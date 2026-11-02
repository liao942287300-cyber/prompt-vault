/* =========================================================================
 * js/png-meta.js —— PNG 内嵌提示词提取
 * 职责：流式读取 PNG 的 tEXt / zTXt / iTXt 文本块，识别主流 AI 出图工具
 *      写入的生成参数，归一化成 { positive, negative, params }。
 * 本模块不依赖任何业务模块，也不引入外部依赖，只使用浏览器内置 API。
 * ========================================================================= */

/** PNG 文件签名（8 字节） */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 首次读取的头部字节数（绝大多数文本块都在这一区间内） */
const INITIAL_READ_BYTES = 64 * 1024;

/** 元数据扫描上限：超过该体积仍无结果就放弃，避免为解析元数据读入整张大图 */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/** 单次扩容的最大轮数（防御性上限，正常图片 1~2 轮即可） */
const MAX_SCAN_ROUNDS = 8;

/** 单个 chunk 数据长度上限，超过视为文件损坏 */
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

/** 已经在前面的分支里消费掉的关键字，不再进入兜底流程 */
const HANDLED_KEYS = new Set([
  'parameters', 'prompt', 'workflow', 'description', 'comment',
  'negative_prompt', 'negative prompt', 'uc'
]);

/** 可以直接当作正向提示词使用的兜底关键字 */
const PROMPT_KEYS = new Set(['dream', 'prompt_text', 'positive', 'positive prompt', 'positive_prompt']);

/** 负向提示词的常见特征词（用于在多个文本块中区分正 / 负向） */
const NEGATIVE_HINT = /(?:worst quality|low quality|lowres|bad anatomy|bad hands|bad proportions|deformed|disfigured|blurry|watermark|nsfw|ugly|extra limbs|jpeg artifacts|signature|text,)/i;

/* ------------------------------------------------------------ 基础工具 */

/**
 * 判断文件是否为 PNG。
 * @param {File|Blob} file
 * @returns {boolean}
 */
export function isPngFile(file) {
  if (!file) return false;
  if (String(file.type || '').toLowerCase() === 'image/png') return true;
  return /\.png$/i.test(String(file.name || ''));
}

