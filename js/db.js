/* =========================================================================
 * js/db.js —— IndexedDB 数据访问层
 * 库名 promptvault / version 2，
 * objectStore：categories、images、meta、loras、edits、assets。
 * 若 IndexedDB 不可用则整体降级为内存实现（API 完全一致）。
 * ========================================================================= */

import { uid } from './utils.js';

export const DB_NAME = 'promptvault';
export const DB_VERSION = 3;

const STORE_CATEGORIES = 'categories';
const STORE_IMAGES = 'images';
const STORE_META = 'meta';
const STORE_LORAS = 'loras';
const STORE_EDITS = 'edits';
const STORE_ASSETS = 'assets';
const STORE_PROMPTS = 'prompts';

/** 种子分类数据：一级分类 + 二级分类 */
const SEED_CATEGORIES = [
  { name: '风格', color: '#2f6fed', subs: ['写实摄影', '动漫插画', '油画', '水彩', '3D 渲染', '像素风', '赛博朋克', '水墨'] },
  { name: '主体', color: '#0f9d58', subs: ['人物', '动物', '建筑', '地景', '植物', '食物', '物品道具', '机械载具'] },
  { name: '场景', color: '#8b5cf6', subs: ['室内', '街道', '自然荒野', '幻想世界', '太空', '水下'] }
];

/**
 * 已废弃的一级分类名（不再提供，老数据由 migrateRetiredCategories 清理）。
 * 这几个维度几乎人人都写、又总被「主体/风格」压过，自动分类命中率极低
 * （镜头构图 0%、场景外的修饰类合计不到 13%），保留只会让用户看到永远填不上的分类。
 */
const RETIRED_TOP_CATEGORIES = ['光照氛围', '镜头构图', '画质增强'];

/* ------------------------------------------------------------ 运行状态 */

let _db = null;
let _memory = false;
const _mem = {
  categories: new Map(),
  images: new Map(),
  meta: new Map(),
  loras: new Map(),
  edits: new Map(),
  assets: new Map(),
  prompts: new Map()
};

/** 当前是否处于内存降级模式 */
export function isMemoryMode() {
  return _memory;
}

/* --------------------------------------------------- IndexedDB 底层封装 */

function openIndexedDB() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('当前环境不支持 IndexedDB')); return; }
    let request;
    try {
      request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) { reject(err); return; }

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_CATEGORIES)) {
        const store = db.createObjectStore(STORE_CATEGORIES, { keyPath: 'id' });
        store.createIndex('parentId', 'parentId', { unique: false });
        store.createIndex('level', 'level', { unique: false });
        store.createIndex('order', 'order', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        const store = db.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
        store.createIndex('categoryId', 'categoryId', { unique: false });
        store.createIndex('subCategoryId', 'subCategoryId', { unique: false });
        store.createIndex('favorite', 'favorite', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('hash', 'hash', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      // v2 新增：LORA 触发词库
      if (!db.objectStoreNames.contains(STORE_LORAS)) {
        const store = db.createObjectStore(STORE_LORAS, { keyPath: 'id' });
        store.createIndex('fileName', 'fileName', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      // v2 新增：编辑指令提示词
      if (!db.objectStoreNames.contains(STORE_EDITS)) {
        const store = db.createObjectStore(STORE_EDITS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      // v2 新增：资产图（原图存储，不压缩）
      if (!db.objectStoreNames.contains(STORE_ASSETS)) {
        const store = db.createObjectStore(STORE_ASSETS, { keyPath: 'id' });
        store.createIndex('category', 'category', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('hash', 'hash', { unique: false });
      }
      // v3 新增：LLM 系统提示词模板
      if (!db.objectStoreNames.contains(STORE_PROMPTS)) {
        const store = db.createObjectStore(STORE_PROMPTS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开数据库失败'));
    request.onblocked = () => reject(new Error('数据库被其他标签页占用'));
  });
}

/** 事务完成 Promise */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('事务失败'));
    tx.onabort = () => reject(tx.error || new Error('事务被中止'));
  });
}

/** 请求完成 Promise */
function reqDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('请求失败'));
  });
}

/** 浅拷贝，避免内存态被外部引用直接改写 */
function shallowCopy(record) {
  return record ? { ...record } : record;
}

/* ------------------------------------------------------------ 初始化 */

/**
 * 初始化数据库连接。
 * @returns {Promise<{mode:'idb'|'memory', error: Error|null}>}
 */
export async function initDB() {
  try {
    _db = await openIndexedDB();
    _memory = false;
    return { mode: 'idb', error: null };
  } catch (err) {
    console.warn('[PromptVault] IndexedDB 不可用，降级为内存模式：', err);
    _db = null;
    _memory = true;
    return { mode: 'memory', error: err };
  }
}

/* ------------------------------------------------------------ 分类 */

/** 读取全部分类 */
export async function getAllCategories() {
  if (_memory) return Array.from(_mem.categories.values()).map(shallowCopy);
  const tx = _db.transaction(STORE_CATEGORIES, 'readonly');
  const list = await reqDone(tx.objectStore(STORE_CATEGORIES).getAll());
  return Array.isArray(list) ? list : [];
}

