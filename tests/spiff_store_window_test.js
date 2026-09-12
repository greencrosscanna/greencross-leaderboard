#!/usr/bin/env node
/* The kiosk SPIFF button — GC.views.openSpiffBoard and friends in index.html.
 *
 * Sky, 2026-09-11: "The SPIFF button on kiosk should open the Store page in a popup, not the
 * leaderboard SPIFF page." So the button opens SPIFF's own per-store page in its own window, and
 * Leaderboard's panel — which was the front door for exactly one day — is now only what a store
 * with no kiosk token gets.
 *
 * Everything here is about a WALL SCREEN: no browser chrome, nobody standing at it, and the board
 * behind it is the most visible surface in the company.
 *
 *   1. A WINDOW THAT OUTLIVES THE BOARD. The two-minute auto-close exists so the kiosk comes back
 *      on its own. A window left standing is that guarantee deleted — and with the panel gone from
 *      the front door there is no overlay behind it carrying a Close button either. It has to close
 *      on the countdown, and when SPIFF is switched off in Settings mid-view.
 *
 *   2. A BUTTON THAT DOES NOTHING. window.open returns null when a browser refuses it, and a store
 *      may have no token at all. Neither may end in a tap that visibly does nothing.
 *
 *   3. A SECOND WINDOW PER TAP. Staff tap a kiosk more than once, and a second window is one more
 *      thing nobody on the floor can close.
 *
 * Per tests/_harness.js's rule this NEVER reimplements: it lifts the real block out of the shipped
 * index.html and runs it.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('var KIOSK_SPIFF_AUTOCLOSE_S');
const end   = src.indexOf('GC.views.renderKiosk = function(slug)');
if (start < 0 || end < 0 || end <= start) throw new Error('kiosk SPIFF block not found in index.html');
const block = src.slice(start, end);
if (!/window\.open\(/.test(block)) throw new Error('the SPIFF button no longer calls window.open');

let pass = 0, fail = 0;
const ok = (m, c) => { c ? (pass++, console.log('  ok  ' + m)) : (fail++, console.log('  FAIL ' + m)); };

/* A DOM thin enough to read and real enough to be wrong where the browser would be: `hidden` is a
   property, attributes are a bag, elements are found by id. */
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
  const state = { tick: null, blurBound: 0 };
  const win = {
    addEventListener(ev) { if (ev === 'blur') state.blurBound++; },
    removeEventListener(ev) { if (ev === 'blur') state.blurBound--; },
    open(u, name, feat) {
      if (opts.blocked) { opened.push({ url: u, name: name, feat: feat, win: null }); return null; }
      const w = { closed: false, focused: 0, location: { href: u, replace(x) { w.location.href = x; } },
                  focus() { w.focused++; }, close() { w.closed = true; } };
      opened.push({ url: u, name: name, feat: feat, win: w });
      return w;
    },
  };
  const ctx = {
    window: win, screen: { availWidth: 1920, availHeight: 1080 }, console: console,
    setInterval: (fn) => { state.tick = fn; return 1; }, clearInterval: () => { state.tick = null; },
    document: { getElementById: (id) => nodes[id] || null, querySelector: () => null },
    GC: { views: {}, spiffPanel: () => '<div class="panel"></div>', todayStr: () => '2026-09-11' },
  };
  ctx.window.GC = ctx.GC;
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  // Include SPIFF — the ONE switch for this button. The block seeds it off; the kiosk render fills
  // it from the payload. Set it the way a real render would, unless a case is testing the switch.
  if (!opts.spiffOff) ctx.GC._kioskSpiff = { on: true, ok: true, programs: [{ vendor: 'Mule Extracts',
    program: 'Mule Extracts 2g Dank Tank Spiff', target: 7, people: [] }], store: 'Century' };
  const shown = () => nodes.kioskSpiffOverlay.classList.contains('show');
  return { ctx, nodes, opened, state, GC: ctx.GC, shown };
}

