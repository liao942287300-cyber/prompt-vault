/* =========================================================================
 * desktop/bridge-server.js —— 本地数据桥（主进程 HTTP 服务）
 *
 * 为什么需要它：
 *   PromptVault 的数据存在**渲染进程的 IndexedDB** 里，主进程读不到。
 *   所以这里只做「HTTP 网关」：收到请求 → 通过 webContents.executeJavaScript
 *   调渲染层的 window.PV_API → 把结果序列化成 JSON / 二进制写回响应。
 *
 * 安全约束（刻意为之）：
 *   1. 只监听 127.0.0.1（回环），外网访问不到；
 *   2. 不返回 Access-Control-Allow-Origin —— 浏览器网页读不到响应，
 *      而 Python(urllib/requests) 这类非浏览器客户端不受 CORS 限制；
 *   3. 校验 Host 头（防 DNS rebinding）、校验 Origin（只放行应用自身）；
 *   4. 只接受 GET，其余方法一律 405；无请求体解析，避免被塞大 body。
 *
 * 端口策略：
 *   8765 起依次尝试到 8775；全部被占用时只打日志、不影响应用启动
 *   （绝对不能因为端口占用让 PromptVault 打不开）。
 *   实际端口写入 <userData>/bridge-port.txt（纯文本一行），供 ComfyUI 节点发现。
 * ========================================================================= */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/** 对外标识 */
const APP_NAME = 'PromptVault';
/** 只绑回环地址，绝不能绑 0.0.0.0 */
const HOST = '127.0.0.1';
/** 端口尝试区间（闭区间） */
const PORT_MIN = 8765;
const PORT_MAX = 8775;
/** 端口发现文件名（写在 userData 目录下） */
const PORT_FILE_NAME = 'bridge-port.txt';

/** 允许的 Host 主机名（只接受回环） */
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** 允许的 Origin 前缀：只放行应用自身的自定义协议 */
const ALLOWED_ORIGIN_PREFIXES = ['app://local', 'file://'];

/** 调用渲染层的重试间隔（毫秒）。总时长约 9s，覆盖应用冷启动窗口期 */
const RETRY_DELAYS = [50, 100, 150, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1000, 1000, 1000];

/** 渲染层方法名白名单，避免拼出奇怪的调用 */
const RENDERER_METHODS = new Set([
  'getHealth',
  'getCategories',
  'getItems',
  'getImageBase64',
  'getText',
  'getAssets',
  'getAssetImageBase64'
]);

/* ------------------------------------------------------------ 模块级状态 */

/** @type {import('node:http').Server|null} */
let server = null;
/** 实际监听端口，0 表示未启动 */
let activePort = 0;
/** 端口文件绝对路径 */
let portFilePath = '';
/** 启动中的 Promise（并发调用复用同一个） */
let startPromise = null;
/** 日志器 */
let logger = console;

/* ------------------------------------------------------------ 小工具 */

/** 等待若干毫秒 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** 把任意错误转成可读文本 */
function errorMessage(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  return String(err);
}

