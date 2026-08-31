// ============================================================
//  Pay-period boundaries across Daylight Saving
//  Run:  node tests/pay_period_dst_test.js
//
//  WHY THIS SUITE EXISTS
//  ---------------------
//  Pay periods used to be derived with fixed-millisecond arithmetic:
//  `anchorMs ± n * (14 * 86400000)`. A period that contains a DST
//  change is still 14 CALENDAR days, but it is 335 or 337 hours —
//  so that arithmetic lands an hour off PT midnight, and an hour
//  BEFORE midnight formats back to the previous day.
//
//  It shipped, and it was not loud. With the 2026-05-11 (PDT)
//  anchor it mis-dated every period before the 2026-03-08 change:
//  GX Core period_goals carried five period starts a day early and
//  a 2026-03-01..2026-03-15 row — fifteen days holding a 14-day
//  goal total, at all six stores. The same math would have moved
//  the LIVE period a day early from 2026-11-09.
//
//  Every case below is pinned to a real 2026 DST boundary. If a
//  future refactor reintroduces ms arithmetic, these fail.
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

const ANCHOR = '2026-05-11';            // a PDT date — the shipped default
const PROPS  = { getProperty: function () { return null; } };

// currentPPStart_ memoizes into a module-level cache (one GAS execution =
// one period), so each probe needs a freshly loaded module — exactly what a
// new invocation gets in production.
function ppOn(ptDateStr) {
  const M = H.load(['dutchie_proxy.gs']);
  H.setNow(M.ptDateToUtcMs_(ptDateStr) + 12 * 3600000);   // midday PT, away from any edge
  return M.currentPPStart_(PROPS);
}
function startOn(ptDateStr) { return H.fmtPT(ppOn(ptDateStr).ppStartMs); }

// ── The dates the bug actually got wrong ─────────────────────
function test_periodStart_acrossDST() {
  // Spring forward 2026-03-08; fall back 2026-11-01. Anchor is 2026-05-11.
  // Every expectation here is anchor ± a whole number of 14-day calendar steps.
  const cases = [
    ['2026-05-11', '2026-05-11'],   // the anchor itself
    ['2026-08-25', '2026-08-17'],   // same DST side, forward — always worked
    ['2026-03-20', '2026-03-16'],   // last period fully after spring-forward
    ['2026-03-05', '2026-03-02'],   // period STRADDLING spring-forward
    ['2026-02-20', '2026-02-16'],   // before it: was 2026-02-15
    ['2026-01-10', '2026-01-05'],   // before it: was 2026-01-04
    ['2026-11-15', '2026-11-09'],   // after fall-back: was 2026-11-08
    ['2026-12-25', '2026-12-21'],   // deeper into PST: was 2026-12-20
  ];
  cases.forEach(function (c) {
    _eq_('period on ' + c[0] + ' starts ' + c[1], startOn(c[0]), c[1]);
  });
}

// ── A period is always exactly 14 calendar days ──────────────
function test_periodIsAlways14Days() {
  // The 15-day row in GX Core is what this asserts against.
  const probes = ['2026-01-10','2026-02-20','2026-03-05','2026-03-20',
                  '2026-05-11','2026-08-25','2026-11-15','2026-12-25'];
  probes.forEach(function (d) {
    const pp  = ppOn(d);
    const beg = H.fmtPT(pp.ppStartMs);
    const end = H.fmtPT(pp.ppEndMs);
    const days = Math.round(
      (Date.UTC.apply(null, end.split('-').map(Number).map(function (n, i) { return i === 1 ? n - 1 : n; }))
       - Date.UTC.apply(null, beg.split('-').map(Number).map(function (n, i) { return i === 1 ? n - 1 : n; })))
      / 86400000) + 1;
    _eq_('period at ' + d + ' spans 14 days (' + beg + '..' + end + ')', days, 14);
    // ppEndMs is the last instant of the last day, not midnight starting it.
    _eq_('ppEndStr agrees with ppEndMs at ' + d, pp.ppEndStr, end);
    _eq_('ppStartStr agrees with ppStartMs at ' + d, pp.ppStartStr, beg);
  });
}

// ── The end boundary butts against the next period's start ───
function test_endAbutsNextStart() {
  ['2026-03-05', '2026-11-15', '2026-08-25'].forEach(function (d) {
    const M  = H.load(['dutchie_proxy.gs']);
    H.setNow(M.ptDateToUtcMs_(d) + 12 * 3600000);
    const pp = M.currentPPStart_(PROPS);
    _eq_('no gap/overlap at next boundary from ' + d,
         M.ppShift_(pp.ppStartMs, 1) - pp.ppEndMs, 1);
  });
}

