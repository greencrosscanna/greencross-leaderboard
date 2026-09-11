#!/usr/bin/env node
/* SPIFF's store page opening in its own WINDOW from the kiosk — GC.views.showSpiffStorePage and
 * GC.views.closeSpiffBoard in index.html.
 *
 * Sky, 2026-09-11: "I'm expecting it to open a popup window." The button used to swap SPIFF's page
 * into a frame inside the overlay; it now opens a real window over the board.
 *
 * A window is a different shape of risk from a frame, and all three of these are about the kiosk —
 * a wall-mounted screen with no browser chrome and nobody standing at it:
 *
 *   1. A WINDOW THAT OUTLIVES THE BOARD. The overlay closes itself after two minutes for one
 *      reason: the most visible screen in the company must come back on its own. A popup left
 *      standing when the overlay goes is that guarantee quietly deleted — the board is still gone,
 *      and now there is no countdown and no Close button anywhere on the screen.
 *
 *   2. A BUTTON THAT DOES NOTHING. window.open returns null when it is refused, and a kiosk browser
 *      configured against popups will refuse it. Returning there leaves a gold button on a wall
 *      screen that visibly does nothing when tapped — which is the complaint this whole path
 *      started from. A blocked popup must fall back to the frame.
 *
 *   3. A SECOND WINDOW PER TAP. Staff tap a kiosk more than once. A second window is one more thing
 *      nobody on the floor can close.
 *
 * Per tests/_harness.js's rule this NEVER reimplements: it lifts the real block out of the shipped
 * index.html and runs it.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('var KIOSK_SPIFF_AUTOCLOSE_S');
const end   = src.indexOf('GC.views.renderKiosk = function(slug)');
if (start < 0 || end < 0 || end <= start) throw new Error('kiosk SPIFF overlay block not found in index.html');
const block = src.slice(start, end);
if (!/window\.open\(/.test(block)) throw new Error('showSpiffStorePage no longer calls window.open');

let pass = 0, fail = 0;
const ok = (m, c) => { c ? (pass++, console.log('  ok  ' + m)) : (fail++, console.log('  FAIL ' + m)); };

/* A DOM thin enough to read and real enough to be wrong in the same places the browser would be:
   `hidden` is a property, attributes are a bag, and elements are found by id. */
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
  const nodes = { kioskSpiffOverlay: el('kioskSpiffOverlay'), kioskSpiffPanel: el('kioskSpiffPanel'),
                  kioskSpiffFrame: el('kioskSpiffFrame'), kioskSpiffPage: el('kioskSpiffPage'),
                  kioskSpiffAuto: el('kioskSpiffAuto') };
  nodes.kioskSpiffOverlay.setAttribute('data-src', opts.url === undefined ? URL_A : opts.url);
  nodes.kioskSpiffFrame.hidden = true;

  const opened = [];
  const win = {
    addEventListener() {}, removeEventListener() {},
    open(u, name, feat) {
      if (opts.blocked) { opened.push({ url: u, name: name, feat: feat, win: null }); return null; }
      const w = { closed: false, focused: 0, location: { href: u, replace(x) { w.location.href = x; } },
                  focus() { w.focused++; }, close() { w.closed = true; } };
      opened.push({ url: u, name: name, feat: feat, win: w });
      return w;
    },
  };
  const ctx = {
    window: win, screen: { availWidth: 1920, availHeight: 1080 },
    setInterval: () => 1, clearInterval: () => {}, console: console,
    document: { getElementById: (id) => nodes[id] || null, querySelector: () => null },
    GC: { views: {}, spiffPanel: () => '<div class="panel"></div>', todayStr: () => '2026-09-11' },
  };
  ctx.window.GC = ctx.GC;
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  return { ctx: ctx, nodes: nodes, opened: opened, GC: ctx.GC };
}