/** 计数归一化：非法值一律 0 */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 字符串归一化 */
function toText(value) {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * 非负整数归一化（用于 total / width 等「0 有意义」的字段）。
 * 与 toCount 的区别：非法值返回 fallback，而不是一律 0。
 * @param {any} value
 * @param {number} fallback
 * @returns {number}
 */
function toNonNegativeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * 解析 `?ids=a,b,c` 形式的批量 id 参数。
 *
 * 返回 null 表示「请求里根本没有 ids 参数」—— 这个区分很关键：
 * 没有 ids 走分页查询，有 ids（哪怕是空串）走按 id 批量取。
 * 空串时返回 []，于是调用方拿到 {total:0, items:[], missing:[]}，
 * 比「悄悄退回全量查询」更可预期。
 *
 * @param {URL} url
 * @returns {string[]|null}
 */
function parseIdList(url) {
  if (!url.searchParams.has('ids')) return null;
  const raw = toText(url.searchParams.get('ids'));
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * 校验 Host 头，防 DNS rebinding。
 * 缺省 Host（HTTP/1.0）放行——浏览器一定会带 Host。
 * @param {string|undefined} hostHeader
 * @returns {boolean}
 */
function isAllowedHost(hostHeader) {
  if (!hostHeader) return true;
  const host = String(hostHeader).trim().toLowerCase();
  let name = host;
  if (host.startsWith('[')) {
    // IPv6：[::1]:8765
    const end = host.indexOf(']');
    name = end >= 0 ? host.slice(0, end + 1) : host;
  } else {
    const idx = host.lastIndexOf(':');
    if (idx >= 0) name = host.slice(0, idx);
  }
  return ALLOWED_HOSTNAMES.has(name);
}

/**
 * 校验 Origin 头：没有 Origin 的请求（Python 客户端）放行；
 * 有 Origin 时只接受应用自身（app://local）。
 * @param {string|undefined} origin
 * @returns {boolean}
 */
function isAllowedOrigin(origin) {
  if (!origin) return true;
  const value = String(origin).trim().toLowerCase();
  if (!value || value === 'null') return false;
  return ALLOWED_ORIGIN_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** 发送 JSON 响应 */
function sendJson(res, statusCode, body) {
  if (!res || res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

/** 发送二进制响应 */
function sendBinary(res, statusCode, buffer, contentType) {
  if (!res || res.writableEnded) return;
  res.writeHead(statusCode, {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(buffer);
}

/**
 * 从二进制头嗅探图片格式，兜底 mime 缺失 / 为 image/* 的情况。
 * @param {Buffer} buffer
 * @returns {string} 形如 image/png
 */
function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return '';
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // WEBP: "RIFF" .... "WEBP"
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  // GIF: "GIF8"
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  // BMP: "BM"
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  return '';
}

/**
 * 决定响应用的 Content-Type：优先用渲染层给的 mime，
 * 不可信（空 / image/* / octet-stream）时按内容嗅探，最后退回 image/png。
 * @param {string} mime
 * @param {Buffer} buffer
 * @returns {string}
 */
function resolveImageMime(mime, buffer) {
  const raw = toText(mime).trim().toLowerCase();
  const usable = raw.startsWith('image/') && raw !== 'image/*' && raw !== 'image/';
  if (usable) return raw === 'image/jpg' ? 'image/jpeg' : raw;
  const sniffed = sniffImageMime(buffer);
  if (sniffed) return sniffed;
  return 'image/png';
}

/* ------------------------------------------------------ 调用渲染进程 */

/** 该错误是否值得重试（页面还没加载完 / PV_API 还没挂上） */
function isRetryableError(err) {
  const message = errorMessage(err);
  return /PV_API_NOT_READY|Script failed to execute|Render frame was disposed|Execution context was destroyed|Object has been destroyed|Cannot read propert|is not a function|Target closed|WebContents is destroyed/i
    .test(message);
}

/**
 * 拼出要在渲染进程执行的表达式。
 *
 * 关键：参数一律 JSON.stringify 后拼进字符串，**绝不手拼引号**，
 * 这样搜索词里带引号 / 反斜杠 / 换行也不会破坏表达式。
 *
 * @param {string} method PV_API 上的方法名
 * @param {object} arg 传给方法的参数对象
 * @returns {string}
 */
function buildExpression(method, arg) {
  const payload = JSON.stringify(arg === undefined || arg === null ? {} : arg);
  return `(() => {
    const api = window.PV_API;
    if (!api || typeof api.${method} !== 'function') {
      return Promise.reject(new Error('PV_API_NOT_READY'));
    }
    return api.${method}(${payload});
  })()`;
}

/**
 * 在渲染进程里调用 PV_API 的某个方法，返回其 JSON 化结果。
 *
 * 应用刚启动时 window.PV_API 可能还没挂上，这里带重试；
 * 窗口被销毁 / 页面重载中途等瞬时错误也会重试。
 *
 * @param {() => any} getWindow 返回当前 BrowserWindow 的函数
 * @param {string} method 方法名（必须在白名单里）
 * @param {object} arg 参数对象
 * @returns {Promise<any>}
 */
async function callRenderer(getWindow, method, arg) {
  if (!RENDERER_METHODS.has(method)) {
    throw new Error(`非法的渲染层方法：${method}`);
  }

  let lastError = null;
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt += 1) {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    const alive = win && typeof win.isDestroyed === 'function' ? !win.isDestroyed() : Boolean(win);

    if (alive) {
      const contents = win.webContents;
      if (contents && typeof contents.isDestroyed === 'function' && !contents.isDestroyed()) {
        try {
          const result = await contents.executeJavaScript(buildExpression(method, arg), true);
          return result;
        } catch (err) {
          lastError = err;
          if (!isRetryableError(err)) throw err;
        }
      } else {
        lastError = new Error('渲染进程不可用');
      }
    } else {
      lastError = new Error('PromptVault 窗口尚未就绪');
    }

    if (attempt < RETRY_DELAYS.length - 1) {
      await delay(RETRY_DELAYS[attempt]);
    }
  }

  throw lastError || new Error('渲染进程无响应');
}

/* ------------------------------------------------------------ 路由处理 */

/** 所有对外接口的说明，挂在根路径上方便人工排查 */
function describeEndpoints() {
  return {
    ok: true,
    app: APP_NAME,
    port: activePort,
    endpoints: [
      'GET /api/health',
      'GET /api/ping',
      'GET /api/categories',
      'GET /api/items?type=images&category=<id>&includeChildren=1&search=<kw>&ids=<id,id>',
      'GET /api/image?id=<id>&size=full|thumb',
      'GET /api/text?type=loras|edits|system-prompts',
      'GET /api/assets?category=<name>&project=<name|__none__>&q=<kw>&limit=<n>&offset=<n>',
      'GET /api/assets?ids=<id,id>',
      'GET /api/asset-image?id=<id>&size=thumb|full'
    ]
  };
}

/** 处理 /api/health */
async function handleHealth(ctx, res) {
  const data = await callRenderer(ctx.getWindow, 'getHealth', {});
  const counts = (data && typeof data === 'object' && data.counts) ? data.counts : {};
  sendJson(res, 200, {
    ok: true,
    app: APP_NAME,
    version: ctx.version,
    counts: {
      images: toCount(counts.images),
      categories: toCount(counts.categories),
      loras: toCount(counts.loras),
      edits: toCount(counts.edits),
      assets: toCount(counts.assets),
      systemPrompts: toCount(counts.systemPrompts)
    }
  });
}

/** 处理 /api/categories */
async function handleCategories(ctx, res) {
  const data = await callRenderer(ctx.getWindow, 'getCategories', {});
  const raw = Array.isArray(data) ? data : (data && Array.isArray(data.categories) ? data.categories : []);
  const categories = raw.map((c) => ({
    id: toText(c && c.id),
    name: toText(c && c.name),
    level: Number(c && c.level) === 2 ? 2 : 1,
    parentId: c && c.parentId !== null && c.parentId !== undefined ? toText(c.parentId) : null,
    order: Number(c && c.order) || 0
  }));
  sendJson(res, 200, { ok: true, categories });
}

/** 处理 /api/items */
async function handleItems(ctx, url, res) {
  const type = (url.searchParams.get('type') || 'images').toLowerCase();
  if (type !== 'images' && type !== 'image') {
    sendJson(res, 400, { ok: false, error: `不支持的 type：${type}（当前仅支持 images）` });
    return;
  }

  const category = url.searchParams.get('category') || '';
  const search = url.searchParams.get('search') || '';
  const rawChildren = (url.searchParams.get('includeChildren') || '').toLowerCase();
  const includeChildren = rawChildren === '1' || rawChildren === 'true' || rawChildren === 'yes';
  // null = 没传 ids（走原来的筛选路径）；数组 = 按 id 批量取
  const ids = parseIdList(url);

  const data = await callRenderer(ctx.getWindow, 'getItems', {
    type: 'images',
    category,
    includeChildren,
    search,
    ids
  });

  if (data && data.ok === false) {
    sendJson(res, 400, { ok: false, error: toText(data.error) || '查询失败' });
    return;
  }

  const items = Array.isArray(data && data.items) ? data.items : [];

  if (ids) {
    const missing = Array.isArray(data && data.missing) ? data.missing.map(toText) : [];
    sendJson(res, 200, { ok: true, total: items.length, items, missing });
    return;
  }

  sendJson(res, 200, { ok: true, total: items.length, items });
}

/**
 * 把渲染层返回的 {ok, mime, base64} 解码成二进制写回响应。
 * /api/image 与 /api/asset-image 共用，避免两份几乎相同的解码逻辑漂移。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {any} data 渲染层返回值
 * @param {string} id 请求的记录 id（仅用于错误文案）
 * @param {string} label 错误文案里的实体名，如 '图片' / '资产图'
 * @returns {boolean} 是否已写出响应
 */
function sendBase64Image(res, data, id, label) {
  const base64 = data && typeof data.base64 === 'string' ? data.base64 : '';

  if (!data || data.ok !== true || !base64) {
    sendJson(res, 404, {
      ok: false,
      error: toText(data && data.error) || `${label}不存在：${id}`
    });
    return true;
  }

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch (err) {
    sendJson(res, 500, { ok: false, error: `${label}解码失败：${errorMessage(err)}` });
    return true;
  }

  if (!buffer.length) {
    sendJson(res, 404, { ok: false, error: `${label}数据为空：${id}` });
    return true;
  }

  sendBinary(res, 200, buffer, resolveImageMime(data.mime, buffer));
  return true;
}

/** 处理 /api/image */
async function handleImage(ctx, url, res) {
  const id = toText(url.searchParams.get('id')).trim();
  if (!id) {
    sendJson(res, 400, { ok: false, error: '缺少 id 参数' });
    return;
  }

  const sizeParam = (url.searchParams.get('size') || 'full').toLowerCase();
  const size = sizeParam === 'thumb' ? 'thumb' : 'full';

  const data = await callRenderer(ctx.getWindow, 'getImageBase64', { id, size });
  sendBase64Image(res, data, id, '图片');
}

/**
 * 处理 /api/assets —— 资产图元数据列表（分页）。
 *
 * 刻意不返回 blob / thumb 的 base64：
 *   资产图原图常有 1~3MB，base64 再膨胀 ~33%。ComfyUI 侧要的是「精简列表」
 *   做分页缓存，一次几百条元数据也就几十 KB；把图片塞进来会让单次响应到
 *   上百 MB，跨进程克隆 + JSON 解析两边都会卡死。图片走 /api/asset-image 单张取。
 *
 * 分页在渲染层完成（数据在内存里，切片 O(1)），这里**不能再切一次**，
 * 否则 offset 会被应用两遍。
 */
async function handleAssets(ctx, url, res) {
  const category = toText(url.searchParams.get('category')).trim();
  const project = toText(url.searchParams.get('project')).trim();
  const q = toText(url.searchParams.get('q')).trim();
  // limit=0（或非法）= 不限
  const limit = toCount(url.searchParams.get('limit'));
  const offset = toCount(url.searchParams.get('offset'));
  // null = 没传 ids（走分页查询）；数组 = 按 id 批量取，其余筛选/分页参数由渲染层忽略
  const ids = parseIdList(url);

  const data = await callRenderer(ctx.getWindow, 'getAssets', {
    category,
    project,
    q,
    limit,
    offset,
    ids
  });

  if (data && data.ok === false) {
    sendJson(res, 400, { ok: false, error: toText(data.error) || '查询失败' });
    return;
  }

  const rawItems = Array.isArray(data && data.items) ? data.items : [];
  const items = rawItems.map((item) => ({
    id: toText(item && item.id),
    name: toText(item && item.name),
    category: toText(item && item.category),
    project: toText(item && item.project),
    note: toText(item && item.note),
    width: toNonNegativeInt(item && item.width, 0),
    height: toNonNegativeInt(item && item.height, 0),
    size: toNonNegativeInt(item && item.size, 0),
    mime: toText(item && item.mime),
    createdAt: toNonNegativeInt(item && item.createdAt, 0)
  }));

  // total 是「筛选后、分页前」的总数，调用方据此决定还要不要翻页
  const total = toNonNegativeInt(data && data.total, items.length);

  if (ids) {
    // 按 id 取时额外告诉调用方「哪些 id 在 PromptVault 里已经不存在了」，
    // 面板据此把卡片标灰而不是直接消失（工作流里还留着这些 id）
    const missing = Array.isArray(data && data.missing) ? data.missing.map(toText) : [];
    sendJson(res, 200, { ok: true, total, items, missing });
    return;
  }

  sendJson(res, 200, { ok: true, total, items });
}

/**
 * 处理 /api/asset-image —— 返回资产图原始字节。
 *
 * 与 /api/image 的差别：size 默认 thumb（资产图原图太大，节点侧预览基本只要缩略图）。
 */
async function handleAssetImage(ctx, url, res) {
  const id = toText(url.searchParams.get('id')).trim();
  if (!id) {
    sendJson(res, 400, { ok: false, error: '缺少 id 参数' });
    return;
  }

  const sizeParam = (url.searchParams.get('size') || 'thumb').toLowerCase();
  const size = sizeParam === 'full' ? 'full' : 'thumb';

  const data = await callRenderer(ctx.getWindow, 'getAssetImageBase64', { id, size });
  sendBase64Image(res, data, id, '资产图');
}

/** 处理 /api/text */
async function handleText(ctx, url, res) {
  const raw = (url.searchParams.get('type') || '').toLowerCase();
  const ALIASES = {
    loras: 'loras',
    lora: 'loras',
    edits: 'edits',
    edit: 'edits',
    'system-prompts': 'system-prompts',
    'system_prompts': 'system-prompts',
    systemprompts: 'system-prompts',
    prompts: 'system-prompts'
  };
  const type = ALIASES[raw];
  if (!type) {
    sendJson(res, 400, {
      ok: false,
      error: `不支持的 type：${raw || '(空)'}（可选 loras / edits / system-prompts）`
    });
    return;
  }

  const data = await callRenderer(ctx.getWindow, 'getText', { type });
  if (data && data.ok === false) {
    sendJson(res, 400, { ok: false, error: toText(data.error) || '查询失败' });
    return;
  }

  const items = Array.isArray(data && data.items) ? data.items : [];
  sendJson(res, 200, {
    ok: true,
    items: items.map((item) => ({
      id: toText(item && item.id),
      name: toText(item && item.name),
      text: toText(item && item.text)
    }))
  });
}

/**
 * 创建请求处理函数（闭包持有 getWindow / version，便于测试注入）。
 * @param {{getWindow:() => any, version: string}} ctx
 */
function createRequestHandler(ctx) {
  return async function handle(req, res) {
    const method = toText(req.method).toUpperCase();

    // 1) Host 校验（DNS rebinding）
    if (!isAllowedHost(req.headers.host)) {
      sendJson(res, 403, { ok: false, error: 'Host 不被允许' });
      return;
    }

    // 2) 只接受 GET（无 body，天然免疫大包攻击）
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, { ok: false, error: `不支持的方法：${method || '(空)'}，仅支持 GET` });
      return;
    }

    // 3) Origin 校验：浏览器网页（有跨源 Origin）一律拒绝
    if (!isAllowedOrigin(req.headers.origin)) {
      sendJson(res, 403, { ok: false, error: 'Origin 不被允许' });
      return;
    }

    // 4) 解析 URL
    let url;
    try {
      url = new URL(req.url || '/', `http://${HOST}:${activePort || PORT_MIN}`);
    } catch {
      sendJson(res, 400, { ok: false, error: '请求地址不合法' });
      return;
    }

    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    switch (pathname) {
      case '/':
        sendJson(res, 200, describeEndpoints());
        return;
      case '/api/health':
        await handleHealth(ctx, res);
        return;
      case '/api/ping':
        sendJson(res, 200, { ok: true, app: APP_NAME, version: ctx.version, port: activePort });
        return;
      case '/api/categories':
        await handleCategories(ctx, res);
        return;
      case '/api/items':
        await handleItems(ctx, url, res);
        return;
      case '/api/image':
        await handleImage(ctx, url, res);
        return;
      case '/api/text':
        await handleText(ctx, url, res);
        return;
      case '/api/assets':
        await handleAssets(ctx, url, res);
        return;
      case '/api/asset-image':
        await handleAssetImage(ctx, url, res);
        return;
      default:
        sendJson(res, 404, { ok: false, error: `未知接口：${pathname}` });
    }
  };
}

/* ------------------------------------------------------------ 端口绑定 */

/**
 * 在指定端口上 listen，失败时 reject（保留错误码）。
 * @param {import('node:http').Server} srv
 * @param {number} port
 * @returns {Promise<void>}
 */
function listenOn(srv, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      srv.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      srv.removeListener('error', onError);
      resolve();
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
    try {
      srv.listen(port, HOST);
    } catch (err) {
      srv.removeListener('error', onError);
      srv.removeListener('listening', onListening);
      reject(err);
    }
  });
}

/**
 * 写端口发现文件（纯文本一行端口号）。失败不影响服务本身。
 * @param {string} dataDir userData 目录
 * @param {number} port
 * @returns {string} 写入的绝对路径，失败返回空串
 */
function writePortFile(dataDir, port) {
  if (!dataDir) return '';
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, PORT_FILE_NAME);
    fs.writeFileSync(file, `${port}\n`, 'utf8');
    return file;
  } catch (err) {
    logger.error('[bridge] 写入端口文件失败（不影响服务）', err);
    return '';
  }
}

