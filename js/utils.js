/* =========================================================================
 * js/utils.js —— 通用工具层
 * 职责：DOM 创建与查询、内联图标、剪贴板、哈希、缩略图、CSV、弹窗、toast。
 * 本模块不依赖任何其他业务模块，避免循环依赖。
 * ========================================================================= */

/* ------------------------------------------------------------------ DOM */

/** 查询单个元素 */
export function $(selector, root = document) {
  return root.querySelector(selector);
}

/** 查询多个元素（返回真数组） */
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/**
 * 创建元素。
 * @param {string} tag 标签名
 * @param {object} [attrs] 属性；`class`/`text`/`html`/`dataset` 有特殊语义，
 *                         以 `on` 开头且值为函数时按事件绑定；其余走 setAttribute。
 * @param {Array|Node|string} [children] 子节点
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key === 'disabled') node.disabled = Boolean(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const child of kids) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : child);
  }
  return node;
}

/** 清空元素 */
export function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* ---------------------------------------------------------------- 图标 */

/** 图标路径表（内联 SVG，禁止使用 emoji 作为功能图标） */
const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L17 17"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15.5l-4.5-4.5L6 21"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9.5 3v18"/>',
  heart: '<path d="M20.4 5.9a5.2 5.2 0 0 0-7.4 0L12 6.9l-1-1a5.2 5.2 0 1 0-7.4 7.4l8.4 8.4 8.4-8.4a5.2 5.2 0 0 0 0-7.4z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>',
  eye: '<path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  upload: '<path d="M12 16V4"/><path d="M7.5 8.5L12 4l4.5 4.5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4v12"/><path d="M7.5 11.5L12 16l4.5-4.5"/><path d="M4 19h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  chevronDown: '<path d="M5 9l7 7 7-7"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  pencil: '<path d="M12.5 20H21"/><path d="M16.6 3.4a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5L16.6 3.4z"/>',
  trash: '<path d="M3.5 6.5h17"/><path d="M8.5 6.5V4.8A1.8 1.8 0 0 1 10.3 3h3.4a1.8 1.8 0 0 1 1.8 1.8v1.7"/><path d="M18.8 6.5l-.9 13.1A2 2 0 0 1 15.9 21H8.1a2 2 0 0 1-2-1.9L5.2 6.5"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7l-2-2.4H4a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2z"/>',
  folderOpen: '<path d="M3 7.5A2 2 0 0 1 5 5.5h4.2l2 2.4H19a2 2 0 0 1 2 2V11"/><path d="M2.6 12.2h18.8l-2 7a2 2 0 0 1-1.9 1.5H5.4a2 2 0 0 1-1.9-1.5l-.9-7z"/>',
  check: '<path d="M20 6.5L9.2 17.3 4 12.1"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  filter: '<path d="M3.5 5h17l-6.5 7.6V20l-4-2.4v-5L3.5 5z"/>',
  alert: '<path d="M12 9.5v4.5"/><path d="M12 17.4h.01"/><path d="M10.3 3.9L1.9 18.1a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  refresh: '<path d="M3.5 12a8.5 8.5 0 0 1 14.4-6.1L21 8.8"/><path d="M21 4.5v4.3h-4.3"/><path d="M20.5 12a8.5 8.5 0 0 1-14.4 6.1L3 15.2"/><path d="M3 19.5v-4.3h4.3"/>',
  tag: '<path d="M20.6 13.6l-7 7a2 2 0 0 1-2.8 0l-7.4-7.4a2 2 0 0 1-.6-1.6l.5-6.1a2 2 0 0 1 1.8-1.8l6.1-.5a2 2 0 0 1 1.6.6l7.8 7.8a2 2 0 0 1 0 2z"/><circle cx="8.2" cy="8.2" r="1.4"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L17 17"/><path d="M11 8.5v5M8.5 11h5"/>',
  code: '<path d="M8.5 8.5L4 12l4.5 3.5"/><path d="M15.5 8.5L20 12l-4.5 3.5"/><path d="M13.4 5.2l-2.8 13.6"/>'
};

/**
 * 生成内联 SVG 图标（字符串形式，便于 innerHTML 使用）。
 * @param {string} name ICONS 中的名称
 * @param {number} [size=16] 边长（px）
 * @returns {string} SVG 字符串
 */
export function icon(name, size = 16) {
  const inner = ICONS[name] || ICONS.image;
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true" focusable="false">${inner}</svg>`;
}

/**
 * 生成内联 SVG 图标（DOM 节点形式）。
 * @param {string} name 图标名
 * @param {number} [size=16] 边长
 * @returns {SVGElement}
 */
