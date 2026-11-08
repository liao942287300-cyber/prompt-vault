/* =========================================================================
 * js/store.js —— 全局状态、筛选、分类树与业务动作
 * 单向数据流：视图调用 store 的动作 → store 写库 + recompute + emit(reason)
 * 视图订阅 store，根据 reason 决定是否重绘。
 * ========================================================================= */

import * as db from './db.js';
import { uid } from './utils.js';

/** 默认设置 */
const DEFAULT_SETTINGS = {
  theme: 'light',
  galleryPageSize: 60,
  dbPageSize: 50,
  lastCategory: 'all',
  collapsed: {},
  /** 导入时是否按提示词内容自动推断分类（用户显式指定分类时始终以用户为准） */
  autoClassify: true
};

/** 全局状态（唯一数据源） */
export const state = {
  ready: false,
  memoryMode: false,
  initError: null,

  images: [],
  categories: [],

  /** v2 新增集合：LORA 触发词 / 编辑指令 / 资产图 */
  loras: [],
  edits: [],
  assets: [],
  /** v3 新增：LLM 系统提示词模板 */
  systemPrompts: [],

  /** 当前映射的 loras 目录名（仅用于展示，句柄存在 meta 里） */
  loraDirName: '',

  settings: { ...DEFAULT_SETTINGS },

  /** 全局搜索关键字 */
  search: '',
  /** 当前主视图：gallery | database | loras | edits | assets */
  view: 'gallery',

  /** 图库筛选（左栏驱动） */
  filter: { kind: 'all', categoryId: null, subCategoryId: null },
  /** 图库排序 */
  gallerySort: { sort: 'createdAt', dir: 'desc' },

  /** 数据库视图筛选与排序 */
  dbFilter: { categoryId: '', subCategoryId: '', favoriteOnly: false, sort: 'createdAt', dir: 'desc' },
  dbPage: 1,

  /** 数据库视图多选集合 */
  selection: new Set(),

  /** 图库当前页码（从 1 开始） */
  galleryPage: 1,

  /** 提示词购物车：存图片 id，数组顺序即加入顺序 */
  cart: [],
  /** 选购模式：开启后点卡片是「加入购物车」而不是打开详情 */
  cartMode: false,

  /** 派生数据 */
  galleryList: [],
  galleryFiltered: [],
  galleryTotal: 0,
  /** 图库总页数 */
  galleryPages: 0,
  dbList: [],
  counts: { total: 0, favorite: 0, uncategorized: 0, byCategory: {}, bySub: {} }
};

/* ------------------------------------------------------------ 订阅广播 */

const listeners = new Set();

/**
 * 订阅状态变化。
 * @param {(reason:string)=>void} fn
 * @returns {()=>void} 取消订阅
 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 广播状态变化。
 * @param {string} reason all | images | categories | filter | search | settings | view | selection
 */
export function emit(reason = 'all') {
  for (const fn of Array.from(listeners)) {
    try { fn(reason); } catch (err) { console.error('[PromptVault] 订阅回调异常', err); }
  }
}

/* ------------------------------------------------------------ 初始化 */

/** 初始化：连接数据库、种子分类、载入数据与设置 */
export async function init() {
  const result = await db.initDB();
  state.memoryMode = result.mode === 'memory';
  state.initError = result.error || null;

  await db.seedCategories();

  // 一次性迁移：移除已废弃的三个修饰类分类（光照氛围 / 镜头构图 / 画质增强）
  try {
    const migration = await db.migrateRetiredCategories();
    if (migration.removedCategories) {
      console.info(
        `[PromptVault] 已移除 ${migration.removedCategories} 个废弃分类，` +
        `${migration.affectedImages} 张图片退回未分类`
      );
    }
  } catch (err) {
    console.warn('[PromptVault] 废弃分类迁移失败，已跳过', err);
  }

  state.categories = await db.getAllCategories();
  state.images = await db.getAllImages();
  state.loras = await db.getAllLoras();
  state.edits = await db.getAllEdits();
  state.assets = await db.getAllAssets();
  state.systemPrompts = await db.getAllPrompts();
  state.loraDirName = await db.getMeta('loraDirName', '');

  const saved = await db.getMeta('settings', null);
  if (saved && typeof saved === 'object') {
    state.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      collapsed: { ...DEFAULT_SETTINGS.collapsed, ...(saved.collapsed || {}) }
    };
  }
  if (state.settings.lastCategory) applyStoredCategory(state.settings.lastCategory);

  state.galleryPage = 1;

  state.ready = true;
  applyTheme();
  recompute();
  emit('all');
}

/* ------------------------------------------------------------ 设置 */

/** 持久化设置 */
export async function saveSettings() {
  await db.setMeta('settings', state.settings);
  emit('settings');
}

/** 应用主题到根节点 */
export function applyTheme() {
  const theme = state.settings.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
}

