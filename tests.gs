// ============================================================
//  Green Cross — Backend Test Suite  (tests.gs)
//
//  Self-contained unit tests for the pure (no network, no
//  ScriptProperties-write) functions where a silent bug would
//  corrupt revenue numbers, goals, or leaderboard rankings.
//
//  HOW TO RUN:
//    1. Open the project in the Apps Script editor.
//    2. Select  runAllTests  in the function dropdown.
//    3. Click Run, then View → Logs (or Executions) for the
//       PASS/FAIL summary.
//
//  These functions are never called by doGet — shipping them in
//  the project is harmless and makes the suite runnable in place.
// ============================================================

// ── Manual diagnostic (hits the Dutchie API — run from the editor) ───────────
// Prints, per store: actual MTD sales vs the new DOW-weighted "expected by now"
// bar, the resulting vs-plan %, and whether the behind-plan alert would fire.
// Use this to sanity-check the alert proration against live numbers.
function diagAlertProration() {
  var range   = getDateRange_('mtd');
  var byStore  = fetchAllStoresTransactions_(range);
  var pt       = ptNow_();
  var dim      = new Date(Date.UTC(pt.year, pt.month + 1, 0)).getUTCDate();
  var lines    = ['MTD ' + pt.dateStr + ' — ' + (pt.day - 1) +
                  ' completed day(s) of ' + dim + ' in month  (today excluded from "expected")'];
  STORES.forEach(function(store) {
    var agg      = aggregateTransactions_(byStore[store.slug] || []);
    var expected = getProratedMonthGoalToDate_(store.slug);
    var monthly  = getMonthlyGoal_(store.slug);
    var vsplan   = expected > 0 ? Math.round((agg.sales - expected) / expected * 100) : null;
    lines.push(
      store.name +
      ': actual $' + Math.round(agg.sales) +
      '  |  expected $' + expected +
      '  |  vs plan ' + (vsplan === null ? 'n/a' : (vsplan > 0 ? '+' : '') + vsplan + '%') +
      (vsplan !== null && vsplan < -5 ? '  ⚠ FLAG' : '  ✓ ok') +
      '  |  full-month goal $' + monthly
    );
  });
  Logger.log(lines.join('\n'));
  return lines;
}

// ── Manual diagnostic: per-store 30-day retail counts ────────────────────────
// Sanity-checks the single-fetch behavior. Counts well above DUTCHIE_TAKE prove
// Dutchie returns the full result set in one call (no hard cap). A count of
// EXACTLY DUTCHIE_TAKE would indicate a real cap that needs date-window splitting.
function diagPagination() {
  var r       = getDateRange_('30d');
  var byStore  = fetchAllStoresTransactions_(r);
  var lines    = ['30-day fetch ' + r.fromLocal + ' → ' + r.toLocal +
                  '  (Take=' + DUTCHIE_TAKE + ')'];
  STORES.forEach(function(store) {
    var n = (byStore[store.slug] || []).length;
    lines.push(store.name + ': ' + n + ' retail txns' +
      (n === DUTCHIE_TAKE ? '  ⚠ exactly at cap — possible truncation' :
       n > DUTCHIE_TAKE   ? '  ✓ full set returned in one call (no cap)' : ''));
  });
  Logger.log(lines.join('\n'));
  return lines;
}

// ── Tiny assertion harness ───────────────────────────────────
var _T_PASS = 0, _T_FAIL = 0, _T_LOG = [];

function _eq_(name, actual, expected) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { _T_PASS++; }
  else { _T_FAIL++; _T_LOG.push('✗ ' + name + '\n    expected: ' + e + '\n    actual:   ' + a); }
}

function _ok_(name, cond) {
  if (cond) { _T_PASS++; }
  else { _T_FAIL++; _T_LOG.push('✗ ' + name + ' (expected truthy)'); }
}

function _approx_(name, actual, expected, eps) {
  if (Math.abs(actual - expected) <= (eps || 1e-9)) { _T_PASS++; }
  else { _T_FAIL++; _T_LOG.push('✗ ' + name + '\n    expected ≈ ' + expected + '\n    actual:    ' + actual); }
}

function runAllTests() {
  _T_PASS = 0; _T_FAIL = 0; _T_LOG = [];
  // Reset request-scope memo so PP helpers compute fresh.
  _ppStartCache_ = null;

  test_rounding_();
  test_initials_();
  test_nameToKey_();
  test_txFields_();
  test_txEmployee_();
  test_txItems_();
  test_aggregateTransactions_();
  test_aggregateByDay_();
  test_aggregateByHour_();
  test_trendFromByDay_();
  test_getDateRange_();
  test_currentPPStart_();
  test_dowCountsThroughDay_();

  var total = _T_PASS + _T_FAIL;
  var header = (_T_FAIL === 0 ? '✅ ALL PASS' : '❌ ' + _T_FAIL + ' FAILED')
    + '  (' + _T_PASS + '/' + total + ')';
  Logger.log(header + (_T_LOG.length ? '\n\n' + _T_LOG.join('\n') : ''));
  return { pass: _T_PASS, fail: _T_FAIL, total: total };
}

