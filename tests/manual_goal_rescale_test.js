// ============================================================
//  goals.gs — resolveEffectiveGoal_, the MANUAL-OVERRIDE branch
//
//  A manual PP override is a number a human typed: Portland Rd's
//  $41,500. Nothing downstream ever reads that number directly.
//  GX Core's period_goals stores dow_targets, and Sales expands
//  them per date and adds them up — so the assertion that
//  matters is that the seven targets SUM to the override across
//  a fourteen-day period. Anything else silently shows a goal
//  nobody set.
//
//  The rescale used to normalise on g.ppGoal, which is only the
//  same thing when 2 x sum(dowAvg) == ppGoal. That identity
//  breaks whenever the 12-period window is missing days (ppGoal
//  falls, the per-weekday means do not) or carries an extra one
//  from a DST-stretched range. Both happened to the one store on
//  an override: it rendered $47,735 and $43,564 against a
//  $41,500 goal in Dec 2025 / Jan 2026, and has run 0.7% light
//  since 2026-04-27.
//
//  The fixtures below are those measured shapes. Normalising on
//  the shape's own two-week total makes the sum exact by
//  construction, which is what these assert.
//
//  Run:  node tests/manual_goal_rescale_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_, _approx_ } = H;

const S = H.load(['goals.gs', 'dutchie_proxy.gs']);

const PP_DAYS = 14;
const MANUAL  = 41500;

/** What a consumer actually gets: the seven targets summed over a 14-day period
 *  (each weekday falls exactly twice). Deliberately computed the way Sales does
 *  it — per date — rather than as 2 x sum, so the test would still catch a shape
 *  that only balances in aggregate. */
function periodSum(dowAvg) {
  let t = 0;
  for (let day = 0; day < PP_DAYS; day++) t += (dowAvg[day % 7] || 0);
  return t;
}

/** A day-of-week shape whose two-week total is `total`, distributed unevenly —
 *  a flat shape would pass a broken rescale by accident. */
function shape(total) {
  const w = [0.12, 0.11, 0.11, 0.14, 0.15, 0.20, 0.17];   // Sun..Sat, sums to 1
  const out = {};
  for (let d = 0; d <= 6; d++) out[d] = total / 2 * w[d];
  return out;
}

function test_clean_window() {
  // The healthy case: ppGoal and the shape agree, so both the old and the new
  // basis land on the override. Asserted so the fix cannot regress the common path.
  const gr = { ppGoal: 38000, dowAvg: shape(38000) };
  const r  = S.resolveEffectiveGoal_('portland', gr, {}, 0.01, { portland: String(MANUAL) });
  _ok_('the override is used',              r.useManual === true);
  _eq_('effectivePP is the override',       Math.round(r.effectivePP), MANUAL);
  _eq_('stretch is zeroed on an override',  r.stretch, 0);
  _approx_('the shape sums to the override', periodSum(r.g.dowAvg), MANUAL, 0.01);
}

function test_window_missing_days() {
  // Dec 2025, measured: 22 of the 168 window days had no Portland Rd sales, so the
  // period totals were short while the per-weekday means were not. ppGoal reads
  // 168/146 low against the shape — the exact ratio that rendered $47,735.
  const trueTwoWeek = 38000;
  const gr = { ppGoal: Math.round(trueTwoWeek * 146 / 168), dowAvg: shape(trueTwoWeek) };
  _ok_('the fixture really is the broken identity',
       Math.abs(2 * Object.values(gr.dowAvg).reduce((a, b) => a + b, 0) / gr.ppGoal - 1.15) < 0.01);

  const r = S.resolveEffectiveGoal_('portland', gr, {}, 0.01, { portland: String(MANUAL) });
  _approx_('the shape still sums to the override', periodSum(r.g.dowAvg), MANUAL, 0.01);
  _ok_('and does NOT overshoot the way ppGoal-normalising did',
       periodSum(r.g.dowAvg) < MANUAL * 1.001);
}