/** 写入（新增/覆盖）单个分类 */
export async function putCategory(category) {
  const record = { ...category };
  if (_memory) { _mem.categories.set(record.id, record); return record; }
  const tx = _db.transaction(STORE_CATEGORIES, 'readwrite');
  tx.objectStore(STORE_CATEGORIES).put(record);
  await txDone(tx);
  return record;
}

/** 批量写入分类 */
export async function putCategories(categories = []) {
  if (!categories.length) return;
  if (_memory) {
    categories.forEach((c) => _mem.categories.set(c.id, { ...c }));
    return;
  }
  const tx = _db.transaction(STORE_CATEGORIES, 'readwrite');
  const store = tx.objectStore(STORE_CATEGORIES);
  categories.forEach((c) => store.put({ ...c }));
  await txDone(tx);
}

/** 删除一批分类 */
export async function deleteCategories(ids = []) {
  if (!ids.length) return;
  if (_memory) {
    ids.forEach((id) => _mem.categories.delete(id));
    return;
  }
  const tx = _db.transaction(STORE_CATEGORIES, 'readwrite');
  const store = tx.objectStore(STORE_CATEGORIES);
  ids.forEach((id) => store.delete(id));
  await txDone(tx);
}

/* ------------------------------------------------------------ 图片 */

/** 读取全部图片 */
export async function getAllImages() {
  if (_memory) return Array.from(_mem.images.values()).map(shallowCopy);
  const tx = _db.transaction(STORE_IMAGES, 'readonly');
  const list = await reqDone(tx.objectStore(STORE_IMAGES).getAll());
  return Array.isArray(list) ? list : [];
}

/** 读取单张图片 */
export async function getImage(id) {
  if (_memory) return shallowCopy(_mem.images.get(id)) || null;
  const tx = _db.transaction(STORE_IMAGES, 'readonly');
  const record = await reqDone(tx.objectStore(STORE_IMAGES).get(id));
  return record || null;
}

/** 写入（新增/覆盖）单张图片 */
export async function putImage(image) {
  const record = { ...image };
  if (_memory) { _mem.images.set(record.id, record); return record; }
  const tx = _db.transaction(STORE_IMAGES, 'readwrite');
  tx.objectStore(STORE_IMAGES).put(record);
  await txDone(tx);
  return record;
}

/** 批量写入图片 */
export async function putImages(images = []) {
  if (!images.length) return;
  if (_memory) {
    images.forEach((img) => _mem.images.set(img.id, { ...img }));
    return;
  }
  const tx = _db.transaction(STORE_IMAGES, 'readwrite');
  const store = tx.objectStore(STORE_IMAGES);
  images.forEach((img) => store.put({ ...img }));
  await txDone(tx);
}

/** 删除一批图片 */
export async function deleteImages(ids = []) {
  if (!ids.length) return;
  if (_memory) {
    ids.forEach((id) => _mem.images.delete(id));
    return;
  }
  const tx = _db.transaction(STORE_IMAGES, 'readwrite');
  const store = tx.objectStore(STORE_IMAGES);
  ids.forEach((id) => store.delete(id));
  await txDone(tx);
}

/* ------------------------------------------------------------ meta */

/** 读取 meta 值 */
export async function getMeta(key, fallback = null) {
  if (_memory) return _mem.meta.has(key) ? _mem.meta.get(key) : fallback;
  const tx = _db.transaction(STORE_META, 'readonly');
  const record = await reqDone(tx.objectStore(STORE_META).get(key));
  return record && 'value' in record ? record.value : fallback;
}

/** 写入 meta 值 */
export async function setMeta(key, value) {
  if (_memory) { _mem.meta.set(key, value); return; }
  const tx = _db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).put({ key, value });
  await txDone(tx);
}

/* ------------------------------------------------------------ 种子数据 */

/**
 * 首次打开时写入种子分类。
 * @returns {Promise<{seeded:boolean, categories:Array}>}
 */
export async function seedCategories() {
  const existing = await getAllCategories();
  if (existing.some((c) => c.level === 1)) {
    return { seeded: false, categories: existing };
  }
  const now = Date.now();
  const created = [];
  let topOrder = 0;
  for (const group of SEED_CATEGORIES) {
    const parentId = uid();
    created.push({
      id: parentId,
      name: group.name,
      level: 1,
      parentId: null,
      order: topOrder,
      color: group.color,
      createdAt: now
    });
    topOrder += 1;
    group.subs.forEach((subName, index) => {
      created.push({
        id: uid(),
        name: subName,
        level: 2,
        parentId,
        order: index,
        color: group.color,
        createdAt: now
      });
    });
  }
  await putCategories(created);
  return { seeded: true, categories: created };
}

/**
 * 一次性迁移：移除已废弃的三个修饰类分类（光照氛围 / 镜头构图 / 画质增强）。
 *
 * 只跑一次（写 meta 标记）。归在这些分类下的图片会被移回「未分类」，
 * 不会丢图，只是分类字段被清空，用户可以重新归类。
 *
 * @returns {Promise<{skipped:boolean, removedCategories:number, affectedImages:number}>}
 */
