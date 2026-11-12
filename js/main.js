/* =========================================================================
 * js/main.js —— 应用引导：顶栏、视图切换、快捷键、拖拽导入
 * ========================================================================= */

import * as store from './store.js';
import { mountSidebar } from './views/sidebar.js';
import { mountGallery } from './views/gallery.js';
import { mountManager } from './views/manager.js';
import { mountDetail } from './views/detail.js';
import { mountTransfer } from './views/transfer.js';
import { mountLoras } from './views/loras.js';
import { mountEdits } from './views/edits.js';
import { mountAssets } from './views/assets.js';
import { mountPrompts } from './views/prompts.js';
import { $, icon, toast, isImageFile, hasModal } from './utils.js';

/* ------------------------------------------------------------------ 上下文 */

let detail = null;
let transfer = null;

/** 供各视图共享的应用上下文（延迟绑定，避免循环依赖） */
const ctx = {
  /** 打开详情弹窗 */
  openDetail(id, ids) { if (detail) detail.open(id, ids); },
  /** 详情弹窗是否打开 */
  isDetailOpen() { return detail ? detail.isOpen() : false; },
  /** 打开导入弹窗 */
  openImport() { if (transfer) transfer.openImport(); },
  /** 打开快速导入弹窗 */
  openQuickImport() { if (transfer) transfer.openQuickImport(); },
  /** 从 Civitai 链接导入 */
  openCivitaiImport() { if (transfer) transfer.openCivitaiImport(); },
  /** 打开导出弹窗 */
  openExport() { if (transfer) transfer.openExport(); }
};

/* ------------------------------------------------------------------ 顶栏 */

function decorateTopbar() {
  const sidebarBtn = $('#btn-sidebar');
  sidebarBtn.innerHTML = icon('menu', 18);

  const searchIcon = $('.search-icon');
  if (searchIcon) searchIcon.innerHTML = icon('search', 16);

  const clearBtn = $('#btn-search-clear');
  clearBtn.innerHTML = icon('close', 15);

  $('#view-switch [data-view="gallery"]').innerHTML = `${icon('grid', 15)}<span>图库</span>`;
  $('#view-switch [data-view="database"]').innerHTML = `${icon('table', 15)}<span>数据库</span>`;

  const importBtn = $('#btn-import');
  importBtn.innerHTML = `${icon('upload', 15)}<span>导入</span>`;

  const quickImportBtn = $('#btn-quick-import');
  if (quickImportBtn) {
    quickImportBtn.innerHTML = `${icon('plus', 15)}<span>快速导入</span>`;
    quickImportBtn.title = '粘贴一张图片并填写提示词，快速入库';
  }

  const civitaiBtn = $('#btn-civitai-import');
  if (civitaiBtn) {
    civitaiBtn.innerHTML = `${icon('link', 15)}<span>Civitai</span>`;
    civitaiBtn.title = '粘贴 Civitai 图片链接批量导入，连同生成参数一起入库';
  }

  const exportBtn = $('#btn-export');
  exportBtn.innerHTML = `${icon('download', 15)}<span>导出</span>`;

  updateThemeButton();
}

function updateThemeButton() {
  const btn = $('#btn-theme');
  const dark = store.state.settings.theme === 'dark';
  btn.innerHTML = dark ? icon('sun', 17) : icon('moon', 17);
  btn.title = dark ? '切换到浅色主题' : '切换到深色主题';
}

/* ------------------------------------------------------------------ 视图切换 */

/** 主视图 → 容器 id */
const VIEW_IDS = {
  gallery: '#view-gallery',
  database: '#view-database',
  loras: '#view-loras',
  edits: '#view-edits',
  assets: '#view-assets',
  prompts: '#view-prompts'
};

function applyView() {
  const current = store.state.view;
  Object.entries(VIEW_IDS).forEach(([key, selector]) => {
    const node = $(selector);
    if (node) node.hidden = key !== current;
  });
  // 顶栏「图库 / 数据库」切换：处于模块视图时两个都不激活
  document.querySelectorAll('#view-switch .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === current);
  });
}

/* ------------------------------------------------------------------ 侧栏折叠 */

function toggleSidebar() {
  const layout = $('#layout');
  layout.classList.toggle('sidebar-collapsed');
}

/* ------------------------------------------------------------------ 警告条 */

function renderWarnBar() {
  const bar = $('#warn-bar');
  if (!store.state.memoryMode) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = `${icon('alert', 16)}<span><strong>当前处于内存降级模式：</strong>` +
    '浏览器不允许使用 IndexedDB（常见于直接以 file:// 打开页面），本次导入的数据仅保存在内存中，' +
    '关闭或刷新页面后会丢失。请使用项目根目录下的 <strong>start.bat</strong>（Windows）或 ' +
    '<strong>start.sh</strong>（macOS / Linux）通过本地 HTTP 服务重新打开，即可正常持久化。</span>';
}

/* ------------------------------------------------------------------ 搜索 */

function bindSearch() {
  const input = $('#search-input');
  input.addEventListener('input', () => store.setSearch(input.value));
  input.addEventListener('search', () => store.setSearch(input.value));

  const clearBtn = $('#btn-search-clear');
  clearBtn.addEventListener('click', () => {
    input.value = '';
    store.setSearch('');
    input.focus();
  });
}

/** 聚焦搜索框 */
function focusSearch() {
  const input = $('#search-input');
  if (!input) return;
  input.focus();
  input.select();
}