// ── ppShift_ walks calendar days, not milliseconds ───────────
function test_ppShift_walksCalendarDays() {
  const M = H.load(['dutchie_proxy.gs']);
  H.setNow(M.ptDateToUtcMs_('2026-05-11') + 12 * 3600000);
  const cur = M.currentPPStart_(PROPS);
  // Walking back from the PDT anchor into PST is the exact path that broke.
  const back = [1,2,3,4,5,6,7,8,9,10].map(function (k) { return H.fmtPT(M.ppShift_(cur.ppStartMs, -k)); });
  _eq_('10 periods back from the anchor', back, [
    '2026-04-27','2026-04-13','2026-03-30','2026-03-16','2026-03-02',
    '2026-02-16','2026-02-02','2026-01-19','2026-01-05','2025-12-22',
  ]);
  // And forward across fall-back.
  const fwd = [12,13,14,15].map(function (k) { return H.fmtPT(M.ppShift_(cur.ppStartMs, k)); });
  _eq_('forward across fall-back', fwd, ['2026-10-26','2026-11-09','2026-11-23','2026-12-07']);
  // Round-tripping must land back where it started, on both DST sides.
  [-9, -5, -1, 0, 1, 13, 15].forEach(function (k) {
    _eq_('shift ' + k + ' then back is identity',
         M.ppShift_(M.ppShift_(cur.ppStartMs, k), -k), cur.ppStartMs);
  });
}

// ── Every start is a true PT midnight ────────────────────────
function test_startsAreMidnightPT() {
  // The failure signature was an instant at 23:00 the day before. Assert the
  // hour directly, so a regression cannot hide behind a date that looks right.
  ['2026-01-10','2026-03-05','2026-05-11','2026-08-25','2026-11-15','2026-12-25'].forEach(function (d) {
    const pp = ppOn(d);
    _eq_('period start on ' + d + ' is PT midnight',
         H.formatDate(new Date(pp.ppStartMs), 'America/Los_Angeles', 'HH:mm'), '00:00');
  });
}

// ── Anchor-relative: offsets stay whole across a DST change ──
function test_everyStartIsAWholeNumberOfPeriodsFromAnchor() {
  const M = H.load(['dutchie_proxy.gs']);
  const anchorMs = M.ptDateToUtcMs_(ANCHOR);
  // Sweep a year of dates; every computed start must be reachable from the
  // anchor by a whole number of 14-day calendar steps.
  let checked = 0, bad = [];
  for (let i = -200; i <= 200; i += 7) {
    const probe = new Date(Date.UTC(2026, 4, 11 + i)).toISOString().slice(0, 10);
    const start = startOn(probe);
    const days  = Math.round((M.ptDateToUtcMs_(start) - anchorMs) / 86400000);
    if (days % 14 !== 0) bad.push(probe + '->' + start);
    // The probe date must fall inside its own period.
    const pp = ppOn(probe);
    if (!(M.ptDateToUtcMs_(probe) >= pp.ppStartMs && M.ptDateToUtcMs_(probe) <= pp.ppEndMs)) {
      bad.push(probe + ' outside ' + H.fmtPT(pp.ppStartMs) + '..' + H.fmtPT(pp.ppEndMs));
    }
    checked++;
  }
  _ok_('swept ' + checked + ' dates across a full year', checked > 50);
  _eq_('every start is a whole number of periods from the anchor, and contains its date', bad, []);
}

// ── periodStartForDate_: maps a day to its period KEY ────────
// This is what decides which frozen goal a given day is scored against, so an
// off-by-one here silently scores a day against the neighboring period's goal.
function test_periodStartForDate_() {
  const M = H.load(['goals.gs', 'dutchie_proxy.gs']);
  H.setNow(M.ptDateToUtcMs_('2026-08-25') + 12 * 3600000);
  const cases = [
    // [any PT day, the period start it belongs to]
    ['2026-08-25', '2026-08-17'],   // inside the current period
    ['2026-08-17', '2026-08-17'],   // first day of the current period
    ['2026-08-16', '2026-08-03'],   // last day of the previous one
    ['2026-03-15', '2026-03-02'],   // the DST-straddling period
    ['2026-03-08', '2026-03-02'],   // spring-forward day itself
    ['2026-03-02', '2026-03-02'],   // its first day
    ['2026-03-01', '2026-02-16'],   // the day before — previous period
    ['2026-02-16', '2026-02-16'],
    ['2026-01-05', '2026-01-05'],
  ];
  cases.forEach(function (c) {
    _eq_(c[0] + ' belongs to period ' + c[1], M.periodStartForDate_(c[0]), c[1]);
  });

  // Every day of the DST-straddling period must map to that one period, and it
  // must be exactly 14 distinct days.
  const days = [];
  for (var d = 2; d <= 15; d++) {
    days.push(M.periodStartForDate_('2026-03-' + String(d).padStart(2, '0')));
  }
  _eq_('all 14 days of the spring-forward period map to it',
       days.filter(function (x) { return x === '2026-03-02'; }).length, 14);
}

H.run('pay_period_dst', {
  test_periodStartForDate_,
  test_periodStart_acrossDST,
  test_periodIsAlways14Days,
  test_endAbutsNextStart,
  test_ppShift_walksCalendarDays,
  test_startsAreMidnightPT,
  test_everyStartIsAWholeNumberOfPeriodsFromAnchor,
});