export async function migrateRetiredCategories() {
  const META_KEY = 'migrated_retired_categories_v1';
  const done = await getMeta(META_KEY, false);
  if (done) return { skipped: true, removedCategories: 0, affectedImages: 0 };

  const categories = await getAllCategories();
  const targets = categories.filter((c) => c.level === 1 && RETIRED_TOP_CATEGORIES.includes(c.name));

  if (!targets.length) {
    await setMeta(META_KEY, true);
    return { skipped: false, removedCategories: 0, affectedImages: 0 };
  }

  // 一级分类 + 其下全部二级分类
  const doomed = new Set();
  targets.forEach((top) => {
    doomed.add(top.id);
    categories.filter((c) => c.level === 2 && c.parentId === top.id).forEach((c) => doomed.add(c.id));
  });

  // 受影响的图片：清空分类字段，退回未分类
  const images = await getAllImages();
  const affected = images.filter((img) => doomed.has(img.categoryId) || doomed.has(img.subCategoryId));
  if (affected.length) {
    affected.forEach((img) => {
      img.categoryId = null;
      img.subCategoryId = null;
      img.updatedAt = Date.now();
    });
    await putImages(affected);
  }

  await deleteCategories(Array.from(doomed));
  await setMeta(META_KEY, true);

  return { skipped: false, removedCategories: doomed.size, affectedImages: affected.length };
}

/** 计算指定分类 id 集合中的（未被引用的）分类 id 列表 —— 供删除前校验使用 */
export async function findUnusedCategoryIds(ids = []) {
  const images = await getAllImages();
  const used = new Set();
  images.forEach((img) => {
    if (img.categoryId) used.add(img.categoryId);
    if (img.subCategoryId) used.add(img.subCategoryId);
  });
  return ids.filter((id) => !used.has(id));
}

/* ------------------------------------------------ v2 通用集合访问层 */

/**
 * 为结构相同的集合生成统一 CRUD（all / put / putMany / remove / clear）。
 * 内存模式下自动落到对应 Map，API 与 IndexedDB 分支完全一致。
 *
 * @param {string} storeName objectStore 名称
 * @param {Map} memMap 内存降级用的 Map
 */
function makeCollection(storeName, memMap) {
  return {
    async all() {
      if (_memory) return Array.from(memMap.values()).map(shallowCopy);
      const tx = _db.transaction(storeName, 'readonly');
      const list = await reqDone(tx.objectStore(storeName).getAll());
      return Array.isArray(list) ? list : [];
    },
    async put(record) {
      const copy = { ...record };
      if (_memory) { memMap.set(copy.id, copy); return copy; }
      const tx = _db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(copy);
      await txDone(tx);
      return copy;
    },
    async putMany(records = []) {
      if (!records.length) return;
      if (_memory) { records.forEach((r) => memMap.set(r.id, { ...r })); return; }
      const tx = _db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      records.forEach((r) => store.put({ ...r }));
      await txDone(tx);
    },
    async remove(ids = []) {
      if (!ids.length) return;
      if (_memory) { ids.forEach((id) => memMap.delete(id)); return; }
      const tx = _db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      ids.forEach((id) => store.delete(id));
      await txDone(tx);
    },
    async clear() {
      if (_memory) { memMap.clear(); return; }
      const tx = _db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      await txDone(tx);
    }
  };
}

const loraCol = makeCollection(STORE_LORAS, _mem.loras);
const editCol = makeCollection(STORE_EDITS, _mem.edits);
const assetCol = makeCollection(STORE_ASSETS, _mem.assets);
const promptCol = makeCollection(STORE_PROMPTS, _mem.prompts);

/* LORA 触发词 */
export const getAllLoras = () => loraCol.all();
export const putLora = (record) => loraCol.put(record);
export const putLoras = (records) => loraCol.putMany(records);
export const deleteLoras = (ids) => loraCol.remove(ids);
export const clearLoras = () => loraCol.clear();

/* 编辑指令提示词 */
export const getAllEdits = () => editCol.all();
export const putEdit = (record) => editCol.put(record);
export const putEdits = (records) => editCol.putMany(records);
export const deleteEdits = (ids) => editCol.remove(ids);
export const clearEdits = () => editCol.clear();

/* 资产图 */
export const getAllAssets = () => assetCol.all();
export const putAsset = (record) => assetCol.put(record);
export const putAssets = (records) => assetCol.putMany(records);
export const deleteAssets = (ids) => assetCol.remove(ids);
export const clearAssets = () => assetCol.clear();

/* LLM 系统提示词模板 */
export const getAllPrompts = () => promptCol.all();
export const putPrompt = (record) => promptCol.put(record);
export const putPrompts = (records) => promptCol.putMany(records);
export const deletePrompts = (ids) => promptCol.remove(ids);
export const clearPrompts = () => promptCol.clear();