/** 读取 4 字节大端无符号整数 */
function readUint32BE(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/** 读取 4 字节 ASCII chunk 类型名 */
function readChunkType(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * 字节数组 → 文本。
 * PNG 规范里 tEXt 是 Latin-1、iTXt 是 UTF-8，但实际工具常把 UTF-8 写进 tEXt，
 * 因此优先按 UTF-8 严格解码，失败再回退 Latin-1。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeText(bytes) {
  if (!bytes || !bytes.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    try {
      return new TextDecoder('iso-8859-1').decode(bytes);
    } catch (e) {
      return '';
    }
  }
}

/** 找到从 from 开始的第一个 0x00 分隔符，未找到返回 -1 */
function indexOfZero(bytes, from = 0) {
  for (let i = from; i < bytes.length; i += 1) {
    if (bytes[i] === 0) return i;
  }
  return -1;
}

/**
 * zlib(deflate) 解压。
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array|null>} 浏览器不支持或解压失败时返回 null
 */
async function inflateBytes(bytes) {
  if (typeof DecompressionStream !== 'function') {
    console.warn('[PromptVault] 当前浏览器不支持 DecompressionStream，跳过压缩文本块');
    return null;
  }
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch (err) {
    console.warn('[PromptVault] PNG 文本块解压失败', err);
    return null;
  }
}

/* ------------------------------------------------------------ chunk 解析 */

/**
 * 解析单个文本块（tEXt / zTXt / iTXt）。
 * @param {string} type chunk 类型
 * @param {Uint8Array} data chunk 数据区
 * @returns {Promise<{keyword:string, text:string}|null>}
 */
async function parseTextChunk(type, data) {
  if (!data || !data.length) return null;
  const firstZero = indexOfZero(data, 0);
  if (firstZero < 0) return null;
  const keyword = decodeText(data.subarray(0, firstZero));

  if (type === 'tEXt') {
    return { keyword, text: decodeText(data.subarray(firstZero + 1)) };
  }

  if (type === 'zTXt') {
    const method = data[firstZero + 1];
    if (method !== 0) return null; // 仅支持 deflate 压缩方法
    const raw = await inflateBytes(data.subarray(firstZero + 2));
    return raw ? { keyword, text: decodeText(raw) } : null;
  }

  // iTXt：keyword\0 flag(1B) method(1B) languageTag\0 translatedKeyword\0 text
  const flag = data[firstZero + 1];
  let cursor = firstZero + 3;
  const langEnd = indexOfZero(data, cursor);
  if (langEnd < 0) return null;
  cursor = langEnd + 1;
  const translatedEnd = indexOfZero(data, cursor);
  if (translatedEnd < 0) return null;
  cursor = translatedEnd + 1;
  const body = data.subarray(cursor);
  if (flag === 1) {
    const raw = await inflateBytes(body);
    return raw ? { keyword, text: decodeText(raw) } : null;
  }
  return { keyword, text: decodeText(body) };
}

/**
 * 在已读入的头部字节里顺序扫描 chunk。
 * @param {Uint8Array} bytes
 * @returns {Promise<{entries:Array<{keyword:string,text:string}>, done:boolean}>}
 *          done 为真表示无需再读更多字节（已到 IEND / IDAT，或文件不是 PNG）
 */
async function scanChunks(bytes) {
  const entries = [];
  if (bytes.length < 8) return { entries, done: false };
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return { entries, done: true }; // 不是 PNG，直接放弃
  }

  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length = readUint32BE(bytes, pos);
    const type = readChunkType(bytes, pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (length > MAX_CHUNK_BYTES) return { entries, done: true };
    if (dataEnd + 4 > bytes.length) return { entries, done: false }; // 需要更多字节
    // 像素数据与结束块都在文本块之后，遇到即可停
    if (type === 'IEND' || type === 'IDAT') return { entries, done: true };
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const entry = await parseTextChunk(type, bytes.subarray(dataStart, dataEnd));
      if (entry && entry.keyword) entries.push(entry);
    }
    pos = dataEnd + 4;
  }
  return { entries, done: false };
}

/* ------------------------------------------------------------ 格式归一化 */

/**
 * 解析 AUTOMATIC1111 / SD WebUI 的 parameters 文本。
 * 形如：
 *   正向提示词……
 *   Negative prompt: 负向提示词……
 *   Steps: 20, Sampler: ..., CFG scale: 7, Seed: 123, Size: 512x768, Model: xxx
 * @param {string} raw
 * @returns {{positive:string, negative:string, params:string}}
 */
function parseA1111(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  const out = { positive: '', negative: '', params: '' };
  if (!text) return out;

  const negMatch = /(?:^|\n)[ \t]*Negative prompt[ \t]*:/i.exec(text);
  const stepsMatch = /(?:^|\n)[ \t]*Steps[ \t]*:/i.exec(text);

  // 正向：两个分隔行中最靠前的那个之前
  let positiveEnd = text.length;
  if (negMatch) positiveEnd = Math.min(positiveEnd, negMatch.index);
  if (stepsMatch) positiveEnd = Math.min(positiveEnd, stepsMatch.index);
  out.positive = text.slice(0, positiveEnd).trim();

  // 负向：Negative prompt: 之后到 Steps: 之前
  if (negMatch) {
    const bodyStart = negMatch.index + negMatch[0].length;
    const bodyEnd = stepsMatch && stepsMatch.index > negMatch.index ? stepsMatch.index : text.length;
    out.negative = bodyStart < bodyEnd ? text.slice(bodyStart, bodyEnd).trim() : '';
  }

  // 参数：Steps: 起整段
  if (stepsMatch) out.params = text.slice(stepsMatch.index).trim();

  return out;
}