/** 切换深浅主题 */
export async function toggleTheme() {
  state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  await saveSettings();
}

/** 全部主视图 */
const VIEWS = new Set(['gallery', 'database', 'loras', 'edits', 'assets', 'prompts']);

/** 切换视图 */
export function setView(view) {
  const next = VIEWS.has(view) ? view : 'gallery';
  if (state.view === next) return;
  state.view = next;
  emit('view');
}

/** 设置搜索关键字 */
export function setSearch(keyword) {
  const next = String(keyword || '');
  if (state.search === next) return;
  state.search = next;
  state.galleryPage = 1;
  state.dbPage = 1;
  recompute();
  emit('search');
}

/* ------------------------------------------------------------ 分类查询 */

function byOrder(a, b) {
  const oa = Number(a.order) || 0;
  const ob = Number(b.order) || 0;
  if (oa !== ob) return oa - ob;
  return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
}

/** 全部一级分类 */
export function topCategories() {
  return state.categories.filter((c) => c.level === 1).sort(byOrder);
}

/** 某个一级分类下的二级分类 */
export function subCategoriesOf(categoryId) {
  if (!categoryId) return [];
  return state.categories.filter((c) => c.level === 2 && c.parentId === categoryId).sort(byOrder);
}

/** 按 id 取分类 */
export function categoryById(id) {
  if (!id) return null;
  return state.categories.find((c) => c.id === id) || null;
}

/** 图片的分类路径文本，例如 “风格 / 写实摄影” */
export function getCategoryPath(image) {
  if (!image) return '';
  const sub = categoryById(image.subCategoryId);
  const top = categoryById(image.categoryId) || (sub ? categoryById(sub.parentId) : null);
  const parts = [];
  if (top) parts.push(top.name);
  if (sub) parts.push(sub.name);
  return parts.join(' / ');
}

/** 分类路径（小写），用于排序 */
function categoryPathLower(image) {
  return getCategoryPath(image).toLowerCase();
}

/* ------------------------------------------------------------ 搜索 */

/**
 * 判断图片是否匹配搜索关键字（名称 / 正向 / 负向 / 备注 / 标签）。
 *
 * 注意：这里每次调用都重新拼接检索文本，**刻意不做缓存**。
 * updateImage / updateImages 是对 state.images 中的对象「原地改字段」，
 * 对象引用不变，任何以对象为键的缓存（如 WeakMap）都会在编辑后读到陈旧内容，
 * 导致「改名 / 改提示词后搜新值搜不到、搜旧值仍命中」。
 * 本应用全量数据常驻内存，重新拼接字符串的开销可以接受，正确性优先。
 */
export function matchesSearch(image, keyword) {
  const q = String(keyword || '').trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    image.name || '',
    image.positive || '',
    image.negative || '',
    image.note || '',
    (image.tags || []).join(' ')
  ].join('\n').toLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

/* ------------------------------------------------------------ 排序 */

function sortValue(image, key) {
  switch (key) {
    case 'name': return String(image.name || '').toLowerCase();
    case 'categoryId': return categoryPathLower(image);
    case 'size': return Number(image.size) || 0;
    case 'updatedAt': return Number(image.updatedAt) || 0;
    case 'favorite': return image.favorite ? 1 : 0;
    case 'createdAt':
    default: return Number(image.createdAt) || 0;
  }
}

/**
 * 就地排序。
 * @param {Array} list 待排序数组
 * @param {string} key name|categoryId|size|updatedAt|createdAt|favorite
 * @param {'asc'|'desc'} dir
 */
export function sortList(list, key, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return 0;
  });
  return list;
}

/* ------------------------------------------------------------ 派生计算 */

function computeGallery() {
  const q = state.search.trim();
  let list;
  if (q) {
    // 全局搜索：忽略左栏分类筛选
    list = state.images.filter((img) => matchesSearch(img, q));
  } else {
    const f = state.filter;
    list = state.images.slice();
    if (f.kind === 'favorite') list = list.filter((img) => img.favorite);
    else if (f.kind === 'uncategorized') list = list.filter((img) => !img.categoryId && !img.subCategoryId);
    else if (f.kind === 'category') {
      if (f.subCategoryId) list = list.filter((img) => img.subCategoryId === f.subCategoryId);
      else if (f.categoryId) list = list.filter((img) => img.categoryId === f.categoryId);
    }
  }
  sortList(list, state.gallerySort.sort, state.gallerySort.dir);
  state.galleryTotal = list.length;
  // 完整筛选结果（未经分页截断）—— 导出等数据完整性场景必须用它
  state.galleryFiltered = list;

  // 真分页：只把当前页的数据交给网格渲染，上万张也不会一次性建 DOM
  const size = pageSizeGallery();
  const pages = Math.max(1, Math.ceil(list.length / size));
  state.galleryPages = pages;
  if (state.galleryPage > pages) state.galleryPage = pages;
  if (state.galleryPage < 1) state.galleryPage = 1;
  const start = (state.galleryPage - 1) * size;
  state.galleryList = list.slice(start, start + size);
}

