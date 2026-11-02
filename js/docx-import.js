/* =========================================================================
 * js/docx-import.js —— Word (.docx) 智能导入
 *
 * .docx 本质是一个 ZIP 包，正文在 word/document.xml，图片在 word/media/。
 * 本模块零依赖完成三件事：
 *   1. 解析 ZIP 中央目录，按需取出指定条目（不整包读进内存）
 *   2. 解析 document.xml，按「图片段落 → 后续文本段落」配对成「图 + 提示词」
 *   3. 过滤掉结尾的链接 / 推广段落，不把它们误当提示词
 * ========================================================================= */

/* ------------------------------------------------------------ 命名空间 */

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_V = 'urn:schemas-microsoft-com:vml';

/* -------------------------------------------------------------- ZIP */

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LFH = 0x04034b50;

/** 在文件尾部搜索 EOCD（中央目录结束记录） */
async function findEocd(file) {
  // EOCD 固定 22 字节，后面最多跟 65535 字节注释
  const tailLen = Math.min(file.size, 22 + 65535);
  const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
  // 从后往前找，取第一个命中的（注释里可能藏假签名，倒序更稳）
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      return { bytes: tail.subarray(i), fileOffset: file.size - tailLen + i };
    }
  }
  return null;
}

/**
 * 读取 ZIP 中央目录，返回 名称 → 条目 的映射。
 * @param {File|Blob} file
 * @returns {Promise<Map<string, {name:string, method:number, csize:number, localOffset:number}>>}
 */
