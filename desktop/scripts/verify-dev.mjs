const WS_URL = process.argv[2];
if (!WS_URL) {
  console.error('用法：node verify-dev.mjs <ws://...>');
  process.exit(1);
}

const logs = [];
const exceptions = [];
const results = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const ws = new WebSocket(WS_URL);
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    id++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.onopen = async () => {
  try {
    await send('Runtime.enable');
    await send('Log.enable');

    // 等待页面脚本初始化完成
    await sleep(2000);

    const title = await send('Runtime.evaluate', { expression: 'document.title' });
    results.push({ name: 'document.title', value: title.result.value });

    const desktop = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.promptvaultDesktop || null)' });
    results.push({ name: 'promptvaultDesktop', value: JSON.parse(desktop.result.value) });

    const ua = await send('Runtime.evaluate', { expression: 'navigator.userAgent' });
    results.push({ name: 'userAgent', value: ua.result.value });

    // 查询 IndexedDB 里的分类数量
    const idbExpr = `
      (async () => {
        try {
          const dbs = await indexedDB.databases();
          const dbInfo = dbs.find(d => d.name === 'promptvault');
          if (!dbInfo) return JSON.stringify({ error: 'no promptvault db' });
          return new Promise((resolve) => {
            const req = indexedDB.open('promptvault');
            req.onsuccess = () => {
              const db = req.result;
              const tx = db.transaction('categories', 'readonly');
              const store = tx.objectStore('categories');
              const countReq = store.count();
              countReq.onsuccess = () => resolve(JSON.stringify({ categoriesCount: countReq.result }));
              countReq.onerror = () => resolve(JSON.stringify({ error: countReq.error?.message }));
            };
            req.onerror = () => resolve(JSON.stringify({ error: req.error?.message }));
          });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `;
    const idb = await send('Runtime.evaluate', { expression: idbExpr, awaitPromise: true });
    results.push({ name: 'indexedDB.categories', value: JSON.parse(idb.result.value) });

    // 再留 3 秒收集 console/异常
    await sleep(3000);

    console.log('=== 验证结果 ===');
    for (const r of results) {
      console.log(`${r.name}: ${typeof r.value === 'object' ? JSON.stringify(r.value) : r.value}`);
    }
    console.log(`console 日志数: ${logs.length}`);
    for (const l of logs) console.log('  LOG:', JSON.stringify(l));
    console.log(`未捕获异常数: ${exceptions.length}`);
    for (const e of exceptions) console.log('  ERR:', JSON.stringify(e));

    const ok = exceptions.length === 0 &&
      results.find(r => r.name === 'document.title').value &&
      results.find(r => r.name === 'promptvaultDesktop').value?.isDesktop === true;
    console.log(ok ? '\nDEV_VERIFY: PASS' : '\nDEV_VERIFY: FAIL');
  } catch (err) {
    console.error('验证脚本异常', err);
  } finally {
    ws.close();
  }
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push({ type: msg.params.type, args: msg.params.args.map(a => a.value || a.description) });
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push({ text: msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text });
  }
};

ws.onerror = (err) => {
  console.error('WebSocket 错误', err.message);
};
