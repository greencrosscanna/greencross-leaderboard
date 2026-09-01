#!/usr/bin/env node
/* Pace damping — pacedAgainstFloor_ / PACE_FLOOR_FRAC in dutchie_fetch.gs.
 *
 * The problem: pace is (sales so far − expected so far) / expected so far, and before midday the
 * divisor is a rounding error. Center's REAL curve, pulled live from GX Core's expected_frac on
 * 2026-09-01, expects only 4.19% of the day done by 10:00 — a $335 bar on an $8,000 goal — so one
 * $270 order over an ordinary morning read as +81% on the kiosk every staff member watches. It cut
 * the other way too: a store with no 9am customer read −100%. Nothing was miscalculated; the base
 * was nearly nothing. (Sky, 2026-09-01: "is Center St really +80%, seems way off".)
 *
 * What must stay true, and is the whole reason this file exists:
 *   · the NUMERATOR is untouched — a store that is ahead must never read behind;
 *   · the floor UNBINDS on its own, so afternoons are bit-for-bit the old number;
 *   · it is symmetric — it damps a terrible morning exactly as much as a great one.
 *
 * Per tests/_harness.js's rule this never reimplements: it loads the shipped .gs and calls the
 * real function.
 */
'use strict';
const { load } = require('./_harness');

const ctx = load(['dutchie_fetch.gs']);
const paced = ctx.pacedAgainstFloor_;
const FLOOR = ctx.PACE_FLOOR_FRAC;

let pass = 0, fail = 0;
const ok = (m, c) => { c ? (pass++, console.log('  ok  ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.005 : tol);

// Center's real DOW-weighted curve (GX Core expected_frac, 2026-09-01). Not invented.
const CENTER = { 8: 0, 9: 0.0165, 10: 0.0419, 11: 0.0889, 12: 0.1614,
                 13: 0.2429, 14: 0.3136, 15: 0.3865, 16: 0.4749, 17: 0.5662 };
const GOAL = 8000;
const bar = (h) => GOAL * CENTER[h];

console.log('\nThe floor itself');
ok('is 20% of the day, as chosen', FLOOR === 0.20);

console.log('\nCenter at 10am — the case that started this');
{
  const sales = 605;                       // an ordinary morning plus one $270 order
  const undamped = (sales - bar(10)) / bar(10);
  ok('undamped really was about +81%', near(undamped, 0.81, 0.01));
  ok('damped reads about +17%', near(paced(sales, bar(10), GOAL), 0.17, 0.01));
  ok('still reads AHEAD, not behind', paced(sales, bar(10), GOAL) > 0);
  ok('damped is strictly smaller in magnitude', paced(sales, bar(10), GOAL) < undamped);
}

console.log('\nSymmetry — a bad morning is damped the same as a good one');
{
  const quiet = 65;                        // well under the $335 bar
  const d = paced(quiet, bar(10), GOAL);
  ok('a quiet morning still reads BEHIND', d < 0);
  ok('but nowhere near −100%', d > -0.20);
  // Mirror a gap of +X and −X about the bar: the damped magnitudes must match exactly.
  const up   = paced(bar(10) + 400, bar(10), GOAL);
  const down = paced(bar(10) - 400, bar(10), GOAL);
  ok('equal and opposite gaps damp to equal and opposite numbers', near(up, -down, 1e-9));
}

console.log('\nThe floor unbinds — afternoons are untouched');
{
  [13, 14, 15, 16, 17].forEach(function (h) {
    const sales = bar(h) * 1.08;           // 8% ahead, whatever the hour
    const exact = (sales - bar(h)) / bar(h);
    ok(h + ':00 is the exact undamped pace', near(paced(sales, bar(h), GOAL), Math.round(exact * 1000) / 1000, 1e-9));
  });
  ok('the floor binds at 12:00 (day is ' + (CENTER[12] * 100).toFixed(1) + '% in)', CENTER[12] < FLOOR);
  ok('the floor is released by 13:00 (day is ' + (CENTER[13] * 100).toFixed(1) + '% in)', CENTER[13] > FLOOR);
}

console.log('\nEdges');
{
  ok('no daily goal → unchanged behavior, not a divide by the floor',
     near(paced(500, 400, 0), (500 - 400) / 400, 1e-9));
  ok('nothing to divide by at all → 0, never NaN or Infinity', paced(0, 0, 0) === 0);
  ok('open with zero sales and a real goal is finite',
     Number.isFinite(paced(0, 0, GOAL)) && paced(0, 0, GOAL) === 0);
  ok('exactly on the bar reads 0', paced(bar(15), bar(15), GOAL) === 0);
  ok('result is rounded to 3dp like every other pace value',
     String(paced(605, bar(10), GOAL)).replace(/^-?\d*\.?/, '').length <= 3);
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' : 'passed ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);
