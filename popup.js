'use strict';
/* Popup: калькулятор, настройки, итог избранного, поиск */

const $ = (id) => document.getElementById(id);
let S = { ...GFX_DEFAULTS };
let marketRates = { RUB: 12.18, USD: 0.1496, ts: 0 };
let favs = {};

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
  const list = Object.values(favs);
  if (!list.length) {
    $('favCount').textContent = 'Избранное пусто';
    $('favSum').textContent = 'нажмите ☆ у цены на Goofish';
    return;
  }
  let cny = 0;
  for (const f of list) if (f.sel !== false) cny += (+f.price || 0) * Math.max(1, +f.qty || 1);
  const c = gfxCalc(cny, S, marketRates);
  $('favCount').textContent = `${list.length} ${plural(list.length, 'товар', 'товара', 'товаров')} в избранном`;
  $('favSum').textContent = `¥${gfxFmtCny.format(cny)} → с байером ${gfxFmtRub.format(c.buyer)} ₽`;
}

function fillForm() {
  $('buyerRate').value = S.buyerRate;
  $('buyerFee').value = S.buyerFee;
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

  // избранное — всплывающая панель на самой странице Goofish
  $('openFavs').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const fallback = () => chrome.tabs.create({ url: 'https://www.goofish.com/#gfx-favs' });
    if (!tab) { fallback(); window.close(); return; }
    chrome.tabs.sendMessage(tab.id, { type: 'openFavPanel' }, (r) => {
      if (chrome.runtime.lastError || !r || !r.ok) fallback();
      window.close();
    });
  });

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
  });
}

(async function init() {
  const all = await chrome.storage.local.get(null);
  S = { ...GFX_DEFAULTS, ...(all.settings || {}) };
  if (all.rates) marketRates = all.rates;
  favs = all.favs || {};
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
