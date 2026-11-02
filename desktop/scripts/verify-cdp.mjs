#!/usr/bin/env node
/* =========================================================================
 * scripts/verify-cdp.mjs —— 通过 Chrome DevTools Protocol 做端到端验证
 *
 * 用法示例：
 *   开发版：
 *     node scripts/verify-cdp.mjs --mode dev --png ../qa-smoke.png --user-data ./.verify-data
 *   打包版（portable exe）：
 *     node scripts/verify-cdp.mjs --bin dist/PromptVault-1.0.0-portable.exe \
 *          --user-data ./.verify-data
 *
 * 断言并输出（stdout 最后一行以 RESULT_JSON: 前缀）：
 *   - 页面 URL 以 app://local/ 开头
 *   - 页面标题
 *   - 控制台错误 / 未捕获异常数量
 *   - IndexedDB promptvault 库存在，一级分类 6 + 二级分类 39 = 45
 *   - 可选：导入一张真实 PNG 并断言卡片渲染
 *   - 可选：断言图片总数
 * ========================================================================= */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..');

/* --------------------------------------------------------------- 参数解析 */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const MODE = args.mode === 'packaged' || args.bin ? 'packaged' : 'dev';
const PORT = String(args.port || 9333);
const PNG_PATH = args.png ? path.resolve(args.png) : null;
const USER_DATA = args['user-data'] ? path.resolve(args['user-data']) : null;
const BIN = args.bin ? path.resolve(args.bin) : null;
const EXPECT_IMAGES = args['expect-images'] !== undefined ? Number(args['expect-images']) : null;
const TOTAL_TIMEOUT = Number(args.timeout || 90000);

/* ----------------------------------------------------------------- 工具 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) {
  console.error('[verify-cdp]', ...a);
}

function killTree(pid) {
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (_) {
    try { process.kill(pid); } catch (__) { /* ignore */ }
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

/* --------------------------------------------------------- CDP 客户端 */

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.listeners = new Set();
    this.closed = false;
  }

  attach() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败: ' + (e.message || 'unknown'))));
      this.ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(JSON.stringify(msg.error)));
          else res(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
          for (const fn of this.listeners) {
            try { fn(msg); } catch (_) { /* ignore */ }
          }
        }
      });
      this.ws.addEventListener('close', () => { this.closed = true; });
    });
  }

  onEvent(fn) { this.listeners.add(fn); }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true
    });
    if (res && res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error('页面求值异常: ' + text);
    }
    return res && res.result ? res.result.value : undefined;
  }

  close() {
    try { this.ws.close(); } catch (_) { /* ignore */ }
  }
}

/* ------------------------------------------------------------ 主流程 */

