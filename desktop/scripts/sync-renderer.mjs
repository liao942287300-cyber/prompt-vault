import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
// 桌面版放在网页版仓库的 desktop/ 子目录下，渲染层源码就在上一级
const sourceRoot = path.resolve(projectRoot, '..');
const targetRoot = path.resolve(projectRoot, 'renderer');

const copyList = [
  'index.html',
  'css/styles.css',
  'js/utils.js',
  'js/db.js',
  'js/store.js',
  'js/bridge.js',
  'js/main.js',
  'js/png-meta.js',
  'js/docx-import.js',
  'js/auto-classify.js',
  'js/civitai.js',
  'js/views/sidebar.js',
  'js/views/gallery.js',
  'js/views/detail.js',
  'js/views/manager.js',
  'js/views/transfer.js',
  'js/views/loras.js',
  'js/views/edits.js',
  'js/views/assets.js',
  'js/views/prompts.js'
];

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function sync() {
  if (!existsSync(sourceRoot)) {
    throw new Error(`渲染层源目录不存在：${sourceRoot}`);
  }

  // 确保目标目录存在（不递归删除旧目录，避免沙箱批量删除守卫拦截）
  await fs.mkdir(targetRoot, { recursive: true });

  // 清理渲染层根目录下可能存在的旧文件（只删直接文件，不递归删子目录）
  try {
    const entries = await fs.readdir(targetRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        await fs.rm(path.join(targetRoot, entry.name), { force: true });
      }
    }
  } catch {
    // 目录不存在时忽略
  }

  let fileCount = 0;
  let totalBytes = 0;

  for (const rel of copyList) {
    const src = path.join(sourceRoot, rel);
    const dst = path.join(targetRoot, rel);
    if (!existsSync(src)) {
      throw new Error(`源文件缺失：${src}`);
    }
    await ensureDir(dst);
    const data = await fs.readFile(src);
    await fs.writeFile(dst, data);
    fileCount++;
    totalBytes += data.length;
  }

  // 写 package.json 让 node --check 把 .js 当 ES Module 解析
  const pkg = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  await fs.writeFile(
    path.join(targetRoot, 'package.json'),
    JSON.stringify({ name: pkg.name, private: true, type: 'module' }, null, 2)
  );

  // 语法检查
  const jsFiles = copyList.filter(f => f.endsWith('.js')).map(f => path.join(targetRoot, f));
  const node = process.execPath;
  for (const f of jsFiles) {
    const proc = await new Promise((resolve) => {
      import('node:child_process').then(cp => {
        const p = cp.spawn(node, ['--check', f], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        p.stdout.on('data', d => out += d);
        p.stderr.on('data', d => err += d);
        p.on('close', code => resolve({ code, out, err }));
      });
    });
    if (proc.code !== 0) {
      throw new Error(`语法检查失败：${f}\n${proc.err || proc.out}`);
    }
  }

  console.log(`渲染层同步完成：${fileCount} 个文件，${totalBytes} 字节`);
}

sync().catch(err => {
  console.error(err.message);
  process.exit(1);
});
