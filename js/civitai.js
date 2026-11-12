/* =========================================================================
 * js/civitai.js —— Civitai 图片链接导入
 *
 * 支持三种输入（可混在一段文本里，一行一条或一行多条 URL）：
 *   1. 图片页链接   https://civitai.com/images/148754255?postId=...
 *   2. 接口链接     https://civitai.com/api/v1/images?imageId=148754255
 *   3. 图床直链     https://image.civitai.com/xG1.../original=true/xxx.jpeg
 *   4. 纯数字 ID    148754255
 *
 * 元数据走公开接口 /api/v1/images?imageId=...&withMeta=true。
 * 该接口与 image.civitai.com 都返回 `access-control-allow-origin: *`，
 * 所以渲染层可以直接 fetch，不需要主进程代理。
 *
 * 注意接口返回的 meta 有两种形状：
 *   列表/单查（imageId 过滤）→ { id, meta: { seed, prompt, ... } }
 *   批量列表（limit 分页）     → { seed, prompt, ... }
 * normalizeCivitaiEntry() 两种都吃。
 * ========================================================================= */

const API_IMAGES = 'https://civitai.com/api/v1/images';
const PAGE_IMAGES = 'https://civitai.com/images';

/** 单次网络请求超时（毫秒） */
const TIMEOUT_MS = 20000;

