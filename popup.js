'use strict';
/* Popup: калькулятор, настройки, итог корзины, избранное, поиск */

const $ = (id) => document.getElementById(id);
let S = { ...GFX_DEFAULTS };
let marketRates = { RUB: 12.18, USD: 0.1496, ts: 0 };
let favs = {};
let cart = {};

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function renderRates() {
  const R = gfxRates(S, marketRates);
  const when = marketRates.ts
    ? new Date(marketRates.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';
  $('rateLine').textContent = S.rateMode === 'manual'
    ? `1 ¥ = ${R.RUB} ₽ · $${R.USD} (вручную)`
    : `1 ¥ = ${R.RUB.toFixed(2)} ₽ · $${R.USD.toFixed(4)} · ${when}`;
}

function renderCalc() {
  const v = parseFloat($('calcCny').value);
  if (!isFinite(v) || v <= 0) {
    ['outRub', 'outUsd', 'outBuyer', 'outBuyerUsd'].forEach((id) => ($(id).textContent = '—'));
    $('outFormula').textContent = `цена × ${S.buyerRate} + ${S.buyerFee}%`;
    return;
  }
  const c = gfxCalc(v, S, marketRates);
  $('outRub').textContent = `${gfxFmtRub.format(c.rub)} ₽`;
  $('outUsd').textContent = gfxFmtUsd(c.usd);
  $('outBuyer').textContent = `${gfxFmtRub.format(c.buyer)} ₽`;
  $('outBuyerUsd').textContent = '≈ ' + gfxFmtUsd(c.buyerUsd);
  $('outFormula').textContent = `${gfxFmtRub2.format(v)} ¥ × ${S.buyerRate} = ${gfxFmtRub2.format(c.base)} ₽ + ${S.buyerFee}% (${gfxFmtRub2.format(c.fee)} ₽)`;
}

function renderFavs() {
  const nFav = Object.keys(favs).length;
  $('favCount').textContent = nFav
    ? `Избранное: ${nFav} ${plural(nFav, 'товар', 'товара', 'товаров')}`
    : 'Избранное пусто';

  const list = Object.values(cart);
  const sum = $('cartSum');
  sum.classList.remove('warn');
  if (!list.length) {
    $('cartCount').textContent = 'Корзина пуста';
    sum.textContent = 'нажмите 🛒 у цены на Goofish';
    return;
  }
  let cny = 0, n = 0;
  for (const f of list) {
    if (f.sel === false) continue;
    n++;
    cny += (+f.price || 0) * Math.max(1, +f.qty || 1);
  }
  const c = gfxCalc(cny, S, marketRates);
  const short = n ? gfxMinShort(cny, S) : 0;
  $('cartCount').textContent = `${list.length} ${plural(list.length, 'товар', 'товара', 'товаров')} в корзине`;
  if (short > 0) {
    sum.classList.add('warn');
    sum.textContent = `¥${gfxFmtCny.format(cny)} · до минимума ¥${gfxFmtCny.format(+S.minOrder)} не хватает ¥${gfxFmtCny.format(short)}`;
  } else {
    sum.textContent = `¥${gfxFmtCny.format(cny)} → с байером ${gfxFmtRub.format(c.buyer)} ₽`;
  }
}

function fillForm() {
  $('buyerRate').value = S.buyerRate;
  $('buyerFee').value = S.buyerFee;
  $('minOrder').value = S.minOrder;
  $('translate').checked = S.translate;
  $('lang').value = S.lang;
  $('blockPopups').checked = S.blockPopups;
  $('prices').checked = S.prices;
  $('showRub').checked = S.showRub;
  $('showUsd').checked = S.showUsd;
  $('showBuyer').checked = S.showBuyer;
  $('skipStrike').checked = S.skipStrike;
  $('manualMode').checked = S.rateMode === 'manual';
  $('manualRub').value = S.manualRub;
  $('manualUsd').value = S.manualUsd;
  $('manualBox').classList.toggle('off', S.rateMode !== 'manual');
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ settings: S }), 250);
  renderRates();
  renderCalc();
  renderFavs();
}

function num(id, fallback) {
  const v = parseFloat($(id).value);
  return isFinite(v) && v >= 0 ? v : fallback;
}

