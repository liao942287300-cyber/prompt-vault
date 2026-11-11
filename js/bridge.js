/* =========================================================================
 * js/bridge.js —— 渲染层数据桥：window.PV_API
 *
 * 主进程（desktop/bridge-server.js）用 webContents.executeJavaScript 调用这里，
 * 再把结果转发给本地 HTTP 服务（供 ComfyUI 插件读取）。
 *
 * 三条硬约束：
 *   1. 只读 store.state（内存），**不重新查 IndexedDB** —— 图库动辄上万条，
 *      每次请求都走一遍 IndexedDB 会把响应拖到秒级；
 *   2. 返回值必须可 JSON 序列化 —— 不能返回 Blob / Set / DOM 节点，
 *      图片一律转成 base64 字符串；
 *   3. 对外字段名统一（例如 loras 的 trigger、edits 的 instruction 都映射成 text），
 *      主进程与 ComfyUI 节点只认统一契约，不认内部字段名。
 *
 * 本文件不改变任何业务逻辑，只做「读 + 映射」。
 * ========================================================================= */

import { state, subscribe } from './store.js';

/** 等待 store.init() 完成的最长时间（毫秒） */
const READY_TIMEOUT_MS = 8000;

/** 已完成的等待 Promise（并发请求复用） */
let readyPromise = null;

/**
 * 等到 store 初始化完成（state.ready === true）。
 * 超时后不 reject，而是按当前内存数据返回 —— 宁可返回空列表，也不要让节点侧超时。
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} 是否已就绪
 */
function waitUntilReady(timeoutMs = READY_TIMEOUT_MS) {
  if (state.ready) return Promise.resolve(true);
  if (readyPromise) return readyPromise;

  readyPromise = new Promise((resolve) => {
    let settled = false;
    let timer = 0;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { unsubscribe(); } catch { /* 忽略 */ }
      if (timer) clearTimeout(timer);
      readyPromise = null;
      resolve(Boolean(value));
    };

    const unsubscribe = subscribe(() => {
      if (state.ready) finish(true);
    });

    timer = setTimeout(() => finish(state.ready), Math.max(0, Number(timeoutMs) || 0));
  });

  return readyPromise;
}

/* ------------------------------------------------------------ 字段工具 */

/** 任意值 → 字符串（null/undefined → ''） */
function str(value) {
  return value === null || value === undefined ? '' : String(value);
}

/** 任意值 → 非负数字 */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 任意值 → 字符串数组 */
function strArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item)).filter((item) => item.length > 0);
}

/** id 归一化：null 保持 null，其余转字符串 */
function idOrNull(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}

/**
 * 批量 id 归一化：接受数组或逗号分隔字符串，去空、去重、保留首次出现顺序。
 *
 * 为什么要去重：调用方（ComfyUI 工作流）存的是 id 清单，用户可能把同一张图
 * 放了两次。这里返回两份完全相同的元数据没有意义，还会让面板重复渲染卡片。
 *
 * @param {any} value
 * @returns {string[]}
 */