/**
 * 解析 ComfyUI 的 prompt / workflow JSON。
 * @param {string} raw JSON 原文
 * @returns {{positive:string, negative:string, params:string}}
 */
function parseComfyJson(raw) {
  const out = { positive: '', negative: '', params: raw };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return out; // 解析失败只保留 params
  }
  if (!data || typeof data !== 'object') return out;

  const texts = [];
  const pushText = (value) => {
    if (typeof value === 'string' && value.trim()) texts.push(value.trim());
  };

  // API 格式：{ "3": { class_type: "CLIPTextEncode", inputs: { text: "..." } } }
  for (const node of Object.values(data)) {
    if (!node || typeof node !== 'object') continue;
    const classType = String(node.class_type || node.type || '');
    if (!/CLIPTextEncode/i.test(classType)) continue;
    if (node.inputs && typeof node.inputs === 'object') pushText(node.inputs.text);
    else if (Array.isArray(node.widgets_values)) pushText(node.widgets_values[0]);
  }

  // UI 格式：{ nodes: [ { type: "CLIPTextEncode", widgets_values: ["..."] } ] }
  if (Array.isArray(data.nodes)) {
    for (const node of data.nodes) {
      if (!node || typeof node !== 'object') continue;
      if (!/CLIPTextEncode/i.test(String(node.type || ''))) continue;
      if (Array.isArray(node.widgets_values)) pushText(node.widgets_values[0]);
      else if (node.inputs && typeof node.inputs === 'object') pushText(node.inputs.text);
    }
  }

  const unique = [];
  for (const text of texts) {
    if (!unique.includes(text)) unique.push(text);
  }
  if (!unique.length) return out;

  if (unique.length === 1) {
    if (NEGATIVE_HINT.test(unique[0])) out.negative = unique[0];
    else out.positive = unique[0];
    return out;
  }

  const negIndex = unique.findIndex((text) => NEGATIVE_HINT.test(text));
  if (negIndex >= 0) {
    out.negative = unique[negIndex];
    out.positive = unique.find((text, index) => index !== negIndex) || '';
  } else {
    out.positive = unique[0];
    out.negative = unique[1];
  }
  return out;
}

/**
 * 解析 NovelAI 的 Comment JSON（uc = 负向词，prompt = 正向词，其余字段进 params）。
 * @param {string} raw JSON 原文
 * @returns {{positive:string, negative:string, params:string}}
 */
