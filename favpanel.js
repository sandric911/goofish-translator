/* Goofish EN — кнопки «Избранное» и «Корзина» в шапке Goofish и всплывающая панель с двумя вкладками.
 * Избранное — просто список сохранённых товаров; корзина — то, что заказываем: количество, цена, итог.
 * Панель живёт в Shadow DOM: стили сайта её не ломают, а переводчик её не трогает.
 * Данные — chrome.storage.local.favs (общие с ☆ и 🛒 в content.js): одна запись на товар
 * с отметками fav (у старых записей поля нет — считаем, что да) и cart.
 */
(() => {
  'use strict';
  if (window.top !== window || window.__gfxPanelLoaded) return;
  window.__gfxPanelLoaded = true;

  const OPEN_HASH = '#gfx-favs';
  const CJK = /[㐀-鿿]/;

  let S = { ...GFX_DEFAULTS };
  let market = { RUB: 12.18, USD: 0.1496, ts: 0 };
  let favs = {};
  let ready = false;
  let lastWritten = '';

  const hdr = { favs: null, cart: null }; // ссылки в шапке
  let hdrWrap = null;     // общая обёртка ссылок: к ней привязано окно, поэтому оно одно и не прыгает
  let hdrVisible = false; // видны ли кнопки шапки на экране
  let floatBtn = null;    // плавающая кнопка, когда шапка уехала за экран
  let host = null, root = null, panelEl = null;
  let isOpen = false;
  let view = 'favs';      // какая вкладка открыта: 'favs' | 'cart'

  // ================================================================= utils
  const qtyOf = (f) => Math.max(1, Math.round(+f.qty || 1));
  const priceOf = (f) => Math.max(0, +f.price || 0);

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const isFav = (f) => f.fav !== false;
  const inCart = (f) => f.cart === true;
  const listOf = (v) => Object.values(favs).filter(v === 'cart' ? inCart : isFav);

  // итог корзины
  function totals() {
    let cny = 0, pcs = 0;
    const items = listOf('cart');
    for (const f of items) {
      pcs += qtyOf(f);
      cny += priceOf(f) * qtyOf(f);
    }
    return { cny, pcs, n: items.length };
  }

  function sorted(v) {
    const at = v === 'cart' ? (f) => f.cartAt || f.addedAt || 0 : (f) => f.addedAt || 0;
    return listOf(v).sort((a, b) => at(b) - at(a));
  }

  // убрать товар из списка; запись удаляется, когда его нет ни в избранном, ни в корзине
  function unlist(f, v) {
    if (v === 'cart') f.cart = false; else f.fav = false;
    if (!isFav(f) && !inCart(f)) delete favs[f.id];
  }

  let saveTimer = 0;
  function save(now) {
    clearTimeout(saveTimer);
    const run = () => {
      lastWritten = JSON.stringify(favs);
      try { chrome.storage.local.set({ favs }); } catch (e) { /* контекст расширения перезагружен */ }
    };
    if (now) run(); else saveTimer = setTimeout(run, 300);
  }

  // ================================================================= data
  try {
    chrome.storage.local.get(['settings', 'rates', 'favs'], (d) => {
      d = d || {};
      S = { ...GFX_DEFAULTS, ...(d.settings || {}) };
      if (d.rates) market = d.rates;
      favs = d.favs || {};
      lastWritten = JSON.stringify(favs);
      ready = true;
      ensureButtons();
      if (location.hash === OPEN_HASH) {
        history.replaceState(null, '', location.pathname + location.search);
        openWhenReady('favs');
      }
    });
  } catch (e) { return; }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let full = false;
    if (changes.favs) {
      const nv = changes.favs.newValue || {};
      const js = JSON.stringify(nv);
      if (js !== lastWritten) { favs = nv; lastWritten = js; full = true; }
    }
    if (changes.settings) { S = { ...GFX_DEFAULTS, ...(changes.settings.newValue || {}) }; full = true; }
    if (changes.rates && changes.rates.newValue) { market = changes.rates.newValue; full = true; }
    if (full) { renderButtons(); if (isOpen) { renderPanel(); place(); } }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'openFavPanel') {
      openWhenReady(msg.view === 'cart' ? 'cart' : 'favs');
      sendResponse({ ok: true });
    }
  });

  // ================================================================= buttons
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const e of entries) if (e.target === hdrWrap) hdrVisible = e.isIntersecting;
      renderFloat();
      placeSoon();
    })
    : null;

  function headerSlot() {
    return document.querySelector('[class*="user-order-container"]') || document.querySelector('[class*="header-right"]');
  }

  function makeHdrBtn(v) {
    const b = h('button', 'gfx-hdr-fav' + (v === 'cart' ? ' gfx-hdr-cart' : ''));
    b.type = 'button';
    const ico = h('span', 'gfx-hdr-ico', v === 'cart' ? null : '★');
    if (v === 'cart') ico.appendChild(h('i', 'gfx-ico-cart'));
    b.appendChild(ico);
    b.appendChild(h('span', 'gfx-hdr-txt', v === 'cart' ? 'Корзина' : 'Избранное'));
    b.appendChild(h('span', 'gfx-hdr-badge'));
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(v); });
    return b;
  }

  // Родные «Вход» и «Заказы»: помечаем, а прячет их CSS (только пока скрываются окна входа).
  // Если пользователь вошёл, на месте «Вход» стоит его ник — его не трогаем.
  const LOGIN_TXT = /^(登录|log\s?in|sign\s?in|login|войти|вход|авторизоваться)$/i;
  function markNative(slot) {
    for (const el of slot.children) {
      if (el === hdrWrap) continue;
      const nick = el.querySelector('[class*="nick"]');
      const isLogin = !!nick && LOGIN_TXT.test(nick.textContent.trim());
      const isOrders = el.matches('a[href*="/bought"]') || !!el.querySelector('a[href*="/bought"]');
      el.toggleAttribute('data-gfx-native-hidden', isLogin || isOrders);
    }
  }

  function ensureButtons() {
    if (!ready || !document.body) return;
    const slot = headerSlot();
    if (slot && !(hdrWrap && hdrWrap.isConnected && hdrWrap.parentElement === slot)) {
      if (hdrWrap) { if (io) io.unobserve(hdrWrap); hdrWrap.remove(); }
      hdrWrap = h('span', 'gfx-ui gfx-hdr');
      for (const v of ['favs', 'cart']) {
        hdr[v] = makeHdrBtn(v);
        hdrWrap.appendChild(hdr[v]);
      }
      slot.appendChild(hdrWrap);
      if (io) io.observe(hdrWrap); else hdrVisible = true;
      placeSoon();
    } else if (!slot && hdrWrap && !hdrWrap.isConnected) {
      hdrWrap = hdr.favs = hdr.cart = null;
      hdrVisible = false;
    }
    if (slot) markNative(slot);
    renderButtons();
  }

  const goods = (n) => `${n} ${plural(n, 'товар', 'товара', 'товаров')}`;

  function renderButtons() {
    if (!ready) return;
    const nf = listOf('favs').length;
    const t = totals();
    if (hdr.favs) {
      hdr.favs.querySelector('.gfx-hdr-badge').textContent = nf ? String(nf) : '';
      hdr.favs.classList.toggle('gfx-open', isOpen && view === 'favs');
      hdr.favs.title = nf ? `Избранное: ${goods(nf)}` : 'Избранное пусто — нажмите ☆ рядом с ценой';
    }
    if (hdr.cart) {
      hdr.cart.querySelector('.gfx-hdr-badge').textContent = t.n ? String(t.n) : '';
      hdr.cart.classList.toggle('gfx-open', isOpen && view === 'cart');
      hdr.cart.title = t.n
        ? `Корзина: ${goods(t.n)} · ${gfxFmtRub.format(gfxCalc(t.cny, S, market).buyer)} ₽`
        : 'Корзина пуста — нажмите значок корзины рядом с ценой';
    }
    renderFloat();
  }

  // плавающая кнопка — только если кнопок в шапке не видно (прокрутили вниз или шапки нет)
  function renderFloat() {
    if (!ready || !document.body) return;
    const nf = listOf('favs').length;
    const t = totals();
    const need = nf + t.n > 0 && !(hdrWrap && hdrWrap.isConnected && hdrVisible);
    if (!need) {
      if (floatBtn) { floatBtn.remove(); floatBtn = null; }
      return;
    }
    if (!floatBtn || !floatBtn.isConnected) {
      floatBtn = h('div', 'gfx-ui gfx-cart');
      floatBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const seg = e.target.closest('[data-view]');
        toggle(seg ? seg.dataset.view : view);
      });
      document.body.appendChild(floatBtn);
    }
    floatBtn.textContent = '';
    const seg = (v, ico, n, title) => {
      const el = h('span', 'gfx-cart-seg');
      el.dataset.view = v;
      el.setAttribute('role', 'button');
      el.title = title;
      const i = h('span', 'gfx-cart-star', ico);
      if (!ico) i.appendChild(h('i', 'gfx-ico-cart'));
      el.appendChild(i);
      el.appendChild(h('span', 'gfx-cart-count', String(n)));
      floatBtn.appendChild(el);
      return el;
    };
    seg('favs', '★', nf, 'Открыть избранное');
    const cs = seg('cart', null, t.n, 'Открыть корзину');
    if (t.n) cs.appendChild(h('span', 'gfx-cart-sum', `${gfxFmtRub.format(gfxCalc(t.cny, S, market).buyer)} ₽`));
  }

  // «подбросить» кнопку, в чей список только что добавили товар
  function bump(v) {
    const els = [v === 'cart' ? hdr.cart : hdr.favs, floatBtn];
    for (const el of els) {
      if (!el) continue;
      el.classList.remove('gfx-bump');
      void el.offsetWidth;
      el.classList.add('gfx-bump');
    }
  }

  setInterval(ensureButtons, 800);
  document.addEventListener('DOMContentLoaded', ensureButtons);

  // ================================================================= panel
  // Оформление — «китайский интернет-магазин 2005 года»: оранжевая шапка окна, вкладки-закладки,
  // таблица с пунктирными разделителями, фото в рамке, синие ссылки, красные цены, кнопки с фаской.
  const CART_ICON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' shape-rendering='crispEdges'%3E%3Cpath d='M0 2h4v3h11l-2 5H3V4H0zM4 11h10v1H4zM4 13h2v2H4zM11 13h2v2h-2z'/%3E%3C/svg%3E")`;
  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel {
  position: fixed; z-index: 2147483647;
  width: 460px;
  display: flex; flex-direction: column;
  background: #fff; color: #333;
  border: 1px solid #d94f00;
  box-shadow: 4px 4px 0 rgba(0,0,0,.22);
  font: 12px/1.5 Tahoma, Verdana, Arial, "SimSun", "Songti SC", sans-serif;
  opacity: 0; transition: opacity .1s linear;
}
.panel.show { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .panel { transition: none; } }
.caret { display: none; }
.ico-cart { display: inline-block; flex: none; width: 14px; height: 14px; background-color: currentColor;
  -webkit-mask: ${CART_ICON} center / contain no-repeat; mask: ${CART_ICON} center / contain no-repeat; }

