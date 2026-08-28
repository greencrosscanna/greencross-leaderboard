// ============================================================
//  endpoints.gs — per-employee daily target math
//
//  The kiosk shows every budtender a personal daily target. It is NOT a
//  ranking: it is that person's own trailing 28-day average for TODAY'S
//  day-of-week, +2.5 %. These assertions pin that contract, and pin the
//  known asymmetry that makes two people's targets non-comparable when
//  one has ≥2 same-DOW samples and the other does not.
//
//  Run:  node tests/emp_targets_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

const S = H.load(['endpoints.gs', 'dutchie_fetch.gs', 'dutchie_proxy.gs']);

// Build a transaction the way Dutchie returns one.
function tx(name, dateStr, total) {
  return { completedByUser: name, transactionDateLocalTime: dateStr + 'T13:00:00', total: total };
}

// 2026-08-27 is a Thursday (dow 4). Thursdays in the 28-day window before it:
// 08-06, 08-13, 08-20. Wednesdays: 08-05, 08-12, 08-19, 08-26.
const THU = [ '2026-08-06', '2026-08-13', '2026-08-20' ];
const WED = [ '2026-08-05', '2026-08-12', '2026-08-19', '2026-08-26' ];

function test_sameDowAverage() {
  // Two Thursdays at 1000 and 1400 → avg 1200 → ×1.025 → 1230
  const txns = [ tx('Ada Lovelace', THU[0], 1000), tx('Ada Lovelace', THU[1], 1400) ];
  const r = S.empTargetsFromTxns_(txns, 4, 999);
  _eq_('same-dow average +2.5%', r.targets['ada_lovelace'], 1230);
  _eq_('basis reported', r.detail['ada_lovelace'].basis, 'same-dow');
  _eq_('sample count is same-dow only', r.detail['ada_lovelace'].sampleCount, 2);
}

function test_sameDaySummed() {
  // Multiple transactions on one day roll up into that day, not separate samples.
  const txns = [ tx('Ada Lovelace', THU[0], 600), tx('Ada Lovelace', THU[0], 400),
                 tx('Ada Lovelace', THU[1], 1400) ];
  const r = S.empTargetsFromTxns_(txns, 4, 999);
  _eq_('two days, not three samples', r.detail['ada_lovelace'].sampleCount, 2);
  _eq_('day totals summed', r.targets['ada_lovelace'], 1230);
}

function test_fallbackWhenNoHistory() {
  // Nobody with history at all → empty result, the caller applies its own fallback.
  const r = S.empTargetsFromTxns_([], 4, 777);
  _eq_('no employees', Object.keys(r.targets).length, 0);
}

function test_unknownEmployeeSkipped() {
  const r = S.empTargetsFromTxns_([ { completedByUser: '', transactionDateLocalTime: THU[0] + 'T13:00:00', total: 500 } ], 4, 999);
  _eq_('unknown budtender excluded', Object.keys(r.targets).length, 0);
}

// ── The asymmetry that makes two targets non-comparable ─────────────
// This is the behaviour that made Pam's target exceed Jayden's. It is pinned
// here as CURRENT behaviour, not as desired behaviour — see the note in
// diagEmpTargets_. If this test starts failing, the fallback was changed on
// purpose and the assertion should move with it.
function test_allDaysFallbackInflatesOnASlowDow() {
  // Today is Thursday. Thursdays are slow; Wednesdays are busy.
  // Heavy: works every Thursday (3 samples) at 1000 → same-dow basis → 1025.
  // Light: worked ONE Thursday at 1000 plus busy Wednesdays at 2000 →
  //        only 1 same-dow sample → falls back to ALL days → average is
  //        pulled up by the Wednesdays → target lands ABOVE Heavy's.
  const txns = [];
  THU.forEach(d => txns.push(tx('Heavy Seller', d, 1000)));
  txns.push(tx('Light Seller', THU[0], 1000));
  WED.forEach(d => txns.push(tx('Light Seller', d, 2000)));

  const r = S.empTargetsFromTxns_(txns, 4, 0);
  const heavy = r.detail['heavy_seller'];
  const light = r.detail['light_seller'];

  _eq_('heavy uses same-dow', heavy.basis, 'same-dow');
  _eq_('light falls back to all-days', light.basis, 'all-days');
  _eq_('heavy target is its Thursday average', heavy.target, 1025);
  // Light: (1000 + 2000*4) / 5 = 1800 → ×1.025 → 1845
  _eq_('light target is a blended average', light.target, 1845);
  _ok_('the lighter Thursday seller gets the HIGHER Thursday target',
       light.target > heavy.target);
}

H.run('emp_targets', {
  test_sameDowAverage,
  test_sameDaySummed,
  test_fallbackWhenNoHistory,
  test_unknownEmployeeSkipped,
  test_allDaysFallbackInflatesOnASlowDow,
});
