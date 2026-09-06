// ============================================================
//  A FAILED DUTCHIE FETCH MUST NOT READ AS $0
//
//  Regression cover for the River Rd kiosk, 2026-09-05: from 2pm
//  to close the board showed $0 while Dutchie's own closing
//  report for the day read $7,251.27 over 167 transactions. The
//  execution log recorded no failure, because there wasn't one —
//  fetchTxnPagesByKey_ answered a non-200 with [], every caller
//  aggregated zero, and doGet returned a well-formed payload of
//  zeros. The morning's bars survived only because they were
//  already frozen to the hour snapshot.
//
//  What is asserted here is the DISTINCTION, not a number: an
//  empty day and a failed fetch must not produce the same value.
//
//  Run:  node tests/dutchie_unavailable_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

// ── A fake Dutchie ───────────────────────────────────────────
// One knob: what HTTP code every request comes back with. Real
// UrlFetchApp response objects only need getResponseCode and
// getContentText for this path.
const wire = { code: 200, body: '[]' };

function fakeResponse() {
  return {
    getResponseCode: function () { return wire.code; },
    getContentText:  function () { return wire.body; },
  };
}

const S = H.load(['dutchie_fetch.gs', 'dutchie_proxy.gs', 'discounts.gs'], {
  stubs: {
    UrlFetchApp: {
      fetchAll: function (reqs) { return reqs.map(fakeResponse); },
      fetch:    function () { return fakeResponse(); },
    },
    // getDutchieStoreKey_ reaches GX Core for the key map; short-circuit it with a cache hit on the
    // real cache key so these tests exercise the FETCH path and nothing else. Keyed by GX Core
    // store_id (not app slug) — that is the map GX Core hands back.
    CacheService: {
      getScriptCache: function () {
        return {
          get: function (k) {
            return k === 'gx_dutchie_keys'
              ? JSON.stringify({ 'river-rd': 'test-key', 'center': 'test-key', 'hillsboro': 'test-key',
                                 'bend': 'test-key', 'commercial': 'test-key', 'portland-rd': 'test-key' })
              : null;
          },
          put: function () {}, remove: function () {}, removeAll: function () {}, getAll: function () { return {}; },
        };
      },
      getUserCache: function () { return { get: function () { return null; }, put: function () {} }; },
      getDocumentCache: function () { return { get: function () { return null; }, put: function () {} }; },
    },
  },
});

const REQ = [{ key: 'river', storeKey: 'k', fromUTC: '2026-09-05T07:00:00Z', toUTC: '2026-09-06T06:59:59Z' }];

// ── A quiet day is not a failure ─────────────────────────────
function test_emptyDayIsNotAFailure_() {
  wire.code = 200; wire.body = '[]';
  const byKey = S.fetchTxnPagesByKey_(REQ);
  _eq_('200 + empty list → no rows', byKey.river.length, 0);
  _eq_('200 + empty list → NOT recorded as a failure', S.txnFetchFailures_().length, 0);
}

// ── A 429 is a failure, and says so ──────────────────────────
function test_rateLimitIsRecorded_() {
  wire.code = 429; wire.body = 'Too Many Requests';
  const byKey = S.fetchTxnPagesByKey_(REQ);
  _eq_('429 → still no rows (callers unchanged)', byKey.river.length, 0);
  _eq_('429 → recorded as a failure',             S.txnFetchFailures_().length, 1);
  _eq_('429 → names the key',                     S.txnFetchFailures_()[0].key, 'river');
  _ok_('429 → reason carries the code',           /429/.test(S.txnFetchFailures_()[0].why));
}

function test_unreadableBodyIsRecorded_() {
  wire.code = 200; wire.body = '<html>gateway timeout</html>';
  S.fetchTxnPagesByKey_(REQ);
  _eq_('unparseable 200 → recorded as a failure', S.txnFetchFailures_().length, 1);
  _ok_('unparseable 200 → says so', /unreadable/i.test(S.txnFetchFailures_()[0].why));
}

// ── The record resets per call ───────────────────────────────
// Otherwise one failure early in an execution would condemn every later fetch in it.
function test_failuresResetPerCall_() {
  wire.code = 500; wire.body = 'boom';
  S.fetchTxnPagesByKey_(REQ);
  _eq_('500 → one failure', S.txnFetchFailures_().length, 1);
  wire.code = 200; wire.body = '[]';
  S.fetchTxnPagesByKey_(REQ);
  _eq_('next good call clears the record', S.txnFetchFailures_().length, 0);
}

// ── The single-store path REFUSES to return a number it does not have ──
function test_singleStoreThrowsOnFailure_() {
  wire.code = 200; wire.body = '[]';
  let quiet = null;
  try { quiet = S.fetchStoreTransactions_('river', 'a', 'b'); } catch (e) { quiet = e; }
  _ok_('a genuinely empty day returns [], never throws', Array.isArray(quiet) && quiet.length === 0);

  wire.code = 429; wire.body = 'Too Many Requests';
  let threw = null;
  try { S.fetchStoreTransactions_('river', 'a', 'b'); } catch (e) { threw = e; }
  _ok_('a failed fetch throws instead of returning []', !!threw);
  _ok_('the throw is tagged as a data outage, not a bug', S.isDutchieUnavailable_(threw));
  _ok_('the throw names the store', /river/.test(String(threw.message)));
}

// ── The two cases must never collapse into one value ─────────
// This is the whole bug in one assertion.
function test_outageAndEmptyDayAreDistinguishable_() {
  wire.code = 200; wire.body = '[]';
  const emptyDay = S.fetchStoreTransactions_('river', 'a', 'b');

  wire.code = 503; wire.body = 'unavailable';
  let outage = 'DID NOT THROW';
  try { S.fetchStoreTransactions_('river', 'a', 'b'); } catch (e) { outage = 'threw'; }

  _eq_('empty day → an empty array', JSON.stringify(emptyDay), '[]');
  _eq_('outage    → a throw',        outage, 'threw');
  _ok_('the two are not the same answer', JSON.stringify(emptyDay) !== outage);
}

H.run('dutchie-unavailable', {
  test_emptyDayIsNotAFailure_,
  test_rateLimitIsRecorded_,
  test_unreadableBodyIsRecorded_,
  test_failuresResetPerCall_,
  test_singleStoreThrowsOnFailure_,
  test_outageAndEmptyDayAreDistinguishable_,
});
