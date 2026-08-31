#!/usr/bin/env node
/* Big-sale banner — paintBigSale_ / applyBigSaleTreatment_ in index.html.
 *
 * One big sale lights three surfaces on the kiosk: the #kioskBigSale banner under the header, a
 * .hot flame on the seller's card, and the Biggest Sale trophy. They are supposed to hold for the
 * same BIG_SALE_HOLD_MS and go dark together. The failure this file exists to prevent is the
 * surfaces DISAGREEING — module state saying the banner is up while the kiosk shows nothing.
 *
 * Why that is worth a test rather than a look: the banner is on .lb-section, which the 5-minute
 * leaderboard refresh replaces wholesale, handing the module a fresh #kioskBigSale carrying no
 * .show. applyBigSaleTreatment_ used to guard its repaint on the sale's ts alone, so with the same
 * sale still inside its window the guard was false and the banner never came back — while the
 * flame, re-added unconditionally on every pass, kept burning. Nothing errors, nothing logs, and
 * on a wall-mounted screen nobody reloads it just looks like the banner is shorter some days.
 * (bug_mt95r4ho_54re, 2026-08-25.)
 *
 * Per tests/_harness.js's rule this NEVER reimplements the module: it extracts the real function
 * bodies from the shipped index.html and runs them. The harness itself is not reused — it loads
 * .gs files, and this code lives in the monolith (same approach as nightly_refresh_test.js).
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Pull one top-level-in-the-IIFE function out of the monolith. Bodies are indented 2 spaces, so a
// line that is exactly "  }" closes them; nested callbacks close deeper and can't terminate early.
function grab(name) {
  const re = new RegExp('\\n  function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n');
  const m = src.match(re);
  if (!m) throw new Error('function not found in index.html: ' + name);
  return m[0];
}
const CODE = ['parseLocalTs_', 'bigSaleRemainingMs_', 'noteBigSale_', 'paintBigSale_',
              'applyBigSaleTreatment_'].map(grab).join('\n');

// The hold comes from the shipped constant, not a copy — shortening it in index.html must move
// these assertions with it rather than quietly falsifying them.
const HOLD_DECL = src.match(/\n  var BIG_SALE_HOLD_MS = [^;]+;/);
if (!HOLD_DECL) throw new Error('BIG_SALE_HOLD_MS not found in index.html');
const HOLD_MS = vm.runInNewContext(HOLD_DECL[0].trim().replace(/^var /, '') + '\nBIG_SALE_HOLD_MS;');

const MIN = 300;   // GC.THRESHOLDS.bigTransactionMin — only the ordering against it matters here

// ── A DOM small enough to reason about, real enough to catch the bug ────────────────────────────
function makeEl(id) {
  const cls = new Set();
  return {
    id, innerHTML: '',
    classList: {
      add()    { for (const c of arguments) cls.add(c); },
      remove() { for (const c of arguments) cls.delete(c); },
      contains(c) { return cls.has(c); },
    },
    _cls: cls,
  };
}

function make() {
  const env = { now: 0, timers: [], seq: 0, cards: {} };

  env.banner = makeEl('kioskBigSale');
  const byId = { kioskBigSale: () => env.banner };

  const sandbox = {
    console,
    GC: { THRESHOLDS: { bigTransactionMin: MIN } },
    e: s => String(s),
    fmtDollars: n => '$' + n,
    fmtTxnTime: ts => String(ts).slice(11, 16),
    // The seller's card, when they're on the board. Mirrors the real sellerCard_ contract:
    // an element with data-emp-key, or null when the seller isn't rendered.
    sellerCard_: (whoKey, who) => env.cards[whoKey || who] || null,
    document: {
      getElementById: id => (byId[id] ? byId[id]() : null),
      querySelectorAll: sel => {
        if (sel !== '.emp-card.hot') throw new Error('unexpected selector: ' + sel);
        return Object.keys(env.cards)
          .map(k => env.cards[k])
          .filter(c => c.classList.contains('hot'));
      },
    },
    setTimeout: (fn, ms) => { const id = ++env.seq; env.timers.push({ id, fn, at: env.now + ms }); return id; },
    clearTimeout: id => { env.timers = env.timers.filter(t => t.id !== id); },
    Date: Object.assign(
      class extends Date { constructor(...a) { if (!a.length) super(env.now); else super(...a); } },
      { now: () => env.now, UTC: Date.UTC, parse: Date.parse }
    ),
  };
  vm.createContext(sandbox);
  // Module state the real IIFE holds in its closure.
  vm.runInContext(
    'var BIG_SALE_HOLD_MS = ' + HOLD_MS + ';\n' +
    'var _bigSale = null, _bigSales = [], _bigSaleTimer = null, _bigSaleFade = null;\n' + CODE +
    '\nthis.api = { apply: applyBigSaleTreatment_, note: noteBigSale_, paint: paintBigSale_,\n' +
    '             state: function() { return _bigSale; } };', sandbox);

  const api = sandbox.api;

  // A sale `minsAgo` minutes back, expressed the way the ticker does: a local wall-clock string
  // with no zone. Built from the sandbox clock so the test is timezone-independent.
  env.sale = (who, price, minsAgo) => {
    const d = new Date(env.now - minsAgo * 60000);
    const p = n => String(n).padStart(2, '0');
    return {
      who, whoKey: who.toLowerCase(), price,
      ts: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
          p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()),
    };
  };
  env.addCard = key => {
    const c = makeEl('card-' + key);
    c.getAttribute = a => (a === 'data-emp-key' ? key : null);
    env.cards[key] = c;
    return c;
  };
  // Replace #kioskBigSale the way the 5-minute refresh does: section.outerHTML = renderStaffGrid(…)
  // yields a brand-new element with no .show and no content.
  env.rebuildGrid = () => { env.banner = makeEl('kioskBigSale'); };
  env.at = ms => { env.now = ms; };
  env.advance = ms => {   // move the clock and fire anything that came due
    env.now += ms;
    let due;
    while ((due = env.timers.filter(t => t.at <= env.now)).length) {
      env.timers = env.timers.filter(t => t.at > env.now);
      due.sort((a, b) => a.at - b.at).forEach(t => t.fn());
    }
  };
  env.flushFades = () => {   // fire pending timeouts WITHOUT moving the clock (the fade race)
    const due = env.timers.slice();
    env.timers = [];
    due.forEach(t => t.fn());
  };
  env.shown  = () => env.banner.classList.contains('show');
  env.fading = () => env.banner.classList.contains('fading');
  env.api = api;
  env.at(new Date(2026, 7, 25, 14, 0, 0).getTime());
  return env;
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (err) { console.log('  FAIL ' + name + ' — ' + err.message); fail++; }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'value') + ': expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a));
}

// ── Baseline behavior ──────────────────────────────────────────────────────────────────────────

t('a fresh big sale shows the banner', () => {
  const x = make();
  x.api.note(x.sale('Lina', 900, 0));
  x.api.apply();
  eq(x.shown(), true, 'shown');
  eq(/Lina/.test(x.banner.innerHTML), true, 'names the seller');
});

t('a sale under the threshold never reaches the banner', () => {
  const x = make();
  x.api.note(x.sale('Lina', MIN - 1, 0));
  x.api.apply();
  eq(x.shown(), false, 'shown');
  eq(x.api.state(), null, 'module state');
});

t('the banner fades out once the hold expires', () => {
  const x = make();
  x.api.note(x.sale('Lina', 900, 0));
  x.api.apply();
  x.advance(HOLD_MS + 1000);            // the scheduled recompute fires here
  eq(x.api.state(), null, 'module state cleared');
  eq(x.fading() || !x.shown(), true, 'fading or already gone');
  x.advance(2000);                      // let the 1.3s removal land
  eq(x.shown(), false, 'shown');
});

// ── The regression: the 5-minute staff-grid rebuild ─────────────────────────────────────────────

t('REGRESSION: the banner returns after the grid is rebuilt mid-hold', () => {
  const x = make();
  x.api.note(x.sale('Lina', 900, 0));
  x.api.apply();
  eq(x.shown(), true, 'shown before rebuild');

  x.advance(5 * 60 * 1000);   // 5-minute leaderboard refresh, still inside the 12-minute hold
  x.rebuildGrid();            // .lb-section replaced — fresh #kioskBigSale, no .show
  eq(x.shown(), false, 'the fresh element starts blank');

  x.api.apply();              // what the refresh handler calls
  eq(x.shown(), true, 'banner restored on the new element');
  eq(/Lina/.test(x.banner.innerHTML), true, 'content restored too');
});

t('the rebuild does NOT resurrect a sale whose hold has already run out', () => {
  const x = make();
  x.api.note(x.sale('Lina', 900, 0));
  x.api.apply();
  x.advance(HOLD_MS + 1000);
  x.advance(2000);
  x.rebuildGrid();
  x.api.apply();
  eq(x.shown(), false, 'shown');
  eq(x.fading(), false, 'no stale fade on a brand-new element');
});

t('banner and card flame agree after a rebuild — neither surface outlives the other', () => {
  const x = make();
  x.addCard('lina');
  x.api.note(x.sale('Lina', 900, 0));
  x.api.apply();
  eq(x.cards.lina.classList.contains('hot'), true, 'flame lit');

  x.advance(5 * 60 * 1000);
  x.rebuildGrid();
  x.addCard('lina');           // cards are rebuilt with the grid
  x.api.apply();
  eq(x.shown(), true, 'banner');
  eq(x.cards.lina.classList.contains('hot'), true, 'flame');

  x.advance(HOLD_MS);          // both should be gone together
  x.advance(2000);
  eq(x.shown(), false, 'banner after expiry');
  eq(x.cards.lina.classList.contains('hot'), false, 'flame after expiry');
});

t('repeated passes with no DOM change do not re-add .fading while idle', () => {
  const x = make();
  x.api.apply(); x.api.apply(); x.api.apply();
  eq(x.shown(), false, 'shown');
  eq(x.fading(), false, 'fading');
});

// ── The other road to the same divergence: a fade-out still in flight ───────────────────────────

t('a new sale inside the 1.3s fade is not stripped by the old fade timer', () => {
  const x = make();
  x.api.note(x.sale('Lina', 900, 0));
  x.api.apply();
  x.advance(HOLD_MS + 1000);          // expires → .fading, removal queued for +1300ms
  eq(x.fading(), true, 'fading started');

  x.api.note(x.sale('Marco', 1200, 0));   // lands during the fade
  x.api.apply();
  eq(x.shown(), true, 'new banner up');
  eq(x.fading(), false, 'fade canceled');

  x.flushFades();                     // whatever the old pass left queued fires now
  eq(x.shown(), true, 'new banner survives the old fade timeout');
  eq(/Marco/.test(x.banner.innerHTML), true, 'shows the new seller');
});

// ── Sale changing hands ─────────────────────────────────────────────────────────────────────────

t('a bigger, newer sale takes over the banner', () => {
  const x = make();
  x.api.note(x.sale('Lina', 900, 3));
  x.api.apply();
  eq(/Lina/.test(x.banner.innerHTML), true, 'Lina first');

  x.api.note(x.sale('Marco', 1500, 0));
  x.api.apply();
  eq(x.shown(), true, 'shown');
  eq(/Marco/.test(x.banner.innerHTML), true, 'Marco takes over');
});

t('the most RECENT live sale holds the banner, not the largest', () => {
  const x = make();
  x.api.note(x.sale('Lina', 5000, 4));
  x.api.note(x.sale('Marco', 600, 1));
  x.api.apply();
  eq(/Marco/.test(x.banner.innerHTML), true, 'newest wins');
});

t('a sale already past its hold at mount never shows', () => {
  const x = make();
  x.api.note(x.sale('Lina', 900, 20));   // 20 min ago, hold is 12
  x.api.apply();
  eq(x.shown(), false, 'shown');
  eq(x.api.state(), null, 'module state');
});

// ── The guard itself ────────────────────────────────────────────────────────────────────────────

t('the ts-only guard is gone: repaint keys off the DOM as well', () => {
  const body = src.match(/\n  function applyBigSaleTreatment_\(\)[\s\S]*?\n  \}\n/)[0];
  eq(/getElementById\('kioskBigSale'\)/.test(body), true,
     'applyBigSaleTreatment_ must consult the live banner element');
  eq(/contains\('show'\)/.test(body), true,
     'applyBigSaleTreatment_ must check for the .show class');
});

console.log(fail === 0
  ? '\n✅ big_sale_banner ALL PASS (' + pass + '/' + (pass + fail) + ')'
  : '\n❌ big_sale_banner ' + fail + ' FAILED (' + pass + '/' + (pass + fail) + ')');
process.exit(fail === 0 ? 0 : 1);
