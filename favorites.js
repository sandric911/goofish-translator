'use strict';
/* Страница «Избранное»: корзина сохранённых товаров с итогом по формуле байера */

const $ = (id) => document.getElementById(id);
let S = { ...GFX_DEFAULTS };
let market = { RUB: 12.18, USD: 0.1496, ts: 0 };
let favs = {};
let lastWritten = '';

// ----------------------------------------------------------------- storage
let saveTimer = 0;
function saveFavs(now) {
  clearTimeout(saveTimer);
  const run = () => {
    lastWritten = JSON.stringify(favs);
    chrome.storage.local.set({ favs });
  };
  if (now) run();
  else saveTimer = setTimeout(run, 250);
}

let settingsTimer = 0;
function saveSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...GFX_DEFAULTS, ...(settings || {}), buyerRate: S.buyerRate, buyerFee: S.buyerFee } });
  }, 250);
}

// ----------------------------------------------------------------- helpers
const qtyOf = (f) => Math.max(1, Math.round(+f.qty || 1));
const priceOf = (f) => Math.max(0, +f.price || 0);

function sortedItems() {
  const items = Object.values(favs);
  const mode = $('sort').value;
  const by = {
    new: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    old: (a, b) => (a.addedAt || 0) - (b.addedAt || 0),
    cheap: (a, b) => priceOf(a) - priceOf(b),
    exp: (a, b) => priceOf(b) - priceOf(a)
  }[mode];
  return items.sort(by);
}

function totals() {
  let cny = 0, pcs = 0, n = 0;
  for (const f of Object.values(favs)) {
    if (f.sel === false) continue;
    n++;
    pcs += qtyOf(f);
    cny += priceOf(f) * qtyOf(f);
  }
  return { cny, pcs, n };
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

// ----------------------------------------------------------------- render
function renderRowTotals(row, f) {
  const sum = priceOf(f) * qtyOf(f);
  const c = gfxCalc(sum, S, market);
  row.querySelector('.t-buyer').textContent = `${gfxFmtRub.format(c.buyer)} ₽`;
  row.querySelector('.t-market').textContent = `≈ ${gfxFmtRub.format(c.rub)} ₽ · ${gfxFmtUsd(c.usd)}`;
  row.querySelector('.qn').textContent = qtyOf(f);
  row.classList.toggle('off', f.sel === false);
  row.querySelector('.sel').checked = f.sel !== false;

  const meta = row.querySelector('.meta');
  meta.textContent = '';
  const parts = [];
  if (f.addedAt) parts.push(document.createTextNode('Добавлено ' + new Date(f.addedAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })));
  if (qtyOf(f) > 1) parts.push(document.createTextNode(`${qtyOf(f)} × ¥${gfxFmtCny.format(priceOf(f))}`));
  if (f.manual && f.listPrice != null && +f.listPrice !== priceOf(f)) {
    const s = document.createElement('span');
    s.className = 'manual';
    s.textContent = `ваша цена, на сайте ¥${gfxFmtCny.format(+f.listPrice)}`;
    parts.push(s);
  } else if (f.priceAtAdd != null && f.listPrice != null && +f.listPrice !== +f.priceAtAdd) {
    const s = document.createElement('span');
    const down = +f.listPrice < +f.priceAtAdd;
    s.className = 'changed ' + (down ? 'down' : 'up');
    s.textContent = `${down ? '↓' : '↑'} цена изменилась: было ¥${gfxFmtCny.format(+f.priceAtAdd)}`;
    parts.push(s);
  }
  parts.forEach((p, i) => { if (i) meta.appendChild(document.createTextNode(' · ')); meta.appendChild(p); });
}

