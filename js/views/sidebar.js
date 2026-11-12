/* =========================================================================
 * js/views/sidebar.js —— 左栏：快捷入口 + 两级分类树 + 分类管理
 * ========================================================================= */

import * as store from '../store.js';
import { el, icon, confirmDialog, promptDialog, listDialog, toast, openModal } from '../utils.js';
import { ruleKeys, ruleKeywords, fallbackRuleName } from '../auto-classify.js';

/** 新建分类时可选的颜色 */
const COLOR_CHOICES = ['#2f6fed', '#0f9d58', '#8b5cf6', '#e8973a', '#0ea5b7', '#d946a0', '#d92d20', '#66717d'];

/**
 * 快速填充下拉里「清除绑定」这一项的哨兵值。
 *
 * 为什么需要它：`ruleKey` 是「关键词留空时用哪条内置规则」，保存时「不填充」要保留原绑定
 * （否则用户清空关键词就丢了上次绑的规则）。但这样 ruleKey 一旦有值就再也改不回来 ——
 * 用户误绑了「人物」，UI 里没有任何操作能让他回到「按分类名匹配」。
 * 所以给一个显式的第三态：选了它 = 明确要求解绑，ruleKey 置 null。
 *
 * 必须不会和任何内置规则名撞车（ruleKeys() 里没有这个字符串，已在回归里断言）。
 */
