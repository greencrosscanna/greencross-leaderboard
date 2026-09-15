// ============================================================
//  THE DIRECTOR REFRESH MUST NOT CROWD THE SHARED ACCOUNT
//
//  Every GX web app and trigger runs as one Google account, capped
//  at 30 simultaneous executions. On 2026-09-15 refreshDirectorCache
//  ran 48 times in under four hours for 5,983s, individual runs 1 to
//  7.5 minutes, overlapping — and Sales, SPIFF and Crew waited behind
//  it. The live log showed why: each run downloaded TODAY's detailed
//  transactions from Dutchie about five times (~20s apiece), and made
//  a CacheService round trip per store per settled day.
//
//  What is asserted is the COST, counted at the wire:
//    • inside one build, the same store + window is downloaded once;
//    • a failed download is not remembered, so it is still retried
//      and still reported;
//    • outside a build nothing is remembered (a warm instance must
//      never serve a kiosk an earlier request's sales);
//    • settled days are read from cache in one batched call;
//    • a refresh that finds one already running leaves at once;
//    • the trigger and the directorall route share one TTL.
//
//  Run:  node tests/director_refresh_load_test.js
// ============================================================

const fs = require('fs');
const path = require('path');
const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

const KEYS = JSON.stringify({ 'river-rd': 'k-river', 'center': 'k-center', 'hillsboro': 'k-hills',
                              'bend': 'k-bend', 'commercial': 'k-comm', 'portland-rd': 'k-portland' });

const wire = { urls: [], failUntil: 0 };
const cacheLog = { get: 0, getAll: 0, put: 0, putAll: 0 };
const store = {};

function fakeResponse(req) {
  wire.urls.push(req.url);
  const failing = wire.failUntil > 0;
  if (failing) wire.failUntil--;
  return {
    getResponseCode: function () { return failing ? 500 : 200; },
    getContentText:  function () { return failing ? 'boom' : JSON.stringify([
      { transactionType: 'Retail', totalBeforeTax: 10, completedByUser: 'A B', transactionDateLocalTime: '2026-09-15T12:00:00' },
    ]); },
  };
}

const userLock = { free: true, released: 0 };

const stubs = {
  UrlFetchApp: {
    fetchAll: function (reqs) { return reqs.map(fakeResponse); },
    fetch:    function (r) { return fakeResponse({ url: String(r) }); },
  },
  CacheService: {
    getScriptCache: function () {
      return {
        get: function (k) {
          if (k === 'gx_dutchie_keys') return KEYS;
          cacheLog.get++;
          return store[k] || null;
        },
        getAll: function (ks) { cacheLog.getAll++; const o = {}; ks.forEach(function (k) { if (store[k]) o[k] = store[k]; }); return o; },
        put:    function (k, v) { cacheLog.put++; store[k] = v; },
        putAll: function (m) { cacheLog.putAll++; Object.keys(m).forEach(function (k) { store[k] = m[k]; }); },
        remove: function () {}, removeAll: function () {},
      };
    },
    getUserCache: function () { return { get: function () { return null; }, put: function () {} }; },
    getDocumentCache: function () { return { get: function () { return null; }, put: function () {} }; },
  },
  LockService: {
    getScriptLock: function () { throw new Error('refreshDirectorCache must not take the SCRIPT lock (bug mail waits on it)'); },
    getUserLock: function () {
      return {
        tryLock: function () { if (!userLock.free) return false; userLock.free = false; return true; },
        releaseLock: function () { userLock.free = true; userLock.released++; },
      };
    },
  },
};

const S = H.load(['dutchie_fetch.gs', 'dutchie_proxy.gs', 'discounts.gs', 'cache.gs'], { stubs: stubs });

// Tue 2026-09-15 14:00 PT — past 6am, so everything before today is settled.
H.setNow(Date.UTC(2026, 8, 15, 21, 0, 0));

const TODAY = { key: 'river', storeKey: 'k', fromUTC: '2026-09-15T07:00:00.000Z', toUTC: '2026-09-16T06:59:59.999Z' };
function reset_() { wire.urls = []; wire.failUntil = 0; }

// ── The memo is scoped to a build ────────────────────────────
function test_sameWindowTwiceIsOneDownloadInsideABuild_() {
  reset_();
  S.withTxnMemo_(function () {
    S.fetchTxnPagesByKey_([TODAY]);
    const again = S.fetchTxnPagesByKey_([Object.assign({}, TODAY, { key: 'other-bucket' })]);
    _eq_('second ask answered under the caller\'s own key', again['other-bucket'].length, 1);
  });
  _eq_('inside a build: one download', wire.urls.length, 1);
}

function test_outsideABuildNothingIsRemembered_() {
  reset_();
  S.withTxnMemo_(function () { S.fetchTxnPagesByKey_([TODAY]); });
  S.fetchTxnPagesByKey_([TODAY]);
  S.fetchTxnPagesByKey_([TODAY]);
  _eq_('scope closed → every later call goes to Dutchie', wire.urls.length, 3);
}