/* шапка окна */
.bar { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 4px 0 8px;
  background: linear-gradient(#ff9a3c, #f26100); border-bottom: 1px solid #b34700;
  color: #fff; font-weight: 700; text-shadow: 1px 1px 0 #b34700; }
.bar .zh { color: #ffffcc; font: 400 12px/1 "SimSun", "Songti SC", Tahoma, sans-serif; }
.bar .sp { flex: 1; }
.x { width: 18px; height: 18px; padding: 0; border: 1px solid; border-color: #fff #8c8c8c #8c8c8c #fff;
  background: linear-gradient(#fff, #e4e4e4); color: #333; font: 700 11px/1 Tahoma, Verdana, sans-serif; cursor: pointer; }
.x:hover { color: #d40000; }
.x:active { border-color: #8c8c8c #fff #fff #8c8c8c; }

/* вкладки-закладки */
.tabs { display: flex; align-items: flex-end; gap: 3px; padding: 6px 8px 0; background: #fff7e8; border-bottom: 1px solid #ff9a3c; }
.tab { position: relative; top: 1px; display: inline-flex; align-items: center; gap: 5px; height: 25px; padding: 0 12px;
  border: 1px solid #f2b26b; border-bottom-color: #ff9a3c; background: linear-gradient(#fffaf0, #ffe2bf);
  color: #0033cc; font: inherit; cursor: pointer; }
.tab .name { text-decoration: underline; }
.tab:hover { color: #ff6600; }
.tab.on { height: 27px; border-color: #ff9a3c; border-top: 2px solid #ff6600; border-bottom-color: #fff;
  background: #fff; color: #333; font-weight: 700; cursor: default; }
.tab.on .name { text-decoration: none; }
.tab .star { color: #ff9900; font-size: 13px; line-height: 1; }
.tab .ico-cart { color: #d94f00; }
.tab .cnt { color: #d40000; font: 700 12px/1 Arial, Verdana, sans-serif; }
.tab .cnt::before { content: '('; }
.tab .cnt::after { content: ')'; }
.tab .cnt:empty { display: none; }

/* таблица товаров */
.th { display: flex; justify-content: space-between; padding: 2px 10px; background: #f3f3f3;
  border-bottom: 1px solid #dcdcdc; color: #666; font-size: 11px; }
.list { overflow-y: auto; overscroll-behavior: contain; min-height: 60px; }
.row { display: grid; grid-template-columns: 80px minmax(0,1fr) auto; gap: 10px; align-items: start;
  padding: 8px 10px; border-bottom: 1px dotted #b5b5b5; }
.row:nth-child(even) { background: #fffcf5; }
.row:hover { background: #fff4e0; }
.thumb { position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; width: 80px; height: 80px; padding: 2px;
  border: 1px solid #c8c8c8; background: #fff; color: #aaa; text-decoration: none;
  font: 11px/1 "SimSun", "Songti SC", Tahoma, sans-serif; }
.thumb:hover { border-color: #ff6600; }
.thumb.none { background: #f3f3f3; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* штамп «продано / снято / удалено» поверх фото */
.thumb.st img { filter: grayscale(1); opacity: .45; }
.stamp { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) rotate(-14deg);
  display: flex; flex-direction: column; align-items: center; padding: 2px 5px 1px;
  border: 2px solid #d40000; outline: 1px solid #d40000; outline-offset: 1px;
  background: rgba(255,255,255,.9); color: #d40000; white-space: nowrap; }
.stamp b { font: 700 14px/1.15 "SimSun", "Songti SC", Tahoma, sans-serif; letter-spacing: 1px; }
.stamp i { font: 700 9px/1.2 Tahoma, Verdana, sans-serif; font-style: normal; letter-spacing: .5px; }
.mid { min-width: 0; }
.title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  color: #0033cc; text-decoration: underline; }
.title:hover { color: #ff6600; }
.meta { font-size: 11px; color: #777; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta .up { color: #d40000; font-weight: 700; }
.meta .down { color: #2e8b00; font-weight: 700; }
.meta .manual { color: #996600; }
.pr { margin-top: 4px; color: #d40000; font: 700 14px/1.3 Arial, Verdana, sans-serif; }
.ctrl { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.cny { display: inline-flex; align-items: center; gap: 3px; color: #d40000; font: 700 13px/1 Arial, Verdana, sans-serif; }
.price { width: 72px; height: 22px; padding: 0 4px; border: 1px solid #7f9db9; border-radius: 0; background: #fff;
  color: #333; font: 700 12px/1 Arial, Verdana, sans-serif; outline: none; }
.price:focus { border-color: #ff6600; background: #ffffe1; }
.qty { display: inline-flex; align-items: center; }
.qty button { width: 20px; height: 22px; padding: 0; border: 1px solid; border-color: #fff #8c8c8c #8c8c8c #fff;
  outline: 1px solid #a6a6a6; background: linear-gradient(#fff, #e4e4e4); color: #333; font: 700 12px/1 Arial, sans-serif; cursor: pointer; }
.qty button:hover { color: #ff6600; }
.qty button:active { border-color: #8c8c8c #fff #fff #8c8c8c; }
.qn { min-width: 28px; height: 22px; margin: 0 2px; border: 1px solid #7f9db9; background: #fff;
  text-align: center; font: 700 12px/20px Arial, Verdana, sans-serif; }
.right { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; text-align: right; }
.tb { color: #d40000; font: 700 14px/1.3 Arial, Verdana, sans-serif; white-space: nowrap; }
.tb::before { content: 'байер'; margin-right: 5px; padding: 0 3px; background: #ff6600; color: #fff;
  font: 400 10px/14px Tahoma, Verdana, sans-serif; vertical-align: 1px; }
.acts { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.tocart { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border: 1px solid;
  border-color: #ffc38a #b34700 #b34700 #ffc38a; outline: 1px solid #b34700; background: linear-gradient(#ff8c26, #f26100);
  color: #fff; font: 700 11px/1 Tahoma, Verdana, sans-serif; text-shadow: 1px 1px 0 #b34700; white-space: nowrap; cursor: pointer; }
.tocart .ico-cart { width: 12px; height: 12px; }
.tocart:hover { color: #ffffcc; }
.tocart:active { border-color: #b34700 #ffc38a #ffc38a #b34700; }
.tocart.on { border-color: #fff #c9a36a #c9a36a #fff; outline-color: #c9a36a; background: #fff3e0; color: #d94f00; text-shadow: none; }
.del { padding: 0; border: 0; background: none; color: #0033cc; font: 11px/1.4 Tahoma, Verdana, sans-serif;
  text-decoration: underline; cursor: pointer; }
.del:hover { color: #d40000; }
.empty { padding: 28px 20px; text-align: center; color: #777; }
.empty .zh { display: block; margin-bottom: 6px; color: #ff6600; font: 14px/1.4 "SimSun", "Songti SC", Tahoma, sans-serif; }
.empty b { display: block; color: #333; margin-bottom: 2px; }

/* итог */
.pf { border-top: 1px solid #ff9a3c; padding: 8px 10px 10px; background: #fff7e8; }
.sr { display: flex; justify-content: space-between; gap: 8px; color: #555; }
.sr .v { color: #333; font-family: Arial, Verdana, sans-serif; }
.buyer { margin-top: 6px; padding: 4px 8px; border: 1px solid #f7c873; background: #ffffe1; text-align: right; }
.buyer .big { color: #d40000; font: 700 24px/1.2 Arial, Verdana, sans-serif; }
.btns { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: 8px; }
.pf.plain .btns { margin-top: 0; }
.btns button { height: 26px; padding: 0 12px; border: 1px solid; border-radius: 0; font: 700 12px/1 Tahoma, Verdana, sans-serif; cursor: pointer; }
.primary { border-color: #ffc38a #b34700 #b34700 #ffc38a !important; outline: 1px solid #b34700; background: linear-gradient(#ff8c26, #f26100);
  color: #fff; text-shadow: 1px 1px 0 #b34700; }
.primary:hover { color: #ffffcc; }
.primary:active { border-color: #b34700 #ffc38a #ffc38a #b34700 !important; }
.ghost { border-color: #fff #8c8c8c #8c8c8c #fff !important; outline: 1px solid #a6a6a6; background: linear-gradient(#fff, #e4e4e4); color: #333; }
.ghost:hover { color: #ff6600; }
.ghost:active { border-color: #8c8c8c #fff #fff #8c8c8c !important; }
.ghost.warn { background: #ffecec; color: #d40000; }
`;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = h('div', 'gfx-ui gfx-panel-host');
    root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = CSS;
    root.appendChild(st);
    panelEl = h('div', 'panel');
    panelEl.setAttribute('role', 'dialog');
    root.appendChild(panelEl);
    (document.body || document.documentElement).appendChild(host);
    bindPanel();
  }

  function anchorEl() {
    if (hdrWrap && hdrWrap.isConnected && hdrVisible) return hdrWrap;
    if (floatBtn && floatBtn.isConnected) return floatBtn;
    return hdrWrap && hdrWrap.isConnected ? hdrWrap : null;
  }

  function place() {
    if (!isOpen || !panelEl) return;
    // масштаб: zoom умножает и размеры окна, и его left/top, поэтому координаты делим на k
    const k = gfxScale(S);
    panelEl.style.zoom = k;
    const W = Math.min(460 * k, innerWidth - 16);
    panelEl.style.width = W / k + 'px';
    const a = anchorEl();
    const r = a ? a.getBoundingClientRect() : { top: 0, bottom: 0, left: innerWidth - 24, right: innerWidth - 8, width: 16 };
    const caret = panelEl.querySelector('.caret');
    const left = Math.min(Math.max(8, r.right - W + 12), innerWidth - W - 8);
    panelEl.style.left = left / k + 'px';
    if (r.top < innerHeight / 2) {
      const top = Math.max(8, r.bottom + 10);
      panelEl.classList.remove('up');
      panelEl.style.top = top / k + 'px';
      panelEl.style.bottom = '';
      panelEl.style.maxHeight = Math.max(260, innerHeight - top - 12) / k + 'px';
      if (caret) {
        const cx = r.left + r.width / 2 - left - 7;
        caret.style.display = r.bottom > 0 && cx > 12 && cx < W - 24 ? '' : 'none';
        caret.style.left = cx + 'px';
      }
    } else {
      const bottom = Math.max(8, innerHeight - r.top + 10);
      panelEl.classList.add('up');
      panelEl.style.top = '';
      panelEl.style.bottom = bottom / k + 'px';
      panelEl.style.maxHeight = Math.max(260, innerHeight - bottom - 12) / k + 'px';
    }
  }

  let rafPending = false;
  function placeSoon() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; place(); });
  }
  addEventListener('scroll', placeSoon, { passive: true, capture: true });
  addEventListener('resize', placeSoon, { passive: true });

  function open() {
    if (!ready) return;
    ensureHost();
    isOpen = true;
    renderPanel();
    place();
    requestAnimationFrame(() => panelEl.classList.add('show'));
    renderButtons();
    translateTitles();
    checkStale();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    if (panelEl) panelEl.classList.remove('show');
    setTimeout(() => { if (!isOpen && host) { host.remove(); host = null; root = null; panelEl = null; } }, 160);
    renderButtons();
  }

  // кнопка своей вкладки закрывает панель, кнопка другой — переключает вкладку
  function toggle(v) {
    if (isOpen && v === view) { close(); return; }
    show(v);
  }

  function show(v) {
    view = v === 'cart' ? 'cart' : 'favs';
    if (!isOpen) { open(); return; }
    renderPanel();
    place();
    renderButtons();
  }

  function openWhenReady(v, tries = 0) {
    if (ready && document.body) { ensureButtons(); show(v); return; }
    if (tries < 50) setTimeout(() => openWhenReady(v, tries + 1), 100);
  }

  // закрытие: клик вне панели и Esc
  addEventListener('pointerdown', (e) => {
    if (!isOpen) return;
    const path = e.composedPath();
    if (path.includes(host) || path.includes(hdrWrap) || path.includes(floatBtn)) return;
    close();
  }, true);
  addEventListener('keydown', (e) => { if (isOpen && e.key === 'Escape') close(); }, true);

  // ---------------------------------------------------------------- render
  function renderPanel() {
    if (!panelEl) return;
    const cart = view === 'cart';
    const scroll = panelEl.querySelector('.list') ? panelEl.querySelector('.list').scrollTop : 0;
    panelEl.textContent = '';
    panelEl.setAttribute('aria-label', cart ? 'Корзина' : 'Избранное');
    panelEl.appendChild(h('div', 'caret'));

    const bar = h('div', 'bar');
    bar.appendChild(h('span', null, 'Goofish EN'));
    bar.appendChild(h('span', 'zh', cart ? '我的购物车' : '我的收藏夹'));
    bar.appendChild(h('span', 'sp'));
    const x = h('button', 'x', '×');
    x.setAttribute('aria-label', 'Закрыть');
    bar.appendChild(x);
    panelEl.appendChild(bar);

    const tabs = h('div', 'tabs');
    for (const [v, name] of [['favs', 'Избранное'], ['cart', 'Корзина']]) {
      const tab = h('button', 'tab' + (v === view ? ' on' : ''));
      tab.type = 'button';
      tab.dataset.view = v;
      tab.appendChild(v === 'favs' ? h('span', 'star', '★') : h('i', 'ico-cart'));
      tab.appendChild(h('span', 'name', name));
      tab.appendChild(h('span', 'cnt'));
      tabs.appendChild(tab);
    }
    panelEl.appendChild(tabs);

    const list = h('div', 'list');
    const items = sorted(view);
    if (!items.length) {
      const e = h('div', 'empty');
      e.appendChild(h('span', 'zh', cart ? '购物车里还没有宝贝' : '收藏夹里还没有宝贝'));
      e.appendChild(h('b', null, cart ? 'Корзина пуста' : 'Избранное пусто'));
      e.appendChild(document.createTextNode(cart
        ? 'Нажмите значок корзины рядом с ценой товара или «В корзину» в избранном.'
        : 'Нажмите ☆ рядом с ценой товара — он появится здесь.'));
      list.appendChild(e);
    } else {
      const th = h('div', 'th');
      th.appendChild(h('span', null, 'Товар'));
      th.appendChild(h('span', null, cart ? 'Сумма' : 'Цена'));
      panelEl.appendChild(th);
    }
    for (const f of items) list.appendChild(renderRow(f));
    panelEl.appendChild(list);

    const pf = h('div', cart ? 'pf' : 'pf plain');
    const btns = h('div', 'btns');
    if (cart) {
      pf.appendChild(sumRow('sr sCount', '', ''));
      const b = h('div', 'buyer');
      b.appendChild(h('span', 'big sBuyer'));
      pf.appendChild(b);
      btns.appendChild(h('button', 'primary copy', 'Скопировать список для байера'));
    } else {
      btns.appendChild(h('button', 'primary allcart', 'Всё в корзину'));
    }
    btns.appendChild(h('button', 'ghost clear', 'Очистить'));
    pf.appendChild(btns);
    if (!items.length) pf.style.display = 'none';
    panelEl.appendChild(pf);

    renderSummary();
    list.scrollTop = scroll;
  }

  function sumRow(cls, k, v) {
    const r = h('div', cls);
    r.appendChild(h('span', 'k', k));
    r.appendChild(h('b', 'v', v));
    return r;
  }

  // статус товара записывает content.js, когда открыта страница товара
  const STATUS = {
    sold: { zh: '已售出', ru: 'ПРОДАНО', tip: 'Товар продан' },
    off: { zh: '已下架', ru: 'СНЯТО', tip: 'Продавец снял товар с продажи' },
    gone: { zh: '已删除', ru: 'УДАЛЕНО', tip: 'Объявление удалено' },
  };

  function renderRow(f) {
    const cart = view === 'cart';
    const url = f.url || `https://www.goofish.com/item?id=${f.id}`;
    const row = h('div', 'row');
    row.dataset.id = f.id;

    const th = h('a', 'thumb');
    th.href = url;
    th.target = '_blank';
    th.rel = 'noopener';
    if (f.img) {
      const im = h('img');
      im.referrerPolicy = 'no-referrer';
      im.alt = '';
      im.src = f.img;
      th.appendChild(im);
    } else {
      th.classList.add('none');
      th.textContent = '暂无图片'; // «нет фото»
    }
    // продан / снят / удалён — красный штамп прямо на превью
    const st = STATUS[f.status];
    if (st) {
      th.classList.add('st');
      const stamp = h('span', 'stamp');
      stamp.appendChild(h('b', null, st.zh));
      stamp.appendChild(h('i', null, st.ru));
      th.appendChild(stamp);
    }
    // в подсказке — когда статус проверялся в последний раз (видно, что проверка работает)
    const when = f.statusAt ? new Date(f.statusAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    if (st || when) th.title = (st ? st.tip : 'В продаже') + (when ? ` · проверено ${when}` : '');
    row.appendChild(th);

    const mid = h('div', 'mid');
    const a = h('a', 'title', f.title || f.titleZh || `Item ${f.id}`);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = f.titleZh && f.titleZh !== f.title ? `${f.title}\n${f.titleZh}` : (f.title || '');
    mid.appendChild(a);
    mid.appendChild(h('div', 'meta'));
    if (cart) {
      const ctrl = h('div', 'ctrl');
      const cny = h('label', 'cny', '¥');
      const pin = h('input', 'price');
      pin.type = 'number';
      pin.min = '0';
      pin.step = 'any';
      pin.value = priceOf(f);
      pin.title = 'Цену можно поправить (например, после торга)';
      cny.appendChild(pin);
      ctrl.appendChild(cny);
      const q = h('div', 'qty');
      q.appendChild(h('button', 'minus', '−'));
      q.appendChild(h('span', 'qn'));
      q.appendChild(h('button', 'plus', '+'));
      ctrl.appendChild(q);
      mid.appendChild(ctrl);
    } else {
      mid.appendChild(h('div', 'pr'));
    }
    row.appendChild(mid);

    const right = h('div', 'right');
    right.appendChild(h('div', 'tb'));
    const acts = h('div', 'acts');
    if (!cart) acts.appendChild(h('button', 'tocart'));
    const del = h('button', 'del', cart ? 'убрать' : 'удалить');
    del.title = cart ? 'Убрать из корзины' : 'Удалить из избранного';
    acts.appendChild(del);
    right.appendChild(acts);
    row.appendChild(right);

    renderRowTotals(row, f);
    return row;
  }

  function renderRowTotals(row, f) {
    const cart = view === 'cart';
    const c = gfxCalc(priceOf(f) * (cart ? qtyOf(f) : 1), S, market);
    row.querySelector('.tb').textContent = `${gfxFmtRub.format(c.buyer)} ₽`;
    if (cart) {
      row.querySelector('.qn').textContent = qtyOf(f);
    } else {
      row.querySelector('.pr').textContent = `¥${priceOf(f).toFixed(2)}`; // по-магазинному, с копейками
      const tc = row.querySelector('.tocart');
      tc.classList.toggle('on', inCart(f));
      tc.textContent = '';
      if (!inCart(f)) tc.appendChild(h('i', 'ico-cart'));
      tc.appendChild(document.createTextNode(inCart(f) ? 'В корзине ✓' : 'В корзину'));
      tc.title = inCart(f) ? 'Убрать из корзины' : 'Добавить в корзину';
    }
    // под названием — только то, что важно для цены: своя цена или изменение цены на сайте
    const meta = row.querySelector('.meta');
    meta.textContent = '';
    if (f.manual && f.listPrice != null && +f.listPrice !== priceOf(f)) {
      meta.appendChild(h('span', 'manual', `ваша цена · на сайте ¥${gfxFmtCny.format(+f.listPrice)}`));
    } else if (f.priceAtAdd != null && f.listPrice != null && +f.listPrice !== +f.priceAtAdd) {
      const down = +f.listPrice < +f.priceAtAdd;
      meta.appendChild(h('span', down ? 'down' : 'up', `${down ? '↓' : '↑'} было ¥${gfxFmtCny.format(+f.priceAtAdd)}`));
    }
  }

  function renderSummary() {
    if (!panelEl) return;
    const t = totals();
    const nf = listOf('favs').length;
    for (const tab of panelEl.querySelectorAll('.tab')) {
      const n = tab.dataset.view === 'cart' ? t.n : nf;
      tab.querySelector('.cnt').textContent = n ? String(n) : '';
    }
    const sc = panelEl.querySelector('.sCount');
    if (sc) {
      sc.querySelector('.k').textContent = goods(t.n) + (t.pcs !== t.n ? ` (${t.pcs} шт.)` : '');
      sc.querySelector('.v').textContent = `¥${gfxFmtCny.format(t.cny)}`;
    }
    const sb = panelEl.querySelector('.sBuyer');
    if (sb) sb.textContent = `${gfxFmtRub.format(gfxCalc(t.cny, S, market).buyer)} ₽`;
    renderButtons();
  }

  // ---------------------------------------------------------------- events
  function bindPanel() {
    root.addEventListener('click', (e) => {
      const t = e.target;
      if (t.closest('.x')) { close(); return; }
      const tab = t.closest('.tab');
      if (tab) { if (tab.dataset.view !== view) show(tab.dataset.view); return; }
      if (t.closest('.copy')) { copyList(t.closest('.copy')); return; }
      if (t.closest('.clear')) { clearAll(t.closest('.clear')); return; }
      if (t.closest('.allcart')) {
        const now = Date.now();
        for (const f of listOf('favs')) if (!inCart(f)) { f.cart = true; f.cartAt = now; }
        save(true);
        show('cart');
        return;
      }
      const row = t.closest('.row');
      const f = row && favs[row.dataset.id];
      if (!f) return;
      if (t.closest('.plus')) f.qty = qtyOf(f) + 1;
      else if (t.closest('.minus')) f.qty = Math.max(1, qtyOf(f) - 1);
      else if (t.closest('.tocart')) {
        if (inCart(f)) f.cart = false; else { f.cart = true; f.cartAt = Date.now(); }
      } else if (t.closest('.del')) {
        unlist(f, view);
        save(true);
        renderPanel();
        return;
      } else return;
      renderRowTotals(row, f);
      renderSummary();
      save();
    });

    root.addEventListener('input', (e) => {
      const t = e.target;
      if (!t.classList.contains('price')) return;
      const row = t.closest('.row');
      const f = row && favs[row.dataset.id];
      const v = parseFloat(t.value);
      if (!f || !isFinite(v) || v < 0) return;
      f.price = v;
      f.manual = f.listPrice == null || v !== +f.listPrice;
      renderRowTotals(row, f);
      renderSummary();
      save();
    });

    // не даём горячим клавишам сайта перехватывать ввод в панели
    for (const type of ['keydown', 'keyup', 'keypress']) {
      root.addEventListener(type, (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
    }
  }

  let clearTimer = 0;
  function clearAll(btn) {
    if (!btn.classList.contains('warn')) {
      btn.classList.add('warn');
      btn.textContent = 'Точно?';
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => { btn.classList.remove('warn'); btn.textContent = 'Очистить'; }, 3000);
      return;
    }
    for (const f of listOf(view)) unlist(f, view);
    save(true);
    renderPanel();
  }

  async function copyList(btn) {
    const items = sorted('cart');
    if (!items.length) return;
    const lines = items.map((f, i) => {
      const q = qtyOf(f);
      const name = f.titleZh && f.titleZh !== f.title ? `${f.title} / ${f.titleZh}` : f.title;
      return `${i + 1}. ${name}\n   ¥${gfxFmtCny.format(priceOf(f))}${q > 1 ? ` × ${q} шт.` : ''} — ${f.url || 'https://www.goofish.com/item?id=' + f.id}`;
    });
    const t = totals();
    const c = gfxCalc(t.cny, S, market);
    const text = lines.join('\n') +
      `\n\nИтого: ¥${gfxFmtCny.format(t.cny)} (${t.pcs} шт.)` +
      `\nС байером: ¥${gfxFmtCny.format(t.cny)} × ${S.buyerRate} + ${S.buyerFee}% = ${gfxFmtRub.format(c.buyer)} ₽`;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      root.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
    }
    const prev = btn.textContent;
    btn.textContent = ok ? 'Скопировано ✓' : 'Не удалось скопировать';
    setTimeout(() => { btn.textContent = prev; }, 1600);
  }

  // китайские названия (★ нажали раньше, чем пришёл перевод) — допереводим
  let translating = false;
  function translateTitles() {
    if (translating) return;
    const todo = Object.values(favs).filter((f) => f.title && CJK.test(f.title)).slice(0, 40);
    if (!todo.length) return;
    translating = true;
    try {
      chrome.runtime.sendMessage({ type: 'tr', texts: todo.map((f) => f.title), sl: 'zh-CN', tl: S.lang || 'en' }, (r) => {
        translating = false;
        if (chrome.runtime.lastError || !r || !r.ok || !r.res) return;
        todo.forEach((f, i) => {
          const tr = (r.res[i] || '').trim();
          if (tr && favs[f.id]) { favs[f.id].titleZh = favs[f.id].titleZh || f.title; favs[f.id].title = tr; }
        });
        save(true);
        if (isOpen) renderPanel();
      });
    } catch (e) { translating = false; }
  }

  // ================================================================= фоновая проверка статуса
  // При открытии окна узнаём у Goofish статус одного-двух товаров, которые дольше всех не проверялись,
  // — тем же запросом карточки товара, каким пользуется сама страница. Ограничения намеренно жёсткие:
  // на частые запросы Goofish отвечает требованием входа. Если сайт попросил вход или проверку,
  // останавливаемся на сутки и ничего не обходим.
  const CHECK = {
    perOpen: 2,                 // товаров за одно открытие окна
    itemEvery: 12 * 3600e3,     // один и тот же товар — не чаще раза в 12 часов
    batchEvery: 10 * 60e3,      // сами проверки — не чаще раза в 10 минут
    pauseHard: 24 * 3600e3,     // сайт потребовал вход/проверку — пауза на сутки
    pauseSoft: 3600e3           // сеть или непонятный ответ — пауза на час
  };
  const APP_KEY = '34839810';
  const DETAIL_API = 'mtop.taobao.idle.pc.detail';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function md5(str) {
    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const bytes = new TextEncoder().encode(str);
    const n = bytes.length;
    const buf = new Uint8Array((((n + 8) >> 6) + 1) * 64);
    buf.set(bytes);
    buf[n] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(buf.length - 8, (n * 8) >>> 0, true);
    dv.setUint32(buf.length - 4, Math.floor(n / 536870912), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < buf.length; off += 64) {
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * i) % 16; }
        const k = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
        const x = (a + f + k + dv.getUint32(off + g * 4, true)) | 0;
        const s = S[(i >> 4) * 4 + (i % 4)];
        a = d; d = c; c = b;
        b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
      }
      a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
    }
    const out = new DataView(new ArrayBuffer(16));
    [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
    return [...new Uint8Array(out.buffer)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  // запрос подписывается так же, как это делает страница: md5(токен из cookie & время & ключ & данные)
  async function fetchDetail(id) {
    const tk = (document.cookie.match(/(?:^|;\s*)_m_h5_tk=([^;_]*)_/) || [])[1] || '';
    const data = JSON.stringify({ itemId: String(id) });
    const t = String(Date.now());
    const q = new URLSearchParams({
      jsv: '2.7.2', appKey: APP_KEY, t, sign: md5(`${tk}&${t}&${APP_KEY}&${data}`), v: '1.0',
      type: 'originaljson', accountSite: 'xianyu', dataType: 'json', timeout: '20000',
      api: DETAIL_API, sessionOption: 'AutoLoginOnly', spm_cnt: 'a21ybx.item.0.0'
    });
    const res = await fetch(`https://h5api.m.goofish.com/h5/${DETAIL_API}/1.0/?${q}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(data)
    });
    return res.json();
  }

  // ответ → 'ok' | 'sold' | 'off' | 'gone' | 'retry' (выдан свежий токен) | 'stop' (сайт требует вход) | null
  function readDetail(j) {
    const ret = String((j && j.ret && j.ret[0]) || '');
    if (ret.startsWith('SUCCESS')) {
      const m = JSON.stringify(j.data || {}).match(/"itemStatusStr":"([^"]*)"/);
      const s = m ? m[1] : '';
      return s === '卖掉了' ? 'sold' : s === '已下架' ? 'off' : s === '在线' ? 'ok' : null;
    }
    if (ret.startsWith('FAIL_BIZ_ITEM_DEL_NOT_FOUND')) return 'gone';
    if (ret.startsWith('FAIL_SYS_TOKEN')) return 'retry';
    if (/USER_VALIDATE|RGV587|SESSION_EXPIRED|ILLEGAL_ACCESS|被挤爆/.test(ret)) return 'stop';
    return null;
  }

  let checking = false;
  async function checkStale() {
    if (checking || !ready || S.autoCheck === false) return;
    checking = true;
    let sc = {};
    const put = (patch) => chrome.storage.local.set({ statusCheck: (sc = { ...sc, ...patch }) });
    try {
      sc = (await chrome.storage.local.get('statusCheck')).statusCheck || {};
      const now = Date.now();
      if (now < (sc.pausedUntil || 0) || now - (sc.lastAt || 0) < CHECK.batchEvery) return;
      const seen = (f) => Math.max(f.statusAt || 0, f.checkedAt || 0);
      const stale = Object.values(favs).filter((f) => now - seen(f) > CHECK.itemEvery)
        .sort((a, b) => seen(a) - seen(b)).slice(0, CHECK.perOpen).map((f) => f.id);
      if (!stale.length) return;
      await put({ lastAt: now });
      for (let i = 0; i < stale.length; i++) {
        if (i) await sleep(2500 + Math.random() * 2500);
        let r = readDetail(await fetchDetail(stale[i]));
        if (r === 'retry') r = readDetail(await fetchDetail(stale[i]));
        if (r === 'stop') { await put({ pausedUntil: Date.now() + CHECK.pauseHard, why: 'login' }); return; }
        const f = favs[stale[i]];
        if (!f) continue;
        f.checkedAt = Date.now();
        if (r === 'ok' || r === 'sold' || r === 'off' || r === 'gone') {
          if (r === 'ok') delete f.status; else f.status = r;
          f.statusAt = f.checkedAt;
        }
        save(true);
        if (isOpen) renderPanel();
      }
    } catch (e) {
      // сеть недоступна или ответ не разобрать — не настаиваем
      try { await put({ pausedUntil: Date.now() + CHECK.pauseSoft, why: 'error' }); } catch (e2) { /* ignore */ }
    } finally {
      checking = false;
    }
  }

  self.GFXPanel = { open: openWhenReady, close, toggle, bump };
})();