// ── Rounding ─────────────────────────────────────────────────
function test_rounding_() {
  _eq_('r2_ rounds down', r2_(1.234), 1.23);
  _eq_('r2_ rounds up',   r2_(1.236), 1.24);   // 1.236*100=123.6 (no FP ambiguity)
  _eq_('r1_ to 1dp',      r1_(1.27), 1.3);
  _eq_('r3_ to 3dp',      r3_(0.12345), 0.123);
  _eq_('r2_ zero',        r2_(0), 0);
  _eq_('r2_ negative',    r2_(-1.236), -1.24);
}

// ── initials_ ────────────────────────────────────────────────
function test_initials_() {
  _eq_('two-word initials',   initials_('Jon Juslen'), 'JJ');
  _eq_('single name',         initials_('Madonna'), 'M');
  _eq_('strips quotes',       initials_('"Bob" Smith'), 'BS');
  _eq_('caps max two',        initials_('a b c'), 'AB');
  _eq_('empty → empty',       initials_(''), '');
}

// ── nameToKey_ ───────────────────────────────────────────────
function test_nameToKey_() {
  _eq_('basic key',           nameToKey_('Jon Juslen'), 'jon_juslen');
  _eq_('strips apostrophe+dot', nameToKey_("D'Angelo St. James"), 'dangelo_st_james');
  _eq_('empty → empty',       nameToKey_(''), '');
  _eq_('null → empty',        nameToKey_(null), '');
}

// ── tx numeric field extraction ──────────────────────────────
function test_txFields_() {
  _eq_('net prefers totalBeforeTax', txNet_({ totalBeforeTax: 100, subtotal: 999 }), 100);
  _eq_('net falls back to subtotal', txNet_({ subtotal: 50 }), 50);
  _eq_('net falls back to total',    txNet_({ total: 25 }), 25);
  _eq_('net default 0',              txNet_({}), 0);
  _eq_('discount totalDiscount',     txDiscount_({ totalDiscount: 5 }), 5);
  _eq_('discount discountTotal',     txDiscount_({ discountTotal: 3 }), 3);
  _eq_('discount default 0',         txDiscount_({}), 0);
  _eq_('subtotal = net + discount',  txSubtotal_({ totalBeforeTax: 100, totalDiscount: 20 }), 120);
}

// ── txEmployee_ ──────────────────────────────────────────────
function test_txEmployee_() {
  var e = txEmployee_({ completedByUser: 'Jon Juslen', employeeId: 7 });
  _eq_('emp name',     e.name, 'Jon Juslen');
  _eq_('emp id string', e.id, '7');
  _eq_('emp initials', e.initials, 'JJ');
  _eq_('emp unknown',  txEmployee_({}).name, 'Unknown');
}

// ── txItems_ ─────────────────────────────────────────────────
function test_txItems_() {
  _eq_('counts line items', txItems_({ items: [1, 2, 3] }), 3);
  _eq_('falls back totalItems', txItems_({ totalItems: 5 }), 5);
  _eq_('default 1', txItems_({}), 1);
}

// ── aggregateTransactions_ ───────────────────────────────────
function test_aggregateTransactions_() {
  var empty = aggregateTransactions_([]);
  _eq_('empty sales', empty.sales, 0);
  _eq_('empty txns',  empty.transactions, 0);
  _eq_('empty byEmployee', empty.byEmployee, {});

  var one = aggregateTransactions_([
    { completedByUser: 'Ann Bee', totalBeforeTax: 100, totalDiscount: 20, items: [1, 2] }
  ]);
  _eq_('one sales',        one.sales, 100);
  _eq_('one txns',         one.transactions, 1);
  _eq_('one AOV',          one.avgOrderValue, 100);
  _eq_('one UPT',          one.avgUPT, 2);
  _eq_('one totalDiscounts', one.totalDiscounts, 20);
  _approx_('one discountRate = 20/120', one.discountRate, 0.167, 0.001);
  _eq_('one emp sales',    one.byEmployee.ann_bee.sales, 100);
  _eq_('one emp items',    one.byEmployee.ann_bee.items, 2);

  var two = aggregateTransactions_([
    { completedByUser: 'Ann Bee',  totalBeforeTax: 100, items: [1] },
    { completedByUser: 'Cy Dee',   totalBeforeTax: 60,  items: [1, 2, 3] }
  ]);
  _eq_('two total sales', two.sales, 160);
  _eq_('two emp count',   Object.keys(two.byEmployee).length, 2);
  _eq_('two UPT = 4/2',   two.avgUPT, 2);
}