function computeDbList() {
  const q = state.search.trim();
  let list = state.images.slice();
  if (q) list = list.filter((img) => matchesSearch(img, q));

  const f = state.dbFilter;
  if (f.categoryId) list = list.filter((img) => img.categoryId === f.categoryId);
  if (f.subCategoryId) list = list.filter((img) => img.subCategoryId === f.subCategoryId);
  if (f.favoriteOnly) list = list.filter((img) => img.favorite);

  sortList(list, f.sort, f.dir);
  state.dbList = list;

  const pageSize = pageSizeDb();
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  if (state.dbPage > pages) state.dbPage = pages;
  if (state.dbPage < 1) state.dbPage = 1;
}

function computeCounts() {
  const byCategory = {};
  const bySub = {};
  let favorite = 0;
  let uncategorized = 0;
  for (const img of state.images) {
    if (img.favorite) favorite += 1;
    if (!img.categoryId && !img.subCategoryId) uncategorized += 1;
    if (img.categoryId) byCategory[img.categoryId] = (byCategory[img.categoryId] || 0) + 1;
    if (img.subCategoryId) bySub[img.subCategoryId] = (bySub[img.subCategoryId] || 0) + 1;
  }
  state.counts = { total: state.images.length, favorite, uncategorized, byCategory, bySub };
}

/** 重新计算所有派生数据 */
export function recompute() {
  computeGallery();
  computeDbList();
  computeCounts();
}

/**
 * 当前筛选（含全局搜索）命中的**完整**图片列表，未经「加载更多」分页截断。
 * 导出、批量等需要数据完整性的场景请用这个，不要用 galleryList。
 * @returns {Array} 图片对象数组（只读，请勿原地修改）
 */
export function getFiltered() {
  return state.galleryFiltered;
}

/** 图库每页条数 */
export function pageSizeGallery() {
  return Number(state.settings.galleryPageSize) || DEFAULT_SETTINGS.galleryPageSize;
}

/** 数据库每页条数 */
export function pageSizeDb() {
  return Number(state.settings.dbPageSize) || DEFAULT_SETTINGS.dbPageSize;
}

/** 数据库视图当前页数据 */
export function dbPageItems() {
  const size = pageSizeDb();
  const start = (state.dbPage - 1) * size;
  return state.dbList.slice(start, start + size);
}

/** 数据库视图总页数 */
export function dbTotalPages() {
  return Math.max(1, Math.ceil(state.dbList.length / pageSizeDb()));
}

/* ------------------------------------------------------------ 筛选动作 */

/** 从持久化设置恢复上次选中的分类 */
function applyStoredCategory(value) {
  if (!value || value === 'all') { state.filter = { kind: 'all', categoryId: null, subCategoryId: null }; return; }
  if (value === 'favorite' || value === 'uncategorized') {
    state.filter = { kind: value, categoryId: null, subCategoryId: null };
    return;
  }
  const [kind, id] = String(value).split(':');
  if (kind === 'cat' && categoryById(id)) {
    state.filter = { kind: 'category', categoryId: id, subCategoryId: null };
    return;
  }
  if (kind === 'sub') {
    const sub = categoryById(id);
    if (sub) {
      state.filter = { kind: 'category', categoryId: sub.parentId, subCategoryId: id };
      return;
    }
  }
  // 分类已被删除等情况：回退到「全部图片」
  state.filter = { kind: 'all', categoryId: null, subCategoryId: null };
}

function persistCategoryFilter() {
  const f = state.filter;
  let token = 'all';
  if (f.kind === 'favorite' || f.kind === 'uncategorized') token = f.kind;
  else if (f.kind === 'category') token = f.subCategoryId ? `sub:${f.subCategoryId}` : `cat:${f.categoryId}`;
  state.settings.lastCategory = token;
  db.setMeta('settings', state.settings).catch(() => {});
}

/** 左栏：全部图片 */
export function selectAllImages() {
  state.filter = { kind: 'all', categoryId: null, subCategoryId: null };
  state.galleryPage = 1;
  recompute(); persistCategoryFilter();
  emit('filter');
}

/** 左栏：收藏 */
export function selectFavorites() {
  state.filter = { kind: 'favorite', categoryId: null, subCategoryId: null };
  state.galleryPage = 1;
  recompute(); persistCategoryFilter();
  emit('filter');
}

/** 左栏：未分类 */
export function selectUncategorized() {
  state.filter = { kind: 'uncategorized', categoryId: null, subCategoryId: null };
  state.galleryPage = 1;
  recompute(); persistCategoryFilter();
  emit('filter');
}

