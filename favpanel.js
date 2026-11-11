/* Goofish EN — кнопки «Избранное» и «Корзина» в шапке Goofish и всплывающая панель.
 * Два независимых списка в chrome.storage.local (общие с ☆ и 🛒 в content.js):
 *   favs — избранное, простой список «на потом»;
 *   cart — корзина: галочки, количество, правка цены, итог через байера и минимум заказа.
 * Панель живёт в Shadow DOM: стили сайта её не ломают, а переводчик её не трогает.
 */
(() => {
  'use strict';
  if (window.top !== window || window.__gfxPanelLoaded) return;
  window.__gfxPanelLoaded = true;

  const KINDS = ['cart', 'favs'];
  const HASH = { '#gfx-cart': 'cart', '#gfx-favs': 'favs' };
  const LABEL = { cart: 'Корзина', favs: 'Избранное' };
  const ICON = { cart: '🛒', favs: '★' };
  const CJK = /[㐀-鿿]/;

  let S = { ...GFX_DEFAULTS };
  let market = { RUB: 12.18, USD: 0.1496, ts: 0 };
  const lists = { cart: {}, favs: {} };
  const lastWritten = { cart: '', favs: '' };
  let ready = false;

  const hdr = { cart: null, favs: null }; // кнопки в шапке
  let hdrVisible = false;                 // видны ли кнопки шапки на экране
  let floatBtn = null;                    // плавающая кнопка, когда шапка уехала за экран
  let host = null, root = null, panelEl = null;
  let isOpen = false;
  let mode = 'cart';                      // какой раздел показывает панель

  // ================================================================= utils
  const qtyOf = (f) => Math.max(1, Math.round(+f.qty || 1));
  const priceOf = (f) => Math.max(0, +f.price || 0);
  const countOf = (kind) => Object.keys(lists[kind]).length;
  const urlOf = (f) => f.url || `https://www.goofish.com/item?id=${f.id}`;

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  const goods = (n) => `${n} ${plural(n, 'товар', 'товара', 'товаров')}`;

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** Итог корзины: только отмеченные товары */
  function totals() {
    let cny = 0, pcs = 0, n = 0;
    const all = Object.values(lists.cart);
    for (const f of all) {
      if (f.sel === false) continue;
      n++;
      pcs += qtyOf(f);
      cny += priceOf(f) * qtyOf(f);
    }
    return { cny, pcs, n, count: all.length };
  }

  function sorted(kind) {
    return Object.values(lists[kind]).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  const saveTimers = {};
  function save(kind, now) {
    clearTimeout(saveTimers[kind]);
    const run = () => {
      lastWritten[kind] = JSON.stringify(lists[kind]);
      try { chrome.storage.local.set({ [kind]: lists[kind] }); } catch (e) { /* контекст расширения перезагружен */ }
    };
    if (now) run(); else saveTimers[kind] = setTimeout(run, 300);
  }

  // ================================================================= data
  try {
    chrome.storage.local.get(['settings', 'rates', 'favs', 'cart'], (d) => {
      d = d || {};
      S = { ...GFX_DEFAULTS, ...(d.settings || {}) };
      if (d.rates) market = d.rates;
      for (const k of KINDS) {
        lists[k] = d[k] || {};
        lastWritten[k] = JSON.stringify(lists[k]);
      }
      ready = true;
      ensureButtons();
      if (HASH[location.hash]) {
        const kind = HASH[location.hash];
        history.replaceState(null, '', location.pathname + location.search);
        openWhenReady(kind);
      }
    });
  } catch (e) { return; }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let full = false;
    for (const k of KINDS) {
      if (!changes[k]) continue;
      const nv = changes[k].newValue || {};
      const js = JSON.stringify(nv);
      if (js !== lastWritten[k]) { lists[k] = nv; lastWritten[k] = js; full = true; }
    }
    if (changes.settings) { S = { ...GFX_DEFAULTS, ...(changes.settings.newValue || {}) }; full = true; }
    if (changes.rates && changes.rates.newValue) { market = changes.rates.newValue; full = true; }
    if (full) { renderButtons(); if (isOpen) renderPanel(); }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'openPanel') {
      openWhenReady(msg.mode === 'favs' ? 'favs' : 'cart');
      sendResponse({ ok: true });
    }
  });

  // ================================================================= buttons
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const e of entries) if (e.target === hdr.cart) hdrVisible = e.isIntersecting;
      renderFloat();
      placeSoon();
    })
    : null;

  function headerSlot() {
    return document.querySelector('[class*="user-order-container"]') || document.querySelector('[class*="header-right"]');
  }

  function makeHdrBtn(kind) {
    const b = h('button', 'gfx-ui gfx-hdr-fav gfx-hdr-' + kind);
    b.type = 'button';
    b.appendChild(h('span', 'gfx-hdr-ico', ICON[kind]));
    b.appendChild(h('span', 'gfx-hdr-txt', LABEL[kind]));
    b.appendChild(h('span', 'gfx-hdr-badge'));
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggle(kind);
    });
    return b;
  }

  function ensureButtons() {
    if (!ready || !document.body) return;
    const slot = headerSlot();
    const ok = (b) => b && b.isConnected && b.parentElement === slot;
    if (slot && !(ok(hdr.favs) && ok(hdr.cart))) {
      if (hdr.cart && io) io.unobserve(hdr.cart);
      for (const k of KINDS) if (hdr[k]) hdr[k].remove();
      hdr.favs = makeHdrBtn('favs');
      hdr.cart = makeHdrBtn('cart');
      slot.appendChild(hdr.favs);
      slot.appendChild(hdr.cart);
      if (io) io.observe(hdr.cart); else hdrVisible = true;
      placeSoon();
    } else if (!slot && hdr.cart && !hdr.cart.isConnected) {
      hdr.cart = hdr.favs = null;
      hdrVisible = false;
    }
    renderButtons();
  }

  function renderButtons() {
    if (!ready) return;
    const t = totals();
    const c = gfxCalc(t.cny, S, market);
    const nFav = countOf('favs');
    if (hdr.cart) {
      hdr.cart.querySelector('.gfx-hdr-badge').textContent = t.count ? String(t.count) : '';
      hdr.cart.classList.toggle('gfx-open', isOpen && mode === 'cart');
      hdr.cart.title = t.count
        ? `Корзина: ${goods(t.count)} · с байером ${gfxFmtRub.format(c.buyer)} ₽`
        : 'Корзина пуста — нажмите 🛒 рядом с ценой';
    }
    if (hdr.favs) {
      hdr.favs.querySelector('.gfx-hdr-badge').textContent = nFav ? String(nFav) : '';
      hdr.favs.classList.toggle('gfx-open', isOpen && mode === 'favs');
      hdr.favs.title = nFav ? `Избранное: ${goods(nFav)}` : 'Избранное пусто — нажмите ☆ рядом с ценой';
    }
    renderFloat();
  }

  // плавающая кнопка — только если кнопок в шапке не видно (прокрутили вниз или шапки нет)
  function renderFloat() {
    if (!ready || !document.body) return;
    const t = totals();
    const nFav = countOf('favs');
    const need = (t.count > 0 || nFav > 0) && !(hdr.cart && hdr.cart.isConnected && hdrVisible);
    if (!need) {
      if (floatBtn) { floatBtn.remove(); floatBtn = null; }
      return;
    }
    if (!floatBtn || !floatBtn.isConnected) {
      floatBtn = h('div', 'gfx-ui gfx-cart');
      floatBtn.addEventListener('click', (e) => {
        const part = e.target.closest('[data-kind]');
        if (!part) return;
        e.preventDefault();
        e.stopPropagation();
        toggle(part.dataset.kind);
      });
      document.body.appendChild(floatBtn);
    }
    floatBtn.textContent = '';
    if (t.count > 0) {
      const c = gfxCalc(t.cny, S, market);
      const p = h('span', 'gfx-cart-part');
      p.dataset.kind = 'cart';
      p.setAttribute('role', 'button');
      p.title = 'Открыть корзину';
      p.appendChild(h('span', 'gfx-cart-star', ICON.cart));
      p.appendChild(h('span', 'gfx-cart-count', String(t.count)));
      p.appendChild(h('span', 'gfx-cart-sum', `с байером ${gfxFmtRub.format(c.buyer)} ₽`));
      floatBtn.appendChild(p);
    }
    if (nFav > 0) {
      const p = h('span', 'gfx-cart-part');
      p.dataset.kind = 'favs';
      p.setAttribute('role', 'button');
      p.title = 'Открыть избранное';
      p.appendChild(h('span', 'gfx-cart-star', ICON.favs));
      p.appendChild(h('span', 'gfx-cart-count', String(nFav)));
      floatBtn.appendChild(p);
    }
  }

  function bump(kind) {
    for (const el of [hdr[kind === 'favs' ? 'favs' : 'cart'], floatBtn]) {
      if (!el) continue;
      el.classList.remove('gfx-bump');
      void el.offsetWidth;
      el.classList.add('gfx-bump');
    }
  }

  setInterval(ensureButtons, 800);
  document.addEventListener('DOMContentLoaded', ensureButtons);

  // ================================================================= panel
  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel {
  position: fixed; z-index: 2147483647;
  width: 440px; max-width: calc(100vw - 16px);
  display: flex; flex-direction: column;
  background: #fff; color: #1d1d1f;
  border: 1px solid rgba(0,0,0,.08); border-radius: 16px;
  box-shadow: 0 18px 50px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.06);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  opacity: 0; transform: translateY(-6px) scale(.98); transform-origin: top right;
  transition: opacity .14s ease, transform .14s ease;
}
.panel.up { transform-origin: bottom left; transform: translateY(6px) scale(.98); }
.panel.show { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) { .panel { transition: none; } }
.caret { position: absolute; width: 14px; height: 14px; background: #fff; transform: rotate(45deg);
  border-left: 1px solid rgba(0,0,0,.08); border-top: 1px solid rgba(0,0,0,.08); top: -8px; }