function test_nestedScopeDoesNotCloseTheOuterOne_() {
  reset_();
  S.withTxnMemo_(function () {
    S.withTxnMemo_(function () { S.fetchTxnPagesByKey_([TODAY]); });
    S.fetchTxnPagesByKey_([TODAY]);
  });
  _eq_('inner scope ending keeps the outer memo', wire.urls.length, 1);
}

function test_aFailureIsRetriedAndStillReported_() {
  reset_();
  wire.failUntil = 2;
  S.withTxnMemo_(function () {
    S.fetchTxnPagesByKey_([TODAY]);
    _eq_('first failure reported', S.txnFetchFailures_().length, 1);
    S.fetchTxnPagesByKey_([TODAY]);
    _eq_('a remembered failure would hide this one', S.txnFetchFailures_().length, 1);
    S.fetchTxnPagesByKey_([TODAY]);
    _eq_('recovered on the third ask', S.txnFetchFailures_().length, 0);
  });
  _eq_('failures are not memoized: three trips', wire.urls.length, 3);
}

// ── The per-store aggregate ──────────────────────────────────
function test_settledDaysReadInOneBatch_() {
  reset_();
  Object.keys(store).forEach(function (k) { delete store[k]; });
  const range = { fromUTC: '2026-09-13T07:00:00.000Z', toUTC: '2026-09-16T06:59:59.999Z' };   // 13th..15th
  S.byStoreAggCached_(range, false);                    // cold: 2 settled days + today, all live
  const nStores = S.STORES.length;
  _eq_('cold: every store-day downloaded', wire.urls.length, 3 * nStores);

  reset_();
  cacheLog.get = 0; cacheLog.getAll = 0; cacheLog.put = 0;
  S.byStoreAggCached_(range, false);                    // warm: only today live
  _eq_('warm: only today downloaded', wire.urls.length, nStores);
  _eq_('warm: settled days read in ONE getAll', cacheLog.getAll, 1);
  _eq_('warm: no per-day cache.get', cacheLog.get, 0);
  _eq_('warm: no per-day cache.put', cacheLog.put, 0);
}

function test_sameRangeTwiceInABuildIsAssembledOnce_() {
  reset_();
  const range = { fromUTC: '2026-09-15T07:00:00.000Z', toUTC: '2026-09-16T06:59:59.999Z' };
  let a, b;
  S.withTxnMemo_(function () { a = S.byStoreAggCached_(range, false); b = S.byStoreAggCached_(range, false); });
  _eq_('one download of today per store', wire.urls.length, S.STORES.length);
  _eq_('same answer both times', JSON.stringify(a), JSON.stringify(b));
}

function test_unavailableStoreIsReplayedFromTheMemo_() {
  reset_();
  const range = { fromUTC: '2026-09-15T07:00:00.000Z', toUTC: '2026-09-16T06:59:59.999Z' };
  S.withTxnMemo_(function () {
    wire.failUntil = 1;                                  // the first store of the batch fails
    S.resetStoresUnavailable_();
    S.byStoreAggCached_(range, false);
    const first = Object.keys(S.storesUnavailable_()).length;
    S.resetStoresUnavailable_();                         // what the next build does first
    S.byStoreAggCached_(range, false);
    _eq_('first build: one store unavailable', first, 1);
    _eq_('second build from memo: still unavailable, not a confident $0', Object.keys(S.storesUnavailable_()).length, 1);
  });
}

// ── The trigger ──────────────────────────────────────────────
function test_refreshLeavesAtOnceWhenOneIsRunning_() {
  reset_();
  userLock.free = false;                                 // a previous run holds it
  let threw = null;
  try { S.refreshDirectorCache(); } catch (e) { threw = e; }
  _ok_('no throw', !threw);
  _eq_('no Dutchie traffic from the skipped run', wire.urls.length, 0);
  userLock.free = true;
}

function test_triggerAndRouteShareOneTtl_() {
  const cacheSrc = fs.readFileSync(path.join(__dirname, '..', 'cache.gs'), 'utf8');
  const proxySrc = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');
  _eq_('TTL outlasts a slow run', S.DIRECTOR_CACHE_TTL_S >= 600, true);
  const lit = /saveChunkedCache_\((?:dirCache, dirCacheKey|cache, 'gc_dirall_v2_').*$/gm;
  const calls = (cacheSrc.match(lit) || []).concat(proxySrc.match(lit) || []);
  _eq_('two directorall cache writes', calls.length, 2);
  _ok_('both use DIRECTOR_CACHE_TTL_S, no literal', calls.every(function (c) { return /DIRECTOR_CACHE_TTL_S/.test(c); }));
}

H.run('director-refresh-load', {
  test_sameWindowTwiceIsOneDownloadInsideABuild_,
  test_outsideABuildNothingIsRemembered_,
  test_nestedScopeDoesNotCloseTheOuterOne_,
  test_aFailureIsRetriedAndStillReported_,
  test_settledDaysReadInOneBatch_,
  test_sameRangeTwiceInABuildIsAssembledOnce_,
  test_unavailableStoreIsReplayedFromTheMemo_,
  test_refreshLeavesAtOnceWhenOneIsRunning_,
  test_triggerAndRouteShareOneTtl_,
});
