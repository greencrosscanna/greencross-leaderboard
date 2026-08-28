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

// ── storeDowFactor_ ─────────────────────────────────────────────────
function test_storeDowFactorNeedsEvidence() {
  _eq_('no data → no scaling', S.storeDowFactor_({}, 4), 1);
  // One Thursday only — a single date is not a weekday shape.
  _eq_('one sample → no scaling', S.storeDowFactor_({ '2026-08-06': 5000 }, 4), 1);
}

function test_storeDowFactorMeasuresTheWeekday() {
  // Thursdays 1000, Wednesdays 3000. Overall mean of the two weekday averages is
  // 2000, so Thursday indexes at 0.5 and Wednesday at 1.5 (both at the clamp).
  const days = {};
  THU.forEach(d => days[d] = 1000);
  WED.forEach(d => days[d] = 3000);
  _eq_('slow weekday scales down', S.storeDowFactor_(days, 4), 0.5);
  _eq_('busy weekday scales up',   S.storeDowFactor_(days, 3), 1.5);
}

function test_storeDowFactorClamped() {
  // Thursday near zero against huge Wednesdays would be ~0 unscaled; the clamp
  // stops one freak day from erasing a target.
  const days = {};
  THU.forEach(d => days[d] = 1);
  WED.forEach(d => days[d] = 100000);
  _ok_('never below 0.5', S.storeDowFactor_(days, 4) >= 0.5);
  _ok_('never above 1.5', S.storeDowFactor_(days, 3) <= 1.5);
}

// ── The fix: an all-days fallback is aimed at today's weekday ────────
// The defect this closes is that a fallback target ignored the weekday entirely,
// so one person got the SAME number on a dead Sunday and a peak Saturday (on the
// live board, Jayden's Sun and Mon targets were both exactly $1,965). Note the
// fix deliberately does not promise any ordering between two employees — a
// stronger seller covering an unusual shift still gets the higher target, which
// is correct. What it promises is that the number now depends on the weekday.
function test_allDaysFallbackIsDowScaled() {
  const txns = [];
  THU.forEach(d => txns.push(tx('Heavy Seller', d, 1000)));   // Thursdays are the slow day
  txns.push(tx('Light Seller', THU[0], 1000));                // one Thursday → falls back
  WED.forEach(d => txns.push(tx('Light Seller', d, 2000)));

  const r     = S.empTargetsFromTxns_(txns, 4, 0);
  const light = r.detail['light_seller'];

  _eq_('scaled, and says so', light.basis, 'all-days-dow-scaled');
  _ok_('aimed down toward the slow weekday', light.dowFactor < 1);
  _ok_('scaled below the raw blend', light.target < Math.round(light.rawAvgDaily * 1.025));
  _eq_('heavy is untouched', r.detail['heavy_seller'].target, 1025);
}

function test_fallbackTargetVariesByWeekday() {
  // The regression that matters: the same person, same history, asked for a slow
  // weekday and a busy one, must not come back with the identical number.
  const txns = [];
  THU.forEach(d => txns.push(tx('Heavy Seller', d, 1000)));
  WED.forEach(d => txns.push(tx('Heavy Seller', d, 3000)));
  txns.push(tx('Light Seller', THU[0], 1500));                 // 1 Thu, 0 Wed → always falls back

  const thu = S.empTargetsFromTxns_(txns, 4, 0).detail['light_seller'];
  const wed = S.empTargetsFromTxns_(txns, 3, 0).detail['light_seller'];

  _eq_('same raw history both times', thu.rawAvgDaily, wed.rawAvgDaily);
  _eq_('falls back on Thursday', thu.basis, 'all-days-dow-scaled');
  _eq_('falls back on Wednesday', wed.basis, 'all-days-dow-scaled');
  _ok_('the slow weekday asks for less than the busy one', thu.target < wed.target);
}

function test_sameDowTargetsAreNeverScaled() {
  // The fix must not move anybody who has real same-weekday history — that is
  // every employee on a day they normally work.
  const txns = [];
  THU.forEach(d => txns.push(tx('Ada Lovelace', d, 1000)));
  WED.forEach(d => txns.push(tx('Ada Lovelace', d, 4000)));   // skews the store weekday shape
  const r = S.empTargetsFromTxns_(txns, 4, 0);
  _eq_('same-dow basis', r.detail['ada_lovelace'].basis, 'same-dow');
  _eq_('factor recorded as 1', r.detail['ada_lovelace'].dowFactor, 1);
  _eq_('target is the plain Thursday average', r.targets['ada_lovelace'], 1025);
}

H.run('emp_targets', {
  test_sameDowAverage,
  test_sameDaySummed,
  test_fallbackWhenNoHistory,
  test_unknownEmployeeSkipped,
  test_storeDowFactorNeedsEvidence,
  test_storeDowFactorMeasuresTheWeekday,
  test_storeDowFactorClamped,
  test_allDaysFallbackIsDowScaled,
  test_fallbackTargetVariesByWeekday,
  test_sameDowTargetsAreNeverScaled,
});