.panel.up .caret { display: none; }
.ph { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #f0f0f2; }
.tabs { flex: 1; display: flex; gap: 4px; min-width: 0; }
.tab { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border: 0; border-radius: 9px;
  background: transparent; color: #6e6e73; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.tab:hover { background: #f2f2f4; color: #1d1d1f; }
.tab.on { background: #1d1d1f; color: #fff; }
.tab .ico { font-size: 14px; }
.tab[data-kind="favs"] .ico { color: #f5c400; }
.tab .cnt { min-width: 18px; padding: 0 5px; border-radius: 9px; background: rgba(0,0,0,.07); font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; }
.tab.on .cnt { background: #ffe60f; color: #1d1d1f; }
.tab .cnt:empty { display: none; }
.all { display: inline-flex; align-items: center; gap: 5px; color: #6e6e73; font-size: 12px; cursor: pointer; user-select: none; }
.x { width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: #86868b; font-size: 14px; cursor: pointer; }
.x:hover { background: #f2f2f4; color: #1d1d1f; }
input[type="checkbox"] { accent-color: #1d1d1f; width: 16px; height: 16px; margin: 0; cursor: pointer; }
.list { overflow-y: auto; overscroll-behavior: contain; padding: 4px 6px; min-height: 60px; }
.row { display: grid; grid-template-columns: 18px 56px minmax(0,1fr) auto; gap: 10px; align-items: start;
  padding: 10px 8px; border-radius: 10px; }
.row.fav { grid-template-columns: 56px minmax(0,1fr) auto; }
.row + .row { border-top: 1px solid #f4f4f6; }
.row:hover { background: #fafafa; }
.row.off { opacity: .5; }
.row .sel { margin-top: 20px; }
.thumb { display: block; width: 56px; height: 56px; border-radius: 8px; overflow: hidden; background: #eee; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mid { min-width: 0; }
.title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  color: #1d1d1f; font-weight: 600; text-decoration: none; }
.title:hover { text-decoration: underline; }
.meta { font-size: 11px; color: #86868b; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta .up { color: #d70015; font-weight: 600; }
.meta .down { color: #1a7f37; font-weight: 600; }
.meta .manual { color: #8a6d00; }
.ctrl { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.cny { display: inline-flex; align-items: center; gap: 3px; font-weight: 700; }
.price { width: 76px; height: 26px; padding: 0 6px; border: 1px solid #e3e3e8; border-radius: 7px; font: inherit; font-weight: 600; color: #1d1d1f; background: #fff; outline: none; }
.price:focus { border-color: #c9b800; box-shadow: 0 0 0 3px rgba(255,230,15,.35); }
.qty { display: inline-flex; align-items: center; border: 1px solid #e3e3e8; border-radius: 7px; overflow: hidden; }
.qty button { width: 24px; height: 24px; border: 0; background: #fff; font-size: 14px; cursor: pointer; color: #1d1d1f; }
.qty button:hover { background: #f2f2f4; }
.qn { min-width: 22px; text-align: center; font-weight: 600; font-size: 12px; }
.tocart { height: 26px; padding: 0 9px; border: 1px solid #1d1d1f; border-radius: 7px; background: #fff; color: #1d1d1f;
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.tocart:hover { background: #f2f2f4; }
.tocart.on { background: #1d1d1f; color: #ffe60f; }
.right { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.tb { font-weight: 700; font-size: 14px; white-space: nowrap; }
.tb::before { content: 'байер'; margin-right: 5px; padding: 1px 5px; border-radius: 4px; background: #ffe60f;
  font-size: 9px; font-weight: 700; text-transform: uppercase; vertical-align: 1px; }
.tm { font-size: 11px; color: #86868b; white-space: nowrap; }
.del { margin-top: 4px; width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent; color: #aeaeb2; cursor: pointer; font-size: 12px; }
.del:hover { background: #fde8e8; color: #d70015; }
.empty { padding: 34px 20px; text-align: center; color: #86868b; }
.empty b { display: block; color: #1d1d1f; font-size: 14px; margin-bottom: 4px; }
.pf { border-top: 1px solid #f0f0f2; padding: 12px 14px 14px; background: #fcfcfd; border-radius: 0 0 16px 16px; }
.sr { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; color: #3a3a3c; }
.sr.muted { color: #86868b; font-size: 12px; }
.buyer { display: flex; align-items: baseline; gap: 8px; margin-top: 8px; padding: 8px 10px; border-radius: 10px;
  background: #fffbe0; border: 1px solid #ffe60f; }
.buyer .k { color: #6e6e73; font-size: 12px; }
.buyer .big { font-size: 22px; font-weight: 800; letter-spacing: -.01em; }
.buyer .usd { color: #86868b; font-size: 12px; margin-left: auto; }
.formula { margin-top: 6px; color: #6e6e73; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.minwarn { margin-top: 8px; padding: 7px 10px; border-radius: 9px; background: #fff4e5; border: 1px solid #ffcf8a; color: #8a4b00; font-size: 12px; }
.minwarn b { font-weight: 700; }
.minwarn:empty { display: none; }
.btns { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: 10px; }
.pf.favs .btns { margin-top: 0; }
.btns button { height: 34px; border-radius: 9px; font: inherit; font-weight: 600; cursor: pointer; padding: 0 12px; }
.primary { border: 0; background: #1d1d1f; color: #fff; }
.primary:hover { background: #000; }
.ghost { border: 1px solid #e3e3e8; background: #fff; color: #1d1d1f; font-weight: 500 !important; }
.ghost:hover { background: #f6f6f8; }
.ghost.warn { border-color: #f3c2c2; color: #d70015; background: #fff5f5; }
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
    const b = hdr[mode];
    if (b && b.isConnected && hdrVisible) return b;
    if (floatBtn && floatBtn.isConnected) return floatBtn;
    return b && b.isConnected ? b : null;
  }

  function place() {
    if (!isOpen || !panelEl) return;
    const W = Math.min(440, innerWidth - 16);
    const a = anchorEl();
    const r = a ? a.getBoundingClientRect() : { top: 0, bottom: 0, left: innerWidth - 24, right: innerWidth - 8, width: 16 };
    const caret = panelEl.querySelector('.caret');
    const left = Math.min(Math.max(8, r.right - W + 12), innerWidth - W - 8);
    panelEl.style.left = left + 'px';
    if (r.top < innerHeight / 2) {
      const top = Math.max(8, r.bottom + 10);
      panelEl.classList.remove('up');
      panelEl.style.top = top + 'px';
      panelEl.style.bottom = '';
      panelEl.style.maxHeight = Math.max(260, innerHeight - top - 12) + 'px';
      if (caret) {
        const cx = r.left + r.width / 2 - left - 7;
        caret.style.display = r.bottom > 0 && cx > 12 && cx < W - 24 ? '' : 'none';
        caret.style.left = cx + 'px';
      }
    } else {
      const bottom = Math.max(8, innerHeight - r.top + 10);
      panelEl.classList.add('up');
      panelEl.style.top = '';
      panelEl.style.bottom = bottom + 'px';
      panelEl.style.maxHeight = Math.max(260, innerHeight - bottom - 12) + 'px';
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

  function open(kind) {
    if (!ready) return;
    if (kind) mode = kind;
    ensureHost();
    isOpen = true;
    renderPanel();
    place();
    requestAnimationFrame(() => { if (panelEl) panelEl.classList.add('show'); });
    renderButtons();
    translateTitles();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    if (panelEl) panelEl.classList.remove('show');
    setTimeout(() => { if (!isOpen && host) { host.remove(); host = null; root = null; panelEl = null; } }, 160);
    renderButtons();
  }

  function toggle(kind) {
    kind = kind || mode;
    if (isOpen && mode === kind) close(); else open(kind);
  }

  function openWhenReady(kind, tries = 0) {
    if (ready && document.body) { ensureButtons(); open(kind); return; }
    if (tries < 50) setTimeout(() => openWhenReady(kind, tries + 1), 100);
  }

  // закрытие: клик вне панели и Esc
  addEventListener('pointerdown', (e) => {
    if (!isOpen) return;
    const path = e.composedPath();
    if (path.includes(host) || path.includes(hdr.cart) || path.includes(hdr.favs) || path.includes(floatBtn)) return;
    close();
  }, true);
  addEventListener('keydown', (e) => { if (isOpen && e.key === 'Escape') close(); }, true);

  // ---------------------------------------------------------------- render
  function renderPanel() {
    if (!panelEl) return;
    const prevList = panelEl.querySelector('.list');
    const scroll = prevList && prevList.dataset.kind === mode ? prevList.scrollTop : 0;
    panelEl.textContent = '';
    panelEl.setAttribute('aria-label', LABEL[mode]);
    panelEl.appendChild(h('div', 'caret'));

    const items = sorted(mode);
    const ph = h('div', 'ph');
    const tabs = h('div', 'tabs');
    for (const k of KINDS) {
      const tab = h('button', 'tab' + (k === mode ? ' on' : ''));
      tab.type = 'button';
      tab.dataset.kind = k;
      tab.appendChild(h('span', 'ico', ICON[k]));
      tab.appendChild(document.createTextNode(LABEL[k]));
      tab.appendChild(h('span', 'cnt', countOf(k) ? String(countOf(k)) : ''));
      tabs.appendChild(tab);
    }
    ph.appendChild(tabs);
    if (mode === 'cart' && items.length) {
      const all = h('label', 'all');
      const cb = h('input', 'selAll');
      cb.type = 'checkbox';
      all.appendChild(cb);
      all.appendChild(document.createTextNode('все'));
      ph.appendChild(all);
    }
    const x = h('button', 'x', '✕');
    x.setAttribute('aria-label', 'Закрыть');
    ph.appendChild(x);
    panelEl.appendChild(ph);

    const list = h('div', 'list');
    list.dataset.kind = mode;
    if (!items.length) {
      const e = h('div', 'empty');
      if (mode === 'cart') {
        e.appendChild(h('b', null, 'Корзина пуста'));
        e.appendChild(document.createTextNode('Нажмите 🛒 рядом с ценой товара или «В корзину» в избранном.'));
      } else {
        e.appendChild(h('b', null, 'Пока пусто'));
        e.appendChild(document.createTextNode('Нажмите ☆ рядом с ценой товара — он появится здесь.'));
      }
      list.appendChild(e);
    }
    for (const f of items) list.appendChild(mode === 'cart' ? renderCartRow(f) : renderFavRow(f));
    panelEl.appendChild(list);

    const pf = h('div', 'pf ' + mode);
    if (mode === 'cart') {
      pf.appendChild(sumRow('sr sCount', '', ''));
      pf.appendChild(sumRow('sr muted sMarket', 'По рыночному курсу', ''));
      const b = h('div', 'buyer');
      b.appendChild(h('span', 'k', 'С байером'));
      b.appendChild(h('span', 'big sBuyer'));
      b.appendChild(h('span', 'usd sBuyerUsd'));
      pf.appendChild(b);
      pf.appendChild(h('div', 'formula sFormula'));
      pf.appendChild(h('div', 'minwarn sMin'));
      const btns = h('div', 'btns');
      btns.appendChild(h('button', 'primary copy', 'Скопировать список для байера'));
      btns.appendChild(h('button', 'ghost clear', 'Очистить'));
      pf.appendChild(btns);
    } else {
      const btns = h('div', 'btns');
      btns.appendChild(h('button', 'primary allToCart', 'Всё в корзину'));
      btns.appendChild(h('button', 'ghost clear', 'Очистить'));
      pf.appendChild(btns);
    }
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

  function rowBase(f, cls) {
    const url = urlOf(f);
    const row = h('div', cls);
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
    }
    const mid = h('div', 'mid');
    const a = h('a', 'title', f.title || f.titleZh || `Item ${f.id}`);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = f.titleZh && f.titleZh !== f.title ? `${f.title}\n${f.titleZh}` : (f.title || '');
    mid.appendChild(a);
    mid.appendChild(h('div', 'meta'));
    const ctrl = h('div', 'ctrl');
    mid.appendChild(ctrl);
    const right = h('div', 'right');
    right.appendChild(h('div', 'tb'));
    right.appendChild(h('div', 'tm'));
    const del = h('button', 'del', '✕');
    right.appendChild(del);
    return { row, th, mid, ctrl, right, del };
  }

  function renderCartRow(f) {
    const p = rowBase(f, 'row');
    const sel = h('input', 'sel');
    sel.type = 'checkbox';
    sel.title = 'Учитывать в сумме';
    p.row.appendChild(sel);
    p.row.appendChild(p.th);

    const cny = h('label', 'cny', '¥');
    const pin = h('input', 'price');
    pin.type = 'number';
    pin.min = '0';
    pin.step = 'any';
    pin.value = priceOf(f);
    pin.title = 'Цену можно поправить (например, после торга)';
    cny.appendChild(pin);
    p.ctrl.appendChild(cny);
    const q = h('div', 'qty');
    q.appendChild(h('button', 'minus', '−'));
    q.appendChild(h('span', 'qn'));
    q.appendChild(h('button', 'plus', '+'));
    p.ctrl.appendChild(q);
    p.row.appendChild(p.mid);
    p.del.title = 'Удалить из корзины';
    p.row.appendChild(p.right);

    renderCartRowTotals(p.row, f);
    return p.row;
  }

  function renderFavRow(f) {
    const p = rowBase(f, 'row fav');
    p.row.appendChild(p.th);
    p.ctrl.appendChild(h('span', 'cny', `¥${gfxFmtCny.format(priceOf(f))}`));
    p.ctrl.appendChild(h('button', 'tocart'));
    p.row.appendChild(p.mid);
    p.del.title = 'Удалить из избранного';
    p.row.appendChild(p.right);

    const c = gfxCalc(priceOf(f), S, market);
    p.row.querySelector('.tb').textContent = `${gfxFmtRub.format(c.buyer)} ₽`;
    p.row.querySelector('.tm').textContent = `≈${gfxFmtRub.format(c.rub)} ₽ · ${gfxFmtUsd(c.usd)}`;
    renderMeta(p.row, f);
    paintToCart(p.row, f);
    return p.row;
  }

  function paintToCart(row, f) {
    const b = row.querySelector('.tocart');
    const on = !!lists.cart[f.id];
    b.classList.toggle('on', on);
    b.textContent = on ? '✓ В корзине' : '🛒 В корзину';
    b.title = on ? 'Убрать из корзины' : 'Добавить в корзину';
  }

  function renderMeta(row, f) {
    const meta = row.querySelector('.meta');
    meta.textContent = '';
    if (f.manual && f.listPrice != null && +f.listPrice !== priceOf(f)) {
      meta.appendChild(h('span', 'manual', `ваша цена · на сайте ¥${gfxFmtCny.format(+f.listPrice)}`));
    } else if (f.priceAtAdd != null && f.listPrice != null && +f.listPrice !== +f.priceAtAdd) {
      const down = +f.listPrice < +f.priceAtAdd;
      meta.appendChild(h('span', down ? 'down' : 'up', `${down ? '↓' : '↑'} было ¥${gfxFmtCny.format(+f.priceAtAdd)}`));
    } else if (f.titleZh && f.titleZh !== f.title) {
      meta.textContent = f.titleZh;
    }
  }

  function renderCartRowTotals(row, f) {
    const c = gfxCalc(priceOf(f) * qtyOf(f), S, market);
    row.querySelector('.tb').textContent = `${gfxFmtRub.format(c.buyer)} ₽`;
    row.querySelector('.tm').textContent = `≈${gfxFmtRub.format(c.rub)} ₽ · ${gfxFmtUsd(c.usd)}`;
    row.querySelector('.qn').textContent = qtyOf(f);
    row.querySelector('.sel').checked = f.sel !== false;
    row.classList.toggle('off', f.sel === false);
    renderMeta(row, f);
  }

  function renderSummary() {
    if (!panelEl) return;
    for (const tab of panelEl.querySelectorAll('.tab')) {
      const n = countOf(tab.dataset.kind);
      tab.querySelector('.cnt').textContent = n ? String(n) : '';
    }
    if (mode === 'cart') {
      const t = totals();
      const c = gfxCalc(t.cny, S, market);
      const set = (sel, txt) => { const e = panelEl.querySelector(sel); if (e) e.textContent = txt; };
      const sc = panelEl.querySelector('.sCount');
      if (sc) {
        sc.querySelector('.k').textContent = `Выбрано ${t.n} из ${t.count}` + (t.pcs !== t.n ? ` (${t.pcs} шт.)` : '');
        sc.querySelector('.v').textContent = `¥${gfxFmtCny.format(t.cny)}`;
      }
      const sm = panelEl.querySelector('.sMarket .v');
      if (sm) sm.textContent = `${gfxFmtRub.format(c.rub)} ₽ · ${gfxFmtUsd(c.usd)}`;
      set('.sBuyer', `${gfxFmtRub.format(c.buyer)} ₽`);
      set('.sBuyerUsd', `≈ ${gfxFmtUsd(c.buyerUsd)}`);
      set('.sFormula', `¥${gfxFmtCny.format(t.cny)} × ${S.buyerRate} = ${gfxFmtRub2.format(c.base)} ₽ + ${S.buyerFee}% (${gfxFmtRub2.format(c.fee)} ₽)`);
      const mw = panelEl.querySelector('.sMin');
      if (mw) {
        const short = t.n ? gfxMinShort(t.cny, S) : 0;
        mw.textContent = '';
        if (short > 0) {
          mw.appendChild(document.createTextNode(`Минимальный заказ у байера ¥${gfxFmtCny.format(+S.minOrder)} — не хватает `));
          mw.appendChild(h('b', null, `¥${gfxFmtCny.format(short)}`));
        }
      }
      const sa = panelEl.querySelector('.selAll');
      if (sa) {
        const all = Object.values(lists.cart);
        sa.checked = all.length > 0 && all.every((f) => f.sel !== false);
        sa.indeterminate = !sa.checked && all.some((f) => f.sel !== false);
      }
    }
    renderButtons();
  }

  // ---------------------------------------------------------------- actions
  /** Копия товара из избранного для корзины */
  function cartItemFrom(f) {
    return {
      id: f.id, url: urlOf(f), title: f.title, titleZh: f.titleZh, img: f.img,
      price: priceOf(f), listPrice: f.listPrice != null ? f.listPrice : priceOf(f), manual: !!f.manual,
      priceAtAdd: priceOf(f), qty: 1, sel: true, addedAt: Date.now()
    };
  }

  function bindPanel() {
    root.addEventListener('click', (e) => {
      const t = e.target;
      if (t.closest('.x')) { close(); return; }
      const tab = t.closest('.tab');
      if (tab) {
        if (tab.dataset.kind !== mode) { mode = tab.dataset.kind; renderPanel(); place(); translateTitles(); }
        return;
      }
      if (t.closest('.copy')) { copyList(t.closest('.copy')); return; }
      if (t.closest('.clear')) { clearAll(t.closest('.clear')); return; }
      if (t.closest('.allToCart')) {
        let added = 0;
        for (const f of sorted('favs').reverse()) {
          if (lists.cart[f.id]) continue;
          lists.cart[f.id] = cartItemFrom(f);
          lists.cart[f.id].addedAt += added++; // сохраняем порядок избранного
        }
        if (added) { save('cart', true); bump('cart'); }
        mode = 'cart';
        renderPanel();
        place();
        return;
      }
      const row = t.closest('.row');
      const f = row && lists[mode][row.dataset.id];
      if (!f) return;
      if (t.closest('.del')) {
        delete lists[mode][f.id];
        save(mode, true);
        renderPanel();
        return;
      }
      if (mode === 'favs') {
        if (!t.closest('.tocart')) return;
        if (lists.cart[f.id]) delete lists.cart[f.id];
        else { lists.cart[f.id] = cartItemFrom(f); bump('cart'); }
        save('cart', true);
        paintToCart(row, f);
        renderSummary();
        return;
      }
      if (t.closest('.plus')) f.qty = qtyOf(f) + 1;
      else if (t.closest('.minus')) f.qty = Math.max(1, qtyOf(f) - 1);
      else return;
      renderCartRowTotals(row, f);
      renderSummary();
      save('cart');
    });

    root.addEventListener('change', (e) => {
      const t = e.target;
      if (mode !== 'cart') return;
      if (t.classList.contains('selAll')) {
        Object.values(lists.cart).forEach((f) => { f.sel = t.checked; });
        panelEl.querySelectorAll('.row').forEach((row) => renderCartRowTotals(row, lists.cart[row.dataset.id]));
        renderSummary();
        save('cart');
        return;
      }
      if (t.classList.contains('sel')) {
        const row = t.closest('.row');
        const f = lists.cart[row.dataset.id];
        if (!f) return;
        f.sel = t.checked;
        renderCartRowTotals(row, f);
        renderSummary();
        save('cart');
      }
    });

    root.addEventListener('input', (e) => {
      const t = e.target;
      if (mode !== 'cart' || !t.classList.contains('price')) return;
      const row = t.closest('.row');
      const f = row && lists.cart[row.dataset.id];
      const v = parseFloat(t.value);
      if (!f || !isFinite(v) || v < 0) return;
      f.price = v;
      f.manual = f.listPrice == null || v !== +f.listPrice;
      renderCartRowTotals(row, f);
      renderSummary();
      save('cart');
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
    clearTimeout(clearTimer);
    lists[mode] = {};
    save(mode, true);
    renderPanel();
  }

  async function copyList(btn) {
    const items = sorted('cart').filter((f) => f.sel !== false);
    if (!items.length) return;
    const lines = items.map((f, i) => {
      const q = qtyOf(f);
      const name = f.titleZh && f.titleZh !== f.title ? `${f.title} / ${f.titleZh}` : f.title;
      return `${i + 1}. ${name}\n   ¥${gfxFmtCny.format(priceOf(f))}${q > 1 ? ` × ${q} шт.` : ''} — ${urlOf(f)}`;
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

  // китайские названия (☆/🛒 нажали раньше, чем пришёл перевод) — допереводим
  let translating = false;
  function translateTitles() {
    if (translating) return;
    const todo = [];
    for (const k of KINDS) {
      for (const f of Object.values(lists[k])) if (f.title && CJK.test(f.title)) todo.push({ k, id: f.id, title: f.title });
    }
    todo.splice(40);
    if (!todo.length) return;
    translating = true;
    try {
      chrome.runtime.sendMessage({ type: 'tr', texts: todo.map((x) => x.title), sl: 'zh-CN', tl: S.lang || 'en' }, (r) => {
        translating = false;
        if (chrome.runtime.lastError || !r || !r.ok || !r.res) return;
        const touched = new Set();
        todo.forEach((x, i) => {
          const tr = (r.res[i] || '').trim();
          const f = lists[x.k][x.id];
          if (tr && f) { f.titleZh = f.titleZh || x.title; f.title = tr; touched.add(x.k); }
        });
        for (const k of touched) save(k, true);
        if (isOpen && touched.size) renderPanel();
      });
    } catch (e) { translating = false; }
  }

  self.GFXPanel = { open: openWhenReady, close, toggle, bump };
})();
