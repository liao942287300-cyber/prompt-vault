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
 * @param {{type?:string, category?:string, includeChildren?:any, search?:string}} [options]
 * @returns {Promise<{ok:boolean, total:number, items:Array}>}
 */
async function getItems(options = {}) {
  await waitUntilReady();

  const type = str(options.type).trim().toLowerCase() || 'images';
  if (type !== 'images' && type !== 'image') {
    return { ok: false, error: `不支持的 type：${type}（当前仅支持 images）` };
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

/** 挂到 window 上供主进程 executeJavaScript 调用 */
const PV_API = {
  getHealth,
  getCategories,
  getItems,
  getImageBase64,
  getText
};

if (typeof window !== 'undefined') {
  window.PV_API = PV_API;
}

export default PV_API;