function test_window_extra_day() {
  // The DST case, opposite sign: one extra day in the 168 inflates ppGoal against
  // the shape. Measured as a steady -0.7% on Portland Rd since 2026-04-27.
  const trueTwoWeek = 38000;
  const gr = { ppGoal: Math.round(trueTwoWeek * 169 / 168), dowAvg: shape(trueTwoWeek) };
  const r  = S.resolveEffectiveGoal_('portland', gr, {}, 0.01, { portland: String(MANUAL) });
  _approx_('the shape sums to the override', periodSum(r.g.dowAvg), MANUAL, 0.01);
  _ok_('and does NOT undershoot', periodSum(r.g.dowAvg) > MANUAL * 0.999);
}

function test_shape_is_preserved() {
  // Rescaling must move the LEVEL and not the profile — a Saturday has to stay the
  // same multiple of a Monday, or the override quietly reshapes the week.
  const gr = { ppGoal: 30000, dowAvg: shape(38000) };
  const r  = S.resolveEffectiveGoal_('portland', gr, {}, 0, { portland: String(MANUAL) });
  const before = gr.dowAvg[6] / gr.dowAvg[1];
  const after  = r.g.dowAvg[6] / r.g.dowAvg[1];
  _approx_('Sat:Mon ratio is unchanged', after, before, 1e-9);
  _ok_('every day scaled by the same factor',
       [0,1,2,3,4,5,6].every(d => Math.abs(r.g.dowAvg[d] / gr.dowAvg[d] - r.g.dowAvg[0] / gr.dowAvg[0]) < 1e-9));
}

function test_no_shape_falls_back_to_ppGoal() {
  // A store with no day-of-week profile has nothing to normalise on. It must not
  // divide by zero or return NaN targets — ppGoal is the only basis left.
  const gr = { ppGoal: 30000 };
  const r  = S.resolveEffectiveGoal_('portland', gr, {}, 0, { portland: String(MANUAL) });
  _eq_('still reports the override', Math.round(r.effectivePP), MANUAL);
  _ok_('no NaN reaches the shape',
       [0,1,2,3,4,5,6].every(d => r.g.dowAvg[d] === undefined || !isNaN(r.g.dowAvg[d])));
}

function test_non_manual_stores_untouched() {
  // The rescale lives entirely inside the override branch. A store with no entry
  // in the map must come back with its computed goal and its stretch intact.
  const gr = { ppGoal: 66000, dowAvg: shape(66000) };
  const gy = { ppGoal: 61000, dowAvg: shape(61000) };
  const r  = S.resolveEffectiveGoal_('century', gr, gy, 0.01, { portland: String(MANUAL) });
  _ok_('no override used',            r.useManual === false);
  _eq_('the rolling goal wins',       r.effectivePP, 66000);
  _eq_('stretch survives',            r.stretch, 0.01);
  _eq_('the shape is the untouched original', r.g.dowAvg[6], gr.dowAvg[6]);
}

function test_yoy_floor_still_supplies_the_shape() {
  // max(rolling, yoy) picks the source BEFORE the rescale, and the override must
  // rescale whichever shape won — not silently fall back to the rolling one.
  const gr = { ppGoal: 30000, dowAvg: shape(30000) };
  const gy = { ppGoal: 44000, dowAvg: shape(44000) };
  const r  = S.resolveEffectiveGoal_('portland', gr, gy, 0, { portland: String(MANUAL) });
  _approx_('the shape sums to the override', periodSum(r.g.dowAvg), MANUAL, 0.01);
  _approx_('and it is the YoY profile that was scaled',
           r.g.dowAvg[6] / r.g.dowAvg[0], gy.dowAvg[6] / gy.dowAvg[0], 1e-9);
}

function test_stretch_derived_override_is_ignored() {
  // An override within 1% of max(R,Y)x(1+stretch) is treated as a stretch artefact,
  // not a human decision — that branch must be untouched by this change.
  const gr = { ppGoal: 40000, dowAvg: shape(40000) };
  const r  = S.resolveEffectiveGoal_('portland', gr, {}, 0.01, { portland: '40400' });
  _ok_('not treated as a manual override', r.useManual === false);
  _eq_('the computed goal is returned',    r.effectivePP, 40000);
  _eq_('stretch is kept',                  r.stretch, 0.01);
}

H.run('manual goal rescale', {
  test_clean_window,
  test_window_missing_days,
  test_window_extra_day,
  test_shape_is_preserved,
  test_no_shape_falls_back_to_ppGoal,
  test_non_manual_stores_untouched,
  test_yoy_floor_still_supplies_the_shape,
  test_stretch_derived_override_is_ignored,
});
