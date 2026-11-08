/* =========================================================================
 * js/views/loras.js —— LORA 触发词
 *
 * 通过 File System Access API「映射」一个本地 loras 目录：
 * 只遍历目录结构和文件名，**不读取任何权重内容**，也不复制文件。
 * 目录句柄会存进 IndexedDB，下次打开页面直接复用，不用重新选。
 *
 * 浏览器不支持目录映射时（Firefox / Safari），降级为 webkitdirectory 选择，
 * 功能可用但需要重新选择。
 * ========================================================================= */

import * as store from '../store.js';
import { el, icon, toast, confirmDialog, formatBytes, copyText } from '../utils.js';

/** 视为 LoRA 权重的扩展名 */
const LORA_EXTS = new Set(['safetensors', 'ckpt', 'pt', 'pth', 'bin', 'onnx']);

/** 当前环境是否支持目录句柄映射 */
const SUPPORTS_DIR_PICKER = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

/**
 * 挂载 LORA 触发词视图。
 * @param {{}} ctx 应用上下文（保留统一签名）
 * @returns {{render:()=>void}}
 */
export function mountLoras(ctx) {
  const root = document.getElementById('view-loras');
  if (!root) return { render: () => {} };
  root.innerHTML = '';

  /** 扫描中标记，避免重复点击 */
  let scanning = false;

  /** 当前页码（1 基）与每页条数 —— LoRA 目录动辄几百个文件，必须分页 */
  let page = 1;
  const PAGE_SIZE = 60;

  /** 当前按目录筛选（'' = 全部目录），由 relPath 的目录部分决定 */
  let activeDir = '';

  /* ------------------------------ 骨架 ------------------------------ */
  const head = el('div', { class: 'mod-head' });
  head.appendChild(el('div', { class: 'mod-head-main' }, [
    el('h2', { class: 'mod-title', text: 'LORA 触发词' }),
    el('p', {
      class: 'mod-desc',
      text: SUPPORTS_DIR_PICKER
        ? '映射一个本地 loras 文件夹，只读取目录里的文件名，不动文件内容。为每个 LoRA 配一段触发词，用的时候一键复制。'
        : '当前浏览器不支持目录映射，改为选择文件夹读取文件列表（不会上传内容）。'
    })
  ]));

  const headActions = el('div', { class: 'mod-actions' });
  const refreshBtn = el('button', { class: 'btn', type: 'button', hidden: true });
  refreshBtn.innerHTML = `${icon('refresh', 15)}<span>刷新扫描</span>`;
  const pickBtn = el('button', { class: 'btn btn-primary', type: 'button' });
  pickBtn.innerHTML = `${icon('folder', 15)}<span>映射 loras 文件夹</span>`;
  const clearBtn = el('button', { class: 'btn', type: 'button' });
  clearBtn.innerHTML = `${icon('trash', 15)}<span>清空</span>`;
  headActions.appendChild(refreshBtn);
  headActions.appendChild(pickBtn);
  headActions.appendChild(clearBtn);
  head.appendChild(headActions);
  root.appendChild(head);

  // 降级通道：不支持目录映射时用
  const dirInput = el('input', {
    type: 'file', multiple: true, webkitdirectory: 'true', directory: 'true',
    style: { display: 'none' }
  });
  root.appendChild(dirInput);

  const statLine = el('div', { class: 'mod-stat', text: '' });
  root.appendChild(statLine);

  // 目录筛选条：把 loras 文件夹的子目录当分类用
  const dirBar = el('div', { class: 'lora-dirbar' });
  root.appendChild(dirBar);

  const listWrap = el('div', { class: 'lora-list' });
  root.appendChild(listWrap);

  // 分页条
  const pager = el('div', { class: 'asset-pager' });
  root.appendChild(pager);

  /** 取 LoRA 所在目录（'' 表示根目录） */
  const dirOf = (lora) => {
    const p = String(lora?.relPath || '');
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(0, i) : '';
  };

  /** 渲染分页条 */
  function renderPager(total, pages) {
    pager.innerHTML = '';
    if (pages <= 1) return;

    const mkBtn = (label, target, disabled) => {
      const btn = el('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: label,
        disabled: disabled ? 'disabled' : null
      });
      btn.addEventListener('click', () => {
        page = target;
        render();
        pager.scrollIntoView({ block: 'nearest' });
      });
      return btn;
    };

    pager.appendChild(mkBtn('上一页', Math.max(1, page - 1), page <= 1));
    const from = (page - 1) * PAGE_SIZE + 1;
    const to = Math.min(page * PAGE_SIZE, total);
    pager.appendChild(el('span', {
      class: 'asset-pager-info',
      text: `第 ${from}-${to} 个 / 共 ${total} 个 · 第 ${page} / ${pages} 页`
    }));
    pager.appendChild(mkBtn('下一页', Math.min(pages, page + 1), page >= pages));
  }

  /* ---------------------------- 目录遍历 ---------------------------- */

  /**
   * 递归遍历目录句柄，只收集文件名 / 大小 / 相对路径。
   * 用 getFile() 取元信息，不会把权重内容读进内存。
   *
   * @param {FileSystemDirectoryHandle} dirHandle
   * @param {string} [prefix]
   * @returns {Promise<Array<{fileName:string, ext:string, size:number, relPath:string}>>}
   */
  async function walkDirectory(dirHandle, prefix = '') {
    const out = [];
    for await (const [name, child] of dirHandle.entries()) {
      if (child.kind === 'directory') {
        const sub = await walkDirectory(child, `${prefix}${name}/`);
        out.push(...sub);
        continue;
      }
      const ext = (name.split('.').pop() || '').toLowerCase();
      if (!LORA_EXTS.has(ext)) continue;
      let size = 0;
      try {
        const file = await child.getFile(); // 仅元数据，不读内容
        size = file.size;
      } catch (err) { /* 个别文件可能无权访问，忽略 */ }
      out.push({ fileName: name, ext, size, relPath: `${prefix}${name}` });
    }
    return out;
  }

  /**
   * 确保目录读权限。
   * @param {FileSystemDirectoryHandle} handle
   * @param {boolean} interactive 是否允许弹授权框（必须由用户手势触发）
   */
  async function ensurePermission(handle, interactive) {
    const opts = { mode: 'read' };
    try {
      // 从 IndexedDB 取回的句柄若已失效，可能没有这两个方法
      if (typeof handle.queryPermission !== 'function') return false;
      if ((await handle.queryPermission(opts)) === 'granted') return true;
      if (!interactive || typeof handle.requestPermission !== 'function') return false;
      return (await handle.requestPermission(opts)) === 'granted';
    } catch (err) {
      console.warn('[PromptVault] 目录授权失败', err);
      return false;
    }
  }

  /**
   * 扫描目录并同步到列表：已有记录保留触发词，新增文件补进来，消失的文件移除。
   * @param {FileSystemDirectoryHandle} handle
   */
  async function syncFromHandle(handle) {
    if (scanning) return;
    scanning = true;
    refreshBtn.disabled = true;
    pickBtn.disabled = true;
    statLine.textContent = '正在扫描目录…';

    try {
      const found = await walkDirectory(handle);
      const existing = new Map(store.state.loras.map((l) => [l.relPath, l]));
      const foundPaths = new Set(found.map((f) => f.relPath));

      // 目录里已不存在的记录
      const staleIds = store.state.loras.filter((l) => !foundPaths.has(l.relPath)).map((l) => l.id);
      // 新出现的文件
      const fresh = found.filter((f) => !existing.has(f.relPath));
      // 体积有变化的，顺手更新
      const changed = found.filter((f) => {
        const old = existing.get(f.relPath);
        return old && Number(old.size) !== Number(f.size);
      });

      if (staleIds.length) await store.removeLoras(staleIds);
      if (fresh.length) await store.addLoras(fresh);
      for (const f of changed) {
        const old = existing.get(f.relPath);
        if (old) await store.updateLora(old.id, { size: f.size });
      }

      await store.setLoraDirName(handle.name);
      refreshBtn.hidden = false;

      const total = found.length;
      if (!total) {
        toast('这个目录里没有找到 LoRA 权重文件', 'warn');
      } else {
        const parts = [`共 ${total} 个 LoRA`];
        if (fresh.length) parts.push(`新增 ${fresh.length}`);
        if (staleIds.length) parts.push(`移除 ${staleIds.length}`);
        toast(`扫描完成：${parts.join('，')}`, 'success');
      }
    } catch (err) {
      console.error('[PromptVault] 扫描 loras 目录失败', err);
      toast(`扫描失败：${(err && err.message) || err}`, 'error');
    } finally {
      scanning = false;
      refreshBtn.disabled = false;
      pickBtn.disabled = false;
      render();
    }
  }

  /* ------------------------------ 交互 ------------------------------ */

  /** 首次映射 / 重新选择目录 */
  async function pickDirectory() {
    if (!SUPPORTS_DIR_PICKER) { dirInput.click(); return; }

    let handle;
    try {
      handle = await window.showDirectoryPicker({
        id: 'promptvault-loras',
        mode: 'read',
        startIn: 'documents'
      });
    } catch (err) {
      // 用户取消选择不算错误
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
      console.error('[PromptVault] 选择目录失败', err);
      toast('打开目录失败，请重试', 'error');
      return;
    }

    // 换了目录：旧记录基于别的路径，提示是否清空
    if (store.state.loras.length && store.state.loraDirName && store.state.loraDirName !== handle.name) {
      const ok = await confirmDialog(
        `当前记录来自「${store.state.loraDirName}」，现在要映射「${handle.name}」。\n继续会清空原有的 ${store.state.loras.length} 条记录（已填写的触发词会丢失），是否继续？`,
        { title: '切换 loras 目录', danger: true, okText: '清空并切换' }
      );
      if (!ok) return;
      await store.removeLoras(store.state.loras.map((l) => l.id));
    }

    const granted = await ensurePermission(handle, true);
    if (!granted) { toast('没有获得目录读取权限', 'warn'); return; }

    try {
      await store.setLoraDirHandle(handle);
    } catch (err) {
      // 部分环境不允许把句柄写进 IndexedDB，功能仍可用，只是下次要重选
      console.warn('[PromptVault] 目录句柄持久化失败，下次需重新选择', err);
    }
    await syncFromHandle(handle);
  }

  pickBtn.addEventListener('click', pickDirectory);

  refreshBtn.addEventListener('click', async () => {
    const handle = await store.getLoraDirHandle();
    if (!handle) {
      // 句柄丢了，让用户重新选
      toast('目录句柄已失效，请重新映射', 'warn');
      pickDirectory();
      return;
    }
    const granted = await ensurePermission(handle, true);
    if (!granted) { toast('没有获得目录读取权限，请重新映射', 'warn'); return; }
    await syncFromHandle(handle);
  });

  clearBtn.addEventListener('click', async () => {
    if (!store.state.loras.length) { toast('还没有映射过 LoRA 目录', 'warn'); return; }
    const ok = await confirmDialog(
      `确定要清空全部 ${store.state.loras.length} 条 LoRA 记录吗？已填写的触发词也会一起删除，此操作不可撤销。`,
      { title: '清空 LORA 记录', danger: true, okText: '清空' }
    );
    if (!ok) return;
    await store.removeLoras(store.state.loras.map((l) => l.id));
    await store.setLoraDirName('');
    toast('已清空 LORA 记录', 'success');
  });

  /* 降级通道：webkitdirectory（不支持目录映射的浏览器） */
  dirInput.addEventListener('change', async () => {
    const files = Array.from(dirInput.files || []);
    dirInput.value = '';
    if (!files.length) return;

    const known = new Set(store.state.loras.map((l) => l.relPath || l.fileName));
    const found = [];
    let skipped = 0;

    for (const file of files) {
      const relPath = file.webkitRelativePath || file.name;
      const ext = (relPath.split('.').pop() || '').toLowerCase();
      if (!LORA_EXTS.has(ext)) continue;
      if (known.has(relPath)) { skipped += 1; continue; }
      known.add(relPath);
      found.push({ fileName: file.name, ext, size: file.size, relPath });
    }

    if (!found.length) {
      toast(skipped ? `扫描完成：${skipped} 个文件已在列表中` : '这个文件夹里没有找到 LoRA 权重文件', skipped ? 'info' : 'warn');
      return;
    }
    await store.addLoras(found);
    const parts = [`新增 ${found.length} 个 LoRA`];
    if (skipped) parts.push(`跳过已存在 ${skipped} 个`);
    toast(`扫描完成：${parts.join('，')}`, 'success');
  });

  /* ------------------------------ 渲染 ------------------------------ */

  /** 记录当前焦点，重绘后恢复，避免输入触发词时被搜索打断 */
  function captureFocus() {
    const active = document.activeElement;
    if (!active || !root.contains(active) || !active.dataset.loraId) return null;
    return {
      id: active.dataset.loraId,
      start: active.selectionStart,
      end: active.selectionEnd
    };
  }

  function restoreFocus(snap) {
    if (!snap) return;
    const node = root.querySelector(`[data-lora-id="${snap.id}"]`);
    if (!node) return;
    node.focus();
    try { node.setSelectionRange(snap.start, snap.end); } catch (err) { /* 非文本输入忽略 */ }
  }

  function render() {
    const snap = captureFocus();
    listWrap.innerHTML = '';

    let list = store.filteredLoras();
    const total = store.state.loras.length;
    const withTrigger = store.state.loras.filter((l) => (l.trigger || '').trim()).length;
    const dirName = store.state.loraDirName;

    refreshBtn.hidden = !dirName;
    pickBtn.innerHTML = dirName
      ? `${icon('folder', 15)}<span>更换目录</span>`
      : `${icon('folder', 15)}<span>映射 loras 文件夹</span>`;

    const bits = [];
    if (dirName) bits.push(`已映射「${dirName}」`);
    if (total) {
      bits.push(`${total} 个 LoRA`);
      bits.push(`已填触发词 ${withTrigger} 个`);
      if (store.state.search) bits.push(`筛选出 ${list.length} 个`);
    }
    statLine.textContent = bits.join(' · ');

    /* -------------------- 目录筛选（把文件夹当分类用） -------------------- */
    // relPath 形如「角色/古风/xxx.safetensors」，按目录分组，用户能像选分类一样选目录
    const dirs = Array.from(new Set(
      store.state.loras.map(dirOf).filter((d) => d !== '')
    )).sort((a, b) => a.localeCompare(b, 'zh'));

    dirBar.innerHTML = '';
    if (dirs.length) {
      // 当前选的目录被删了（换了映射目录）→ 回到全部。
      // 注意 '__root__' 是个虚拟 key（根目录），不在 dirs 里，不能把它当「已删除」重置掉，
      // 否则点「根目录」会立刻被弹回「全部目录」，看起来就是点了没反应。
      if (activeDir && activeDir !== '__root__' && !dirs.includes(activeDir)) activeDir = '';

      const mkDirTab = (key, label, count) => {
        const btn = el('button', {
          class: `asset-tab${activeDir === key ? ' active' : ''}`,
          type: 'button'
        });
        btn.appendChild(el('span', { text: label }));
        btn.appendChild(el('span', { class: 'asset-tab-count', text: String(count) }));
        btn.addEventListener('click', () => {
          activeDir = key;
          page = 1;
          render();
        });
        return btn;
      };

      const rootCount = store.state.loras.filter((l) => dirOf(l) === '').length;
      dirBar.appendChild(mkDirTab('', '全部目录', total));
      dirs.forEach((d) => {
        dirBar.appendChild(mkDirTab(d, d, store.state.loras.filter((l) => dirOf(l) === d).length));
      });
      if (rootCount) dirBar.appendChild(mkDirTab('__root__', '（根目录）', rootCount));
    }

    // 应用目录筛选
    if (activeDir === '__root__') list = list.filter((l) => dirOf(l) === '');
    else if (activeDir) list = list.filter((l) => dirOf(l) === activeDir);

    if (!total) {
      listWrap.appendChild(emptyState(
        dirName ? '这个目录里没有 LoRA 文件' : '还没有映射 loras 目录',
        dirName
          ? '确认目录里有 .safetensors / .ckpt / .pt 等权重文件，点「刷新扫描」重新读取'
          : (SUPPORTS_DIR_PICKER
            ? '点击右上角「映射 loras 文件夹」，只读取目录里的文件名，不动文件内容'
            : '点击右上角选择文件夹读取文件列表')
      ));
      return;
    }
    if (!list.length) {
      listWrap.appendChild(emptyState('没有匹配的 LoRA', '换个关键字试试，或清空搜索框'));
      return;
    }

    // 表头
    const header = el('div', { class: 'lora-row lora-row-head' });
    header.appendChild(el('div', { class: 'lora-col-name', text: '文件' }));
    header.appendChild(el('div', { class: 'lora-col-size', text: '大小' }));
    header.appendChild(el('div', { class: 'lora-col-trigger', text: '触发词' }));
    header.appendChild(el('div', { class: 'lora-col-act', text: '' }));
    listWrap.appendChild(header);

    // 分页切片（LoRA 目录几百个文件，一页全渲染会卡）
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * PAGE_SIZE;
    const slice = list.slice(start, start + PAGE_SIZE);

    for (const lora of slice) {
      const row = el('div', { class: 'lora-row' });

      const nameCell = el('div', { class: 'lora-col-name' });
      nameCell.appendChild(el('span', { class: 'lora-file', text: lora.fileName, title: lora.relPath || lora.fileName }));
      if (lora.relPath && lora.relPath.includes('/')) {
        nameCell.appendChild(el('span', {
          class: 'lora-path',
          text: lora.relPath.slice(0, lora.relPath.lastIndexOf('/')),
          title: lora.relPath
        }));
      }
      row.appendChild(nameCell);

      row.appendChild(el('div', { class: 'lora-col-size', text: lora.size ? formatBytes(lora.size) : '—' }));

      const triggerCell = el('div', { class: 'lora-col-trigger' });
      const input = el('input', {
        class: 'input lora-trigger',
        type: 'text',
        placeholder: '填写触发词，例如 mystyle',
        value: lora.trigger || '',
        dataset: { loraId: lora.id }
      });
      input.addEventListener('change', async () => {
        await store.updateLora(lora.id, { trigger: input.value.trim() });
      });
      triggerCell.appendChild(input);
      row.appendChild(triggerCell);

      const actCell = el('div', { class: 'lora-col-act' });
      const copyBtn = el('button', {
        class: 'cat-act', type: 'button', title: '复制触发词',
        html: icon('copy', 13)
      });
      copyBtn.addEventListener('click', async () => {
        const text = (lora.trigger || '').trim();
        if (!text) { toast('这个 LoRA 还没有填写触发词', 'warn'); return; }
        const ok = await copyText(text);
        toast(ok ? `已复制：${text}` : '复制失败', ok ? 'success' : 'error');
      });
      const delBtn = el('button', {
        class: 'cat-act danger', type: 'button', title: '从列表移除',
        html: icon('trash', 13)
      });
      delBtn.addEventListener('click', async () => {
        await store.removeLoras([lora.id]);
        toast('已移除', 'success');
      });
      actCell.appendChild(copyBtn);
      actCell.appendChild(delBtn);
      row.appendChild(actCell);

      listWrap.appendChild(row);
    }

    renderPager(list.length, pages);

    restoreFocus(snap);
  }

  function emptyState(title, desc) {
    const box = el('div', { class: 'empty-state' });
    box.appendChild(el('div', { class: 'empty-ico', html: icon('tag', 30) }));
    box.appendChild(el('div', { class: 'empty-title', text: title }));
    box.appendChild(el('div', { class: 'empty-desc', text: desc }));
    return box;
  }

  const REASONS = new Set(['all', 'loras', 'search']);
  store.subscribe((reason) => { if (REASONS.has(reason)) render(); });

  render();

  /* 启动时若已有目录句柄且权限仍在，静默重扫一次。
   * 注意：本视图在 store.init() 之前挂载，那时 IndexedDB 连接还没建立，
   * 直接调 getLoraDirHandle() 会撞上 _db === null。必须等 ready 之后再跑。 */
  let autoRescanned = false;
  async function autoRescanOnce() {
    if (autoRescanned || !SUPPORTS_DIR_PICKER) return;
    if (!store.state.ready) return; // 等 init 完成
    autoRescanned = true;
    const handle = await store.getLoraDirHandle();
    if (!handle) return;
    const granted = await ensurePermission(handle, false); // 非交互，不弹窗
    if (!granted) return;
    await syncFromHandle(handle);
  }

  store.subscribe((reason) => { if (reason === 'all') autoRescanOnce(); });
  autoRescanOnce();

  return { render };
}