const CLEAR_RULE_KEY = '__clear__';

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
      else if (kind === 'noPrompt') store.selectNoPrompt();
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

    // 一级分类下的「+ 新建子分类」
    const subAdd = event.target.closest('[data-act="new-sub"]');
    if (subAdd) {
      event.stopPropagation();   // 别顺带触发选中该分类
      await handleNewCategory(subAdd.dataset.parent);
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
    fixed.appendChild(quickItem('noPrompt', 'noText', '无提示词', counts.noPrompt, onGallery && store.state.filter.kind === 'noPrompt'));
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
    // 加号：在这个一级分类下新建二级分类
    actions.appendChild(el('button', {
      class: 'cat-act', type: 'button', title: '新建子分类',
      dataset: { act: 'new-sub', parent: category.id }, html: icon('plus', 13)
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
      class: 'cat-act', type: 'button', title: '识别关键词（自动分类用）',
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
   * 编辑二级分类的「识别关键词」。
   *
   * 自动分类的关键词原本写死在 auto-classify.js 的 SUB_KEYWORDS 里（22 条规则，按分类名索引）。
   * 用户把「人物」改成「女人」后，规则表里没有「女人」这条，重新分类永远是 0 张
   * —— 提示词里写的是 1girl / woman / 少女，跟「女人」两个字字面上完全对不上。
   *
   * 这个弹窗把「用哪些词判断这个分类」交给用户：
   *   - 留空 → 回落到内置规则（按 ruleKey 或分类名）；
   *   - 填了 → 只用这组词，内置规则和分类名兜底都不再参与（见 auto-classify.js）。
   *
   * 关键：填自定义词时**不会**清掉 ruleKey（见下面的保存逻辑）。ruleKey 是「留空时
   * 用哪条内置规则」，跟自定义词是两个独立的概念；清掉它会让用户填过一次自定义词后
   * 就永久失去「上次绑定的规则」，清空关键词时只能退回按分类名匹配，常常就匹配不上了。
   */
  async function handleRule(id) {
    const category = store.categoryById(id);
    if (!category || category.level !== 2) return;

    const keys = ruleKeys();
    // 用户已保存的自定义关键词（保留原始大小写，只用于回显）
    const customWords = (Array.isArray(category.keywords) ? category.keywords : [])
      .map((word) => String(word == null ? '' : word).trim())
      .filter(Boolean);
    // 「关键词清空后会用哪条内置规则」—— 与 keywords 无关，所以填了自定义词时依然有值
    const fallbackRule = fallbackRuleName(category);

    const body = el('div');
    body.appendChild(el('p', {
      class: 'muted',
      style: { margin: '0 0 8px', lineHeight: '1.7' },
      text: `这些词出现在提示词里，就把图归到「${category.name}」。一行一个，或用逗号隔开。`
    }));

    // 预填策略：有自定义词就显示自定义词；否则把内置规则的关键词摊出来，
    // 让用户看到「默认会命中哪些词」，在默认值上改两个字即可，不用从零写。
    const textarea = el('textarea', {
      class: 'textarea',
      rows: '8',
      placeholder: '例如：\n女人\n女性\n少女\ngirl\nwoman\n1girl',
      value: customWords.length ? customWords.join('\n') : ruleKeywords(fallbackRule).join('\n')
    });
    body.appendChild(textarea);

    /* 快速填充：把某条内置规则的关键词整段覆盖进文本框 */
    const quickRow = el('div', {
      style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '10px 0 0' }
    });
    quickRow.appendChild(el('span', {
      class: 'muted',
      style: { fontSize: '12px', whiteSpace: 'nowrap', flex: '0 0 auto' },
      text: '快速填充'
    }));
    const select = el('select', { class: 'select', style: { width: 'auto', flex: '1 1 auto' } });
    select.appendChild(el('option', { value: '', text: '不填充（留空则用内置规则）' }));
    keys.forEach((key) => {
      select.appendChild(el('option', { value: key, text: key }));
    });
    // 第三态：明确解绑。放在最后，和「不填充」区分开 ——
    // 「不填充」= 这次不动绑定（保留上次绑的），「清除绑定」= 把绑定删掉。
    select.appendChild(el('option', { value: CLEAR_RULE_KEY, text: '按分类名匹配（清除绑定）' }));
    // 默认选中「上次绑定的规则」：文本框留空时它就是保存后的 ruleKey
    select.value = fallbackRule || '';
    quickRow.appendChild(select);

    // 选「清除绑定」时立刻清空文本框。
    // 不清的话，预填的内置词会被当成自定义关键词存下去 ——
    // 结果 toast 说"已清除规则绑定"，实际只是把内置规则换成了同样内容的
    // 自定义词，匹配行为一点没变，用户会以为解绑失败。
    select.addEventListener('change', () => {
      if (select.value === CLEAR_RULE_KEY) textarea.value = '';
    });

    const fillBtn = el('button', {
      class: 'btn', type: 'button', text: '填入', style: { flex: '0 0 auto' }
    });
    quickRow.appendChild(fillBtn);
    body.appendChild(quickRow);

    fillBtn.addEventListener('click', () => {
      // 「不填充」和「清除绑定」都不要内置规则的词 → 清空文本框
      const picked = select.value;
      textarea.value = (picked && picked !== CLEAR_RULE_KEY) ? ruleKeywords(picked).join('\n') : '';
    });

    body.appendChild(el('div', {
      class: 'muted',
      style: { margin: '10px 0 0', fontSize: '12px', lineHeight: '1.8' },
      html: '· 留空 = 用内置规则（按分类名或上次绑定的规则）<br>· 填了 = 只用你填的词，不再看分类名'
        + '<br>· 英文按整词匹配：「1girl」里的「girl」不算命中，要把「1girl」本身写进去'
    }));

    const footer = el('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } });
    const cancelBtn = el('button', { class: 'btn', type: 'button', text: '取消' });
    const okBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '保存' });
    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);

    const m = openModal({ title: `识别规则 · ${category.name}`, content: body, footer });
    cancelBtn.addEventListener('click', () => m.close());

    okBtn.addEventListener('click', async () => {
      // 分隔符与 auto-classify.js 的 KEYWORD_SEPARATORS 一致：换行 / 半角逗号 / 全角逗号 / 顿号
      const words = textarea.value
        .split(/[\n,，、]/)
        .map((word) => word.trim())
        .filter(Boolean);
      // 去重（大小写不敏感）：用户手敲出重复词时不该存两遍
      const unique = [];
      const seen = new Set();
      for (const word of words) {
        const lower = word.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        unique.push(word);
      }

      // ruleKey 有三种意图，必须显式区分 —— 不能用 `select.value || category.ruleKey || null`
      // 这种 `||` 链：那样「清除绑定」会被当成「没选」，ruleKey 永远粘住改不回来。
      //   1. 选中哨兵 CLEAR_RULE_KEY → 解绑，ruleKey = null（回到按分类名匹配）；
      //   2. 选中某条具体规则      → 绑定它；
      //   3. 停在「不填充」        → 保留分类原有的 ruleKey（P3：清空关键词后还能回退）。
      const picked = select.value;
      let nextRuleKey;
      if (picked === CLEAR_RULE_KEY) {
        nextRuleKey = null;
      } else if (picked) {
        nextRuleKey = picked;
      } else {
        nextRuleKey = category.ruleKey || null;
      }

      await store.updateCategory(id, {
        // 空数组 = 不再有自定义词。必须写 []（而不是 undefined），
        // 否则用户清空时旧关键词会留在 IndexedDB 里删不掉。
        keywords: unique,
        ruleKey: nextRuleKey
      });
      m.close();
      if (picked === CLEAR_RULE_KEY) toast('已清除规则绑定，改按分类名匹配', 'success');
      else toast(unique.length ? `已保存 ${unique.length} 个关键词` : '已改为使用内置规则', 'success');
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

  /**
   * 新建分类。
   *
   * @param {string} [parentId] 传了就在该一级分类下建二级（颜色继承父级）；
   *        不传就是底部入口，直接建一级 —— 不再问「要不要挂到某个一级下」，
   *        建二级的入口是一级分类行上的加号。
   */
  async function handleNewCategory(parentId) {
    const parent = parentId ? store.categoryById(parentId) : null;

    const name = await promptDialog(
      parent ? `在「${parent.name}」下新建二级分类` : '请输入一级分类名称，例如「电影感」',
      '',
      { title: parent ? '新建二级分类' : '新建一级分类', placeholder: '分类名称' }
    );
    if (!name) return;

    let color = parent ? parent.color : null;
    if (!parentId) {
      const picked = await listDialog('选择颜色', COLOR_CHOICES.map((c) => ({ value: c, label: c })), {
        label: '分类色点颜色', defaultValue: '#2f6fed'
      });
      if (picked === null) return;
      color = picked || '#2f6fed';
    }

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
