/* =========================================================================
 * js/views/assets.js —— 资产图
 *
 * 只存资产图（角色四视图 / 场景 / 人物设计 / 道具 / 分镜），
 * **原图存储，不做任何压缩**。
 * 支持：复制图片到剪贴板、把卡片直接拖到资源管理器或聊天窗口。
 * ========================================================================= */

import * as store from '../store.js';
import {
  el, icon, toast, confirmDialog, openModal, formatBytes, promptDialog,
  genThumbnail, sha256Hex, baseNameNoExt, isImageFile, extFromMime
} from '../utils.js';

/**
 * 把任意图片 Blob 转成 PNG（剪贴板写入统一用 PNG，兼容性最好）。
 * @param {Blob} blob
 * @returns {Promise<Blob|null>}
 */
function toPngBlob(blob) {
  return new Promise((resolve) => {
    if (!blob) { resolve(null); return; }
    if (blob.type === 'image/png') { resolve(blob); return; }
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        canvas.toBlob((out) => resolve(out || null), 'image/png');
      } catch (err) {
        URL.revokeObjectURL(url);
        resolve(null);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/**
 * 挂载资产图视图。
 * @param {{}} ctx
 * @returns {{render:()=>void}}
 */
export function mountAssets(ctx) {
  const root = document.getElementById('view-assets');
  if (!root) return { render: () => {} };
  root.innerHTML = '';

  /** 当前筛选分类 */
  let activeCat = 'all';
  /** 当前选中的项目：'all' = 全部，'__none__' = 未分项目，其余为项目名 */
  let activeProject = 'all';
  /** 当前页码（1 基） */
  let page = 1;
  /** 每页张数 —— 瀑布流一屏大约这么多，再多滚动就累 */
  const PAGE_SIZE = 48;
  /** 本视图产生的 objectURL */
  let liveUrls = [];
  /** 拖拽期间临时保留的 objectURL（拖完再释放） */
  const dragUrls = new Set();

  function releaseUrls() {
    liveUrls.forEach((u) => URL.revokeObjectURL(u));
    liveUrls = [];
  }
  function useUrl(blob) {
    if (!blob) return '';
    const url = URL.createObjectURL(blob);
    liveUrls.push(url);
    return url;
  }

  /* ------------------------------ 骨架 ------------------------------ */
  const head = el('div', { class: 'mod-head' });
  head.appendChild(el('div', { class: 'mod-head-main' }, [
    el('h2', { class: 'mod-title', text: '资产图' }),
    el('p', { class: 'mod-desc', text: '角色四视图、场景、人物设计、道具、分镜等素材。按原图存储不做压缩，卡片可以直接拖到文件夹或聊天窗口。' })
  ]));
  const headActions = el('div', { class: 'mod-actions' });
  const addBtn = el('button', { class: 'btn btn-primary', type: 'button' });
  addBtn.innerHTML = `${icon('upload', 15)}<span>添加资产图</span>`;
  headActions.appendChild(addBtn);

  // 分类管理：资产图的分类原来写死在代码里，现在可以增删改（存 meta）
  const catMgrBtn = el('button', { class: 'btn btn-sm', type: 'button' });
  catMgrBtn.innerHTML = `${icon('tag', 15)}<span>管理分类</span>`;
  catMgrBtn.title = '新增 / 重命名 / 删除资产图分类';
  catMgrBtn.addEventListener('click', openCategoryManager);
  headActions.appendChild(catMgrBtn);
  head.appendChild(headActions);
  root.appendChild(head);

  const fileInput = el('input', {
    type: 'file', multiple: true, accept: 'image/*', style: { display: 'none' }
  });
  root.appendChild(fileInput);

  /* 项目 tab —— 放在分类上面（先选项目，再看分类） */
  const projectBar = el('div', { class: 'asset-projects' });
  root.appendChild(projectBar);

  /* 分类 tab */
  const tabs = el('div', { class: 'asset-tabs' });
  root.appendChild(tabs);

  const statLine = el('div', { class: 'mod-stat', text: '' });
  root.appendChild(statLine);

  const dropHint = el('div', { class: 'asset-drop', hidden: true, text: '松开鼠标即可添加资产图' });
  root.appendChild(dropHint);

  const grid = el('div', { class: 'asset-grid' });
  root.appendChild(grid);

  // 空状态单独放一个容器：asset-grid 是瀑布流（column-*），
  // 空状态放进列容器会被拆成好几段，必须放在外面。
  const emptyWrap = el('div', { class: 'asset-empty-wrap' });
  root.appendChild(emptyWrap);

  // 分页条：资产图多了以后一页全渲染会明显卡顿，按页切片
  const pager = el('div', { class: 'asset-pager' });
  root.appendChild(pager);

  /** 渲染分页条（只有一页时不显示） */
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
      text: `第 ${from}-${to} 张 / 共 ${total} 张 · 第 ${page} / ${pages} 页`
    }));

    pager.appendChild(mkBtn('下一页', Math.min(pages, page + 1), page >= pages));
  }

  /** 是否正在把卡片图拖出去（拖出到文件夹 / 聊天窗口，不该被当成导入） */
  let draggingCard = false;

  /* ---------------------------- 拖拽拦截 ----------------------------
   * 资产视图内的拖入是「添加资产图」，不能冒泡到全局链路（那会导进主图库）。
   * 卡片自身的拖出也会带 Files 类型（dragstart 里塞了原图 File，Chromium 拖 <img>
   * 本身也会带一个文件项），必须用 draggingCard 排除，
   * 否则在页面内松手会把自己又导入一张。
   */
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((type) => {
    root.addEventListener(type, (e) => {
      if (!e.dataTransfer) return;
      if (draggingCard) return;
      const types = Array.from(e.dataTransfer.types || []);
      if (!types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      if (type === 'dragenter' || type === 'dragover') dropHint.hidden = false;
      if (type === 'dragleave') {
        if (!root.contains(e.relatedTarget)) dropHint.hidden = true;
      }
      if (type === 'drop') {
        dropHint.hidden = true;
        importFiles(Array.from(e.dataTransfer.files || []));
      }
    });
  });

  /* ------------------------------ 交互 ------------------------------ */

  addBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = '';
    importFiles(files);
  });

  /**
   * 导入一批图片：原图直接存，只生成缩略图用于列表展示。
   * @param {File[]} files
   */
  async function importFiles(files) {
    const images = (files || []).filter(isImageFile);
    if (!images.length) { toast('没有找到可用的图片文件', 'warn'); return; }

    const targetCat = activeCat === 'all' ? store.assetCategoryList()[0] : activeCat;
    // 导入的图归到当前选中的项目；选的是「全部」或「未分项目」就留空
    const targetProject = (activeProject === 'all' || activeProject === '__none__') ? '' : activeProject;
    const known = store.assetHashSet();
    const records = [];
    let skipped = 0;

    for (const file of images) {
      try {
        const hash = await sha256Hex(file);
        if (hash && known.has(hash)) { skipped += 1; continue; }
        // 缩略图只用于列表展示；blob 保留原始文件，不做压缩
        const { thumb, width, height } = await genThumbnail(file, 480, 0.82);
        records.push({
          name: baseNameNoExt(file.name) || '未命名',
          category: targetCat,
          project: targetProject,
          blob: file,
          thumb: thumb || null,
          mime: file.type || 'image/*',
          width: width || 0,
          height: height || 0,
          size: file.size,
          hash
        });
        if (hash) known.add(hash);
      } catch (err) {
        console.error('[PromptVault] 资产图处理失败', file.name, err);
      }
      // 让出主线程，大批量时不至于卡死界面
      await new Promise((r) => setTimeout(r, 0));
    }

    if (!records.length) {
      toast(skipped ? `这批图片都已存在（跳过 ${skipped} 张）` : '没有可添加的图片', skipped ? 'info' : 'warn');
      return;
    }
    await store.addAssets(records);
    const parts = [`新增 ${records.length} 张资产图`];
    if (skipped) parts.push(`跳过重复 ${skipped} 张`);
    toast(`${parts.join('，')}（原图存储，未压缩）`, 'success');
  }

  /* ------------------------- 单张操作 ------------------------- */

  /** 复制图片到系统剪贴板 */
  async function copyImage(item) {
    if (!item.blob) { toast('这张资产图缺少原图数据', 'error'); return; }
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
      toast('当前浏览器不支持复制图片，请改用拖拽', 'warn');
      return;
    }
    try {
      const png = await toPngBlob(item.blob);
      if (!png) throw new Error('转换 PNG 失败');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      toast('图片已复制到剪贴板', 'success');
    } catch (err) {
      console.error('[PromptVault] 复制图片失败', err);
      toast('复制失败，可以试试直接拖拽卡片', 'error');
    }
  }

  /** 下载原图 */
  function downloadImage(item) {
    if (!item.blob) return;
    const ext = extFromMime(item.mime) || 'png';
    const url = URL.createObjectURL(item.blob);
    const a = el('a', { href: url, download: `${item.name || 'asset'}.${ext}` });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /** 打开大图查看 */
  function previewImage(item) {
    const url = URL.createObjectURL(item.blob || item.thumb);
    const box = el('div', { class: 'asset-viewer' });
    box.appendChild(el('img', { src: url, alt: item.name || '' }));
    const meta = el('div', { class: 'asset-viewer-meta' });
    meta.textContent = [
      item.name || '未命名',
      item.category || '',
      item.width && item.height ? `${item.width}×${item.height}` : '',
      formatBytes(item.size)
    ].filter(Boolean).join(' · ');
    box.appendChild(meta);

    const footer = el('div', { class: 'modal-foot', style: { width: '100%' } });
    const copyBtn = el('button', { class: 'btn', type: 'button', text: '复制图片' });
    copyBtn.addEventListener('click', () => copyImage(item));
    const dlBtn = el('button', { class: 'btn', type: 'button', text: '下载原图' });
    dlBtn.addEventListener('click', () => downloadImage(item));
    footer.appendChild(copyBtn);
    footer.appendChild(dlBtn);
    footer.appendChild(el('span', { class: 'spacer' }));
    const closeBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '关闭' });
    footer.appendChild(closeBtn);

    let modal = null;
    closeBtn.addEventListener('click', () => modal.close(null));
    modal = openModal({
      title: '查看资产图',
      content: box,
      footer,
      wide: true,
      onClose: () => URL.revokeObjectURL(url)
    });
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function render() {
    releaseUrls();
    tabs.innerHTML = '';
    grid.innerHTML = '';
    grid.hidden = false;
    emptyWrap.hidden = true;
    emptyWrap.innerHTML = '';

    // 分类栏的计数按当前选中的项目过滤（项目 → 分类联动）
    const counts = store.assetCounts(activeProject);

    /* 分类 tab */
    const mkTab = (key, label, count) => {
      const btn = el('button', {
        class: `asset-tab${activeCat === key ? ' active' : ''}`,
        type: 'button'
      });
      btn.appendChild(el('span', { text: label }));
      btn.appendChild(el('span', { class: 'asset-tab-count', text: String(count || 0) }));
      btn.addEventListener('click', () => {
        activeCat = key;
        page = 1;        // 换分类回到第一页，否则可能停在空页
        render();
      });
      return btn;
    };
    tabs.appendChild(mkTab('all', '全部', counts.all));
    store.assetCategoryList().forEach((c) => tabs.appendChild(mkTab(c, c, counts[c] || 0)));

    /* 项目 tab —— 独立维度，和分类做交集筛选 */
    projectBar.innerHTML = '';
    // 项目栏的计数按当前选中的分类过滤（分类 → 项目联动）
    const projCounts = store.assetProjectCounts(activeCat);
    const mkProj = (key, label, count) => {
      const btn = el('button', {
        class: `asset-tab${activeProject === key ? ' active' : ''}`,
        type: 'button'
      });
      btn.appendChild(el('span', { text: label }));
      btn.appendChild(el('span', { class: 'asset-tab-count', text: String(count || 0) }));
      btn.addEventListener('click', () => {
        activeProject = key;
        page = 1;
        render();
      });
      return btn;
    };

    projectBar.appendChild(el('span', { class: 'asset-projects-label', text: '项目' }));
    projectBar.appendChild(mkProj('all', '全部', projCounts.all));
    store.assetProjectList().forEach((p) => projectBar.appendChild(mkProj(p, p, projCounts[p] || 0)));
    // 「未分项目」没有图时不占位；但如果它正是当前选中的项目，必须保留 ——
    // 计数现在跟着 activeCat 走，一旦切到「未分项目为 0」的分类，tab 会消失，
    // 而 activeProject 仍是 '__none__'，用户就看不到也点不掉这个筛选了（死锁）。
    if (projCounts.__none__ || activeProject === '__none__') {
      projectBar.appendChild(mkProj('__none__', '未分项目', projCounts.__none__));
    }

    const addProjBtn = el('button', { class: 'asset-tab asset-tab-add', type: 'button', text: '+ 新建项目' });
    addProjBtn.addEventListener('click', async () => {
      // promptDialog(message, defaultValue, opts) —— 第二个参数是默认值，不是选项。
      // 这里原来把选项对象当成了 defaultValue，输入框会被填成 "[object Object]"，
      // 标题和 placeholder 也一起失效。
      const name = await promptDialog('新项目名称', '', { title: '新建项目', placeholder: '例如：某角色设定集' });
      if (name === null) return;
      const r = await store.addAssetProject(name);
      if (!r.ok) { toast(r.error, 'warn'); return; }
      activeProject = String(name).trim();
      page = 1;
      toast('已创建项目', 'success');
      render();
    });
    projectBar.appendChild(addProjBtn);

    // 管理项目：重命名 / 删除（新建已经有上面的快捷按钮）
    const mgrProjBtn = el('button', { class: 'asset-tab asset-tab-add', type: 'button', text: '管理项目' });
    mgrProjBtn.addEventListener('click', openProjectManager);
    projectBar.appendChild(mgrProjBtn);

    const list = store.filteredAssets(activeCat, activeProject);
    const total = store.state.assets.length;
    const totalSize = store.state.assets.reduce((s, a) => s + (Number(a.size) || 0), 0);
    // 筛选生效时主口径要跟着筛选走，否则「共 12 张」会和分类栏的「全部 5」自相矛盾。
    // 保留「共 N 张」让用户知道库里一共多少，只把「筛出多少 + 这些的体积」追加在后面。
    const filtering = activeCat !== 'all' || activeProject !== 'all' || Boolean(store.state.search);
    let listSize = 0;
    if (filtering) {
      listSize = list.reduce((s, a) => s + (Number(a.size) || 0), 0);
    }
    statLine.textContent = total
      ? (filtering
        ? `共 ${total} 张，当前筛选出 ${list.length} 张，合计 ${formatBytes(listSize)}`
        : `共 ${total} 张，原图合计 ${formatBytes(totalSize)}（未压缩存储）`)
      : '';

    if (!total) {
      showEmpty('还没有资产图', '点击「添加资产图」，或把图片直接拖到这里。原图存储，不做压缩');
      return;
    }
    if (!list.length) {
      showEmpty('这个分类下还没有图', '换个分类看看，或往这里拖几张');
      return;
    }

    // 分页切片：列表长了一页全渲染会卡（每张都要建 objectURL）
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * PAGE_SIZE;
    const slice = list.slice(start, start + PAGE_SIZE);

    for (const item of slice) {
      grid.appendChild(buildCard(item));
    }
    renderPager(list.length, pages);
  }

  /** 显示空状态：网格是瀑布流，空状态必须挪到外面，否则会被列布局切成几段 */
  function showEmpty(title, desc) {
    grid.hidden = true;
    emptyWrap.hidden = false;
    emptyWrap.innerHTML = '';
    emptyWrap.appendChild(emptyState(title, desc));
  }

  /** 项目重命名 / 删除 */
  function openProjectManager() {
    const body = el('div');
    const listWrap = el('div', { class: 'asset-cat-mgr' });

    const renderList = () => {
      listWrap.innerHTML = '';
      const list = store.assetProjectList();
      const counts = store.assetProjectCounts();

      if (!list.length) {
        listWrap.appendChild(el('div', { class: 'muted', style: { padding: '8px 0' }, text: '还没有项目' }));
      }

      list.forEach((name) => {
        const row = el('div', { class: 'asset-cat-mgr-row' });
        row.appendChild(el('span', { class: 'asset-cat-mgr-name', text: name }));
        row.appendChild(el('span', { class: 'muted', text: `${counts[name] || 0} 张` }));

        const renameBtn = el('button', { class: 'cat-act', type: 'button', title: '重命名', html: icon('pencil', 13) });
        renameBtn.addEventListener('click', async () => {
          // 不能用原生 prompt()：Electron 渲染进程默认禁用 window.prompt，
          // 调用后不弹任何窗口、直接返回 null，表现就是"点重命名没反应"。
          // 统一用项目自己的 promptDialog（取消返回 null，确定返回去空格后的非空字符串）。
          const next = await promptDialog(`重命名项目「${name}」`, name, {
            title: '重命名项目',
            placeholder: '项目名称',
            okText: '重命名'
          });
          if (next === null) return;   // 用户取消：什么都不做（不要当成"改成空字符串"）
          const r = await store.renameAssetProject(name, next);
          if (!r.ok) { toast(r.error, 'warn'); return; }
          toast(`已重命名，${r.updated} 张图同步更新`, 'success');
          if (activeProject === name) activeProject = String(next).trim();
          renderList();
          render();
        });

        const delBtn = el('button', { class: 'cat-act danger', type: 'button', title: '删除', html: icon('trash', 13) });
        delBtn.addEventListener('click', async () => {
          const count = counts[name] || 0;
          const ok = await confirmDialog(
            `删除项目「${name}」？\n\n该项目下的 ${count} 张资产图会一起删除，不可恢复。`,
            { title: '删除项目', danger: true, okText: count ? `删除项目和 ${count} 张图` : '删除项目' }
          );
          if (!ok) return;
          const r = await store.deleteAssetProject(name);
          if (!r.ok) { toast(r.error, 'warn'); return; }
          toast(`已删除项目，同时删掉 ${r.removed} 张图`, 'success');
          if (activeProject === name) activeProject = 'all';
          renderList();
          render();
        });

        row.appendChild(renameBtn);
        row.appendChild(delBtn);
        listWrap.appendChild(row);
      });
    };

    renderList();

    const footer = el('div', { style: { display: 'flex', justifyContent: 'flex-end' } });
    const closeBtn = el('button', { class: 'btn', type: 'button', text: '完成' });
    footer.appendChild(closeBtn);

    const m = openModal({ title: '管理项目', content: body, footer });
    body.appendChild(listWrap);
    closeBtn.addEventListener('click', () => m.close());
  }

  /** 资产图分类管理：新增 / 重命名 / 删除（分类原来写死在代码里） */
  function openCategoryManager() {
    const body = el('div');
    const listWrap = el('div', { class: 'asset-cat-mgr' });

    const renderList = () => {
      listWrap.innerHTML = '';
      const list = store.assetCategoryList();
      const counts = store.assetCounts();

      list.forEach((name) => {
        const row = el('div', { class: 'asset-cat-mgr-row' });
        row.appendChild(el('span', { class: 'asset-cat-mgr-name', text: name }));
        row.appendChild(el('span', { class: 'muted', text: `${counts[name] || 0} 张` }));

        const renameBtn = el('button', { class: 'cat-act', type: 'button', title: '重命名', html: icon('pencil', 13) });
        renameBtn.addEventListener('click', async () => {
          // 同上：Electron 里原生 prompt() 恒返回 null，必须用 promptDialog。
          const next = await promptDialog(`重命名分类「${name}」`, name, {
            title: '重命名分类',
            placeholder: '分类名称',
            okText: '重命名'
          });
          if (next === null) return;   // 用户取消
          const r = await store.renameAssetCategory(name, next);
          if (!r.ok) { toast(r.error, 'warn'); return; }
          toast(`已重命名，${r.updated} 张图同步更新`, 'success');
          if (activeCat === name) activeCat = String(next).trim();
          renderList();
          render();
        });

        const delBtn = el('button', { class: 'cat-act danger', type: 'button', title: '删除', html: icon('trash', 13) });
        delBtn.addEventListener('click', async () => {
          if (list.length <= 1) { toast('至少保留一个分类', 'warn'); return; }
          const fallback = list.find((c) => c !== name);
          const ok = await confirmDialog(
            `删除分类「${name}」？\n\n该分类下的图会移到「${fallback}」，图不会丢。`,
            { title: '删除分类', danger: true, okText: '删除' }
          );
          if (!ok) return;
          const r = await store.deleteAssetCategory(name);
          if (!r.ok) { toast(r.error, 'warn'); return; }
          toast(`已删除，${r.moved} 张图移到「${r.fallback}」`, 'success');
          if (activeCat === name) activeCat = 'all';
          renderList();
        });

        row.appendChild(renameBtn);
        row.appendChild(delBtn);
        listWrap.appendChild(row);
      });
    };

    renderList();

    const addRow = el('div', { class: 'asset-cat-add' });
    const input = el('input', { class: 'input', type: 'text', placeholder: '新分类名称' });
    const addBtn2 = el('button', { class: 'btn btn-primary', type: 'button', text: '添加' });
    const doAdd = async () => {
      const r = await store.addAssetCategory(input.value);
      if (!r.ok) { toast(r.error, 'warn'); return; }
      input.value = '';
      toast('已添加', 'success');
      renderList();
    };
    addBtn2.addEventListener('click', doAdd);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
    addRow.appendChild(input);
    addRow.appendChild(addBtn2);

    body.appendChild(listWrap);
    body.appendChild(addRow);

    const footer = el('div', { style: { display: 'flex', justifyContent: 'flex-end' } });
    const closeBtn = el('button', { class: 'btn', type: 'button', text: '完成' });
    footer.appendChild(closeBtn);

    const m = openModal({ title: '管理资产图分类', content: body, footer });
    closeBtn.addEventListener('click', () => m.close());
  }

  /** 重命名 / 改分类（资产图原来只能看和删，不能改） */
  function editAsset(item) {
    const nameInput = el('input', {
      class: 'input', type: 'text',
      value: item.name || '',
      placeholder: '资产图名称'
    });

    const catSelect = el('select', { class: 'select' });
    store.assetCategoryList().forEach((c) => {
      catSelect.appendChild(el('option', {
        value: c,
        text: c,
        selected: c === item.category ? 'selected' : null
      }));
    });

    // 项目下拉：未分项目 + 已建项目
    const projSelect = el('select', { class: 'select' });
    projSelect.appendChild(el('option', {
      value: '',
      text: '未分项目',
      selected: !item.project ? 'selected' : null
    }));
    store.assetProjectList().forEach((p) => {
      projSelect.appendChild(el('option', {
        value: p,
        text: p,
        selected: p === item.project ? 'selected' : null
      }));
    });

    const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });

    const nameField = el('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    nameField.appendChild(el('span', { class: 'muted', text: '名称' }));
    nameField.appendChild(nameInput);
    body.appendChild(nameField);

    const catField = el('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    catField.appendChild(el('span', { class: 'muted', text: '分类' }));
    catField.appendChild(catSelect);
    body.appendChild(catField);

    const projField = el('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    projField.appendChild(el('span', { class: 'muted', text: '项目' }));
    projField.appendChild(projSelect);
    body.appendChild(projField);

    const footer = el('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } });
    const cancelBtn = el('button', { class: 'btn', type: 'button', text: '取消' });
    const okBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '保存' });
    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);

    const m = openModal({ title: '编辑资产图', content: body, footer });

    cancelBtn.addEventListener('click', () => m.close());

    okBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const category = catSelect.value;
      const project = projSelect.value || '';
      await store.updateAsset(item.id, { name, category, project });
      m.close();
      toast('已保存', 'success');
    });

    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
  }

  function buildCard(item) {
    const card = el('div', { class: 'asset-card', title: '点击查看大图 · 可直接拖出' });

    const thumbBox = el('div', { class: 'asset-thumb' });
    const src = item.thumb || item.blob;
    if (src) {
      const img = el('img', { src: useUrl(src), alt: item.name || '', loading: 'lazy', draggable: 'true' });
      // 拖出：往 dataTransfer 里塞「原图 File 对象」，这样资源管理器 / 微信 / Discord
      // 等任意支持文件拖放的目标拿到的都是原图，而不是卡片上显示的缩略图。
      img.addEventListener('dragstart', (e) => {
        if (!item.blob || !e.dataTransfer) return;
        // 标记「这是卡片拖出」，页面内的 drop 一律忽略，否则会把自己又导入一张
        draggingCard = true;

        const ext = extFromMime(item.mime) || 'png';
        const fileName = `${item.name || 'asset'}.${ext}`;
        const mime = item.mime || 'image/png';

        /* ---- ① 关键：塞真实的 File 对象（原图） ----
         * 为什么不能只靠 DownloadURL：那是 Chromium 私有格式，只有 Chrome/Edge
         * 自己的内部逻辑（拖到网页、拖到下载栏）认它。Windows 资源管理器、微信、
         * 微信输入法、PS 等第三方目标完全不认 DownloadURL，它们会退回读
         * dataTransfer 里的 Files —— 而拖 <img> 时 Chromium 会自动把该 img 的
         * src 内容做成一个 File 项塞进去。img.src 指向的是缩略图（列表必须用
         * 缩略图省内存，1.7 万张不能全量解码原图），所以资源管理器落地的就是
         * 缩略图。这里显式 items.add(原图 File) 覆盖掉那个默认项。
         * 注意：items 只在 dragstart 期间可写，之后变只读，所以必须同步调用。
         */
        try {
          const dt = e.dataTransfer;
          // 先清掉浏览器可能已经预置的 file 类项（就是那张缩略图），
          // 避免 items 里同时出现「缩略图 + 原图」，目标应用取第一个就又错了。
          // 只清 kind === 'file' 的项，别动文本类数据。
          if (dt.items && typeof dt.items.remove === 'function') {
            for (let i = dt.items.length - 1; i >= 0; i -= 1) {
              if (dt.items[i] && dt.items[i].kind === 'file') dt.items.remove(i);
            }
          }
          const file = new File([item.blob], fileName, { type: mime });
          dt.items.add(file);
        } catch (err) {
          // 极少数环境不支持 items.add / items.remove，退回只靠下面的 DownloadURL
          console.warn('[PromptVault] 拖出原图失败，退回 DownloadURL', err);
        }

        /* ---- ② DownloadURL 保留 ----
         * Chrome/Edge 内部链路（拖到网页、下载栏）认这个，文件名和 mime 更准确。
         * 它和上面的 File 项不冲突：认 Files 的目标用 File，认 DownloadURL 的用它。
         */
        const url = URL.createObjectURL(item.blob);
        dragUrls.add(url);
        e.dataTransfer.effectAllowed = 'copy';
        try {
          e.dataTransfer.setData('DownloadURL', `${mime}:${fileName}:${url}`);
        } catch (err) { /* 个别环境禁止自定义类型，忽略 */ }

        /* ---- ③ 缩略图只做拖拽时的视觉预览，不参与数据传输 ---- */
        try { e.dataTransfer.setDragImage(img, 40, 40); } catch (err) { /* 部分环境不支持，忽略 */ }
      });
      img.addEventListener('dragend', () => {
        draggingCard = false;
        // 拖拽结束后延迟释放，避免目标应用还没读完
        setTimeout(() => {
          dragUrls.forEach((u) => { URL.revokeObjectURL(u); dragUrls.delete(u); });
        }, 3000);
      });
      thumbBox.appendChild(img);
    } else {
      thumbBox.appendChild(el('div', { class: 'asset-thumb-empty', html: icon('image', 24) }));
    }

    // 悬停操作条
    const acts = el('div', { class: 'asset-acts' });
    const editBtn = el('button', { class: 'asset-act', type: 'button', title: '重命名 / 改分类', html: icon('pencil', 14) });
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); editAsset(item); });
    const copyBtn = el('button', { class: 'asset-act', type: 'button', title: '复制图片', html: icon('copy', 14) });
    copyBtn.addEventListener('click', (e) => { e.stopPropagation(); copyImage(item); });
    const dlBtn = el('button', { class: 'asset-act', type: 'button', title: '下载原图', html: icon('download', 14) });
    dlBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadImage(item); });
    const delBtn = el('button', { class: 'asset-act danger', type: 'button', title: '删除', html: icon('trash', 14) });
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog(`确定删除「${item.name || '未命名'}」吗？原图会一并删除，不可撤销。`, {
        title: '删除资产图', danger: true, okText: '删除'
      });
      if (!ok) return;
      await store.removeAssets([item.id]);
      toast('已删除', 'success');
    });
    acts.appendChild(editBtn);
    acts.appendChild(copyBtn);
    acts.appendChild(dlBtn);
    acts.appendChild(delBtn);
    thumbBox.appendChild(acts);

    card.appendChild(thumbBox);

    const body = el('div', { class: 'asset-body' });
    body.appendChild(el('div', { class: 'asset-name', text: item.name || '未命名' }));
    const sub = el('div', { class: 'asset-sub' });
    sub.appendChild(el('span', { class: 'chip chip-sm', text: item.category || '未分类' }));
    sub.appendChild(el('span', { class: 'muted', text: formatBytes(item.size) }));
    body.appendChild(sub);
    card.appendChild(body);

    card.addEventListener('click', () => previewImage(item));
    return card;
  }

  function emptyState(title, desc) {
    const box = el('div', { class: 'empty-state' });
    box.appendChild(el('div', { class: 'empty-ico', html: icon('image', 30) }));
    box.appendChild(el('div', { class: 'empty-title', text: title }));
    box.appendChild(el('div', { class: 'empty-desc', text: desc }));
    return box;
  }

  const REASONS = new Set(['all', 'assets', 'search']);
  store.subscribe((reason) => { if (REASONS.has(reason)) render(); });

  render();
  return { render };
}