export function svgIcon(name, size = 16) {
  const holder = document.createElement('span');
  holder.innerHTML = icon(name, size);
  return holder.firstElementChild;
}

/* ------------------------------------------------------------ 基础工具 */

/** 生成一个足够唯一的本地 ID */
export function uid() {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${time}-${rand}`;
}

/** 防抖 */
export function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  wrapped.flush = (...args) => { if (timer) { clearTimeout(timer); timer = null; fn(...args); } };
  return wrapped;
}

/** 节流（首次立即执行） */
export function throttle(fn, wait = 200) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= wait) { last = now; fn(...args); }
  };
}

/** HTML 转义 */
export function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 文本截断 */
export function truncateText(str, max = 60) {
  const s = String(str == null ? '' : str);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 去掉扩展名 */
export function stripExt(path) {
  const s = String(path || '');
  const idx = s.lastIndexOf('.');
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return idx > slash ? s.slice(0, idx) : s;
}

/** 取文件名（去路径） */
export function baseName(path) {
  const s = String(path || '');
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return slash >= 0 ? s.slice(slash + 1) : s;
}

/** 取文件名（不含扩展名） */
export function baseNameNoExt(path) {
  return stripExt(baseName(path));
}

/** 字节数格式化 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 时间戳 → "YYYY-MM-DD HH:mm" */
export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 生成文件名时间戳 "YYYYMMDD-HHmm" */
export function stamp(date = new Date()) {
  const p = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

/** 触发浏览器下载 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 从 mime 推断扩展名 */
export function extFromMime(mime) {
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif', 'image/svg+xml': 'svg'
  };
  return map[String(mime || '').toLowerCase()] || 'png';
}

/** 判断文件是否为图片 */
export function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(file.name || '');
}

/* ---------------------------------------------------------- 文件与编码 */

/** 读取文件为文本 */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}

/** Blob → DataURL */
export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    if (!blob) { resolve(null); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取 Blob 失败'));
    reader.readAsDataURL(blob);
  });
}

/** DataURL → Blob */
export function dataURLToBlob(dataURL) {
  if (!dataURL || typeof dataURL !== 'string') return null;
  const parts = dataURL.split(',');
  if (parts.length < 2) return null;
  const meta = parts[0];
  const body = parts.slice(1).join(',');
  const mimeMatch = /data:([^;]+)/.exec(meta);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const isBase64 = /;base64/i.test(meta);
  try {
    if (isBase64) {
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(body)], { type: mime });
  } catch (err) {
    console.warn('[PromptVault] DataURL 解码失败', err);
    return null;
  }
}

/* -------------------------------------------------------------- 哈希 */

function bufToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** 无 SubtleCrypto 时的回退哈希（非加密，仅用于去重） */
function fallbackHash(bytes) {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < bytes.length; i += 1) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[i], 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * 计算 Blob 的 SHA-256 十六进制摘要（用于去重）。
 * SubtleCrypto 不可用时回退到本地哈希。
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function sha256Hex(blob) {
  if (!blob) return '';
  try {
    const buffer = await blob.arrayBuffer();
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (subtle && typeof subtle.digest === 'function') {
      const digest = await subtle.digest('SHA-256', buffer);
      return bufToHex(digest);
    }
    return fallbackHash(new Uint8Array(buffer));
  } catch (err) {
    console.warn('[PromptVault] 哈希计算失败，使用回退算法', err);
    try {
      const buffer = await blob.arrayBuffer();
      return fallbackHash(new Uint8Array(buffer));
    } catch (e) {
      return `${blob.size}-${blob.type}`;
    }
  }
}

/* ---------------------------------------------------------- 缩略图生成 */

/**
 * 用 canvas 生成最长边 maxEdge 的缩略图。
 * 带透明通道的图片先用白底填充，输出 image/jpeg。
 * @param {Blob} blob 原图
 * @param {number} [maxEdge=480]
 * @param {number} [quality=0.82]
 * @returns {Promise<{thumb: Blob|null, width: number, height: number}>}
 */
export function genThumbnail(blob, maxEdge = 480, quality = 0.82) {
  return new Promise((resolve) => {
    if (!blob) { resolve({ thumb: null, width: 0, height: 0 }); return; }
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const cleanup = () => URL.revokeObjectURL(url);

    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) { cleanup(); resolve({ thumb: null, width: 0, height: 0 }); return; }
        const scale = Math.min(1, maxEdge / Math.max(w, h));
        const tw = Math.max(1, Math.round(w * scale));
        const th = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, tw, th);
        ctx.drawImage(img, 0, 0, tw, th);
        cleanup();
        canvas.toBlob((out) => {
          resolve({ thumb: out || null, width: w, height: h });
        }, 'image/jpeg', quality);
      } catch (err) {
        console.warn('[PromptVault] 缩略图生成失败', err);
        cleanup();
        resolve({ thumb: null, width: 0, height: 0 });
      }
    };

    img.onerror = () => { cleanup(); resolve({ thumb: null, width: 0, height: 0 }); };
    img.src = url;
  });
}

/* ---------------------------------------------------------- 图片压缩 */

/** 入库图片体积上限：300KB（307200 字节） */
export const MAX_IMAGE_BYTES = 300 * 1024;

/** 本身已是高效压缩格式：体积达标时原样入库，避免无意义重编码 */
const EFFICIENT_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/webp', 'image/avif']);

/** 重编码会丢失信息（动画 / 矢量）：体积达标时一律原样保留 */
const PRESERVE_MIMES = new Set(['image/gif', 'image/svg+xml']);

/** 质量搜索区间 */
const QUALITY_HIGH = 0.92;
const QUALITY_LOW = 0.4;
/** 首轮探测质量：多数图片在这一档即可达标 */
const QUALITY_PROBE = 0.8;
/** 质量二分轮数上限 */
const QUALITY_ROUNDS = 4;

/** 分辨率阶梯（相对原图长边），从原图尺寸逐级下探 */
const SCALE_LADDER = [1, 0.85, 0.72, 0.6, 0.5, 0.42, 0.35];

/** 长边下限：再小就会出现肉眼可见的马赛克 */
const MIN_LONG_EDGE = 320;

/** webp 编码能力缓存（null 表示尚未检测） */
let webpEncodeSupport = null;

/**
 * 把 Blob 解码成可绘制的 <img>，并返回释放函数。
 * @param {Blob} blob
 * @returns {Promise<{img: HTMLImageElement|null, release: ()=>void}>}
 */
function decodeImage(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const release = () => URL.revokeObjectURL(url);
    img.onload = () => resolve({ img, release });
    img.onerror = () => { release(); resolve({ img: null, release: () => {} }); };
    img.src = url;
  });
}

/**
 * canvas → Blob（Promise 包装，编码异常时返回 null）。
 * @param {HTMLCanvasElement} canvas
 * @param {string} type
 * @param {number} quality
 * @returns {Promise<Blob|null>}
 */
function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((out) => resolve(out || null), type, quality);
    } catch (err) {
      console.warn('[PromptVault] canvas 编码失败', err);
      resolve(null);
    }
  });
}

/**
 * 检测当前浏览器是否支持 canvas 输出 image/webp（结果缓存）。
 * @returns {Promise<boolean>}
 */
async function supportsWebpEncoding() {
  if (webpEncodeSupport !== null) return webpEncodeSupport;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const out = await canvasToBlob(canvas, 'image/webp', 0.9);
    webpEncodeSupport = Boolean(out && out.type === 'image/webp');
  } catch (err) {
    webpEncodeSupport = false;
  }
  return webpEncodeSupport;
}

/**
 * 在固定分辨率下搜索「能达标且质量最高」的编码结果。
 * @param {(w:number,h:number,quality:number)=>Promise<Blob|null>} encodeAt
 * @param {number} w
 * @param {number} h
 * @param {number} maxBytes
 * @returns {Promise<Blob|null>} 该分辨率下无法达标时返回 null
 */
async function fitQualityAtScale(encodeAt, w, h, maxBytes) {
  let low = QUALITY_LOW;
  let high = QUALITY_HIGH;
  let best = null;

  // 先用中等质量探底：命中则向上二分找更高画质
  const probe = await encodeAt(w, h, QUALITY_PROBE);
  if (!probe) return null;
  if (probe.size <= maxBytes) {
    best = probe;
    low = QUALITY_PROBE;
  } else {
    // 中等质量已超标，用下限再探一次，判断该分辨率是否还有救
    const floor = await encodeAt(w, h, QUALITY_LOW);
    if (!floor || floor.size > maxBytes) return null;
    best = floor;
    high = QUALITY_PROBE;
  }

  for (let round = 0; round < QUALITY_ROUNDS; round += 1) {
    if (high - low < 0.06) break;
    const mid = (low + high) / 2;
    // eslint-disable-next-line no-await-in-loop
    const candidate = await encodeAt(w, h, mid);
    if (!candidate) break;
    if (candidate.size <= maxBytes) { best = candidate; low = mid; } else { high = mid; }
  }
  return best;
}

/**
 * 把图片压缩到指定体积以内（默认 300KB）。
 *
 * 策略：
 * 1. 快速通道 —— 原图已达标的 JPEG / WebP / AVIF / GIF / SVG 不重编码；
 * 2. 输出优先 image/webp（体积小且保留透明通道），浏览器不支持时回退 image/jpeg（白底填充）；
 * 3. 先固定分辨率二分质量，质量触底仍超标再按阶梯降分辨率，长边不低于 320px；
 * 4. 压缩失败或结果反而更大时原样返回，绝不让调用方导入失败。
 *
 * @param {Blob} blob 原图
 * @param {{maxBytes?:number}} [options]
 * @returns {Promise<{blob:Blob, mime:string, width:number, height:number,
 *                    compressed:boolean, originalSize:number}>}
 *          width / height 为压缩后实际像素；compressed 为 false 时二者为 0，
 *          调用方应改用 genThumbnail() 返回的尺寸（两者对同一 blob 必然一致）。
 */
export async function compressImage(blob, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_IMAGE_BYTES;
  const originalSize = blob ? Number(blob.size) || 0 : 0;
  const originalMime = String((blob && blob.type) || '').toLowerCase();

  /** 原样返回（不压缩） */
  const passthrough = (reason) => {
    if (reason) console.warn('[PromptVault] 图片压缩回退原图：', reason);
    return {
      blob,
      mime: originalMime || 'image/*',
      width: 0,
      height: 0,
      compressed: false,
      originalSize
    };
  };

  if (!blob || !originalSize) return passthrough('');

  // 快速通道：已达标的压缩格式 / 不宜重编码的格式直接入库
  if (originalSize <= maxBytes && (EFFICIENT_MIMES.has(originalMime) || PRESERVE_MIMES.has(originalMime))) {
    return passthrough('');
  }

  const decoded = await decodeImage(blob);
  if (!decoded.img) return passthrough('图片无法解码');

  try {
    const srcW = decoded.img.naturalWidth || decoded.img.width;
    const srcH = decoded.img.naturalHeight || decoded.img.height;
    if (!srcW || !srcH) return passthrough('图片尺寸无效');

    const useWebp = await supportsWebpEncoding();
    const outType = useWebp ? 'image/webp' : 'image/jpeg';
    const needFlatten = outType === 'image/jpeg'; // JPEG 无透明通道，先铺白底

    const longEdge = Math.max(srcW, srcH);
    const minScale = longEdge > MIN_LONG_EDGE ? MIN_LONG_EDGE / longEdge : 1;
    const scales = SCALE_LADDER.filter((scale) => scale >= minScale - 1e-6);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return passthrough('无法创建 canvas 上下文');

    /** 在指定尺寸 / 质量下编码一次 */
    const encodeAt = async (w, h, quality) => {
      canvas.width = w;
      canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      if (needFlatten) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(decoded.img, 0, 0, w, h);
      return canvasToBlob(canvas, outType, quality);
    };

    let best = null;
    let bestWidth = 0;
    let bestHeight = 0;

    for (const scale of scales) {
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));
      // eslint-disable-next-line no-await-in-loop
      const hit = await fitQualityAtScale(encodeAt, w, h, maxBytes);
      if (hit) { best = hit; bestWidth = w; bestHeight = h; break; }
    }

    if (!best) return passthrough('在长边 320px 下限内仍无法压到目标体积');
    if (best.size >= originalSize) return passthrough('压缩后体积未减小');

    return {
      blob: best,
      mime: best.type || outType,
      width: bestWidth,
      height: bestHeight,
      compressed: true,
      originalSize
    };
  } catch (err) {
    return passthrough(err && err.message ? err.message : '压缩过程异常');
  } finally {
    decoded.release();
  }
}

/* ------------------------------------------------ 批量导入专用快通道 */

/**
 * 解码图片（优先 createImageBitmap，解码在后台线程，比 <img> 快 30-50%）。
 * @param {Blob} blob
 * @returns {Promise<{source:any, width:number, height:number, release:()=>void}|null>}
 */
async function decodeFast(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      return {
        source: bmp,
        width: bmp.width,
        height: bmp.height,
        release: () => { try { bmp.close(); } catch (err) { /* 忽略 */ } }
      };
    } catch (err) {
      // 某些格式 createImageBitmap 不支持，回退 <img>
    }
  }
  const legacy = await decodeImage(blob);
  if (!legacy.img) return null;
  return {
    source: legacy.img,
    width: legacy.img.naturalWidth || legacy.img.width,
    height: legacy.img.naturalHeight || legacy.img.height,
    release: legacy.release
  };
}

/** 批量导入的质量阶梯：从「够用」开始，不追求最优，命中即停 */
const FAST_QUALITY_LADDER = [0.78, 0.6, 0.45];
/** 批量导入的分辨率阶梯（相对「预缩放后」的基准尺寸） */
const FAST_SCALE_LADDER = [1, 0.82, 0.68, 0.55];
/**
 * 编码前的像素上限。
 *
 * 300KB 的 webp 在 200 万像素左右就能达到不错的观感（约 1600×1250）；
 * 更大的图无论怎么调质量都必然要降分辨率，先缩再编码可以避免
 * 在 4000×3000 这种尺寸上反复编码 —— 那才是真正的耗时黑洞
 * （实测原尺寸编码一次就要 1-2 秒）。
 */
const FAST_MAX_PIXELS = 2200000;

/**
 * 批量导入专用：一次解码同时产出「压缩图 + 缩略图」。
 *
 * 与 compressImage + genThumbnail 的组合相比，省掉一次完整解码，
 * 并把「质量二分找最优画质」换成「够用即停」——典型图片 1 次编码即可定稿。
 * 大批量导入（上千张）时整体快 3-5 倍，代价是画质从「最优」降为「够用」。
 *
 * @param {Blob} blob 原图
 * @param {{maxBytes?:number, thumbEdge?:number, thumbQuality?:number}} [options]
 * @returns {Promise<{blob:Blob, mime:string, width:number, height:number,
 *                    compressed:boolean, originalSize:number,
 *                    thumb:Blob|null}>}
 */
export async function compressAndThumbnail(blob, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_IMAGE_BYTES;
  const thumbEdge = Number(options.thumbEdge) > 0 ? Number(options.thumbEdge) : 480;
  const thumbQuality = Number(options.thumbQuality) > 0 ? Number(options.thumbQuality) : 0.8;
  const originalSize = blob ? Number(blob.size) || 0 : 0;
  const originalMime = String((blob && blob.type) || '').toLowerCase();

  const passthrough = () => ({
    blob,
    mime: originalMime || 'image/*',
    width: 0,
    height: 0,
    compressed: false,
    originalSize,
    thumb: null
  });

  if (!blob || !originalSize) return passthrough();

  const decoded = await decodeFast(blob);
  if (!decoded) return passthrough();

  const { source, width: srcW, height: srcH } = decoded;
  if (!srcW || !srcH) { decoded.release(); return passthrough(); }

  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    /* --- 缩略图：先做，成本固定且必须产出 --- */
    const scale = Math.min(1, thumbEdge / Math.max(srcW, srcH));
    const tw = Math.max(1, Math.round(srcW * scale));
    const th = Math.max(1, Math.round(srcH * scale));
    canvas.width = tw;
    canvas.height = th;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tw, th);
    ctx.drawImage(source, 0, 0, tw, th);
    const thumb = await canvasToBlob(canvas, 'image/jpeg', thumbQuality);

    /* --- 压缩图：已经是高效格式且达标 → 直接用原图 --- */
    const alreadyOk = originalSize <= maxBytes
      && (EFFICIENT_MIMES.has(originalMime) || PRESERVE_MIMES.has(originalMime));
    if (alreadyOk) {
      return {
        blob,
        mime: originalMime,
        width: srcW,
        height: srcH,
        compressed: false,
        originalSize,
        thumb
      };
    }

    const useWebp = await supportsWebpEncoding();
    const outType = useWebp ? 'image/webp' : 'image/jpeg';
    const needFlatten = outType === 'image/jpeg';

    let best = null;
    let bestW = 0;
    let bestH = 0;

    // 预缩放：先按像素上限把超大图缩下来，再在缩放后的基准上试质量。
    // 直接在 4000×3000 上编码一次就要 1-2 秒，且最终必然要降分辨率。
    const srcPixels = srcW * srcH;
    const preK = srcPixels > FAST_MAX_PIXELS ? Math.sqrt(FAST_MAX_PIXELS / srcPixels) : 1;
    const baseW = Math.max(1, Math.round(srcW * preK));
    const baseH = Math.max(1, Math.round(srcH * preK));

    // 按「原图字节 / 像素」预判起步质量，尽量一次编码就命中：
    //   噪点多的照片（>1.5 B/px）压缩比差，从低质量起步；
    //   纯色/线稿（<0.5 B/px）本来就好压，从高质量起步避免糊。
    const bytesPerPixel = originalSize / srcPixels;
    const startQ = bytesPerPixel > 1.5 ? 0.55 : (bytesPerPixel > 0.5 ? 0.7 : 0.85);
    const qualities = [startQ, Math.max(0.35, startQ - 0.16), 0.35];

    outer:
    for (const s of FAST_SCALE_LADDER) {
      const w = Math.max(1, Math.round(baseW * s));
      const h = Math.max(1, Math.round(baseH * s));
      canvas.width = w;
      canvas.height = h;
      for (const quality of qualities) {
        ctx.clearRect(0, 0, w, h);
        if (needFlatten) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(source, 0, 0, w, h);
        // eslint-disable-next-line no-await-in-loop
        const out = await canvasToBlob(canvas, outType, quality);
        if (out && out.size <= maxBytes) {
          best = out;
          bestW = w;
          bestH = h;
          break outer;
        }
      }
    }

    // 压不下去 / 反而更大 → 存原图（不阻断导入）
    if (!best || best.size >= originalSize) {
      return {
        blob,
        mime: originalMime || 'image/*',
        width: srcW,
        height: srcH,
        compressed: false,
        originalSize,
        thumb
      };
    }

    return {
      blob: best,
      mime: best.type || outType,
      width: bestW,
      height: bestH,
      compressed: true,
      originalSize,
      thumb
    };
  } catch (err) {
    console.warn('[PromptVault] 批量压缩失败，回退原图', err);
    return passthrough();
  } finally {
    decoded.release();
  }
}

/* ------------------------------------------------------------ 剪贴板 */

/**
 * 复制文本：优先 navigator.clipboard，失败回退隐藏 textarea + execCommand。
 * @param {string} text
 * @returns {Promise<boolean>} 是否成功
 */
export async function copyText(text) {
  const value = String(text == null ? '' : text);
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (err) {
    console.warn('[PromptVault] clipboard API 不可用，回退 execCommand', err);
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    console.warn('[PromptVault] execCommand 复制失败', err);
    return false;
  }
}

/**
 * 复制并弹出 toast 提示。
 * @param {string} text 待复制文本
 * @param {string} okMessage 成功提示
 * @param {string} [emptyMessage] 内容为空时的提示
 */
export async function copyAndToast(text, okMessage, emptyMessage = '内容为空，未复制') {
  if (!text || !String(text).trim()) { toast(emptyMessage, 'warn'); return false; }
  const ok = await copyText(text);
  if (ok) toast(okMessage, 'success');
  else toast('复制失败，请手动选择文本后复制', 'error');
  return ok;
}

/* ---------------------------------------------------------- 提示词拼接 */

/**
 * 把一张图片的正向 / 负向 / 参数拼成完整提示词文本（用于「复制全部」）。
 * @param {{positive?:string, negative?:string, params?:string}} image
 * @returns {string}
 */
export function composePromptText(image) {
  const parts = [];
  const positive = String((image && image.positive) || '').trim();
  const negative = String((image && image.negative) || '').trim();
  const params = String((image && image.params) || '').trim();
  if (positive) parts.push(`正向提示词：\n${positive}`);
  if (negative) parts.push(`负向提示词：\n${negative}`);
  if (params) parts.push(`参数：\n${params}`);
  return parts.join('\n\n');
}

/* --------------------------------------------------------------- CSV */

/**
 * 解析 CSV 文本为二维数组（支持双引号包裹与转义）。
 * 会先剥离 UTF-8 BOM（不依赖 FileReader 是否已剥离），避免首个表头变成 "\uFEFFname"。
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let hasField = false;
  const src = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
      hasField = true;
    } else if (ch === ',') {
      row.push(field); field = ''; hasField = false;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = []; field = ''; hasField = false;
    } else {
      field += ch;
      hasField = true;
    }
  }
  if (hasField || field !== '' || row.length) { row.push(field); rows.push(row); }
  // 去掉完全空白的尾行
  return rows.filter((r) => !(r.length === 1 && String(r[0]).trim() === ''));
}

/** 单个 CSV 字段转义：含逗号、双引号、CR 或 LF 的字段一律加引号包裹 */
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[\r\n,"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 二维数组 → CSV 文本（带 UTF-8 BOM，便于 Excel 正确识别中文）。
 * @param {string[][]} rows
 * @returns {string}
 */
export function toCsv(rows) {
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  return `\uFEFF${body}`;
}

/* --------------------------------------------------------------- toast */

const TOAST_ICONS = { success: 'check', error: 'alert', warn: 'alert', info: 'info' };

/**
 * 右上角轻提示。
 * @param {string} message
 * @param {'success'|'error'|'warn'|'info'} [type='info']
 * @param {number} [duration=2200]
 */
export function toast(message, type = 'info', duration = 2200) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = el('div', { id: 'toast-host', class: 'toast-host' });
    document.body.appendChild(host);
  }
  const node = el('div', { class: `toast toast-${type}` });
  const ico = el('span', { class: 'toast-icon', html: icon(TOAST_ICONS[type] || 'info', 16) });
  node.appendChild(ico);
  node.appendChild(el('span', { class: 'toast-text', text: String(message) }));
  host.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  }, duration);
}

/* --------------------------------------------------------------- 弹窗 */

/** 弹窗栈，供 Esc 关闭最上层使用 */
const modalStack = [];

/**
 * 打开一个弹窗。
 * @param {object} opts
 * @param {string} [opts.title] 标题
 * @param {Node|string} [opts.content] 主体内容
 * @param {Node|string} [opts.footer] 底部内容
 * @param {boolean} [opts.wide] 是否使用宽弹窗
 * @param {boolean} [opts.dismissible=true] 是否允许 Esc / 点击遮罩关闭
 * @param {(result:any)=>void} [opts.onClose] 关闭回调
 * @returns {{backdrop:HTMLElement, modal:HTMLElement, head:HTMLElement, body:HTMLElement, footer:HTMLElement|null, close:(r?:any)=>void}}
 */
export function openModal(opts = {}) {
  const root = document.getElementById('modal-root') || document.body;
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: `modal${opts.wide ? ' modal-wide' : ''}` });

  const head = el('div', { class: 'modal-head' });
  const title = el('h3', { class: 'modal-title', text: opts.title || '' });
  const closeBtn = el('button', { class: 'icon-btn', type: 'button', title: '关闭', html: icon('close', 18) });
  head.appendChild(title);
  head.appendChild(closeBtn);

  const body = el('div', { class: 'modal-body' });
  if (typeof opts.content === 'string') body.innerHTML = opts.content;
  else if (opts.content) body.appendChild(opts.content);

  modal.appendChild(head);
  modal.appendChild(body);

  let footer = null;
  if (opts.footer) {
    footer = el('div', { class: 'modal-foot' });
    if (typeof opts.footer === 'string') footer.innerHTML = opts.footer;
    else footer.appendChild(opts.footer);
    modal.appendChild(footer);
  }

  backdrop.appendChild(modal);
  root.appendChild(backdrop);

  const api = {
    backdrop, modal, head, body, footer, title,
    dismissible: opts.dismissible !== false,
    close(result) {
      if (!backdrop.parentNode) return;
      backdrop.remove();
      const idx = modalStack.indexOf(api);
      if (idx >= 0) modalStack.splice(idx, 1);
      if (typeof opts.onClose === 'function') opts.onClose(result);
    }
  };

  closeBtn.addEventListener('click', () => api.close(null));
  if (api.dismissible) {
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) api.close(null); });
  }

  modalStack.push(api);
  return api;
}

/** 关闭最上层弹窗；返回是否关闭了任意弹窗 */
export function closeTopModal() {
  // 放大层是最上层，存在时 Esc 只应关闭它（其自身监听已处理），此处不再动弹窗
  if (document.querySelector('.zoom-layer')) return false;
  const top = modalStack[modalStack.length - 1];
  if (!top) return false;
  if (top.dismissible === false) return false;
  top.close(null);
  return true;
}

/** 当前是否存在弹窗 */
export function hasModal() {
  return modalStack.length > 0;
}

// Esc 统一由工具层处理（保证只关闭最上层）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTopModal();
});

/**
 * 二次确认对话框。
 * @param {string} message 提示文案
 * @param {object} [opts]
 * @param {string} [opts.title='请确认']
 * @param {boolean} [opts.danger=false]
 * @param {string} [opts.okText='确定']
 * @param {string} [opts.cancelText='取消']
 * @returns {Promise<boolean>}
 */
export function confirmDialog(message, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const footer = el('div', { class: 'modal-foot', style: { width: '100%' } });
    const cancel = el('button', { class: 'btn', type: 'button', text: opts.cancelText || '取消' });
    const ok = el('button', {
      class: `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`,
      type: 'button',
      text: opts.okText || '确定'
    });
    footer.appendChild(el('span', { class: 'spacer' }));
    footer.appendChild(cancel);
    footer.appendChild(ok);

    const api = openModal({
      title: opts.title || '请确认',
      dismissible: true,
      content: el('div', { class: 'section-desc', text: message }),
      footer,
      onClose: () => done(false)
    });
    cancel.addEventListener('click', () => api.close(false));
    ok.addEventListener('click', () => { done(true); api.close(true); });
    ok.focus();
  });
}

/**
 * 单行输入对话框。
 * @param {string} message 提示文案
 * @param {string} [defaultValue='']
 * @param {object} [opts]
 * @param {string} [opts.title='输入']
 * @param {string} [opts.placeholder='']
 * @param {string} [opts.okText='确定']
 * @param {string} [opts.type='text']
 * @returns {Promise<string|null>}
 */
export function promptDialog(message, defaultValue = '', opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const input = el('input', {
      class: 'input', type: opts.type || 'text',
      placeholder: opts.placeholder || '', value: defaultValue
    });
    const wrap = el('div', { class: 'section' });
    if (message) wrap.appendChild(el('div', { class: 'section-desc', text: message }));
    wrap.appendChild(input);

    const footer = el('div', { class: 'modal-foot', style: { width: '100%' } });
    const cancel = el('button', { class: 'btn', type: 'button', text: '取消' });
    const ok = el('button', { class: 'btn btn-primary', type: 'button', text: opts.okText || '确定' });
    footer.appendChild(el('span', { class: 'spacer' }));
    footer.appendChild(cancel);
    footer.appendChild(ok);

    const api = openModal({
      title: opts.title || '输入',
      content: wrap,
      footer,
      onClose: () => done(null)
    });

    const submit = () => { const v = input.value.trim(); if (!v) { input.focus(); return; } done(v); api.close(v); };
    cancel.addEventListener('click', () => api.close(null));
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

/**
 * 从列表中选择一项（用于分类选择等）。
 * @param {string} title 标题
 * @param {Array<{value:string,label:string}>} options 选项
 * @param {object} [opts]
 * @param {string} [opts.label] 选择框上方标签
 * @param {string} [opts.emptyLabel] 允许留空时的空选项文案
 * @param {string} [opts.defaultValue]
 * @returns {Promise<string|null>} 取消返回 null
 */
export function listDialog(title, options, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    const select = el('select', { class: 'select' });
    if (opts.emptyLabel) select.appendChild(el('option', { value: '', text: opts.emptyLabel }));
    for (const opt of options) {
      select.appendChild(el('option', { value: opt.value, text: opt.label }));
    }
    if (opts.defaultValue !== undefined) select.value = opts.defaultValue;

    const wrap = el('div', { class: 'section' });
    if (opts.label) wrap.appendChild(el('div', { class: 'field-label', text: opts.label }));
    wrap.appendChild(select);

    const footer = el('div', { class: 'modal-foot', style: { width: '100%' } });
    const cancel = el('button', { class: 'btn', type: 'button', text: '取消' });
    const ok = el('button', { class: 'btn btn-primary', type: 'button', text: '确定' });
    footer.appendChild(el('span', { class: 'spacer' }));
    footer.appendChild(cancel);
    footer.appendChild(ok);

    const api = openModal({ title, content: wrap, footer, onClose: () => done(null) });
    cancel.addEventListener('click', () => api.close(null));
    ok.addEventListener('click', () => { done(select.value); api.close(select.value); });
    setTimeout(() => select.focus(), 30);
  });
}

/**
 * 多选项选择弹窗（一次选择后统一生效），用于导入去重策略。
 * @param {string} title
 * @param {string} message
 * @param {Array<{value:string,label:string,desc?:string,danger?:boolean}>} choices
 * @returns {Promise<string|null>}
 */
export function chooseDialog(title, message, choices) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    const wrap = el('div', { class: 'section' });
    if (message) wrap.appendChild(el('div', { class: 'section-desc', text: message }));

    const list = el('div', { class: 'btn-row', style: { flexDirection: 'column' } });
    for (const choice of choices) {
      const btn = el('button', {
        class: `btn${choice.danger ? ' btn-danger' : ''}`,
        type: 'button',
        style: { width: '100%', height: 'auto', padding: '10px 12px', justifyContent: 'flex-start', flexDirection: 'column', alignItems: 'flex-start', gap: '2px' }
      });
      btn.appendChild(el('span', { style: { fontWeight: '600' }, text: choice.label }));
      if (choice.desc) btn.appendChild(el('span', { class: 'muted', text: choice.desc }));
      btn.addEventListener('click', () => { done(choice.value); api.close(choice.value); });
      list.appendChild(btn);
    }
    wrap.appendChild(list);

    const api = openModal({ title, content: wrap, onClose: () => done(null) });
  });
}
