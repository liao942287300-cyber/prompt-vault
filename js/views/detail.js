/* =========================================================================
 * js/views/detail.js —— 详情弹窗：大图预览 + 左右切换 + 失焦自动保存
 * ========================================================================= */

import * as store from '../store.js';
import {
  el, icon, copyAndToast, composePromptText, openModal, confirmDialog, toast,
  downloadBlob, debounce, extFromMime, baseNameNoExt
} from '../utils.js';

/** 自动保存防抖时长（毫秒） */
const SAVE_DEBOUNCE = 400;

/**
 * 挂载详情弹窗模块。
 * @param {{}} ctx
 * @returns {{open:(id:string, ids?:string[])=>void, close:()=>void, isOpen:()=>boolean}}
 */
export function mountDetail(ctx) {
  let api = null;
  let sequence = [];
  let index = -1;
  let previewUrl = null;
  let currentId = null;
  let tags = [];
  let savedTimer = null;
  let savedBadge = null;
  /** 仅弹窗「首次打开」时才把焦点落到名称输入框；翻页/重绘不再抢焦点 */
  let focusNameOnce = false;

  /** 当前图片对象 */
  function currentImage() {
    return store.imageById(currentId);
  }

  /* ------------------------------ 打开 / 关闭 ------------------------------ */

  function open(id, ids) {
    // 入口存在性校验：必须在关闭旧实例之前完成。
    // 否则「打开一张已不存在的图片」这个失败路径会把用户当前正打开的详情弹窗关掉（BUG-7）。
    if (!store.imageById(id)) { toast('图片不存在', 'error'); return; }

    const source = Array.isArray(ids) && ids.length ? ids.slice() : store.state.galleryList.map((i) => i.id);
    const next = source.filter((x) => store.imageById(x));
    if (!next.includes(id)) next.unshift(id);

    // 先把旧实例关掉：cleanup() 会重置 currentId / sequence / index，
    // 若在其之后再写入新状态，新状态会被清空，弹窗刚打开就自关（BUG-6）。
    if (api) api.close(null);

    sequence = next;
    index = Math.max(0, sequence.indexOf(id));
    currentId = sequence[index];

    savedBadge = el('span', { class: 'saved-badge', text: '已保存' });
    const instance = openModal({
      title: '图片详情',
      wide: true,
      dismissible: true,
      content: el('div', { class: 'detail-body' }),
      footer: buildFooter(),
      // 身份校验：旧实例的关闭回调不得覆盖新实例状态
      onClose: () => { if (api === instance) cleanup(); }
    });
    api = instance;
    api.head.insertBefore(savedBadge, api.head.lastElementChild);
    focusNameOnce = true;
    renderContent();
  }

  function close() {
    if (api) api.close(null);
  }

  function cleanup() {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    if (savedTimer) { clearTimeout(savedTimer); savedTimer = null; }
    // 关闭前把尚未落库的编辑补提交，避免「刚打完字立刻关闭」丢失改动
    debouncedSave.flush();
    api = null;
    currentId = null;
    sequence = [];
    index = -1;
    // 详情内的编辑是静默保存的，关闭时统一广播一次，让图库 / 数据库视图刷新
    store.emit('images');
  }

  function isOpen() {
    return Boolean(api);
  }

  /* ------------------------------ 切换图片 ------------------------------ */

  function step(delta) {
    if (!api || sequence.length < 2) return;
    // 先把当前图片未落库的编辑提交（flush 会同步读取旧表单的值再异步写库），
    // 再切换 currentId，这样翻页不会丢改动。
    debouncedSave.flush();
    index = (index + delta + sequence.length) % sequence.length;
    currentId = sequence[index];
    renderContent();
  }

  /* ------------------------------ 保存 ------------------------------ */

  function flashSaved() {
    if (!savedBadge) return;
    savedBadge.classList.add('show');
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => savedBadge.classList.remove('show'), 1400);
  }

  const debouncedSave = debounce(collectAndSave, SAVE_DEBOUNCE);

  async function collectAndSave() {
    const image = currentImage();
    if (!image || !api) return;
    const form = api.body.querySelector('.detail-form');
    if (!form) return;

    const nameInput = form.querySelector('[data-field="name"]');
    const posArea = form.querySelector('[data-field="positive"]');
    const negArea = form.querySelector('[data-field="negative"]');
    const paramArea = form.querySelector('[data-field="params"]');
    const noteArea = form.querySelector('[data-field="note"]');
    const favSwitch = form.querySelector('[data-field="favorite"]');

    // 多分类：收集每一行的大类 + 二级
    const cats = [];
    form.querySelectorAll('.cat-row').forEach((row) => {
      const sels = row.querySelectorAll('select');
      const topId = sels[0]?.value || '';
      if (!topId) return;
      cats.push({ categoryId: topId, subCategoryId: sels[1]?.value || null });
    });

    const patch = {
      name: (nameInput.value || '').trim() || '未命名',
      positive: posArea.value,
      negative: negArea.value,
      params: paramArea.value,
      note: noteArea.value,
      favorite: Boolean(favSwitch.checked),
      tags: tags.slice()
    };

    await store.updateImage(image.id, patch, { silent: true });
    // 分类单独写：要维护 categories 数组，并同步主分类字段
    await store.setImageCategories(image.id, cats, { silent: true });
    flashSaved();
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function renderContent() {
    const image = currentImage();
    if (!image || !api) { if (api) api.close(null); return; }
    api.title.textContent = image.name || '图片详情';
    tags = Array.isArray(image.tags) ? image.tags.slice() : [];

    const body = api.body;
    body.innerHTML = '';

    /* ---------- 左：预览 ---------- */
    const preview = el('div', { class: 'detail-preview' });
    const stage = el('div', { class: 'preview-stage' });
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    const blob = image.blob || image.thumb;
    if (blob) {
      previewUrl = URL.createObjectURL(blob);
      const img = el('img', { alt: image.name || '' });
      img.src = previewUrl;
      img.addEventListener('click', () => openZoom(previewUrl, image.name));
      stage.appendChild(img);
    } else {
      const ph = el('div', { class: 'preview-placeholder' });
      ph.innerHTML = `${icon('image', 40)}<span>该记录只有元数据，没有图片文件</span>`;
      stage.appendChild(ph);
      stage.style.cursor = 'default';
    }

    if (sequence.length > 1) {
      const prev = el('button', { class: 'preview-nav prev', type: 'button', title: '上一张 (←)', html: icon('chevronLeft', 18) });
      const next = el('button', { class: 'preview-nav next', type: 'button', title: '下一张 (→)', html: icon('chevronRight', 18) });
      prev.addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
      next.addEventListener('click', (e) => { e.stopPropagation(); step(1); });
      stage.appendChild(prev);
      stage.appendChild(next);
    }
    preview.appendChild(stage);

    const metaLine = el('div', { class: 'preview-meta' });
    metaLine.appendChild(el('span', {
      text: image.width && image.height ? `${image.width} × ${image.height}` : '尺寸未知'
    }));
    metaLine.appendChild(el('span', { text: `${store.getCategoryPath(image) || '未分类'}` }));
    metaLine.appendChild(el('span', { text: `${index + 1} / ${sequence.length}` }));
    preview.appendChild(metaLine);

    body.appendChild(preview);

    /* ---------- 右：表单 ---------- */
    const form = el('div', { class: 'detail-form' });

    const nameField = el('div', { class: 'field' });
    nameField.appendChild(el('label', { class: 'field-label', text: '名称' }));
    const nameInput = el('input', { class: 'input', type: 'text', dataset: { field: 'name' }, value: image.name || '' });
    nameField.appendChild(nameInput);
    form.appendChild(nameField);

    // 多分类：一行一个大类，可增删（同一大类只能选一次）
    form.appendChild(buildCategoryRows(image));

    // 标签
    const tagField = el('div', { class: 'field' });
    tagField.appendChild(el('label', { class: 'field-label', text: '标签（回车添加，点 × 删除）' }));
    const tagWrap = el('div', { class: 'tag-input-wrap' });
    const tagInput = el('input', { class: 'tag-input', type: 'text', placeholder: '输入标签后回车' });
    form.appendChild(tagField);
    tagField.appendChild(tagWrap);

    function renderTags() {
      tagWrap.innerHTML = '';
      tags.forEach((tag, i) => {
        const chip = el('span', { class: 'chip' });
        chip.appendChild(el('span', { text: tag }));
        const rm = el('button', { class: 'chip-remove', type: 'button', title: '删除标签', html: icon('close', 11) });
        rm.addEventListener('click', () => {
          tags.splice(i, 1);
          renderTags();
          debouncedSave();
        });
        chip.appendChild(rm);
        tagWrap.appendChild(chip);
      });
      tagWrap.appendChild(tagInput);
    }
    function commitTagFromInput() {
      const value = tagInput.value.trim().replace(/[,，]/g, '');
      if (!value) return;
      if (!tags.includes(value)) tags.push(value);
      tagInput.value = '';
      renderTags();
      tagInput.focus();
      debouncedSave();
    }
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitTagFromInput(); }
      else if (e.key === 'Backspace' && !tagInput.value && tags.length) {
        tags.pop(); renderTags(); tagInput.focus(); debouncedSave();
      }
    });
    tagInput.addEventListener('blur', commitTagFromInput);
    renderTags();

    // 提示词
    form.appendChild(buildTextarea('正向提示词', 'positive', image.positive, '描述你想要的画面…'));
    form.appendChild(buildTextarea('负向提示词', 'negative', image.negative, '不希望出现的内容…'));
    form.appendChild(buildTextarea('参数', 'params', image.params, 'Steps: 30, CFG: 7, Sampler: DPM++ 2M'));

    // 备注
    const noteField = el('div', { class: 'field' });
    noteField.appendChild(el('label', { class: 'field-label', text: '备注' }));
    noteField.appendChild(el('textarea', {
      class: 'textarea', dataset: { field: 'note' }, value: image.note || '',
      style: { minHeight: '58px' }
    }));
    form.appendChild(noteField);

    // 收藏
    const favField = el('div', { class: 'field' });
    const favLabel = el('label', { class: 'switch' });
    const favInput = el('input', { type: 'checkbox', dataset: { field: 'favorite' }, checked: Boolean(image.favorite) });
    const track = el('span', { class: 'switch-track' });
    favLabel.appendChild(favInput);
    favLabel.appendChild(track);
    favLabel.appendChild(el('span', { text: '加入收藏' }));
    favField.appendChild(favLabel);
    form.appendChild(favField);

    body.appendChild(form);

    // 变更即触发自动保存
    form.addEventListener('input', () => debouncedSave());
    form.addEventListener('change', () => debouncedSave());

    // 仅在弹窗首次打开时把焦点落到名称上，便于直接编辑；
    // 翻页（←/→）时不再抢焦点，否则 ←/→ 会被输入框吃掉导致无法切图。
    if (focusNameOnce) {
      focusNameOnce = false;
      setTimeout(() => {
        if (!api) return;
        if (nameInput.value === (image.name || '')) nameInput.focus({ preventScroll: true });
      }, 20);
    }
  }

  /**
   * 多分类编辑：每行一个「大类 + 二级」，可增删。
   *
   * 一张图可以同时属于风格 / 主体 / 场景多个大类，所以不能再是一级+二级两个固定下拉。
   * 写库时由 setImageCategories 按大类去重，同一大类只保留最后一行。
   */
  function buildCategoryRows(image) {
    const wrap = el('div', { class: 'field' });
    wrap.appendChild(el('label', { class: 'field-label', text: '分类（可添加多个大类）' }));

    const rowsWrap = el('div', { class: 'cat-rows' });
    const addBtn = el('button', { class: 'btn btn-sm', type: 'button', text: '+ 添加分类' });

    const addRow = (init = {}) => {
      const row = el('div', { class: 'cat-row' });
      const topSel = el('select', { class: 'select' });
      const subSel = el('select', { class: 'select' });

      topSel.appendChild(el('option', { value: '', text: '选择大类' }));
      store.topCategories().forEach((c) => topSel.appendChild(el('option', { value: c.id, text: c.name })));
      topSel.value = init.categoryId || '';

      const fillSubs = (parentId, selected) => {
        subSel.innerHTML = '';
        subSel.appendChild(el('option', { value: '', text: '未指定' }));
        store.subCategoriesOf(parentId).forEach((c) => subSel.appendChild(el('option', { value: c.id, text: c.name })));
        subSel.value = selected || '';
      };
      fillSubs(topSel.value, init.subCategoryId);

      topSel.addEventListener('change', () => {
        fillSubs(topSel.value, '');
        debouncedSave();
      });
      subSel.addEventListener('change', () => debouncedSave());

      const delBtn = el('button', { class: 'cat-act danger', type: 'button', title: '删除这条分类', html: icon('trash', 13) });
      delBtn.addEventListener('click', () => {
        row.remove();
        // 至少留一行，否则没法再加回来
        if (!rowsWrap.children.length) addRow();
        debouncedSave();
      });

      row.appendChild(topSel);
      row.appendChild(subSel);
      row.appendChild(delBtn);
      rowsWrap.appendChild(row);
    };

    const existing = store.getImageCategories(image);
    if (existing.length) existing.forEach((c) => addRow(c));
    else addRow();

    addBtn.addEventListener('click', () => {
      addRow();
      debouncedSave();
    });

    wrap.appendChild(rowsWrap);
    wrap.appendChild(addBtn);
    return wrap;
  }

  function buildCategoryField(image, field, label, level) {
    const wrap = el('div', { class: 'field' });
    wrap.appendChild(el('label', { class: 'field-label', text: label }));
    const select = el('select', { class: 'select', dataset: { field } });

    if (level === 1) {
      select.appendChild(el('option', { value: '', text: '未分类' }));
      store.topCategories().forEach((c) => select.appendChild(el('option', { value: c.id, text: c.name })));
      select.value = image.categoryId || '';
    } else {
      const buildOptions = (parentId) => {
        select.innerHTML = '';
        select.appendChild(el('option', { value: '', text: '未指定' }));
        store.subCategoriesOf(parentId).forEach((c) => select.appendChild(el('option', { value: c.id, text: c.name })));
      };
      buildOptions(image.categoryId);
      select.value = image.subCategoryId || '';
      // 一级分类变化时联动刷新二级
      const catSelect = () => api.body.querySelector('[data-field="categoryId"]');
      select.addEventListener('focus', () => {
        const parent = catSelect();
        const parentId = parent ? parent.value : image.categoryId;
        const previous = select.value;
        buildOptions(parentId);
        select.value = previous && store.categoryById(previous) && store.categoryById(previous).parentId === parentId
          ? previous : '';
      });
    }
    wrap.appendChild(select);
    return wrap;
  }

  function buildTextarea(label, field, value, placeholder) {
    const wrap = el('div', { class: 'field' });
    wrap.appendChild(el('label', { class: 'field-label', text: label }));
    wrap.appendChild(el('textarea', {
      class: 'textarea', dataset: { field }, value: value || '', placeholder
    }));
    return wrap;
  }

  function buildFooter() {
    const footer = el('div', { class: 'modal-foot', style: { width: '100%' } });

    const copyPos = el('button', { class: 'btn btn-sm', type: 'button' });
    copyPos.innerHTML = `${icon('copy', 14)}<span>复制正向</span>`;
    copyPos.addEventListener('click', () => {
      const image = currentImage(); if (!image) return;
      copyAndToast(image.positive, '已复制正向提示词');
    });

    const copyNeg = el('button', { class: 'btn btn-sm', type: 'button' });
    copyNeg.innerHTML = `${icon('copy', 14)}<span>复制负向</span>`;
    copyNeg.addEventListener('click', () => {
      const image = currentImage(); if (!image) return;
      copyAndToast(image.negative, '已复制负向提示词');
    });

    const copyAll = el('button', { class: 'btn btn-sm', type: 'button' });
    copyAll.innerHTML = `${icon('copy', 14)}<span>复制全部</span>`;
    copyAll.addEventListener('click', () => {
      const image = currentImage(); if (!image) return;
      copyAndToast(composePromptText(image), '已复制完整提示词');
    });

    const download = el('button', { class: 'btn btn-sm', type: 'button' });
    download.innerHTML = `${icon('download', 14)}<span>下载原图</span>`;
    download.addEventListener('click', () => {
      const image = currentImage(); if (!image) return;
      if (!image.blob) { toast('该记录没有图片文件', 'warn'); return; }
      const ext = extFromMime(image.mime || image.blob.type);
      const base = baseNameNoExt(image.name || 'image') || 'image';
      downloadBlob(image.blob, `${base}.${ext}`);
    });

    const del = el('button', { class: 'btn btn-sm btn-danger', type: 'button' });
    del.innerHTML = `${icon('trash', 14)}<span>删除</span>`;
    del.addEventListener('click', async () => {
      const image = currentImage(); if (!image) return;
      const ok = await confirmDialog(`确定要删除「${image.name || '未命名'}」吗？此操作不可撤销。`, {
        title: '删除图片', danger: true, okText: '删除'
      });
      if (!ok) return;
      await store.removeImages([image.id]);
      toast('已删除', 'success');
      const nextId = sequence.filter((x) => x !== image.id)[0];
      if (nextId && store.imageById(nextId)) {
        const rest = sequence.filter((x) => x !== image.id);
        open(nextId, rest);
      } else {
        close();
      }
    });

    footer.appendChild(copyPos);
    footer.appendChild(copyNeg);
    footer.appendChild(copyAll);
    footer.appendChild(download);
    footer.appendChild(el('span', { class: 'spacer' }));
    footer.appendChild(del);
    return footer;
  }

  /* ------------------------------ 放大预览 ------------------------------ */

  function openZoom(url, name) {
    const layer = el('div', { class: 'zoom-layer' });
    let destroyed = false;
    layer.appendChild(el('img', { src: url, alt: name || '' }));
    document.body.appendChild(layer);

    // 统一销毁入口：无论「点遮罩关闭」还是「按 Esc 关闭」都会摘掉全局监听，不留残留。
    // destroyed 保证幂等 —— 遮罩点击与 Esc 可能先后各触发一次。
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      document.removeEventListener('keydown', onKey, true); // 必须带 true，否则摘不掉捕获监听
      if (layer.parentNode) layer.remove();
    };

    // Esc 由放大层独占消费：捕获阶段 + stopImmediatePropagation，
    // 避免事件继续传给 utils.js 里「关闭最上层弹窗」的冒泡监听，导致详情弹窗被连带关掉。
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation(); // 阻断同层其它监听
      e.stopPropagation();          // 阻断冒泡到 window 等
      destroy();
    };

    layer.addEventListener('click', destroy);
    document.addEventListener('keydown', onKey, true); // 捕获阶段：先于 utils.js 的冒泡监听
  }

  /* ------------------------------ 快捷键 ------------------------------ */

  document.addEventListener('keydown', (e) => {
    if (!api) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const active = document.activeElement;
    const tag = (active && active.tagName) || '';
    // 多行文本域/下拉框/可编辑区：←/→ 是浏览器的光标移动与选项切换，必须原样放行，不拦截
    if (tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(active && active.isContentEditable)) return;
    e.preventDefault();
    // 单行输入框：←/→ 会被当成光标移动而吃掉，先失焦再翻页；
    // step() 内部会 flush 掉未落库的编辑，不会丢改动。
    if (tag === 'INPUT' && typeof active.blur === 'function') active.blur();
    step(e.key === 'ArrowLeft' ? -1 : 1);
  });

  return { open, close, isOpen };
}
