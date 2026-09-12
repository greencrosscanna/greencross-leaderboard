#!/usr/bin/env node
/* The kiosk SPIFF button — the popup in index.html (renderSpiffOverlay + GC.views.openSpiffBoard).
 *
 * Sky, 2026-09-11: "the spiff button should open the store specific SPIFF link supplied by SPIFF,
 * with the addition of the staff level progress… I'm saying pop up, but maybe that's being blocked,
 * what about an overlay that is acting like a popup." And: "the data takes too long to load."
 *
 * So: SPIFF's own page, in a popup this page draws, already loaded before anybody taps. Three ways
 * that goes wrong, all of them on a WALL SCREEN with nobody standing at it:
 *
 *   1. A COLD FRAME. If `src` is set when the popup opens, every tap buys a blank card and several
 *      seconds of SPIFF's "Loading…" while it fetches over JSONP. The frame must be warm at kiosk
 *      paint — that is the entire fix for the complaint, and it is one attribute away from
 *      regressing back to lazy every time someone "tidies up" the render.
 *
 *   2. A POPUP THAT OUTLIVES THE BOARD. The two-minute auto-close is why the kiosk comes back on
 *      its own. It has to fire, and it has to fire when Include SPIFF is switched off mid-view.
 *
 *   3. A BUTTON THAT DOES NOTHING. Include SPIFF is the one switch for the button, so a store with
 *      the setting on and no token must still open something — Leaderboard's own panel.
 *
 * Per tests/_harness.js's rule this NEVER reimplements: it lifts the real code out of the shipped
 * index.html and runs it.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (m, c) => { c ? (pass++, console.log('  ok  ' + m)) : (fail++, console.log('  FAIL ' + m)); };

// ── The markup half: renderSpiffOverlay, lifted and run ────────────────────────────────────────
const rsoStart = src.indexOf('  function renderSpiffOverlay(url, storeName) {');
const rsoEnd   = src.indexOf('\n  }\n', rsoStart);
if (rsoStart < 0 || rsoEnd < 0) throw new Error('renderSpiffOverlay not found in index.html');
const rsoSrc = src.slice(rsoStart, rsoEnd + 4).trim();
const rso = new vm.Script(rsoSrc + '; renderSpiffOverlay')
  .runInNewContext({ e: (v) => String(v == null ? '' : v).replace(/[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) });

// ── The behavior half: the popup block, lifted and run ─────────────────────────────────────────
const bStart = src.indexOf('/* ── The SPIFF popup');
const bEnd   = src.indexOf('GC.views.renderKiosk = function(slug)');
if (bStart < 0 || bEnd < 0 || bEnd <= bStart) throw new Error('SPIFF popup block not found in index.html');
const block = src.slice(bStart, bEnd);
if (/window\.open\(/.test(block)) throw new Error('the SPIFF button is calling window.open again — Sky asked for a drawn overlay');

function el(id) {
  return { id: id, hidden: false, innerHTML: '', textContent: '', _attr: {},
           classList: { _s: {}, add(c) { this._s[c] = true; }, remove(c) { delete this._s[c]; },
                        contains(c) { return !!this._s[c]; }, toggle(c, on) { on ? this.add(c) : this.remove(c); } },
           setAttribute(k, v) { this._attr[k] = String(v); },
           getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attr, k) ? this._attr[k] : null; },
           removeAttribute(k) { delete this._attr[k]; } };
}

const URL_A = 'https://greencrosscanna.github.io/greencross-spiff/store.html?t=aaa';
const URL_B = 'https://greencrosscanna.github.io/greencross-spiff/store.html?t=bbb';

function setup(opts) {
  opts = opts || {};
  const url = opts.url === undefined ? URL_A : opts.url;
  const nodes = { kioskSpiffOverlay: el('kioskSpiffOverlay'), kioskSpiffPanel: el('kioskSpiffPanel'),
                  kioskSpiffFrame: el('kioskSpiffFrame'), kioskSpiffAuto: el('kioskSpiffAuto') };
  // Seed the nodes the way renderSpiffOverlay's own markup does — asserted separately below, so
  // these two can never drift apart without a failure.
  nodes.kioskSpiffOverlay.setAttribute('data-src', url);
  nodes.kioskSpiffPanel.hidden = !!url;
  nodes.kioskSpiffFrame.hidden = !url;
  if (url) nodes.kioskSpiffFrame.setAttribute('src', url);

  const state = { tick: null, blurBound: 0 };
  const win = { addEventListener(ev) { if (ev === 'blur') state.blurBound++; },
                removeEventListener(ev) { if (ev === 'blur') state.blurBound--; } };
  const ctx = {
    window: win, console: console,
    setInterval: (fn) => { state.tick = fn; return 1; }, clearInterval: () => { state.tick = null; },
    document: { getElementById: (id) => nodes[id] || null, querySelector: () => null },
    GC: { views: {}, spiffPanel: () => '<div class="panel"></div>', todayStr: () => '2026-09-11' },
  };
  ctx.window.GC = ctx.GC;
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  if (!opts.spiffOff) {
    var prog = { vendor: 'Mule Extracts', name: 'Mule Extracts 2g Dank Tank Spiff', target: 7, people: [] };
    // SPIFF's own copy — the thing that decides which view the popup opens on.
    if (opts.copy) { prog.product = 'Live Resin Dank Tank | 2g'; prog.tips = ['Lead with the live resin']; }
    ctx.GC._kioskSpiff = { on: true, ok: true, programs: [prog], store: 'Century' };
  }
  const shown = () => nodes.kioskSpiffOverlay.classList.contains('show');
  return { ctx, nodes, state, GC: ctx.GC, shown };
}

const tests = {

  'THE FRAME IS WARM AT PAINT — the whole answer to "the data takes too long to load"': function () {
    const html = rso(URL_A, 'Century');
    ok('the iframe carries src in the kiosk markup itself', html.indexOf('src="' + URL_A + '"') > -1);
    ok('so it is NOT hidden, it is loading behind the closed popup', !/id="kioskSpiffFrame"[^>]*hidden/.test(html));
    ok('and our panel is the one held back', /id="kioskSpiffPanel"[^>]*hidden/.test(html));
    ok('the popup itself starts closed', html.indexOf('class="show"') === -1);
  },

  'no token: the markup holds no frame to load, and shows the panel instead': function () {
    const html = rso('', 'Century');
    ok('no src anywhere', html.indexOf('src="http') === -1);
    ok('frame hidden', /id="kioskSpiffFrame"[^>]*hidden/.test(html));
    ok('panel not hidden', !/id="kioskSpiffPanel"[^>]*hidden/.test(html));
  },

  'the popup is a card over a scrim, not a full-bleed takeover': function () {
    const html = rso(URL_A, 'Century');
    ok('a scrim that closes on tap', /class="kso-scrim" onclick="GC\.views\.closeSpiffBoard\(\)"/.test(html));
    ok('a window card inside it', html.indexOf('class="kso-win"') > -1);
    ok('announced as a dialog', html.indexOf('role="dialog"') > -1);
    ok('the store is named on it', html.indexOf('Century') > -1);
    ok('and a Close button', /kso-close[^>]*onclick="GC\.views\.closeSpiffBoard\(\)"/.test(html));
  },

  /* THE HANDOVER. SPIFF's product/tips are what Leaderboard cannot derive, so they decide which
     rendering the popup opens on — and no deploy flips it, the data does. */
  'WITHOUT SPIFF’s copy it frames their page — never a panel with the tips cut out': function () {
    const t = setup();                       // no product, no tips
    t.GC.views.openSpiffBoard();
    ok('SPIFF’s page', t.nodes.kioskSpiffFrame.hidden === false);
    ok('our panel held back', t.nodes.kioskSpiffPanel.hidden === true);
  },

  'WITH SPIFF’s copy it opens our panel instead, and never loads the frame': function () {
    const t = setup({ copy: true });
    t.GC.views.openSpiffBoard();
    ok('our panel', t.nodes.kioskSpiffPanel.hidden === false && t.nodes.kioskSpiffPanel.innerHTML !== '');
    ok('frame out of the way', t.nodes.kioskSpiffFrame.hidden === true);
  },

  'copy arriving on a 5-minute refresh swaps the view under someone already looking': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    ok('framed to begin with', t.nodes.kioskSpiffFrame.hidden === false);
    t.GC.views.applySpiffState({ spiffOn: true, spiffOk: true, spiffPrograms: [
      { vendor: 'Mule Extracts', name: 'Mule Extracts 2g Dank Tank Spiff', target: 7, people: [],
        product: 'Live Resin Dank Tank | 2g', tips: ['Lead with the live resin'] }] });
    ok('now our panel, without closing and reopening', t.nodes.kioskSpiffPanel.hidden === false);
    ok('frame stood down', t.nodes.kioskSpiffFrame.hidden === true);
  },

  'one tap opens SPIFF’s page, already loaded, with no panel of ours in the way': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    ok('popup shown', t.shown() === true);
    ok('on SPIFF’s page', t.nodes.kioskSpiffFrame.hidden === false);
    ok('which was never reloaded — same src it was warmed with',
       t.nodes.kioskSpiffFrame.getAttribute('src') === URL_A);
    ok('our panel stays out of it', t.nodes.kioskSpiffPanel.hidden === true);
    ok('and it was never even drawn', t.nodes.kioskSpiffPanel.innerHTML === '');
    ok('the clock is running', typeof t.state.tick === 'function');
  },

  'Include SPIFF off means the button opens nothing at all': function () {
    const t = setup({ spiffOff: true });
    t.GC.views.openSpiffBoard();
    ok('no popup', t.shown() === false);
    ok('no clock left running', t.state.tick === null);
  },

  'no token for this store falls back to our panel — the button always does something': function () {
    const t = setup({ url: '' });
    t.GC.views.openSpiffBoard();
    ok('popup shown', t.shown() === true);
    ok('on our panel', t.nodes.kioskSpiffPanel.hidden === false && t.nodes.kioskSpiffPanel.innerHTML !== '');
    ok('no frame', t.nodes.kioskSpiffFrame.hidden === true);
  },

  'closing leaves the frame LOADED — the next tap must be instant too': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    t.GC.views.closeSpiffBoard();
    ok('popup closed', t.shown() === false);
    ok('clock torn down', t.state.tick === null);
    ok('blur listener released', t.state.blurBound === 0);
    ok('but the page is still loaded', t.nodes.kioskSpiffFrame.getAttribute('src') === URL_A);
    t.GC.views.openSpiffBoard();
    ok('second tap opens the same warm frame', t.nodes.kioskSpiffFrame.getAttribute('src') === URL_A
       && t.shown() === true);
  },

  'SPIFF switched off in Settings mid-view closes the popup': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    t.GC.views.applySpiffState({ spiffOn: false });
    ok('closed', t.shown() === false);
  },

  'an engine that never sends spiffOn changes nothing — undefined is not off': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    t.GC.views.applySpiffState({});
    t.GC.views.applySpiffState({ spiffOn: true, spiffOk: true, spiffPrograms: [] });
    ok('still open on SPIFF’s page', t.shown() === true && t.nodes.kioskSpiffFrame.hidden === false);
  },

  'a rotated token re-warms the frame at once; a revoked one falls back to the panel': function () {
    const t = setup();
    t.GC.views.applySpiffLink(URL_B);
    ok('data-src moved', t.nodes.kioskSpiffOverlay.getAttribute('data-src') === URL_B);
    ok('and the frame followed IMMEDIATELY, not at the next open',
       t.nodes.kioskSpiffFrame.getAttribute('src') === URL_B && t.nodes.kioskSpiffFrame.hidden === false);

    t.GC.views.applySpiffLink('');          // revoke
    ok('frame dropped, not left on "this link is no longer active"',
       t.nodes.kioskSpiffFrame.getAttribute('src') === null && t.nodes.kioskSpiffFrame.hidden === true);
    ok('panel took over', t.nodes.kioskSpiffPanel.hidden === false);
  },

  'an absent link field is not a revoke — an older engine must not blank the frame': function () {
    const t = setup();
    t.GC.views.applySpiffLink(undefined);
    t.GC.views.applySpiffLink(null);
    ok('link untouched', t.nodes.kioskSpiffOverlay.getAttribute('data-src') === URL_A);
    ok('frame untouched', t.nodes.kioskSpiffFrame.getAttribute('src') === URL_A
       && t.nodes.kioskSpiffFrame.hidden === false);
  },

};

console.log('\nKiosk SPIFF popup — SPIFF’s store page, warm, over the board (index.html)\n');
Object.keys(tests).forEach((name) => { console.log(' ' + name); tests[name](); });
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
