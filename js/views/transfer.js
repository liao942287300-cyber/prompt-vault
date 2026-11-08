/* =========================================================================
 * js/views/transfer.js —— 导入 / 导出
 * 导入：拖拽、多选文件、整文件夹递归、同名 .txt/.json 配对、SHA-256 去重、进度条
 * 导出：全库 JSON、仅元数据 JSON、CSV、当前筛选结果 / 选中项
 * ========================================================================= */

import * as store from '../store.js';
import {
  el, icon, openModal, toast, confirmDialog, chooseDialog,
  sha256Hex, genThumbnail, uid, isImageFile, readFileAsText, blobToDataURL,
  dataURLToBlob, downloadBlob, parseCsv, toCsv, stamp, baseNameNoExt,
  stripExt, formatBytes, compressImage, compressAndThumbnail, debounce, MAX_IMAGE_BYTES
} from '../utils.js';
import { readPngPromptMeta, isPngFile } from '../png-meta.js';
import { parseDocxStructure, loadDocxImage } from '../docx-import.js';
import { classifyPrompt } from '../auto-classify.js';

/** CSV 列顺序 */
const CSV_HEADER = ['name', 'category', 'subCategory', 'positive', 'negative', 'params', 'tags', 'favorite'];

/** 去重策略：本次导入内统一生效 */
const DUP = { SKIP: 'skip', OVERWRITE: 'overwrite', KEEP: 'keep' };

/**
 * 挂载导入 / 导出模块。
 * @param {{}} ctx
 */