/** 左栏：选择一级分类 */
export function selectCategory(categoryId) {
  state.filter = { kind: 'category', categoryId, subCategoryId: null };
  state.galleryPage = 1;
  recompute(); persistCategoryFilter();
  emit('filter');
}

/** 左栏：选择二级分类 */
export function selectSubCategory(subCategoryId) {
  const sub = categoryById(subCategoryId);
  state.filter = { kind: 'category', categoryId: sub ? sub.parentId : null, subCategoryId };
  state.galleryPage = 1;
  recompute(); persistCategoryFilter();
  emit('filter');
}

/**
 * 图库：跳转到指定页。
 * @param {number} page 目标页码（从 1 开始，会被收敛到有效范围）
 */
export function setGalleryPage(page) {
  const next = Math.round(Number(page) || 1);
  if (next === state.galleryPage) return;
  state.galleryPage = next;
  recompute();
  emit('filter');
}

/** 图库：切换排序 */
export function setGallerySort(sort, dir) {
  state.gallerySort = { sort, dir };
  recompute();
  emit('filter');
}

/** 数据库：更新筛选 */
export function setDbFilter(patch = {}) {
  state.dbFilter = { ...state.dbFilter, ...patch };
  state.dbPage = 1;
  recompute();
  emit('filter');
}

/** 数据库：清空筛选 */
export function clearDbFilter() {
  state.dbFilter = { categoryId: '', subCategoryId: '', favoriteOnly: false, sort: 'createdAt', dir: 'desc' };
  state.dbPage = 1;
  recompute();
  emit('filter');
}

/** 数据库：翻页 */
export function setDbPage(page) {
  const total = dbTotalPages();
  state.dbPage = Math.min(Math.max(1, Number(page) || 1), total);
  emit('filter');
}

/** 数据库：切换排序 */
export function toggleDbSort(sort) {
  if (state.dbFilter.sort === sort) {
    state.dbFilter.dir = state.dbFilter.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.dbFilter.sort = sort;
    state.dbFilter.dir = sort === 'name' ? 'asc' : 'desc';
  }
  recompute();
  emit('filter');
}

/* ------------------------------------------------------------ 多选 */

/** 切换单行选中态 */
export function toggleSelection(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  emit('selection');
}

/** 设置一批 id 的选中态 */
export function setSelection(ids, selected) {
  ids.forEach((id) => { if (selected) state.selection.add(id); else state.selection.delete(id); });
  emit('selection');
}

/** 清空选中 */
export function clearSelection() {
  if (!state.selection.size) return;
  state.selection.clear();
  emit('selection');
}

/** 当前选中数量 */
export function selectionCount() {
  return state.selection.size;
}

/** 当前选中的图片对象列表 */
export function selectedImages() {
  return state.images.filter((img) => state.selection.has(img.id));
}

/* ------------------------------------------------------------ 图片动作 */

/** 取图片对象 */
export function imageById(id) {
  return state.images.find((img) => img.id === id) || null;
}

/**
 * 更新单张图片。
 * @param {string} id
 * @param {object} patch 需要覆盖的字段
 * @param {{silent?:boolean}} [opts] silent 为真时不广播（用于详情弹窗避免重绘打断输入）
 */
export async function updateImage(id, patch, opts = {}) {
  const image = imageById(id);
  if (!image) return null;
  Object.assign(image, patch, { updatedAt: Date.now() });
  await db.putImage(image);
  recompute();
  if (!opts.silent) emit('images');
  return image;
}

/** 批量更新（同一 patch 应用到多张图片） */
export async function updateImages(ids, patch) {
  const targets = ids.map((id) => imageById(id)).filter(Boolean);
  if (!targets.length) return;
  const now = Date.now();
  targets.forEach((image) => {
    Object.assign(image, patch);
    if (patch.tags) image.tags = Array.from(new Set(patch.tags));
    image.updatedAt = now;
  });
  await db.putImages(targets);
  recompute();
  emit('images');
}

/**
 * 批量重新归类：每张图单独算新分类，最后一次性落库。
 *
 * 为什么不用 updateImages：它只能套同一个 patch，而重新分类每张结果都不同。
 * 为什么不用循环 updateImage：每张都会 recompute + emit，1.7 万张会直接卡死。
 *
 * @param {(image:object)=>{categoryId:string|null, subCategoryId:string|null}|null} updater
 *        返回 null 表示这张跳过（保持原样）
 * @param {(done:number, total:number)=>void} [onProgress] 每批回调一次
 * @returns {Promise<{total:number, changed:number, toUncategorized:number, skipped:number}>}
 */
