// ============================================================
//  endpoints.gs — the two kiosk hero surfaces that quietly lied
//
//  Both bugs shipped, both were reported off the kiosk, and both are
//  invisible to every other suite because they live inside getStoreToday:
//
//   1. BIGGEST SALE had no floor. It was an unconditional max over the
//      day's transactions, so a slow morning crowned a $68 ticket with
//      the trophy. The banner and the card flame have always used
//      bigMin (GC.THRESHOLDS.bigTransactionMin); the trophy didn't.
//
//   2. TODAY BY HOUR froze zeros. Completed hours are snapshotted so a
//      settled bar can't drift — but a failed Dutchie call returns []
//      (fetchTxnPagesByKey_ swallows a non-200), which is indistinguishable
//      from a quiet hour, so an outage locked $0 into 12p/1p/2p for the
//      rest of the day even after the sales came back.
//
//  Run:  node tests/kiosk_hero_test.js
//
//  getStoreToday is driven for real — the transactions are stubbed at
//  fetchStoreTransactions_ and everything downstream (aggregateByHour_,
//  txTotal_, the freeze loop, the trophy scan) is the shipped code.
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

// ── An in-memory Script Properties, so the freeze can actually persist
// across calls the way it does in production. The base stub is inert
// (getProperty always null), which would make every freeze assertion
// vacuous — the hour would look "not yet frozen" every single time.
const store_ = Object.create(null);
const memProps = {
  getProperty:    function (k) { return Object.prototype.hasOwnProperty.call(store_, k) ? store_[k] : null; },
  setProperty:    function (k, v) { store_[k] = String(v); return this; },
  deleteProperty: function (k) { delete store_[k]; return this; },
  getProperties:  function () { return Object.assign({}, store_); },
  setProperties:  function (o) { Object.keys(o).forEach(function (k) { store_[k] = String(o[k]); }); return this; },
};

const S = H.load(['endpoints.gs', 'dutchie_proxy.gs', 'dutchie_fetch.gs'], {
  stubs: {
    PropertiesService: {
      getScriptProperties:   function () { return memProps; },
      getUserProperties:     function () { return memProps; },
      getDocumentProperties: function () { return memProps; },
    },
    // Not in the loaded files, so these resolve to the sandbox globals.
    getNicknames_:      function () { return {}; },
    getDailyGoal_:      function () { return 5000; },
    getDailyGoalForDow_: function () { return 5000; },
    gxIsExcluded_:      function () { return false; },
  },
  // fetchStoreTransactions_ IS in a loaded file, so a global stub would be
  // shadowed by its declaration. Reassign the binding from inside instead.
  extraExports:
    '"setTxns": function (rows) { fetchStoreTransactions_ = function () { return rows; }; },' +
    '"resetCaches": function () { _propsCache_ = null; _ppStartCache_ = null; }',
});

const STORE = { slug: 'century', name: 'Century' };

/** One retail transaction at a PT wall-clock hour, for `total` dollars. */
function txn(hour, minute, total, who) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return {
    transactionType:        'Retail',
    transactionDateLocalTime: '2026-08-31T' + hh + ':' + mm + ':00',
    transactionDate:        '2026-08-31T' + hh + ':' + mm + ':00',
    total:                  total,
    totalBeforeTax:         total,
    subtotal:               total,
    employeeId:             who || 'emp-1',
    employeeName:           who || 'Tyler G',
    itemsSold:              [{ productName: 'Flower 1g', totalPrice: total, quantity: 1 }],
  };
}

/** Freeze the clock at a PT hour on 2026-08-31 and clear per-run memos. */
function atPT(hour, minute) {
  // 2026-08-31 is PDT (UTC-7).
  H.setNow(Date.UTC(2026, 7, 31, hour + 7, minute || 0, 0));
  S.resetCaches();
}

function hourRow(res, label) {
  return (res.hourly || []).filter(function (h) { return h.hour === label; })[0];
}

// ── 1. The Biggest Sale trophy has a floor ───────────────────
function test_trophy_floor() {
  atPT(16, 2);                       // 4:02pm — the hour the bug was reported in
  S.setTxns([txn(9, 15, 40), txn(11, 30, 68), txn(15, 44, 33)]);
  var res = S.getStoreToday(STORE, {});
  _eq_('a $68 day crowns nobody', res.topSale, null);

  atPT(16, 2);
  S.setTxns([txn(9, 15, 40), txn(11, 30, 99.99), txn(15, 44, 33)]);
  _eq_('a cent under the bar is still under it', S.getStoreToday(STORE, {}).topSale, null);

  atPT(16, 2);
  S.setTxns([txn(9, 15, 40), txn(11, 30, 100), txn(15, 44, 33)]);
  var at100 = S.getStoreToday(STORE, {}).topSale;
  _ok_('exactly $100 clears it', at100 && at100.price === 100);

  atPT(16, 2);
  S.setTxns([txn(9, 15, 250), txn(11, 30, 68), txn(15, 44, 140)]);
  var best = S.getStoreToday(STORE, {}).topSale;
  _ok_('still the DAY\'s best, not the newest', best && best.price === 250);
}