function normalizeIds(value) {
  const raw = Array.isArray(value) ? value : str(value).split(',');
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const id = str(item).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 按 id 从集合里捞记录（单遍扫描 + 找齐即停）。
 *
 * 为什么不用「每条 id 都 find 一遍」：图库有 1.7 万条，ids 有几十个时
 * O(n·m) 会明显变慢；这里一趟扫完、找齐就 break，代价是 O(n)。
 *
 * @param {Array} collection
 * @param {string[]} ids
 * @returns {{found: Map<string, object>, missing: string[]}}
 */
function pickByIds(collection, ids) {
  const wanted = new Set(ids);
  const found = new Map();
  if (wanted.size > 0) {
    for (const item of collection) {
      if (!wanted.has(item.id)) continue;
      found.set(item.id, item);
      if (found.size >= wanted.size) break;
    }
  }
  return {
    found,
    // missing 保持传入顺序，方便调用方逐条报告「哪张图没了」
    missing: ids.filter((id) => !found.has(id))
  };
}

/**
 * 布尔参数归一化（executeJavaScript 传过来的可能是 true / 1 / '1' / 'true'）。
 * @param {any} value
 * @returns {boolean}
 */
function bool(value) {
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  const text = str(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

/* ------------------------------------------------------------ 映射函数 */

/**
 * 图片记录 → 对外元数据（**不含二进制**）。
 * @param {object} image
 * @returns {{id:string, name:string, positive:string, negative:string, params:string,
 *            tags:string[], categoryId:string|null, width:number, height:number, createdAt:number}}
 */
function toItemMeta(image) {
  return {
    id: str(image.id),
    name: str(image.name),
    positive: str(image.positive),
    negative: str(image.negative),
    params: str(image.params),
    tags: strArray(image.tags),
    categoryId: idOrNull(image.categoryId),
    width: num(image.width),
    height: num(image.height),
    createdAt: num(image.createdAt)
  };
}

/**
 * 搜索匹配：在 name / positive / tags 里做**不区分大小写**的包含匹配。
 * @param {object} image
 * @param {string} keyword 已小写、已 trim 的关键字
 * @returns {boolean}
 */
function matchesKeyword(image, keyword) {
  if (!keyword) return true;
  const haystack = [
    str(image.name),
    str(image.positive),
    strArray(image.tags).join(' ')
  ].join('\n').toLowerCase();
  return haystack.includes(keyword);
}

/**
 * 资产图记录 → 对外元数据（**刻意不含 blob / thumb 的 base64**）。
 *
 * 为什么列表不返回 base64：
 *   资产图原图动辄 1~3MB，一张转 base64 就膨胀 ~33%；一个项目几十张图，
 *   列表接口一次就要序列化上百 MB 字符串 —— 主进程 executeJavaScript 的返回值
 *   要跨进程结构化克隆，ComfyUI 那边还要再解析一遍 JSON，两边都会卡死。
 *   所以列表只给元数据（每条约 150 字节），图片字节由 /api/asset-image 单张取。
 *
 * @param {object} asset
 * @returns {{id:string, name:string, category:string, project:string, note:string,
 *            width:number, height:number, size:number, mime:string, createdAt:number}}
 */
function toAssetMeta(asset) {
  return {
    id: str(asset.id),
    name: str(asset.name),
    category: str(asset.category),
    project: str(asset.project),
    // note 是给 ComfyUI 面板 hover 卡片显示备注用的；它同时是 q 的搜索字段
    note: str(asset.note),
    width: num(asset.width),
    height: num(asset.height),
    size: num(asset.size),
    mime: str(asset.mime),
    createdAt: num(asset.createdAt)
  };
}

/**
 * 资产图搜索匹配：只在 name / note 里做不区分大小写的包含匹配。
 * 空格分隔表示「同时包含」（和 store.js 的 matchKeywords 语义一致）。
 *
 * 注意：不匹配 category / project —— 这两个维度已经有独立的查询参数，
 * 混进关键词会让「按项目筛 + 搜名字」的结果变得难以预期。
 *
 * @param {object} asset
 * @param {string} keyword 已小写、已 trim 的关键字
 * @returns {boolean}
 */
function matchesAssetKeyword(asset, keyword) {
  if (!keyword) return true;
  const words = keyword.split(/\s+/).filter((word) => word.length > 0);
  if (!words.length) return true;
  const haystack = `${str(asset.name)}\n${str(asset.note)}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * 构造分类匹配器。
 *
 * 数据模型：图片同时带 categoryId（一级）与 subCategoryId（二级，可能为 null），
 * 所以「只算一级分类本身」必须显式排除带 subCategoryId 的图，否则
 * includeChildren 这个参数就失去意义了。
 *
 *   不传 category          → 全部（返回 null）
 *   一级分类 + includeChildren → 该分类 + 其下所有二级子分类
 *   一级分类（默认）        → 仅直接挂在一级分类上的图（subCategoryId 为空）
 *   二级分类               → 该二级分类下的图
 *
 * @param {string} categoryId
 * @param {boolean} includeChildren
 * @returns {((image:object) => boolean)|null}
 */
function buildCategoryMatcher(categoryId, includeChildren) {
  if (!categoryId) return null;

  const target = state.categories.find((c) => c.id === categoryId);
  const isTopLevel = target ? Number(target.level) === 1 : false;

  if (isTopLevel) {
    if (!includeChildren) {
      return (image) => image.categoryId === categoryId && !image.subCategoryId;
    }
    const scope = new Set([categoryId]);
    state.categories.forEach((c) => {
      if (Number(c.level) === 2 && c.parentId === categoryId) scope.add(c.id);
    });
    return (image) => scope.has(image.categoryId) || scope.has(image.subCategoryId);
  }

  // 二级分类（或分类已不存在时的兜底）：精确匹配该分类
  return (image) => image.subCategoryId === categoryId
    || (image.categoryId === categoryId && !image.subCategoryId);
}

/**
 * Blob → base64（不含 data: 前缀）。
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    let reader;
    try {
      reader = new FileReader();
    } catch (err) {
      reject(err);
      return;
    }
    reader.onload = () => {
      const result = str(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('读取图片数据失败'));
    reader.readAsDataURL(blob);
  });
}

/* ------------------------------------------------------------ 对外 API */

/**
 * 健康检查 / 数据量统计。
 * @returns {Promise<{ok:boolean, counts:object, ready:boolean, memoryMode:boolean}>}
 */
async function getHealth() {
  await waitUntilReady();
  return {
    ok: true,
    counts: {
      images: state.images.length,
      categories: state.categories.length,
      loras: state.loras.length,
      edits: state.edits.length,
      assets: state.assets.length,
      systemPrompts: state.systemPrompts.length
    },
    ready: Boolean(state.ready),
    memoryMode: Boolean(state.memoryMode)
  };
}

/**
 * 全部分类（一级 + 二级，含层级与排序号）。
 *
 * 输出顺序：一级分类按 order 升序，其二级子分类紧随其后（同样按 order 升序），
 * 方便节点侧直接按顺序渲染成下拉框；父分类已丢失的二级分类会追加在末尾，不丢数据。
 *
 * @returns {Promise<{ok:boolean, categories:Array}>}
 */
async function getCategories() {
  await waitUntilReady();

  const mapOne = (c) => ({
    id: str(c.id),
    name: str(c.name),
    level: Number(c.level) === 2 ? 2 : 1,
    parentId: idOrNull(c.parentId),
    order: num(c.order)
  });

  const byOrder = (a, b) => {
    const diff = num(a.order) - num(b.order);
    if (diff !== 0) return diff;
    return str(a.name).localeCompare(str(b.name), 'zh-Hans-CN');
  };

  const tops = state.categories.filter((c) => Number(c.level) === 1).sort(byOrder);
  const topIds = new Set(tops.map((c) => c.id));
  const categories = [];

  tops.forEach((top) => {
    categories.push(mapOne(top));
    state.categories
      .filter((c) => Number(c.level) === 2 && c.parentId === top.id)
      .sort(byOrder)
      .forEach((sub) => categories.push(mapOne(sub)));
  });

  // 兜底：父分类已删除的二级分类，仍然返回，避免节点侧看到「有图但没分类」
  state.categories
    .filter((c) => Number(c.level) !== 1 && !topIds.has(c.parentId))
    .sort(byOrder)
    .forEach((orphan) => categories.push(mapOne(orphan)));

  return { ok: true, categories };
}

/**
 * 图片元数据列表（不含图片二进制）。
 *
 * includeChildren 语义见 buildCategoryMatcher：
 * 只有显式传 includeChildren=1 时，一级分类才会带上其二级子分类的图。
 *
 * @param {{type?:string, category?:string, includeChildren?:any, search?:string, ids?:any}} [options]
 *        传了 ids 则走「按 id 批量取」分支，其余筛选参数全部忽略。
 * @returns {Promise<{ok:boolean, total:number, items:Array, missing?:string[]}>}
 */
async function getItems(options = {}) {
  await waitUntilReady();

  const type = str(options.type).trim().toLowerCase() || 'images';
  if (type !== 'images' && type !== 'image') {
    return { ok: false, error: `不支持的 type：${type}（当前仅支持 images）` };
  }

  // 按 id 批量取（语义同 getAssets）：忽略分类 / 搜索，只按传入顺序返回。
  const hasIds = options.ids !== undefined && options.ids !== null;
  if (hasIds) {
    const ids = normalizeIds(options.ids);
    const { found, missing } = pickByIds(state.images, ids);
    const picked = [];
    for (const id of ids) {
      const image = found.get(id);
      if (image) picked.push(toItemMeta(image));
    }
    return { ok: true, total: picked.length, items: picked, missing };
  }

  const categoryId = str(options.category).trim();
  const matcher = buildCategoryMatcher(categoryId, bool(options.includeChildren));
  const keyword = str(options.search).trim().toLowerCase();

  const items = [];
  for (const image of state.images) {
    if (matcher && !matcher(image)) continue;
    if (!matchesKeyword(image, keyword)) continue;
    items.push(toItemMeta(image));
  }

  // 刻意不排序：排序交给调用方（ComfyUI 节点侧自己按需要排）
  return { ok: true, total: items.length, items };
}

/**
 * 取图片二进制（base64）。
 * size=thumb 优先缩略图，没有则退回原图；size=full 优先原图，没有则退回缩略图。
 *
 * @param {{id?:string, size?:string}} [options]
 * @returns {Promise<{ok:boolean, mime?:string, base64?:string, bytes?:number, error?:string}>}
 */
async function getImageBase64(options = {}) {
  await waitUntilReady();

  const id = str(options.id).trim();
  if (!id) return { ok: false, error: '缺少 id 参数' };

  const image = state.images.find((item) => item.id === id);
  if (!image) return { ok: false, error: `图片不存在：${id}` };

  const wantThumb = str(options.size).trim().toLowerCase() === 'thumb';
  const blob = wantThumb
    ? (image.thumb || image.blob)
    : (image.blob || image.thumb);

  if (!blob || typeof blob.arrayBuffer !== 'function') {
    return { ok: false, error: '该记录没有图片数据（可能是 CSV 导入的纯文本记录）' };
  }

  try {
    const base64 = await blobToBase64(blob);
    if (!base64) return { ok: false, error: '图片数据为空' };
    return {
      ok: true,
      mime: str(blob.type) || str(image.mime) || 'image/png',
      base64,
      bytes: num(blob.size)
    };
  } catch (err) {
    return { ok: false, error: `读取图片失败：${str(err && err.message) || '未知错误'}` };
  }
}

/**
 * 文本类集合（LORA 触发词 / 编辑指令 / 系统提示词），对外统一成 {id, name, text}。
 *
 * 字段映射（以 store.js 的实际字段为准）：
 *   loras          → name = fileName, text = trigger
 *   edits          → name = title,    text = instruction
 *   system-prompts → name = title,    text = content
 *
 * @param {{type?:string}} [options]
 * @returns {Promise<{ok:boolean, items:Array, error?:string}>}
 */
async function getText(options = {}) {
  await waitUntilReady();

  const type = str(options.type).trim().toLowerCase();

  if (type === 'loras' || type === 'lora') {
    return {
      ok: true,
      items: state.loras.map((lora) => ({
        id: str(lora.id),
        name: str(lora.fileName) || str(lora.name),
        text: str(lora.trigger)
      }))
    };
  }

  if (type === 'edits' || type === 'edit') {
    return {
      ok: true,
      items: state.edits.map((edit) => ({
        id: str(edit.id),
        name: str(edit.title),
        text: str(edit.instruction)
      }))
    };
  }

  if (
    type === 'system-prompts' || type === 'system_prompts' ||
    type === 'systemprompts' || type === 'prompts'
  ) {
    return {
      ok: true,
      items: state.systemPrompts.map((prompt) => ({
        id: str(prompt.id),
        name: str(prompt.title),
        text: str(prompt.content)
      }))
    };
  }

  return {
    ok: false,
    error: `不支持的 type：${type || '(空)'}（可选 loras / edits / system-prompts）`
  };
}

/**
 * 资产图元数据列表（分页）。**不返回任何图片字节**（原因见 toAssetMeta）。
 *
 * 分页刻意放在渲染层做：数据本来就在内存里，切片是 O(1)，
 * 一次只把「这一页」跨进程传出去；如果放到主进程切片，
 * 每翻一页都要把整个库的元数据克隆一遍，上万张图时明显变慢。
 *
 * 排序：createdAt 倒序（最新的在前），和资产图页一致；
 * 同毫秒用 id 兜底，保证 offset 分页不会因为排序不稳定而漏图 / 重复图。
 *
 * @param {{category?:string, project?:string, limit?:any, offset?:any, q?:string, ids?:any}} [options]
 *        project 传 '__none__' 表示只看未分项目的图；
 *        limit <= 0 表示不限；
 *        传了 ids 则走「按 id 批量取」分支，其余筛选/分页参数全部忽略。
 * @returns {Promise<{ok:boolean, total:number, items:Array, offset?:number,
 *                    limit?:number, missing?:string[]}>}
 */
async function getAssets(options = {}) {
  await waitUntilReady();

  // 按 id 批量取：工作流里存的是 id 清单，重开工作流时按 id 取回元数据。
  // 这条路径必须忽略 category/project/q/limit/offset —— 否则「按 id 取」
  // 会被残留的筛选条件悄悄过滤掉一部分，面板上就会出现「图明明存在却没了」。
  const hasIds = options.ids !== undefined && options.ids !== null;
  if (hasIds) {
    const ids = normalizeIds(options.ids);
    const { found, missing } = pickByIds(state.assets, ids);
    const items = [];
    for (const id of ids) {
      const asset = found.get(id);
      if (asset) items.push(toAssetMeta(asset));
    }
    return { ok: true, total: items.length, items, missing };
  }

  const category = str(options.category).trim();
  const project = str(options.project).trim();
  const keyword = str(options.q).trim().toLowerCase();

  const rawLimit = Number(options.limit);
  const rawOffset = Number(options.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 0;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  const matched = [];
  for (const asset of state.assets) {
    if (category && str(asset.category) !== category) continue;

    if (project) {
      const projectName = str(asset.project);
      if (project === '__none__') {
        // 特殊值：project 为空字符串 = 未分项目
        if (projectName) continue;
      } else if (projectName !== project) {
        continue;
      }
    }

    if (!matchesAssetKeyword(asset, keyword)) continue;
    matched.push(asset);
  }

  matched.sort((a, b) => {
    const diff = num(b.createdAt) - num(a.createdAt);
    if (diff !== 0) return diff;
    return str(a.id).localeCompare(str(b.id));
  });

  const total = matched.length;
  const start = Math.min(offset, total);
  const end = limit > 0 ? Math.min(start + limit, total) : total;

  return {
    ok: true,
    total,
    items: matched.slice(start, end).map(toAssetMeta),
    offset: start,
    limit
  };
}

/**
 * 取资产图二进制（base64）。默认缩略图（约 35KB JPEG），size=full 取原图。
 *
 * 和 getImageBase64 的唯一差别是**默认值**：这里默认 thumb ——
 * 资产图原图常有 1~3MB，节点侧做预览 / 选图时几乎总是要缩略图；
 * 指定尺寸缺失时同样退回另一个尺寸（老记录可能只存了其中一种）。
 *
 * @param {{id?:string, size?:string}} [options]
 * @returns {Promise<{ok:boolean, mime?:string, base64?:string, bytes?:number, error?:string}>}
 */
async function getAssetImageBase64(options = {}) {
  await waitUntilReady();

  const id = str(options.id).trim();
  if (!id) return { ok: false, error: '缺少 id 参数' };

  const asset = state.assets.find((item) => item.id === id);
  if (!asset) return { ok: false, error: `资产图不存在：${id}` };

  const wantFull = str(options.size).trim().toLowerCase() === 'full';
  // 兜底：老记录可能只有 blob 没有 thumb（导入时缩略图生成失败），反之亦然
  const blob = wantFull
    ? (asset.blob || asset.thumb)
    : (asset.thumb || asset.blob);

  if (!blob || typeof blob.arrayBuffer !== 'function') {
    return { ok: false, error: '该记录没有图片数据' };
  }

  try {
    const base64 = await blobToBase64(blob);
    if (!base64) return { ok: false, error: '图片数据为空' };
    return {
      ok: true,
      mime: str(blob.type) || str(asset.mime) || 'image/png',
      base64,
      bytes: num(blob.size) || num(asset.size)
    };
  } catch (err) {
    return { ok: false, error: `读取图片失败：${str(err && err.message) || '未知错误'}` };
  }
}

/** 挂到 window 上供主进程 executeJavaScript 调用 */
const PV_API = {
  getHealth,
  getCategories,
  getItems,
  getImageBase64,
  getText,
  getAssets,
  getAssetImageBase64
};

if (typeof window !== 'undefined') {
  window.PV_API = PV_API;
}

export default PV_API;