function parseNovelAiComment(raw) {
  const out = { positive: '', negative: '', params: '' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return out;
  }
  if (!data || typeof data !== 'object') return out;

  const uc = data.uc || data.negative_prompt || data.negative;
  if (typeof uc === 'string' && uc.trim()) out.negative = uc.trim();

  const prompt = data.prompt || data.positive;
  if (typeof prompt === 'string' && prompt.trim()) out.positive = prompt.trim();

  const skip = new Set(['uc', 'prompt', 'positive', 'negative_prompt', 'negative']);
  const parts = [];
  for (const [key, value] of Object.entries(data)) {
    if (skip.has(key)) continue;
    if (value === null || value === undefined || value === '') continue;
    parts.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  out.params = parts.join(', ');
  return out;
}

/**
 * 把若干文本块归一化成 { positive, negative, params }。
 * 识别顺序：SD WebUI → ComfyUI → NovelAI → 显式负向键 → 其余兜底。
 * @param {Array<{keyword:string, text:string}>} entries
 * @returns {{positive:string, negative:string, params:string}}
 */
function normalizeEntries(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = String(entry.keyword || '').trim().toLowerCase();
    const text = String(entry.text || '');
    if (!key || !text.trim()) continue;
    if (!map.has(key)) map.set(key, text); // 同名块只取第一个
  }

  const result = { positive: '', negative: '', params: '' };
  const extras = [];

  const setPositive = (value) => {
    if (!result.positive && value && String(value).trim()) result.positive = String(value).trim();
  };
  const setNegative = (value) => {
    if (!result.negative && value && String(value).trim()) result.negative = String(value).trim();
  };
  const setParams = (value) => {
    if (!result.params && value && String(value).trim()) result.params = String(value).trim();
  };

  /* ① AUTOMATIC1111 / SD WebUI */
  const parameters = map.get('parameters');
  if (parameters) {
    const parsed = parseA1111(parameters);
    setPositive(parsed.positive);
    setNegative(parsed.negative);
    setParams(parsed.params);
  }

  /* ② ComfyUI：prompt / workflow */
  for (const key of ['prompt', 'workflow']) {
    const raw = map.get(key);
    if (!raw) continue;
    const trimmed = raw.trim();
    if (/^[[{]/.test(trimmed)) {
      const parsed = parseComfyJson(trimmed);
      setPositive(parsed.positive);
      setNegative(parsed.negative);
      setParams(parsed.params);
    } else {
      setPositive(trimmed);
    }
  }

  /* ③ NovelAI：Description + Comment */
  const description = map.get('description');
  if (description) setPositive(description);

  const comment = map.get('comment');
  if (comment) {
    const trimmed = comment.trim();
    if (/^[[{]/.test(trimmed)) {
      const parsed = parseNovelAiComment(trimmed);
      setPositive(parsed.positive);
      setNegative(parsed.negative);
      setParams(parsed.params);
    } else {
      extras.push(trimmed);
    }
  }

  /* ④ 显式给出的负向词 */
  for (const key of ['negative_prompt', 'negative prompt', 'uc']) {
    const raw = map.get(key);
    if (raw) setNegative(raw);
  }

  /* ⑤ 其余文本块：能当提示词就当正向兜底，否则并入 params，绝不丢弃 */
  for (const [key, raw] of map) {
    if (HANDLED_KEYS.has(key)) continue;
    const text = raw.trim();
    if (!text) continue;
    if (PROMPT_KEYS.has(key)) {
      if (!result.positive) result.positive = text;
      else extras.push(text);
    } else {
      extras.push(`${key}: ${text}`);
    }
  }

  result.positive = result.positive.trim();
  result.negative = result.negative.trim();
  const paramsParts = [];
  if (result.params) paramsParts.push(result.params);
  for (const extra of extras) {
    if (extra && !paramsParts.includes(extra)) paramsParts.push(extra);
  }
  result.params = paramsParts.join('\n').trim();
  return result;
}

/* ------------------------------------------------------------ 对外接口 */

/**
 * 读取 PNG 内嵌的生成提示词。
 * 只读取文件头部的少量字节（分段扩容，命中 IDAT / IEND 即停），不会把整张图读进内存。
 * @param {File|Blob} file PNG 文件
 * @returns {Promise<{positive:string, negative:string, params:string, keys:string[]}>}
 *          非 PNG 或解析不到内容时返回全空对象
 */
export async function readPngPromptMeta(file) {
  const empty = { positive: '', negative: '', params: '', keys: [] };
  if (!isPngFile(file) || !file || !file.size) return empty;

  const limit = Math.min(file.size, MAX_SCAN_BYTES);
  let readBytes = Math.min(file.size, INITIAL_READ_BYTES);
  let entries = [];

  for (let round = 0; round < MAX_SCAN_ROUNDS; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const buffer = new Uint8Array(await file.slice(0, readBytes).arrayBuffer());
    // eslint-disable-next-line no-await-in-loop
    const scanned = await scanChunks(buffer);
    entries = scanned.entries;
    if (scanned.done) break;
    if (readBytes >= limit) break;
    readBytes = Math.min(limit, readBytes * 2);
  }

  if (!entries.length) return empty;
  const meta = normalizeEntries(entries);
  return { ...meta, keys: entries.map((entry) => entry.keyword) };
}
