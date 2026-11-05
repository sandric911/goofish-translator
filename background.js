'use strict';

// ---------------------------------------------------------------------------
// Goofish EN — background service worker
// Делает сетевые запросы (перевод, курсы валют), чтобы не упираться в CSP/CORS сайта.
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  translate: true,      // переводить страницу
  lang: 'en',           // язык перевода: en | ru
  prices: true,         // показывать пересчёт цен
  showRub: true,        // ₽ по рыночному курсу
  showUsd: true,        // $ по рыночному курсу
  showBuyer: true,      // итог с байером
  buyerRate: 13.5,      // курс байера, ₽ за 1 ¥
  buyerFee: 10,         // комиссия байера, %
  skipStrike: true,     // не считать зачёркнутые «старые» цены
  rateMode: 'auto',     // auto | manual
  manualRub: 12.2,      // ручной курс ₽ за 1 ¥
  manualUsd: 0.1496,    // ручной курс $ за 1 ¥
  blockPopups: true     // скрывать окна входа/регистрации и всплывашки
};

const FALLBACK_RATES = { RUB: 12.18, USD: 0.1496, ts: 0, src: 'встроенный' };
const RATES_TTL = 6 * 60 * 60 * 1000;      // 6 часов
const CACHE_LIMIT = 30000;                  // максимум переводов в кэше

const TR_ENDPOINTS = [
  'https://translate.googleapis.com/translate_a/t?client=gtx',
  'https://clients5.google.com/translate_a/t?client=dict-chrome-ex'
];

// ----------------------------- перевод -------------------------------------

function normalizeResult(json, n) {
  if (typeof json === 'string') return [json];
  if (!Array.isArray(json)) return null;
  // sl=auto → [[tr, lang], ...]; фиксированный sl → ["tr", ...]
  if (n === 1 && json.length === 2 && typeof json[0] === 'string' && typeof json[1] === 'string' && /^[a-z]{2}(-[A-Za-z]+)?$/.test(json[1])) {
    return [json[0]];
  }
  return json.map((x) => (Array.isArray(x) ? x[0] : x));
}

async function translateBatch(texts, sl, tl) {
  const body = texts.map((t) => 'q=' + encodeURIComponent(t)).join('&');
  let lastErr;
  for (const base of TR_ENDPOINTS) {
    try {
      const r = await fetch(`${base}&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const out = normalizeResult(await r.json(), texts.length);
      if (out && out.length === texts.length) return out;
      throw new Error('bad response');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('translate failed');
}

// ----------------------------- курсы ---------------------------------------

async function fetchRates() {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/CNY');
    const j = await r.json();
    if (j && j.result === 'success' && j.rates && j.rates.RUB && j.rates.USD) {
      return { RUB: j.rates.RUB, USD: j.rates.USD, ts: Date.now(), src: 'open.er-api.com' };
    }
  } catch (e) { /* пробуем запасной источник */ }
  try {
    const r = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json');
    const j = await r.json();
    if (j && j.cny && j.cny.rub && j.cny.usd) {
      return { RUB: j.cny.rub, USD: j.cny.usd, ts: Date.now(), src: 'currency-api' };
    }
  } catch (e) { /* ignore */ }
  return null;
}

let ratesPromise = null;
async function getRates(force) {
  const { rates } = await chrome.storage.local.get('rates');
  if (!force && rates && Date.now() - rates.ts < RATES_TTL) return rates;
  if (!ratesPromise) {
    ratesPromise = fetchRates().finally(() => { ratesPromise = null; });
  }
  const fresh = await ratesPromise;
  if (fresh) {
    await chrome.storage.local.set({ rates: fresh });
    return fresh;
  }
  return rates || FALLBACK_RATES;
}

// ----------------------------- обслуживание кэша ---------------------------

async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('t:'));
  if (keys.length > CACHE_LIMIT) {
    // простая стратегия: удаляем старую половину (порядок вставки сохраняется)
    await chrome.storage.local.remove(keys.slice(0, Math.floor(keys.length / 2)));
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } });
  getRates(false).catch(() => {});
  pruneCache().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  pruneCache().catch(() => {});
});

// ----------------------------- сообщения -----------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'tr') {
    translateBatch(msg.texts, msg.sl || 'zh-CN', msg.tl || 'en')
      .then((res) => sendResponse({ ok: true, res }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'rates') {
    getRates(!!msg.force)
      .then((rates) => sendResponse({ ok: true, rates }))
      .catch((e) => sendResponse({ ok: false, error: String(e), rates: FALLBACK_RATES }));
    return true;
  }

  if (msg.type === 'defaults') {
    sendResponse({ ok: true, settings: DEFAULT_SETTINGS });
    return false;
  }

  return false;
});
