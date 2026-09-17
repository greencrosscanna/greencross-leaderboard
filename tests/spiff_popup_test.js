#!/usr/bin/env node
/* The kiosk SPIFF button — the popup in index.html (renderSpiffOverlay + GC.views.openSpiffBoard).
 *
 * Sky, 2026-09-11: "the spiff button should open the store specific SPIFF link supplied by SPIFF,
 * with the addition of the staff level progress… I'm saying pop up, but maybe that's being blocked,
 * what about an overlay that is acting like a popup." So it is a card this page DRAWS, never
 * window.open, which a kiosk browser blocks.
 *
 * THE POPUP HAS EXACTLY ONE VIEW NOW: Leaderboard's own board. It used to frame SPIFF's
 * `store.html?t=<token>` and hand over to our panel once SPIFF published enough copy, which meant
 * the view was chosen in three places — the markup's default, openSpiffBoard, and applySpiffLink.
 * Sky's decision of 2026-09-16 made the panel the destination, and on 2026-09-17 he caught what the
 * leftover frame still cost: a full re-render while the popup was OPEN (checkRemoteRefresh →
 * renderKiosk) repainted the overlay in its frame-first default and put SPIFF's page on the wall
 * mid-read. It read as "the layout went wrong" only because SPIFF's page is built from the same
 * handoff — the visible tells were their vendor-prefixed title and their full names.
 *
 * So what these lock down, on a WALL SCREEN with nobody standing at it:
 *
 *   1. ONE VIEW, AND NO WAY BACK TO TWO. The overlay markup must contain no second rendering, and
 *      the panel must never be painted hidden. This is the regression guard: the bug was not a bad
 *      branch, it was a SECOND VIEW existing at all, and a repaint choosing it.
 *
 *   2. A POPUP THAT OUTLIVES THE BOARD. The two-minute auto-close is why the kiosk comes back on
 *      its own. It has to fire, and it has to fire when Include SPIFF is switched off mid-view.
 *
 *   3. A BUTTON THAT DOES NOTHING. Include SPIFF is the one switch for the button, so whenever it
 *      is on the button must open a drawn board — with or without a token, which no longer has any
 *      say in what the kiosk shows.
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
const rsoStart = src.indexOf('  function renderSpiffOverlay(storeName) {');
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

function setup(opts) {
  opts = opts || {};
  const nodes = { kioskSpiffOverlay: el('kioskSpiffOverlay'), kioskSpiffPanel: el('kioskSpiffPanel'),
                  kioskSpiffAuto: el('kioskSpiffAuto') };

  const state = { tick: null, blurBound: 0 };
  const win = { addEventListener(ev) { if (ev === 'blur') state.blurBound++; },
                removeEventListener(ev) { if (ev === 'blur') state.blurBound--; } };
  let painted = 0;
  const ctx = {
    window: win, console: console,
    setInterval: (fn) => { state.tick = fn; return 1; }, clearInterval: () => { state.tick = null; },
    document: { getElementById: (id) => nodes[id] || null, querySelector: () => null },
    GC: { views: {}, spiffPanel: () => { painted++; return '<div class="panel">board ' + painted + '</div>'; },
          todayStr: () => '2026-09-17' },
  };
  ctx.window.GC = ctx.GC;
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  if (!opts.spiffOff) {
    var prog = { vendor: 'Mule Extracts', name: 'Mule Extracts 2g Dank Tank Spiff', target: 7, people: [],
                 product: 'Live Resin Dank Tank | 2g', tips: ['Lead with the live resin'] };
    if (opts.noCopy) { delete prog.product; delete prog.tips; }
    ctx.GC._kioskSpiff = { on: true, ok: true, programs: [prog], store: 'Century', slug: 'century' };
  }
  const shown = () => nodes.kioskSpiffOverlay.classList.contains('show');
  return { ctx, nodes, state, GC: ctx.GC, shown, paints: () => painted };
}

const tests = {

  /* THE REGRESSION GUARD. Sky, 2026-09-17: "after 60 seconds on screen, it reloaded the contents
     and then the layout was wrong." The overlay's own markup was the culprit — it painted SPIFF's
     framed page whenever the store had a token, and every repaint restored that default under
     somebody who was reading our board. There must be nothing else in here to restore. */
  'THE MARKUP HAS ONE VIEW — a repaint cannot put anything else on screen': function () {
    const html = rso('Century');
    ok('no iframe', html.indexOf('<iframe') === -1 && html.indexOf('kioskSpiffFrame') === -1);
    ok('no SPIFF page URL anywhere', html.indexOf('store.html') === -1 && html.indexOf('src="http') === -1);
    ok('no token cached on the overlay', html.indexOf('data-src') === -1);
    ok('and our panel is NOT painted hidden — that was the whole bug',
       !/id="kioskSpiffPanel"[^>]*hidden/.test(html));
    ok('the popup itself still starts closed', html.indexOf('class="show"') === -1);
  },

  /* The same thing from the other side: the render takes no url, so there is no token for a future
     tidy-up to reintroduce a branch on. */
  'renderSpiffOverlay takes only the store name': function () {
    ok('one parameter', /function renderSpiffOverlay\(storeName\)/.test(rsoSrc));
    /* Comments out first: the block's own prose names both removed functions to explain why they
       went, so a raw grep reads the tombstone as the body. Second time that trap has been hit in
       this pass — a CSS guard on the popup window did the same thing an hour earlier. */
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('and no link plumbing survives in the popup block',
       code.indexOf('applySpiffLink') === -1 && code.indexOf('spiffPanelHasSpiffCopy_') === -1);
  },

  'the popup is a card over a scrim, not a full-bleed takeover': function () {
    const html = rso('Century');
    ok('a scrim that closes on tap', /class="kso-scrim" onclick="GC\.views\.closeSpiffBoard\(\)"/.test(html));
    ok('a window card inside it', html.indexOf('class="kso-win"') > -1);
    ok('announced as a dialog', html.indexOf('role="dialog"') > -1);
    ok('the store is named on it', html.indexOf('Century') > -1);
    ok('and a Close button', /kso-close[^>]*onclick="GC\.views\.closeSpiffBoard\(\)"/.test(html));
  },

  'one tap draws our board, painted fresh': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    ok('popup shown', t.shown() === true);
    ok('board drawn', t.nodes.kioskSpiffPanel.innerHTML.indexOf('board') > -1);
    ok('not hidden', t.nodes.kioskSpiffPanel.hidden === false);
    ok('the clock is running', typeof t.state.tick === 'function');
  },

  /* A program with no product and no tips used to send the popup to SPIFF's page instead. There is
     nowhere else to go now, so a thin program is drawn thin rather than handed off. */
  'a program SPIFF has published no copy for still opens our board': function () {
    const t = setup({ noCopy: true });
    t.GC.views.openSpiffBoard();
    ok('popup shown', t.shown() === true);
    ok('our board, not somebody else\'s page', t.nodes.kioskSpiffPanel.innerHTML.indexOf('board') > -1);
  },

  'every open repaints — never numbers from before a pay-period boundary': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    const first = t.nodes.kioskSpiffPanel.innerHTML;
    t.GC.views.closeSpiffBoard();
    t.GC.views.openSpiffBoard();
    ok('drawn again on the second tap', t.nodes.kioskSpiffPanel.innerHTML !== first);
    ok('and it is still our board', t.nodes.kioskSpiffPanel.innerHTML.indexOf('board') > -1);
  },

  'a 5-minute refresh repaints under someone already looking': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    const before = t.nodes.kioskSpiffPanel.innerHTML;
    t.GC.views.applySpiffState({ spiffOn: true, spiffOk: true, spiffPrograms: [
      { vendor: 'Mule Extracts', name: 'Mule Extracts 2g Dank Tank Spiff', target: 9, people: [],
        product: 'Live Resin Dank Tank | 2g', tips: ['Lead with the live resin'] }] });
    ok('new numbers under their eyes', t.nodes.kioskSpiffPanel.innerHTML !== before);
    ok('still visible', t.nodes.kioskSpiffPanel.hidden === false && t.shown() === true);
  },

  'a refresh while CLOSED paints nothing and leaves the popup shut': function () {
    const t = setup();
    const paintsBefore = t.paints();
    t.GC.views.applySpiffState({ spiffOn: true, spiffOk: true, spiffPrograms: [] });
    ok('no wasted paint', t.paints() === paintsBefore);
    ok('still closed', t.shown() === false);
  },

  'Include SPIFF off means the button opens nothing at all': function () {
    const t = setup({ spiffOff: true });
    t.GC.views.openSpiffBoard();
    ok('no popup', t.shown() === false);
    ok('no clock left running', t.state.tick === null);
  },

  'closing tears down the clock and the listener': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    t.GC.views.closeSpiffBoard();
    ok('popup closed', t.shown() === false);
    ok('clock torn down', t.state.tick === null);
    ok('blur listener released', t.state.blurBound === 0);
  },

  /* The auto-close is why a wall screen comes back on its own — a popup nobody can dismiss is the
     board gone for the shift. */
  'the countdown runs down and closes the popup by itself': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    ok('a countdown is shown, not a silent timer', t.nodes.kioskSpiffAuto.textContent.indexOf('Closing in') === 0);
    for (let i = 0; i < 200 && t.shown(); i++) t.state.tick && t.state.tick();
    ok('it closed on its own', t.shown() === false);
  },

  'any touch restarts the clock — somebody still reading is not shut out mid-sentence': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    for (let i = 0; i < 30; i++) t.state.tick();
    t.GC.views.keepSpiffBoardOpen();
    for (let i = 0; i < 100 && t.shown(); i++) t.state.tick();
    ok('still open well past where it would have closed', t.shown() === true);
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
    ok('still open on our board', t.shown() === true && t.nodes.kioskSpiffPanel.hidden === false);
  },

};

console.log('\nKiosk SPIFF popup — Leaderboard\'s own board, drawn over the kiosk (index.html)\n');
Object.keys(tests).forEach((name) => { console.log(' ' + name); tests[name](); });
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