/* ------------------------------------------------------------------ 快捷键 */

function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const tag = (active && active.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      || (active && active.isContentEditable);

    // '/' 或 Ctrl/Cmd + F 聚焦搜索
    if (!typing && e.key === '/') { e.preventDefault(); focusSearch(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); focusSearch(); }
  });
}

/* ------------------------------------------------------------------ 拖拽导入 */

function bindDragAndDrop() {
  const overlay = $('#drop-overlay');
  const target = $('#drop-target');
  let depth = 0;

  const hasFiles = (event) => {
    const dt = event.dataTransfer;
    if (!dt) return false;
    const types = dt.types ? Array.from(dt.types) : [];
    return types.includes('Files');
  };

  const show = () => { overlay.hidden = false; };
  const hide = () => {
    depth = 0;
    overlay.hidden = true;
    target?.classList.remove('is-over');
  };

  /* ------------------- 投放框：只有这里松手才导入 ------------------- */
  // 遮罩是 pointer-events:none（不挡鼠标），只有 #drop-target 设了 auto。
  // 所以手一滑掉在框外时，drop 事件只会落到 document 上 —— 那里只做
  // preventDefault（防止浏览器直接打开文件），绝不导入。
  if (target) {
    target.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      target.classList.add('is-over');
    });

    target.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      target.classList.add('is-over');
    });

    target.addEventListener('dragleave', (e) => {
      // 必须阻止冒泡：不阻止的话这次 dragleave 会冒到 document，
      // 把 depth 减掉（而进入 target 时 dragenter 被 stopPropagation 拦住了没加），
      // 结果 depth 变负 → 遮罩在鼠标刚进投放框时就消失了。
      e.stopPropagation();
      target.classList.remove('is-over');
    });

    target.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      hide();
      if (!transfer) return;
      try {
        await transfer.handleDroppedDataTransfer(e.dataTransfer);
      } catch (err) {
        console.error('[PromptVault] 拖拽导入失败', err);
        toast('拖拽导入失败，请改用「导入」按钮', 'error');
      }
    });
  }

  /* ------------------- 全局：只负责显示遮罩，不导入 ------------------- */
  // 弹窗打开时不接管拖拽：避免拖到弹窗非粘贴区时穿透到全局链路
  // （遮罩闪现 + 静默导入，而弹窗表单仍是空的）。dragleave 也必须一起跳过，
  // 否则 depth 计数会失衡，导致遮罩残留。
  document.addEventListener('dragenter', (e) => {
    if (hasModal() || !hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    show();
  });

  document.addEventListener('dragover', (e) => {
    if (hasModal() || !hasFiles(e)) return;
    e.preventDefault();
    // none = 光标显示「禁止」，明确告诉用户这里不能松手
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  });

  document.addEventListener('dragleave', (e) => {
    if (hasModal() || !hasFiles(e)) return;
    // 只在真正离开窗口时隐藏。
    // dragleave 在「从一个元素移到另一个元素」时也会触发（relatedTarget 非空），
    // 用 depth 计数判断会被子元素的 enter/leave 组合搞乱，直接看 relatedTarget 最稳。
    if (!e.relatedTarget) hide();
  });

  // 关键：全局 drop 只拦截，不导入。落点在框外 = 什么都不发生。
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
  });

  // 防止浏览器直接打开被拖入的文件
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  decorateTopbar();
  bindSearch();
  bindShortcuts();
  bindDragAndDrop();

  $('#btn-sidebar').addEventListener('click', toggleSidebar);

  $('#view-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    store.setView(btn.dataset.view);
  });

  $('#btn-import').addEventListener('click', () => ctx.openImport());
  $('#btn-quick-import').addEventListener('click', () => ctx.openQuickImport());
  const civitaiImportBtn = $('#btn-civitai-import');
  if (civitaiImportBtn) civitaiImportBtn.addEventListener('click', () => ctx.openCivitaiImport());
  $('#btn-export').addEventListener('click', () => ctx.openExport());
  $('#btn-theme').addEventListener('click', () => store.toggleTheme());

  // 先挂载视图，再初始化数据，保证首次渲染能收到 'all' 广播
  detail = mountDetail(ctx);
  transfer = mountTransfer(ctx);
  mountSidebar(ctx);
  mountGallery(ctx);
  mountManager(ctx);
  mountLoras(ctx);
  mountEdits(ctx);
  mountAssets(ctx);
  mountPrompts(ctx);

  store.subscribe((reason) => {
    if (reason === 'all' || reason === 'view') applyView();
    if (reason === 'all' || reason === 'settings') updateThemeButton();
  });

  try {
    await store.init();
  } catch (err) {
    console.error('[PromptVault] 初始化失败', err);
    toast('初始化失败，已切换到内存模式', 'error');
  }

  renderWarnBar();
  applyView();
  updateThemeButton();

  // 隐藏加载遮罩
  const loading = $('#loading');
  if (loading) {
    loading.classList.add('hide');
    setTimeout(() => { loading.hidden = true; }, 200);
  }

  if (store.state.ready) {
    const total = store.state.images.length;
    toast(total ? `已载入 ${total} 张图片` : '图库为空，拖入图片或点击「导入」开始', 'info', 2600);
  }

  // 便于调试：暴露只读入口
  window.PromptVault = { store, ctx, isImageFile };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
