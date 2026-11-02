import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const EXE = path.resolve(process.argv[2] || 'dist/PromptVault-1.0.0-portable.exe');
const EXE_DIR = path.dirname(EXE);
const DATA_DIR = path.join(EXE_DIR, 'PromptVaultData');
const DEBUG_PORT = 9333;
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

function findChromeDebugger() {
  // 通过 CDP HTTP 接口获取 webSocketDebuggerUrl
  return fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    .then(r => r.json())
    .then(j => j.webSocketDebuggerUrl)
    .catch(() => null);
}

let child = null;
let ws = null;

async function main() {
  console.log(`启动便携版：${EXE}`);
  console.log(`期望数据目录：${DATA_DIR}`);

  const env = { ...process.env, PROMPTVAULT_HEADLESS: '1' };

  child = spawn(EXE, [`--remote-debugging-port=${DEBUG_PORT}`, '--disable-gpu'], {
    env,
    detached: false,
    stdio: 'ignore'
  });

  child.on('error', e => console.error('启动失败', e.message));

  // 轮询等待 CDP 就绪
  let wsUrl = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    wsUrl = await findChromeDebugger();
    if (wsUrl) break;
    if (child.exitCode !== null) {
      console.error('进程在 CDP 就绪前退出，exitCode=', child.exitCode);
      process.exit(2);
    }
  }

  if (!wsUrl) {
    console.error('CDP 未在 30s 内就绪');
    child.kill('SIGKILL');
    process.exit(3);
  }

  console.log('CDP 就绪：', wsUrl);

  await new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => {
      id++;
      pending.set(id, { res, rej });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const logs = [];
    socket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id).res(msg.result); pending.delete(msg.id); }
      if (msg.method === 'Runtime.consoleAPICalled') {
        logs.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
      }
    };
    socket.onopen = async () => {
      try {
        await send('Runtime.enable');
        await sleep(3000);
        const title = await send('Runtime.evaluate', { expression: 'document.title' });
        console.log('页面标题：', title.result.value);
        const idb = await send('Runtime.evaluate', {
          expression: `(async () => {
            try {
              const dbs = await indexedDB.databases();
              if (!dbs.find(d => d.name === 'promptvault')) return JSON.stringify({ error: 'no promptvault db' });
              return new Promise(r => {
                const req = indexedDB.open('promptvault');
                req.onsuccess = () => {
                  const db = req.result;
                  const tx = db.transaction('categories', 'readonly');
                  tx.objectStore('categories').count().onsuccess = e => r(JSON.stringify({ categoriesCount: e.target.result }));
                };
                req.onerror = () => r(JSON.stringify({ error: req.error.message }));
              });
            } catch (e) { return JSON.stringify({ error: e.message }); }
          })()`,
          awaitPromise: true
        });
        console.log('IndexedDB：', idb.result.value);
        console.log('控制台日志：', logs.length ? logs.join(' | ') : '(无)');
        resolve();
      } catch (e) { reject(e); }
    };
    socket.onerror = (err) => reject(err);
  });

  // 给主进程一点时间创建数据目录
  await sleep(2000);

  console.log('\n=== 数据目录检查 ===');
  const dataExists = existsSync(DATA_DIR);
  console.log(`exe 同目录 PromptVaultData/ 存在: ${dataExists}`);
  if (dataExists) {
    const entries = readdirSync(DATA_DIR);
    console.log('其中包含：', entries.join(', ') || '(空)');
  }

  const appdataSub = path.join(APPDATA, 'promptvault-desktop');
  const appdataExists = existsSync(appdataSub);
  console.log(`${APPDATA}/promptvault-desktop 存在(应=false): ${appdataExists}`);

  const pass = dataExists && !appdataExists;
  console.log(pass ? '\nPORTABLE_VERIFY: PASS' : '\nPORTABLE_VERIFY: FAIL');

  try { if (ws) ws.close(); } catch {}
  try { child.kill('SIGKILL'); } catch {}
  process.exit(pass ? 0 : 4);
}

main().catch(e => { console.error(e); process.exit(5); });
