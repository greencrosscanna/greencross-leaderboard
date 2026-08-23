// ============================================================
//  goals.gs — day-of-week counting for alert proration
//
//  Ported from tests.gs (2026-08-22). Assertions unchanged —
//  these were already date-pinned (June 2026, Feb 2026) and
//  need no clock control.
//  Run:  node tests/goals_test.js
//
//  dutchie_proxy.gs is loaded alongside for STORE_TZ.
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

const S = H.load(['goals.gs', 'dutchie_proxy.gs']);

// ── dowCountsThroughDay_ ─────────────────────────────────────
function test_dowCountsThroughDay_() {
  function sum(o) { var t = 0; for (var d = 0; d <= 6; d++) t += o[d]; return t; }
  // June 2026 has 30 days.
  _eq_('counts to day 10 sum to 10', sum(S.dowCountsThroughDay_(2026, 5, 10)), 10);
  _eq_('counts to day 30 sum to 30', sum(S.dowCountsThroughDay_(2026, 5, 30)), 30);
  _eq_('clamps past month end',      sum(S.dowCountsThroughDay_(2026, 5, 100)), 30);
  // Feb 2026 (non-leap) has 28 days.
  _eq_('clamps Feb to 28',           sum(S.dowCountsThroughDay_(2026, 1, 40)), 28);
  // Each bucket non-negative and ≤ 5 (no DOW occurs >5× in a ≤10-day window).
  var c = S.dowCountsThroughDay_(2026, 5, 10);
  _ok_('buckets sane', [0,1,2,3,4,5,6].every(function(d){ return c[d] >= 0 && c[d] <= 5; }));
}

H.run('goals', { test_dowCountsThroughDay_ });
