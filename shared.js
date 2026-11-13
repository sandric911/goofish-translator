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

/* ===================== Запросы к API Goofish (mtop) =====================
 * Подпись как у самой страницы: md5(токен из cookie _m_h5_tk & время & appKey & данные).
 * Нужны cookie сайта, поэтому вызывать только со страниц goofish.com (content script). */
const GFX_APP_KEY = '34839810';

function gfxMd5(str) {
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

async function gfxMtop(api, data, extra = {}) {
  const tk = (document.cookie.match(/(?:^|;\s*)_m_h5_tk=([^;_]*)_/) || [])[1] || '';
  const body = JSON.stringify(data || {});
  const t = String(Date.now());
  const q = new URLSearchParams({
    jsv: '2.7.2', appKey: GFX_APP_KEY, t, sign: gfxMd5(`${tk}&${t}&${GFX_APP_KEY}&${body}`), v: '1.0',
    type: 'originaljson', accountSite: 'xianyu', dataType: 'json', timeout: '20000',
    ...extra, api, sessionOption: 'AutoLoginOnly'
  });
  const res = await fetch(`https://h5api.m.goofish.com/h5/${api}/1.0/?${q}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(body)
  });
  return res.json();
}