/** 删除端口文件 */
function removePortFile() {
  if (!portFilePath) return;
  try {
    fs.rmSync(portFilePath, { force: true });
  } catch (err) {
    logger.warn('[bridge] 删除端口文件失败', err);
  }
  portFilePath = '';
}

/* ------------------------------------------------------------ 生命周期 */

/**
 * 启动本地数据桥。
 *
 * 幂等：重复调用返回同一个实例信息。全部端口被占用时返回 null，
 * **不抛异常**，调用方（main.js）继续正常启动应用。
 *
 * @param {{getWindow:() => any, dataDir?: string, version?: string, logger?: Console}} options
 * @returns {Promise<{port:number, close:() => Promise<void>}|null>}
 */
function startBridgeServer(options = {}) {
  if (server) {
    return Promise.resolve({ port: activePort, close: stopBridgeServer });
  }
  if (startPromise) return startPromise;

  const ctx = {
    getWindow: typeof options.getWindow === 'function' ? options.getWindow : () => null,
    version: toText(options.version)
  };
  const dataDir = toText(options.dataDir);
  if (options.logger && typeof options.logger.error === 'function') logger = options.logger;

  startPromise = (async () => {
    const handle = createRequestHandler(ctx);
    const srv = http.createServer((req, res) => {
      Promise.resolve(handle(req, res)).catch((err) => {
        logger.error('[bridge] 请求处理失败', err);
        try {
          sendJson(res, 500, { ok: false, error: errorMessage(err) });
        } catch {
          try { res.destroy(); } catch { /* 忽略 */ }
        }
      });
    });

    // 只做 GET，不需要长连接；短超时避免残留连接
    srv.keepAliveTimeout = 5000;
    srv.headersTimeout = 10000;
    srv.requestTimeout = 20000;

    srv.on('clientError', (err, socket) => {
      if (socket && socket.writable) {
        try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* 忽略 */ }
      } else if (socket) {
        try { socket.destroy(); } catch { /* 忽略 */ }
      }
      logger.warn('[bridge] 客户端连接异常', errorMessage(err));
    });

    srv.on('error', (err) => {
      // 监听阶段的 EADDRINUSE/EACCES 由 listenOn 的 once('error') 处理（会继续试下一个端口），
      // 这里只兜运行期错误，避免启动时刷一堆无意义的堆栈。
      const code = err && err.code ? err.code : '';
      if (code === 'EADDRINUSE' || code === 'EACCES') return;
      logger.error('[bridge] 服务错误', err);
    });

    for (let port = PORT_MIN; port <= PORT_MAX; port += 1) {
      try {
        await listenOn(srv, port);
        server = srv;
        activePort = port;
        break;
      } catch (err) {
        const code = err && err.code ? err.code : '';
        if (code === 'EADDRINUSE' || code === 'EACCES') {
          logger.warn(`[bridge] 端口 ${port} 不可用（${code}），尝试下一个`);
        } else {
          logger.error(`[bridge] 端口 ${port} 监听失败`, err);
        }
      }
    }

    if (!server) {
      logger.error(
        `[bridge] ${PORT_MIN}-${PORT_MAX} 全部端口不可用，本地数据服务未启动（应用继续正常运行）`
      );
      return null;
    }

    portFilePath = writePortFile(dataDir, activePort);
    logger.log(
      `[bridge] 本地数据服务已启动：http://${HOST}:${activePort}` +
      (portFilePath ? `（端口文件：${portFilePath}）` : '')
    );
    return { port: activePort, close: stopBridgeServer };
  })().catch((err) => {
    logger.error('[bridge] 启动异常，已跳过本地数据服务', err);
    return null;
  }).finally(() => {
    startPromise = null;
  });

  return startPromise;
}

/**
 * 停止本地数据桥并删除端口文件。幂等，可安全重复调用。
 * @returns {Promise<void>}
 */
function stopBridgeServer() {
  removePortFile();

  const srv = server;
  server = null;
  activePort = 0;
  if (!srv) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    try {
      srv.close(done);
      // 断开 keep-alive 连接，确保端口立即释放（否则 netstat 仍能看到）
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
      else if (typeof srv.closeIdleConnections === 'function') srv.closeIdleConnections();
    } catch (err) {
      logger.warn('[bridge] 关闭服务失败', err);
      done();
      return;
    }

    const timer = setTimeout(done, 1000);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** 当前端口（0 = 未启动） */
function getBridgePort() {
  return activePort;
}

module.exports = {
  startBridgeServer,
  stopBridgeServer,
  getBridgePort,
  PORT_MIN,
  PORT_MAX,
  PORT_FILE_NAME,
  HOST,
  // 供测试直接使用
  __internal: {
    isAllowedHost,
    isAllowedOrigin,
    sniffImageMime,
    resolveImageMime,
    buildExpression,
    createRequestHandler
  }
};
