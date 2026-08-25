// ============================================================
//  getFrozenPeriodGoal_ — must match on period_start, exactly
//  Run:  node tests/frozen_goal_lookup_test.js
//
//  WHY THIS SUITE EXISTS
//  ---------------------
//  GXCore.getPeriodGoals is dual-purpose by design. Its filter is
//      ps === d || (ps <= d && (!pe || d <= pe))
//  because most callers ask "what goal applied on this DATE?".
//
//  getFrozenPeriodGoal_ asks a different question — "is THIS period
//  already frozen?" — and the range half of that filter answers it
//  wrong whenever a stored row is mis-keyed. A stale row matches a
//  start it does not begin at, and rowsToLedgerEntry_ then stamps the
//  result with the REQUESTED start, so the caller gets a mislabeled
//  entry that looks entirely legitimate.
//
//  This is not hypothetical. On 2026-08-25 it silently defeated the
//  DST remediation: goalbackfillbulk asked for 2026-03-02, the stale
//  fifteen-day 2026-03-01..2026-03-15 row matched on range, the guard
//  read locked:true and skipped. The run reported all five mis-dated
//  periods as `alreadyLocked` and wrote nothing — a false success,
//  which is worse than a failure, because it reads as "already fixed".
//
//  The GXCore stub below reproduces the REAL filter from the hub's
//  gx_core.gs getPeriodGoals, so this suite fails if the app-side
//  guard ever goes back to trusting a range match.
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

// ── The corrupt shape the DST bug left in GX Core ────────────
// All five mis-dated rows, each keyed a day early, plus a correctly-keyed
// neighbour from after the 2026-03-08 spring-forward. The 03-01 row is the
// tell: fifteen days carrying a fourteen-day total. Every one of these is a
// real period_start/period_end pair read out of live period_goals on
// 2026-08-25 — the fixture has to carry all five or the assertions below
// pass vacuously against a fixture that cannot exercise them.
const CENTRAL_ROWS = [
  { store: 'baseline', period_start: '2026-03-01', period_end: '2026-03-15',   // 15 days — the tell
    period_total: 37205, dow_targets: [2626, 2414, 2402, 2610, 2537, 3111, 2902],
    source: 'auto', stretch: 0.01, computed_at: '2026-08-18T03:52:44.428Z', locked: true },
  { store: 'baseline', period_start: '2026-02-15', period_end: '2026-02-28',
    period_total: 37393, dow_targets: [2782, 2386, 2373, 2630, 2522, 3127, 2877],
    source: 'auto', stretch: 0.01, computed_at: '2026-08-18T03:52:49.404Z', locked: true },
  { store: 'baseline', period_start: '2026-02-01', period_end: '2026-02-14',
    period_total: 37500, dow_targets: [2800, 2400, 2380, 2640, 2530, 3130, 2880],
    source: 'auto', stretch: 0.01, computed_at: '2026-08-18T03:52:55.000Z', locked: true },
  { store: 'baseline', period_start: '2026-01-18', period_end: '2026-01-31',
    period_total: 37650, dow_targets: [2900, 2390, 2395, 2655, 2528, 3160, 2800],
    source: 'auto', stretch: 0.01, computed_at: '2026-08-18T03:52:58.000Z', locked: true },
  { store: 'baseline', period_start: '2026-01-04', period_end: '2026-01-17',
    period_total: 37792, dow_targets: [3014, 2378, 2404, 2671, 2531, 3188, 2710],
    source: 'auto', stretch: 0.01, computed_at: '2026-08-18T03:53:02.862Z', locked: true },
  { store: 'baseline', period_start: '2026-03-16', period_end: '2026-03-29',   // correctly keyed
    period_total: 37000, dow_targets: [2600, 2400, 2400, 2600, 2500, 3100, 2900],
    source: 'auto', stretch: 0.01, computed_at: '2026-08-18T03:53:00.000Z', locked: true },
];

// Mirrors gx_core.gs getPeriodGoals: exact period_start OR date within [start,end].
function fakeGetPeriodGoals(store, dateOrPeriodStart) {
  const d = String(dateOrPeriodStart || '').slice(0, 10);
  const rows = CENTRAL_ROWS.filter(function (r) {
    if (store && r.store !== store) return false;
    if (!d) return true;
    return r.period_start === d || (r.period_start <= d && (!r.period_end || d <= r.period_end));
  });
  return { ok: true, rows: rows };
}

function mod() {
  return H.load(['goals.gs', 'dutchie_proxy.gs'], {
    stubs: { GXCore: { getPeriodGoals: fakeGetPeriodGoals } },
  });
}

// ── The exact case the backfill got wrong ────────────────────
function test_misKeyedRowDoesNotShadowACorrectStart() {
  const S = mod();
  // 2026-03-02 is the CORRECT start. Only the stale 03-01 row exists, and it
  // spans 03-01..03-15 — so a range match would return it.
  _eq_('2026-03-02 has no frozen goal (stale 03-01 row must not shadow it)',
       S.getFrozenPeriodGoal_('2026-03-02'), null);
}

function test_allFiveMisdatedStartsReadAsUnfrozen() {
  const S = mod();
  // The five the note named. None of them is present under its correct key,
  // so every one must read as unfrozen — that is what lets backfill write them.
  ['2026-03-02', '2026-02-16', '2026-02-02', '2026-01-19', '2026-01-05'].forEach(function (pp) {
    _eq_(pp + ' reads as unfrozen', S.getFrozenPeriodGoal_(pp), null);
  });
}

// ── The behaviour that must NOT regress ──────────────────────
function test_correctlyKeyedRowStillResolves() {
  const S = mod();
  const fz = S.getFrozenPeriodGoal_('2026-03-16');
  _ok_('a correctly-keyed period still resolves', fz !== null);
  _eq_('it carries its own start',  fz && fz.periodStart, '2026-03-16');
  _eq_('and its own end',           fz && fz.periodEnd,   '2026-03-29');
  _eq_('and is reported locked',    fz && fz.locked,      true);
}

function test_staleRowStillResolvesAtItsOwnStart() {
  const S = mod();
  // The stale row is still readable at the key it actually has. The fix narrows
  // WHICH start matches it — it does not make the row unreachable.
  const fz = S.getFrozenPeriodGoal_('2026-03-01');
  _ok_('stale row resolves at its own start', fz !== null);
  _eq_('with its real fifteen-day end',       fz && fz.periodEnd, '2026-03-15');
}

// ── A mid-period date must not resolve as a period start ─────
function test_midPeriodDateIsNotAStart() {
  const S = mod();
  _eq_('2026-03-20 (mid 03-16 period) is not itself a start',
       S.getFrozenPeriodGoal_('2026-03-20'), null);
}

H.run('frozen goal lookup', {
  test_misKeyedRowDoesNotShadowACorrectStart,
  test_allFiveMisdatedStartsReadAsUnfrozen,
  test_correctlyKeyedRowStillResolves,
  test_staleRowStillResolvesAtItsOwnStart,
  test_midPeriodDateIsNotAStart,
});
