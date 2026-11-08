/* =========================================================================
 * js/views/prompts.js —— LLM 系统提示词模板
 *
 * 只存纯文本的系统提示词（system prompt），不配图。
 * 适合存角色设定、输出格式约束、工作流规则这类长期复用的指令。
 * ========================================================================= */

import * as store from '../store.js';
import {
  el, icon, toast, confirmDialog, openModal, formatDate, copyText
} from '../utils.js';

/**
 * 挂载系统提示词模板视图。
 * @param {{}} ctx
 * @returns {{render:()=>void}}
 */
export function mountPrompts(ctx) {
  const root = document.getElementById('view-prompts');
  if (!root) return { render: () => {} };
  root.innerHTML = '';

  /* ------------------------------ 骨架 ------------------------------ */
  const head = el('div', { class: 'mod-head' });
  head.appendChild(el('div', { class: 'mod-head-main' }, [
    el('h2', { class: 'mod-title', text: 'LLM 系统提示词模板' }),
    el('p', { class: 'mod-desc', text: '存放喂给大模型的系统提示词：角色设定、输出格式约束、工作流规则。只存文本，不配图。' })
  ]));
  const headActions = el('div', { class: 'mod-actions' });
  const newBtn = el('button', { class: 'btn btn-primary', type: 'button' });
  newBtn.innerHTML = `${icon('plus', 15)}<span>新建模板</span>`;
  headActions.appendChild(newBtn);
  head.appendChild(headActions);
  root.appendChild(head);

  const statLine = el('div', { class: 'mod-stat', text: '' });
  root.appendChild(statLine);

  const grid = el('div', { class: 'prompt-grid' });
  root.appendChild(grid);

  // 分页条：模板多了以后一页全渲染会卡
  const pager = el('div', { class: 'asset-pager' });
  root.appendChild(pager);

  /** 当前页码（1 基）与每页条数 */
  let page = 1;
  const PAGE_SIZE = 48;

  function renderPager(total, pages) {
    pager.innerHTML = '';
    if (pages <= 1) return;
    const mkBtn = (label, target, disabled) => {
      const btn = el('button', {
        class: 'btn btn-sm', type: 'button', text: label,
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
      text: `第 ${from}-${to} 条 / 共 ${total} 条 · 第 ${page} / ${pages} 页`
    }));
    pager.appendChild(mkBtn('下一页', Math.min(pages, page + 1), page >= pages));
  }

  newBtn.addEventListener('click', () => openEditor(null));

  /* ---------------------------- 编辑器 ---------------------------- */

  /**
   * 打开编辑弹窗。
   * @param {object|null} item 传 null 表示新建
   */
  function openEditor(item) {
    const draft = {
      title: item ? item.title || '' : '',
      content: item ? item.content || '' : '',
      tags: item ? (item.tags || []).slice() : []
    };

    const wrap = el('div', { class: 'edit-editor' });

    /* 标题 */
    const titleField = el('div', { class: 'field' });
    titleField.appendChild(el('label', { class: 'field-label', text: '模板名称' }));
    const titleInput = el('input', {
      class: 'input', type: 'text',
      placeholder: '例如：小红书文案助手 / 代码审查员',
      value: draft.title
    });
    titleInput.addEventListener('input', () => { draft.title = titleInput.value; });
    titleField.appendChild(titleInput);
    wrap.appendChild(titleField);

    /* 系统提示词正文 */
    const bodyField = el('div', { class: 'field' });
    const labelRow = el('div', { class: 'field-label-row' });
    labelRow.appendChild(el('span', { class: 'field-label', text: '系统提示词' }));
    const counter = el('span', { class: 'field-counter', text: `${draft.content.length} 字` });
    labelRow.appendChild(counter);
    bodyField.appendChild(labelRow);

    const textArea = el('textarea', {
      class: 'textarea prompt-content-input',
      rows: '16',
      placeholder: '你是一位……\n\n要求：\n1. ……\n2. ……'
    });
    textArea.value = draft.content;
    textArea.addEventListener('input', () => {
      draft.content = textArea.value;
      counter.textContent = `${draft.content.length} 字`;
    });
    bodyField.appendChild(textArea);
    bodyField.appendChild(el('div', {
      class: 'field-hint',
      text: '这里的内容会作为 system role 直接喂给模型，换行和空行都会原样保留。'
    }));
    wrap.appendChild(bodyField);

    /* 标签 */
    const tagField = el('div', { class: 'field' });
    tagField.appendChild(el('label', { class: 'field-label', text: '标签（逗号分隔，可选）' }));
    const tagInput = el('input', {
      class: 'input', type: 'text', placeholder: '写作, 代码, 翻译',
      value: draft.tags.join(', ')
    });
    tagInput.addEventListener('input', () => {
      draft.tags = tagInput.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    });
    tagField.appendChild(tagInput);
    wrap.appendChild(tagField);

    /* 底部 */
    const footer = el('div', { class: 'modal-foot', style: { width: '100%' } });
    footer.appendChild(el('span', { class: 'muted', text: '只存在本机，不会上传' }));
    footer.appendChild(el('span', { class: 'spacer' }));

    const cancelBtn = el('button', { class: 'btn', type: 'button', text: '取消' });
    const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '保存' });
    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);

    let modal = null;
    cancelBtn.addEventListener('click', () => { if (modal) modal.close(null); });

    saveBtn.addEventListener('click', async () => {
      const content = draft.content.trim();
      if (!content) { toast('系统提示词不能为空', 'warn'); textArea.focus(); return; }

      saveBtn.disabled = true;
      try {
        const payload = {
          title: draft.title.trim() || '未命名模板',
          content,
          tags: draft.tags
        };
        if (item) await store.updateSystemPrompt(item.id, payload);
        else await store.addSystemPrompt(payload);
        toast(item ? '已保存' : '已新建模板', 'success');
        if (modal) modal.close(null);
      } catch (err) {
        console.error('[PromptVault] 保存系统提示词失败', err);
        toast('保存失败，请查看控制台', 'error');
        saveBtn.disabled = false;
      }
    });

    modal = openModal({
      title: item ? '编辑系统提示词' : '新建系统提示词',
      content: wrap,
      footer,
      wide: true
    });
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function render() {
    grid.innerHTML = '';

    const list = store.filteredSystemPrompts();
    const total = store.state.systemPrompts.length;
    const totalChars = store.state.systemPrompts.reduce((s, p) => s + (p.content || '').length, 0);
    statLine.textContent = total
      ? `共 ${total} 个模板，合计 ${totalChars.toLocaleString()} 字${store.state.search ? `，当前筛选出 ${list.length} 个` : ''}`
      : '';

    if (!total) {
      grid.appendChild(emptyState('还没有系统提示词', '点击「新建模板」，把常用的系统设定存下来，用的时候一键复制'));
      return;
    }
    if (!list.length) {
      grid.appendChild(emptyState('没有匹配的模板', '换个关键字试试，或清空搜索框'));
      return;
    }

    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * PAGE_SIZE;

    for (const item of list.slice(start, start + PAGE_SIZE)) {
      grid.appendChild(buildCard(item));
    }
    renderPager(list.length, pages);
  }

  function buildCard(item) {
    const card = el('div', { class: 'prompt-card' });

    const body = el('div', { class: 'prompt-card-body' });
    body.appendChild(el('div', { class: 'prompt-card-title', text: item.title || '未命名模板' }));
    body.appendChild(el('div', { class: 'prompt-card-text', text: item.content }));

    if ((item.tags || []).length) {
      const tags = el('div', { class: 'edit-card-tags' });
      item.tags.forEach((t) => tags.appendChild(el('span', { class: 'chip', text: t })));
      body.appendChild(tags);
    }

    const foot = el('div', { class: 'prompt-card-foot' });
    foot.appendChild(el('span', {
      class: 'muted',
      text: `${(item.content || '').length} 字 · ${formatDate(item.updatedAt || item.createdAt)}`
    }));

    const acts = el('span', { class: 'edit-card-acts' });
    const copyBtn = el('button', { class: 'cat-act', type: 'button', title: '复制系统提示词', html: icon('copy', 13) });
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await copyText(item.content || '');
      toast(ok ? '系统提示词已复制' : '复制失败', ok ? 'success' : 'error');
    });
    const editBtn = el('button', { class: 'cat-act', type: 'button', title: '编辑', html: icon('pencil', 13) });
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); openEditor(item); });
    const delBtn = el('button', { class: 'cat-act danger', type: 'button', title: '删除', html: icon('trash', 13) });
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog(`确定删除「${item.title || '未命名模板'}」吗？此操作不可撤销。`, {
        title: '删除系统提示词', danger: true, okText: '删除'
      });
      if (!ok) return;
      await store.removeSystemPrompts([item.id]);
      toast('已删除', 'success');
    });
    acts.appendChild(copyBtn);
    acts.appendChild(editBtn);
    acts.appendChild(delBtn);
    foot.appendChild(acts);
    body.appendChild(foot);

    card.appendChild(body);
    card.addEventListener('click', () => openEditor(item));
    return card;
  }

  function emptyState(title, desc) {
    const box = el('div', { class: 'empty-state' });
    box.appendChild(el('div', { class: 'empty-ico', html: icon('code', 30) }));
    box.appendChild(el('div', { class: 'empty-title', text: title }));
    box.appendChild(el('div', { class: 'empty-desc', text: desc }));
    return box;
  }

  const REASONS = new Set(['all', 'prompts', 'search']);
  store.subscribe((reason) => { if (REASONS.has(reason)) render(); });

  render();
  return { render };
}
