// ============================================================
//  endpoints.gs — hourFreezeDisplay_: the by-hour bars may never
//  out-claim the day total
//
//  Reported off the kiosk by Sky, 2026-09-02: River read $266 SOLD in the
//  KPI strip while the 9a bar alone read $636 and the peak label agreed
//  with the bar. Every transaction lands in exactly one hour bucket, so
//  the bars can only ever sum to LESS than the day (a sale outside store
//  hours is charted nowhere) — never more.
//
//  The cause is the freeze. A completed hour is snapshotted on the first
//  read after it closes and was then never revisited, so anything that
//  later takes money OUT of that hour — a ticket voided out of the retail
//  set, a return posted against the original sale — dropped the day total
//  and left the bar behind, for the rest of the day.
//
//  These cases drive the pure decision function, which is the only place
//  the two freeze rules live. kiosk_hero_test.js drives the same rules
//  through the real getStoreToday.
//
//  Run:  node tests/hour_freeze_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

const S = H.load(['endpoints.gs', 'dutchie_proxy.gs', 'dutchie_fetch.gs']);

const OPEN = 8, CLOSE = 22;

/** { 9: 636, 10: 12 } → the hourMap shape aggregateByHour_ returns. */
function hours(o) {
  const m = {};
  Object.keys(o).forEach(function (h) { m[h] = { revenue: o[h], count: 1 }; });
  return m;
}

function run(hourMap, frozen, nowHour, dayTotal, isPreOpen) {
  return S.hourFreezeDisplay_(hourMap, frozen, {
    openHour: OPEN, closeHour: CLOSE, nowHour: nowHour,
    isPreOpen: !!isPreOpen, dayTotal: dayTotal,
  });
}

function sum(disp) {
  let t = 0;
  for (let h = OPEN; h < CLOSE; h++) t += disp[h] || 0;
  return t;
}

// ── 1. The reported shape ────────────────────────────────────
// River at 10:06am: 8a and 9a are settled and snapshotted; the day has
// since been reduced to $267. The 9a bar was reading nearly 2.4x the day.
function test_the_river_case() {
  const live   = hours({ 8: 60, 9: 197, 10: 10 });     // what Dutchie says NOW
  const frozen = { 8: 60, 9: 636 };                    // what the 10:00 snapshot locked
  const r = run(live, frozen, 10, 267);

  _ok_('the stale snapshot is detected',       r.healed);
  _eq_('9a comes down to the live hour',       r.dispRev[9], 197);
  _eq_('8a is untouched — it never lied',      r.dispRev[8], 60);
  _eq_('the current hour is live either way',  r.dispRev[10], 10);
  _ok_('the bars no longer out-claim the day', sum(r.dispRev) <= 267);
  _eq_('and the correction is persisted',      r.frozen[9], 197);
  _ok_('the write is flagged',                 r.dirty);
}

// ── 2. Freezing still does its job ───────────────────────────
// The bug the freeze exists for: a late-settling transaction must not
// move a bar that has already been read by the whole store.
function test_a_late_sale_still_does_not_move_a_settled_bar() {
  const r = run(hours({ 11: 390 }), { 11: 300 }, 14, 390);
  _eq_('a settled hour holds its snapshot', r.dispRev[11], 300);
  _ok_('nothing healed',                    !r.healed);
  _ok_('nothing written',                   !r.dirty);
}

// ── 3. Rounding alone never triggers a re-snapshot ───────────
// Every hour is Math.round-ed on its own, so the bars drift from the
// un-rounded day total by cents. That is not evidence of anything.
function test_rounding_noise_is_not_a_stale_snapshot() {
  const r = run(hours({ 9: 100, 10: 100 }), { 9: 100, 10: 100 }, 12, 199.4);
  _ok_('a couple of dollars is left alone', !r.healed);
  _eq_('the bar is unchanged',              r.dispRev[9], 100);
}

// ── 4. A zero is never evidence, in either direction ─────────
// fetchTxnPagesByKey_ returns [] on a non-200 or a parse error, so a
// failed fetch is indistinguishable from a quiet hour. It may not freeze
// a zero, and it may not heal one either — a Dutchie outage that zeroed
// today's fetch would otherwise wipe the morning off the chart.
function test_an_outage_cannot_erase_the_morning() {
  const r = run(hours({}), { 9: 400, 10: 300 }, 12, 0);
  _eq_('9a survives the outage',   r.dispRev[9], 400);
  _eq_('10a survives the outage',  r.dispRev[10], 300);
  _ok_('nothing was healed away',  !r.healed);
}

// A partial outage — one hour lost, the rest intact — heals only the hour
// it can actually see.
function test_a_lost_hour_is_kept_and_a_shrunken_one_is_healed() {
  const r = run(hours({ 9: 0, 10: 120 }), { 9: 400, 10: 300 }, 12, 120);
  _eq_('the lost hour keeps its snapshot', r.dispRev[9], 400);
  _eq_('the hour that shrank is healed',   r.dispRev[10], 120);
}

// ── 5. Healing is one-way ────────────────────────────────────
function test_healing_never_pushes_a_bar_up() {
  // The day total is far above the bars (sales outside store hours, or a
  // late batch). Nothing may move: an upward heal is the drift the freeze
  // was built to stop.
  const r = run(hours({ 9: 900 }), { 9: 300 }, 12, 5000);
  _eq_('the settled bar holds', r.dispRev[9], 300);
  _ok_('no heal',               !r.healed);
}

// ── 6. Pre-open shows yesterday, live, and freezes nothing ───
function test_pre_open_is_untouched() {
  const r = run(hours({ 9: 400, 17: 900 }), {}, 6, 1300, true);
  _eq_('yesterday 9a is live',   r.dispRev[9], 400);
  _eq_('yesterday 5p is live',   r.dispRev[17], 900);
  _ok_('nothing frozen pre-open', !r.dirty);
}

// ── 7. A stored zero is not a snapshot ───────────────────────
// A day poisoned by the original freeze-a-zero bug still heals: a stored
// 0 reads as "not frozen yet", so the real number lands on the next poll.
function test_a_stored_zero_reads_as_unfrozen() {
  const r = run(hours({ 9: 250 }), { 9: 0 }, 12, 250);
  _eq_('the real number lands', r.dispRev[9], 250);
  _eq_('and is snapshotted',    r.frozen[9], 250);
}

H.run('hour_freeze', {
  test_the_river_case,
  test_a_late_sale_still_does_not_move_a_settled_bar,
  test_rounding_noise_is_not_a_stale_snapshot,
  test_an_outage_cannot_erase_the_morning,
  test_a_lost_hour_is_kept_and_a_shrunken_one_is_healed,
  test_healing_never_pushes_a_bar_up,
  test_pre_open_is_untouched,
  test_a_stored_zero_reads_as_unfrozen,
});
