/* =========================================================================
 * js/views/gallery.js —— 图库视图：响应式网格 + 悬停提示卡 + 加载更多
 * ========================================================================= */

import * as store from '../store.js';
import { el, icon, toast, copyAndToast, composePromptText, confirmDialog } from '../utils.js';

/** 悬停弹出延迟（毫秒） */
const HOVER_DELAY = 250;
/** 鼠标离开后延迟隐藏（毫秒），给用户移动到卡片上的时间 */
const HIDE_DELAY = 150;
/** 点击卡片上按钮时，短暂禁止触发 hover 卡 */
const POPOVER_MAX_TEXT_LINES = { positive: 6, negative: 2 };

/**
 * 挂载图库视图。
 * @param {{openDetail:(id:string, ids?:string[])=>void, openExport:()=>void}} ctx
 */
export function mountGallery(ctx) {
  const root = document.getElementById('view-gallery');
  root.innerHTML = '';

  /* ------------------------------ 结构 ------------------------------ */
  const head = el('div', { class: 'view-head' });
  const titleBox = el('div');
  titleBox.appendChild(el('div', { class: 'view-title', text: '图库' }));
  const subtitle = el('div', { class: 'view-sub' });
  titleBox.appendChild(subtitle);
  head.appendChild(titleBox);

  const actions = el('div', { class: 'view-actions' });
  const dupBtn = el('button', { class: 'btn btn-sm', type: 'button' });
  dupBtn.innerHTML = `${icon('trash', 15)}<span>剔除重复图片</span>`;
  dupBtn.title = '按内容指纹找出重复图片，每组保留信息最完整的一张';
  actions.appendChild(dupBtn);

  const exportBtn = el('button', { class: 'btn btn-sm', type: 'button' });
  exportBtn.innerHTML = `${icon('download', 15)}<span>导出筛选结果</span>`;
  exportBtn.title = '把当前筛选结果导出为 JSON（含图片数据）';
  actions.appendChild(exportBtn);
  head.appendChild(actions);
  root.appendChild(head);

  const body = el('div', { class: 'gallery-body' });
  const grid = el('div', { class: 'grid' });
  body.appendChild(grid);
  const empty = el('div', { class: 'empty-state' });
  empty.innerHTML =
    `<div class="empty-illus">${icon('image', 40)}</div>` +
    '<div class="empty-title">把图片拖进来，或点击导入</div>' +
    '<div class="empty-desc">支持多选文件、整个文件夹，以及同名的 .txt / .json 提示词配对文件</div>';
  const emptyBtn = el('button', { class: 'btn btn-primary', type: 'button' });
  emptyBtn.innerHTML = `${icon('upload', 15)}<span>导入图片</span>`;
  emptyBtn.addEventListener('click', () => ctx.openImport());
  empty.appendChild(emptyBtn);
  body.appendChild(empty);
  root.appendChild(body);

  const foot = el('div', { class: 'gallery-foot' });
  const prevBtn = el('button', { class: 'btn btn-sm', type: 'button', text: '上一页' });
  const countLabel = el('span', { class: 'gallery-count' });
  const nextBtn = el('button', { class: 'btn btn-sm', type: 'button', text: '下一页' });
  const jumpInput = el('input', {
    class: 'input',
    type: 'number',
    min: '1',
    style: { width: '72px', height: '28px', padding: '0 6px' }
  });
  jumpInput.title = '输入页码后回车跳转';
  foot.appendChild(prevBtn);
  foot.appendChild(countLabel);
  foot.appendChild(nextBtn);
  foot.appendChild(jumpInput);
  root.appendChild(foot);

  /* ------------------------------ 悬停卡 ------------------------------ */
  const popoverRoot = document.getElementById('popover-root') || document.body;
  const hoverCard = el('div', { class: 'hover-card' });
  hoverCard.hidden = true;
  popoverRoot.appendChild(hoverCard);
  let hoverTimer = null;
  let hideTimer = null;
  let hoverForId = null;

  function scheduleHover(cardEl, image) {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hoverForId = image.id;
    hoverTimer = setTimeout(() => {
      if (hoverForId !== image.id) return;
      showHoverCard(cardEl, image);
    }, HOVER_DELAY);
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hoverForId = null;
      hideHoverCard();
    }, HIDE_DELAY);
  }

  function keepHover() {
    clearTimeout(hideTimer);
  }

  function cancelHover() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hoverForId = null;
    hideHoverCard();
  }

  function hideHoverCard() {
    hoverCard.hidden = true;
    hoverCard.innerHTML = '';
  }

  function showHoverCard(cardEl, image) {
    hoverCard.innerHTML = '';
    hoverCard.appendChild(el('div', { class: 'hc-name', text: image.name || '未命名' }));
    hoverCard.appendChild(el('div', {
      class: 'hc-path',
      text: store.getCategoryPath(image) || '未分类'
    }));
    hoverCard.appendChild(hoverBlock('正向提示词', image.positive, POPOVER_MAX_TEXT_LINES.positive));
    hoverCard.appendChild(hoverBlock('负向提示词', image.negative, POPOVER_MAX_TEXT_LINES.negative));

    if (image.tags && image.tags.length) {
      const tags = el('div', { class: 'hc-tags' });
      image.tags.forEach((tag) => tags.appendChild(el('span', { class: 'chip', text: tag })));
      hoverCard.appendChild(tags);
    }

    const btns = el('div', { class: 'hc-btns' });
    const copyPos = el('button', { class: 'btn btn-sm', type: 'button' });
    copyPos.innerHTML = `${icon('copy', 13)}<span>复制正向</span>`;
    copyPos.addEventListener('click', (e) => {
      e.stopPropagation();
      copyAndToast(image.positive, '已复制正向提示词');
    });
    const copyNeg = el('button', { class: 'btn btn-sm', type: 'button' });
    copyNeg.innerHTML = `${icon('copy', 13)}<span>复制负向</span>`;
    copyNeg.addEventListener('click', (e) => {
      e.stopPropagation();
      copyAndToast(image.negative, '已复制负向提示词');
    });
    const copyAll = el('button', { class: 'btn btn-sm btn-primary', type: 'button' });
    copyAll.innerHTML = `${icon('copy', 13)}<span>复制全部</span>`;
    copyAll.addEventListener('click', (e) => {
      e.stopPropagation();
      copyAndToast(composePromptText(image), '已复制完整提示词');
    });
    btns.appendChild(copyPos);
    btns.appendChild(copyNeg);
    btns.appendChild(copyAll);
    hoverCard.appendChild(btns);

    // 定位：优先贴近卡片右侧，空间不足则放左侧，并做视口收敛
    hoverCard.hidden = false;
    hoverCard.style.visibility = 'hidden';
    const rect = cardEl.getBoundingClientRect();
    const width = hoverCard.offsetWidth;
    const height = hoverCard.offsetHeight;
    let left = rect.right + 12;
    if (left + width > window.innerWidth - 8) left = rect.left - width - 12;
    if (left < 8) left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.top;
    if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8);
    hoverCard.style.left = `${Math.round(left)}px`;
    hoverCard.style.top = `${Math.round(top)}px`;
    hoverCard.style.visibility = '';

    // 允许鼠标从卡片移动到悬浮卡上；在悬浮卡上移动/点击时不关闭
    hoverCard.onmouseenter = keepHover;
    hoverCard.onmouseleave = scheduleHide;
  }

  function hoverBlock(label, text, maxLines) {
    const wrap = el('div', { class: 'hc-block' });
    wrap.appendChild(el('div', { class: 'hc-label', text: label }));
    const content = String(text || '').trim();
    const p = el('p', { class: 'hc-text' });
    p.style.webkitLineClamp = String(maxLines);
    p.textContent = content || '（空）';
    if (!content) p.classList.add('hc-empty');
    wrap.appendChild(p);
    return wrap;
  }

  /* ------------------------------ 缩略图 URL 管理 ------------------------------ */
  let liveUrls = [];
  function releaseUrls() {
    liveUrls.forEach((url) => URL.revokeObjectURL(url));
    liveUrls = [];
  }
  function urlFor(image, key) {
    const blob = key === 'thumb' ? (image.thumb || image.blob) : image.blob;
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    liveUrls.push(url);
    return url;
  }

  /* ------------------------------ 渲染 ------------------------------ */
  function render() {
    cancelHover();
    releaseUrls();
    grid.innerHTML = '';

    const list = store.state.galleryList;
    subtitle.textContent = store.state.search.trim()
      ? `全局搜索「${store.state.search.trim()}」`
      : describeFilter();

    if (!list.length) {
      grid.hidden = true;
      empty.hidden = false;
      empty.querySelector('.empty-title').textContent = store.state.images.length
        ? '没有符合条件的图片'
        : '把图片拖进来，或点击导入';
      foot.hidden = true;
      renderCount();
      return;
    }

    grid.hidden = false;
    empty.hidden = true;
    foot.hidden = false;

    const frag = document.createDocumentFragment();
    list.forEach((image) => frag.appendChild(buildCard(image)));
    grid.appendChild(frag);

    renderCount();
  }

  function renderCount() {
    const total = store.state.galleryTotal;
    const page = store.state.galleryPage;
    const pages = store.state.galleryPages || 1;
    const size = store.pageSizeGallery();

    if (!total) {
      countLabel.textContent = '当前筛选结果 0 张';
      prevBtn.hidden = true;
      nextBtn.hidden = true;
      jumpInput.hidden = true;
      return;
    }

    prevBtn.hidden = false;
    nextBtn.hidden = false;
    jumpInput.hidden = false;

    const from = (page - 1) * size + 1;
    const to = Math.min(page * size, total);
    countLabel.textContent = `第 ${from}-${to} 条 / 共 ${total} 条 · 第 ${page} / ${pages} 页`;

    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= pages;
    jumpInput.max = String(pages);
    // 正在输入时不覆盖用户已输入的页码
    if (document.activeElement !== jumpInput) jumpInput.value = String(page);
  }

  function describeFilter() {
    const f = store.state.filter;
    if (f.kind === 'favorite') return '收藏';
    if (f.kind === 'uncategorized') return '未分类';
    if (f.kind === 'category') {
      if (f.subCategoryId) {
        const sub = store.categoryById(f.subCategoryId);
        const top = sub ? store.categoryById(sub.parentId) : null;
        return top ? `${top.name} / ${sub.name}` : (sub ? sub.name : '');
      }
      const cat = store.categoryById(f.categoryId);
      return cat ? cat.name : '全部图片';
    }
    return '全部图片';
  }

  function buildCard(image) {
    const card = el('article', {
      class: 'card',
      tabindex: '0',
      dataset: { id: image.id },
      title: image.name || '未命名'
    });

    const thumbWrap = el('div', { class: 'card-thumb' });
    const url = urlFor(image, 'thumb');
    if (url) {
      const img = el('img', { alt: image.name || '', loading: 'lazy' });
      img.src = url;
      thumbWrap.appendChild(img);
    } else {
      const ph = el('div', { class: 'thumb-placeholder', html: icon('image', 34) });
      thumbWrap.appendChild(ph);
    }
    card.appendChild(thumbWrap);

    // 卡片右下角常驻小按钮
    const actions = el('div', { class: 'card-actions' });
    const favBtn = el('button', {
      class: `mini-btn${image.favorite ? ' is-fav' : ''}`,
      type: 'button',
      title: image.favorite ? '取消收藏' : '收藏',
      html: icon('heart', 15)
    });
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelHover();
      store.toggleFavorite(image.id);
    });
    const copyBtn = el('button', {
      class: 'mini-btn', type: 'button', title: '复制正向提示词', html: icon('copy', 15)
    });
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyAndToast(image.positive, '已复制正向提示词');
    });
    const openBtn = el('button', {
      class: 'mini-btn', type: 'button', title: '打开详情', html: icon('eye', 15)
    });
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelHover();
      ctx.openDetail(image.id, store.state.galleryList.map((i) => i.id));
    });
    actions.appendChild(favBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(openBtn);
    card.appendChild(actions);

    const meta = el('div', { class: 'card-meta' });
    meta.appendChild(el('span', { class: 'card-name', text: image.name || '未命名' }));
    if (image.favorite) meta.appendChild(el('span', { class: 'card-fav-mark', html: icon('heart', 13) }));
    card.appendChild(meta);

    card.addEventListener('click', () => {
      cancelHover();
      ctx.openDetail(image.id, store.state.galleryList.map((i) => i.id));
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        cancelHover();
        ctx.openDetail(image.id, store.state.galleryList.map((i) => i.id));
      }
    });
    card.addEventListener('mouseenter', () => scheduleHover(card, image));
    card.addEventListener('mouseleave', () => scheduleHide());

    return card;
  }

  /* ------------------------------ 交互 ------------------------------ */
  /** 翻页并滚回顶部 —— 换页后还停在原滚动位置会让人以为没反应 */
  function gotoPage(page) {
    jumpInput.blur();
    store.setGalleryPage(page);
    body.scrollTop = 0;
  }

  prevBtn.addEventListener('click', () => gotoPage(store.state.galleryPage - 1));
  nextBtn.addEventListener('click', () => gotoPage(store.state.galleryPage + 1));
  jumpInput.addEventListener('change', () => gotoPage(jumpInput.value));
  jumpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') gotoPage(jumpInput.value);
  });

  exportBtn.addEventListener('click', () => ctx.openExport());

  /* 剔除重复图片：扫描全库（不受当前筛选影响），确认后删除多余副本 */
  dupBtn.addEventListener('click', async () => {
    dupBtn.disabled = true;
    try {
      const { groups, extra, noHash } = store.findDuplicateGroups();
      if (!groups.length) {
        toast(
          noHash
            ? `没有发现重复图片（另有 ${noHash} 张没有内容指纹，无法比对）`
            : '没有发现重复图片',
          'success'
        );
        return;
      }

      const sample = groups.slice(0, 3).map((g) => g.keep.name || '未命名').join('、');
      const tail = noHash ? ` 另有 ${noHash} 张没有内容指纹，无法参与比对。` : '';
      const ok = await confirmDialog(
        `发现 ${groups.length} 组重复，共 ${extra} 张多余。将删除每组里信息较少的副本，保留 ${groups.length} 张（例如「${sample}」）。此操作不可撤销。${tail}`,
        { danger: true, okText: `删除 ${extra} 张`, title: '剔除重复图片' }
      );
      if (!ok) return;

      const ids = groups.flatMap((g) => g.duplicates.map((i) => i.id));
      await store.removeImages(ids);
      toast(`已剔除 ${ids.length} 张重复图片`, 'success');
    } catch (err) {
      console.error('[PromptVault] 剔除重复图片失败', err);
      toast('剔除失败，请查看控制台', 'error');
    } finally {
      dupBtn.disabled = false;
    }
  });

  const onScroll = () => cancelHover();
  body.addEventListener('scroll', onScroll, { passive: true });

  /* ------------------------------ 订阅 ------------------------------ */
  const REASONS = new Set(['all', 'images', 'filter', 'search', 'settings']);
  store.subscribe((reason) => {
    if (!REASONS.has(reason)) return;
    render();
    // 筛选 / 搜索 / 翻页后列表内容整批换掉，停在原滚动位置会看到一片空白
    if (reason === 'filter' || reason === 'search') body.scrollTop = 0;
  });

  render();
  return { render };
}
