'use strict';
/* Общие функции для popup и страницы избранного */

const GFX_DEFAULTS = {
  translate: true, lang: 'en', prices: true, showRub: true, showUsd: true, showBuyer: true,
  buyerRate: 13.5, buyerFee: 10, skipStrike: true, rateMode: 'auto', manualRub: 12.2, manualUsd: 0.1496,
  blockPopups: true,
  uiScale: 'auto',  // размер интерфейса: 'auto' — по экрану, либо число (1, 1.2, 1.4, …)
  autoCheck: true   // изредка проверять в фоне, не проданы ли товары из избранного и корзины
};

const gfxFmtRub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const gfxFmtRub2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const gfxFmtCny = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const gfxFmtUsd = (v) => '$' + (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));

/** Масштаб интерфейса. В режиме «авто» ориентируемся на высоту экрана: это надёжный признак
 *  плотности пикселей и для обычных мониторов, и для сверхшироких (3440×1440 — те же точки, что 2560×1440). */
function gfxScale(S) {
  const v = parseFloat(S && S.uiScale);
  if (v > 0) return Math.min(2.5, Math.max(0.8, v));
  const h = screen.height;
  if (h >= 2000) return 1.8;   // 4K без масштабирования
  if (h >= 1300) return 1.4;   // 1440p: 2560×1440, 3440×1440
  if (h >= 1050) return 1.2;   // 1080p / 1200p
  return 1;
}

function gfxRates(S, market) {
  if (S.rateMode === 'manual') return { RUB: +S.manualRub || market.RUB, USD: +S.manualUsd || market.USD };
  return market;
}

/** Цена в ¥ → рыночные ₽/$ и итог с байером: цена × курс байера + комиссия % */
function gfxCalc(cny, S, market) {
  const R = gfxRates(S, market);
  const base = cny * (+S.buyerRate || 0);
  const fee = base * ((+S.buyerFee || 0) / 100);
  const buyer = base + fee;
  return {
    rub: cny * R.RUB,
    usd: cny * R.USD,
    base, fee, buyer,
    buyerUsd: R.RUB ? buyer * (R.USD / R.RUB) : 0,
    R
  };
}

async function gfxLoad() {
  const all = await chrome.storage.local.get(['settings', 'rates', 'favs']);
  return {
    S: { ...GFX_DEFAULTS, ...(all.settings || {}) },
    market: all.rates || { RUB: 12.18, USD: 0.1496, ts: 0 },
    favs: all.favs || {}
  };
}
