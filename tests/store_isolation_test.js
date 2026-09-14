// ============================================================
//  ONE STORE THAT CANNOT BE READ MUST NOT TAKE THE OTHERS DOWN
//
//  Before 2026-09-14, a store with no Dutchie key in GX Core threw out of the request builder in
//  every all-stores path, so the director view, ticker, roster sync and nightly goal job failed for
//  ALL six. And a store whose fetch failed was drawn as a confident $0 on the director screens.
//  This matters now because the store list is about to come from GX Core: a store added there
//  before its Dutchie connection is set up would otherwise blank the whole board.
//
//  What must hold:
//    1. A store with no key is skipped, never fetched, and every other store is still read.
//    2. That store -- and any store whose fetch fails -- is RECORDED as unavailable, never as empty.
//    3. An unreachable key map (every store at once) still throws: that is an outage, not one store.
//    4. The roster sync keeps an unavailable store's previous staff list instead of wiping it.
//    5. The single-store path says "unavailable" (the kiosk's wording), not a raw error.
//
//  Run:  node tests/store_isolation_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

const ALL_KEYS = { 'river-rd': 'k-river', center: 'k-center', hillsboro: 'k-baseline',
                   bend: 'k-century', commercial: 'k-commercial', 'portland-rd': 'k-portland' };

let keys, keyMapThrows, failAuth, wired, props;

function build() {
  props = {};
  return H.load(['dutchie_fetch.gs', 'dutchie_proxy.gs', 'discounts.gs'], {
    stubs: {
      UrlFetchApp: {
        fetchAll: function (reqs) {
          return reqs.map(function (r) {
            wired.push(r.headers.Authorization);
            const bad = failAuth && r.headers.Authorization === 'Basic ' + Buffer.from(failAuth + ':').toString('base64');
            return {
              getResponseCode: function () { return bad ? 503 : 200; },
              getContentText: function () {
                return bad ? 'down' : JSON.stringify([{ transactionType: 'Retail', isVoid: false, total: 10,
                  completedByUser: 'Pat Lee', employeeId: 7, transactionDateLocalTime: '2026-09-14T10:00:00' }]);
              },
            };
          });
        },
        fetch: function () { throw new Error('unexpected single fetch'); },
      },
      PropertiesService: { getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
          setProperty: function (k, v) { props[k] = String(v); return this; },
        };
      } },
      CacheService: { getScriptCache: function () {
        return {
          get: function (k) {
            if (k !== 'gx_dutchie_keys') return null;
            if (keyMapThrows) return null;          // falls through to the Core fetch, which throws
            return JSON.stringify(keys);
          },
          put: function () {}, remove: function () {},
        };
      } },
    },
  });
}

const RANGE = { fromUTC: '2026-09-14T07:00:00Z', toUTC: '2026-09-15T06:59:59Z' };

function reset(A) {
  keys = Object.assign({}, ALL_KEYS);
  keyMapThrows = false; failAuth = null; wired = [];
  A.resetStoresUnavailable_();
}

H.run('store_isolation', {

  missingKeySkipsOnlyThatStore: function () {
    const A = build(); reset(A);
    delete keys['river-rd'];
    let threw = null, byStore = null;
    try { byStore = A.fetchAllStoresTransactions_(RANGE); } catch (e) { threw = e.message; }
    _eq_('no throw for the whole board', threw, null);
    _eq_('the other five were fetched', wired.length, 5);
    _ok_('no request went out without a key', wired.every(function (a) { return a && a !== 'Basic ' + Buffer.from('null:').toString('base64'); }));
    _eq_('the other stores have their rows', byStore.center.length, 1);
    _eq_('river is empty...', byStore.river.length, 0);
    _eq_('...and recorded as unavailable, with why', A.storesUnavailable_(), { river: 'no Dutchie key in GX Core' });
  },

  missingKeyInMultiRange: function () {
    const A = build(); reset(A);
    delete keys.bend;
    const out = A.fetchAllStoresTransactionsMulti_([RANGE, RANGE]);
    _eq_('two ranges x five keyed stores on the wire', wired.length, 10);
    _eq_('century marked by SLUG, not by the "0:century" request key', Object.keys(A.storesUnavailable_()), ['century']);
    _eq_('every range still has every store', Object.keys(out[1]).length, 6);
  },

  failedFetchIsRecordedNotZero: function () {
    const A = build(); reset(A);
    failAuth = 'k-commercial';
    A.fetchAllStoresTransactions_(RANGE);
    _eq_('a 503 for one store marks exactly that store', Object.keys(A.storesUnavailable_()), ['commercial']);
    _ok_('with the HTTP reason', /503/.test(A.storesUnavailable_().commercial));
  },

  keyMapOutageStillThrows: function () {
    const A = build(); reset(A);
    keyMapThrows = true;   // no cache hit and GX_CONNECTOR_SECRET unset -> the key map cannot be read
    let threw = null;
    try { A.fetchAllStoresTransactions_(RANGE); } catch (e) { threw = e.message; }
    _ok_('no key map at all is every store at once: still an error', !!threw && /GX_CONNECTOR_SECRET/.test(threw));
  },

  singleStoreSaysUnavailable: function () {
    const A = build(); reset(A);
    delete keys.center;
    let threw = null;
    try { A.fetchStoreTransactions_('center', 'a', 'b'); } catch (e) { threw = e; }
    _ok_('the kiosk path reads a missing key as a data outage', !!threw && A.isDutchieUnavailable_(threw));
  },

  rosterKeepsAnUnavailableStore: function () {
    const A = build(); reset(A);
    props.GC_STORE_EMPLOYEES_JSON = JSON.stringify({ river: [{ id: 1, name: 'Kept Person', initials: 'KP' }] });
    delete keys['river-rd'];
    const r = A.syncEmployeeRoster_();
    const saved = JSON.parse(props[Object.keys(props).find(function (k) { return /EMPLOYEES/.test(k); })]);
    _eq_('river kept its previous roster instead of being wiped', saved.river.map(function (x) { return x.name; }), ['Kept Person']);
    _eq_('a readable store was rebuilt from the fetch', saved.center.map(function (x) { return x.name; }), ['Pat Lee']);
    _eq_('sync still reports ok', r.ok, true);
  },

  recordResetsPerBuild: function () {
    const A = build(); reset(A);
    failAuth = 'k-river';
    A.fetchAllStoresTransactions_(RANGE);
    _eq_('first build: river failed', Object.keys(A.storesUnavailable_()), ['river']);
    A.resetStoresUnavailable_();
    failAuth = 'k-center';
    A.fetchAllStoresTransactions_(RANGE);
    _eq_('a later build carries only ITS failures, not the earlier one', Object.keys(A.storesUnavailable_()), ['center']);
  },
});
