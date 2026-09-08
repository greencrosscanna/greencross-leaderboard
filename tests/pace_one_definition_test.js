#!/usr/bin/env node
/* The kiosk and Director must show ONE pace number per store — GC.paceView in index.html.
 *
 * The bug this exists to prevent (reported 2026-09-08, from two screenshots taken the same
 * minute): River read −28% on the kiosk and −46% on the Director strip. Neither was wrong.
 * The kiosk printed today's DAMPED INTRADAY pace (pacedAgainstFloor_, dutchie_fetch.gs) while
 * Director printed PROJECTED END OF DAY vs the daily goal. Two honest answers to two different
 * questions, both labeled just "pace", on two screens of the same app.
 *
 * The kiosk also contradicted ITSELF, which is the part a manager actually catches: the big
 * −28% sat directly above "Short by $1,793", and $1,793 against a $4,155 goal is 43%. The two
 * stats under the gauge were end-of-day while the number over them was right-now.
 *
 * And the gauges disagreed even given one number: the kiosk mapped ±30% across the dial,
 * Director ±80%, so a projected −46% pinned the kiosk needle at the end stop where every
 * struggling store looked identically bad.
 *
 * Fixtures below are the REAL River figures off those screenshots, so the numbers this file
 * asserts are numbers that actually appeared on a screen in the store.
 *
 * Per tests/_harness.js's rule this NEVER reimplements: it lifts the real GC.paceView out of
 * the shipped index.html and runs it.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = src.match(/\nGC\.PACE_RANGE = [\s\S]*?\nGC\.paceView = function[\s\S]*?\n\};\n/);
if (!m) throw new Error('GC.paceView not found in index.html');
const ctx = { Math: Math, GC: {} };
vm.createContext(ctx);
vm.runInContext(m[0], ctx);
const paceView = ctx.GC.paceView;

let pass = 0, fail = 0;
const ok = (msg, c) => { c ? (pass++, console.log('  ok  ' + msg)) : (fail++, console.log('  FAIL ' + msg)); };

// ── River, 2026-09-08 10:33 AM ─────────────────────────────────────────────────────────────────
// Kiosk payload: revenue $301, goal $4,155, projected $2,362, damped pace −28%.
const KIOSK = { goal: 4155, projectedRevenue: 2362, pace: -0.275 };
// Director payload for the same store, ~2 min staler off its own cache: revenue $280.41,
// projected $2,235. Different revenue is EXPECTED (55s cache vs a 2-min trigger / 6-min TTL);
// what must not differ is which QUESTION the percentage answers.
const DIRECTOR = { goal: 4155, projected: 2235, projectedPace: -0.462, pace: -0.29 };

console.log('\nThe headline reconciles with the stats printed under it');
{
  const pv = paceView(KIOSK);
  // This is the assertion the old kiosk card failed. "Short by" is goal − projected.
  const shortBy = KIOSK.goal - KIOSK.projectedRevenue;             // 1793
  const impliedPct = -shortBy / KIOSK.goal;                        // −0.4315
  ok('headline equals short-by ÷ goal, the number beside it',
     Math.abs(pv.pct - impliedPct) < 0.0005);
  ok('headline reads −43%, not the old −28%', pv.str === '−43%');
  ok('and it is flagged as the projection', pv.isProjected === true);
  ok('title names which number this is', pv.title === 'Projected · vs. Plan');
  ok('sub-label carries the Proj. prefix', /^Proj\./.test(pv.sub));
}

console.log('\nKiosk and Director answer the same question');
{
  const k = paceView(KIOSK), d = paceView(DIRECTOR);
  ok('both show the projection, not one each way', k.isProjected && d.isProjected);
  ok('both title the card the same way', k.title === d.title);
  // Their inputs are minutes apart, so the values differ slightly — that is cache lag, not a
  // formula split. Before the fix these were 28 vs 46 points apart; now they track.
  ok('the two views land within 5 points of each other',
     Math.abs(k.pct - d.pct) < 0.05);
  ok('Director is unchanged by the fix — it was already right',
     d.str === '−46%');
}

console.log('\nOne gauge scale, so one number points one way');
{
  ok('the scale has a single home', ctx.GC.PACE_RANGE === 80);
  const deg = paceView(KIOSK).deg;
  ok('needle uses the shared ±80 range', deg === Math.round((-0.4315 * 100 / 80) * 90));
  ok('a projected −43% does NOT pin the needle', Math.abs(deg) < 90);
  // The old kiosk ±30 mapped anything past −30% to the hard stop.
  const pinnedOnOldScale = Math.round((Math.max(-30, -43.15) / 30) * 90);
  ok('the old ±30 scale would have pinned it', pinnedOnOldScale === -90);
}

console.log('\nBefore a projection exists, fall back to damped pace and say so');
{
  // endpoints.gs computes no projection until MIN_PROJ_HOURS (2) of sales.
  const early = paceView({ goal: 4155, projectedRevenue: 0, pace: -0.275 });
  ok('falls back to today\'s pace', Math.abs(early.pct - (-0.275)) < 1e-9);
  ok('not flagged as a projection', early.isProjected === false);
  ok('title says Pace', early.title === 'Pace · vs. Plan');
  ok('sub-label drops the Proj. prefix', !/Proj\./.test(early.sub));
}

console.log('\nEdges');
{
  ok('no goal → no projection, no divide by zero',
     paceView({ goal: 0, projectedRevenue: 2000, pace: 0.1 }).isProjected === false);
  ok('empty payload does not throw', paceView().str === '+0%');
  ok('a wild projection clamps to the end stop',
     Math.abs(paceView({ goal: 1000, projectedRevenue: 9000 }).deg) === 90);
  ok('ahead of plan reads green',
     paceView({ goal: 1000, projectedRevenue: 1400 }).zone === 'green');
  ok('near plan reads amber',
     paceView({ goal: 1000, projectedRevenue: 1050 }).zone === 'amber');
}

// ── The card's own bottom-row stats, rendered for real ─────────────────────────────────────────
// Pre-projection the kiosk used to print "$0 projected / short by $4,155" — the whole day's goal,
// at 9am, on a store trading normally. Both came from a projection of 0 the backend never sent.
console.log('\nBottom-row stats never invent a projection');
{
  function grab(name) {
    const m = src.match(new RegExp('\\n  function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n'));
    if (!m) throw new Error('not found in index.html: ' + name);
    return m[0];
  }
  const c = { Math: Math, e: (x) => String(x == null ? '' : x), GC: ctx.GC,
              fmtDollars: (n) => '$' + Math.round(n).toLocaleString('en-US') };
  vm.createContext(c);
  vm.runInContext(grab('renderPaceCard'), c);

  const withProj = c.renderPaceCard(KIOSK);
  ok('headline reconciles with the short-by printed beside it',
     /kioskPacePct">−43%/.test(withProj) && /kioskPaceShortBy">\$1,793/.test(withProj));
  ok('title names which number this is', /kioskPaceTitle">Projected · vs\. Plan/.test(withProj));

  const early = c.renderPaceCard({ goal: 4155, projectedRevenue: 0, pace: -0.275 });
  ok('projected slot dashes rather than printing $0', /kioskPaceProjVal">—/.test(early));
  ok('short-by dashes rather than claiming the whole goal',
     /kioskPaceShortBy">—/.test(early) && !/\$4,155/.test(early));
  ok('headline falls back to the damped pace', /kioskPacePct">−28%/.test(early));
  ok('title says Pace, not Projected', /kioskPaceTitle">Pace · vs\. Plan/.test(early));
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' : '✅ pace one-definition ALL PASS ') + (pass + fail));
process.exit(fail ? 1 : 0);