export async function readZipDirectory(file) {
  const eocd = await findEocd(file);
  if (!eocd) throw new Error('不是有效的 docx（未找到 ZIP 结构）');

  const dv = new DataView(eocd.bytes.buffer, eocd.bytes.byteOffset, eocd.bytes.byteLength);
  const cdSize = dv.getUint32(12, true);
  const cdOffset = dv.getUint32(16, true);
  if (!cdSize || cdOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的 docx');
  }

  const cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const entries = new Map();
  let p = 0;

  while (p + 46 <= cd.length) {
    const v = new DataView(cd.buffer, cd.byteOffset + p, cd.byteLength - p);
    if (v.getUint32(0, true) !== SIG_CD) break;

    const method = v.getUint16(10, true);
    const csize = v.getUint32(20, true);
    const nameLen = v.getUint16(28, true);
    const extraLen = v.getUint16(30, true);
    const commentLen = v.getUint16(32, true);
    const localOffset = v.getUint32(42, true);
    const name = new TextDecoder('utf-8').decode(cd.subarray(p + 46, p + 46 + nameLen));

    // 目录条目本身跳过（以 / 结尾且大小为 0）
    if (csize > 0) entries.set(name, { name, method, csize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 用浏览器原生 DecompressionStream 做 raw deflate 解压 */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器不支持解压 docx（缺少 DecompressionStream）');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 读取单个 ZIP 条目的解压后字节。
 * @param {File|Blob} file
 * @param {{method:number, csize:number, localOffset:number}} entry
 * @returns {Promise<Uint8Array>}
 */
export async function readZipEntry(file, entry) {
  // 本地文件头里的名称/扩展字段长度可能与中央目录不同，必须重新读
  const head = new Uint8Array(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  if (head.length < 30) throw new Error('ZIP 本地文件头不完整');
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (hv.getUint32(0, true) !== SIG_LFH) throw new Error('ZIP 本地文件头损坏');

  const nameLen = hv.getUint16(26, true);
  const extraLen = hv.getUint16(28, true);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const raw = new Uint8Array(await file.slice(dataStart, dataStart + entry.csize).arrayBuffer());

  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw new Error(`不支持的 ZIP 压缩方式：${entry.method}`);
}

/* -------------------------------------------------------- 关系与正文 */

/** 把 rels 里的相对 Target 规范成包内绝对路径 */
function resolveTarget(target) {
  let t = String(target || '').replace(/\\/g, '/');
  if (t.startsWith('/')) return t.slice(1);
  const parts = `word/${t}`.split('/');
  const out = [];
  for (const seg of parts) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** 解析 word/_rels/document.xml.rels → rId → 包内路径 */
function parseRelations(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const map = new Map();
  for (const node of doc.getElementsByTagName('Relationship')) {
    const id = node.getAttribute('Id');
    const target = node.getAttribute('Target');
    if (id && target) map.set(id, resolveTarget(target));
  }
  return map;
}

/** 提取一个段落里的纯文本 */
function paragraphText(node) {
  const parts = [];
  for (const t of node.getElementsByTagNameNS(NS_W, 't')) parts.push(t.textContent || '');
  return parts.join('').replace(/\u00a0/g, ' ').trim();
}

/** 提取一个段落里引用的图片关系 id（兼容 DrawingML 与旧式 VML） */
function paragraphImageIds(node) {
  const ids = [];
  for (const blip of node.getElementsByTagNameNS(NS_A, 'blip')) {
    const id = blip.getAttributeNS(NS_R, 'embed') || blip.getAttribute('r:embed');
    if (id) ids.push(id);
  }
  if (!ids.length) {
    for (const img of node.getElementsByTagNameNS(NS_V, 'imagedata')) {
      const id = img.getAttributeNS(NS_R, 'id') || img.getAttribute('r:id');
      if (id) ids.push(id);
    }
  }
  return ids;
}

/**
 * 判断段落内「第一张图」和「第一段文字」谁在前。
 * Word 里图片是 inline 对象，和文字可以同处一个段落（`<w:p><w:r>图</w:r><w:r>文字</w:r></w:p>`），
 * 视觉上就是「图下面紧跟提示词」。必须按 run 的实际顺序决定块序，否则会把词错配到上一张图。
 *
 * @returns {{imgFirst:boolean, hasImage:boolean, hasText:boolean}}
 */
function paragraphOrder(node) {
  let idx = 0;
  let firstImg = -1;
  let firstTxt = -1;

  const walk = (parent) => {
    for (const child of parent.children) {
      const local = child.localName;
      if (local === 'r') {
        const isImg = paragraphImageIds(child).length > 0;
        const txt = paragraphText(child);
        if (isImg && firstImg < 0) firstImg = idx;
        if (txt && firstTxt < 0) firstTxt = idx;
        idx += 1;
      } else if (local === 'hyperlink' || local === 'smartTag' || local === 'ins'
        || local === 'del' || local === 'sdt' || local === 'sdtContent') {
        walk(child); // 这些容器里还能继续塞 run
      }
    }
  };
  walk(node);

  return {
    hasImage: firstImg >= 0,
    hasText: firstTxt >= 0,
    // 没有文字时按「图在前」处理；文字先出现才算「词在上、图在下」
    imgFirst: !(firstTxt >= 0 && (firstImg < 0 || firstTxt < firstImg))
  };
}

/**
 * 把 body 展开成有序块序列：{ type:'image', rIds } 或 { type:'text', text }
 *
 * 注意：**一个段落里可能同时有图片和文字**（inline 图 + 紧随其后的提示词段落文字），
 * 必须按 run 顺序分别产出 image / text 两个块，不能「有图就整段当图、把文字丢掉」——
 * 那正是「明明图下面有提示词却识别不到」的根因。
 *
 * @param {string} xmlText word/document.xml 的文本
 */
function flattenBlocks(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parserError = doc.getElementsByTagName('parsererror');
  if (parserError.length) throw new Error('document.xml 解析失败');

  const body = doc.getElementsByTagNameNS(NS_W, 'body')[0];
  if (!body) throw new Error('docx 正文为空');

  const blocks = [];

  const handleParagraph = (node) => {
    const rIds = paragraphImageIds(node);
    const text = paragraphText(node);
    const order = paragraphOrder(node);

    if (rIds.length && text) {
      // 图文同段：按 run 顺序决定先后
      if (order.imgFirst) {
        blocks.push({ type: 'image', rIds });
        blocks.push({ type: 'text', text });
      } else {
        blocks.push({ type: 'text', text });
        blocks.push({ type: 'image', rIds });
      }
      return;
    }
    if (rIds.length) blocks.push({ type: 'image', rIds });
    else if (text) blocks.push({ type: 'text', text });
  };

  const visit = (container) => {
    for (const node of container.children) {
      const local = node.localName;
      if (local === 'p') {
        handleParagraph(node);
      } else if (local === 'tbl') {
        // 表格里也可能放图和词，逐行逐格递归
        visit(node);
      }
    }
  };

  visit(body);
  return blocks;
}

/* ------------------------------------------------------------ 配对 */

/** 判断段落是否是链接 / 推广引导语（不应作为提示词） */
function isLinkParagraph(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^[👉👇]/.test(t)) return true;
  if (/https?:\/\//i.test(t) && t.length < 300) return true;
  if (/^(海外|国内)\s*[（(]/.test(t) && /https?:\/\//i.test(t)) return true;
  return false;
}

/**
 * 图片块 → 收集其后到下一组图之前的文本段落，拼成提示词。
 *
 * 关键点：**连续的图片视为同一组**，共用同一段提示词。
 * 真实文档里常见「同一提示词生成多张图」，几张图在 Word 里紧挨着排列、
 * 中间不插文本；如果按「一张图一段词」硬配，后面几张就会配不到。
 * 遇到链接段落即停止收集，避免把结尾推广区吞进最后一张图的提示词。
 *
 * @param {Array} blocks flattenBlocks 的输出
 * @returns {Array<{rIds:string[], prompt:string, shared:boolean}>} shared 表示该组含多张图
 */
function pairBlocks(blocks) {
  const groups = [];
  let current = null;

  for (const block of blocks) {
    if (block.type === 'image') {
      // 上一组还没被文本"关闭"→ 说明这几张图是连续的，并入同一组
      if (current && current.open) {
        current.rIds.push(...block.rIds);
        continue;
      }
      current = { rIds: [...block.rIds], texts: [], open: true };
      groups.push(current);
      continue;
    }

    if (!current) continue;
    current.open = false; // 出现文本，图片组到此结束
    if (isLinkParagraph(block.text)) {
      current = null; // 进入链接区，后续文本不再归属任何图片
      continue;
    }
    current.texts.push(block.text);
  }

  return groups.map((g) => ({
    rIds: g.rIds,
    prompt: g.texts.join('\n').trim(),
    shared: g.rIds.length > 1
  }));
}

/* ---------------------------------------------------------- 对外入口 */

/**
 * 解析 docx 的正文结构，只解压 document.xml 与 rels，**不碰图片**。
 * 返回的 items 是「图片路径 + 提示词」的配对清单，图片内容按需再取。
 *
 * @param {File} file
 * @returns {Promise<{dir: Map, items: Array<{name:string, path:string, prompt:string}>}>}
 */
export async function parseDocxStructure(file) {
  if (!file) throw new Error('没有选择文件');

  const dir = await readZipDirectory(file);

  const docEntry = dir.get('word/document.xml');
  if (!docEntry) throw new Error('docx 缺少 word/document.xml');

  const relsEntry = dir.get('word/_rels/document.xml.rels');
  const decoder = new TextDecoder('utf-8');

  const docXml = decoder.decode(await readZipEntry(file, docEntry));
  const rels = relsEntry ? parseRelations(decoder.decode(await readZipEntry(file, relsEntry))) : new Map();

  const groups = pairBlocks(flattenBlocks(docXml));

  const items = [];
  for (const group of groups) {
    for (const rId of group.rIds) {
      const path = rels.get(rId);
      if (!path || !dir.get(path)) continue;
      const base = path.split('/').pop() || 'image';
      items.push({
        name: base.replace(/\.[^.]+$/, ''),
        path,
        prompt: group.prompt,
        // 同一组里有几张图（>1 说明是连续排列、共用这段提示词）
        groupSize: group.rIds.length
      });
    }
  }
  return { dir, items };
}

/** 由包内路径推断 MIME */
function mimeOf(path) {
  const ext = String(path || '').split('.').pop().toLowerCase();
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif'
  }[ext] || 'application/octet-stream';
}

/**
 * 按需解压单张图片。
 * @param {File} file
 * @param {Map} dir parseDocxStructure 返回的目录
 * @param {string} path 包内路径
 * @returns {Promise<Blob>}
 */
export async function loadDocxImage(file, dir, path) {
  const entry = dir.get(path);
  if (!entry) throw new Error(`docx 中找不到图片：${path}`);
  const bytes = await readZipEntry(file, entry);
  return new Blob([bytes], { type: mimeOf(path) });
}

/** 判断文件是否是 docx（老的 .doc 二进制格式不支持） */
export function isDocxFile(file) {
  if (!file) return false;
  return /\.docx$/i.test(file.name || '');
}