/** civitai.com/images/<id> 或 civitai.com/i/<id> */
const RE_PAGE_ID = /civitai\.com\/(?:images|i)\/(\d+)/i;
/** civitai.com/api/v1/images?imageId=<id>（imageIds 也认） */
const RE_API_ID = /civitai\.com\/api\/v\d+\/images\?[^\s]*imageIds?=(\d+)/i;
/** 任意 http(s) 链接 */
const RE_URL = /https?:\/\/[^\s"'<>）)，,]+/g;
/** 图床域名 */
const RE_CDN = /(?:image|imagecache)\.civitai\.com\//i;

/** 从 URL 里抠图片 id；抠不到返回 null */
export function idFromUrl(url) {
  const s = String(url || '');
  const m = RE_PAGE_ID.exec(s) || RE_API_ID.exec(s);
  return m ? m[1] : null;
}

/**
 * 解析用户粘贴的一整段文本。
 * @param {string} text
 * @returns {{refs: Array<{kind:'image',id:string,raw:string}|{kind:'file',url:string,raw:string}>, bad: Array<{raw:string,reason:string}>}}
 */
export function parseCivitaiRefs(text) {
  const refs = [];
  const bad = [];
  const seen = new Set();

  const push = (ref) => {
    const key = ref.kind === 'image' ? `i:${ref.id}` : `f:${ref.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  String(text || '').split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    const urls = line.match(RE_URL) || [];

    // 没有链接 → 只接受纯数字 ID
    if (!urls.length) {
      if (/^\d{4,}$/.test(line)) push({ kind: 'image', id: line, raw: line });
      else bad.push({ raw: line, reason: '不是链接，也不是图片 ID' });
      return;
    }

    urls.forEach((url) => {
      const id = idFromUrl(url);
      if (id) {
        push({ kind: 'image', id, raw: url });
        return;
      }
      if (RE_CDN.test(url)) {
        push({ kind: 'file', url, raw: url });
        return;
      }
      bad.push({ raw: url, reason: '不是 Civitai 图片链接' });
    });
  });

  return { refs, bad };
}

/** 带超时的 fetch（AbortController） */
async function fetchWithTimeout(url, init = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把接口异常翻译成用户能看懂的话。
 * 国内直连 civitai.com 会超时——这条提示很关键，否则用户只会看到 "Failed to fetch"。
 */
function describeError(err) {
  if (err && err.name === 'AbortError') return '请求超时（Civitai 在国内通常需要代理）';
  const msg = String((err && err.message) || err || '');
  if (/Failed to fetch|NetworkError|fetch failed/i.test(msg)) {
    return '网络不通（Civitai 在国内通常需要代理）';
  }
  return msg || '未知错误';
}

/**
 * 按图片 id 拉一条元数据。
 * @param {string|number} id
 * @returns {Promise<object>} 原始 item（已确认存在）
 */
export async function fetchCivitaiEntry(id) {
  const build = (withNsfw) => {
    const qs = new URLSearchParams({ imageId: String(id), withMeta: 'true' });
    if (withNsfw) qs.set('nsfw', 'X');
    return `${API_IMAGES}?${qs.toString()}`;
  };

  const read = async (url) => {
    const res = await fetchWithTimeout(url, { credentials: 'omit', headers: { Accept: 'application/json' } });
    if (res.status === 404) throw new Error('图片不存在或已删除');
    if (res.status === 401 || res.status === 403) throw new Error('该图片需要登录或权限，公开接口读不到');
    if (res.status === 429) throw new Error('请求太频繁，被 Civitai 限流了，等一会儿再来');
    // 5xx：实测「ID 不存在」也会走到这里，别只甩个状态码
    if (res.status >= 500) throw new Error(`Civitai 接口报错（${res.status}），通常是这个 ID 不存在，或服务临时故障`);
    if (!res.ok) throw new Error(`接口返回 ${res.status}`);
    const json = await res.json();
    return (json && json.items) || [];
  };

  let items = [];
  try {
    items = await read(build(true));
    // 带 nsfw=X 仍为空 → 用默认参数再试一次（某些网络下 X 档会被拒）
    if (!items.length) items = await read(build(false));
  } catch (err) {
    throw new Error(describeError(err));
  }

  // 只认 id 完全对上的那条。**不能回退到 items[0]**：
  // 接口对未知参数会直接忽略过滤（实测 imageIds= 就返回了整页无关图），
  // 回退会把「要的这张」换成「碰巧第一条」，导进来的就是别人的图。
  const hit = items.find((it) => String(it.id) === String(id));
  if (!hit) throw new Error('接口没有返回这张图（可能已删除、被 NSFW 过滤或 ID 不对）');
  return hit;
}

/**
 * 把接口 item 归一化成导入要用的字段。
 * @param {object} entry
 */
export function normalizeCivitaiEntry(entry) {
  const item = entry || {};
  const holder = item.meta || {};
  // 单查形状是 { id, meta:{...} }，批量形状是 {...} 直接躺平
  const raw = holder && holder.meta && typeof holder.meta === 'object' ? holder.meta : holder;

  const width = Number(item.width) || Number(raw.width) || 0;
  const height = Number(item.height) || Number(raw.height) || 0;

  return {
    id: String(item.id || ''),
    prompt: typeof raw.prompt === 'string' ? raw.prompt.trim() : '',
    negative: typeof raw.negativePrompt === 'string' ? raw.negativePrompt.trim() : '',
    sampler: raw.sampler || '',
    steps: raw.steps === 0 || raw.steps ? String(raw.steps) : '',
    cfg: raw.cfgScale === 0 || raw.cfgScale ? String(raw.cfgScale) : '',
    seed: raw.seed === 0 || raw.seed ? String(raw.seed) : '',
    clipSkip: raw.clipSkip === 0 || raw.clipSkip ? String(raw.clipSkip) : '',
    width,
    height,
    baseModel: item.baseModel || raw.ecosystem || '',
    username: item.username || '',
    nsfw: Boolean(item.nsfw),
    pageUrl: item.id ? `${PAGE_IMAGES}/${item.id}` : '',
    imageUrl: item.url || '',
    hasMeta: Boolean(raw.prompt || raw.steps)
  };
}

/**
 * 拼成和 PNG / A1111 一致的单行参数串：
 * `Steps: 18, Sampler: DPM++ 2M Karras, CFG scale: 2, Seed: 671035176, Size: 832x1216, Model: Illustrious`
 * 这样导入后「参数」框里的格式和本地图片解析出来的一模一样，复制出去能直接用。
 */
export function buildParamsString(info) {
  const src = info || {};
  const parts = [];
  if (src.steps) parts.push(`Steps: ${src.steps}`);
  if (src.sampler) parts.push(`Sampler: ${src.sampler}`);
  if (src.cfg) parts.push(`CFG scale: ${src.cfg}`);
  if (src.seed) parts.push(`Seed: ${src.seed}`);
  if (src.width && src.height) parts.push(`Size: ${src.width}x${src.height}`);
  if (src.baseModel) parts.push(`Model: ${src.baseModel}`);
  if (src.clipSkip) parts.push(`Clip skip: ${src.clipSkip}`);
  return parts.join(', ');
}

/** 从 URL 猜扩展名（图床链接末尾常带 .jpeg / .png） */
export function extFromUrl(url) {
  const m = /\.(jpe?g|png|webp|gif|avif)(?:\?|#|$)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : 'jpeg';
}

/** 下载图片原始字节 */
export async function fetchCivitaiBlob(url) {
  if (!url) throw new Error('这张图没有可下载的地址');
  let res;
  try {
    res = await fetchWithTimeout(url, { credentials: 'omit' });
  } catch (err) {
    throw new Error(describeError(err));
  }
  if (!res.ok) throw new Error(`图片下载失败（${res.status}）`);
  const blob = await res.blob();
  if (!blob.size) throw new Error('图片下载到 0 字节');
  return blob;
}
