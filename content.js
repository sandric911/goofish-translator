/* Goofish EN — content script
 * 1) Перевод всего текста страницы (текстовые узлы + placeholder/title/alt/aria-label).
 *    Скорость: встроенный словарь → правила → кэш в памяти (предзагружен из storage) — всё синхронно,
 *    прямо в MutationObserver до отрисовки кадра. Остальное — пакетами в Google Translate.
 * 2) Цены ¥ → ₽ / $ и итог с байером: цена × курс байера + комиссия %.
 */
(() => {
  'use strict';
  if (window.__gfxLoaded) return;
  window.__gfxLoaded = true;

  // ------------------------------------------------------------------ const
  const CJK = /[㐀-鿿豈-﫿]/;
  const YUAN = /[¥￥]/;
  const ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'TEMPLATE', 'IFRAME', 'CANVAS', 'svg', 'SVG']);
  const DICT = self.GFX_DICT || {};
  const UI_CLASS = 'gfx-ui';
  const IS_TOP = window.top === window;

  const DEFAULTS = {
    translate: true, lang: 'en', prices: true, showRub: true, showUsd: true, showBuyer: true,
    buyerRate: 13.5, buyerFee: 10, skipStrike: true, rateMode: 'auto', manualRub: 12.2, manualUsd: 0.1496,
    blockPopups: true, uiScale: 'auto', autoCheck: true
  };

  // ------------------------------------------------------------------ state
  let S = { ...DEFAULTS };
  let marketRates = { RUB: 12.18, USD: 0.1496, ts: 0 };
  let ready = false;
  let showOriginal = false;

  const mem = new Map();          // key -> перевод (для текущего языка)
  const textRec = new WeakMap();  // Text -> { orig, tr }
  const attrRec = new WeakMap();  // Element -> { [attr]: { orig, tr } }
  const tracked = new Set();      // узлы/элементы, которые мы меняли (для «показать оригинал»)
  const pending = new Map();      // key -> Set<target>
  const inflight = new Map();     // key -> Set<target>
  const failures = new Map();     // key -> число неудач
  let netTimer = 0;

  // ================================================================ helpers
  const cacheKey = (k) => 't:' + S.lang + ':' + k;

  function rates() {
    if (S.rateMode === 'manual') return { RUB: +S.manualRub || marketRates.RUB, USD: +S.manualUsd || marketRates.USD };
    return marketRates;
  }

  function isOurs(el) {
    return el && el.closest && el.closest('.' + UI_CLASS);
  }

  function capFirst(src, s) {
    if (!s) return s;
    if (!CJK.test(src.charAt(0))) return s;
    if (/^(i[A-Z]|iphone|ipad|imac|ipod|iqoo|vivo|realme|oppo|ebay)/i.test(s)) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ------------------------------------------- быстрые правила (без сети)
  const RULES = {
    en: [
      [/^(\d+)人想要$/, (m) => `${m[1]} want it`],
      [/^(\d+)人浏览$/, (m) => `${m[1]} views`],
      [/^(\d+)次浏览$/, (m) => `${m[1]} views`],
      [/^购入价([\d.]+)折$/, (m) => `${fmtPct(m[1])}% of purchase price`],
      [/^([\d.]+)折$/, (m) => `${fmtPct(m[1])}% of price`],
      [/^累计降价(\d+)%$/, (m) => `Price cut ${m[1]}% in total`],
      [/^降价(\d+)%$/, (m) => `Price cut ${m[1]}%`],
      [/^刚刚$/, () => 'just now'],
      [/^(\d+)分钟前$/, (m) => `${m[1]} min ago`],
      [/^(\d+)小时前$/, (m) => `${m[1]} h ago`],
      [/^(\d+)天前$/, (m) => `${m[1]} days ago`],
      [/^刚刚来过$/, () => 'Active just now'],
      [/^(\d+)分钟前来过$/, (m) => `Active ${m[1]} min ago`],
      [/^(\d+)小时前来过$/, (m) => `Active ${m[1]} h ago`],
      [/^(\d+)天前来过$/, (m) => `Active ${m[1]} days ago`],
      [/^来闲鱼(\d+)年$/, (m) => `${m[1]} yrs on Goofish`],
      [/^来闲鱼(\d+)个月$/, (m) => `${m[1]} mo on Goofish`],
      [/^来闲鱼(\d+)天$/, (m) => `${m[1]} days on Goofish`],
      [/^(\d+)天内$/, (m) => `Within ${m[1]} days`],
      [/^(\d+)成新$/, (m) => `${m[1]}0% new`],
      [/^(\d{2})新$/, (m) => `${m[1]}% new`],
      [/^卖出(\d+)件$/, (m) => `${m[1]} sold`],
      [/^(\d+)条留言$/, (m) => `${m[1]} comments`],
      [/^万$/, () => '×10k']
    ],
    ru: [
      [/^(\d+)人想要$/, (m) => `хотят: ${m[1]}`],
      [/^(\d+)人浏览$/, (m) => `просмотров: ${m[1]}`],
      [/^(\d+)次浏览$/, (m) => `просмотров: ${m[1]}`],
      [/^购入价([\d.]+)折$/, (m) => `${fmtPct(m[1])}% от цены покупки`],
      [/^([\d.]+)折$/, (m) => `${fmtPct(m[1])}% от цены`],
      [/^累计降价(\d+)%$/, (m) => `Скидка всего ${m[1]}%`],
      [/^刚刚$/, () => 'только что'],
      [/^(\d+)分钟前$/, (m) => `${m[1]} мин назад`],
      [/^(\d+)小时前$/, (m) => `${m[1]} ч назад`],
      [/^(\d+)天前$/, (m) => `${m[1]} дн назад`],
      [/^(\d+)天前来过$/, (m) => `Был(а) ${m[1]} дн назад`],
      [/^来闲鱼(\d+)年$/, (m) => `${m[1]} лет на Goofish`],
      [/^(\d+)天内$/, (m) => `За ${m[1]} дн`],
      [/^(\d+)成新$/, (m) => `Состояние ${m[1]}0%`],
      [/^(\d{2})新$/, (m) => `Состояние ${m[1]}%`],
      [/^万$/, () => '×10 тыс']
    ]
  };

  function fmtPct(x) {
    const n = parseFloat(x);
    if (!isFinite(n)) return x;
    return String(Math.round(n * 10 * 10) / 10);
  }

  // Подготовка текста перед отправкой в переводчик (жаргон Xianyu)
  function preprocess(s) {
    return s
      .replace(/(\d+(?:\.\d+)?)万/g, (_, n) => String(Math.round(parseFloat(n) * 10000)))
      .replace(/(\d)成新/g, (_, n) => `${n}0%新`)
      .replace(/(^|[^\d.])(9\d|8\d)新/g, (_, p, n) => `${p}${n}%新`)
      .replace(/小刀/g, '小砍价');
  }

  function lookup(key) {
    if (S.lang === 'en') {
      const d = DICT[key];
      if (d !== undefined) return d;
    }
    const rules = RULES[S.lang] || RULES.en;
    for (const [re, fn] of rules) {
      const m = key.match(re);
      if (m) return fn(m);
    }
    return mem.get(key);
  }

  // ============================================================ translation
  function canTranslate() {
    return ready && S.translate && !showOriginal;
  }

  // Соседний текст (в китайском нет пробелов): «1» + «人想要» → «1 want it», а не «1want it»
  function edgeChar(node, dir) {
    let n = node;
    for (let i = 0; i < 3 && n; i++) {
      const sib = dir < 0 ? n.previousSibling : n.nextSibling;
      if (sib) {
        if (sib.nodeType === 1 && sib.classList && sib.classList.contains(UI_CLASS)) return '';
        const t = sib.textContent || '';
        return dir < 0 ? t.charAt(t.length - 1) : t.charAt(0);
      }
      n = n.parentNode;
      if (!n || n.nodeType !== 1 || /^(DIV|P|LI|TD|TH|SECTION|ARTICLE|BODY|TITLE|BUTTON|H\d)$/.test(n.tagName)) return '';
    }
    return '';
  }
  const WORDISH = /[A-Za-z0-9%)\]】]/;

  function applyText(node, orig, tr) {
    let lead = orig.match(/^\s*/)[0];
    let trail = orig.match(/\s*$/)[0];
    if (!lead && /^[A-Za-z0-9(]/.test(tr) && WORDISH.test(edgeChar(node, -1))) lead = ' ';
    if (!trail && /[A-Za-z0-9.,:)]$/.test(tr) && /[A-Za-z0-9(¥￥]/.test(edgeChar(node, 1))) trail = ' ';
    const full = lead + tr + trail;
    textRec.set(node, { orig, tr: full });
    tracked.add(node);
    if (node.nodeValue !== full) node.nodeValue = full;
  }

  function applyAttr(el, name, orig, tr) {
    let rec = attrRec.get(el);
    if (!rec) attrRec.set(el, (rec = {}));
    rec[name] = { orig, tr };
    tracked.add(el);
    if (el.getAttribute(name) !== tr) el.setAttribute(name, tr);
  }

  function applyGroup(g, tr) {
    // «П р о б е л ь н ы е» подписи: каждый иероглиф в своём div (品 牌 → Brand)
    g.nodes.forEach((n, i) => {
      const val = i === 0 ? tr : '';
      textRec.set(n, { orig: g.origs[i], tr: val });
      tracked.add(n);
      if (n.nodeValue !== val) n.nodeValue = val;
    });
    if (g.el && g.el.setAttribute) g.el.setAttribute('data-gfx-label', '');
  }

  function applyTarget(t, tr) {
    if (!canTranslate()) return;
    if (t.t === 'text') {
      if (t.node.nodeValue === t.orig) applyText(t.node, t.orig, tr);
    } else if (t.t === 'attr') {
      if (t.el.getAttribute(t.name) === t.orig) applyAttr(t.el, t.name, t.orig, tr);
    } else if (t.t === 'group') {
      if (t.nodes.every((n, i) => n.nodeValue === t.origs[i])) applyGroup(t, tr);
    }
  }

  // Пока строка переводится по сети — её элемент слегка приглушён (видно, что идёт перевод)
  const fadeCount = new WeakMap();
  function fadeHost(t) {
    return t.t === 'text' ? t.node.parentElement : t.t === 'group' ? t.el : null;
  }
  function fadeOn(t) {
    const h = fadeHost(t);
    if (!h || t.faded) return;
    t.faded = true;
    fadeCount.set(h, (fadeCount.get(h) || 0) + 1);
    h.setAttribute('data-gfx-pending', '');
  }
  function fadeOff(t) {
    const h = fadeHost(t);
    if (!h || !t.faded) return;
    t.faded = false;
    const c = (fadeCount.get(h) || 1) - 1;
    fadeCount.set(h, c);
    if (c <= 0) h.removeAttribute('data-gfx-pending');
  }

  function request(key, target) {
    const tr = lookup(key);
    if (tr !== undefined) { fadeOff(target); applyTarget(target, tr); return; }
    fadeOn(target);
    if (inflight.has(key)) { inflight.get(key).add(target); return; }
    let set = pending.get(key);
    if (!set) pending.set(key, (set = new Set()));
    set.add(target);
    if (!netTimer) netTimer = setTimeout(flushNet, 8);
  }

  function handleText(node, checked) {
    const v = node.nodeValue;
    if (!v || !CJK.test(v)) return;
    const rec = textRec.get(node);
    if (rec && rec.tr === v) return;
    const p = node.parentElement;
    if (!p) return;
    if (!checked) {
      if (SKIP_TAGS.has(p.tagName) || isOurs(p) || p.closest('textarea,code,script,style,noscript')) return;
    }
    if (p.isContentEditable) return;
    const key = v.trim();
    if (key.length === 1 && tryGroup(node)) return;
    request(key, { t: 'text', node, orig: v });
  }

  function handleAttrs(el) {
    if (!el.hasAttributes()) return;
    for (const name of ATTRS) {
      const v = el.getAttribute(name);
      if (!v || !CJK.test(v)) continue;
      const rec = attrRec.get(el);
      if (rec && rec[name] && rec[name].tr === v) continue;
      request(v.trim(), { t: 'attr', el, name, orig: v });
    }
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) {
      const v = el.getAttribute('value');
      if (v && CJK.test(v)) {
        const rec = attrRec.get(el);
        if (!(rec && rec.value && rec.value.tr === v)) request(v.trim(), { t: 'attr', el, name: 'value', orig: v });
      }
    }
  }

  // Подписи вида <div class="label"><div>品</div><div>牌</div></div>
  function tryGroup(node) {
    let el = node.parentElement;
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
      const txt = el.textContent.replace(/\s+/g, '');
      if (txt.length < 2) continue;
      if (txt.length > 6 || !/^[㐀-鿿]+$/.test(txt)) return false;
      if (el.querySelector('a,button,input')) return false;
      const nodes = [];
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) if (n.nodeValue.trim()) nodes.push(n);
      if (nodes.length < 2 || !nodes.every((x) => x.nodeValue.trim().length === 1)) return false;
      const cls = typeof el.className === 'string' ? el.className : '';
      let spaced = /label|title|key|name/i.test(cls);
      if (!spaced) {
        const cs = getComputedStyle(el);
        spaced = /space-(between|around|evenly)/.test(cs.justifyContent) || cs.textAlignLast === 'justify';
      }
      if (!spaced) return false;
      const g = { t: 'group', el, nodes, origs: nodes.map((x) => x.nodeValue) };
      request(txt, g);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------- network
  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(resp);
        });
      } catch (e) {
        resolve(null); // контекст расширения перезагружен
      }
    });
  }

  function flushNet() {
    netTimer = 0;
    if (!pending.size) return;
    const keys = [...pending.keys()];
    for (const k of keys) { inflight.set(k, pending.get(k)); pending.delete(k); }

    // мелкие пачки параллельно (HTTP/2) — Google отвечает быстрее на короткие запросы,
    // первые строки (верх страницы) появляются через ~300 мс
    const chunks = [];
    let cur = [], len = 0;
    for (const k of keys) {
      if (cur.length && (cur.length >= 8 || len + k.length > 400)) { chunks.push(cur); cur = []; len = 0; }
      cur.push(k); len += k.length;
    }
    if (cur.length) chunks.push(cur);
    chunks.forEach(sendChunk);
  }

  async function sendChunk(keys) {
    const lang = S.lang;
    const resp = await sendMessage({ type: 'tr', texts: keys.map(preprocess), sl: 'zh-CN', tl: lang });
    const store = {};
    keys.forEach((k, i) => {
      const targets = inflight.get(k);
      inflight.delete(k);
      const raw = resp && resp.ok && resp.res ? resp.res[i] : null;
      if (raw == null || lang !== S.lang) {
        const f = (failures.get(k) || 0) + 1;
        failures.set(k, f);
        if (!targets) return;
        if (f <= 3) setTimeout(() => targets.forEach((t) => request(k, t)), 800 * f);
        else targets.forEach(fadeOff);
        return;
      }
      const tr = capFirst(k, String(raw).trim());
      mem.set(k, tr);
      store[cacheKey(k)] = tr;
      if (targets) targets.forEach((t) => { fadeOff(t); applyTarget(t, tr); });
    });
    if (Object.keys(store).length) {
      try { chrome.storage.local.set(store); } catch (e) { /* ignore */ }
    }
  }

  // ================================================================ prices
  const badges = new Set();          // все наши бейджи
  const anchorBadge = new WeakMap(); // anchor -> badge
  const priceDirty = new Set();      // текстовые узлы с ¥, которые надо (пере)проверить

  const fmtRub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const fmtRub2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  const fmtCny = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  function fmtUsd(v) {
    return '$' + (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
  }

  function notePrice(n) {
    const v = n.nodeValue;
    if (!v) return;
    if (YUAN.test(v)) { priceDirty.add(n); return; }
    if (/^\s*[\d.,]+\s*(万)?\s*$/.test(v)) {
      // поменялась цифра цены → ищем знак ¥ рядом
      let host = n.parentElement;
      for (let i = 0; i < 2 && host; i++) host = host.parentElement;
      if (host && host.textContent.length < 60 && YUAN.test(host.textContent)) {
        const tw = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        let t;
        while ((t = tw.nextNode())) if (YUAN.test(t.nodeValue)) priceDirty.add(t);
      }
    }
  }

  function textFrom(node, offset, root) {
    try {
      const r = document.createRange();
      r.setStart(node, offset);
      r.setEnd(root, root.childNodes.length);
      return r.toString();
    } catch (e) {
      return '';
    }
  }

  function isStruck(el) {
    for (let i = 0; i < 3 && el; i++, el = el.parentElement) {
      if (el.nodeType !== 1) break;
      const d = getComputedStyle(el).textDecorationLine || getComputedStyle(el).textDecoration || '';
      if (d.includes('line-through')) return true;
      if (el.tagName === 'DEL' || el.tagName === 'S') return true;
    }
    return false;
  }

  function detectPrice(tn) {
    if (!tn.isConnected) return null;
    const el = tn.parentElement;
    if (!el || isOurs(el) || el.closest('input,textarea,[contenteditable="true"],button,select,option')) return null;
    const v = tn.nodeValue;
    const idx = v.search(YUAN);
    if (idx < 0) return null;
    const before = v.slice(0, idx);

    // текст от знака ¥ до конца ближайшего контейнера, где есть цифры
    let box = el, m = null, str = '';
    for (let i = 0; i < 3 && box; i++, box = box.parentElement) {
      str = textFrom(tn, idx, box);
      m = str.match(/^[¥￥]\s*([\d,]+(?:\.\d+)?)\s*(万|×10k|×10 тыс)?/);
      if (m) break;
      if (str.replace(/\s/g, '').length > 1) break; // после ¥ идёт что-то нечисловое
    }
    if (!m) return null;
    let amount = parseFloat(m[1].replace(/,/g, ''));
    if (m[2]) amount *= 10000;
    if (!isFinite(amount) || amount <= 0 || amount > 1e8) return null;

    // якорь: минимальный предок, содержащий всю цену «¥123.45»
    const needle = m[0].replace(/\s/g, '');
    let anchor = el;
    for (let i = 0; i < 4 && anchor; i++) {
      if (anchor.textContent.replace(/\s/g, '').includes(needle)) break;
      anchor = anchor.parentElement;
    }
    if (!anchor || anchor === document.body || anchor === document.documentElement) return null;

    const struck = /原价|orig|первонач|исходн/i.test(before) || isStruck(el);
    return { anchor, amount, struck, el };
  }

  function priceBig(el) {
    // крупная цена → подробная карточка (страница товара)
    let max = 0;
    const tw = document.createTreeWalker(el.parentElement || el, NodeFilter.SHOW_TEXT);
    let n, k = 0;
    while ((n = tw.nextNode()) && k++ < 8) {
      if (/\d/.test(n.nodeValue) && n.parentElement) {
        max = Math.max(max, parseFloat(getComputedStyle(n.parentElement).fontSize) || 0);
      }
    }
    return max >= 22;
  }

  function calc(amount) {
    const R = rates();
    const rub = amount * R.RUB;
    const usd = amount * R.USD;
    const base = amount * (+S.buyerRate || 0);
    const fee = base * ((+S.buyerFee || 0) / 100);
    const buyer = base + fee;
    const buyerUsd = R.RUB ? buyer * (R.USD / R.RUB) : 0;
    return { rub, usd, base, fee, buyer, buyerUsd, R };
  }

  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function buildBadge(amount, big, anchor) {
    const c = calc(amount);
    const tip =
      `¥${fmtCny.format(amount)}\n` +
      `По курсу: ${fmtRub.format(c.rub)} ₽ · ${fmtUsd(c.usd)}  (1 ¥ = ${c.R.RUB.toFixed(2)} ₽ / $${c.R.USD.toFixed(4)})\n` +
      `С байером: ¥${fmtCny.format(amount)} × ${S.buyerRate} = ${fmtRub2.format(c.base)} ₽ + ${S.buyerFee}% (${fmtRub2.format(c.fee)} ₽) = ${fmtRub.format(c.buyer)} ₽ ≈ ${fmtUsd(c.buyerUsd)}`;

    if (!big) {
      const b = mk('span', UI_CLASS + ' gfx-badge');
      b.title = tip;
      if (S.showRub) b.appendChild(mk('span', 'gfx-pill', `≈${fmtRub.format(c.rub)} ₽`));
      if (S.showUsd) b.appendChild(mk('span', 'gfx-pill', fmtUsd(c.usd)));
      if (S.showBuyer) {
        const p = mk('span', 'gfx-pill gfx-pill--buyer');
        p.appendChild(mk('span', 'gfx-pill-label', 'байер'));
        p.appendChild(document.createTextNode(` ${fmtRub.format(c.buyer)} ₽`));
        b.appendChild(p);
      }
      const card = anchor && cardOf(anchor);
      const id = card && itemIdFromHref(card.getAttribute('href'));
      if (id) {
        b.appendChild(makeCtl('fav', id, anchor, amount, false));
        b.appendChild(makeCtl('cart', id, anchor, amount, false));
      }
      return b;
    }

    const box = mk('div', UI_CLASS + ' gfx-card');
    box.title = tip;
    let main = '';
    if (S.showBuyer) main = `${fmtRub.format(c.buyer)} ₽`;
    else if (S.showRub) main = `≈${fmtRub.format(c.rub)} ₽`;
    else if (S.showUsd) main = fmtUsd(c.usd);
    if (main) box.appendChild(mk('div', 'gfx-v gfx-v--big', main));
    const pid = pageItemId();
    if (pid) {
      const acts = mk('div', 'gfx-acts');
      acts.appendChild(makeCtl('fav', pid, anchor, amount, true));
      acts.appendChild(makeCtl('cart', pid, anchor, amount, true));
      box.appendChild(acts);
      syncFavPrice(pid, amount);
      syncFavMeta(pid);
      syncFavStatus(pid);
    }
    return box;
  }

  function placeBadge(info) {
    const { anchor, amount } = info;
    const sig = amount + '|' + settingsSig;
    let badge = anchorBadge.get(anchor);
    if (badge && badge.isConnected && anchor.nextSibling === badge && badge.__sig === sig) return;
    if (badge) { badge.remove(); badges.delete(badge); }

    // подробная карточка — только для главной цены товара (крупный шрифт и не внутри карточки-ссылки)
    const big = !anchor.closest('a') && priceBig(info.el);
    badge = buildBadge(amount, big, anchor);
    badge.__sig = sig;
    badge.__anchor = anchor;
    anchorBadge.set(anchor, badge);
    badges.add(badge);

    const parent = anchor.parentElement;
    if (!big && parent) {
      const cs = getComputedStyle(parent);
      if (cs.display.includes('flex') && !cs.flexDirection.startsWith('column')) {
        parent.classList.add('gfx-wrap');
        badge.classList.add('gfx-badge--line');
      }
    }
    anchor.insertAdjacentElement('afterend', badge);
  }

  function flushPrices() {
    // убрать «осиротевшие» бейджи
    for (const b of badges) {
      const a = b.__anchor;
      if (!b.isConnected || !a || !a.isConnected || a.nextSibling !== b) {
        b.remove();
        badges.delete(b);
        if (a && anchorBadge.get(a) === b) anchorBadge.delete(a);
        if (a && a.isConnected) {
          // сайт что-то вставил между ценой и бейджем — перепроверим цену
          const tw = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
          let t;
          while ((t = tw.nextNode())) if (YUAN.test(t.nodeValue)) priceDirty.add(t);
        }
      }
    }
    if (!S.prices) { priceDirty.clear(); return; }
    const seen = new Set();
    for (const tn of priceDirty) {
      const info = detectPrice(tn);
      if (!info || seen.has(info.anchor)) continue;
      seen.add(info.anchor);
      if (info.struck && S.skipStrike) continue;
      // крошечные промо-плитки (цена поверх картинки 90px) — бейдж не помещается
      const tile = info.anchor.closest('a');
      if (tile && tile.offsetWidth && tile.offsetWidth < 150) continue;
      placeBadge(info);
    }
    priceDirty.clear();
  }

  function removeAllBadges() {
    for (const b of badges) b.remove();
    badges.clear();
    document.querySelectorAll('.gfx-wrap').forEach((e) => e.classList.remove('gfx-wrap'));
  }

  function rescanPrices() {
    removeAllBadges();
    if (!S.prices) return;
    const tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) if (YUAN.test(n.nodeValue)) priceDirty.add(n);
    flushPrices();
  }


  // ================================================================ favorites
  let favs = {};
  let bumpCart = '';  // какую кнопку в шапке «подбросить»: 'favs' | 'cart'
  const priceSynced = new Set();

  function itemIdFromHref(href) {
    try { return new URL(href, location.href).searchParams.get('id'); } catch (e) { return null; }
  }
  // Ссылка-карточка товара. Нельзя искать по 'item?id=': при нажатии мыши сайт дописывает
  // метку перехода, и ссылка превращается в item?spm=…&id=… — карточка «терялась» прямо в момент клика по ☆.
  function cardOf(el) {
    const a = el && el.closest && el.closest('a[href*="item?"]');
    return a && itemIdFromHref(a.getAttribute('href')) ? a : null;
  }
  function pageItemId() {
    return location.pathname.startsWith('/item') ? new URLSearchParams(location.search).get('id') : null;
  }
  function absUrl(src) {
    if (!src) return '';
    return src.startsWith('//') ? 'https:' + src : src;
  }

  // Один товар — одна запись в favs с отметками: fav (в избранном; у старых записей поля нет — считаем, что да)
  // и cart (в корзине). Запись удаляется, когда сняты обе отметки.
  const isFav = (f) => !!f && f.fav !== false;
  const inCart = (f) => !!f && f.cart === true;
  const CTL = '[data-gfx-fav],[data-gfx-cart]';
  const ctlKind = (s) => (s.hasAttribute('data-gfx-cart') ? 'cart' : 'fav');
  const ctlId = (s) => s.getAttribute('data-gfx-cart') || s.getAttribute('data-gfx-fav');

  function makeCtl(kind, id, anchor, amount, big) {
    const s = big ? mk('button', 'gfx-favbtn') : mk('span', 'gfx-pill gfx-star');
    if (big) s.type = 'button';
    s.setAttribute(kind === 'cart' ? 'data-gfx-cart' : 'data-gfx-fav', id);
    s.__anchor = anchor;
    s.__amount = amount;
    s.__big = big;
    paintCtl(s);
    return s;
  }

  function paintCtl(s) {
    const cart = ctlKind(s) === 'cart';
    const f = favs[ctlId(s)];
    const on = cart ? inCart(f) : isFav(f);
    const big = s.classList.contains('gfx-favbtn');
    s.classList.toggle('gfx-on', on);
    if (cart) {
      s.textContent = '';
      s.appendChild(mk('i', 'gfx-ico-cart'));
      if (big) s.appendChild(document.createTextNode(on ? 'В корзине ✓' : 'В корзину'));
      s.title = on ? 'Убрать из корзины' : 'Добавить в корзину';
    } else {
      s.textContent = big ? (on ? '★ В избранном' : '☆ В избранное') : (on ? '★' : '☆');
      s.title = on ? 'Убрать из избранного' : 'Добавить в избранное';
    }
  }

  function refreshStars() {
    document.querySelectorAll(CTL).forEach(paintCtl);
  }

  // переведённый текст элемента + исходный китайский (из наших записей)
  function textWithOrig(el) {
    let tr = '', orig = '';
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) {
      if (n.parentElement && isOurs(n.parentElement)) continue;
      const rec = textRec.get(n);
      tr += n.nodeValue;
      orig += rec && rec.tr === n.nodeValue ? rec.orig : n.nodeValue;
    }
    return [tr.replace(/\s+/g, ' ').trim(), orig.replace(/\s+/g, ' ').trim()];
  }

  function attrWithOrig(el, name) {
    const v = (el.getAttribute(name) || '').trim();
    const rec = attrRec.get(el);
    const orig = rec && rec[name] && rec[name].tr === el.getAttribute(name) ? rec[name].orig.trim() : v;
    return [v, orig];
  }

  // ленивые картинки ленты: пока карточка не на экране, вместо фото заглушка 2×2
  const PLACEHOLDER = /tps-2-2|tps-1-1|\/s\.gif|spaceball/i;
  function imgUrl(im) {
    for (const c of [im.currentSrc, im.src, im.getAttribute('data-src'), im.getAttribute('data-ks-lazyload')]) {
      if (c && !c.startsWith('data:') && !PLACEHOLDER.test(c)) return absUrl(c);
    }
    return '';
  }

  // Фото товара в карточке ленты — самое крупное изображение карточки.
  // Аватарка продавца и значки лежат в той же ссылке, поэтому мелкие картинки пропускаем.
  function cardImg(card) {
    let best = null, area = 0;
    for (const im of card.querySelectorAll('img')) {
      if (isOurs(im)) continue;
      const p = im.parentElement;
      if (/avatar|seller|user/i.test(String(im.className) + ' ' + String(p ? p.className : ''))) continue;
      const r = im.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) continue;
      if (r.width * r.height > area) { best = im; area = r.width * r.height; }
    }
    return best;
  }

  // когда настоящая картинка подгрузилась — дописываем её в избранное
  async function checkFavImg(im) {
    const card = cardOf(im);
    if (!card) return;
    const id = itemIdFromHref(card.getAttribute('href'));
    if (!id || !favs[id] || favs[id].img) return;
    if (cardImg(card) !== im) return; // подгрузилась аватарка или значок, а не фото товара
    const url = imgUrl(im);
    if (!url) return;
    try {
      const store = await loadFavs();
      if (store[id] && !store[id].img) { store[id].img = url; await chrome.storage.local.set({ favs: store }); }
    } catch (e) { /* ignore */ }
  }

  // Первое фото на странице товара. Берём первую миниатюру галереи; если галереи нет — слайд №0.
  // Просто «первая крупная картинка» не годится: карусель в разметке начинается с копии ПОСЛЕДНЕГО фото.
  function pagePhoto() {
    for (const sel of ['[class*="item-main-window-list-item"] img', '.slick-slide[data-index="0"] img']) {
      const im = document.querySelector(sel);
      const u = im && !im.closest('.slick-cloned') ? imgUrl(im) : '';
      if (u) return u;
    }
    // галереи и карусели нет (одно фото) — самое крупное фото страницы, кроме копий и карточек рекомендаций
    let best = null, area = 0;
    for (const im of document.querySelectorAll('img')) {
      if (isOurs(im) || im.closest('.slick-cloned, a[href*="item?"]')) continue;
      if (!/alicdn|fleamarket|bao\/uploaded/.test(im.src)) continue;
      const r = im.getBoundingClientRect();
      if (r.width >= 150 && r.width * r.height > area) { best = im; area = r.width * r.height; }
    }
    return best ? imgUrl(best) : '';
  }

  // название и главное фото со страницы товара; named — заголовок уже от товара, а не общий заголовок сайта
  const SITE_SUFFIX = /\s*[_|\-–—]\s*(闲鱼|Xianyu|Goofish|Idle ?fish)\s*$/i;
  function pageMeta() {
    let title = '', titleZh = '', img = '';
    const t = document.querySelector('title');
    if (t) [title, titleZh] = textWithOrig(t);
    const named = SITE_SUFFIX.test(title) || SITE_SUFFIX.test(titleZh);
    title = title.replace(SITE_SUFFIX, '').trim();
    titleZh = titleZh.replace(SITE_SUFFIX, '').trim();
    img = pagePhoto();
    return { title, titleZh, img, named };
  }

  function collectMeta(btn) {
    const id = ctlId(btn);
    const anchor = btn.__anchor;
    if (!id) return null;
    let title = '', titleZh = '', img = '';
    if (!btn.__big) {
      const card = anchor && cardOf(anchor);
      if (card) {
        const tEl = card.querySelector('[class*="main-title"]') || card.querySelector('[class*="title"]:not(img)');
        if (tEl) [title, titleZh] = textWithOrig(tEl);
        if (!title) {
          // плитки без подписи: название лежит в title/alt картинки или ссылки
          for (const el of [card, ...card.querySelectorAll('[title], img[alt]')]) {
            if (isOurs(el)) continue;
            const name = el.hasAttribute('title') ? 'title' : 'alt';
            const [v, o] = attrWithOrig(el, name);
            if (v && v.length > 2 && !/^(icon|avatar|image)$/i.test(v)) { title = v; titleZh = o; break; }
          }
        }
        const im = cardImg(card);
        if (im) img = imgUrl(im);
      }
    } else {
      ({ title, titleZh, img } = pageMeta());
    }
    // перевод ещё в пути — берём из кэша, если есть
    if (CJK.test(title)) {
      const t = lookup(title);
      if (t) { titleZh = title; title = t; }
    }
    if (!title) title = titleZh || 'Item ' + id;
    return { id, url: 'https://www.goofish.com/item?id=' + id, title, titleZh, price: btn.__amount, listPrice: btn.__amount, img };
  }

  async function loadFavs() {
    return (await chrome.storage.local.get('favs')).favs || {};
  }

  // клики по ☆ обрабатываем строго по очереди, иначе два быстрых клика перезапишут друг друга
  let favQueue = Promise.resolve();
  function toggleFav(btn) {
    favQueue = favQueue.then(() => doToggleFav(btn)).catch(() => {});
    return favQueue;
  }

  async function doToggleFav(btn) {
    let store;
    try { store = await loadFavs(); } catch (e) { toast('Расширение обновилось — перезагрузите страницу', 3000); return; }
    const cart = ctlKind(btn) === 'cart';
    const id = ctlId(btn);
    const f = store[id];
    if (cart ? inCart(f) : isFav(f)) {
      // снимаем отметку; запись остаётся, только если товар есть в другом списке
      if (cart ? isFav(f) : inCart(f)) { if (cart) f.cart = false; else f.fav = false; }
      else delete store[id];
      toast(cart ? 'Убрано из корзины' : 'Убрано из избранного');
    } else {
      if (f) {
        if (cart) f.cart = true; else f.fav = true;
      } else {
        const meta = collectMeta(btn);
        if (!meta) return;
        store[id] = { ...meta, qty: 1, fav: !cart, cart, addedAt: Date.now(), priceAtAdd: meta.price };
      }
      if (cart) store[id].cartAt = Date.now();
      bumpCart = cart ? 'cart' : 'favs';
      toast(cart ? 'Добавлено в корзину' : '★ Добавлено в избранное');
    }
    favs = store;
    refreshStars();
    renderCart();
    await chrome.storage.local.set({ favs: store });
  }

  // на странице товара обновляем цену сохранённого товара (если продавец её поменял)
  async function syncFavPrice(id, amount) {
    if (priceSynced.has(id) || !favs[id]) return;
    priceSynced.add(id);
    try {
      const store = await loadFavs();
      const f = store[id];
      if (!f || +f.listPrice === amount) return;
      f.listPrice = amount;
      if (!f.manual) f.price = amount;
      f.updatedAt = Date.now();
      await chrome.storage.local.set({ favs: store });
    } catch (e) { /* ignore */ }
  }

  // На странице товара сверяем сохранённую запись: дописываем название, если его нет, и ставим
  // первое фото товара (раньше в запись могла попасть аватарка продавца или последнее фото).
  const isStubTitle = (f) => !f.title || f.title === 'Item ' + f.id;
  const imgKey = (u) => (u || '').replace(/^https?:/, '').replace(/_\d+x\d+.*$/, '');
  const metaSynced = new Set();
  let metaTimer = 0;
  function syncFavMeta(id, tries = 0) {
    if (metaSynced.has(id)) return;
    clearTimeout(metaTimer);
    metaTimer = setTimeout(async () => {
      if (pageItemId() !== id) return;
      try {
        const store = await loadFavs();
        const s = store[id];
        if (!s) return; // товара нет ни в избранном, ни в корзине
        const m = pageMeta();
        let changed = false;
        if (m.img && imgKey(m.img) !== imgKey(s.img)) { s.img = m.img; changed = true; }
        if (isStubTitle(s) && m.named && m.title) { s.title = m.title; s.titleZh = m.titleZh; changed = true; }
        if (changed) await chrome.storage.local.set({ favs: store });
        if (m.img && !isStubTitle(s)) { metaSynced.add(id); return; }
      } catch (e) { return; }
      // страница ещё грузится — попробуем позже
      if (tries < 5) syncFavMeta(id, tries + 1);
    }, 1200);
  }

  // ---- Статус товара: продан / снят с продажи / удалён.
  // Читаем его со страницы товара, когда пользователь её открыл. Сами сайт не опрашиваем:
  // на частые запросы карточек Goofish отвечает требованием входа.
  // Признаки взяты из кода страницы Goofish: на проданном и снятом товаре поверх фото лежит
  // штамп (блок item-status в карусели), у удалённого — надпись «糟糕！宝贝被删掉了».
  const STAMP_SOLD = 'O1CN01XvUrci1XK59jkqafe'; // штамп «卖掉了» (продано)
  const STAMP_OFF = 'O1CN016Us3b321aVpzyxCA4';  // штамп «已下架» (снято)
  function pageStatus() {
    const st = document.querySelector('[class*="carousel-container"] [class*="item-status"] img');
    if (st) {
      const src = st.currentSrc || st.src || st.getAttribute('data-src') || '';
      if (src.includes(STAMP_SOLD)) return 'sold';
      if (src.includes(STAMP_OFF)) return 'off';
      return src ? 'off' : null; // незнакомый штамп — товар в любом случае недоступен
    }
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, k = 0;
    while ((n = tw.nextNode()) && k++ < 5000) {
      const rec = textRec.get(n);
      if ((rec ? rec.orig : n.nodeValue).includes('宝贝被删掉了')) return 'gone';
    }
    // товар показан как обычно: есть его заголовок и галерея — значит, в продаже
    if (pageMeta().named && document.querySelector('[class*="carousel-container"], [class*="item-main-window"]')) return 'ok';
    return null; // страница ещё грузится или Goofish её не показал — ничего не утверждаем
  }

  const statusSynced = new Set();
  let statusTimer = 0;
  function syncFavStatus(id, tries = 0) {
    if (!IS_TOP || statusSynced.has(id)) return;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(async () => {
      if (pageItemId() !== id) return;
      const st = pageStatus();
      if (!st) { if (tries < 6) syncFavStatus(id, tries + 1); return; }
      statusSynced.add(id);
      try {
        const store = await loadFavs();
        const s = store[id];
        if (!s) return;
        const next = st === 'ok' ? undefined : st;
        if (s.status === next) return;
        if (next) s.status = next; else delete s.status;
        s.statusAt = Date.now();
        await chrome.storage.local.set({ favs: store });
      } catch (e) { /* ignore */ }
    }, 1500);
  }

  // Кнопки «Избранное» и «Корзина» в шапке и всплывающая панель — в favpanel.js (следит за storage сама)
  function renderCart() {
    if (bumpCart && self.GFXPanel) self.GFXPanel.bump(bumpCart);
    bumpCart = '';
  }

  window.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    const star = t.closest(CTL);
    if (star) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      toggleFav(star);
    }
  }, true);

  // ================================================================ popup blocker
  const LOGIN_FRAME = /mini_login|passport\.goofish\.com|login\.taobao\.com|havanaone/i;
  let lastClick = 0;
  let itemNotified = false;
  let pageUnblocked = false; // Alt+L — показать окно входа на этой странице
  window.addEventListener('pointerdown', () => { lastClick = Date.now(); }, true);

  function applyScale() {
    const k = gfxScale(S);
    const st = document.documentElement.style;
    st.setProperty('--gfx-zoom', k);
    st.setProperty('--gfx-zoom-s', 1 + (k - 1) / 2);
  }

  // Вошёл ли пользователь в аккаунт Goofish. Тогда окна входа не прячем: вошедшему Goofish показывает
  // их, только когда нужно подтвердить вход, и скрытое окно помешало бы это сделать.
  // Одной cookie unb мало: она остаётся и после незавершённого входа (застрял на проверке по SMS)
  // и после истёкшей сессии. Поэтому при unb спрашиваем сервер тем же запросом, что делает шапка
  // сайта при каждой загрузке: вошедшему он отвечает SUCCESS, остальным — «сессия истекла».
  // Ответ кэшируем на 10 минут для этого набора cookie входа (unb и csg меняются при новом входе).
  const LOGIN_API = 'mtop.taobao.idlemessage.pc.loginuser.get';
  const LOGIN_TTL = 10 * 60e3;
  const LOGIN_KEY = 'gfx:login';
  const cookieVal = (n) => (document.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)')) || [])[1] || '';
  const loginSig = () => (cookieVal('unb') ? cookieVal('unb') + '|' + cookieVal('csg') : '');

  function cachedLogin(sig) { // true | false | null (неизвестно)
    if (!sig) return false;
    try {
      const c = JSON.parse(localStorage.getItem(LOGIN_KEY) || 'null');
      if (c && c.sig === sig && Date.now() - c.ts < LOGIN_TTL) return c.ok;
    } catch (e) { /* localStorage недоступен */ }
    return null;
  }

  let wasLoggedIn = cachedLogin(loginSig()) === true;
  let loginSigNow = loginSig();
  let verifying = false;
  let verifyAfter = 0; // после непонятного ответа или сбоя сети — не чаще раза в минуту

  async function verifyLogin() {
    const sig = loginSig();
    if (verifying || !sig || Date.now() < verifyAfter) return;
    verifying = true;
    let ok = null;
    try {
      for (let i = 0; i < 2 && ok === null; i++) {
        const j = await gfxMtop(LOGIN_API, {}, { needLoginPC: 'true', spm_cnt: 'a21ybx.home.0.0' });
        const ret = String((j && j.ret && j.ret[0]) || '');
        if (ret.startsWith('SUCCESS')) ok = true;
        else if (/SESSION_EXPIRED|SESSION_INVALID|NOT_LOGIN|USER_VALIDATE|RGV587/i.test(ret)) ok = false;
        else if (ret.startsWith('FAIL_SYS_TOKEN')) await new Promise((r) => setTimeout(r, 400)); // выдан свежий токен
        else break;
      }
    } catch (e) { /* сеть: оставляем как было */ }
    verifying = false;
    if (ok === null) { verifyAfter = Date.now() + 60e3; return; }
    try { localStorage.setItem(LOGIN_KEY, JSON.stringify({ sig, ok, ts: Date.now() })); } catch (e) { /* ignore */ }
    if (sig !== loginSig() || ok === wasLoggedIn) return;
    wasLoggedIn = ok;
    if (ready) applyBlockClass();
  }

  function applyBlockClass() {
    if (!IS_TOP) return;
    const de = document.documentElement;
    const on = !!S.blockPopups && !pageUnblocked && !wasLoggedIn;
    de.classList.toggle('gfx-block', on);            // окна входа, плашка «Войдите», «Вход»/«Заказы» в шапке
    de.classList.toggle('gfx-nopop', !!S.blockPopups); // опрос — скрываем и вошедшему
    if (!on) {
      de.removeAttribute('data-gfx-unlock');
      if (gateEl) { gateEl.remove(); gateEl = null; }
    }
  }

  // вход и выход — по QR в окне входа или в другой вкладке — замечаем без перезагрузки страницы
  if (IS_TOP) {
    const recheckLogin = () => {
      const sig = loginSig();
      if (sig === loginSigNow && (!sig || cachedLogin(sig) !== null)) return;
      loginSigNow = sig;
      const c = cachedLogin(sig);
      if (c === null) { verifyLogin(); return; }
      if (c === wasLoggedIn) return;
      wasLoggedIn = c;
      if (ready) applyBlockClass();
    };
    if (loginSigNow && cachedLogin(loginSigNow) === null) verifyLogin();
    setInterval(recheckLogin, 2000);
    document.addEventListener('visibilitychange', recheckLogin);
  }

  function notifyBlocked() {
    if (Date.now() - lastClick < 2000) {
      toast('Для этого Goofish требует вход — окно входа скрыто. Alt+L — показать', 3500);
    } else if (!itemNotified && location.pathname.startsWith('/item')) {
      itemNotified = true;
      // если товар так и не отрисовался — Goofish отказал в карточке без входа (сервер отвечает «сессия истекла»)
      setTimeout(() => {
        if (!document.querySelector('.gfx-card') && document.documentElement.classList.contains('gfx-block')) {
          notifyGate(false);
        }
      }, 4500);
    }
  }

  // Goofish не отдал данные без входа: на поиске это антибот (baxia), на странице товара — ответ
  // «сессия истекла». Окно входа скрыто, поэтому без пояснения сайт пишет «сеть пропала» или
  // показывает пустую выдачу. Говорим прямо, что случилось, и держим сообщение, пока его не закроют.
  let gateEl = null;
  let gateDismissed = false;
  function notifyGate(bot = true) {
    if (!IS_TOP || gateDismissed || pageUnblocked) return;
    const p = location.pathname;
    const search = p.startsWith('/search');
    const what = search ? 'результаты поиска' : p.startsWith('/item') ? 'этот товар' : 'часть страницы';
    const text = `Goofish не отдаёт ${what} без входа в аккаунт${bot ? ': сработала его защита от ботов' : ''}. ` +
      `${search ? 'Пустая выдача или надпись' : 'Надпись'} «сеть пропала» — следствие этого, а не сбой сети или расширения. ` +
      'Alt+L — показать окно входа';
    if (!gateEl || !gateEl.isConnected) {
      gateEl = mk('div', UI_CLASS + ' gfx-gate');
      gateEl.setAttribute('role', 'alert');
      const close = mk('button', 'gfx-gate__close', '×');
      close.type = 'button';
      close.title = 'Скрыть';
      close.addEventListener('click', hideGate);
      gateEl.append(mk('span', 'gfx-gate__text'), close);
      (document.body || document.documentElement).appendChild(gateEl);
    }
    gateEl.firstChild.textContent = text;
  }

  function hideGate() {
    gateDismissed = true;
    if (gateEl) gateEl.remove();
    gateEl = null;
  }

  function checkPopups(root) {
    if (!IS_TOP || !S.blockPopups || wasLoggedIn || !root || root.nodeType !== 1) return;
    const cls = typeof root.className === 'string' ? root.className : '';
    if (/login-modal/.test(cls) || root.querySelector('[class*="login-modal"]')) notifyBlocked();
    const frames = root.tagName === 'IFRAME' ? [root] : root.getElementsByTagName('iframe');
    for (const f of frames) {
      if (!LOGIN_FRAME.test(f.getAttribute('src') || '')) continue;
      // самый внешний fixed-контейнер — оверлей модалки; встроенную форму на странице входа не трогаем
      let host = null;
      for (let e = f.parentElement; e && e !== document.body; e = e.parentElement) {
        if (getComputedStyle(e).position === 'fixed') host = e;
      }
      if (!host || host.hasAttribute('data-gfx-blocked')) continue;
      // окно от антибота (baxia): сервер уже отказал в данных и ждёт входа — сообщаем об этом сразу
      if (/appEntrance=baxia/i.test(f.getAttribute('src') || '') || /baxia/i.test(String(host.className))) notifyGate();
      host.setAttribute('data-gfx-blocked', '');
      const mask = host.previousElementSibling;
      if (mask && /mask/i.test(String(mask.className)) && getComputedStyle(mask).position === 'fixed') {
        mask.setAttribute('data-gfx-blocked', '');
      }
      document.documentElement.setAttribute('data-gfx-unlock', '');
      notifyBlocked();
    }
  }

  // ================================================================ scanning
  const walkerFilter = {
    acceptNode(n) {
      if (n.nodeType === 1 && (SKIP_TAGS.has(n.tagName) || (n.classList && n.classList.contains(UI_CLASS)))) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  };

  function scan(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      notePrice(root);
      if (canTranslate()) handleText(root, false);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (SKIP_TAGS.has(root.tagName) || isOurs(root)) return;
    }
    const tr = canTranslate();
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, walkerFilter);
    let n = root;
    do {
      if (n.nodeType === 3) {
        notePrice(n);
        if (tr) handleText(n, true);
      } else if (tr && n.nodeType === 1) {
        handleAttrs(n);
      }
    } while ((n = tw.nextNode()));
  }

  function fullScan() {
    scan(document.documentElement);
    flushPrices();
    checkPopups(document.body);
    renderCart();
  }

  // ================================================================ observer
  const mo = new MutationObserver((records) => {
    if (!ready) return;
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains(UI_CLASS)) continue;
          if (n.nodeType === 1) checkPopups(n);
          scan(n);
        }
      } else if (r.type === 'characterData') {
        const n = r.target;
        if (n.parentElement && isOurs(n.parentElement)) continue;
        notePrice(n);
        if (canTranslate()) handleText(n, false);
      } else if (r.type === 'attributes') {
        if (r.attributeName === 'src') { if (r.target.tagName === 'IMG') checkFavImg(r.target); continue; }
        if (canTranslate() && r.target.nodeType === 1 && !isOurs(r.target)) handleAttrs(r.target);
      }
    }
    flushPrices();
  });

  function startObserver() {
    mo.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS.concat(['value', 'src'])
    });
  }

  // ============================================== показать оригинал / перевод
  function restoreOriginals() {
    for (const n of tracked) {
      if (!n.isConnected) { tracked.delete(n); continue; }
      if (n.nodeType === 3) {
        const rec = textRec.get(n);
        if (rec && n.nodeValue === rec.tr) n.nodeValue = rec.orig;
      } else {
        const rec = attrRec.get(n);
        if (rec) for (const name in rec) if (n.getAttribute(name) === rec[name].tr) n.setAttribute(name, rec[name].orig);
      }
    }
    tracked.clear();
  }

  function setShowOriginal(flag) {
    showOriginal = flag;
    if (flag) restoreOriginals();
    else fullScan();
    toast(flag ? 'Оригинал (Alt+T — перевод)' : 'Перевод включён');
  }

  let toastEl = null, toastTimer = 0;
  function toast(text, ms = 1400) {
    if (window.top !== window) return;
    if (!toastEl || !toastEl.isConnected) {
      toastEl = mk('div', UI_CLASS + ' gfx-toast');
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('gfx-toast--show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('gfx-toast--show'), ms);
  }

  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyT') {
      e.preventDefault();
      e.stopPropagation();
      setShowOriginal(!showOriginal);
    } else if (e.code === 'KeyL' && IS_TOP) {
      e.preventDefault();
      e.stopPropagation();
      if (wasLoggedIn) { toast('Вы вошли в аккаунт — окна входа и так не скрываются'); return; }
      pageUnblocked = !pageUnblocked;
      applyBlockClass();
      if (pageUnblocked && gateEl) { gateEl.remove(); gateEl = null; }
      toast(pageUnblocked ? 'Окна входа показаны на этой странице (Alt+L — скрыть)' : 'Окна входа снова скрыты');
    }
  }, true);

  // ================================================================ settings
  let settingsSig = '';
  function computeSig() {
    const R = rates();
    settingsSig = [S.showRub, S.showUsd, S.showBuyer, S.buyerRate, S.buyerFee, R.RUB, R.USD].join('|');
  }

  function onSettingsChanged(prev) {
    computeSig();
    applyBlockClass();
    applyScale();
    if (S.blockPopups && !prev.blockPopups) checkPopups(document.body);
    if (prev.lang !== S.lang) { location.reload(); return; }
    if (prev.translate !== S.translate) {
      if (!S.translate) restoreOriginals();
      else fullScan();
    }
    rescanPrices();
    renderCart();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      const prev = S;
      S = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      if (ready) onSettingsChanged(prev);
    }
    if (changes.rates && changes.rates.newValue) {
      marketRates = changes.rates.newValue;
      computeSig();
      if (ready) { rescanPrices(); renderCart(); }
    }
    if (changes.favs) {
      favs = changes.favs.newValue || {};
      if (ready) { refreshStars(); renderCart(); }
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'toggleOriginal') {
      if (window.top === window) setShowOriginal(!showOriginal);
      sendResponse({ ok: true, showOriginal });
    } else if (msg.type === 'status') {
      sendResponse({ ok: true, showOriginal, cached: mem.size });
    }
  });

  // ================================================================ boot
  // по умолчанию сразу, до загрузки настроек (окна входа — только гостю)
  if (IS_TOP) {
    document.documentElement.classList.add('gfx-nopop');
    if (!wasLoggedIn) document.documentElement.classList.add('gfx-block');
  }
  startObserver(); // наблюдаем с самого начала; до ready события игнорируются, их покроет fullScan

  chrome.storage.local.get(null, (all) => {
    all = all || {};
    S = { ...DEFAULTS, ...(all.settings || {}) };
    if (all.rates) marketRates = all.rates;
    favs = all.favs || {};
    applyBlockClass();
    applyScale();
    const prefix = 't:' + S.lang + ':';
    for (const k in all) {
      if (k.charCodeAt(0) === 116 && k.startsWith(prefix)) mem.set(k.slice(prefix.length), all[k]);
    }
    computeSig();
    ready = true;
    fullScan();
    // удалённый товар показывается без цены, поэтому статус проверяем и без карточки цены
    if (pageItemId()) syncFavStatus(pageItemId());

    // курсы обновляем в фоне (если устарели)
    if (!all.rates || Date.now() - (all.rates.ts || 0) > 6 * 3600 * 1000) {
      sendMessage({ type: 'rates' }).then((r) => {
        if (r && r.rates) { marketRates = r.rates; computeSig(); rescanPrices(); }
      });
    }
  });

  // страховка для поздно отрисованных SPA-страниц
  document.addEventListener('DOMContentLoaded', () => { if (ready) fullScan(); });
})();
