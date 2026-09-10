#!/usr/bin/env node
/* The once-per-login "What's New" popup — GC.checkWhatsNew in index.html.
 *
 * Sky, 2026-09-10: "the staff doesn't need to see the version notes at the kiosk level." The notes
 * are fetched on every route and re-run checkWhatsNew when they land, so a store kiosk signed in with
 * a director's login painted the release-notes popup over the board — on a wall screen nobody is
 * standing at to dismiss. Wall screens (#/store/<slug>, #/sky) must never show it; the director
 * dashboard still must, and skipping a wall screen must not use up the once-per-login check.
 *
 * Per tests/_harness.js's rule this NEVER reimplements: it lifts the real GC.WALL_ROUTE and
 * GC.checkWhatsNew out of the shipped index.html and runs them.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const block = src.match(/\nGC\.WALL_ROUTE = [^\n]*\nGC\.checkWhatsNew = function\(\) \{[\s\S]*?\n\};\n/);
if (!block) throw new Error('GC.WALL_ROUTE + GC.checkWhatsNew not found in index.html');

let pass = 0, fail = 0;
const ok = (m, c) => { c ? (pass++, console.log('  ok  ' + m)) : (fail++, console.log('  FAIL ' + m)); };

function setup(hash, role, seen) {
  const shown = [];
  const store = { gc_wn_seen_performance: seen || '' };
  const ctx = {
    window: { location: { hash: hash } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    GC: {
      auth: { load: () => (role ? { role: role } : null) },
      CHANGELOG: [{ v: 'v1.763', items: ['a'] }, { v: 'v1.761', items: ['b'] }],
      _verGt: (a, b) => {
        const p = (x) => String(x || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
        const x = p(a), y = p(b);
        for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
        return false;
      },
      showChangelog: (entries, isWn) => shown.push({ entries, isWn }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(block[0], ctx);
  return { ctx, shown };
}

console.log('\nWall screens never show it');
['#/store/baseline', '#/store/river', '#/sky'].forEach(function (h) {
  const { ctx, shown } = setup(h, 'director');
  ctx.GC.checkWhatsNew();
  ok('director on ' + h + ' → no popup', shown.length === 0);
  ok('director on ' + h + ' → once-per-login check NOT used up', !ctx.GC._wnChecked);
});

console.log('\nA person using the app still gets it');
{
  const { ctx, shown } = setup('#/director', 'director');
  ctx.GC.checkWhatsNew();
  ok('director dashboard → popup shows', shown.length === 1 && shown[0].isWn === true);
  ok('shows both unseen releases', shown.length === 1 && shown[0].entries.length === 2);
}
{
  const { ctx, shown } = setup('#/store/baseline', 'owner');
  ctx.GC.checkWhatsNew();
  ok('owner on a kiosk → no popup', shown.length === 0);
  ctx.window.location.hash = '#/director';
  ctx.GC.checkWhatsNew();
  ok('same session backs out to the dashboard → popup shows there', shown.length === 1);
}
{
  const { ctx, shown } = setup('#/settings', 'director');
  ctx.GC.checkWhatsNew();
  ok('settings is not a wall screen → popup shows', shown.length === 1);
}

console.log('\nUnchanged rules');
{
  const { ctx, shown } = setup('#/director', 'store_manager');
  ctx.GC.checkWhatsNew();
  ok('store manager never gets it', shown.length === 0);
}
{
  const { ctx, shown } = setup('#/director', 'director', 'v1.763');
  ctx.GC.checkWhatsNew();
  ok('nothing unseen → no popup', shown.length === 0);
}
{
  const { ctx } = setup('#/standings', 'director');
  ok('route matcher does not swallow #/standings', !ctx.GC.WALL_ROUTE.test('#/standings'));
  ok('route matcher does not swallow #/storefront', !ctx.GC.WALL_ROUTE.test('#/storefront'));
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' : 'passed ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);
