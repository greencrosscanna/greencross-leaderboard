#!/usr/bin/env node
/* Pace marker geometry + fallback ladder — GC.expectedFrac / GC.paceFrac / GC.chainShape /
 * GC.arcTick in index.html.
 *
 * The bug these exist to prevent: the gauge drew its pace marker from GC.dayFrac() — straight
 * clock time — while the pace PERCENTAGE printed beside it came from the server's DOW-weighted
 * curve. Both were "pace", they disagreed by up to 13 points of the arc, and nothing errored;
 * it just made the gauge look wrong to anyone who read both numbers ("47% to goal but only
 * -2% behind pace"). Measured 2026-08-28 at 12:43 PT, live: linear said 0.337 of the day was
 * gone, the stores' real curves said 0.20-0.29.
 *
 * The subtle part, and the reason for the explicit ladder: GC.expectedFrac already falls back
 * to linear internally, so `GC.expectedFrac(shape) || serverValue` can NEVER reach serverValue
 * -- linear is a truthy number. That is the same silent-fallback shape as the original bug.
 *
 * Per tests/_harness.js's rule this never reimplements: it extracts the real function bodies
 * from the shipped index.html and runs them (same approach as big_sale_banner_test.js).
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// GC.* assignments are top-level: "GC.name = function(...) {" ... closed by a line "};"
function grabGC(name) {
  const re = new RegExp('\\nGC\\.' + name + ' = function\\([^)]*\\) \\{[\\s\\S]*?\\n\\};\\n');
  const m = src.match(re);
  if (!m) throw new Error('could not extract GC.' + name + ' from index.html');
  return m[0];
}

const ctx = { GC: {}, Math: Math, parseInt: parseInt, parseFloat: parseFloat, Date: Date, Intl: Intl };
vm.createContext(ctx);
['dayFrac', 'expectedFrac', 'hasShape', 'chainShape', 'paceFrac', 'arcTick'].forEach(function(n) {
  vm.runInContext(grabGC(n), ctx);
});
const GC = ctx.GC;

let pass = 0, fail = 0;
const ok  = (m, c) => { c ? (pass++, console.log('  ok  ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const eq  = (m, a, b) => ok(m + '  (got ' + a + ', want ' + b + ')', a === b);
const near= (m, a, b, tol) => ok(m + '  (got ' + a + ', want ~' + b + ')', Math.abs(a - b) <= (tol || 1e-6));

// A curve where the back half of the day carries most of the revenue — the real dispensary
// shape, and the one that makes linear clock time read as "behind" all morning.
const BACKLOADED = {};
for (let h = 8; h < 22; h++) BACKLOADED[h] = h < 15 ? 0.03 : 0.116;   // sums to ~1.0

console.log('\n— GC.expectedFrac —');
{
  // No shape at all must fall through to linear, and say so by matching dayFrac exactly.
  eq('no shape falls back to linear', GC.expectedFrac(null), GC.dayFrac());
  eq('empty shape falls back to linear', GC.expectedFrac({}), GC.dayFrac());

  // A curve that is flat across the open hours IS linear, by construction.
  const flat = {};
  for (let h = 8; h < 22; h++) flat[h] = 1 / 14;
  near('a flat curve reproduces linear', GC.expectedFrac(flat), GC.dayFrac(), 1e-9);

  // Weights are renormalized, so scaling the whole curve changes nothing.
  const scaled = {};
  for (let h = 8; h < 22; h++) scaled[h] = BACKLOADED[h] * 37;
  near('un-normalized curve gives the same answer', GC.expectedFrac(scaled), GC.expectedFrac(BACKLOADED), 1e-9);

  const f = GC.expectedFrac(BACKLOADED);
  ok('stays within 0..1', f >= 0 && f <= 1);
}

console.log('\n— GC.paceFrac ladder —');
{
  // The regression that matters: a real curve wins, but with NO curve the server's weighted
  // value must be used — not linear. The obvious `expectedFrac(x) || server` spelling fails
  // this case, because linear is truthy.
  eq('no shape uses the server value, not linear', GC.paceFrac(null, 0.22), 0.22);
  eq('empty shape uses the server value', GC.paceFrac({}, 0.22), 0.22);
  ok('a real shape beats the server value',
     GC.paceFrac(BACKLOADED, 0.99) !== 0.99);
  eq('no shape and no server value falls back to linear',
     GC.paceFrac(null, 0), GC.dayFrac());
  eq('a zero server value is not mistaken for a real one',
     GC.paceFrac(null, 0), GC.dayFrac());
}

console.log('\n— GC.chainShape —');
{
  const A = {}, B = {};
  for (let h = 8; h < 22; h++) { A[h] = h === 9 ? 1 : 0; B[h] = h === 20 ? 1 : 0; }

  const even = GC.chainShape([{ hourShape: A, target: 100 }, { hourShape: B, target: 100 }]);
  near('equal goals weight the two curves equally', even[9] / (even[9] + even[20]), 0.5);

  const tilted = GC.chainShape([{ hourShape: A, target: 300 }, { hourShape: B, target: 100 }]);
  near('a bigger store pulls the blend toward its curve',
       tilted[9] / (tilted[9] + tilted[20]), 0.75);

  eq('accepts goal under either key', GC.chainShape([{ hourShape: A, goal: 100 }])[9], 100);
  eq('no stores yields null', GC.chainShape([]), null);
  eq('stores without curves yield null', GC.chainShape([{ target: 100 }, { target: 50 }]), null);
  eq('a store with no goal contributes nothing',
     GC.chainShape([{ hourShape: A, target: 0 }]), null);
}

console.log('\n— GC.arcTick geometry —');
{
  // The kiosk arc: "M 22 122 A 98 98 0 0 1 218 122" — center (120,122), r 98, left to right.
  const mid = GC.arcTick(0.5, 120, 122, 98, 8);
  near('half way is straight up: x centered', +mid.x1, 120, 0.01);
  ok('half way is straight up: above the center', +mid.y1 < 122 && +mid.y2 < 122);
  eq('the tick is vertical there', mid.x1, mid.x2);

  const start = GC.arcTick(0, 120, 122, 98, 8);
  near('zero sits at the left end of the arc', +start.x1, 120 - 90, 0.01);
  near('and on the baseline', +start.y1, 122, 0.01);

  const end = GC.arcTick(1, 120, 122, 98, 8);
  near('one sits at the right end of the arc', +end.x1, 120 + 90, 0.01);

  // Spans the 14px stroke (halfWidth 8), measured across the radius.
  const d = Math.hypot(+mid.x2 - +mid.x1, +mid.y2 - +mid.y1);
  near('spans the full stroke width', d, 16, 0.05);

  // Out-of-range fractions are clamped rather than swinging off the arc.
  eq('clamps above 1', GC.arcTick(1.7, 120, 122, 98, 8).x1, end.x1);
  eq('clamps below 0', GC.arcTick(-0.4, 120, 122, 98, 8).x1, start.x1);
}

console.log('\n' + (fail ? '❌' : '✅') + ' pace_marker ' + (fail ? fail + ' FAILED' : 'ALL PASS') +
            ' (' + pass + '/' + (pass + fail) + ')');
process.exit(fail ? 1 : 0);
