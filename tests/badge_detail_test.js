// ============================================================
//  badge_detail_test.js — trophy drill-down (Mike Kettler, 2026-11-02)
//  "Is it 3 transactions or 30?"  Run: node tests/badge_detail_test.js
//
//  Drives the shipped buildBadgeDetail_ over the same aggregateTransactions_ the trophies are
//  picked from, so the drill-down's headline must equal the trophy's by construction.
// ============================================================
const H = require('./_harness.js');
const { _eq_, _ok_ } = H;
const S = H.load(['endpoints.gs', 'dutchie_fetch.gs', 'dutchie_proxy.gs', 'discounts.gs', 'gx_roster.gs']);

function tx(name, when, net, nItems, disc) {
  return { completedByUser: name, transactionType: 'Retail', transactionDateLocalTime: when,
           totalBeforeTax: net, totalDiscount: disc || 0, totalItems: nItems };
}
const SAM = 'Sam Jones';
const txns = [
  tx(SAM, '2026-11-02T10:15:00', 50, 2),
  tx(SAM, '2026-11-02T14:40:00', 40, 3, 5),
  tx(SAM, '2026-11-01T09:05:00', 49.8, 1),
  tx('Other Person', '2026-11-02T11:00:00', 999, 9),
];

function test_headline_matches_trophy_() {
  const key = S.badgeEmpKey_(SAM);
  _eq_('key shape', key, 'sam_jones');
  const d = S.buildBadgeDetail_(txns, key, 'aov-avenger');
  const agg = S.aggregateTransactions_(txns).byEmployee[key];
  _eq_('ticket count is Sam\'s only', d.tickets, 3);
  _eq_('AOV metric equals the trophy\'s number', d.metric.value, '$' + agg.avgOrderValue);
  _eq_('other people\'s sales excluded', d.sales, 139.8);
}
function test_days_and_tickets_() {
  const d = S.buildBadgeDetail_(txns, 'sam_jones', 'the-closer');
  _eq_('closer metric is the count', d.metric.value, '3');
  _eq_('two days', d.days.length, 2);
  _eq_('newest day first', d.days[0].date, '2026-11-02');
  _eq_('that day: 2 tickets', d.days[0].tickets, 2);
  _eq_('that day: sales', d.days[0].sales, 90);
  _eq_('tickets newest first', d.txns[0].time, '14:40');
  _eq_('ticket count = rows', d.txns.length, 3);
  _eq_('ticket net', d.txns[0].net, 40);
  _eq_('not truncated', d.truncated, false);
}
function test_unknown_and_cap_() {
  const none = S.buildBadgeDetail_(txns, 'nobody', 'aov-avenger');
  _eq_('unknown holder has zero tickets', none.tickets, 0);
  const many = [];
  for (let i = 0; i < 200; i++) many.push(tx(SAM, '2026-11-02T10:' + String(i % 60).padStart(2, '0') + ':00', 10, 1));
  const d = S.buildBadgeDetail_(many, 'sam_jones', 'the-closer');
  _eq_('headline counts every ticket', d.tickets, 200);
  _eq_('list is capped', d.txns.length, 150);
  _eq_('cap is flagged', d.truncated, true);
}
function test_no_customer_or_pay_fields_() {
  const d = S.buildBadgeDetail_([Object.assign(tx(SAM, '2026-11-02T10:15:00', 50, 2), { customerId: 77, customerName: 'Jane Doe' })], 'sam_jones', 'aov-avenger');
  _ok_('no customer data leaks', JSON.stringify(d).indexOf('Jane') < 0 && JSON.stringify(d).indexOf('77') < 0);
}

H.run('badge_detail', { test_headline_matches_trophy_, test_days_and_tickets_, test_unknown_and_cap_, test_no_customer_or_pay_fields_ });
