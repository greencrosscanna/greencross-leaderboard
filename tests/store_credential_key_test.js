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

/** Load dutchie_fetch.gs + dutchie_proxy.gs with DUTCHIE_STORE_KEYS_JSON set to `keysObj`. */
function build(keysObj) {
  const props = {
    getProperty: function (k) {
      return k === 'DUTCHIE_STORE_KEYS_JSON' ? JSON.stringify(keysObj) : null;
    },
    setProperty: function () {}, deleteProperty: function () {}, getProperties: function () { return {}; },
  };
  return H.load(['dutchie_fetch.gs', 'dutchie_proxy.gs', 'discounts.gs'], {
    stubs: { PropertiesService: {
      getScriptProperties: function () { return props; },
      getUserProperties:   function () { return props; },
      getDocumentProperties: function () { return props; },
    } },
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

function test_theOldNameKeyedPropertyNowFailsClosed() {
  // THE REGRESSION GUARD. This is the exact JSON the property held before 2026-08-29 — keyed by
  // Dutchie name, with Bend/Hillsboro transposed. It must now resolve to NOTHING rather than
  // quietly serving one store's numbers under another store's name.
  const LEGACY_BY_NAME = {
    'Hillsboro': 'key-that-serves-bend', 'Center': 'k', 'Commercial': 'k',
    'Bend': 'key-that-serves-hillsboro', 'Portland Rd': 'k', 'River': 'k',
  };
  const S = build(LEGACY_BY_NAME);
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
  test_lookupResolvesThroughStoreId,
  test_theOldNameKeyedPropertyNowFailsClosed,
  test_storesCarriesNoNameKeyedCredentialField,
  test_inheritedNamesCannotForgeACredential,
  test_aMissingStoreIdThrowsRatherThanReturningUndefined,
});
