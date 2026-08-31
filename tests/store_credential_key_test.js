// ============================================================
//  Dutchie credentials are keyed by GX Core store_id — and only by store_id.
//
//  WHY THIS EXISTS (2026-08-29)
//  This project's DUTCHIE_STORE_KEYS_JSON labeled its keys by Dutchie store NAME, and its labels
//  had Bend and Hillsboro TRANSPOSED relative to GX Core, Inventory and Sales. dutchie_proxy.gs
//  compensated with a second, opposite swap (slug 'century' -> dutchieName 'Hillsboro'), so the
//  kiosk was correct only because two errors canceled. Anyone who "fixed" either half in isolation
//  broke it — which is exactly what PR #8 did on 2026-08-26.
//
//  Keyed by store_id there is no direction left to get backwards: store_id is Core-owned, matches
//  the row it came from, and means the same thing in every app. These assertions fail if a name-
//  keyed lookup is ever reintroduced.
//
//  Run:  node tests/store_credential_key_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

// The live registry, verbatim from GX Core ?action=stores on 2026-08-29.
const CORE_STORES = [
  { store_id: 'bend',        display_name: 'Century',    dutchie_name: 'Bend'        },
  { store_id: 'center',      display_name: 'Center',     dutchie_name: 'Center'      },
  { store_id: 'commercial',  display_name: 'Commercial', dutchie_name: 'Commercial'  },
  { store_id: 'hillsboro',   display_name: 'Baseline',   dutchie_name: 'Hillsboro'   },
  { store_id: 'portland-rd', display_name: 'Portland',   dutchie_name: 'Portland Rd' },
  { store_id: 'river-rd',    display_name: 'River',      dutchie_name: 'River Rd'    },
];

/* Load the app with GX CORE returning `keysObj` from ?action=dutchie_keys.
 *
 * Changed 2026-08-31: the keys used to come from this project's own DUTCHIE_STORE_KEYS_JSON, one of
 * five copies in the suite. GX Core is now the only holder, so the thing to stub is the HTTP call,
 * not the property. `localProp` lets a test ALSO plant a local property, which is how we prove the
 * old copy is genuinely dead rather than merely unused.
 */
function build(keysObj, opts) {
  opts = opts || {};
  const props = {
    getProperty: function (k) {
      if (k === 'GX_CONNECTOR_SECRET') return opts.noSecret ? null : 'test-connector-secret';
      if (k === 'DUTCHIE_STORE_KEYS_JSON') return opts.localProp ? JSON.stringify(opts.localProp) : null;
      return null;
    },
    setProperty: function () {}, deleteProperty: function () {}, getProperties: function () { return {}; },
  };
  const body = keysObj === null
    ? JSON.stringify({ ok: false, error: 'no keys resolved for any store' })
    : JSON.stringify({ ok: true, keys: keysObj, count: Object.keys(keysObj).length });
  return H.load(['dutchie_fetch.gs', 'dutchie_proxy.gs', 'discounts.gs'], {
    stubs: {
      PropertiesService: {
        getScriptProperties: function () { return props; },
        getUserProperties:   function () { return props; },
        getDocumentProperties: function () { return props; },
      },
      // Cache always misses here: every test should exercise the real fetch path, not a warm copy.
      CacheService: {
        getScriptCache: function () {
          return { get: function () { return null; }, put: function () {} };
        },
      },
      UrlFetchApp: {
        fetch: function (url) {
          if (String(url).indexOf('action=dutchie_keys') === -1) throw new Error('unexpected fetch: ' + url);
          return { getResponseCode: function () { return 200; }, getContentText: function () { return body; } };
        },
        fetchAll: function () { return []; },
      },
      Utilities: Object.assign({}, (H.stdStubs && H.stdStubs.Utilities) || {}, { sleep: function () {} }),
    },
  });
}

// A property file keyed the RIGHT way: by Core store_id.
const BY_STORE_ID = {
  'bend': 'key-bend', 'center': 'key-center', 'commercial': 'key-commercial',
  'hillsboro': 'key-hillsboro', 'portland-rd': 'key-portland', 'river-rd': 'key-river',
};

function test_everyStoreIdIsOneCoreActuallyPublishes() {
  const S = build(BY_STORE_ID);
  const coreIds = CORE_STORES.map(function (s) { return s.store_id; }).sort();
  const appIds  = S.STORES.map(function (s) { return s.storeId; }).sort();
  _eq_('STORES storeIds match Core exactly', appIds.join(','), coreIds.join(','));
}

function test_displayPairingMatchesCore() {
  // The pairing that was inverted. Core's bend row is Century; its hillsboro row is Baseline.
  const S = build(BY_STORE_ID);
  const byId = {};
  S.STORES.forEach(function (s) { byId[s.storeId] = s; });
  CORE_STORES.forEach(function (c) {
    _eq_('store_id ' + c.store_id + ' displays as Core says', byId[c.store_id].name, c.display_name);
  });
}