export function mountTransfer(ctx) {
  /* ==================================================================
   *  一、辅助函数
   * ================================================================== */

  /** 把「布尔字符串」转换为布尔值 */
  function toBool(value) {
    if (typeof value === 'boolean') return value;
    const s = String(value == null ? '' : value).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === '是' || s === 'y';
  }

  /** 文本框 / 分类名 → 分类 id */
  function findTopByName(name) {
    const target = String(name || '').trim().toLowerCase();
    if (!target) return null;
    const hit = store.topCategories().find((c) => c.name.trim().toLowerCase() === target);
    return hit ? hit.id : null;
  }

  function findSubByName(parentId, name) {
    const target = String(name || '').trim().toLowerCase();
    if (!target || !parentId) return null;
    const hit = store.subCategoriesOf(parentId).find((c) => c.name.trim().toLowerCase() === target);
    return hit ? hit.id : null;
  }

  /* --- 自动分类（按提示词内容推断） --- */

  /**
   * 自动分类是否生效：调用方显式传 false 时优先，否则看全局设置。
   * @param {{autoClassify?:boolean}|null} [target]
   * @returns {boolean}
   */
  function isAutoClassifyOn(target) {
    if (target && target.autoClassify === false) return false;
    return store.state.settings.autoClassify !== false;
  }

  /**
   * 按提示词文本推断分类（薄封装，便于统一取值来源）。
   * @param {string} text
   * @returns {{categoryId:string|null, subCategoryId:string|null, label:string,
   *            score:number, hits:string[]}}
   */
  function guessCategory(text) {
    return classifyPrompt(text, store.state.categories);
  }

  /**
   * 分类路径文本，例如「风格 / 写实摄影」；没有任何分类时返回空串。
   * @param {string|null} categoryId
   * @param {string|null} subCategoryId
   * @returns {string}
   */
  function categoryPathOf(categoryId, subCategoryId) {
    const sub = store.categoryById(subCategoryId);
    const top = store.categoryById(categoryId) || (sub ? store.categoryById(sub.parentId) : null);
    const parts = [];
    if (top) parts.push(top.name);
    if (sub) parts.push(sub.name);
    return parts.join(' / ');
  }

  /**
   * 拼装导入结果里的自动分类统计后缀。
   * @param {{autoClassified?:number, uncategorized?:number}} result
   * @returns {string} 形如「（自动分类 9 张，未识别 3 张）」，无统计时为空串
   */
  function autoStatsSuffix(result) {
    const parts = [];
    if (result && result.autoClassified) parts.push(`自动分类 ${result.autoClassified} 张`);
    if (result && result.uncategorized) parts.push(`未识别 ${result.uncategorized} 张`);
    return parts.length ? `（${parts.join('，')}）` : '';
  }

  /** 收集同名配对文件（.txt / -neg.txt / .json） */
  function collectSidecars(files) {
    const map = new Map();
    const get = (key) => {
      if (!map.has(key)) map.set(key, {});
      return map.get(key);
    };
    for (const file of files) {
      if (isImageFile(file)) continue;
      const path = (file.webkitRelativePath || file.name || '').toLowerCase();
      const stem = stripExt(path);
      if (path.endsWith('.txt')) {
        const matched = /(_negative|-neg|-n)$/.exec(stem);
        if (matched) get(stem.slice(0, matched.index)).neg = file;
        else get(stem).txt = file;
      } else if (path.endsWith('.json')) {
        get(stem).json = file;
      }
    }
    return map;
  }

  /** 解析单张图片的配对文件 */
  async function parseSidecars(file, sidecarMap) {
    const path = (file.webkitRelativePath || file.name || '').toLowerCase();
    const stem = stripExt(path);
    const sidecar = sidecarMap.get(stem) || {};
    const result = {
      name: baseNameNoExt(file.name),
      positive: '', negative: '', params: '', tags: [],
      category: '', subCategory: ''
    };

    if (sidecar.txt) {
      result.positive = (await readFileAsText(sidecar.txt)).trim();
    }
    if (sidecar.neg) {
      result.negative = (await readFileAsText(sidecar.neg)).trim();
    }
    if (sidecar.json) {
      try {
        const raw = await readFileAsText(sidecar.json);
        const data = JSON.parse(raw);
        if (typeof data === 'string') {
          result.positive = result.positive || data.trim();
        } else if (data && typeof data === 'object') {
          result.positive = data.prompt || data.positive || result.positive || '';
          result.negative = data.negative_prompt || data.negative || result.negative || '';
          if (Array.isArray(data.tags)) result.tags = data.tags.map((t) => String(t).trim()).filter(Boolean);
          else if (typeof data.tags === 'string') {
            result.tags = data.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
          }
          if (typeof data.params === 'string') result.params = data.params;
          else if (data.params) result.params = JSON.stringify(data.params);
          result.category = data.category ? String(data.category) : '';
          result.subCategory = data.subCategory ? String(data.subCategory) : '';
          if (data.name && !result.name) result.name = String(data.name);
        }
      } catch (err) {
        console.warn('[PromptVault] JSON 配对文件解析失败：', sidecar.json.name, err);
      }
    }
    return result;
  }

  /* ==================================================================
   *  一·B、导入：共用构件（主链路与快速导入共用，避免复制粘贴两份逻辑）
   * ================================================================== */

  /**
   * 读取 PNG 内嵌提示词。非 PNG 直接返回空对象，不额外读文件。
   * @param {File} file
   * @returns {Promise<{positive:string, negative:string, params:string}>}
   */
  async function readEmbeddedMeta(file) {
    const empty = { positive: '', negative: '', params: '' };
    if (!isPngFile(file)) return empty;
    try {
      const meta = await readPngPromptMeta(file);
      return {
        positive: meta.positive || '',
        negative: meta.negative || '',
        params: meta.params || ''
      };
    } catch (err) {
      console.warn('[PromptVault] PNG 内嵌提示词解析失败：', file && file.name, err);
      return empty;
    }
  }

  /**
   * 解析分类归属。优先级（高 → 低）：
   *   1. 用户在导入弹窗里手动选过分类（catTouched）→ 完全以用户为准
   *   2. 配对 JSON 里记录的 category / subCategory → 文件自带的元数据比推断可信
   *   3. 自动分类开关打开 → 按提示词内容推断
   *   4. 回落到 target 上的预填值（来自左栏当前筛选）
   *
   * 关键点：左栏预填值**不算**「用户已指定」，只是兜底；
   * 否则用户在某个分类下点导入时，自动分类会全程失效。
   *
   * @param {{categoryId?:string|null, subCategoryId?:string|null,
   *          autoClassify?:boolean, catTouched?:boolean}} target
   * @param {{category?:string, subCategory?:string}} parsed
   * @param {string} [positiveText] 提示词正文，用于自动推断
   * @returns {{categoryId:string|null, subCategoryId:string|null, auto:boolean}}
   *          auto 为 true 表示分类来自自动推断（回落预填值时为 false）
   */
  function resolveCategory(target, parsed, positiveText) {
    const preset = {
      categoryId: (target && target.categoryId) || null,
      subCategoryId: (target && target.subCategoryId) || null
    };

    // 1) 用户手动选择：最高优先级
    if (target && target.catTouched) return { ...preset, auto: false };

    // 2) 配对文件自带的分类名
    if (parsed && parsed.category) {
      const byName = findTopByName(parsed.category);
      if (byName) {
        const subId = parsed.subCategory ? findSubByName(byName, parsed.subCategory) : null;
        return { categoryId: byName, subCategoryId: subId, auto: false };
      }
    }

    // 3) 按提示词自动推断
    if (isAutoClassifyOn(target)) {
      const guess = guessCategory(positiveText);
      if (guess.categoryId || guess.subCategoryId) {
        return { categoryId: guess.categoryId, subCategoryId: guess.subCategoryId, auto: true };
      }
    }

    // 4) 推断失败 / 开关关闭：回落到预填值（不计入「自动分类」统计）
    return { ...preset, auto: false };
  }

  /**
   * 构造「一级 + 二级」联动分类下拉（Word 预览逐条改分类用）。
   * 用户改动时回调 onChange；程序化 set 不触发回调，便于自动推断回填。
   *
   * @param {{categoryId?:string|null, subCategoryId?:string|null}} [initial]
   * @param {(next:{categoryId:string|null, subCategoryId:string|null})=>void} [onChange]
   * @returns {{node:HTMLElement,
   *            set:(next:{categoryId?:string|null, subCategoryId?:string|null})=>void,
   *            value:()=>({categoryId:string|null, subCategoryId:string|null})}}
   */
  function createCategoryPicker(initial = {}, onChange) {
    const node = el('div', { class: 'docx-cat-picker' });
    const topSelect = el('select', { class: 'select docx-cat-select' });
    const subSelect = el('select', { class: 'select docx-cat-select' });

    /** 选项里不存在该值时，浏览器会把 value 置空，这里显式回落到空串 */
    const applyValue = (select, value) => {
      const next = value || '';
      select.value = next;
      if (select.value !== next) select.value = '';
    };

    const fillTops = (selected) => {
      topSelect.innerHTML = '';
      topSelect.appendChild(el('option', { value: '', text: '未分类（一级）' }));
      store.topCategories().forEach((c) => topSelect.appendChild(el('option', { value: c.id, text: c.name })));
      applyValue(topSelect, selected);
    };

    const fillSubs = (parentId, selected) => {
      subSelect.innerHTML = '';
      subSelect.appendChild(el('option', { value: '', text: '未指定（二级）' }));
      store.subCategoriesOf(parentId).forEach((c) => subSelect.appendChild(el('option', { value: c.id, text: c.name })));
      applyValue(subSelect, selected);
    };

    const value = () => ({
      categoryId: topSelect.value || null,
      subCategoryId: subSelect.value || null
    });

    const notify = () => {
      if (typeof onChange === 'function') onChange(value());
    };

    fillTops(initial.categoryId);
    fillSubs(topSelect.value, initial.subCategoryId);

    topSelect.addEventListener('change', () => {
      fillSubs(topSelect.value, '');
      notify();
    });
    subSelect.addEventListener('change', notify);

    node.appendChild(topSelect);
    node.appendChild(subSelect);

    return {
      node,
      value,
      /** 程序化回填（不触发 onChange） */
      set(next = {}) {
        fillTops(next.categoryId);
        fillSubs(topSelect.value, next.subCategoryId);
      }
    };
  }

  /**
   * 组装单条图片记录：压缩 → 缩略图 → record。主链路与快速导入共用。
   * @param {File} file 原始图片文件
   * @param {{name?:string, positive?:string, negative?:string, params?:string,
   *          tags?:string[], categoryId?:string|null, subCategoryId?:string|null}} meta
   * @param {string} hash 对「原始文件」计算的 SHA-256（去重语义以原图为准）
   * @param {object} [precompressed] 已经跑过压缩的结果，传入可省去一次重复压缩
   * @returns {Promise<object>} 可直接写入 IndexedDB 的 record
   */
  async function buildRecord(file, meta, hash, precomputed) {
    // 批量导入走 compressAndThumbnail：一次解码同时出压缩图和缩略图，典型 1 次编码。
    // precomputed 用于快速导入（已提前压过），此时只需补一张缩略图。
    let result = precomputed && precomputed.blob
      ? precomputed
      : await compressAndThumbnail(file, {
        maxBytes: MAX_IMAGE_BYTES,
        thumbEdge: 480,
        thumbQuality: 0.8
      });

    const blob = result.blob || file;

    let thumb = result.thumb || null;
    let width = result.width || 0;
    let height = result.height || 0;
    if (!thumb) {
      // 快速导入路径没带缩略图，补一张
      const t = await genThumbnail(blob, 480, 0.82);
      thumb = t.thumb || null;
      if (!width) { width = t.width || 0; height = t.height || 0; }
    }

    const now = Date.now();
    return {
      id: uid(),
      name: meta.name || baseNameNoExt(file.name),
      blob,
      thumb,
      // mime 必须与 blob 实际内容一致
      mime: blob.type || result.mime || file.type || 'image/*',
      width,
      height,
      size: blob.size,
      positive: meta.positive || '',
      negative: meta.negative || '',
      params: meta.params || '',
      categoryId: meta.categoryId || null,
      subCategoryId: meta.subCategoryId || null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      favorite: false,
      note: '',
      hash: hash || '',
      createdAt: now,
      updatedAt: now
    };
  }

  /** 读取 DataTransfer 中的全部文件（支持文件夹递归） */
  async function filesFromDataTransfer(dataTransfer) {
    const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
    const entries = [];
    // 必须在事件回调同步阶段取出 entry，异步后 items 会失效
    for (const item of items) {
      if (item.kind === 'file' && typeof item.webkitGetAsEntry === 'function') {
        const entry = item.webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
    }
    if (!entries.length) return Array.from(dataTransfer.files || []);

    const collected = [];

    async function readDirectory(reader) {
      const all = [];
      // readEntries 每次最多返回 100 条，需要循环读取
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await new Promise((resolve, reject) => {
          reader.readEntries((res) => resolve(res || []), (err) => reject(err));
        });
        if (!batch.length) break;
        all.push(...batch);
      }
      return all;
    }

    async function walk(entry, prefix) {
      if (!entry) return;
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        try {
          Object.defineProperty(file, 'webkitRelativePath', {
            value: `${prefix}${entry.name}`,
            configurable: true
          });
        } catch (err) { /* 部分浏览器禁止改写，忽略 */ }
        collected.push(file);
      } else if (entry.isDirectory) {
        const children = await readDirectory(entry.createReader());
        for (const child of children) await walk(child, `${prefix}${entry.name}/`);
      }
    }

    for (const entry of entries) await walk(entry, '');
    return collected.length ? collected : Array.from(dataTransfer.files || []);
  }

  /* ==================================================================
   *  二、导入：图片
   * ================================================================== */

  /**
   * 导入一批文件（图片 + 配对文件）。
   * @param {File[]} files
   * @param {{categoryId?:string|null, subCategoryId?:string|null, autoClassify?:boolean}} target
   * @param {(done:number, total:number, phase?:'compress'|'done')=>void} [onProgress]
   *        第三参数为阶段标识：'compress' 表示正在压缩当前图片，'done' 表示该图片已处理完毕。
   * @returns {Promise<{added:number, skipped:number, autoClassified:number, uncategorized:number}>}
   *          autoClassified 为自动推断出分类的张数，uncategorized 为最终仍无分类的张数
   */
  async function importImageFiles(files, target = {}, onProgress) {
    const all = Array.from(files || []);
    const images = all.filter(isImageFile);
    if (!images.length) {
      toast('没有找到可导入的图片文件', 'warn');
      return { added: 0, skipped: 0, autoClassified: 0, uncategorized: 0 };
    }

    const sidecarMap = collectSidecars(all);
    const total = images.length;
    let done = 0;
    let dupPolicy = null;
    let addedCount = 0;
    let skippedCount = 0;
    let autoCount = 0;
    let uncategorizedCount = 0;
    const records = [];

    /** 每批处理完就写一次库：上万张图全压在内存里会撑爆（压缩后每张仍可达 300KB） */
    async function flushRecords() {
      if (!records.length) return;
      const batch = records.splice(0, records.length);
      // 用 silent 版写库：中途不重算不重绘，否则每批都遍历全库会把界面拖死
      await store.bulkAddImagesSilent(batch);
      // 已落库的记录去掉 pending 标记，后续遇到重复项时按正式记录处理（可真正删除）
      batch.forEach((r) => {
        const entry = r.hash ? hashIndex.get(r.hash) : null;
        if (entry && entry.__pending) delete entry.__pending;
      });
    }

    // 已存在的哈希集合（用于快速比对）
    const hashIndex = new Map();
    store.state.images.forEach((image) => { if (image.hash) hashIndex.set(image.hash, image); });

    /**
     * 重复项策略只问一次。并发处理时多个任务会同时发现重复，
     * 用同一个 Promise 兜住，避免弹出好几个对话框。
     */
    let dupPolicyPromise = null;
    async function getDupPolicy(fileName) {
      if (dupPolicy) return dupPolicy;
      if (!dupPolicyPromise) {
        dupPolicyPromise = askDuplicatePolicy(fileName).then((v) => {
          dupPolicy = v === null || v === undefined ? DUP.SKIP : v;
          return dupPolicy;
        });
      }
      return dupPolicyPromise;
    }

    /** 处理单张图（并发执行的最小单元） */
    async function processOne(file) {
      try {
        const parsed = await parseSidecars(file, sidecarMap);
        // PNG 内嵌提示词：仅作为配对文件的补位，优先级低于同名 .txt / .json
        const embedded = await readEmbeddedMeta(file);
        const hash = await sha256Hex(file);
        let skipThis = false;

        // 与库中已有（或本批次已排队）的相同内容比对
        const duplicate = hash ? hashIndex.get(hash) : null;
        if (duplicate) {
          const policy = await getDupPolicy(file.name);
          if (policy === DUP.SKIP) {
            skipThis = true;
            skippedCount += 1;
          } else if (policy === DUP.OVERWRITE) {
            if (duplicate.__pending) {
              // 本批次内已排队的重复项：直接丢弃，等价于覆盖
              const pos = records.findIndex((r) => r.id === duplicate.id);
              if (pos >= 0) { records.splice(pos, 1); addedCount -= 1; }
            } else if (store.imageById(duplicate.id)) {
              await store.removeImages([duplicate.id], { silent: true });
            }
            hashIndex.delete(hash);
          }
          // DUP.KEEP：两份都保留，继续按新记录写入
        }

        if (!skipThis) {
          // 配对 .txt / .json 与 PNG 内嵌元数据都算数，先合并出最终提示词再推断分类
          const positiveText = parsed.positive || embedded.positive;
          const resolved = resolveCategory(target, parsed, positiveText);
          const record = await buildRecord(file, {
            name: parsed.name || baseNameNoExt(file.name),
            positive: positiveText,
            negative: parsed.negative || embedded.negative,
            params: parsed.params || embedded.params,
            tags: parsed.tags || [],
            categoryId: resolved.categoryId,
            subCategoryId: resolved.subCategoryId
          }, hash);
          records.push(record);
          hashIndex.set(hash, { id: record.id, __pending: true });
          addedCount += 1;
          if (resolved.auto) autoCount += 1;
          if (!resolved.categoryId && !resolved.subCategoryId) uncategorizedCount += 1;
        }
      } catch (err) {
        console.error('[PromptVault] 导入失败：', file.name, err);
      } finally {
        done += 1;
        if (typeof onProgress === 'function' && (done % 10 === 0 || done === total)) {
          onProgress(done, total, 'done');
        }
      }
    }

    /*
     * 并发批处理。
     * 单张图的耗时几乎全在 canvas 编码上，编码可以并行，但要照顾低配置电脑：
     * 并发度高于物理核数会互相抢占，反而更慢甚至把页面拖死。
     * 4 路是保守值（4 核机器刚好一人一路，8 核以上也能稳定跑）。
     *
     * 并发度同时受两个上限约束：
     *   1. 条数上限 CONCURRENCY
     *   2. 本批原始字节总量 MAX_BATCH_BYTES —— 一张 1088×1920 解码后约占 8MB，
     *      几 MB 的大图连开多张会直接把页面打崩（实测过），所以大图自动退化成 2 张一批。
     */
    const CONCURRENCY = 4;
    const MAX_BATCH_BYTES = 12 * 1024 * 1024;

    let batch = [];
    let batchBytes = 0;

    async function flushBatch() {
      if (!batch.length) return;
      const chunk = batch;
      batch = [];
      batchBytes = 0;
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(chunk.map((f) => processOne(f)));
      // eslint-disable-next-line no-await-in-loop
      await flushRecords();
    }

    for (let i = 0; i < images.length; i += 1) {
      const file = images[i];
      if (batch.length >= CONCURRENCY
        || (batch.length > 0 && batchBytes + file.size > MAX_BATCH_BYTES)) {
        // eslint-disable-next-line no-await-in-loop
        await flushBatch();
      }
      batch.push(file);
      batchBytes += file.size;

      if (i % 40 === 0) {
        if (typeof onProgress === 'function') onProgress(done, total, 'compress');
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await flushBatch();

    await flushRecords();
    // 导入结束统一刷新一次（中途都是 silent 写库，不重算不重绘）
    store.refreshAfterBulkImport();
    return {
      added: addedCount,
      skipped: skippedCount,
      autoClassified: autoCount,
      uncategorized: uncategorizedCount
    };
  }

  /** 询问重复文件处理策略（统一生效） */
  async function askDuplicatePolicy(fileName) {
    const value = await chooseDialog(
      '发现重复图片',
      `「${fileName}」与图库中已有图片内容完全相同（SHA-256 一致）。请选择处理方式，本次导入的剩余重复项将统一按此处理。`,
      [
        { value: DUP.SKIP, label: '全部跳过', desc: '保留图库中已有的那一张，忽略本次重复文件' },
        { value: DUP.OVERWRITE, label: '全部覆盖', desc: '用本次导入的文件替换图库中已有的记录' },
        { value: DUP.KEEP, label: '全部保留两份', desc: '作为两条独立记录同时存在' }
      ]
    );
    return value;
  }

  /* ==================================================================
   *  三、导入：JSON 备份 / CSV
   * ================================================================== */

  /** 恢复整库 JSON 备份 */
  async function importBackupFile(file, onProgress) {
    const text = await readFileAsText(file);
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      toast('JSON 备份解析失败，请确认文件格式', 'error');
      return { added: 0 };
    }
    if (!data || !Array.isArray(data.images)) {
      toast('备份格式不正确：缺少 images 数组', 'error');
      return { added: 0 };
    }

    // 分类：按 id 去重合并
    if (Array.isArray(data.categories) && data.categories.length) {
      const known = new Set(store.state.categories.map((c) => c.id));
      const merged = [];
      for (const category of data.categories) {
        if (!category || !category.id || known.has(category.id)) continue;
        merged.push({
          id: category.id,
          name: category.name || '未命名分类',
          level: category.level === 2 ? 2 : 1,
          parentId: category.parentId || null,
          order: Number(category.order) || 0,
          color: category.color || '#2f6fed',
          createdAt: Number(category.createdAt) || Date.now()
        });
      }
      if (merged.length) await store.bulkAddCategories(merged);
    }

    const records = [];
    const total = data.images.length;
    let done = 0;
    for (const item of data.images) {
      try {
        const record = { ...item };
        const blobSource = item.blobData || (typeof item.blob === 'string' ? item.blob : null);
        const thumbSource = item.thumbData || (typeof item.thumb === 'string' ? item.thumb : null);
        record.blob = blobSource ? dataURLToBlob(blobSource) : null;
        record.thumb = thumbSource ? dataURLToBlob(thumbSource) : null;
        delete record.blobData;
        delete record.thumbData;
        if (!record.id) record.id = uid();
        if (!record.createdAt) record.createdAt = Date.now();
        if (!record.updatedAt) record.updatedAt = record.createdAt;
        if (!Array.isArray(record.tags)) record.tags = [];
        record.favorite = Boolean(record.favorite);
        // 若分类 id 不存在则置空，避免产生悬空引用
        if (record.categoryId && !store.categoryById(record.categoryId)) record.categoryId = null;
        if (record.subCategoryId && !store.categoryById(record.subCategoryId)) record.subCategoryId = null;
        // 去重：与已有 hash 冲突时按“保留两份”处理（备份恢复以完整还原为优先）
        if (!record.hash && record.blob) record.hash = await sha256Hex(record.blob);
        records.push(record);
      } catch (err) {
        console.error('[PromptVault] 备份记录解析失败', err);
      } finally {
        done += 1;
        if (typeof onProgress === 'function') onProgress(done, total);
      }
    }
    if (records.length) await store.bulkAddImages(records);
    return { added: records.length };
  }

  /** 导入 CSV（仅元数据） */
  async function importCsvFile(file, target = {}) {
    const text = await readFileAsText(file);
    const rows = parseCsv(text);
    if (!rows.length) { toast('CSV 内容为空', 'warn'); return { added: 0 }; }

    let header = rows[0].map((h) => String(h).trim());
    let body = rows.slice(1);
    const normalized = header.map((h) => h.toLowerCase());
    const looksLikeHeader = normalized.includes('name') || normalized.includes('positive') || normalized.includes('negative');
    if (!looksLikeHeader) {
      header = CSV_HEADER;
      body = rows;
    }
    const indexOf = (key) => header.findIndex((h) => String(h).trim().toLowerCase() === key.toLowerCase());
    const idx = {
      name: indexOf('name'),
      category: indexOf('category'),
      subCategory: indexOf('subCategory'),
      positive: indexOf('positive'),
      negative: indexOf('negative'),
      params: indexOf('params'),
      tags: indexOf('tags'),
      favorite: indexOf('favorite')
    };

    const records = [];
    const now = Date.now();
    for (const row of body) {
      const pick = (i) => (i >= 0 && i < row.length ? String(row[i] ?? '') : '');
      const name = pick(idx.name).trim();
      if (!name && !pick(idx.positive).trim()) continue;

      let categoryId = target.categoryId || null;
      let subCategoryId = target.subCategoryId || null;
      const catName = pick(idx.category).trim();
      const subName = pick(idx.subCategory).trim();
      if (!categoryId && catName) {
        const topId = findTopByName(catName);
        if (topId) {
          categoryId = topId;
          if (!subCategoryId && subName) subCategoryId = findSubByName(topId, subName);
        }
      }

      const tagText = pick(idx.tags);
      records.push({
        id: uid(),
        name: name || '未命名',
        blob: null,
        thumb: null,
        mime: '',
        width: 0,
        height: 0,
        size: 0,
        positive: pick(idx.positive),
        negative: pick(idx.negative),
        params: pick(idx.params),
        categoryId,
        subCategoryId,
        tags: tagText.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        favorite: toBool(pick(idx.favorite)),
        note: '',
        hash: '',
        createdAt: now,
        updatedAt: now
      });
    }

    if (!records.length) { toast('CSV 中没有可导入的记录', 'warn'); return { added: 0 }; }
    await store.bulkAddImages(records);
    return { added: records.length };
  }

  /* ==================================================================
   *  四、导出
   * ================================================================== */

  /** 生成备份对象 */
  async function buildBackup(images, includeBlobs, onProgress) {
    const out = {
      app: 'PromptVault',
      version: 1,
      exportedAt: new Date().toISOString(),
      categories: store.state.categories.map((c) => ({ ...c })),
      images: []
    };
    const total = images.length;
    let done = 0;
    for (const image of images) {
      const item = { ...image };
      delete item.blob;
      delete item.thumb;
      if (includeBlobs) {
        item.blobData = image.blob ? await blobToDataURL(image.blob) : null;
        item.thumbData = image.thumb ? await blobToDataURL(image.thumb) : null;
      }
      out.images.push(item);
      done += 1;
      if (typeof onProgress === 'function') onProgress(done, total);
    }
    return out;
  }

  /** 导出为 JSON 文件 */
  async function exportJson(images, includeBlobs, filename, onProgress) {
    if (!images.length) { toast('没有可导出的图片', 'warn'); return; }
    const backup = await buildBackup(images, includeBlobs, onProgress);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    downloadBlob(blob, filename);
    toast(`已导出 ${images.length} 张图片的${includeBlobs ? '完整备份' : '元数据'}`, 'success');
  }

  /** 导出为 CSV */
  function exportCsv(images, filename) {
    if (!images.length) { toast('没有可导出的图片', 'warn'); return; }
    const rows = [CSV_HEADER];
    for (const image of images) {
      const top = store.categoryById(image.categoryId);
      const sub = store.categoryById(image.subCategoryId);
      rows.push([
        image.name || '',
        top ? top.name : '',
        sub ? sub.name : '',
        image.positive || '',
        image.negative || '',
        image.params || '',
        (image.tags || []).join(','),
        image.favorite ? 'true' : 'false'
      ]);
    }
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, filename);
    toast(`已导出 ${images.length} 条记录到 CSV`, 'success');
  }

  /* ==================================================================
   *  五、导入 / 导出弹窗
   * ================================================================== */

  let importModal = null;
  let exportModal = null;

  /** 打开导入弹窗 */
  function openImport() {
    if (importModal) importModal.close(null);

    const target = {
      categoryId: store.state.filter.categoryId || null,
      subCategoryId: store.state.filter.subCategoryId || null
    };

    const wrap = el('div', { class: 'section' });

    /* --- 目标分类 --- */
    const catSection = el('div', { class: 'section' });
    catSection.appendChild(el('div', { class: 'section-title', text: '目标分类' }));
    catSection.appendChild(el('div', {
      class: 'section-desc',
      text: '不选也可以：开启下方自动分类后，会按每张图的提示词内容推断分类，推断不出来才使用这里选定的分类（或左栏当前的筛选）。'
    }));
    const catRow = el('div', { class: 'detail-row' });
    const catSelect = el('select', { class: 'select' });
    catSelect.appendChild(el('option', { value: '', text: '未分类（一级）' }));
    store.topCategories().forEach((c) => catSelect.appendChild(el('option', { value: c.id, text: c.name })));
    catSelect.value = target.categoryId || '';
    const subSelect = el('select', { class: 'select' });
    const fillSubs = (parentId) => {
      subSelect.innerHTML = '';
      subSelect.appendChild(el('option', { value: '', text: '未指定（二级）' }));
      store.subCategoriesOf(parentId).forEach((c) => subSelect.appendChild(el('option', { value: c.id, text: c.name })));
    };
    fillSubs(target.categoryId);
    subSelect.value = target.subCategoryId || '';

    /**
     * 用户是否在弹窗里手动动过分类下拉。
     * 只有手动选择才拥有最高优先级；这里的预填值（来自左栏筛选）只是兜底。
     * 注意：fillSubs() 里对 subSelect.value 的赋值是程序调用，不会触发 change，
     * 因此不会被误判成「用户动过」。
     */
    let catTouched = false;
    catSelect.addEventListener('change', () => {
      fillSubs(catSelect.value);
      subSelect.value = '';
      catTouched = true;
      refreshCatHint();
    });
    subSelect.addEventListener('change', () => {
      catTouched = true;
      refreshCatHint();
    });
    catRow.appendChild(catSelect);
    catRow.appendChild(subSelect);
    catSection.appendChild(catRow);

    /* 自动分类开关（默认开启，状态持久化到 settings） */
    const autoLabel = el('label', { class: 'switch' });
    const autoInput = el('input', { type: 'checkbox' });
    autoInput.checked = store.state.settings.autoClassify !== false;
    autoLabel.appendChild(autoInput);
    autoLabel.appendChild(el('span', { class: 'switch-track' }));
    autoLabel.appendChild(el('span', { text: '根据提示词自动分类（优先于上面的预填分类）' }));
    autoLabel.title = '开启后按每张图的提示词推断分类；手动选择过分类时以手动选择为准，推断不出来才回落到上面的分类';
    autoInput.addEventListener('change', () => {
      // 立即生效：currentTarget() 每次导入都会重新读取该状态
      store.state.settings.autoClassify = autoInput.checked;
      refreshCatHint();
      store.saveSettings().catch((err) => {
        console.warn('[PromptVault] 保存自动分类设置失败', err);
      });
    });
    catSection.appendChild(autoLabel);

    /** 说明当前实际生效的优先级，避免「下拉里写着 A、导入却归到 B」的困惑 */
    const catHint = el('div', { class: 'field-hint', text: '' });
    catSection.appendChild(catHint);

    function refreshCatHint() {
      const autoOn = autoInput.checked && !catTouched;
      catHint.textContent = autoOn
        ? '当前按提示词自动分类；推断不出来时才使用上面选定的分类。手动选择分类可覆盖自动结果。'
        : '当前按上面选定的分类导入（不会自动推断）。';
      catHint.classList.toggle('is-accent', autoOn);
    }
    refreshCatHint();

    wrap.appendChild(catSection);

    /* --- 选择文件 --- */
    const fileSection = el('div', { class: 'section' });
    fileSection.appendChild(el('div', { class: 'section-title', text: '选择图片' }));
    fileSection.appendChild(el('div', {
      class: 'section-desc',
      text: '支持多选图片文件，也支持选择整个文件夹（递归读取）。同目录下的 xxx.txt / xxx-neg.txt / xxx_negative.txt / xxx.json 会被自动识别为配对提示词。'
    }));

    const fileInput = el('input', { type: 'file', multiple: true, accept: 'image/*', style: { display: 'none' } });
    const dirInput = el('input', { type: 'file', multiple: true, webkitdirectory: 'true', directory: 'true', style: { display: 'none' } });
    const btnRow = el('div', { class: 'btn-row' });

    const pickFiles = el('button', { class: 'btn btn-primary', type: 'button' });
    pickFiles.innerHTML = `${icon('upload', 15)}<span>选择图片文件</span>`;
    pickFiles.addEventListener('click', () => fileInput.click());

    const pickFolder = el('button', { class: 'btn', type: 'button' });
    pickFolder.innerHTML = `${icon('folder', 15)}<span>选择整个文件夹</span>`;
    pickFolder.addEventListener('click', () => dirInput.click());

    btnRow.appendChild(pickFiles);
    btnRow.appendChild(pickFolder);
    fileSection.appendChild(btnRow);
    fileSection.appendChild(fileInput);
    fileSection.appendChild(dirInput);

    const progressWrap = el('div', { class: 'progress-wrap', hidden: true });
    const progressBar = el('div', { class: 'progress-bar' });
    const progressFill = el('div', { class: 'progress-fill' });
    progressBar.appendChild(progressFill);
    const progressText = el('div', { class: 'progress-text', text: '' });
    progressWrap.appendChild(progressBar);
    progressWrap.appendChild(progressText);
    fileSection.appendChild(progressWrap);
    wrap.appendChild(fileSection);

    /* --- 导入其它格式 --- */
    const otherSection = el('div', { class: 'section' });
    otherSection.appendChild(el('div', { class: 'section-title', text: '从备份 / CSV 导入' }));
    otherSection.appendChild(el('div', {
      class: 'section-desc',
      text: 'JSON 备份会完整还原分类与图片（含图片数据）；CSV 只导入元数据字段 name, category, subCategory, positive, negative, params, tags, favorite。'
    }));
    const jsonInput = el('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    const csvInput = el('input', { type: 'file', accept: '.csv,text/csv', style: { display: 'none' } });
    const otherRow = el('div', { class: 'btn-row' });
    const pickJson = el('button', { class: 'btn', type: 'button' });
    pickJson.innerHTML = `${icon('refresh', 15)}<span>恢复 JSON 备份</span>`;
    pickJson.addEventListener('click', () => jsonInput.click());
    const pickCsv = el('button', { class: 'btn', type: 'button' });
    pickCsv.innerHTML = `${icon('table', 15)}<span>导入 CSV</span>`;
    pickCsv.addEventListener('click', () => csvInput.click());
    otherRow.appendChild(pickJson);
    otherRow.appendChild(pickCsv);
    otherSection.appendChild(otherRow);
    otherSection.appendChild(jsonInput);
    otherSection.appendChild(csvInput);
    wrap.appendChild(otherSection);

    /* --- 从 Word 文档导入 --- */
    const wordSection = el('div', { class: 'section' });
    wordSection.appendChild(el('div', { class: 'section-title', text: '从 Word 文档导入' }));
    wordSection.appendChild(el('div', {
      class: 'section-desc',
      text: '支持 .docx，可一次选择多个文档。按「图片 + 紧随其后的提示词段落」自动配对；几张图连续排列时视为同一组、共用一段提示词。结尾的链接与推广段落会自动跳过，文档内图片同样会先压缩再入库。'
    }));
    const docxInput = el('input', {
      type: 'file', accept: '.docx', multiple: true, style: { display: 'none' }
    });
    const pickDocx = el('button', { class: 'btn', type: 'button' });
    pickDocx.innerHTML = `${icon('folder', 15)}<span>选择 Word 文档（可多选）</span>`;
    pickDocx.addEventListener('click', () => docxInput.click());
    const docxRow = el('div', { class: 'btn-row' });
    docxRow.appendChild(pickDocx);
    wordSection.appendChild(docxRow);
    wordSection.appendChild(docxInput);
    wrap.appendChild(wordSection);

    /* --- 进度控制 --- */
    function showProgress(done, total, label) {
      progressWrap.hidden = false;
      const percent = total ? Math.round((done / total) * 100) : 0;
      progressFill.style.width = `${percent}%`;
      progressText.textContent = `${label} ${done}/${total}`;
    }
    function resetProgress() {
      progressWrap.hidden = true;
      progressFill.style.width = '0%';
      progressText.textContent = '';
    }

    const currentTarget = () => ({
      categoryId: catSelect.value || null,
      subCategoryId: subSelect.value || null,
      // 每次都读当前控件状态，弹窗内拨开关后立即生效，无需关掉重开
      autoClassify: autoInput.checked,
      // 只有手动动过下拉，预填值才算「用户已指定」
      catTouched
    });

    async function runImport(files, label) {
      if (!files || !files.length) return;
      resetProgress();
      showProgress(0, files.length, label);
      const before = store.state.images.length;
      let result;
      try {
        result = await importImageFiles(files, currentTarget(), (done, total, phase) => {
          // 压缩阶段单独提示，避免大批量导入时进度条长时间不动造成「卡死」错觉
          showProgress(done, total, phase === 'compress' ? '正在压缩' : label);
        });
      } catch (err) {
        console.error(err);
        toast('导入过程中出现错误，请查看控制台', 'error');
        return;
      }
      const added = store.state.images.length - before;
      const parts = [`新增 ${added} 张`];
      if (result.skipped) parts.push(`跳过重复 ${result.skipped} 张`);
      toast(`导入完成：${parts.join('，')}${autoStatsSuffix(result)}`, 'success');
      setTimeout(resetProgress, 1200);
      store.clearSelection();
    }

    fileInput.addEventListener('change', () => {
      runImport(Array.from(fileInput.files || []), '正在导入');
      fileInput.value = '';
    });
    dirInput.addEventListener('change', () => {
      runImport(Array.from(dirInput.files || []), '正在导入');
      dirInput.value = '';
    });

    jsonInput.addEventListener('change', async () => {
      const file = (jsonInput.files || [])[0];
      jsonInput.value = '';
      if (!file) return;
      const ok = await confirmDialog('恢复备份会向当前图库追加分类与图片，不会清空已有数据。是否继续？', {
        title: '恢复 JSON 备份', okText: '继续导入'
      });
      if (!ok) return;
      showProgress(0, 1, '正在恢复');
      const result = await importBackupFile(file, (done, total) => showProgress(done, total, '正在恢复'));
      toast(`备份恢复完成：新增 ${result.added} 张图片`, 'success');
      resetProgress();
    });

    csvInput.addEventListener('change', async () => {
      const file = (csvInput.files || [])[0];
      csvInput.value = '';
      if (!file) return;
      const result = await importCsvFile(file, currentTarget());
      if (result.added) toast(`CSV 导入完成：新增 ${result.added} 条记录`, 'success');
    });

    docxInput.addEventListener('change', async () => {
      const files = Array.from(docxInput.files || []);
      docxInput.value = '';
      if (!files.length) return;

      const entries = [];
      let failed = 0;

      showProgress(0, files.length, '正在解析文档');
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        progressText.textContent = files.length > 1
          ? `正在解析 ${i + 1}/${files.length}：${file.name}`
          : '正在解析文档结构…';
        try {
          const parsed = await parseDocxStructure(file);
          parsed.items.forEach((item) => {
            entries.push({ ...item, file, dir: parsed.dir, sourceFile: file.name });
          });
        } catch (err) {
          console.error('[PromptVault] docx 解析失败', file.name, err);
          failed += 1;
        }
        showProgress(i + 1, files.length, '正在解析文档');
        // 让出主线程，保证进度条能刷新
        await new Promise((r) => setTimeout(r, 0));
      }
      resetProgress();

      if (!entries.length) {
        toast(failed
          ? `${failed} 个文档都解析失败，请确认是有效的 .docx`
          : '文档里没有识别到「图片 + 提示词」的组合', 'warn');
        return;
      }
      if (failed) toast(`${failed} 个文档解析失败，已跳过`, 'warn');

      openWordPreview(entries, currentTarget(), files.length - failed);
    });

    importModal = openModal({
      title: '导入',
      content: wrap,
      footer: (() => {
        const footer = el('div', { class: 'modal-foot', style: { width: '100%' } });
        footer.appendChild(el('span', {
          class: 'muted',
          text: '提示：也可以直接把图片拖到主区域完成导入'
        }));
        const closeBtn = el('button', { class: 'btn', type: 'button', text: '关闭' });
        closeBtn.addEventListener('click', () => importModal.close(null));
        footer.appendChild(el('span', { class: 'spacer' }));
        footer.appendChild(closeBtn);
        return footer;
      })(),
      onClose: () => { importModal = null; resetProgress(); }
    });
  }

  /* ==================================================================
   *  五之二、Word 文档导入
   * ================================================================== */

  /**
   * 打开 Word 导入预览：逐条核对「图片 + 提示词」配对，勾选后批量导入。
   * 缩略图按滚动位置懒加载，避免一次性解压上百张原图。
   * 每张图的提示词各不相同，因此分类逐条独立推断，并允许逐条手工修改。
   * 支持一次导入多个 docx —— 每条 entry 自带所属 file / dir，互不干扰。
   *
   * @param {Array<{name:string, path:string, prompt:string, groupSize?:number,
   *                file:File, dir:Map, sourceFile:string}>} entries
   * @param {{categoryId:string|null, subCategoryId:string|null,
   *          autoClassify?:boolean, catTouched?:boolean}} target
   * @param {number} [fileCount=1] 源文档数量，仅用于文案
   */
  function openWordPreview(entries, target, fileCount = 1) {
    // 与普通导入保持同一条优先级：手动选择 > 逐条推断 > 左栏预填
    const preset = {
      categoryId: (target && target.categoryId) || null,
      subCategoryId: (target && target.subCategoryId) || null
    };
    const manual = Boolean(target && target.catTouched);
    const autoOn = isAutoClassifyOn(target);

    const items = entries.map((item, index) => {
      // 手动选过分类 → 全部沿用；否则逐条按提示词推断，推断不出来才回落到预填值
      const guess = !manual && autoOn ? guessCategory(item.prompt || '') : null;
      const guessed = Boolean(guess && (guess.categoryId || guess.subCategoryId));
      return {
        ...item,
        index,
        checked: true,
        thumbUrl: null,
        categoryId: guessed ? guess.categoryId : preset.categoryId,
        subCategoryId: guessed ? guess.subCategoryId : preset.subCategoryId,
        /** 该行分类是否由自动推断得出（回落预填值时为 false） */
        guessed,
        /** 是否被用户手工改过分类（改过就不再标「自动推断」） */
        touched: manual
      };
    });

    const wrap = el('div', { class: 'section' });
    const sourceText = fileCount > 1
      ? `从 ${fileCount} 个 Word 文档识别到 ${items.length} 组「图片 + 提示词」`
      : `从「${(entries[0] && entries[0].sourceFile) || '文档'}」识别到 ${items.length} 组「图片 + 提示词」`;
    wrap.appendChild(el('div', {
      class: 'section-desc',
      text: `${sourceText}。缩略图滚动到可见位置时自动加载，请核对图文配对后再导入。每行可单独修改分类。`
    }));

    /* --- 工具条 --- */
    const bar = el('div', { class: 'docx-bar' });
    const toggleBtn = el('button', { class: 'btn btn-sm', type: 'button', text: '全不选' });
    const autoLabel = el('span', { class: 'muted', text: '' });
    const countLabel = el('span', { class: 'muted', text: '' });
    bar.appendChild(toggleBtn);
    bar.appendChild(el('span', { class: 'spacer' }));
    bar.appendChild(autoLabel);
    bar.appendChild(countLabel);
    wrap.appendChild(bar);

    /* --- 列表（分页渲染：上万条时一次性建 DOM 会直接卡死） --- */
    const listWrap = el('div', { class: 'docx-list' });
    const rowRefs = [];

    /* 缩略图懒加载：只解压滚动到可见位置的那几张，上万条也不会一次性全解压 */
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        loadThumb(entry.target);
      });
    }, { root: listWrap, rootMargin: '240px 0px' });

    async function loadThumb(holder) {
      const idx = Number(holder.dataset.idx);
      const item = items[idx];
      if (!item || item.thumbUrl || holder.dataset.loading === '1') return;
      holder.dataset.loading = '1';
      try {
        const blob = await loadDocxImage(item.file, item.dir, item.path);
        const { thumb } = await genThumbnail(blob, 140, 0.7);
        if (thumb) {
          item.thumbUrl = URL.createObjectURL(thumb);
          holder.style.backgroundImage = `url("${item.thumbUrl}")`;
          holder.classList.add('has-img');
        }
      } catch (err) {
        console.warn('[PromptVault] Word 预览缩略图失败：', item.path, err);
        holder.classList.add('is-failed');
      } finally {
        holder.dataset.loading = '0';
      }
    }

    const moreWrap = el('div', { class: 'docx-more-wrap', hidden: true });
    const moreBtn = el('button', { class: 'btn docx-more', type: 'button', text: '' });
    moreWrap.appendChild(moreBtn);
    listWrap.appendChild(moreWrap);

    /** 构建单行 */
    function buildRow(item) {
      const row = el('label', { class: 'docx-item' });
      const box = el('input', { type: 'checkbox', class: 'docx-check' });
      box.checked = true;
      box.addEventListener('change', () => {
        item.checked = box.checked;
        row.classList.toggle('is-off', !box.checked);
        refreshCount();
      });

      const thumb = el('div', { class: 'docx-thumb' });
      thumb.dataset.idx = String(item.index);

      const meta = el('div', { class: 'docx-meta' });
      const nameRow = el('div', { class: 'docx-name-row' });
      nameRow.appendChild(el('span', {
        class: 'docx-name',
        // 多文档时带上来源文件名，便于区分同名图片
        text: fileCount > 1
          ? `${item.index + 1}. ${item.sourceFile} · ${item.name}`
          : `${item.index + 1}. ${item.name}`
      }));
      if (item.groupSize > 1) {
        nameRow.appendChild(el('span', {
          class: 'docx-shared',
          text: `同组 ${item.groupSize} 张共用`,
          title: '这几张图在文档里是连续排列的，共用同一段提示词'
        }));
      }
      meta.appendChild(nameRow);
      const promptEl = el('div', {
        class: 'docx-prompt',
        text: item.prompt || '（这张图后面没有找到提示词）'
      });
      if (!item.prompt) promptEl.classList.add('is-empty');
      meta.appendChild(promptEl);

      /* 分类行：推断结果标签 + 一级/二级联动下拉（可逐条修改） */
      const catBox = el('div', { class: 'docx-cat' });
      // 下拉在 <label> 内部，必须拦住冒泡，否则点下拉会顺带切换勾选状态
      catBox.addEventListener('click', (event) => event.stopPropagation());
      catBox.addEventListener('mousedown', (event) => event.stopPropagation());

      const badge = el('span', { class: 'docx-cat-badge', text: '' });
      const renderBadge = () => {
        const path = categoryPathOf(item.categoryId, item.subCategoryId);
        // 只有「确实是推断出来的、且用户没改过」才标「自动推断」；
        // 回落左栏预填值的行按普通分类显示，避免误导。
        const auto = Boolean(path) && item.guessed && !item.touched;
        badge.textContent = path ? `${auto ? '自动推断：' : ''}${path}` : '未分类';
        badge.classList.toggle('is-auto', auto);
        badge.classList.toggle('is-none', !path);
      };

      const picker = createCategoryPicker(
        { categoryId: item.categoryId, subCategoryId: item.subCategoryId },
        (next) => {
          item.categoryId = next.categoryId;
          item.subCategoryId = next.subCategoryId;
          item.touched = true;
          renderBadge();
          refreshCount();
        }
      );

      catBox.appendChild(badge);
      catBox.appendChild(picker.node);
      meta.appendChild(catBox);
      renderBadge();

      row.appendChild(box);
      row.appendChild(thumb);
      row.appendChild(meta);
      return { item, row, thumb, box, badge, picker };
    }

    /** 每页渲染多少行 */
    const PAGE_SIZE = 200;
    let renderedCount = 0;

    function renderPage(size) {
      const start = renderedCount;
      const end = Math.min(items.length, start + size);
      if (end <= start) return;

      const frag = document.createDocumentFragment();
      const fresh = [];
      for (let i = start; i < end; i += 1) {
        const refs = buildRow(items[i]);
        frag.appendChild(refs.row);
        fresh.push(refs);
      }
      listWrap.insertBefore(frag, moreWrap);
      rowRefs.push(...fresh);
      renderedCount = end;
      fresh.forEach((r) => observer.observe(r.thumb));

      const rest = items.length - renderedCount;
      moreWrap.hidden = rest <= 0;
      moreBtn.textContent = `显示更多（还有 ${rest} 条）`;
    }

    moreBtn.addEventListener('click', () => renderPage(PAGE_SIZE));
    // 首屏只渲染一页，剩下的按需追加（上万条一次性建 DOM 会直接卡死）
    renderPage(PAGE_SIZE);

    wrap.appendChild(listWrap);

    /* --- 进度 --- */
    const progressWrap = el('div', { class: 'progress-wrap', hidden: true });
    const progressBar = el('div', { class: 'progress-bar' });
    const progressFill = el('div', { class: 'progress-fill' });
    progressBar.appendChild(progressFill);
    const progressText = el('div', { class: 'progress-text', text: '' });
    progressWrap.appendChild(progressBar);
    progressWrap.appendChild(progressText);
    wrap.appendChild(progressWrap);

    const importBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '导入选中' });

    function refreshCount() {
      const n = items.filter((i) => i.checked).length;
      const picked = items.filter((i) => i.checked);
      const autoN = picked.filter((i) => i.guessed && !i.touched).length;
      const noneN = picked.filter((i) => !i.categoryId && !i.subCategoryId).length;
      countLabel.textContent = `已选 ${n} / ${items.length}`;
      autoLabel.textContent = `自动分类 ${autoN} · 未分类 ${noneN}`;
      toggleBtn.textContent = n === items.length ? '全不选' : '全选';
      importBtn.textContent = `导入选中（${n}）`;
      importBtn.disabled = n === 0;
    }

    toggleBtn.addEventListener('click', () => {
      const allOn = items.every((i) => i.checked);
      // 作用于全部条目（含尚未渲染出来的页），已渲染的行同步更新 UI
      items.forEach((i) => { i.checked = !allOn; });
      rowRefs.forEach(({ item, row, box }) => {
        box.checked = item.checked;
        row.classList.toggle('is-off', !item.checked);
      });
      refreshCount();
    });

    /* --- 执行导入 --- */
    let importing = false;

    importBtn.addEventListener('click', async () => {
      if (importing) return;
      const picked = items.filter((i) => i.checked);
      if (!picked.length) { toast('请先勾选要导入的条目', 'warn'); return; }

      importing = true;
      importBtn.disabled = true;
      progressWrap.hidden = false;
      progressFill.style.width = '0%';
      progressText.textContent = `正在处理 0/${picked.length}`;

      // 库里已有的哈希，用于静默去重（批量场景不逐个弹窗询问）
      const knownHash = new Set();
      store.state.images.forEach((img) => { if (img.hash) knownHash.add(img.hash); });

      const records = [];
      /** 真正新增的条数。records 会被 flushWordRecords 清空，不能用它计数 */
      let addedCount = 0;
      let skipped = 0;
      let failed = 0;
      let done = 0;
      let autoCount = 0;
      let uncategorizedCount = 0;

      /** 每批处理完就写一次库，避免上千张压缩图全压在内存里 */
      async function flushWordRecords() {
        if (!records.length) return;
        const batch = records.splice(0, records.length);
        await store.bulkAddImagesSilent(batch);
      }

      /**
       * 单条处理（并发执行的最小单元）。
       * 解压 docx 里的图 → 算哈希去重 → 压缩 + 缩略图 → 攒进 records。
       */
      async function processWordItem(item) {
        try {
          const blob = await loadDocxImage(item.file, item.dir, item.path);
          const ext = (item.path.split('.').pop() || 'png').toLowerCase();
          const imageFile = new File([blob], `${item.name}.${ext}`, { type: blob.type || 'image/png' });
          const hash = await sha256Hex(imageFile);

          if (hash && knownHash.has(hash)) {
            skipped += 1;
          } else {
            // 逐条使用该行最终确定的分类（自动推断或用户手工修改后的结果）
            const record = await buildRecord(imageFile, {
              name: item.name,
              positive: item.prompt || '',
              categoryId: item.categoryId || null,
              subCategoryId: item.subCategoryId || null
            }, hash);
            records.push(record);
            addedCount += 1;
            if (hash) knownHash.add(hash);
            if (!item.touched && item.guessed) autoCount += 1;
            if (!item.categoryId && !item.subCategoryId) uncategorizedCount += 1;
          }
        } catch (err) {
          console.warn('[PromptVault] Word 导入单条失败：', item.path, err);
          failed += 1;
        } finally {
          done += 1;
          // 进度每 10 张刷一次即可，上万张时逐张改 DOM 本身就很卡
          if (done % 10 === 0 || done === picked.length) {
            progressFill.style.width = `${Math.round((done / picked.length) * 100)}%`;
            progressText.textContent = `正在处理 ${done}/${picked.length}`;
          }
        }
      }

      /*
       * 并发批处理：编码可以并行，但并发度要照顾低配置电脑，
       * 高于物理核数会互相抢占、反而更慢。4 路是保守值。
       * 这里不按字节封顶 —— 解压后才知道真实大小，而 docx 里的图通常 1~4MB。
       */
      const WORD_CONCURRENCY = 4;
      for (let i = 0; i < picked.length; i += WORD_CONCURRENCY) {
        const chunk = picked.slice(i, i + WORD_CONCURRENCY);
        // eslint-disable-next-line no-await-in-loop
        await Promise.all(chunk.map((it) => processWordItem(it)));
        // eslint-disable-next-line no-await-in-loop
        await flushWordRecords();
        if (i % 60 === 0) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      try {
        await flushWordRecords();
        // 导入结束统一刷新一次（中途都是 silent 写库）
        store.refreshAfterBulkImport();
      } catch (err) {
        console.error('[PromptVault] Word 导入写入图库失败', err);
        toast('写入图库失败，请查看控制台', 'error');
      }

      importing = false;
      importBtn.disabled = false;

      const parts = [`新增 ${addedCount} 张`];
      if (skipped) parts.push(`跳过重复 ${skipped} 张`);
      if (failed) parts.push(`失败 ${failed} 张`);
      const suffix = autoStatsSuffix({ autoClassified: autoCount, uncategorized: uncategorizedCount });
      toast(`Word 导入完成：${parts.join('，')}${suffix}`, addedCount ? 'success' : 'warn');

      // 已处理的条目取消勾选，避免重复点击再次导入
      picked.forEach((item) => { item.checked = false; });
      rowRefs.forEach(({ item, row, box }) => {
        if (picked.includes(item)) {
          box.checked = false;
          row.classList.add('is-off');
        }
      });
      refreshCount();
      progressText.textContent = `完成：${progressText.textContent.replace('正在处理 ', '')}`;
    });

    refreshCount();

    let previewModal = null;
    previewModal = openModal({
      title: 'Word 文档导入',
      content: wrap,
      footer: (() => {
        const footer = el('div', { class: 'modal-foot', style: { width: '100%' } });
        footer.appendChild(el('span', { class: 'muted', text: '文档内图片会先压缩到 300KB 以内再入库' }));
        footer.appendChild(el('span', { class: 'spacer' }));
        const closeBtn = el('button', { class: 'btn', type: 'button', text: '关闭' });
        closeBtn.addEventListener('click', () => previewModal.close(null));
        footer.appendChild(closeBtn);
        footer.appendChild(importBtn);
        return footer;
      })(),
      onClose: () => {
        observer.disconnect();
        items.forEach((item) => { if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl); });
      }
    });
  }

  /** 打开导出弹窗 */
  function openExport() {
    if (exportModal) exportModal.close(null);

    const wrap = el('div', { class: 'section' });
    // 必须使用完整筛选结果（getFiltered），不能用被分页截断的 galleryList，
    // 否则库内图片数超过每页条数时导出会静默丢图。
    const filtered = store.getFiltered();
    const selected = store.selectedImages();
    const all = store.state.images;

    const progressWrap = el('div', { class: 'progress-wrap', hidden: true });
    const progressBar = el('div', { class: 'progress-bar' });
    const progressFill = el('div', { class: 'progress-fill' });
    progressBar.appendChild(progressFill);
    const progressText = el('div', { class: 'progress-text', text: '' });
    progressWrap.appendChild(progressBar);
    progressWrap.appendChild(progressText);

    const setProgress = (done, total) => {
      progressWrap.hidden = false;
      progressFill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
      progressText.textContent = `正在打包 ${done}/${total}`;
    };
    const resetProgress = () => {
      progressFill.style.width = '0%';
      progressText.textContent = '';
      progressWrap.hidden = true;
    };

    const buildSection = (title, desc, buttons) => {
      const section = el('div', { class: 'section' });
      section.appendChild(el('div', { class: 'section-title', text: title }));
      if (desc) section.appendChild(el('div', { class: 'section-desc', text: desc }));
      const row = el('div', { class: 'btn-row' });
      buttons.forEach((b) => row.appendChild(b));
      section.appendChild(row);
      return section;
    };

    const mkBtn = (label, iconName, handler, primary) => {
      const btn = el('button', { class: `btn${primary ? ' btn-primary' : ''}`, type: 'button' });
      btn.innerHTML = `${icon(iconName, 15)}<span>${label}</span>`;
      btn.addEventListener('click', handler);
      return btn;
    };

    // 1. 整库 JSON
    wrap.appendChild(buildSection(
      'JSON 备份',
      '完整备份当前图库（含分类与图片数据，文件较大），可用于换机迁移或完整还原。',
      [
        mkBtn(`全库 JSON（含图片，${all.length} 张）`, 'download', async () => {
          setProgress(0, all.length);
          await exportJson(all, true, `promptvault-backup-${stamp()}.json`, setProgress);
          resetProgress();
        }, true),
        mkBtn(`仅元数据 JSON（${all.length} 条）`, 'download', async () => {
          setProgress(0, all.length);
          await exportJson(all, false, `promptvault-metadata-${stamp()}.json`, setProgress);
          resetProgress();
        })
      ]
    ));

    // 2. 当前筛选结果
    wrap.appendChild(buildSection(
      '当前筛选结果',
      `图库当前筛选出 ${filtered.length} 张图片（受左栏分类与搜索影响）。`,
      [
        mkBtn('导出筛选结果 JSON（含图片）', 'download', async () => {
          setProgress(0, filtered.length);
          await exportJson(filtered, true, `promptvault-filtered-${stamp()}.json`, setProgress);
          resetProgress();
        }),
        mkBtn('导出筛选结果 CSV', 'table', () => {
          exportCsv(filtered, `promptvault-filtered-${stamp()}.csv`);
        })
      ]
    ));

    // 3. 选中项
    wrap.appendChild(buildSection(
      '数据库视图中选中的记录',
      selected.length
        ? `当前已选中 ${selected.length} 条记录。`
        : '当前没有选中任何记录。可切换到「数据库」视图勾选后再导出。',
      [
        mkBtn(`导出选中项 JSON（${selected.length} 条）`, 'download', async () => {
          if (!selected.length) { toast('请先在数据库视图中勾选记录', 'warn'); return; }
          setProgress(0, selected.length);
          await exportJson(selected, true, `promptvault-selected-${stamp()}.json`, setProgress);
          resetProgress();
        }),
        mkBtn('导出选中项 CSV', 'table', () => {
          if (!selected.length) { toast('请先在数据库视图中勾选记录', 'warn'); return; }
          exportCsv(selected, `promptvault-selected-${stamp()}.csv`);
        })
      ]
    ));

    // 4. CSV 全库
    wrap.appendChild(buildSection(
      'CSV',
      '导出全部记录的元数据（name, category, subCategory, positive, negative, params, tags, favorite），不含图片文件。',
      [mkBtn(`导出全库 CSV（${all.length} 条）`, 'table', () => exportCsv(all, `promptvault-${stamp()}.csv`))]
    ));

    wrap.appendChild(progressWrap);

    const statLine = el('div', { class: 'section-desc' });
    const totalSize = all.reduce((sum, img) => sum + (Number(img.size) || 0), 0);
    statLine.textContent = `图库共 ${all.length} 张图片，原图合计约 ${formatBytes(totalSize)}；含图片的备份文件体积会更大（base64 编码约增加 33%）。`;
    wrap.appendChild(statLine);

    exportModal = openModal({
      title: '导出',
      content: wrap,
      footer: (() => {
        const footer = el('div', { class: 'modal-foot', style: { width: '100%' } });
        const closeBtn = el('button', { class: 'btn', type: 'button', text: '关闭' });
        closeBtn.addEventListener('click', () => exportModal.close(null));
        footer.appendChild(el('span', { class: 'spacer' }));
        footer.appendChild(closeBtn);
        return footer;
      })(),
      onClose: () => { exportModal = null; }
    });
  }

  /* ==================================================================
   *  六、快速导入（粘贴一张图 + 填提示词）
   * ================================================================== */

  let quickModal = null;
  /** 快速导入弹窗的粘贴监听，关闭时移除，避免影响其他弹窗 */
  let quickPasteHandler = null;

  /** 打开「快速导入」弹窗：粘贴 / 选择 / 拖入一张图片，填提示词即可入库 */
  function openQuickImport() {
    if (quickModal) quickModal.close(null);

    /** 弹窗内的临时状态（每次打开都是全新的） */
    const quick = {
      file: null,
      compressed: null,
      embedded: { positive: '', negative: '', params: '' },
      /** 递增令牌，用于丢弃「用户已换图」的异步结果 */
      token: 0,
      busy: false,
      /** 用户是否手工改过分类：改过之后不再被自动推断覆盖 */
      catTouched: false
    };

    /* --- 粘贴区 --- */
    const dropZone = el('div', { class: 'quick-drop', tabindex: '0' });
    dropZone.innerHTML =
      `<span class="quick-drop-icon">${icon('upload', 26)}</span>` +
      '<span class="quick-drop-title">点此粘贴图片（Ctrl+V），或点击选择 / 拖入</span>' +
      '<span class="quick-drop-desc">快速导入一次一张，选好后填写提示词即可入库</span>';

    const fileInput = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });

    /* --- 预览卡 --- */
    const preview = el('div', { class: 'quick-preview', hidden: true });
    const previewThumb = el('div', { class: 'quick-preview-thumb' });
    const previewInfo = el('div', { class: 'quick-preview-info' });
    const previewName = el('div', { class: 'quick-preview-name', text: '' });
    const previewSize = el('div', { class: 'quick-preview-size', text: '' });
    const previewClear = el('button', {
      class: 'icon-btn', type: 'button', title: '移除这张图片', html: icon('close', 15)
    });
    previewInfo.appendChild(previewName);
    previewInfo.appendChild(previewSize);
    preview.appendChild(previewThumb);
    preview.appendChild(previewInfo);
    preview.appendChild(previewClear);

    /* --- 表单 --- */
    const form = el('div', { class: 'quick-form' });

    const nameField = el('div', { class: 'field' });
    nameField.appendChild(el('div', { class: 'field-label', text: '名称' }));
    const nameInput = el('input', { class: 'input', type: 'text', placeholder: '默认取文件名（不含扩展名）' });
    nameField.appendChild(nameInput);
    form.appendChild(nameField);

    const posField = el('div', { class: 'field' });
    posField.appendChild(el('div', { class: 'field-label', text: '正向提示词' }));
    const posInput = el('textarea', { class: 'textarea', placeholder: '粘贴或输入这张图的正向提示词' });
    posField.appendChild(posInput);
    const metaHint = el('div', { class: 'quick-hint', hidden: true });
    metaHint.innerHTML = `${icon('info', 13)}<span>已从图片中读取到提示词</span>`;
    posField.appendChild(metaHint);
    form.appendChild(posField);

    const negToggle = el('button', { class: 'quick-toggle', type: 'button' });
    const negWrap = el('div', { class: 'field', hidden: true });
    negWrap.appendChild(el('div', { class: 'field-label', text: '负向提示词' }));
    const negInput = el('textarea', { class: 'textarea', placeholder: '可选，留空表示不记录' });
    negWrap.appendChild(negInput);
    form.appendChild(negToggle);
    form.appendChild(negWrap);

    const catField = el('div', { class: 'field' });
    catField.appendChild(el('div', { class: 'field-label', text: '归入分类' }));
    const catRow = el('div', { class: 'detail-row' });
    const catSelect = el('select', { class: 'select' });
    catSelect.appendChild(el('option', { value: '', text: '未分类（一级）' }));
    store.topCategories().forEach((c) => catSelect.appendChild(el('option', { value: c.id, text: c.name })));
    const subSelect = el('select', { class: 'select' });
    /** 自动推断结果提示（命中关键词数），放在分类下拉下方 */
    const guessHint = el('div', { class: 'quick-hint', hidden: true });
    const fillSubs = (parentId) => {
      subSelect.innerHTML = '';
      subSelect.appendChild(el('option', { value: '', text: '未指定（二级）' }));
      store.subCategoriesOf(parentId).forEach((c) => subSelect.appendChild(el('option', { value: c.id, text: c.name })));
    };
    /** 回到「跟随左栏当前筛选」的默认分类，便于连续导入到同一分类 */
    const applyFilterCategory = () => {
      const topId = store.state.filter.categoryId || '';
      const subId = store.state.filter.subCategoryId || '';
      catSelect.value = topId;
      if (catSelect.value !== topId) catSelect.value = '';
      fillSubs(catSelect.value);
      subSelect.value = subId;
      if (subSelect.value !== subId) subSelect.value = '';
    };
    applyFilterCategory();
    catSelect.addEventListener('change', () => {
      fillSubs(catSelect.value);
      subSelect.value = '';
      // 用户显式选了分类：之后不再自动覆盖
      quick.catTouched = true;
      guessHint.hidden = true;
    });
    subSelect.addEventListener('change', () => {
      quick.catTouched = true;
      guessHint.hidden = true;
    });
    catRow.appendChild(catSelect);
    catRow.appendChild(subSelect);
    catField.appendChild(catRow);
    catField.appendChild(guessHint);
    form.appendChild(catField);

    /**
     * 按当前提示词自动选中分类。
     * 用户手工改过分类（catTouched）或关闭了自动分类开关时不做任何事。
     */
    function applyAutoGuess() {
      if (quick.catTouched) return;
      if (!isAutoClassifyOn(null)) { guessHint.hidden = true; return; }
      const text = posInput.value.trim();
      if (!text) { guessHint.hidden = true; return; }
      const guess = guessCategory(text);
      if (!guess.categoryId && !guess.subCategoryId) {
        // 没识别出来时保持用户当前选择（可能是左栏筛选带过来的默认分类），不强行清空
        guessHint.hidden = true;
        return;
      }
      catSelect.value = guess.categoryId || '';
      if (catSelect.value !== (guess.categoryId || '')) catSelect.value = '';
      fillSubs(catSelect.value);
      subSelect.value = guess.subCategoryId || '';
      if (subSelect.value !== (guess.subCategoryId || '')) subSelect.value = '';
      guessHint.innerHTML = `${icon('tag', 13)}<span>自动推断：${guess.label}（命中 ${guess.hits.length} 个关键词）</span>`;
      guessHint.hidden = false;
    }

    const wrap = el('div', { class: 'section' });
    wrap.appendChild(dropZone);
    wrap.appendChild(preview);
    wrap.appendChild(form);
    wrap.appendChild(fileInput);

    /* --- 预览图 URL 管理 --- */
    let previewURL = '';
    const releasePreviewURL = () => {
      if (previewURL) {
        URL.revokeObjectURL(previewURL);
        previewURL = '';
      }
    };
    const showPreviewThumb = (blob) => {
      releasePreviewURL();
      previewURL = URL.createObjectURL(blob);
      previewThumb.innerHTML = '';
      previewThumb.appendChild(el('img', { src: previewURL, alt: '预览' }));
    };

    const setNegativeOpen = (open) => {
      negWrap.hidden = !open;
      negToggle.innerHTML = open
        ? `${icon('chevronDown', 13)}<span>收起负向提示词</span>`
        : `${icon('chevronRight', 13)}<span>填写负向提示词（可选）</span>`;
    };
    setNegativeOpen(false);

    /* --- 底部按钮 --- */
    const footer = el('div', { class: 'modal-foot', style: { width: '100%' } });
    footer.appendChild(el('span', { class: 'muted', text: '入库前会统一压缩，单张不超过 300KB' }));
    footer.appendChild(el('span', { class: 'spacer' }));
    const closeBtn = el('button', { class: 'btn', type: 'button', text: '关闭' });
    const importBtn = el('button', { class: 'btn btn-primary', type: 'button' });
    importBtn.innerHTML = `${icon('upload', 15)}<span>导入</span>`;
    footer.appendChild(closeBtn);
    footer.appendChild(importBtn);

    /** 清空表单（保留手工选定的分类，便于连续导入） */
    function resetForm() {
      const keepCategory = quick.catTouched;
      quick.file = null;
      quick.compressed = null;
      quick.embedded = { positive: '', negative: '', params: '' };
      quick.token += 1;
      // 下一张图重新参与自动推断
      quick.catTouched = false;
      releasePreviewURL();
      previewThumb.innerHTML = '';
      preview.hidden = true;
      previewName.textContent = '';
      previewSize.textContent = '';
      nameInput.value = '';
      posInput.value = '';
      negInput.value = '';
      metaHint.hidden = true;
      guessHint.hidden = true;
      setNegativeOpen(false);
      // 自动推断出来的分类不带到下一张图，避免把上一张的推断结果套到新图上
      if (!keepCategory) applyFilterCategory();
    }

    /**
     * 选中一张图片：解析内嵌提示词 → 预跑压缩 → 渲染预览。
     * @param {File} file
     */
    async function selectFile(file) {
      if (!file) return;
      if (!isImageFile(file)) { toast('请粘贴或选择图片文件', 'warn'); return; }

      quick.token += 1;
      const token = quick.token;
      quick.file = file;
      quick.compressed = null;
      quick.embedded = { positive: '', negative: '', params: '' };

      nameInput.value = baseNameNoExt(file.name) || '';
      posInput.value = '';
      negInput.value = '';
      metaHint.hidden = true;
      setNegativeOpen(false);

      showPreviewThumb(file);
      preview.hidden = false;
      previewName.textContent = file.name || '剪贴板图片';
      previewSize.textContent = `原图 ${formatBytes(file.size)} · 正在压缩…`;

      // PNG 内嵌提示词：选中瞬间自动预填
      const embedded = await readEmbeddedMeta(file);
      if (token !== quick.token) return; // 用户已换图，丢弃本次结果
      quick.embedded = embedded;
      if (embedded.positive && !posInput.value.trim()) posInput.value = embedded.positive;
      if (embedded.negative) {
        negInput.value = embedded.negative;
        setNegativeOpen(true);
      }
      metaHint.hidden = !(embedded.positive || embedded.negative);

      // 内嵌提示词预填后立刻按内容推断一次分类
      applyAutoGuess();

      // 预跑压缩，让用户在导入前就看到最终体积
      const compressed = await compressImage(file, { maxBytes: MAX_IMAGE_BYTES });
      if (token !== quick.token) return;
      quick.compressed = compressed;
      if (compressed.compressed && compressed.blob) showPreviewThumb(compressed.blob);
      previewSize.textContent = compressed.compressed
        ? `原图 ${formatBytes(compressed.originalSize)} → 压缩后 ${formatBytes(compressed.blob.size)}`
        : `原图 ${formatBytes(file.size)} · 无需压缩`;
    }

    /** 执行导入（与主链路共用 buildRecord，压缩结果复用预览阶段的产物） */
    async function doImport() {
      if (quick.busy) return;
      const file = quick.file;
      if (!file) { toast('请先粘贴或选择一张图片', 'warn'); return; }

      const rawName = nameInput.value.trim();
      const positive = posInput.value.trim();
      if (!rawName && !positive) { toast('请至少填写名称或正向提示词', 'warn'); return; }

      quick.busy = true;
      importBtn.disabled = true;
      const originalHtml = importBtn.innerHTML;
      importBtn.innerHTML = `${icon('refresh', 15)}<span>正在导入…</span>`;
      try {
        const hash = await sha256Hex(file);
        if (hash && store.state.images.some((img) => img.hash === hash)) {
          const ok = await confirmDialog('这张图片与图库中已有图片内容完全相同，仍要再导入一份吗？', {
            title: '图片已存在', okText: '仍然导入'
          });
          if (!ok) return;
        }
        const record = await buildRecord(file, {
          name: rawName || baseNameNoExt(file.name) || '未命名',
          positive,
          negative: negInput.value.trim(),
          params: quick.embedded.params || '',
          tags: [],
          categoryId: catSelect.value || null,
          subCategoryId: subSelect.value || null
        }, hash, quick.compressed);
        await store.bulkAddImages([record]);
        toast('已导入 1 张图片', 'success');
        resetForm();
      } catch (err) {
        console.error('[PromptVault] 快速导入失败', err);
        toast('导入失败，请查看控制台', 'error');
      } finally {
        quick.busy = false;
        importBtn.disabled = false;
        importBtn.innerHTML = originalHtml;
      }
    }

    /* --- 交互绑定 --- */

    // 拖拽：全部拦截，避免触发全局拖拽遮罩与主链路导入
    const swallow = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    dropZone.addEventListener('dragenter', (event) => { swallow(event); dropZone.classList.add('over'); });
    dropZone.addEventListener('dragover', (event) => { swallow(event); dropZone.classList.add('over'); });
    dropZone.addEventListener('dragleave', (event) => { swallow(event); dropZone.classList.remove('over'); });
    dropZone.addEventListener('drop', (event) => {
      swallow(event);
      dropZone.classList.remove('over');
      const files = event.dataTransfer ? Array.from(event.dataTransfer.files || []) : [];
      const picked = files.filter(isImageFile);
      if (!picked.length) { toast('没有识别到图片，请拖入图片文件', 'warn'); return; }
      if (picked.length > 1) toast('快速导入一次一张，已取第一张', 'info');
      selectFile(picked[0]);
    });

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fileInput.click();
      }
    });

    fileInput.addEventListener('change', () => {
      const file = (fileInput.files || [])[0];
      fileInput.value = '';
      if (file) selectFile(file);
    });

    previewClear.addEventListener('click', () => resetForm());
    negToggle.addEventListener('click', () => setNegativeOpen(negWrap.hidden));
    importBtn.addEventListener('click', doImport);
    closeBtn.addEventListener('click', () => { if (quickModal) quickModal.close(null); });

    // 提示词变化时防抖推断分类（用户改过分类后 applyAutoGuess 内部会自行跳过）
    const onPromptInput = debounce(applyAutoGuess, 260);
    posInput.addEventListener('input', onPromptInput);
    posInput.addEventListener('change', onPromptInput);

    // 粘贴：只接管「剪贴板里是图片」的情况，纯文本仍交给输入框
    quickPasteHandler = (event) => {
      if (!quickModal) return;
      const data = event.clipboardData;
      if (!data) return;
      const items = data.items ? Array.from(data.items) : [];
      const imageItems = items.filter((item) => item.kind === 'file'
        && String(item.type || '').startsWith('image/'));
      if (!imageItems.length) return;
      event.preventDefault();
      const files = imageItems.map((item) => item.getAsFile()).filter(Boolean);
      if (!files.length) return;
      if (files.length > 1) toast('快速导入一次一张，已取第一张', 'info');
      selectFile(files[0]);
    };
    document.addEventListener('paste', quickPasteHandler);

    quickModal = openModal({
      title: '快速导入',
      content: wrap,
      footer,
      onClose: () => {
        quickModal = null;
        onPromptInput.cancel();
        if (quickPasteHandler) {
          document.removeEventListener('paste', quickPasteHandler);
          quickPasteHandler = null;
        }
        releasePreviewURL();
      }
    });
  }

  /* ==================================================================
   *  七、拖拽入口
   * ================================================================== */

  /** 处理拖入的 DataTransfer */
  /**
   * 导入前询问分类。
   *
   * 为什么要有这一步：之前拖入直接用 `state.filter.categoryId`，但那个值
   * 不带 catTouched 标记，`resolveCategory()` 里「按提示词自动推断」的优先级
   * 排在它前面 —— 角色图提示词里几乎必有 `1girl`，于是不管拖到哪儿都被判成
   * 「人物」。现在让用户显式确认一次：要么自己选分类（catTouched=true，
   * 跳过自动推断），要么勾「自动识别」把决定权交给关键词表。
   *
   * @param {number} fileCount 待导入文件数（用于提示文案）
   * @returns {Promise<{categoryId:string|null, subCategoryId:string|null, auto:boolean}|null>}
   *          null 表示用户取消
   */
  function askImportCategory(fileCount) {
    return new Promise((resolve) => {
      const body = el('div', { class: 'import-ask' });
      body.appendChild(el('p', {
        class: 'muted',
        style: { margin: '0 0 10px' },
        text: `即将导入 ${fileCount} 个文件。选择存到哪个分类：`
      }));

      const picker = createCategoryPicker({
        categoryId: store.state.filter.categoryId || null,
        subCategoryId: store.state.filter.subCategoryId || null
      });
      body.appendChild(picker.node);

      const autoWrap = el('label', { class: 'import-ask-auto' });
      const autoBox = el('input', { type: 'checkbox' });
      autoWrap.appendChild(autoBox);
      autoWrap.appendChild(el('span', {
        text: '按提示词自动识别分类（勾选后忽略上面的选择）'
      }));
      body.appendChild(autoWrap);

      const footer = el('div', {
        class: 'row',
        style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' }
      });
      const cancelBtn = el('button', { class: 'btn', type: 'button', text: '取消' });
      const okBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '导入' });
      footer.appendChild(cancelBtn);
      footer.appendChild(okBtn);

      const m = openModal({ title: '导入图片', content: body, footer });

      cancelBtn.addEventListener('click', () => {
        m.close();
        resolve(null);
      });

      okBtn.addEventListener('click', () => {
        const v = picker.value();
        m.close();
        resolve({
          categoryId: v.categoryId || null,
          subCategoryId: v.subCategoryId || null,
          auto: Boolean(autoBox.checked)
        });
      });
    });
  }

  async function handleDroppedDataTransfer(dataTransfer) {
    const files = await filesFromDataTransfer(dataTransfer);
    if (!files.length) { toast('没有识别到可导入的文件', 'warn'); return; }

    // 资产图页面拖入 → 进资产图集合，不进图库
    if (store.state.view === 'assets') {
      await importIntoAssets(files);
      return;
    }

    const imageCount = files.filter(isImageFile).length;
    const choice = await askImportCategory(imageCount || files.length);
    if (!choice) return;   // 用户取消

    const target = {
      categoryId: choice.categoryId,
      subCategoryId: choice.subCategoryId,
      // 手动选了分类 → 告诉 resolveCategory「别自动推断」
      catTouched: !choice.auto,
      autoClassify: choice.auto
    };

    toast(`开始导入 ${imageCount} 个文件…`, 'info');
    const before = store.state.images.length;
    const result = await importImageFiles(files, target);
    const added = store.state.images.length - before;
    const parts = [`新增 ${added} 张`];
    if (result.skipped) parts.push(`跳过重复 ${result.skipped} 张`);
    toast(`导入完成：${parts.join('，')}${autoStatsSuffix(result)}`, 'success');
  }

  /** 把文件导入到「资产图」集合（资产图页拖入时走这里，不进图库） */
  async function importIntoAssets(files) {
    const images = files.filter(isImageFile);
    if (!images.length) { toast('没有识别到图片文件', 'warn'); return; }

    const targetCat = store.assetCategoryList()[0];
    const known = store.assetHashSet();
    const records = [];
    let skipped = 0;

    for (const file of images) {
      try {
        const hash = await sha256Hex(file);
        if (hash && known.has(hash)) { skipped += 1; continue; }
        // 缩略图只用于列表展示；blob 保留原始文件，不做压缩
        const { thumb, width, height } = await genThumbnail(file, 480, 0.82);
        records.push({
          name: baseNameNoExt(file.name) || '未命名',
          category: targetCat,
          blob: file,
          thumb: thumb || null,
          mime: file.type || 'image/*',
          width: width || 0,
          height: height || 0,
          size: file.size,
          hash
        });
        if (hash) known.add(hash);
      } catch (err) {
        console.error('[PromptVault] 资产图处理失败', file.name, err);
      }
      // 让出主线程，大批量时不至于卡死界面
      await new Promise((r) => setTimeout(r, 0));
    }

    if (!records.length) {
      toast(skipped ? `这批图片都已存在（跳过 ${skipped} 张）` : '没有可添加的图片', skipped ? 'info' : 'warn');
      return;
    }
    await store.addAssets(records);
    const parts = [`新增 ${records.length} 张资产图`];
    if (skipped) parts.push(`跳过重复 ${skipped} 张`);
    toast(`${parts.join('，')}（原图存储，未压缩）`, 'success');
  }

  /** 处理拖入的 FileList */
  async function handleDroppedFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    const target = {
      categoryId: store.state.filter.categoryId || null,
      subCategoryId: store.state.filter.subCategoryId || null
    };
    const before = store.state.images.length;
    const result = await importImageFiles(list, target);
    const parts = [`新增 ${store.state.images.length - before} 张`];
    if (result.skipped) parts.push(`跳过重复 ${result.skipped} 张`);
    toast(`导入完成：${parts.join('，')}${autoStatsSuffix(result)}`, 'success');
  }

  return {
    openImport,
    openExport,
    openQuickImport,
    handleDroppedDataTransfer,
    handleDroppedFiles
  };
}