const tests = {

  'the button opens a real window at the store link, once per board': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    t.GC.views.showSpiffStorePage();
    ok('window.open called', t.opened.length === 1);
    ok('at the configured link', t.opened[0] && t.opened[0].url === URL_A);
    ok('named, so a second tap can find it', !!(t.opened[0] && t.opened[0].name));
    ok('sized — a window over the board, not a tab behind it', /width=\d+/.test((t.opened[0] || {}).feat || ''));
    ok('NOT noopener: Chrome nulls the handle and every open would read as blocked',
       !/noopener/.test((t.opened[0] || {}).feat || ''));
    ok('the frame stays out of it', t.nodes.kioskSpiffFrame.hidden === true);
    ok('the panel is still behind it', t.nodes.kioskSpiffPanel.hidden === false);
  },

  'a second tap raises the window it already opened, it does not mint another': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    t.GC.views.showSpiffStorePage();
    t.GC.views.showSpiffStorePage();
    t.GC.views.showSpiffStorePage();
    ok('still one window', t.opened.length === 1);
  },

  'THE BOARD COMING BACK TAKES THE WINDOW WITH IT — the auto-close guarantee': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    t.GC.views.showSpiffStorePage();
    const w = t.opened[0].win;
    ok('the window is open to begin with', w.closed === false);
    t.GC.views.closeSpiffBoard();
    ok('overlay closed', t.nodes.kioskSpiffOverlay.classList.contains('show') === false);
    ok('AND the window was closed with it', w.closed === true);
    // The handle is private to the block, so also assert through behavior: opening again must open
    // a NEW window rather than try to raise the dead one.
    t.GC.views.openSpiffBoard();
    t.GC.views.showSpiffStorePage();
    ok('a window opened after the close is a new one, not the dead handle', t.opened.length === 2);
  },

  'a BLOCKED popup falls back to the frame — never a button that does nothing': function () {
    const t = setup({ blocked: true });
    t.GC.views.openSpiffBoard();
    t.GC.views.showSpiffStorePage();
    ok('it did try the window', t.opened.length === 1);
    ok('frame shown instead', t.nodes.kioskSpiffFrame.hidden === false);
    ok('frame points at the link', t.nodes.kioskSpiffFrame.getAttribute('src') === URL_A);
    ok('panel hidden behind it', t.nodes.kioskSpiffPanel.hidden === true);
    ok('and the button says how to get back', t.nodes.kioskSpiffPage.textContent === 'Back to the list');
  },

  'no link configured opens nothing at all — no window, no frame': function () {
    const t = setup({ url: '' });
    t.GC.views.openSpiffBoard();
    t.GC.views.showSpiffStorePage();
    ok('no window', t.opened.length === 0);
    ok('no frame', t.nodes.kioskSpiffFrame.hidden === true);
  },

  'a rotated token reaches the open window; a revoked one closes it': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    t.GC.views.showSpiffStorePage();
    const w = t.opened[0].win;
    t.GC.views.applySpiffLink(URL_B);
    ok('data-src moved', t.nodes.kioskSpiffOverlay.getAttribute('data-src') === URL_B);
    ok('the OPEN window followed the rotation in place', w.location.href === URL_B);
    t.GC.views.showSpiffStorePage();
    ok('still the same window, no second one', t.opened.length === 1);

    t.GC.views.applySpiffLink('');          // revoke
    ok('button hidden when the store loses its link', t.nodes.kioskSpiffPage.hidden === true);
    ok('and the window is closed, not left on "this link is no longer active"', w.closed === true);
    t.GC.views.showSpiffStorePage();
    ok('nothing opens on a revoked link', t.opened.length === 1);
  },

  'an absent field is not a revoke — an older engine must not close the window': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    t.GC.views.showSpiffStorePage();
    const w = t.opened[0].win;
    t.GC.views.applySpiffLink(undefined);
    t.GC.views.applySpiffLink(null);
    ok('link untouched', t.nodes.kioskSpiffOverlay.getAttribute('data-src') === URL_A);
    ok('window left alone', w.closed === false && w.location.href === URL_A);
    t.GC.views.showSpiffStorePage();
    ok('still the one we had', t.opened.length === 1);
  },

};

console.log('\nSPIFF store page opens in its own window (index.html)\n');
Object.keys(tests).forEach((name) => { console.log(' ' + name); tests[name](); });
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