function test_lookupResolvesThroughStoreId() {
  const S = build(BY_STORE_ID);
  _eq_('baseline kiosk -> hillsboro key', S.getDutchieStoreKey_('baseline'),  'key-hillsboro');
  _eq_('century kiosk  -> bend key',      S.getDutchieStoreKey_('century'),   'key-bend');
  _eq_('river kiosk    -> river-rd key',  S.getDutchieStoreKey_('river'),     'key-river');
  _eq_('portland kiosk -> portland-rd',   S.getDutchieStoreKey_('portland'),  'key-portland');
}

function test_theLocalPropertyIsNoLongerASourceOfKeys() {
  // THE NEW INVARIANT (2026-08-31). A leftover local DUTCHIE_STORE_KEYS_JSON must be inert. If this
  // ever passes keys through again, the suite is back to five copies and the next rotation misses
  // one — which is precisely how the May leak survived a cleanup pass.
  const S = build(null, { localProp: {
    'bend': 'STALE', 'center': 'STALE', 'commercial': 'STALE',
    'hillsboro': 'STALE', 'portland-rd': 'STALE', 'river-rd': 'STALE',
  } });
  let served = 0, threw = 0;
  ['baseline', 'century', 'center', 'commercial', 'portland', 'river'].forEach(function (slug) {
    try { if (S.getDutchieStoreKey_(slug) === 'STALE') served++; } catch (e) { threw++; }
  });
  _eq_('a leftover local property serves nothing', served, 0);
  _eq_('and every store fails closed instead', threw, 6);
}

function test_noConnectorSecretFailsClosedAndSaysWhich() {
  // The deploy secret must NOT work here. If someone "fixes" a missing connector secret by falling
  // back to it, any spoke holding the deploy secret can trade it for live POS credentials.
  const S = build(BY_STORE_ID, { noSecret: true });
  let msg = '';
  try { S.getDutchieStoreKey_('century'); } catch (e) { msg = e.message; }
  _ok_('names the connector secret, not the deploy secret', /GX_CONNECTOR_SECRET/.test(msg));
  _ok_('does not suggest the deploy secret as a fallback', !/GX_DEPLOY_SECRET/.test(msg));
}

function test_theOldNameKeyedPropertyNowFailsClosed() {
  // THE REGRESSION GUARD. This is the exact JSON the property held before 2026-08-29 — keyed by
  // Dutchie name, with Bend/Hillsboro transposed. It must now resolve to NOTHING rather than
  // quietly serving one store's numbers under another store's name.
  const LEGACY_BY_NAME = {
    'Hillsboro': 'key-that-serves-bend', 'Center': 'k', 'Commercial': 'k',
    'Bend': 'key-that-serves-hillsboro', 'Portland Rd': 'k', 'River': 'k',
  };
  const S = build(LEGACY_BY_NAME);   // GX Core answering in the OLD name vocabulary
  let threw = 0;
  ['baseline', 'century', 'center', 'commercial', 'portland', 'river'].forEach(function (slug) {
    try { S.getDutchieStoreKey_(slug); } catch (e) { threw++; }
  });
  _eq_('every slug fails closed against a name-keyed property', threw, 6);
}

function test_storesCarriesNoNameKeyedCredentialField() {
  // dutchieName was the field that held the compensating swap. Its absence is the invariant.
  const S = build(BY_STORE_ID);
  const offenders = S.STORES.filter(function (s) { return 'dutchieName' in s; });
  _eq_('no STORES entry carries dutchieName', offenders.length, 0);
}

function test_inheritedNamesCannotForgeACredential() {
  // A lookup table is not a whitelist: keys.constructor is a truthy FUNCTION on any plain object.
  const S = build(BY_STORE_ID);
  const poisoned = S.STORES.map(function (s) { return Object.assign({}, s, { storeId: 'constructor' }); });
  let leaked = 0;
  poisoned.forEach(function () {
    try {
      const k = S.getDutchieStoreKey_('baseline');
      if (typeof k === 'function') leaked++;
    } catch (e) { /* fail-closed is the pass */ }
  });
  _eq_('no inherited property is ever returned as a credential', leaked, 0);
}

function test_aMissingStoreIdThrowsRatherThanReturningUndefined() {
  const S = build({ 'bend': 'key-bend' });   // five stores absent
  let threw = false;
  try { S.getDutchieStoreKey_('baseline'); } catch (e) { threw = /hillsboro/.test(e.message); }
  _ok_('missing key throws and names the store_id it wanted', threw);
}

H.run('store_credential_key', {
  test_everyStoreIdIsOneCoreActuallyPublishes,
  test_displayPairingMatchesCore,
  test_theLocalPropertyIsNoLongerASourceOfKeys,
  test_noConnectorSecretFailsClosedAndSaysWhich,
  test_lookupResolvesThroughStoreId,
  test_theOldNameKeyedPropertyNowFailsClosed,
  test_storesCarriesNoNameKeyedCredentialField,
  test_inheritedNamesCannotForgeACredential,
  test_aMissingStoreIdThrowsRatherThanReturningUndefined,
});
