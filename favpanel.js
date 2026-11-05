/* Goofish EN — кнопка «Избранное» в шапке Goofish и всплывающая панель-корзина.
 * Панель живёт в Shadow DOM: стили сайта её не ломают, а переводчик её не трогает.
 * Данные — chrome.storage.local.favs (общие с ☆ в content.js).
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

  let hdrBtn = null;      // кнопка в шапке
  let hdrVisible = false; // видна ли кнопка шапки на экране
  let floatBtn = null;    // плавающая кнопка, когда шапка уехала за экран
  let host = null, root = null, panelEl = null;
  let isOpen = false;

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

  function totals() {
    let cny = 0, pcs = 0, n = 0;
    const all = Object.values(favs);
    for (const f of all) {
      if (f.sel === false) continue;
      n++;
      pcs += qtyOf(f);
      cny += priceOf(f) * qtyOf(f);
    }
    return { cny, pcs, n, count: all.length };
  }

  function sorted() {
    return Object.values(favs).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
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
        openWhenReady();
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
    if (full) { renderButtons(); if (isOpen) renderPanel(); }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'openFavPanel') {
      openWhenReady();
      sendResponse({ ok: true });
    }
  });

  // ================================================================= buttons
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const e of entries) if (e.target === hdrBtn) hdrVisible = e.isIntersecting;
      renderFloat();
      placeSoon();
    })
    : null;

  function headerSlot() {
    return document.querySelector('[class*="user-order-container"]') || document.querySelector('[class*="header-right"]');
  }

  function makeHdrBtn() {
    const b = h('button', 'gfx-ui gfx-hdr-fav');
    b.type = 'button';
    b.appendChild(h('span', 'gfx-hdr-ico', '★'));
    b.appendChild(h('span', 'gfx-hdr-txt', 'Избранное'));
    b.appendChild(h('span', 'gfx-hdr-badge'));
    b.addEventListener('click', onToggleClick);
    return b;
  }

  function onToggleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  }

  function ensureButtons() {
    if (!ready || !document.body) return;
    const slot = headerSlot();
    if (slot && (!hdrBtn || !hdrBtn.isConnected || hdrBtn.parentElement !== slot)) {
      if (hdrBtn && io) io.unobserve(hdrBtn);
      hdrBtn = makeHdrBtn();
      slot.appendChild(hdrBtn);
      if (io) io.observe(hdrBtn); else hdrVisible = true;
      placeSoon();
    } else if (!slot && hdrBtn && !hdrBtn.isConnected) {
      hdrBtn = null;
      hdrVisible = false;
    }
    renderButtons();
  }

  function renderButtons() {
    if (!ready) return;
    const t = totals();
    const c = gfxCalc(t.cny, S, market);
    if (hdrBtn) {
      const badge = hdrBtn.querySelector('.gfx-hdr-badge');
      badge.textContent = t.count ? String(t.count) : '';
      hdrBtn.classList.toggle('gfx-open', isOpen);
      hdrBtn.title = t.count
        ? `Избранное: ${t.count} ${plural(t.count, 'товар', 'товара', 'товаров')} · с байером ${gfxFmtRub.format(c.buyer)} ₽`
        : 'Избранное пусто — нажмите ☆ рядом с ценой';
    }
    renderFloat();
  }

  // плавающая кнопка — только если кнопки в шапке не видно (прокрутили вниз или шапки нет)
  function renderFloat() {
    if (!ready || !document.body) return;
    const t = totals();
    const need = t.count > 0 && !(hdrBtn && hdrBtn.isConnected && hdrVisible);
    if (!need) {
      if (floatBtn) { floatBtn.remove(); floatBtn = null; }
      return;
    }
    if (!floatBtn || !floatBtn.isConnected) {
      floatBtn = h('div', 'gfx-ui gfx-cart');
      floatBtn.setAttribute('role', 'button');
      floatBtn.addEventListener('click', onToggleClick);
      document.body.appendChild(floatBtn);
    }
    const c = gfxCalc(t.cny, S, market);
    floatBtn.textContent = '';
    floatBtn.appendChild(h('span', 'gfx-cart-star', '★'));
    floatBtn.appendChild(h('span', 'gfx-cart-count', String(t.count)));
    floatBtn.appendChild(h('span', 'gfx-cart-sum', `с байером ${gfxFmtRub.format(c.buyer)} ₽`));
    floatBtn.title = 'Открыть избранное';
  }

  function bump() {
    for (const el of [hdrBtn, floatBtn]) {
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
.ph { display: flex; align-items: center; gap: 10px; padding: 12px 14px 10px; border-bottom: 1px solid #f0f0f2; }
.ttl { flex: 1; font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
.ttl .star { color: #f5c400; font-size: 16px; }
.ttl .cnt { color: #86868b; font-weight: 500; font-size: 13px; }
.all { display: inline-flex; align-items: center; gap: 5px; color: #6e6e73; font-size: 12px; cursor: pointer; user-select: none; }
.x { width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: #86868b; font-size: 14px; cursor: pointer; }
.x:hover { background: #f2f2f4; color: #1d1d1f; }
input[type="checkbox"] { accent-color: #1d1d1f; width: 16px; height: 16px; margin: 0; cursor: pointer; }
.list { overflow-y: auto; overscroll-behavior: contain; padding: 4px 6px; min-height: 60px; }
.row { display: grid; grid-template-columns: 18px 56px minmax(0,1fr) auto; gap: 10px; align-items: start;
  padding: 10px 8px; border-radius: 10px; }
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
.btns { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: 10px; }
.btns button { height: 34px; border-radius: 9px; font: inherit; font-weight: 600; cursor: pointer; padding: 0 12px; }
.primary { border: 0; background: #1d1d1f; color: #fff; }
.primary:hover { background: #000; }
.ghost { border: 1px solid #e3e3e8; background: #fff; color: #1d1d1f; font-weight: 500 !important; }
.ghost:hover { background: #f6f6f8; }
.ghost.warn { border-color: #f3c2c2; color: #d70015; background: #fff5f5; }
.note { margin-top: 6px; font-size: 11px; color: #aeaeb2; text-align: center; }
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
    panelEl.setAttribute('aria-label', 'Избранное');
    root.appendChild(panelEl);
    (document.body || document.documentElement).appendChild(host);
    bindPanel();
  }

  function anchorEl() {
    if (hdrBtn && hdrBtn.isConnected && hdrVisible) return hdrBtn;
    if (floatBtn && floatBtn.isConnected) return floatBtn;
    return hdrBtn && hdrBtn.isConnected ? hdrBtn : null;
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

  function open() {
    if (!ready) return;
    ensureHost();
    isOpen = true;
    renderPanel();
    place();
    requestAnimationFrame(() => panelEl.classList.add('show'));
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

  function toggle() { isOpen ? close() : open(); }

  function openWhenReady(tries = 0) {
    if (ready && document.body) { ensureButtons(); open(); return; }
    if (tries < 50) setTimeout(() => openWhenReady(tries + 1), 100);
  }

  // закрытие: клик вне панели и Esc
  addEventListener('pointerdown', (e) => {
    if (!isOpen) return;
    const path = e.composedPath();
    if (path.includes(host) || path.includes(hdrBtn) || path.includes(floatBtn)) return;
    close();
  }, true);
  addEventListener('keydown', (e) => { if (isOpen && e.key === 'Escape') close(); }, true);

  // ---------------------------------------------------------------- render
  function renderPanel() {
    if (!panelEl) return;
    const scroll = panelEl.querySelector('.list') ? panelEl.querySelector('.list').scrollTop : 0;
    panelEl.textContent = '';
    panelEl.appendChild(h('div', 'caret'));

    const t = totals();
    const ph = h('div', 'ph');
    const ttl = h('div', 'ttl');
    ttl.appendChild(h('span', 'star', '★'));
    ttl.appendChild(document.createTextNode('Избранное'));
    ttl.appendChild(h('span', 'cnt', t.count ? String(t.count) : ''));
    ph.appendChild(ttl);
    if (t.count) {
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
    const items = sorted();
    if (!items.length) {
      const e = h('div', 'empty');
      e.appendChild(h('b', null, 'Пока пусто'));
      e.appendChild(document.createTextNode('Нажмите ☆ рядом с ценой товара — он появится здесь.'));
      list.appendChild(e);
    }
    for (const f of items) list.appendChild(renderRow(f));
    panelEl.appendChild(list);

    const pf = h('div', 'pf');
    pf.appendChild(sumRow('sr sCount', '', ''));
    pf.appendChild(sumRow('sr muted sMarket', 'По рыночному курсу', ''));
    const b = h('div', 'buyer');
    b.appendChild(h('span', 'k', 'С байером'));
    b.appendChild(h('span', 'big sBuyer'));
    b.appendChild(h('span', 'usd sBuyerUsd'));
    pf.appendChild(b);
    pf.appendChild(h('div', 'formula sFormula'));
    const btns = h('div', 'btns');
    btns.appendChild(h('button', 'primary copy', 'Скопировать список для байера'));
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

  function renderRow(f) {
    const url = f.url || `https://www.goofish.com/item?id=${f.id}`;
    const row = h('div', 'row');
    row.dataset.id = f.id;
    const sel = h('input', 'sel');
    sel.type = 'checkbox';
    sel.title = 'Учитывать в сумме';
    row.appendChild(sel);

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
    row.appendChild(th);

    const mid = h('div', 'mid');
    const a = h('a', 'title', f.title || f.titleZh || `Item ${f.id}`);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = f.titleZh && f.titleZh !== f.title ? `${f.title}\n${f.titleZh}` : (f.title || '');
    mid.appendChild(a);
    mid.appendChild(h('div', 'meta'));
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
    row.appendChild(mid);

    const right = h('div', 'right');
    right.appendChild(h('div', 'tb'));
    right.appendChild(h('div', 'tm'));
    const del = h('button', 'del', '✕');
    del.title = 'Удалить из избранного';
    right.appendChild(del);
    row.appendChild(right);

    renderRowTotals(row, f);
    return row;
  }

  function renderRowTotals(row, f) {
    const c = gfxCalc(priceOf(f) * qtyOf(f), S, market);
    row.querySelector('.tb').textContent = `${gfxFmtRub.format(c.buyer)} ₽`;
    row.querySelector('.tm').textContent = `≈${gfxFmtRub.format(c.rub)} ₽ · ${gfxFmtUsd(c.usd)}`;
    row.querySelector('.qn').textContent = qtyOf(f);
    row.querySelector('.sel').checked = f.sel !== false;
    row.classList.toggle('off', f.sel === false);
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

  function renderSummary() {
    if (!panelEl) return;
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
    set('.ttl .cnt', t.count ? String(t.count) : '');
    const sa = panelEl.querySelector('.selAll');
    if (sa) {
      const ids = Object.keys(favs);
      sa.checked = ids.length > 0 && ids.every((id) => favs[id].sel !== false);
      sa.indeterminate = !sa.checked && ids.some((id) => favs[id].sel !== false);
    }
    renderButtons();
  }

  // ---------------------------------------------------------------- events
  function bindPanel() {
    root.addEventListener('click', (e) => {
      const t = e.target;
      if (t.closest('.x')) { close(); return; }
      if (t.closest('.copy')) { copyList(t.closest('.copy')); return; }
      if (t.closest('.clear')) { clearAll(t.closest('.clear')); return; }
      const row = t.closest('.row');
      const f = row && favs[row.dataset.id];
      if (!f) return;
      if (t.closest('.plus')) f.qty = qtyOf(f) + 1;
      else if (t.closest('.minus')) f.qty = Math.max(1, qtyOf(f) - 1);
      else if (t.closest('.del')) {
        delete favs[f.id];
        save(true);
        renderPanel();
        renderButtons();
        return;
      } else return;
      renderRowTotals(row, f);
      renderSummary();
      save();
    });

    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.classList.contains('selAll')) {
        Object.values(favs).forEach((f) => { f.sel = t.checked; });
        panelEl.querySelectorAll('.row').forEach((row) => renderRowTotals(row, favs[row.dataset.id]));
        renderSummary();
        save();
        return;
      }
      if (t.classList.contains('sel')) {
        const row = t.closest('.row');
        const f = favs[row.dataset.id];
        if (!f) return;
        f.sel = t.checked;
        renderRowTotals(row, f);
        renderSummary();
        save();
      }
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
    favs = {};
    save(true);
    renderPanel();
    renderButtons();
  }

  async function copyList(btn) {
    const items = sorted().filter((f) => f.sel !== false);
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

  self.GFXPanel = { open: openWhenReady, close, toggle, bump };
})();