async function main() {
  const port = PORT;
  const launchArgs = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'];
  // 在当前受限/无 GPU 的执行环境下，硬件加速会导致 GPU 进程反复崩溃
  if (process.env.PV_KEEP_GPU !== '1') {
    launchArgs.push('--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer');
  }
  if (USER_DATA) {
    launchArgs.push(`--pv-user-data=${USER_DATA}`);
  }

  let child;
  // 关键：清理会改变 Electron 启动模式的环境变量
  //  - ELECTRON_RUN_AS_NODE：置为任何值（含空串）都会让 electron 以纯 Node 运行，
  //    从而导致 require('electron') 拿不到 app，主进程直接崩溃；
  //  - NODE_OPTIONS：外部注入的 --require 钩子可能干扰启动。
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;

  if (MODE === 'packaged') {
    if (!BIN || !fs.existsSync(BIN)) {
      throw new Error('打包版可执行文件不存在：' + (BIN || '(未提供 --bin)'));
    }
    child = spawn(BIN, launchArgs, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
  } else {
    const electronPath = require('electron');
    child = spawn(electronPath, ['.', ...launchArgs], { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
  }

  child.stdout.on('data', (d) => process.stderr.write('[app] ' + d.toString()));
  child.stderr.on('data', (d) => process.stderr.write('[app-err] ' + d.toString()));
  child.on('exit', (code) => log('应用进程退出，code =', code));

  const errors = [];
  let client = null;

  try {
    // 1. 等待调试端口就绪并拿到 page target
    const deadline = Date.now() + TOTAL_TIMEOUT;
    let target = null;
    while (Date.now() < deadline) {
      try {
        const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
        target = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch (_) { /* 尚未就绪 */ }
      await sleep(400);
    }
    if (!target) throw new Error('超时：未能获取到 CDP page target');

    // 2. 连接
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.attach();

    // 3. 采集控制台错误 / 异常
    client.onEvent((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        errors.push('console.error: ' + text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
        errors.push('uncaught: ' + text);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry && msg.params.entry.level === 'error') {
        errors.push('log: ' + msg.params.entry.text + ' @ ' + (msg.params.entry.url || ''));
      }
    });

    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await client.send('Page.enable');
    await client.send('Page.setLifecycleEventsEnabled', { enabled: true });

    // 4. 重新加载一次，确保捕获完整的启动过程错误
    const loadPromise = new Promise((resolve) => {
      const t = setTimeout(resolve, 15000);
      client.onEvent((msg) => {
        if (msg.method === 'Page.loadEventFired') { clearTimeout(t); resolve(); }
      });
    });
    await client.send('Page.reload', { ignoreCache: true });
    await loadPromise;

    // 5. 等待应用就绪
    let ready = false;
    while (Date.now() < deadline) {
      try {
        ready = await client.evaluate('!!(window.PromptVault && window.PromptVault.store && window.PromptVault.store.state && window.PromptVault.store.state.ready)');
      } catch (_) { ready = false; }
      if (ready) break;
      await sleep(300);
    }
    if (!ready) throw new Error('超时：应用 store 未就绪');

    // 6. 基础信息
    const href = await client.evaluate('location.href');
    const title = await client.evaluate('document.title');

    // 7. IndexedDB 与分类断言
    const dbInfo = await client.evaluate(`(async () => {
      const countStore = (db, store) => new Promise((res, rej) => {
        const tx = db.transaction(store, 'readonly');
        const rq = tx.objectStore(store).getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      });
      const openDb = () => new Promise((res, rej) => {
        const rq = indexedDB.open('promptvault');
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      const names = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [];
      const db = await openDb();
      const idbCategories = await countStore(db, 'categories');
      const idbImages = await countStore(db, 'images');
      const st = window.PromptVault.store.state;
      return {
        dbNames: names,
        hasPromptvaultDb: names.includes('promptvault'),
        idb: {
          categories: idbCategories.length,
          l1: idbCategories.filter((c) => c.level === 1).length,
          l2: idbCategories.filter((c) => c.level === 2).length,
          images: idbImages.length
        },
        state: {
          categories: st.categories.length,
          l1: st.categories.filter((c) => c.level === 1).length,
          l2: st.categories.filter((c) => c.level === 2).length,
          images: st.images.length,
          memoryMode: st.memoryMode
        }
      };
    })()`);

    // 8. 可选：导入一张真实 PNG
    let importResult = null;
    if (PNG_PATH) {
      if (!fs.existsSync(PNG_PATH)) throw new Error('PNG 文件不存在：' + PNG_PATH);
      const b64 = fs.readFileSync(PNG_PATH).toString('base64');
      const expression = `(async () => {
        const bin = atob(${JSON.stringify(b64)});
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const blob = new Blob([arr], { type: 'image/png' });
        const now = Date.now();
        const id = 'qa-' + now + '-' + Math.random().toString(36).slice(2, 8);
        const rec = {
          id, name: 'QA-导入测试图', blob, thumb: blob, mime: 'image/png',
          width: 128, height: 128, size: blob.size, positive: 'qa', negative: '',
          params: '', categoryId: null, subCategoryId: null, tags: ['qa'],
          favorite: false, note: '', hash: '', createdAt: now, updatedAt: now
        };
        await window.PromptVault.store.bulkAddImages([rec]);
        await new Promise((r) => setTimeout(r, 120));
        return {
          images: window.PromptVault.store.state.images.length,
          cards: document.querySelectorAll('.card[data-id]').length,
          importedId: id,
          pngBytes: blob.size
        };
      })()`;
      importResult = await client.evaluate(expression);
    }

    // 9. 可选：断言图片总数
    if (EXPECT_IMAGES !== null) {
      const finalCount = await client.evaluate('window.PromptVault.store.state.images.length');
      if (Number(finalCount) !== EXPECT_IMAGES) {
        throw new Error(`图片总数不符：期望 ${EXPECT_IMAGES}，实际 ${finalCount}`);
      }
    }

    // 10. 汇总
    const result = {
      mode: MODE,
      bin: MODE === 'packaged' ? BIN : 'electron(dev)',
      href,
      title,
      urlOk: typeof href === 'string' && href.startsWith('app://local/'),
      errorCount: errors.length,
      errors: errors.slice(0, 20),
      dbInfo,
      importResult,
      pass: false
    };

    result.pass =
      result.urlOk &&
      errors.length === 0 &&
      dbInfo.hasPromptvaultDb &&
      dbInfo.idb.l1 === 6 &&
      dbInfo.idb.l2 === 39 &&
      dbInfo.state.memoryMode === false &&
      (!importResult || importResult.cards >= 1);

    console.log('RESULT_JSON:' + JSON.stringify(result));
    return result.pass ? 0 : 2;
  } finally {
    if (client) client.close();
    if (!args['keep-open']) {
      killTree(child.pid);
    }
  }
}

main()
  .then((code) => {
    // 给 taskkill 一点时间
    setTimeout(() => process.exit(code), 800);
  })
  .catch((err) => {
    console.log('RESULT_JSON:' + JSON.stringify({ pass: false, fatal: String(err && err.stack || err) }));
    setTimeout(() => process.exit(3), 300);
  });