// ── 2. The floor rides in from the client, one source ────────
function test_trophy_floor_is_the_clients() {
  atPT(16, 2);
  S.setTxns([txn(11, 30, 68)]);
  var lowBar = S.getStoreToday(STORE, { bigMin: 50 }).topSale;
  _ok_('a caller-supplied bigMin moves the trophy floor too', lowBar && lowBar.price === 68);

  atPT(16, 2);
  S.setTxns([txn(11, 30, 150)]);
  _eq_('...in both directions', S.getStoreToday(STORE, { bigMin: 200 }).topSale, null);
}

// ── 3. An outage must not lock $0 into a finished hour ───────
function test_outage_does_not_freeze_zero() {
  Object.keys(store_).forEach(function (k) { delete store_[k]; });

  // 1pm: Dutchie is down, so the fetch returns nothing. Hours 8..12 are
  // complete and all read $0 — exactly the state that used to be permanent.
  atPT(13, 5);
  S.setTxns([]);
  var duringOutage = S.getStoreToday(STORE, {});
  _eq_('during the outage the bar is empty', hourRow(duringOutage, '11a').revenue, 0);

  // 3pm: Dutchie is back and the morning's sales are in the payload.
  atPT(15, 5);
  S.setTxns([txn(11, 15, 300), txn(11, 45, 120), txn(14, 20, 500)]);
  var afterRecovery = S.getStoreToday(STORE, {});
  _eq_('the 11a hour comes back after recovery', hourRow(afterRecovery, '11a').revenue, 420);
  _eq_('and the hour that happened during the outage window too',
       hourRow(afterRecovery, '2p').revenue, 500);

  // And it stays back — the recovered value is what freezes.
  atPT(16, 5);
  S.setTxns([txn(11, 15, 300), txn(11, 45, 120), txn(14, 20, 500)]);
  _eq_('the healed hour is now frozen at the real number',
       hourRow(S.getStoreToday(STORE, {}), '11a').revenue, 420);
}

// ── 4. ...without un-fixing the bug the freeze exists for ────
// A settled hour still must not drift when late txns/returns re-aggregate.
function test_nonzero_hours_still_freeze() {
  Object.keys(store_).forEach(function (k) { delete store_[k]; });

  atPT(13, 5);
  S.setTxns([txn(11, 15, 300)]);
  _eq_('11a snapshots at $300', hourRow(S.getStoreToday(STORE, {}), '11a').revenue, 300);

  // A late-settling txn and a return both land on the finished hour.
  atPT(14, 5);
  S.setTxns([txn(11, 15, 300), txn(11, 50, 90)]);
  _eq_('a late txn does NOT move a settled hour',
       hourRow(S.getStoreToday(STORE, {}), '11a').revenue, 300);

  atPT(15, 5);
  S.setTxns([txn(11, 15, 300), txn(11, 50, 90), txn(11, 55, -150)]);
  _eq_('nor does a return',
       hourRow(S.getStoreToday(STORE, {}), '11a').revenue, 300);

  // The CURRENT hour is still live.
  atPT(15, 30);
  S.setTxns([txn(11, 15, 300), txn(15, 10, 75)]);
  _eq_('the current hour stays live', hourRow(S.getStoreToday(STORE, {}), '3p').revenue, 75);
}

// ── 5. A genuinely empty hour reads $0 and keeps reading $0 ──
function test_a_real_zero_hour_is_still_zero() {
  Object.keys(store_).forEach(function (k) { delete store_[k]; });

  atPT(13, 5);
  S.setTxns([txn(9, 15, 200)]);          // nothing at all in the 11a hour
  _eq_('an empty hour reads $0', hourRow(S.getStoreToday(STORE, {}), '11a').revenue, 0);

  atPT(14, 5);
  S.setTxns([txn(9, 15, 200)]);
  _eq_('and still does on the next poll', hourRow(S.getStoreToday(STORE, {}), '11a').revenue, 0);
}

try {
  H.run('kiosk_hero', {
    test_trophy_floor,
    test_trophy_floor_is_the_clients,
    test_outage_does_not_freeze_zero,
    test_nonzero_hours_still_freeze,
    test_a_real_zero_hour_is_still_zero,
  });
} finally {
  H.setNow(null);
}
