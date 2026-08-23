// ============================================================
//  dutchie_fetch.gs — pure revenue/aggregation math
//
//  Ported from tests.gs (2026-08-22) so the suite runs under
//  node and gates `git push` via gx-preflight. Assertions are
//  unchanged from the editor versions.
//
//  Run:  node tests/dutchie_fetch_test.js
//
//  dutchie_proxy.gs is loaded alongside for ptNow_/STORE_TZ, and
//  discounts.gs for the budtender-discount classifier that
//  aggregateTransactions_ calls per transaction.
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_, _approx_ } = H;

const S = H.load(['dutchie_fetch.gs', 'dutchie_proxy.gs', 'discounts.gs']);

// ── Rounding ─────────────────────────────────────────────────
function test_rounding_() {
  _eq_('r2_ rounds down', S.r2_(1.234), 1.23);
  _eq_('r2_ rounds up',   S.r2_(1.236), 1.24);   // 1.236*100=123.6 (no FP ambiguity)
  _eq_('r1_ to 1dp',      S.r1_(1.27), 1.3);
  _eq_('r3_ to 3dp',      S.r3_(0.12345), 0.123);
  _eq_('r2_ zero',        S.r2_(0), 0);
  _eq_('r2_ negative',    S.r2_(-1.236), -1.24);
}

// ── initials_ ────────────────────────────────────────────────
function test_initials_() {
  _eq_('two-word initials',   S.initials_('Jon Juslen'), 'JJ');
  _eq_('single name',         S.initials_('Madonna'), 'M');
  _eq_('strips quotes',       S.initials_('"Bob" Smith'), 'BS');
  _eq_('caps max two',        S.initials_('a b c'), 'AB');
  _eq_('empty → empty',       S.initials_(''), '');
}

// ── tx numeric field extraction ──────────────────────────────
function test_txFields_() {
  _eq_('net prefers totalBeforeTax', S.txNet_({ totalBeforeTax: 100, subtotal: 999 }), 100);
  _eq_('net falls back to subtotal', S.txNet_({ subtotal: 50 }), 50);
  _eq_('net falls back to total',    S.txNet_({ total: 25 }), 25);
  _eq_('net default 0',              S.txNet_({}), 0);
  _eq_('discount totalDiscount',     S.txDiscount_({ totalDiscount: 5 }), 5);
  _eq_('discount discountTotal',     S.txDiscount_({ discountTotal: 3 }), 3);
  _eq_('discount default 0',         S.txDiscount_({}), 0);
  _eq_('subtotal = net + discount',  S.txSubtotal_({ totalBeforeTax: 100, totalDiscount: 20 }), 120);
}

// ── txEmployee_ ──────────────────────────────────────────────
function test_txEmployee_() {
  var e = S.txEmployee_({ completedByUser: 'Jon Juslen', employeeId: 7 });
  _eq_('emp name',     e.name, 'Jon Juslen');
  _eq_('emp id string', e.id, '7');
  _eq_('emp initials', e.initials, 'JJ');
  _eq_('emp unknown',  S.txEmployee_({}).name, 'Unknown');
}

// ── txItems_ ─────────────────────────────────────────────────
function test_txItems_() {
  _eq_('counts line items', S.txItems_({ items: [1, 2, 3] }), 3);
  _eq_('falls back totalItems', S.txItems_({ totalItems: 5 }), 5);
  _eq_('default 1', S.txItems_({}), 1);
}

// ── aggregateTransactions_ ───────────────────────────────────
function test_aggregateTransactions_() {
  var empty = S.aggregateTransactions_([]);
  _eq_('empty sales', empty.sales, 0);
  _eq_('empty txns',  empty.transactions, 0);
  _eq_('empty byEmployee', empty.byEmployee, {});

  var one = S.aggregateTransactions_([
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

  var two = S.aggregateTransactions_([
    { completedByUser: 'Ann Bee',  totalBeforeTax: 100, items: [1] },
    { completedByUser: 'Cy Dee',   totalBeforeTax: 60,  items: [1, 2, 3] }
  ]);
  _eq_('two total sales', two.sales, 160);
  _eq_('two emp count',   Object.keys(two.byEmployee).length, 2);
  _eq_('two UPT = 4/2',   two.avgUPT, 2);
}

// ── aggregateByDay_ ──────────────────────────────────────────
function test_aggregateByDay_() {
  var byDay = S.aggregateByDay_([
    { transactionDateLocalTime: '2026-05-20T14:00:00', totalBeforeTax: 100 },
    { transactionDateLocalTime: '2026-05-20T16:30:00', totalBeforeTax: 50 },
    { transactionDateLocalTime: '2026-05-21T10:00:00', totalBeforeTax: 30 }
  ]);
  _eq_('day 20 sums',  byDay['2026-05-20'], 150);
  _eq_('day 21',       byDay['2026-05-21'], 30);
  _eq_('ignores blank ts', S.aggregateByDay_([{ totalBeforeTax: 99 }]), {});
}

// ── aggregateByHour_ ─────────────────────────────────────────
function test_aggregateByHour_() {
  var byHour = S.aggregateByHour_([
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
  var t = S.trendFromByDay_(byDay);
  _eq_('trend30d length', t.trend30d.length, 14);
  _approx_('trendPct = +10%', t.trendPct, 0.1, 0.0005);

  _eq_('too few days → 0', S.trendFromByDay_({ '2020-01-01': 100 }).trendPct, 0);
}

H.run('dutchie_fetch', {
  test_rounding_, test_initials_, test_txFields_, test_txEmployee_, test_txItems_,
  test_aggregateTransactions_, test_aggregateByDay_, test_aggregateByHour_, test_trendFromByDay_,
});