function bind() {
  $('calcCny').addEventListener('input', renderCalc);

  $('buyerRate').addEventListener('input', () => { S.buyerRate = num('buyerRate', GFX_DEFAULTS.buyerRate); save(); });
  $('buyerFee').addEventListener('input', () => { S.buyerFee = num('buyerFee', GFX_DEFAULTS.buyerFee); save(); });
  $('minOrder').addEventListener('input', () => { S.minOrder = num('minOrder', GFX_DEFAULTS.minOrder); save(); });
  $('manualRub').addEventListener('input', () => { S.manualRub = num('manualRub', GFX_DEFAULTS.manualRub); save(); });
  $('manualUsd').addEventListener('input', () => { S.manualUsd = num('manualUsd', GFX_DEFAULTS.manualUsd); save(); });

  for (const id of ['translate', 'blockPopups', 'prices', 'showRub', 'showUsd', 'showBuyer', 'skipStrike']) {
    $(id).addEventListener('change', () => { S[id] = $(id).checked; save(); });
  }
  $('lang').addEventListener('change', () => { S.lang = $('lang').value; save(); });
  $('manualMode').addEventListener('change', () => {
    S.rateMode = $('manualMode').checked ? 'manual' : 'auto';
    $('manualBox').classList.toggle('off', S.rateMode !== 'manual');
    save();
  });

  // корзина и избранное — всплывающая панель на самой странице Goofish
  const openPanel = async (mode) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const fallback = () => chrome.tabs.create({ url: 'https://www.goofish.com/#gfx-' + mode });
    if (!tab) { fallback(); window.close(); return; }
    chrome.tabs.sendMessage(tab.id, { type: 'openPanel', mode }, (r) => {
      if (chrome.runtime.lastError || !r || !r.ok) fallback();
      window.close();
    });
  };
  $('openCart').addEventListener('click', () => openPanel('cart'));
  $('openFavs').addEventListener('click', () => openPanel('favs'));

  $('refreshRates').addEventListener('click', async () => {
    $('refreshRates').classList.add('spin');
    const r = await chrome.runtime.sendMessage({ type: 'rates', force: true }).catch(() => null);
    $('refreshRates').classList.remove('spin');
    if (r && r.rates) { marketRates = r.rates; renderRates(); renderCalc(); renderFavs(); }
  });

  $('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('searchQ').value.trim();
    if (!q) return;
    $('searchHint').textContent = 'Перевожу…';
    let zh = q;
    const r = await chrome.runtime.sendMessage({ type: 'tr', texts: [q], sl: 'auto', tl: 'zh-CN' }).catch(() => null);
    if (r && r.ok && r.res && r.res[0]) zh = r.res[0];
    $('searchHint').textContent = `Ищу: ${zh}`;
    chrome.tabs.create({ url: 'https://www.goofish.com/search?q=' + encodeURIComponent(zh) });
  });

  $('toggleOriginal').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: 'toggleOriginal' }, () => void chrome.runtime.lastError);
    window.close();
  });

  $('clearCache').addEventListener('click', async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('t:'));
    await chrome.storage.local.remove(keys);
    $('cacheCount').textContent = '(0)';
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.favs) { favs = changes.favs.newValue || {}; renderFavs(); }
    if (changes.cart) { cart = changes.cart.newValue || {}; renderFavs(); }
  });
}

(async function init() {
  const all = await chrome.storage.local.get(null);
  S = { ...GFX_DEFAULTS, ...(all.settings || {}) };
  if (all.rates) marketRates = all.rates;
  favs = all.favs || {};
  cart = all.cart || {};
  $('cacheCount').textContent = `(${Object.keys(all).filter((k) => k.startsWith('t:')).length})`;
  fillForm();
  bind();
  renderRates();
  renderCalc();
  renderFavs();
  if (!all.rates || Date.now() - (all.rates.ts || 0) > 6 * 3600 * 1000) {
    const r = await chrome.runtime.sendMessage({ type: 'rates' }).catch(() => null);
    if (r && r.rates) { marketRates = r.rates; renderRates(); renderCalc(); renderFavs(); }
  }
})();
