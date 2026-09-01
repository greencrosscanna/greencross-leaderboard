#!/usr/bin/env node
/* Pace readouts before the EOD projection exists — renderStatusStrip / renderDirPaceCard
 * in index.html.
 *
 * The bug this exists to prevent: for the first TWO HOURS of every trading day the dashboard
 * printed an em dash where a percentage belongs. endpoints.gs only computes an end-of-day
 * projection once a store has MIN_PROJ_HOURS (2) of sales behind it; until then projectedPace
 * is null. Both readouts keyed their NUMBER off that null and printed "—", even though today's
 * pace was sitting right there in the same payload and was already coloring the dot beside it.
 *
 * So the top strip read "— — — — — —" every morning while the store table directly under it
 * showed +6.2% / +4.1% / +1.4% for the same six stores, and the Projected-vs-Plan gauge swung
 * its needle to a real position over a readout that refused to name it. Nothing errored;
 * it just looked broken, and it self-healed by mid-morning, which is why it survived so long.
 * (Reported 2026-09-01.)
 *
 * Per tests/_harness.js's rule this NEVER reimplements: it extracts the real function bodies
 * from the shipped index.html and runs them (same approach as big_sale_banner_test.js).
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Bodies are indented 2 spaces inside the view IIFE, so a line that is exactly "  }" closes them.
function grab(name) {
  const re = new RegExp('\\n  function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n');
  const m = src.match(re);
  if (!m) throw new Error('function not found in index.html: ' + name);
  return m[0];
}

// Collaborators the two renderers call. Stubbed to the identity-ish minimum so the assertions are
// about the pace TEXT, not about currency formatting.
const ctx = {
  Math: Math,
  e: (s) => String(s == null ? '' : s),
  GC: {
    fmtCurrency: (n) => '$' + Math.round(Number(n) || 0),
    paceDotClass: (p) => (p >= 0.01 ? 'green' : p <= -0.05 ? 'red' : 'amber'),
  },
  DIR_PACE_RANGE: 80,
};
vm.createContext(ctx);
vm.runInContext(grab('renderStatusStrip'), ctx);
vm.runInContext(grab('renderDirPaceCard'), ctx);

let pass = 0, fail = 0;
const ok = (m, c) => { c ? (pass++, console.log('  ok  ' + m)) : (fail++, console.log('  FAIL ' + m)); };

// ── Fixtures: the same store, before and after the projection exists ────────────────────────────
const preProjection = {
  slug: 'river', name: 'River',
  today: { revenue: 3200, goal: 44000, pace: -0.142, projectedPace: null, projected: 0,
           projectedRevenue: 0, paceGap: -620, timeRemainingLabel: '13:15' },
};
const withProjection = {
  slug: 'river', name: 'River',
  today: { revenue: 21000, goal: 44000, pace: 0.031, projectedPace: 0.062, projected: 46700,
           projectedRevenue: 46700, paceGap: 640, timeRemainingLabel: '05:10' },
};

console.log('\nStatus strip — the "upper bar"');
{
  const pre = ctx.renderStatusStrip([preProjection]);
  ok('prints a percentage before the projection exists', /−14%/.test(pre));
  ok('prints no em dash in the percentage slot',
     !/class="ss-pct[^"]*"[^>]*>—</.test(pre));
  ok('percentage is the pace, signed and rounded', pre.includes('>−14%<'));
  ok('down class matches a negative pace', /class="ss-pct down"/.test(pre));
  ok('tooltip says it is pace, not a projection', /Pace so far vs\. daily goal/.test(pre));

  const post = ctx.renderStatusStrip([withProjection]);
  ok('still prefers the projection once there is one', post.includes('>+6%<'));
  ok('tooltip switches to the projection wording',
     /Projected end of day vs\. daily goal/.test(post));
  ok('up class matches a positive projected pace', /class="ss-pct up"/.test(post));
}

console.log('\nProjected-vs-Plan gauge');
{
  const pre = ctx.renderDirPaceCard(preProjection.today);
  ok('prints a percentage before the projection exists', /dir-gauge-pct[^>]*>−14%</.test(pre));
  ok('no em dash in the headline readout', !/dir-gauge-pct[^>]*>—</.test(pre));
  ok('card title says Pace, not Projected', pre.includes('>Pace · vs. Plan<'));
  ok('sub-label drops the "Proj." prefix', /Behind plan|Near plan|Ahead of plan/.test(pre)
     && !/Proj\./.test(pre));
  ok('Projected stat is a dash — that value genuinely does not exist yet',
     pre.includes('num">—</div><div class="kstat-l">Projected</div>'));

  // The needle and the number must name the same quantity. -14.2% of a ±80 range → -15.975deg.
  const deg = pre.match(/rotate\((-?[\d.]+)deg\)/);
  ok('needle is drawn from the same pace the readout prints',
     !!deg && Math.abs(parseFloat(deg[1]) - (-0.142 * 100 / 80) * 90) < 0.001);

  const post = ctx.renderDirPaceCard(withProjection.today);
  ok('card title returns to Projected once there is a projection',
     post.includes('>Projected · vs. Plan<'));
  ok('headline is the projected pace', /dir-gauge-pct[^>]*>\+6%</.test(post));
  ok('Projected stat shows the money once it exists', post.includes('>$46700<'));
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' : 'passed ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);