function renderList() {
  const list = $('list');
  list.textContent = '';
  const items = sortedItems();
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.innerHTML = '<b>Пока пусто</b><br>Откройте Goofish и нажмите ☆ рядом с ценой товара — он появится здесь.';
    list.appendChild(e);
    return;
  }
  const tpl = $('rowTpl');
  for (const f of items) {
    const row = tpl.content.firstElementChild.cloneNode(true);
    row.dataset.id = f.id;
    const url = f.url || `https://www.goofish.com/item?id=${f.id}`;
    row.querySelector('.thumb').href = url;
    const img = row.querySelector('.thumb img');
    img.referrerPolicy = 'no-referrer';
    if (f.img) img.src = f.img; else img.remove();
    const a = row.querySelector('.title');
    a.href = url;
    a.textContent = f.title || f.titleZh || `Item ${f.id}`;
    a.title = f.title || '';
    const zh = row.querySelector('.zh');
    zh.textContent = f.titleZh && f.titleZh !== f.title ? f.titleZh : '';
    row.querySelector('.priceInput').value = priceOf(f);
    renderRowTotals(row, f);
    list.appendChild(row);
  }
}

function renderSummary() {
  const t = totals();
  const all = Object.keys(favs).length;
  const c = gfxCalc(t.cny, S, market);
  $('subtitle').textContent = all
    ? `${all} ${plural(all, 'товар', 'товара', 'товаров')} · с байером ${gfxFmtRub.format(c.buyer)} ₽`
    : 'нет сохранённых товаров';
  $('sumCount').textContent = `${t.n} из ${all}` + (t.pcs !== t.n ? ` (${t.pcs} шт.)` : '');
  $('sumCny').textContent = `¥${gfxFmtCny.format(t.cny)}`;
  $('sumMarket').textContent = `${gfxFmtRub.format(c.rub)} ₽ · ${gfxFmtUsd(c.usd)}`;
  $('sumBuyer').textContent = `${gfxFmtRub.format(c.buyer)} ₽`;
  $('sumBuyerUsd').textContent = `≈ ${gfxFmtUsd(c.buyerUsd)}`;
  $('sumFormula').textContent =
    `¥${gfxFmtCny.format(t.cny)} × ${S.buyerRate} = ${gfxFmtRub2.format(c.base)} ₽ + ${S.buyerFee}% (${gfxFmtRub2.format(c.fee)} ₽)`;
  const ids = Object.keys(favs);
  $('selAll').checked = ids.length > 0 && ids.every((id) => favs[id].sel !== false);
  $('selAll').indeterminate = !$('selAll').checked && ids.some((id) => favs[id].sel !== false);
  const R = gfxRates(S, market);
  const when = market.ts ? new Date(market.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  $('rateNote').textContent = `Рыночный курс: 1 ¥ = ${R.RUB.toFixed(2)} ₽ · $${R.USD.toFixed(4)}` +
    (S.rateMode === 'manual' ? ' (вручную)' : ` · обновлён ${when}`);
}

function renderAll() {
  renderList();
  renderSummary();
}

// ----------------------------------------------------------------- events
function rowOf(el) {
  const row = el.closest('.item');
  return row ? { row, f: favs[row.dataset.id] } : {};
}

$('list').addEventListener('click', (e) => {
  const { row, f } = rowOf(e.target);
  if (!f) return;
  if (e.target.closest('.plus')) {
    f.qty = qtyOf(f) + 1;
  } else if (e.target.closest('.minus')) {
    f.qty = Math.max(1, qtyOf(f) - 1);
  } else if (e.target.closest('.del')) {
    delete favs[f.id];
    saveFavs(true);
    renderAll();
    toast('Удалено');
    return;
  } else {
    return;
  }
  renderRowTotals(row, f);
  renderSummary();
  saveFavs();
});

$('list').addEventListener('change', (e) => {
  const { row, f } = rowOf(e.target);
  if (!f) return;
  if (e.target.classList.contains('sel')) {
    f.sel = e.target.checked;
    renderRowTotals(row, f);
    renderSummary();
    saveFavs();
  }
});

$('list').addEventListener('input', (e) => {
  if (!e.target.classList.contains('priceInput')) return;
  const { row, f } = rowOf(e.target);
  if (!f) return;
  const v = parseFloat(e.target.value);
  if (!isFinite(v) || v < 0) return;
  f.price = v;
  f.manual = f.listPrice == null || v !== +f.listPrice;
  renderRowTotals(row, f);
  renderSummary();
  saveFavs();
});

$('selAll').addEventListener('change', () => {
  const on = $('selAll').checked;
  Object.values(favs).forEach((f) => { f.sel = on; });
  saveFavs();
  renderAll();
});

$('sort').addEventListener('change', () => {
  localStorage.setItem('gfxSort', $('sort').value);
  renderList();
});

for (const id of ['buyerRate', 'buyerFee']) {
  $(id).addEventListener('input', () => {
    const v = parseFloat($(id).value);
    if (!isFinite(v) || v < 0) return;
    S[id] = v;
    document.querySelectorAll('.item').forEach((row) => { const f = favs[row.dataset.id]; if (f) renderRowTotals(row, f); });
    renderSummary();
    saveSettings();
  });
}

$('delSelected').addEventListener('click', () => {
  const ids = Object.keys(favs).filter((id) => favs[id].sel !== false);
  if (!ids.length) { toast('Ничего не выбрано'); return; }
  if (!confirm(`Удалить выбранные (${ids.length})?`)) return;
  ids.forEach((id) => delete favs[id]);
  saveFavs(true);
  renderAll();
});

$('clearAll').addEventListener('click', () => {
  const n = Object.keys(favs).length;
  if (!n) return;
  if (!confirm(`Удалить всё избранное (${n})?`)) return;
  favs = {};
  saveFavs(true);
  renderAll();
});

$('copyList').addEventListener('click', async () => {
  const items = sortedItems().filter((f) => f.sel !== false);
  if (!items.length) { toast('Ничего не выбрано'); return; }
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
  try {
    await navigator.clipboard.writeText(text);
    toast('Список скопирован');
  } catch (e) {
    toast('Не удалось скопировать');
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let dirty = false;
  if (changes.favs) {
    const nv = changes.favs.newValue || {};
    if (JSON.stringify(nv) !== lastWritten && JSON.stringify(nv) !== JSON.stringify(favs)) {
      favs = nv;
      dirty = true;
    }
  }
  if (changes.settings) {
    const ns = { ...GFX_DEFAULTS, ...(changes.settings.newValue || {}) };
    const active = document.activeElement && document.activeElement.id;
    if (active !== 'buyerRate') $('buyerRate').value = ns.buyerRate;
    if (active !== 'buyerFee') $('buyerFee').value = ns.buyerFee;
    S = ns;
    dirty = true;
  }
  if (changes.rates && changes.rates.newValue) { market = changes.rates.newValue; dirty = true; }
  if (dirty) { renderAll(); translateTitles(); }
});

// ------------------------------------------- допереводим китайские названия
const CJK_RE = /[\u3400-\u9fff]/;
let translating = false;
async function translateTitles() {
  if (translating) return;
  const todo = Object.values(favs).filter((f) => f.title && CJK_RE.test(f.title)).slice(0, 40);
  if (!todo.length) return;
  translating = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'tr', texts: todo.map((f) => f.title), sl: 'zh-CN', tl: S.lang || 'en' });
    if (r && r.ok && r.res) {
      todo.forEach((f, i) => {
        const tr = (r.res[i] || '').trim();
        if (tr && favs[f.id]) { favs[f.id].titleZh = favs[f.id].titleZh || f.title; favs[f.id].title = tr; }
      });
      saveFavs(true);
      renderList();
    }
  } catch (e) { /* без сети — оставим как есть */ }
  translating = false;
}

// ----------------------------------------------------------------- init
(async function init() {
  const d = await gfxLoad();
  S = d.S;
  market = d.market;
  favs = d.favs;
  lastWritten = JSON.stringify(favs);
  $('sort').value = localStorage.getItem('gfxSort') || 'new';
  $('buyerRate').value = S.buyerRate;
  $('buyerFee').value = S.buyerFee;
  renderAll();
  translateTitles();
})();