const tests = {

  'one tap opens SPIFF’s page in a window, and shows nothing of ours behind it': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    ok('a window opened', t.opened.length === 1);
    ok('at the store’s link', t.opened[0].url === URL_A);
    ok('named, so a second tap can find it', !!t.opened[0].name);
    ok('sized — a window over the board, not a tab behind it', /width=\d+/.test(t.opened[0].feat || ''));
    ok('NOT noopener: Chrome nulls the handle and every open would read as blocked',
       !/noopener/.test(t.opened[0].feat || ''));
    ok('NO overlay behind it — closing the window lands back on the board', t.shown() === false);
    ok('and Leaderboard’s panel was never drawn', t.nodes.kioskSpiffPanel.innerHTML === '');
    ok('the clock is running', typeof t.state.tick === 'function');
  },

  'Include SPIFF off means the button opens nothing at all': function () {
    const t = setup({ spiffOff: true });
    t.GC.views.openSpiffBoard();
    ok('no window', t.opened.length === 0);
    ok('no overlay', t.shown() === false);
    ok('no clock left running', t.state.tick === null);
  },

  'a second tap raises the window it already opened, it does not mint another': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    t.GC.views.openSpiffBoard();
    t.GC.views.openSpiffBoard();
    ok('still one window', t.opened.length === 1);
    ok('and it was raised', t.opened[0].win.focused >= 2);
  },

  'THE AUTO-CLOSE TAKES THE WINDOW — nothing else can, on a wall screen': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    const w = t.opened[0].win;
    ok('open to begin with', w.closed === false);
    t.GC.views.closeSpiffBoard();
    ok('the window was closed with the board', w.closed === true);
    ok('the clock was torn down', t.state.tick === null);
    ok('and the blur listener with it', t.state.blurBound === 0);
  },

  'SPIFF switched off in Settings mid-view closes the window too': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    const w = t.opened[0].win;
    // The overlay is not shown in the window case, so anything asking the DOM "is the board open"
    // answers no here and would leave this window standing. That is the bug this covers.
    t.GC.views.applySpiffState({ spiffOn: false });
    ok('window closed', w.closed === true);
  },

  'an engine that never sends spiffOn changes nothing — undefined is not off': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    const w = t.opened[0].win;
    t.GC.views.applySpiffState({});
    t.GC.views.applySpiffState({ spiffOn: true, spiffOk: true, spiffPrograms: [] });
    ok('window left alone', w.closed === false);
  },

  'a window closed by hand stops the clock, and the next tap opens a fresh one': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    const w = t.opened[0].win;
    w.closed = true;                 // somebody closed it themselves
    t.state.tick();                  // the next second
    ok('clock torn down', t.state.tick === null);
    t.GC.views.openSpiffBoard();
    ok('a fresh window, not the dead handle', t.opened.length === 2);
    ok('and the new one is still open', t.opened[1].win.closed === false);
    ok('its clock is running', typeof t.state.tick === 'function');
  },

  'a BLOCKED popup falls back to SPIFF’s page in the frame — not to our panel': function () {
    const t = setup({ blocked: true });
    t.GC.views.openSpiffBoard();
    ok('it did try the window', t.opened.length === 1);
    ok('overlay shown instead', t.shown() === true);
    ok('on SPIFF’s page', t.nodes.kioskSpiffFrame.hidden === false
       && t.nodes.kioskSpiffFrame.getAttribute('src') === URL_A);
    ok('our panel is behind it, not in front', t.nodes.kioskSpiffPanel.hidden === true);
    ok('and the bar says how to get back', t.nodes.kioskSpiffPage.textContent === 'Back to the list');
  },

  'no token for this store falls back to our panel — the button always does something': function () {
    const t = setup({ url: '' });
    t.GC.views.openSpiffBoard();
    ok('no window', t.opened.length === 0);
    ok('overlay shown', t.shown() === true);
    ok('on our panel', t.nodes.kioskSpiffPanel.hidden === false && t.nodes.kioskSpiffPanel.innerHTML !== '');
    ok('no frame loaded', t.nodes.kioskSpiffFrame.hidden === true);
  },

  'a rotated token reaches the open window; a revoked one closes it': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    const w = t.opened[0].win;
    t.GC.views.applySpiffLink(URL_B);
    ok('data-src moved', t.nodes.kioskSpiffOverlay.getAttribute('data-src') === URL_B);
    ok('the OPEN window followed the rotation in place', w.location.href === URL_B);
    ok('without opening a second one', t.opened.length === 1);

    t.GC.views.applySpiffLink('');          // revoke
    ok('closed, not left on "this link is no longer active"', w.closed === true);
  },

  'an absent link field is not a revoke — an older engine must not close the window': function () {
    const t = setup();
    t.GC.views.openSpiffBoard();
    const w = t.opened[0].win;
    t.GC.views.applySpiffLink(undefined);
    t.GC.views.applySpiffLink(null);
    ok('link untouched', t.nodes.kioskSpiffOverlay.getAttribute('data-src') === URL_A);
    ok('window left alone', w.closed === false && w.location.href === URL_A);
  },

};

console.log('\nKiosk SPIFF button opens SPIFF’s store page in a window (index.html)\n');
Object.keys(tests).forEach((name) => { console.log(' ' + name); tests[name](); });
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
