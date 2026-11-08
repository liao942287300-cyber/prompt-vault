/* =========================================================================
 * js/views/gallery.js —— 图库视图：响应式网格 + 悬停提示卡 + 加载更多
 * ========================================================================= */

import * as store from '../store.js';
import {
  el, icon, toast, copyAndToast, composePromptText, confirmDialog, downloadBlob, toCsv, openModal
} from '../utils.js';
import { classifyPromptMulti } from '../auto-classify.js';

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

  const reclassBtn = el('button', { class: 'btn btn-sm', type: 'button' });
  reclassBtn.innerHTML = `${icon('tag', 15)}<span>重新自动分类</span>`;
  reclassBtn.title = '按当前分类表，用提示词关键词重新判定每张图的分类（会覆盖现有分类）';
  actions.appendChild(reclassBtn);

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

  /* ------------------------------ 提示词购物车 ------------------------------ */
  const cartFab = el('button', { class: 'cart-fab', type: 'button', title: '提示词购物车' });
  cartFab.innerHTML = `${icon('cart', 22)}<span class="cart-badge" hidden></span>`;
  root.appendChild(cartFab);
  const cartBadge = cartFab.querySelector('.cart-badge');

  const cartPanel = el('div', { class: 'cart-panel' });
  cartPanel.hidden = true;
  root.appendChild(cartPanel);

  /** 购物车面板里的缩略图 URL（与图库网格分开管理，避免互相提前释放） */
  let cartUrls = [];
  function releaseCartUrls() {
    cartUrls.forEach((url) => URL.revokeObjectURL(url));
    cartUrls = [];
  }
  /** 记住用户填的随机条数，面板重绘后不丢 */
  let lastRandomCount = 10;

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
      updateCartUI();
      return;
    }

    grid.hidden = false;
    empty.hidden = true;
    foot.hidden = false;

    const frag = document.createDocumentFragment();
    list.forEach((image) => frag.appendChild(buildCard(image)));
    grid.appendChild(frag);

    renderCount();
    updateCartUI();
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
      // 用原始宽高先占位：瀑布流里图片加载前高度为 0 会让整列跳动
      if (image.width && image.height) img.style.aspectRatio = `${image.width} / ${image.height}`;
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
    favBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      cancelHover();
      // 收藏直接生效；取消收藏要确认，防止手滑点掉
      if (image.favorite) {
        const ok = await confirmDialog('取消收藏这张图片？', {
          title: '取消收藏', danger: true, okText: '取消收藏'
        });
        if (!ok) return;
      }
      await store.toggleFavorite(image.id);
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
      // 选购模式下点卡片 = 加入 / 移出购物车，不打开详情
      if (store.state.cartMode) {
        store.toggleCartItem(image.id);
        return;
      }
      cancelHover();
      ctx.openDetail(image.id, store.state.galleryList.map((i) => i.id));
    });
    card.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (store.state.cartMode) {
        store.toggleCartItem(image.id);
        return;
      }
      cancelHover();
      ctx.openDetail(image.id, store.state.galleryList.map((i) => i.id));
    });
    // 选购模式下不弹悬停卡，避免挡住点击
    card.addEventListener('mouseenter', () => {
      if (store.state.cartMode) return;
      scheduleHover(card, image);
    });
    card.addEventListener('mouseleave', () => scheduleHide());

    return card;
  }

  /* ------------------------------ 购物车逻辑 ------------------------------ */

  function openCart() {
    cartPanel.hidden = false;
    store.setCartMode(true);
    renderCartPanel();
  }

  function closeCart() {
    cartPanel.hidden = true;
    store.setCartMode(false);
  }

  function buildCartRow(image) {
    const row = el('div', { class: 'cart-item' });
    const src = image.thumb || image.blob;
    if (src) {
      const url = URL.createObjectURL(src);
      cartUrls.push(url);
      row.appendChild(el('img', { class: 'cart-item-thumb', src: url, alt: '' }));
    } else {
      row.appendChild(el('div', { class: 'cart-item-thumb' }));
    }
    row.appendChild(el('div', {
      class: 'cart-item-text',
      text: String(image.positive || '').trim() || '（没有正向提示词）'
    }));
    const del = el('button', {
      class: 'cart-item-del', type: 'button', title: '移出购物车', html: icon('close', 13)
    });
    del.addEventListener('click', () => store.toggleCartItem(image.id));
    row.appendChild(del);
    return row;
  }

  function renderCartPanel() {
    releaseCartUrls();
    cartPanel.innerHTML = '';
    const items = store.cartImages();

    /* 头部 */
    const head = el('div', { class: 'cart-head' });
    head.appendChild(el('div', { class: 'cart-title', text: '提示词购物车' }));
    head.appendChild(el('span', { class: 'cart-count', text: `${items.length} 条` }));
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', title: '收起', html: icon('close', 16) });
    closeBtn.addEventListener('click', closeCart);
    head.appendChild(closeBtn);
    cartPanel.appendChild(head);

    /* 提示 */
    const hint = el('div', { class: `cart-hint${store.state.cartMode ? ' is-on' : ''}` });
    hint.textContent = store.state.cartMode
      ? '选购中：点图库里的图片即可加入或移出购物车'
      : '点右下角按钮进入选购模式，再点图片加入购物车';
    cartPanel.appendChild(hint);

    /* 已选列表 */
    const list = el('div', { class: 'cart-list' });
    if (!items.length) {
      list.appendChild(el('div', { class: 'cart-empty', text: '购物车是空的' }));
    } else {
      items.forEach((image) => list.appendChild(buildCartRow(image)));
    }
    cartPanel.appendChild(list);

    /* 操作区 */
    const actions = el('div', { class: 'cart-actions' });

    const randRow = el('div', { class: 'cart-row' });
    const nInput = el('input', {
      class: 'input', type: 'number', min: '1', value: String(lastRandomCount)
    });
    nInput.title = '从当前筛选结果里随机抽几条';
    nInput.addEventListener('input', () => { lastRandomCount = Math.max(1, Number(nInput.value) || 1); });
    const randBtn = el('button', { class: 'btn btn-sm', type: 'button' });
    randBtn.innerHTML = `${icon('dice', 14)}<span>随机抽取</span>`;
    randBtn.title = '从当前分类（含搜索）里随机抽 N 条带提示词的图，覆盖购物车';
    randBtn.addEventListener('click', () => {
      lastRandomCount = Math.max(1, Number(nInput.value) || 1);
      const { picked, pool } = store.pickRandomCart(lastRandomCount);
      if (!pool) { toast('当前筛选下没有带提示词的图片', 'warn'); return; }
      if (picked < lastRandomCount) toast(`当前分类只有 ${pool} 条带提示词，已全部选入`, 'warn');
      else toast(`已随机抽取 ${picked} 条`, 'success');
    });
    randRow.appendChild(nInput);
    randRow.appendChild(randBtn);
    actions.appendChild(randRow);

    const expRow = el('div', { class: 'cart-row' });
    const txtBtn = el('button', { class: 'btn btn-sm', type: 'button' });
    txtBtn.innerHTML = `${icon('download', 14)}<span>导出 TXT</span>`;
    txtBtn.title = '每条提示词之间空一行，可直接喂给 ComfyUI 批量生图';
    txtBtn.addEventListener('click', () => exportCart('txt'));
    const csvBtn = el('button', { class: 'btn btn-sm', type: 'button' });
    csvBtn.innerHTML = `${icon('download', 14)}<span>导出 CSV</span>`;
    csvBtn.title = '序号 / 名称 / 正向提示词，带 BOM 可被 Excel 正确识别';
    csvBtn.addEventListener('click', () => exportCart('csv'));
    expRow.appendChild(txtBtn);
    expRow.appendChild(csvBtn);
    actions.appendChild(expRow);

    const modeRow = el('div', { class: 'cart-row' });
    const modeBtn = el('button', {
      class: `btn btn-sm${store.state.cartMode ? ' btn-primary' : ''}`,
      type: 'button',
      text: store.state.cartMode ? '结束选购' : '开始选购'
    });
    modeBtn.addEventListener('click', () => {
      if (store.state.cartMode) closeCart();
      else store.setCartMode(true);
    });
    const clearBtn = el('button', { class: 'btn btn-sm', type: 'button', text: '清空' });
    clearBtn.addEventListener('click', () => {
      if (!store.state.cart.length) return;
      store.clearCart();
      toast('已清空购物车', 'success');
    });
    modeRow.appendChild(modeBtn);
    modeRow.appendChild(clearBtn);
    actions.appendChild(modeRow);

    cartPanel.appendChild(actions);
  }

  /**
   * 导出购物车里的正向提示词。
   * @param {'txt'|'csv'} format
   */
  function exportCart(format) {
    const items = store.cartImages().filter((img) => String(img.positive || '').trim());
    if (!items.length) { toast('购物车是空的，先选几张图', 'warn'); return; }
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'txt') {
      // 一条提示词占一行，行与行之间不空行。
      // 提示词内部残留的换行（Word 导入的多段落会带 \n）压成空格，
      // 否则一条会被 ComfyUI 当成好几条。
      const text = items
        .map((img) => String(img.positive).replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim())
        .join('\n');
      downloadBlob(
        new Blob([text], { type: 'text/plain;charset=utf-8' }),
        `prompts-${items.length}-${stamp}.txt`
      );
    } else {
      const rows = [['序号', '名称', '正向提示词']];
      items.forEach((img, i) => rows.push([String(i + 1), img.name || '', String(img.positive).trim()]));
      downloadBlob(
        new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }),
        `prompts-${items.length}-${stamp}.csv`
      );
    }
    toast(`已导出 ${items.length} 条提示词`, 'success');
  }

  /** 购物车变化：只做局部更新，不重绘整个网格（重绘会让 60 张图的 URL 全部重建） */
  function updateCartUI() {
    const count = store.state.cart.length;
    cartBadge.textContent = String(count);
    cartBadge.hidden = count === 0;
    cartFab.classList.toggle('is-active', store.state.cartMode);
    cartFab.title = store.state.cartMode ? '结束选购' : '提示词购物车';
    grid.classList.toggle('is-picking', store.state.cartMode);
    grid.querySelectorAll('.card').forEach((card) => {
      card.classList.toggle('is-picked', store.isInCart(card.dataset.id));
    });
    if (!cartPanel.hidden) renderCartPanel();
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

  /* 购物车悬浮按钮：开面板 = 进入选购模式，关面板 = 退出 */
  cartFab.addEventListener('click', () => {
    if (cartPanel.hidden) openCart();
    else closeCart();
  });
  jumpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') gotoPage(jumpInput.value);
  });

  exportBtn.addEventListener('click', () => ctx.openExport());

  /* 剔除重复图片：扫描全库（不受当前筛选影响），确认后删除多余副本 */
  /* -------------------- 重新自动分类 -------------------- */
  // 分类可以增删改，改了分类表之后旧图的分类就过时了。
  // 这个按钮按当前分类表重新跑一遍关键词匹配，把每张图归到新分类。
  reclassBtn.addEventListener('click', async () => {
    const total = store.state.images.length;
    const cats = store.state.categories;
    if (!total) { toast('图库是空的', 'warn'); return; }
    if (!cats.length) { toast('还没有分类，先建几个分类再试', 'warn'); return; }

    const ok = await confirmReclassify(total, cats.length);
    if (!ok) return;

    reclassBtn.disabled = true;

    // 进度弹窗（不可关闭：中途关掉会让人以为没跑完）
    const fill = el('div', { class: 'reclass-bar-fill' });
    const bar = el('div', { class: 'reclass-bar' });
    bar.appendChild(fill);
    const label = el('div', { class: 'muted', text: '准备中…' });
    const box = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
    box.appendChild(label);
    box.appendChild(bar);
    const progress = openModal({ title: '正在重新分类', content: box, dismissible: false });

    try {
      const stats = await store.reclassifyImages(
        (img) => {
          // 多分类：提示词里能识别出的每个一级大类各挂一个二级分类
          const guesses = classifyPromptMulti(img.positive || '', cats);
          return {
            categories: guesses.map((g) => ({
              categoryId: g.categoryId || null,
              subCategoryId: g.subCategoryId || null
            }))
          };
        },
        (done, all) => {
          const pct = Math.round((done / all) * 100);
          fill.style.width = `${pct}%`;
          label.textContent = `${done} / ${all}（${pct}%）`;
        }
      );

      progress.close();

      const bits = [`共 ${stats.total} 张`, `改了 ${stats.changed} 张`];
      if (stats.toUncategorized) bits.push(`其中 ${stats.toUncategorized} 张归入未分类`);
      if (!stats.changed) bits.push('全部都没变');
      toast(bits.join('，'), 'success');
    } catch (err) {
      progress.close();
      console.error('[PromptVault] 重新分类失败', err);
      toast(`重新分类失败：${err?.message || err}`, 'error');
    } finally {
      reclassBtn.disabled = false;
    }
  });

  /**
   * 重新分类的确认弹窗。做成自定义弹窗而不是 confirmDialog，
   * 因为要把「不可逆」和具体影响分条列出来，光一行字容易看漏。
   * @returns {Promise<boolean>}
   */
  function confirmReclassify(total, catCount) {
    return new Promise((resolve) => {
      const warn = el('div', { class: 'reclass-warn' });
      warn.appendChild(el('strong', { text: '⚠ 此操作不可撤销' }));
      warn.appendChild(el('div', {
        class: 'muted',
        text: `将按当前的 ${catCount} 个分类，重新判定全部 ${total} 张图片。`
      }));
      const ul = el('ul');
      ul.appendChild(el('li', { text: '每张图会根据它的正向提示词重新匹配关键词' }));
      ul.appendChild(el('li', { text: '现有的分类（包括你手动改过的）会被覆盖' }));
      ul.appendChild(el('li', { text: '匹配不到关键词的图会变成「未分类」' }));
      warn.appendChild(ul);

      const body = el('div');
      body.appendChild(warn);
      body.appendChild(el('p', {
        class: 'muted',
        style: { margin: '0' },
        text: '分类表改动越大，这个操作越有用。如果只是加了几张图，没必要跑。'
      }));

      const footer = el('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } });
      const cancelBtn = el('button', { class: 'btn', type: 'button', text: '取消' });
      const okBtn = el('button', { class: 'btn btn-primary', type: 'button', text: `重新分类 ${total} 张` });
      footer.appendChild(cancelBtn);
      footer.appendChild(okBtn);

      const m = openModal({ title: '重新自动分类', content: body, footer });
      cancelBtn.addEventListener('click', () => { m.close(); resolve(false); });
      okBtn.addEventListener('click', () => { m.close(); resolve(true); });
    });
  }

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
    // 购物车变化只更新角标 / 选中态 / 面板，不重绘网格
    if (reason === 'cart') { updateCartUI(); return; }
    if (!REASONS.has(reason)) return;
    render();
    // 筛选 / 搜索 / 翻页后列表内容整批换掉，停在原滚动位置会看到一片空白
    if (reason === 'filter' || reason === 'search') body.scrollTop = 0;
  });

  render();
  return { render };
}
