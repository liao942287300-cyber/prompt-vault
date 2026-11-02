/* =========================================================================
 * js/views/edits.js —— 编辑指令提示词
 *
 * 存放「图生图 / 局部重绘」用的编辑指令，可选配「原图 + 编辑后」对比图。
 * 不配图时就是一条纯文本指令。
 * 配图会压缩到 300KB 以内（与主图库一致）；资产图另走 assets 模块存原图。
 * ========================================================================= */

import * as store from '../store.js';
import {
  el, icon, toast, confirmDialog, openModal, formatDate,
  compressImage, genThumbnail, sha256Hex, copyText, MAX_IMAGE_BYTES
} from '../utils.js';

/**
 * 挂载编辑指令视图。
 * @param {{}} ctx
 * @returns {{render:()=>void}}
 */
export function mountEdits(ctx) {
  const root = document.getElementById('view-edits');
  if (!root) return { render: () => {} };
  root.innerHTML = '';

  /** 当前渲染产生的 objectURL，重绘前统一释放 */
  let liveUrls = [];
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
    el('h2', { class: 'mod-title', text: '编辑指令提示词' }),
    el('p', { class: 'mod-desc', text: '存图生图 / 局部重绘用的编辑指令。可以配上「原图 → 编辑后」的对比图，也可以只存文字。' })
  ]));
  const headActions = el('div', { class: 'mod-actions' });
  const newBtn = el('button', { class: 'btn btn-primary', type: 'button' });
  newBtn.innerHTML = `${icon('plus', 15)}<span>新建指令</span>`;
  headActions.appendChild(newBtn);
  head.appendChild(headActions);
  root.appendChild(head);

  const statLine = el('div', { class: 'mod-stat', text: '' });
  root.appendChild(statLine);

  const grid = el('div', { class: 'edit-grid' });
  root.appendChild(grid);

  newBtn.addEventListener('click', () => openEditor(null));

  /* ---------------------------- 编辑器 ---------------------------- */

  /**
   * 打开编辑弹窗。
   * @param {object|null} item 传 null 表示新建
   */
  function openEditor(item) {
    const draft = {
      title: item ? item.title || '' : '',
      instruction: item ? item.instruction || '' : '',
      tags: item ? (item.tags || []).slice() : [],
      beforeBlob: item ? item.beforeBlob || null : null,
      beforeThumb: item ? item.beforeThumb || null : null,
      beforeMime: item ? item.beforeMime || '' : '',
      beforeWidth: item ? item.beforeWidth || 0 : 0,
      beforeHeight: item ? item.beforeHeight || 0 : 0,
      afterBlob: item ? item.afterBlob || null : null,
      afterThumb: item ? item.afterThumb || null : null,
      afterMime: item ? item.afterMime || '' : '',
      afterWidth: item ? item.afterWidth || 0 : 0,
      afterHeight: item ? item.afterHeight || 0 : 0
    };

    const slotUrls = [];
    const slotUrl = (blob) => {
      if (!blob) return '';
      const u = URL.createObjectURL(blob);
      slotUrls.push(u);
      return u;
    };

    const wrap = el('div', { class: 'edit-editor' });

    /* 标题 */
    const titleField = el('div', { class: 'field' });
    titleField.appendChild(el('label', { class: 'field-label', text: '标题（可选）' }));
    const titleInput = el('input', {
      class: 'input', type: 'text', placeholder: '例如：白底转室内暖光',
      value: draft.title
    });
    titleInput.addEventListener('input', () => { draft.title = titleInput.value; });
    titleField.appendChild(titleInput);
    wrap.appendChild(titleField);

    /* 指令正文 */
    const textField = el('div', { class: 'field' });
    textField.appendChild(el('label', { class: 'field-label', text: '编辑指令' }));
    const textArea = el('textarea', {
      class: 'textarea edit-instruction-input',
      rows: '8',
      placeholder: '把这张图的背景换成黄昏海边，保留人物姿势与服装，光线改为侧逆光…'
    });
    textArea.value = draft.instruction;
    textArea.addEventListener('input', () => { draft.instruction = textArea.value; });
    textField.appendChild(textArea);
    textField.appendChild(el('div', {
      class: 'field-hint',
      text: '可以只存指令不配图。配图后卡片会显示「原图 → 编辑后」的对比。'
    }));
    wrap.appendChild(textField);

    /* 配图 */
    const imgField = el('div', { class: 'field' });
    imgField.appendChild(el('label', { class: 'field-label', text: '配图（可选）' }));
    const slotRow = el('div', { class: 'edit-slots' });

    const makeSlot = (kind, label) => {
      const slot = el('div', { class: 'edit-slot' });
      slot.appendChild(el('div', { class: 'edit-slot-label', text: label }));
      const box = el('div', { class: 'edit-slot-box' });
      const input = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
      slot.appendChild(input);
      slot.appendChild(box);

      const paint = () => {
        box.innerHTML = '';
        const thumb = kind === 'before' ? draft.beforeThumb : draft.afterThumb;
        const blob = kind === 'before' ? draft.beforeBlob : draft.afterBlob;
        if (!thumb && !blob) {
          box.classList.remove('has-img');
          box.appendChild(el('div', { class: 'edit-slot-empty', html: `${icon('plus', 20)}<span>点击选择图片</span>` }));
          return;
        }
        box.classList.add('has-img');
        const img = el('img', { src: slotUrl(thumb || blob), alt: label });
        box.appendChild(img);
        const clearBtn = el('button', { class: 'edit-slot-clear', type: 'button', title: '移除', html: icon('close', 14) });
        clearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (kind === 'before') {
            draft.beforeBlob = null; draft.beforeThumb = null;
            draft.beforeMime = ''; draft.beforeWidth = 0; draft.beforeHeight = 0;
          } else {
            draft.afterBlob = null; draft.afterThumb = null;
            draft.afterMime = ''; draft.afterWidth = 0; draft.afterHeight = 0;
          }
          paint();
        });
        box.appendChild(clearBtn);
      };

      box.addEventListener('click', () => input.click());
      input.addEventListener('change', async () => {
        const file = (input.files || [])[0];
        input.value = '';
        if (!file) return;
        box.classList.add('is-loading');
        try {
          const compressed = await compressImage(file, { maxBytes: MAX_IMAGE_BYTES });
          const { thumb, width, height } = await genThumbnail(compressed.blob || file, 640, 0.82);
          if (kind === 'before') {
            draft.beforeBlob = compressed.blob || file;
            draft.beforeThumb = thumb || null;
            draft.beforeMime = compressed.mime || file.type || '';
            draft.beforeWidth = compressed.width || width || 0;
            draft.beforeHeight = compressed.height || height || 0;
          } else {
            draft.afterBlob = compressed.blob || file;
            draft.afterThumb = thumb || null;
            draft.afterMime = compressed.mime || file.type || '';
            draft.afterWidth = compressed.width || width || 0;
            draft.afterHeight = compressed.height || height || 0;
          }
          paint();
        } catch (err) {
          console.error('[PromptVault] 配图处理失败', err);
          toast('图片处理失败，请换一张试试', 'error');
        } finally {
          box.classList.remove('is-loading');
        }
      });

      paint();
      return slot;
    };

    slotRow.appendChild(makeSlot('before', '原图'));
    slotRow.appendChild(el('div', { class: 'edit-slot-arrow', html: icon('chevronRight', 20) }));
    slotRow.appendChild(makeSlot('after', '编辑后'));
    imgField.appendChild(slotRow);
    wrap.appendChild(imgField);

    /* 标签 */
    const tagField = el('div', { class: 'field' });
    tagField.appendChild(el('label', { class: 'field-label', text: '标签（逗号分隔，可选）' }));
    const tagInput = el('input', {
      class: 'input', type: 'text', placeholder: '换背景, 打光, 扩图',
      value: draft.tags.join(', ')
    });
    tagInput.addEventListener('input', () => {
      draft.tags = tagInput.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    });
    tagField.appendChild(tagInput);
    wrap.appendChild(tagField);

    /* 底部 */
    const footer = el('div', { class: 'modal-foot', style: { width: '100%' } });
    const hint = el('span', { class: 'muted', text: '指令和配图都只存在本机' });
    footer.appendChild(hint);
    footer.appendChild(el('span', { class: 'spacer' }));

    const cancelBtn = el('button', { class: 'btn', type: 'button', text: '取消' });
    const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '保存' });
    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);

    let modal = null;
    const close = () => {
      slotUrls.forEach((u) => URL.revokeObjectURL(u));
      if (modal) modal.close(null);
    };
    cancelBtn.addEventListener('click', close);

    saveBtn.addEventListener('click', async () => {
      const instruction = draft.instruction.trim();
      if (!instruction) { toast('编辑指令不能为空', 'warn'); textArea.focus(); return; }

      saveBtn.disabled = true;
      try {
        const payload = {
          title: draft.title.trim(),
          instruction,
          tags: draft.tags,
          beforeBlob: draft.beforeBlob,
          beforeThumb: draft.beforeThumb,
          beforeMime: draft.beforeMime,
          beforeWidth: draft.beforeWidth,
          beforeHeight: draft.beforeHeight,
          afterBlob: draft.afterBlob,
          afterThumb: draft.afterThumb,
          afterMime: draft.afterMime,
          afterWidth: draft.afterWidth,
          afterHeight: draft.afterHeight
        };
        if (item) await store.updateEdit(item.id, payload);
        else await store.addEdit(payload);
        toast(item ? '已保存' : '已新建编辑指令', 'success');
        close();
      } catch (err) {
        console.error('[PromptVault] 保存编辑指令失败', err);
        toast('保存失败，请查看控制台', 'error');
        saveBtn.disabled = false;
      }
    });

    modal = openModal({
      title: item ? '编辑指令' : '新建编辑指令',
      content: wrap,
      footer,
      wide: true,
      onClose: () => { slotUrls.forEach((u) => URL.revokeObjectURL(u)); }
    });
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function render() {
    releaseUrls();
    grid.innerHTML = '';

    const list = store.filteredEdits();
    const total = store.state.edits.length;
    const withImg = store.state.edits.filter((e) => e.beforeBlob || e.afterBlob).length;
    statLine.textContent = total
      ? `共 ${total} 条指令，其中 ${withImg} 条带配图${store.state.search ? `，当前筛选出 ${list.length} 条` : ''}`
      : '';

    if (!total) {
      grid.appendChild(emptyState('还没有编辑指令', '点击「新建指令」存一条，配图可选'));
      return;
    }
    if (!list.length) {
      grid.appendChild(emptyState('没有匹配的指令', '换个关键字试试，或清空搜索框'));
      return;
    }

    for (const item of list) {
      grid.appendChild(buildCard(item));
    }
  }

  function buildCard(item) {
    const card = el('div', { class: 'edit-card' });

    const hasImg = Boolean(item.beforeThumb || item.beforeBlob || item.afterThumb || item.afterBlob);
    if (hasImg) {
      const imgs = el('div', { class: 'edit-card-imgs' });
      const before = item.beforeThumb || item.beforeBlob;
      const after = item.afterThumb || item.afterBlob;
      if (before) {
        imgs.appendChild(el('div', { class: 'edit-card-img', title: '原图' }, [
          el('img', { src: useUrl(before), alt: '原图', loading: 'lazy' })
        ]));
      }
      if (after) {
        imgs.appendChild(el('div', { class: 'edit-card-img', title: '编辑后' }, [
          el('img', { src: useUrl(after), alt: '编辑后', loading: 'lazy' })
        ]));
      }
      card.appendChild(imgs);
    } else {
      card.classList.add('no-img');
    }

    const body = el('div', { class: 'edit-card-body' });
    body.appendChild(el('div', { class: 'edit-card-title', text: item.title || '未命名指令' }));
    body.appendChild(el('div', { class: 'edit-card-text', text: item.instruction }));

    if ((item.tags || []).length) {
      const tags = el('div', { class: 'edit-card-tags' });
      item.tags.forEach((t) => tags.appendChild(el('span', { class: 'chip', text: t })));
      body.appendChild(tags);
    }

    const foot = el('div', { class: 'edit-card-foot' });
    foot.appendChild(el('span', { class: 'muted', text: formatDate(item.updatedAt || item.createdAt) }));

    const acts = el('span', { class: 'edit-card-acts' });
    const copyBtn = el('button', { class: 'cat-act', type: 'button', title: '复制指令', html: icon('copy', 13) });
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await copyText(item.instruction);
      toast(ok ? '指令已复制' : '复制失败', ok ? 'success' : 'error');
    });
    const editBtn = el('button', { class: 'cat-act', type: 'button', title: '编辑', html: icon('pencil', 13) });
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); openEditor(item); });
    const delBtn = el('button', { class: 'cat-act danger', type: 'button', title: '删除', html: icon('trash', 13) });
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog(`确定删除「${item.title || '未命名指令'}」吗？此操作不可撤销。`, {
        title: '删除编辑指令', danger: true, okText: '删除'
      });
      if (!ok) return;
      await store.removeEdits([item.id]);
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
    box.appendChild(el('div', { class: 'empty-ico', html: icon('pencil', 30) }));
    box.appendChild(el('div', { class: 'empty-title', text: title }));
    box.appendChild(el('div', { class: 'empty-desc', text: desc }));
    return box;
  }

  const REASONS = new Set(['all', 'edits', 'search']);
  store.subscribe((reason) => { if (REASONS.has(reason)) render(); });

  render();
  return { render };
}
