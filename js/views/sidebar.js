/* =========================================================================
 * js/views/sidebar.js —— 左栏：快捷入口 + 两级分类树 + 分类管理
 * ========================================================================= */

import * as store from '../store.js';
import { el, icon, confirmDialog, promptDialog, listDialog, toast, openModal } from '../utils.js';
import { ruleKeys } from '../auto-classify.js';

/** 新建分类时可选的颜色 */
const COLOR_CHOICES = ['#2f6fed', '#0f9d58', '#8b5cf6', '#e8973a', '#0ea5b7', '#d946a0', '#d92d20', '#66717d'];

/**
 * 挂载左栏。
 * @param {{}} ctx 应用上下文（本视图未使用，保留统一签名）
 * @returns {{render:()=>void}}
 */
export function mountSidebar(ctx) {
  const root = document.getElementById('sidebar');
  root.innerHTML = '';

  const head = el('div', { class: 'sidebar-head' });
  head.appendChild(el('span', { class: 'sidebar-title', text: '分类' }));
  root.appendChild(head);

  const scroll = el('div', { class: 'sidebar-scroll' });
  root.appendChild(scroll);

  /* ------------------------------ 事件委托 ------------------------------ */
  root.addEventListener('click', async (event) => {
    // 快捷入口
    const quick = event.target.closest('[data-quick]');
    if (quick) {
      const kind = quick.dataset.quick;
      // 先切回图库视图，再套用筛选
      store.setView('gallery');
      if (kind === 'all') store.selectAllImages();
      else if (kind === 'favorite') store.selectFavorites();
      else if (kind === 'uncategorized') store.selectUncategorized();
      return;
    }

    // 模块入口（LORA / 编辑指令 / 资产图）
    const mod = event.target.closest('[data-module]');
    if (mod) {
      store.setView(mod.dataset.module);
      return;
    }

    // 展开 / 折叠
    const caret = event.target.closest('[data-act="toggle"]');
    if (caret) {
      event.stopPropagation();
      store.toggleCategoryCollapse(caret.dataset.id);
      return;
    }

    // 分类操作按钮
    const action = event.target.closest('[data-act="rename"], [data-act="delete"], [data-act="rule"]');
    if (action) {
      event.stopPropagation();
      const id = action.dataset.id;
      if (action.dataset.act === 'rename') await handleRename(id);
      else if (action.dataset.act === 'rule') await handleRule(id);
      else await handleDelete(id);
      return;
    }

    // 新建分类
    if (event.target.closest('[data-act="new-category"]')) {
      await handleNewCategory();
      return;
    }

    // 选中分类
    const row = event.target.closest('[data-cat-id]');
    if (row) {
      const id = row.dataset.catId;
      const level = Number(row.dataset.catLevel);
      if (level === 2) store.selectSubCategory(id);
      else store.selectCategory(id);
      // 在 LORA / 资产图 / 编辑指令 / 模板这些模块页点分类时，要切回图库 ——
      // 否则只改了筛选条件，页面还停在模块页，看起来像「点了没反应」。
      if (store.state.view !== 'gallery') store.setView('gallery');
    }
  });

  /* ------------------------------ 渲染 ------------------------------ */
  function render() {
    scroll.innerHTML = '';

    const { counts } = store.state;

    // 快捷入口
    const onGallery = store.state.view === 'gallery';
    const fixed = el('nav', { class: 'side-fixed' });
    fixed.appendChild(quickItem('all', 'grid', '全部图片', counts.total, onGallery && store.state.filter.kind === 'all'));
    fixed.appendChild(quickItem('favorite', 'heart', '收藏', counts.favorite, onGallery && store.state.filter.kind === 'favorite'));
    fixed.appendChild(quickItem('uncategorized', 'folderOpen', '未分类', counts.uncategorized, onGallery && store.state.filter.kind === 'uncategorized'));
    scroll.appendChild(fixed);

    scroll.appendChild(el('div', { class: 'side-divider' }));

    // v2 模块入口
    const modules = el('nav', { class: 'side-fixed' });
    modules.appendChild(moduleItem('loras', 'tag', 'LORA触发词', store.state.loras.length));
    modules.appendChild(moduleItem('edits', 'pencil', '编辑指令提示词', store.state.edits.length));
    modules.appendChild(moduleItem('assets', 'image', '资产图', store.state.assets.length));
    modules.appendChild(moduleItem('prompts', 'code', 'LLM系统提示词模板', store.state.systemPrompts.length));
    scroll.appendChild(modules);

    scroll.appendChild(el('div', { class: 'side-divider' }));

    // 分类树
    const tree = el('div', { class: 'cat-children' });
    const tops = store.topCategories();
    if (!tops.length) {
      tree.appendChild(el('div', { class: 'muted', style: { padding: '8px 8px' }, text: '暂无分类，点击下方新建' }));
    }
    for (const top of tops) {
      tree.appendChild(buildTopRow(top));
      const subs = store.subCategoriesOf(top.id);
      const collapsed = Boolean((store.state.settings.collapsed || {})[top.id]);
      const children = el('div', { class: `cat-children${collapsed ? ' collapsed' : ''}` });
      for (const sub of subs) children.appendChild(buildSubRow(sub));
      tree.appendChild(children);
    }
    scroll.appendChild(tree);

    // 新建分类
    const foot = el('div', { class: 'side-foot' });
    const addBtn = el('button', { class: 'side-item side-add', type: 'button', dataset: { act: 'new-category' } });
    addBtn.appendChild(el('span', { class: 'side-ico', html: icon('plus', 16) }));
    addBtn.appendChild(el('span', { class: 'side-label', text: '新建分类' }));
    foot.appendChild(addBtn);
    scroll.appendChild(foot);
  }

  function quickItem(kind, iconName, label, count, active) {
    const btn = el('button', {
      class: `side-item${active ? ' active' : ''}`,
      type: 'button',
      dataset: { quick: kind }
    });
    btn.appendChild(el('span', { class: 'side-ico', html: icon(iconName, 16) }));
    btn.appendChild(el('span', { class: 'side-label', text: label }));
    btn.appendChild(el('span', { class: 'badge', text: String(count || 0) }));
    return btn;
  }

  /** v2 模块入口（LORA / 编辑指令 / 资产图） */
  function moduleItem(view, iconName, label, count) {
    const btn = el('button', {
      class: `side-item${store.state.view === view ? ' active' : ''}`,
      type: 'button',
      dataset: { module: view }
    });
    btn.appendChild(el('span', { class: 'side-ico', html: icon(iconName, 16) }));
    btn.appendChild(el('span', { class: 'side-label', text: label }));
    btn.appendChild(el('span', { class: 'badge', text: String(count || 0) }));
    return btn;
  }

  function buildTopRow(category) {
    const isActive = store.state.filter.kind === 'category'
      && store.state.filter.categoryId === category.id
      && !store.state.filter.subCategoryId;
    const collapsed = Boolean((store.state.settings.collapsed || {})[category.id]);
    const row = el('div', {
      class: `cat-row lv1 ${collapsed ? 'collapsed' : 'expanded'}${isActive ? ' active' : ''}`,
      dataset: { catId: category.id, catLevel: '1' },
      style: { '--cat-color': category.color || 'var(--accent)' }
    });

    const caret = el('button', {
      class: 'cat-caret', type: 'button', title: collapsed ? '展开' : '折叠',
      dataset: { act: 'toggle', id: category.id },
      html: icon('chevronRight', 14)
    });
    row.appendChild(caret);
    row.appendChild(el('span', { class: 'cat-dot' }));
    row.appendChild(el('span', { class: 'cat-name', text: category.name }));
    row.appendChild(el('span', { class: 'cat-count', text: String(store.state.counts.byCategory[category.id] || 0) }));

    const actions = el('span', { class: 'cat-actions' });
    actions.appendChild(el('button', {
      class: 'cat-act', type: 'button', title: '重命名',
      dataset: { act: 'rename', id: category.id }, html: icon('pencil', 13)
    }));
    actions.appendChild(el('button', {
      class: 'cat-act danger', type: 'button', title: '删除',
      dataset: { act: 'delete', id: category.id }, html: icon('trash', 13)
    }));
    row.appendChild(actions);
    return row;
  }

  function buildSubRow(category) {
    const isActive = store.state.filter.subCategoryId === category.id;
    const row = el('div', {
      class: `cat-row lv2${isActive ? ' active' : ''}`,
      dataset: { catId: category.id, catLevel: '2' },
      style: { '--cat-color': category.color || 'var(--accent)' }
    });
    row.appendChild(el('button', { class: 'cat-caret hidden', type: 'button', tabindex: '-1', html: icon('chevronRight', 14) }));
    row.appendChild(el('span', { class: 'cat-dot' }));
    row.appendChild(el('span', { class: 'cat-name', text: category.name }));
    row.appendChild(el('span', { class: 'cat-count', text: String(store.state.counts.bySub[category.id] || 0) }));

    const actions = el('span', { class: 'cat-actions' });
    actions.appendChild(el('button', {
      class: 'cat-act', type: 'button', title: '识别规则（自动分类用）',
      dataset: { act: 'rule', id: category.id }, html: icon('tag', 13)
    }));
    actions.appendChild(el('button', {
      class: 'cat-act', type: 'button', title: '重命名',
      dataset: { act: 'rename', id: category.id }, html: icon('pencil', 13)
    }));
    actions.appendChild(el('button', {
      class: 'cat-act danger', type: 'button', title: '删除',
      dataset: { act: 'delete', id: category.id }, html: icon('trash', 13)
    }));
    row.appendChild(actions);
    return row;
  }

  /* ------------------------------ 分类操作 ------------------------------ */

  async function handleRename(id) {
    const category = store.categoryById(id);
    if (!category) return;
    const name = await promptDialog('请输入新的分类名称', category.name, { title: '重命名分类' });
    if (!name || name === category.name) return;
    await store.updateCategory(id, { name });
    toast('分类已重命名', 'success');
  }

  /**
   * 设置二级分类的「识别规则」。
   *
   * 自动分类的关键词表是按分类名索引的（写死 22 条规则：人物/动物/建筑…）。
   * 用户把「人物」改成「女人」后，规则就匹配不上了，重新分类永远是 0 张。
   * 这个弹窗让用户手动指定：这个分类要用哪一套关键词。
   */
  async function handleRule(id) {
    const category = store.categoryById(id);
    if (!category || category.level !== 2) return;

    const keys = ruleKeys();
    const current = category.ruleKey || (keys.includes(category.name) ? category.name : '');

    const body = el('div');
    body.appendChild(el('p', {
      class: 'muted',
      style: { margin: '0 0 10px' },
      text: `「${category.name}」在「重新自动分类」时，用哪套关键词规则？`
    }));

    const select = el('select', { class: 'select' });
    select.appendChild(el('option', { value: '', text: '不自动识别（保持手动分类）' }));
    keys.forEach((k) => {
      select.appendChild(el('option', { value: k, text: k, selected: k === current ? 'selected' : null }));
    });
    body.appendChild(select);

    body.appendChild(el('p', {
      class: 'muted',
      style: { margin: '10px 0 0', fontSize: '12px' },
      text: current
        ? `当前生效：${current}`
        : '当前没有绑定规则 —— 这个分类不会被自动归类。'
    }));

    const footer = el('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } });
    const cancelBtn = el('button', { class: 'btn', type: 'button', text: '取消' });
    const okBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '保存' });
    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);

    const m = openModal({ title: '识别规则', content: body, footer });
    cancelBtn.addEventListener('click', () => m.close());
    okBtn.addEventListener('click', async () => {
      await store.updateCategory(id, { ruleKey: select.value || null });
      m.close();
      toast(select.value ? `已绑定规则「${select.value}」` : '已取消自动识别', 'success');
    });
  }

  async function handleDelete(id) {
    const category = store.categoryById(id);
    if (!category) return;
    const children = category.level === 1 ? store.subCategoriesOf(id) : [];
    const affected = store.state.images.filter((img) => img.categoryId === id || img.subCategoryId === id
      || children.some((c) => img.subCategoryId === c.id));
    const lines = [
      `确定要删除分类「${category.name}」吗？`,
      category.level === 1 ? `其下 ${children.length} 个二级分类会一并删除。` : '',
      affected.length ? `该分类下的 ${affected.length} 张图片将被移回「未分类」。` : '该分类下暂无图片。',
      '此操作不可撤销。'
    ].filter(Boolean);
    const ok = await confirmDialog(lines.join('\n'), {
      title: '删除分类', danger: true, okText: '删除'
    });
    if (!ok) return;
    await store.deleteCategory(id);
    toast('分类已删除', 'success');
  }

  async function handleNewCategory() {
    const name = await promptDialog('请输入分类名称，例如「电影感」', '', {
      title: '新建分类', placeholder: '分类名称'
    });
    if (!name) return;

    const tops = store.topCategories();
    const options = tops.map((c) => ({ value: c.id, label: c.name }));
    const parentId = await listDialog('选择层级', options, {
      label: '作为一级分类，或挂载到某个一级分类下成为二级分类',
      emptyLabel: '作为一级分类（顶层）'
    });
    if (parentId === undefined) return;

    const color = await listDialog('选择颜色', COLOR_CHOICES.map((c) => ({ value: c, label: c })), {
      label: '分类色点颜色', defaultValue: '#2f6fed'
    });
    if (color === null) return;

    const category = await store.addCategory({
      name,
      level: parentId ? 2 : 1,
      parentId: parentId || null,
      color: color || '#2f6fed'
    });
    toast(`已创建分类「${category.name}」`, 'success');
  }

  /* ------------------------------ 订阅 ------------------------------ */
  const REASONS = new Set(['all', 'images', 'categories', 'filter', 'settings', 'view', 'loras', 'edits', 'assets', 'prompts']);
  store.subscribe((reason) => { if (REASONS.has(reason)) render(); });

  render();
  return { render };
}