// ── aggregateByDay_ ──────────────────────────────────────────
function test_aggregateByDay_() {
  var byDay = aggregateByDay_([
    { transactionDateLocalTime: '2026-05-20T14:00:00', totalBeforeTax: 100 },
    { transactionDateLocalTime: '2026-05-20T16:30:00', totalBeforeTax: 50 },
    { transactionDateLocalTime: '2026-05-21T10:00:00', totalBeforeTax: 30 }
  ]);
  _eq_('day 20 sums',  byDay['2026-05-20'], 150);
  _eq_('day 21',       byDay['2026-05-21'], 30);
  _eq_('ignores blank ts', aggregateByDay_([{ totalBeforeTax: 99 }]), {});
}

// ── aggregateByHour_ ─────────────────────────────────────────
function test_aggregateByHour_() {
  var byHour = aggregateByHour_([
    { transactionDateLocalTime: '2026-05-20T14:00:03', totalBeforeTax: 100 },
    { transactionDateLocalTime: '2026-05-20T14:55:00', totalBeforeTax: 40 },
    { transactionDateLocalTime: '2026-05-20T09:10:00', totalBeforeTax: 25 }
  ]);
  _eq_('hour 14 revenue', byHour[14].revenue, 140);
  _eq_('hour 14 count',   byHour[14].count, 2);
  _eq_('hour 9 revenue',  byHour[9].revenue, 25);
}

// ── trendFromByDay_ ──────────────────────────────────────────
function test_trendFromByDay_() {
  // 14 historical days (all < today): first 7 @ $100, last 7 @ $110.
  // last7 sum = 770, prior7 sum = 700 → trendPct = (770-700)/700 = 0.1
  var byDay = {};
  for (var i = 1; i <= 7;  i++) byDay['2020-01-' + ('0' + i).slice(-2)] = 100;
  for (var j = 8; j <= 14; j++) byDay['2020-01-' + ('0' + j).slice(-2)] = 110;
  var t = trendFromByDay_(byDay);
  _eq_('trend30d length', t.trend30d.length, 14);
  _approx_('trendPct = +10%', t.trendPct, 0.1, 0.0005);

  _eq_('too few days → 0', trendFromByDay_({ '2020-01-01': 100 }).trendPct, 0);
}

// ── getDateRange_ ────────────────────────────────────────────
function test_getDateRange_() {
  var pp = getDateRange_('pp');
  // The RANGE is correct: end-of-day-14 minus start-of-day-1 = 14 days − 1 ms.
  var spanMs = new Date(pp.toUTC).getTime() - new Date(pp.fromUTC).getTime();
  _approx_('pp UTC span = 14 days', spanMs, 14 * 24 * 60 * 60 * 1000 - 1, 2);
  _ok_('pp from <= to',     pp.fromLocal <= pp.toLocal);
  _eq_('pp period label',   pp.period, 'pp');
  _eq_('pp totalDays = 14', pp.totalDays, 14);   // off-by-one fixed (was 15)

  var today = getDateRange_('today');
  _eq_('today from === to', today.fromLocal, today.toLocal);

  var mtd = getDateRange_('mtd');
  _ok_('mtd starts on the 1st', /-01$/.test(mtd.fromLocal));
  _eq_('mtd period label', mtd.period, 'mtd');
}

// ── currentPPStart_ ──────────────────────────────────────────
function test_currentPPStart_() {
  _ppStartCache_ = null;
  var pp = currentPPStart_();
  _eq_('PP_MS = 14 days', pp.PP_MS, 14 * 24 * 60 * 60 * 1000);
  _ok_('ppStartMs positive', typeof pp.ppStartMs === 'number' && pp.ppStartMs > 0);

  // Today should fall within [ppStart, ppStart + 14 days)
  var todayMs = ptDateToUtcMs_(ptNow_().dateStr);
  var offset  = todayMs - pp.ppStartMs;
  _ok_('today within current PP', offset >= 0 && offset < pp.PP_MS);
}

// ── dowCountsThroughDay_ (DOW counting for alert proration) ──
function test_dowCountsThroughDay_() {
  function sum(o) { var t = 0; for (var d = 0; d <= 6; d++) t += o[d]; return t; }
  // June 2026 has 30 days.
  _eq_('counts to day 10 sum to 10', sum(dowCountsThroughDay_(2026, 5, 10)), 10);
  _eq_('counts to day 30 sum to 30', sum(dowCountsThroughDay_(2026, 5, 30)), 30);
  _eq_('clamps past month end',      sum(dowCountsThroughDay_(2026, 5, 100)), 30);
  // Feb 2026 (non-leap) has 28 days.
  _eq_('clamps Feb to 28',           sum(dowCountsThroughDay_(2026, 1, 40)), 28);
  // Each bucket non-negative and ≤ 5 (no DOW occurs >5× in a ≤10-day window).
  var c = dowCountsThroughDay_(2026, 5, 10);
  _ok_('buckets sane', [0,1,2,3,4,5,6].every(function(d){ return c[d] >= 0 && c[d] <= 5; }));
}
