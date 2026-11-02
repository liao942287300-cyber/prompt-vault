/* =========================================================================
 * js/views/manager.js —— 数据库视图：表格 + 排序 + 行内编辑 + 批量操作 + 分页
 * ========================================================================= */

import * as store from '../store.js';
import * as db from '../db.js';
import {
  el, icon, copyAndToast, composePromptText, confirmDialog, promptDialog,
  listDialog, toast, formatBytes, formatDate
} from '../utils.js';

/** 可排序的列定义 */
const SORTABLE = ['name', 'categoryId', 'size', 'updatedAt', 'createdAt', 'favorite'];

/**
 * 挂载数据库视图。
 * @param {{openDetail:(id:string, ids?:string[])=>void, openExport:()=>void}} ctx
 */
export function mountManager(ctx) {
  const root = document.getElementById('view-database');
  root.innerHTML = '';

  /* ------------------------------ 结构 ------------------------------ */
  const toolbar = el('div', { class: 'db-toolbar' });
  const catFilter = el('select', { class: 'select', dataset: { role: 'cat' } });
  const subFilter = el('select', { class: 'select', dataset: { role: 'sub' } });
  const favLabel = el('label', { class: 'switch' });
  const favInput = el('input', { type: 'checkbox', dataset: { role: 'fav' } });
  favLabel.appendChild(favInput);
  favLabel.appendChild(el('span', { class: 'switch-track' }));
  favLabel.appendChild(el('span', { text: '仅看收藏' }));

  const sortSelect = el('select', { class: 'select', dataset: { role: 'sort' } });
  [
    { value: 'createdAt:desc', label: '最新导入' },
    { value: 'createdAt:asc', label: '最早导入' },
    { value: 'updatedAt:desc', label: '最近更新' },
    { value: 'name:asc', label: '名称 A→Z' },
    { value: 'name:desc', label: '名称 Z→A' },
    { value: 'size:desc', label: '体积从大到小' },
    { value: 'size:asc', label: '体积从小到大' }
  ].forEach((opt) => sortSelect.appendChild(el('option', { value: opt.value, text: opt.label })));

  const clearBtn = el('button', { class: 'btn btn-sm', type: 'button', text: '清空筛选' });
  const countLabel = el('span', { class: 'muted', style: { marginLeft: 'auto' } });

  toolbar.appendChild(catFilter);
  toolbar.appendChild(subFilter);
  toolbar.appendChild(favLabel);
  toolbar.appendChild(sortSelect);
  toolbar.appendChild(clearBtn);
  toolbar.appendChild(countLabel);
  root.appendChild(toolbar);

  const batch = el('div', { class: 'db-batch', hidden: true });
  root.appendChild(batch);

  const tableWrap = el('div', { class: 'table-wrap' });
  const table = el('table', { class: 'db-table' });
  const thead = el('thead');
  const tbody = el('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  root.appendChild(tableWrap);

  const pager = el('div', { class: 'db-pager' });
  root.appendChild(pager);

  /* ------------------------------ 缩略图 URL 管理 ------------------------------ */
  let liveUrls = [];
  function releaseUrls() {
    liveUrls.forEach((url) => URL.revokeObjectURL(url));
    liveUrls = [];
  }
  function thumbUrl(image) {
    const blob = image.thumb || image.blob;
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    liveUrls.push(url);
    return url;
  }

  /* ------------------------------ 表头 ------------------------------ */
  const COLUMNS = [
    { key: 'select', label: '' },
    { key: 'thumb', label: '预览' },
    { key: 'name', label: '名称', sort: 'name' },
    { key: 'cat', label: '一级分类', sort: 'categoryId' },
    { key: 'sub', label: '二级分类' },
    { key: 'positive', label: '正向提示词' },
    { key: 'negative', label: '负向提示词' },
    { key: 'tags', label: '标签' },
    { key: 'favorite', label: '收藏', sort: 'favorite' },
    { key: 'size', label: '文件大小', sort: 'size' },
    { key: 'updatedAt', label: '更新时间', sort: 'updatedAt' },
    { key: 'ops', label: '操作' }
  ];

  function renderHead() {
    thead.innerHTML = '';
    const tr = el('tr');
    for (const col of COLUMNS) {
      const th = el('th');
      const sortKey = col.sort || (SORTABLE.includes(col.key) ? col.key : null);
      th.appendChild(el('span', { text: col.label }));
      if (sortKey) {
        th.classList.add('sortable');
        th.addEventListener('click', () => store.toggleDbSort(sortKey));
        if (store.state.dbFilter.sort === sortKey) {
          th.appendChild(el('span', {
            class: 'sort-mark',
            text: store.state.dbFilter.dir === 'asc' ? '▲' : '▼'
          }));
        }
      }
      if (col.key === 'select') {
        const cb = el('input', { class: 'checkbox', type: 'checkbox', title: '全选当前页' });
        th.innerHTML = '';
        th.appendChild(cb);
        th.__selectAll = cb;
        cb.addEventListener('change', () => {
          const ids = store.dbPageItems().map((i) => i.id);
          store.setSelection(ids, cb.checked);
          renderTable();
        });
      }
      tr.appendChild(th);
    }
    thead.appendChild(tr);
  }

  /* ------------------------------ 行渲染 ------------------------------ */
  function renderTable() {
    releaseUrls();
    tbody.innerHTML = '';
    const items = store.dbPageItems();

    if (!items.length) {
      const tr = el('tr');
      const td = el('td', { colspan: String(COLUMNS.length) });
      td.appendChild(el('div', {
        class: 'empty-state',
        html: `<div class="empty-illus">${icon('table', 34)}</div>` +
          '<div class="empty-title">没有符合条件的记录</div>' +
          '<div class="empty-desc">试试清空筛选，或先导入一些图片</div>'
      }));
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      const frag = document.createDocumentFragment();
      items.forEach((image) => frag.appendChild(buildRow(image)));
      tbody.appendChild(frag);
    }

    // 全选框状态
    const ids = items.map((i) => i.id);
    const selectedOnPage = ids.filter((id) => store.state.selection.has(id)).length;
    const selectAllCb = thead.querySelector('th:first-child .checkbox');
    if (selectAllCb) {
      selectAllCb.checked = ids.length > 0 && selectedOnPage === ids.length;
      selectAllCb.indeterminate = selectedOnPage > 0 && selectedOnPage < ids.length;
    }

    countLabel.textContent = `共 ${store.state.dbList.length} 条记录`;
    renderPager();
    renderBatch();
  }

  function buildRow(image) {
    const tr = el('tr', { dataset: { id: image.id } });
    if (store.state.selection.has(image.id)) tr.classList.add('selected');

    // 选择框
    const tdSel = el('td');
    const cb = el('input', { class: 'checkbox', type: 'checkbox', checked: store.state.selection.has(image.id) });
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => store.toggleSelection(image.id));
    tdSel.appendChild(cb);
    tr.appendChild(tdSel);

    // 缩略图
    const tdThumb = el('td');
    const url = thumbUrl(image);
    if (url) {
      const img = el('img', { class: 'cell-thumb', src: url, alt: '', loading: 'lazy' });
      tdThumb.appendChild(img);
    } else {
      tdThumb.appendChild(el('div', { class: 'cell-thumb-placeholder', html: icon('image', 18) }));
    }
    tr.appendChild(tdThumb);

    // 名称
    tr.appendChild(textCell(image, 'name', image.name || '未命名'));

    // 一级分类（下拉行内编辑）
    const top = store.categoryById(image.categoryId);
    tr.appendChild(textCell(image, 'categoryId', top ? top.name : '', '未分类', true));

    // 二级分类
    const sub = store.categoryById(image.subCategoryId);
    tr.appendChild(textCell(image, 'subCategoryId', sub ? sub.name : '', '未指定', true));

    // 正向 / 负向
    tr.appendChild(textCell(image, 'positive', image.positive || '', '（空）', false, true));
    tr.appendChild(textCell(image, 'negative', image.negative || '', '（空）', false, true));

    // 标签
    const tdTags = el('td', { class: 'td-tags', dataset: { field: 'tags' } });
    if (image.tags && image.tags.length) {
      tdTags.appendChild(el('span', {
        class: 'cell-clip',
        title: image.tags.join(', '),
        text: image.tags.join(', ')
      }));
    } else {
      tdTags.appendChild(el('span', { class: 'cell-clip cell-empty', text: '（空）' }));
    }
    tr.appendChild(tdTags);

    // 收藏
    const tdFav = el('td');
    const favBtn = el('button', {
      class: `icon-btn${image.favorite ? ' is-fav' : ''}`,
      type: 'button',
      style: { width: '26px', height: '26px' },
      title: image.favorite ? '取消收藏' : '收藏',
      html: icon('heart', 15)
    });
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      store.toggleFavorite(image.id);
    });
    tdFav.appendChild(favBtn);
    tr.appendChild(tdFav);

    // 大小
    tr.appendChild(el('td', { text: formatBytes(image.size) }));

    // 更新时间
    tr.appendChild(el('td', { text: formatDate(image.updatedAt) }));

    // 操作
    const tdOps = el('td');
    const ops = el('div', { class: 'row-actions' });
    const openBtn = el('button', { class: 'cat-act', type: 'button', title: '打开详情', html: icon('eye', 14) });
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      ctx.openDetail(image.id, store.state.dbList.map((i) => i.id));
    });
    const copyBtn = el('button', { class: 'cat-act', type: 'button', title: '复制正向提示词', html: icon('copy', 14) });
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyAndToast(image.positive, '已复制正向提示词');
    });
    const delBtn = el('button', { class: 'cat-act danger', type: 'button', title: '删除', html: icon('trash', 14) });
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog(`确定要删除「${image.name || '未命名'}」吗？此操作不可撤销。`, {
        title: '删除图片', danger: true, okText: '删除'
      });
      if (ok) { await store.removeImages([image.id]); toast('已删除', 'success'); }
    });
    ops.appendChild(openBtn);
    ops.appendChild(copyBtn);
    ops.appendChild(delBtn);
    tdOps.appendChild(ops);
    tr.appendChild(tdOps);

    return tr;
  }

  function textCell(image, field, value, emptyText = '（空）', isSelect = false, mono = false) {
    const td = el('td', { dataset: { field } });
    if (isSelect) td.classList.add('is-select');
    if (value) {
      td.appendChild(el('span', {
        class: `cell-clip${mono ? ' mono' : ''}`,
        title: String(value),
        text: String(value)
      }));
    } else {
      td.appendChild(el('span', { class: 'cell-clip cell-empty', text: emptyText }));
    }
    td.addEventListener('dblclick', () => startEdit(td, image, field));
    return td;
  }

  /* ------------------------------ 行内编辑 ------------------------------ */

  let editing = false;

  function startEdit(td, image, field) {
    if (editing || td.querySelector('input, select')) return;
    const current = store.imageById(image.id);
    if (!current) return;
    editing = true;

    let editor;
    if (field === 'categoryId') {
      editor = el('select', { class: 'cell-input' });
      editor.appendChild(el('option', { value: '', text: '未分类' }));
      store.topCategories().forEach((c) => editor.appendChild(el('option', { value: c.id, text: c.name })));
      editor.value = current.categoryId || '';
    } else if (field === 'subCategoryId') {
      editor = el('select', { class: 'cell-input' });
      editor.appendChild(el('option', { value: '', text: '未指定' }));
      const subs = current.categoryId
        ? store.subCategoriesOf(current.categoryId)
        : store.state.categories.filter((c) => c.level === 2);
      subs.forEach((c) => editor.appendChild(el('option', { value: c.id, text: c.name })));
      editor.value = current.subCategoryId || '';
    } else {
      editor = el('input', { class: 'cell-input', type: 'text' });
      if (field === 'tags') editor.value = (current.tags || []).join(', ');
      else editor.value = current[field] || '';
    }

    td.innerHTML = '';
    td.appendChild(editor);
    editor.focus();
    if (typeof editor.select === 'function' && editor.tagName === 'INPUT') editor.select();

    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      editing = false;
      if (save) await applyCellEdit(current, field, editor.value);
      else render();
    };

    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    editor.addEventListener('blur', () => finish(true));
    if (editor.tagName === 'SELECT') editor.addEventListener('change', () => finish(true));
  }

  async function applyCellEdit(image, field, value) {
    const patch = {};
    const raw = String(value == null ? '' : value);
    if (field === 'tags') {
      patch.tags = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    } else if (field === 'name') {
      patch.name = raw.trim() || '未命名';
    } else if (field === 'categoryId') {
      patch.categoryId = raw || null;
      patch.subCategoryId = image.subCategoryId || null;
      if (!raw) patch.subCategoryId = null;
      else if (patch.subCategoryId) {
        const sub = store.categoryById(patch.subCategoryId);
        if (!sub || sub.parentId !== raw) patch.subCategoryId = null;
      }
    } else if (field === 'subCategoryId') {
      patch.subCategoryId = raw || null;
      if (raw) {
        const sub = store.categoryById(raw);
        if (sub) patch.categoryId = sub.parentId;
      }
    } else {
      patch[field] = raw;
    }
    await store.updateImage(image.id, patch);
  }

  /* ------------------------------ 批量操作 ------------------------------ */

  function renderBatch() {
    batch.innerHTML = '';
    const count = store.selectionCount();
    if (!count) { batch.hidden = true; return; }
    batch.hidden = false;

    batch.appendChild(el('span', { class: 'db-batch-count', text: `已选 ${count} 项` }));

    const mk = (label, iconName, handler, danger) => {
      const btn = el('button', { class: `btn btn-sm${danger ? ' btn-danger' : ''}`, type: 'button' });
      btn.innerHTML = `${icon(iconName, 14)}<span>${label}</span>`;
      btn.addEventListener('click', handler);
      return btn;
    };

    batch.appendChild(mk('改一级分类', 'folder', batchSetCategory));
    batch.appendChild(mk('改二级分类', 'folderOpen', batchSetSubCategory));
    batch.appendChild(mk('加标签', 'tag', batchAddTags));
    batch.appendChild(mk('复制提示词', 'copy', batchCopyPrompts));
    batch.appendChild(mk('导出选中', 'download', batchExport));
    batch.appendChild(mk('删除', 'trash', batchDelete, true));

    const clearBtn2 = el('button', { class: 'btn btn-sm', type: 'button', text: '取消选择' });
    clearBtn2.addEventListener('click', () => store.clearSelection());
    batch.appendChild(clearBtn2);
  }

  async function batchSetCategory() {
    const options = store.topCategories().map((c) => ({ value: c.id, label: c.name }));
    const value = await listDialog('批量修改一级分类', options, {
      label: `将选中 ${store.selectionCount()} 张图片的一级分类统一修改为`,
      emptyLabel: '未分类（清空一级分类）'
    });
    if (value === null) return;
    const ids = Array.from(store.state.selection);
    const patch = { categoryId: value || null };
    if (!value) patch.subCategoryId = null;
    await store.updateImages(ids, patch);
    toast(`已更新 ${ids.length} 张图片的一级分类`, 'success');
  }

  async function batchSetSubCategory() {
    const allSubs = store.topCategories().flatMap((top) => store.subCategoriesOf(top.id)
      .map((sub) => ({ value: sub.id, label: `${top.name} / ${sub.name}` })));
    const value = await listDialog('批量修改二级分类', allSubs, {
      label: `将选中 ${store.selectionCount()} 张图片的二级分类统一修改为`,
      emptyLabel: '未指定（清空二级分类）'
    });
    if (value === null) return;
    const ids = Array.from(store.state.selection);
    const patch = { subCategoryId: value || null };
    if (value) {
      const sub = store.categoryById(value);
      if (sub) patch.categoryId = sub.parentId;
    }
    await store.updateImages(ids, patch);
    toast(`已更新 ${ids.length} 张图片的二级分类`, 'success');
  }

  async function batchAddTags() {
    const value = await promptDialog('输入要添加的标签，多个标签用逗号分隔', '', {
      title: '批量添加标签', placeholder: '例如：风景, 黄昏'
    });
    if (!value) return;
    const additions = value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (!additions.length) return;
    const ids = Array.from(store.state.selection);
    const targets = ids.map((id) => store.imageById(id)).filter(Boolean);
    const now = Date.now();
    targets.forEach((image) => {
      image.tags = Array.from(new Set([...(image.tags || []), ...additions]));
      image.updatedAt = now;
    });
    await db.putImages(targets);
    store.recompute();
    store.emit('images');
    toast(`已为 ${targets.length} 张图片添加标签`, 'success');
  }

  function batchCopyPrompts() {
    const images = store.selectedImages();
    const text = images.map((image) => {
      const composed = composePromptText(image);
      return `# ${image.name || '未命名'}\n${composed}`;
    }).filter(Boolean).join('\n\n---\n\n');
    copyAndToast(text, `已复制 ${images.length} 张图片的提示词`);
  }

  function batchExport() {
    ctx.openExport();
  }

  async function batchDelete() {
    const ids = Array.from(store.state.selection);
    const ok = await confirmDialog(`确定要删除选中的 ${ids.length} 张图片吗？此操作不可撤销。`, {
      title: '批量删除', danger: true, okText: '全部删除'
    });
    if (!ok) return;
    await store.removeImages(ids);
    store.clearSelection();
    toast(`已删除 ${ids.length} 张图片`, 'success');
  }

  /* ------------------------------ 分页 ------------------------------ */

  function renderPager() {
    pager.innerHTML = '';
    const total = store.dbTotalPages();
    const page = store.state.dbPage;
    const size = store.pageSizeDb();
    const from = store.state.dbList.length ? (page - 1) * size + 1 : 0;
    const to = Math.min(page * size, store.state.dbList.length);

    const prev = el('button', { class: 'btn btn-sm', type: 'button', text: '上一页' });
    prev.disabled = page <= 1;
    prev.addEventListener('click', () => store.setDbPage(page - 1));

    const next = el('button', { class: 'btn btn-sm', type: 'button', text: '下一页' });
    next.disabled = page >= total;
    next.addEventListener('click', () => store.setDbPage(page + 1));

    pager.appendChild(prev);
    pager.appendChild(el('span', { text: `第 ${from}-${to} 条 / 共 ${store.state.dbList.length} 条 · 第 ${page} / ${total} 页` }));
    pager.appendChild(next);

    const jump = el('input', { class: 'input', type: 'number', value: String(page), style: { width: '72px', height: '28px', padding: '0 6px' } });
    jump.min = '1';
    jump.max = String(total);
    jump.addEventListener('change', () => store.setDbPage(Number(jump.value)));
    pager.appendChild(jump);
  }

  /* ------------------------------ 工具行 ------------------------------ */

  function renderToolbar() {
    // 一级分类
    catFilter.innerHTML = '';
    catFilter.appendChild(el('option', { value: '', text: '全部一级分类' }));
    store.topCategories().forEach((c) => catFilter.appendChild(el('option', { value: c.id, text: c.name })));
    catFilter.value = store.state.dbFilter.categoryId || '';

    // 二级分类
    subFilter.innerHTML = '';
    subFilter.appendChild(el('option', { value: '', text: '全部二级分类' }));
    const parentId = store.state.dbFilter.categoryId;
    const subs = parentId
      ? store.subCategoriesOf(parentId)
      : store.state.categories.filter((c) => c.level === 2);
    subs.forEach((c) => subFilter.appendChild(el('option', { value: c.id, text: c.name })));
    subFilter.value = store.state.dbFilter.subCategoryId || '';
    subFilter.disabled = false;

    favInput.checked = Boolean(store.state.dbFilter.favoriteOnly);
    const sortValue = `${store.state.dbFilter.sort}:${store.state.dbFilter.dir}`;
    sortSelect.value = sortValue;
    if (!sortSelect.value) sortSelect.value = 'createdAt:desc';
  }

  catFilter.addEventListener('change', () => {
    store.setDbFilter({ categoryId: catFilter.value, subCategoryId: '' });
  });
  subFilter.addEventListener('change', () => {
    const value = subFilter.value;
    if (value) {
      const sub = store.categoryById(value);
      store.setDbFilter({ subCategoryId: value, categoryId: sub ? sub.parentId : store.state.dbFilter.categoryId });
    } else {
      store.setDbFilter({ subCategoryId: '' });
    }
  });
  favInput.addEventListener('change', () => store.setDbFilter({ favoriteOnly: favInput.checked }));
  sortSelect.addEventListener('change', () => {
    const [sort, dir] = sortSelect.value.split(':');
    store.setDbFilter({ sort, dir });
  });
  clearBtn.addEventListener('click', () => store.clearDbFilter());

  /* ------------------------------ 快捷键：Ctrl+A 全选当前页 ------------------------------ */
  document.addEventListener('keydown', (e) => {
    if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) return;
    if (store.state.view !== 'database') return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (document.activeElement && document.activeElement.isContentEditable)) return;
    e.preventDefault();
    const ids = store.dbPageItems().map((i) => i.id);
    store.setSelection(ids, true);
    renderTable();
  });

  /* ------------------------------ 渲染 / 订阅 ------------------------------ */

  function renderAll() {
    renderHead();
    renderToolbar();
    renderTable();
  }

  store.subscribe((reason) => {
    if (reason === 'selection') {
      // 仅更新勾选态与批量条，避免重建整表打断编辑
      const items = store.dbPageItems();
      items.forEach((image) => {
        const tr = tbody.querySelector(`tr[data-id="${image.id}"]`);
        if (!tr) return;
        const cb = tr.querySelector('input.checkbox');
        if (cb) cb.checked = store.state.selection.has(image.id);
        tr.classList.toggle('selected', store.state.selection.has(image.id));
      });
      const ids = items.map((i) => i.id);
      const selectedOnPage = ids.filter((id) => store.state.selection.has(id)).length;
      const selectAllCb = thead.querySelector('th:first-child .checkbox');
      if (selectAllCb) {
        selectAllCb.checked = ids.length > 0 && selectedOnPage === ids.length;
        selectAllCb.indeterminate = selectedOnPage > 0 && selectedOnPage < ids.length;
      }
      renderBatch();
      return;
    }
    if (reason === 'all' || reason === 'images' || reason === 'filter' || reason === 'search' || reason === 'settings' || reason === 'categories') {
      renderAll();
    }
  });

  renderAll();
  return { render: renderAll };
}