export async function reclassifyImages(updater, onProgress) {
  const list = state.images.slice();
  const total = list.length;
  const targets = [];
  const now = Date.now();
  let changed = 0;
  let toUncategorized = 0;
  let skipped = 0;

  // 分批处理，中间让出主线程，否则一万多张会卡住界面
  const BATCH = 400;
  for (let i = 0; i < list.length; i += 1) {
    const image = list[i];
    let next = null;
    try {
      next = updater(image);
    } catch (err) {
      next = null;
    }
    if (!next) {
      skipped += 1;
    } else {
      const sameCat = (image.categoryId || null) === (next.categoryId || null);
      const sameSub = (image.subCategoryId || null) === (next.subCategoryId || null);
      if (!sameCat || !sameSub) {
        image.categoryId = next.categoryId || null;
        image.subCategoryId = next.subCategoryId || null;
        image.updatedAt = now;
        targets.push(image);
        changed += 1;
        if (!image.categoryId && !image.subCategoryId) toUncategorized += 1;
      }
    }
    if ((i + 1) % BATCH === 0 || i === list.length - 1) {
      if (typeof onProgress === 'function') onProgress(i + 1, total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (targets.length) await db.putImages(targets);
  recompute();
  emit('images');

  return { total, changed, toUncategorized, skipped };
}

/** 批量新增图片记录 */
export async function bulkAddImages(records = []) {
  if (!records.length) return;
  state.images.push(...records);
  await db.putImages(records);
  recompute();
  emit('images');
}

/**
 * 批量导入专用写库：只落库、**不重算不重绘**。
 *
 * 上万张图分批写入时，每批都 recompute + emit 会把主线程彻底拖死
 * （每次都要遍历全库算 counts、并重绘整个图库网格）。
 * 导入全程用这个，结束时调用一次 refreshAfterBulkImport()。
 *
 * @param {Array} records
 */
export async function bulkAddImagesSilent(records = []) {
  if (!records.length) return;
  state.images.push(...records);
  await db.putImages(records);
}

/** 批量导入结束后统一刷新一次（重算派生数据 + 重绘） */
export function refreshAfterBulkImport() {
  recompute();
  emit('images');
}

/**
 * 删除一批图片。
 * @param {string[]} ids 待删除的图片 id
 * @param {{silent?:boolean}} [opts] silent 为真时不广播 'images'（用于导入覆盖去重等后台场景）
 */
export async function removeImages(ids = [], opts = {}) {
  if (!ids.length) return;
  const set = new Set(ids);
  state.images = state.images.filter((img) => !set.has(img.id));
  ids.forEach((id) => state.selection.delete(id));
  // 被删掉的图要同时从购物车里移除，否则角标数量会和实际条数对不上
  const before = state.cart.length;
  if (before) state.cart = state.cart.filter((id) => !set.has(id));
  await db.deleteImages(ids);
  recompute();
  if (!opts.silent) emit('images');
  if (state.cart.length !== before) emit('cart');
}

/**
 * 信息完整度打分：同一张图有多个副本时，保留信息最全的那份。
 * @param {object} img
 * @returns {number}
 */
function infoScore(img) {
  let score = 0;
  if (img.positive) score += 4;
  if (img.negative) score += 1;
  if (img.categoryId || img.subCategoryId) score += 2;
  if (img.favorite) score += 3;
  if (Array.isArray(img.tags) && img.tags.length) score += 1;
  if (img.note) score += 1;
  return score;
}

/**
 * 扫描图库里的重复图片：按内容指纹（hash）分组。
 * 纯读取，不改任何数据 —— 由调用方确认后再调 removeImages。
 *
 * 每组保留一张，取舍顺序：
 *   1. 信息完整度（提示词 / 分类 / 收藏 / 标签 / 备注越多越优先）
 *   2. 创建时间更早的
 *   3. id 字典序（保证结果稳定，不会每次扫描保留不同的那张）
 *
 * @returns {{groups: Array<{hash:string, keep:object, duplicates:object[]}>,
 *            extra:number, noHash:number}}
 *   groups 重复组；extra 需要删除的张数；noHash 没有指纹、无法参与比对的张数
 */
export function findDuplicateGroups() {
  const byHash = new Map();
  let noHash = 0;

  for (const img of state.images) {
    const hash = String(img.hash || '').trim();
    if (!hash) { noHash += 1; continue; }
    const bucket = byHash.get(hash);
    if (bucket) bucket.push(img);
    else byHash.set(hash, [img]);
  }

  const groups = [];
  let extra = 0;
  for (const [hash, list] of byHash) {
    if (list.length < 2) continue;
    const sorted = list.slice().sort((a, b) => {
      const diff = infoScore(b) - infoScore(a);
      if (diff) return diff;
      const t = (a.createdAt || 0) - (b.createdAt || 0);
      if (t) return t;
      return String(a.id).localeCompare(String(b.id));
    });
    const keep = sorted[0];
    const duplicates = sorted.slice(1);
    extra += duplicates.length;
    groups.push({ hash, keep, duplicates });
  }

  // 多余张数多的排前面，方便用户先看到最严重的
  groups.sort((a, b) => b.duplicates.length - a.duplicates.length);
  return { groups, extra, noHash };
}

/** 切换收藏 */
export async function toggleFavorite(id) {
  const image = imageById(id);
  if (!image) return;
  await updateImage(id, { favorite: !image.favorite });
}

/* ------------------------------------------------------------ 提示词购物车 */

/**
 * 切换选购模式。开启后点图库卡片是「加入购物车」，不再打开详情。
 * @param {boolean} on
 */
export function setCartMode(on) {
  const next = Boolean(on);
  if (state.cartMode === next) return;
  state.cartMode = next;
  emit('cart');
}

/** 某张图是否已在购物车 */
export function isInCart(id) {
  return state.cart.includes(id);
}

/**
 * 加入 / 移出购物车。
 * @param {string} id 图片 id
 * @returns {boolean} 操作后是否在车内（true = 刚加入）
 */
export function toggleCartItem(id) {
  const idx = state.cart.indexOf(id);
  if (idx >= 0) state.cart.splice(idx, 1);
  else state.cart.push(id);
  emit('cart');
  return idx < 0;
}

/** 清空购物车 */
export function clearCart() {
  if (!state.cart.length) return;
  state.cart = [];
  emit('cart');
}

/** 购物车内的图片对象（按加入顺序；已被删除的记录自动跳过） */
export function cartImages() {
  return state.cart.map((id) => imageById(id)).filter(Boolean);
}

/**
 * 从当前筛选结果里随机抽 count 条「有正向提示词」的图，覆盖购物车。
 * 抽的是当前筛选（含搜索），所以换分类再抽就是另一批。
 *
 * @param {number} count 想要几条
 * @returns {{picked:number, pool:number}} 实际抽中条数 / 可选总数
 */
export function pickRandomCart(count) {
  const pool = getFiltered().filter((img) => String(img.positive || '').trim());
  const total = pool.length;
  if (!total) {
    state.cart = [];
    emit('cart');
    return { picked: 0, pool: 0 };
  }
  const n = Math.max(1, Math.min(Math.round(Number(count) || 1), total));
  // 部分 Fisher-Yates：只洗前 n 个，避免整池全洗
  const arr = pool.slice();
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(Math.random() * (arr.length - i));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  state.cart = arr.slice(0, n).map((img) => img.id);
  emit('cart');
  return { picked: n, pool: total };
}

/* ------------------------------------------------------------ 分类动作 */

/** 计算新分类的 order */
function nextOrder(level, parentId) {
  const siblings = level === 2
    ? state.categories.filter((c) => c.level === 2 && c.parentId === parentId)
    : state.categories.filter((c) => c.level === 1);
  return siblings.reduce((max, c) => Math.max(max, Number(c.order) || 0), -1) + 1;
}

/**
 * 新建分类。
 * @param {{name:string, level:1|2, parentId?:string|null, color?:string}} options
 */
export async function addCategory(options) {
  const level = options.level === 2 ? 2 : 1;
  let color = options.color;
  if (!color) {
    const parent = level === 2 ? categoryById(options.parentId) : null;
    color = parent ? parent.color : '#2f6fed';
  }
  const category = {
    id: uid(),
    name: String(options.name || '').trim(),
    level,
    parentId: level === 2 ? (options.parentId || null) : null,
    order: nextOrder(level, options.parentId || null),
    color,
    createdAt: Date.now()
  };
  state.categories.push(category);
  await db.putCategory(category);
  recompute();
  emit('categories');
  return category;
}

/**
 * 批量新增分类（用于 JSON 备份恢复）。
 * @param {Array} categories 完整分类对象数组
 */
export async function bulkAddCategories(categories = []) {
  if (!categories.length) return;
  const known = new Set(state.categories.map((c) => c.id));
  const list = categories.filter((c) => c && c.id && !known.has(c.id));
  if (!list.length) return;
  state.categories.push(...list);
  await db.putCategories(list);
  recompute();
  emit('categories');
}

/** 重命名 / 更新颜色 */
export async function updateCategory(id, patch) {
  const category = categoryById(id);
  if (!category) return null;
  Object.assign(category, patch);
  await db.putCategory(category);
  if (patch.color) {
    // 一级分类换色时同步其子分类
    if (category.level === 1) {
      const children = state.categories.filter((c) => c.level === 2 && c.parentId === category.id);
      children.forEach((c) => { c.color = patch.color; });
      await db.putCategories(children);
    }
  }
  recompute();
  emit('categories');
  return category;
}

/**
 * 删除分类：其下图片移回「未分类」；一级分类会同时删除其二级分类。
 * @param {string} id
 */
export async function deleteCategory(id) {
  const category = categoryById(id);
  if (!category) return;
  const removedIds = [category.id];
  if (category.level === 1) {
    state.categories.filter((c) => c.level === 2 && c.parentId === id)
      .forEach((c) => removedIds.push(c.id));
  }
  const removedSet = new Set(removedIds);

  // 图片归入未分类
  const affected = state.images.filter((img) => removedSet.has(img.categoryId) || removedSet.has(img.subCategoryId));
  affected.forEach((img) => {
    img.categoryId = null;
    img.subCategoryId = null;
    img.updatedAt = Date.now();
  });
  if (affected.length) await db.putImages(affected);

  state.categories = state.categories.filter((c) => !removedSet.has(c.id));
  await db.deleteCategories(removedIds);

  if (state.filter.categoryId && removedSet.has(state.filter.categoryId)) {
    state.filter = { kind: 'all', categoryId: null, subCategoryId: null };
  }
  if (state.filter.subCategoryId && removedSet.has(state.filter.subCategoryId)) {
    state.filter = { kind: 'all', categoryId: null, subCategoryId: null };
  }
  if (state.dbFilter.categoryId && removedSet.has(state.dbFilter.categoryId)) state.dbFilter.categoryId = '';
  if (state.dbFilter.subCategoryId && removedSet.has(state.dbFilter.subCategoryId)) state.dbFilter.subCategoryId = '';

  recompute();
  emit('categories');
}

/** 侧栏折叠状态切换 */
export function toggleCategoryCollapse(categoryId) {
  const collapsed = state.settings.collapsed || {};
  collapsed[categoryId] = !collapsed[categoryId];
  state.settings.collapsed = collapsed;
  emit('categories');
  db.setMeta('settings', state.settings).catch(() => {});
}

/* ------------------------------------------------------------ 其它 */

/** 全部标签（去重排序），供输入提示使用 */
export function allTags() {
  const set = new Set();
  state.images.forEach((img) => (img.tags || []).forEach((tag) => set.add(tag)));
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/* ==================================================================
 *  v2 模块一：LORA 触发词
 * ================================================================== */

/** 关键字匹配：任一字段命中即可（空格分隔表示同时包含） */
function matchKeywords(haystacks, keyword) {
  const words = String(keyword || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = haystacks.map((s) => String(s || '').toLowerCase()).join('\n');
  return words.every((w) => text.includes(w));
}

/** 按当前搜索关键字过滤 LORA 列表 */
export function filteredLoras() {
  return state.loras.filter((l) => matchKeywords([l.fileName, l.trigger, l.note], state.search));
}

/**
 * 批量新增 LORA（扫描文件夹后调用）。
 * @param {Array<{fileName:string, ext:string, size:number, relPath:string}>} records
 * @returns {Promise<Array>} 新增后的记录
 */
export async function addLoras(records = []) {
  if (!records.length) return [];
  const now = Date.now();
  const list = records.map((r) => ({
    id: uid(),
    fileName: r.fileName || '',
    ext: r.ext || '',
    size: Number(r.size) || 0,
    relPath: r.relPath || '',
    trigger: '',
    note: '',
    createdAt: now,
    updatedAt: now
  }));
  await db.putLoras(list);
  state.loras.push(...list);
  emit('loras');
  return list;
}

/** 更新单个 LORA（触发词 / 备注） */
export async function updateLora(id, patch) {
  const lora = state.loras.find((l) => l.id === id);
  if (!lora) return null;
  Object.assign(lora, patch, { updatedAt: Date.now() });
  await db.putLora(lora);
  emit('loras');
  return lora;
}

/** 删除若干 LORA */
export async function removeLoras(ids = []) {
  if (!ids.length) return;
  const set = new Set(ids);
  state.loras = state.loras.filter((l) => !set.has(l.id));
  await db.deleteLoras(ids);
  emit('loras');
}

/**
 * 记录当前映射的 loras 目录名（目录句柄本身存在 meta 里）。
 * @param {string} name
 */
export async function setLoraDirName(name) {
  state.loraDirName = name || '';
  await db.setMeta('loraDirName', state.loraDirName);
  emit('loras');
}

/**
 * 读取已保存的 loras 目录句柄（FileSystemDirectoryHandle）。
 * 浏览器支持把句柄结构化克隆进 IndexedDB，重新打开页面后可直接复用。
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function getLoraDirHandle() {
  try {
    return await db.getMeta('loraDirHandle', null);
  } catch (err) {
    console.warn('[PromptVault] 读取 loras 目录句柄失败', err);
    return null;
  }
}

/** 保存 loras 目录句柄 */
export async function setLoraDirHandle(handle) {
  await db.setMeta('loraDirHandle', handle);
}

/**
 * 用新扫描结果整体替换 LORA 列表（切换目录时使用）。
 * @param {Array} records
 */
export async function replaceLoras(records = []) {
  const oldIds = state.loras.map((l) => l.id);
  if (oldIds.length) await db.deleteLoras(oldIds);
  state.loras = [];
  return addLoras(records);
}

/* ==================================================================
 *  v2 模块二：编辑指令提示词
 * ================================================================== */

/** 按当前搜索关键字过滤编辑指令 */
export function filteredEdits() {
  return state.edits.filter((e) => matchKeywords(
    [e.title, e.instruction, (e.tags || []).join(' ')],
    state.search
  ));
}

/**
 * 新增一条编辑指令。
 * @param {object} record
 * @returns {Promise<object>}
 */
export async function addEdit(record) {
  const now = Date.now();
  const item = {
    id: uid(),
    title: '',
    instruction: '',
    tags: [],
    beforeBlob: null, beforeThumb: null, beforeMime: '', beforeWidth: 0, beforeHeight: 0,
    afterBlob: null, afterThumb: null, afterMime: '', afterWidth: 0, afterHeight: 0,
    createdAt: now,
    updatedAt: now,
    ...record
  };
  await db.putEdit(item);
  state.edits.unshift(item);
  emit('edits');
  return item;
}

/** 更新一条编辑指令 */
export async function updateEdit(id, patch) {
  const item = state.edits.find((e) => e.id === id);
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: Date.now() });
  await db.putEdit(item);
  emit('edits');
  return item;
}

/** 删除编辑指令 */
export async function removeEdits(ids = []) {
  if (!ids.length) return;
  const set = new Set(ids);
  state.edits = state.edits.filter((e) => !set.has(e.id));
  await db.deleteEdits(ids);
  emit('edits');
}

/* ==================================================================
 *  v2 模块三：资产图（原图存储，不压缩）
 * ================================================================== */

/** 资产图固定分类 */
export const ASSET_CATEGORIES = [
  '角色四视图', '场景资产图', '人物设计图', '道具设计图', '分镜图'
];

/** 按分类 + 搜索关键字过滤资产图 */
export function filteredAssets(category) {
  const cat = category || 'all';
  return state.assets.filter((a) => {
    if (cat !== 'all' && a.category !== cat) return false;
    return matchKeywords([a.name, a.note, a.category], state.search);
  });
}

/** 各分类下的资产图数量 */
export function assetCounts() {
  const out = { all: state.assets.length };
  ASSET_CATEGORIES.forEach((c) => { out[c] = 0; });
  state.assets.forEach((a) => {
    if (out[a.category] === undefined) out[a.category] = 0;
    out[a.category] += 1;
  });
  return out;
}

/** 新增资产图记录（blob 为原始未压缩数据） */
export async function addAssets(records = []) {
  if (!records.length) return [];
  const now = Date.now();
  const list = records.map((r) => ({
    id: uid(),
    name: '',
    category: ASSET_CATEGORIES[0],
    note: '',
    blob: null,
    thumb: null,
    mime: '',
    width: 0,
    height: 0,
    size: 0,
    hash: '',
    createdAt: now,
    updatedAt: now,
    ...r
  }));
  await db.putAssets(list);
  state.assets.unshift(...list);
  emit('assets');
  return list;
}

/** 更新资产图元信息 */
export async function updateAsset(id, patch) {
  const item = state.assets.find((a) => a.id === id);
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: Date.now() });
  await db.putAsset(item);
  emit('assets');
  return item;
}

/** 删除资产图 */
export async function removeAssets(ids = []) {
  if (!ids.length) return;
  const set = new Set(ids);
  state.assets = state.assets.filter((a) => !set.has(a.id));
  await db.deleteAssets(ids);
  emit('assets');
}

/** 已存在的资产图哈希集合（去重用） */
export function assetHashSet() {
  return new Set(state.assets.map((a) => a.hash).filter(Boolean));
}

/* ==================================================================
 *  v3 模块：LLM 系统提示词模板
 * ================================================================== */

/** 按当前搜索关键字过滤系统提示词 */
export function filteredSystemPrompts() {
  return state.systemPrompts.filter((p) => matchKeywords(
    [p.title, p.content, (p.tags || []).join(' ')],
    state.search
  ));
}

/**
 * 新增一条系统提示词模板。
 * @param {{title?:string, content:string, tags?:string[], note?:string}} record
 */
export async function addSystemPrompt(record) {
  const now = Date.now();
  const item = {
    id: uid(),
    title: '',
    content: '',
    tags: [],
    note: '',
    createdAt: now,
    updatedAt: now,
    ...record
  };
  await db.putPrompt(item);
  state.systemPrompts.unshift(item);
  emit('prompts');
  return item;
}

/** 更新系统提示词模板 */
export async function updateSystemPrompt(id, patch) {
  const item = state.systemPrompts.find((p) => p.id === id);
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: Date.now() });
  await db.putPrompt(item);
  emit('prompts');
  return item;
}

/** 删除系统提示词模板 */
export async function removeSystemPrompts(ids = []) {
  if (!ids.length) return;
  const set = new Set(ids);
  state.systemPrompts = state.systemPrompts.filter((p) => !set.has(p.id));
  await db.deletePrompts(ids);
  emit('prompts');
}
