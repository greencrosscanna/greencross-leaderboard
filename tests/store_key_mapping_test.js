// ============================================================
//  Green Cross — store → Dutchie key mapping  (store_key_mapping_test.js)
//
//  WHY THIS SUITE EXISTS.
//  `getDutchieStoreKey_(slug)` does `keys[store.dutchieName]`, where `keys` is the
//  DUTCHIE_STORE_KEYS_JSON ScriptProperty. So `dutchieName` does not label a column —
//  it CHOOSES THE API CREDENTIAL. Get it wrong and the store's transactions, staff,
//  discounts and goal history all silently belong to a different shop. Every number
//  still renders; they are just the other store's numbers.
//
//  It has been wrong. 56d4622 (2026-05-20) inverted baseline/century. Nothing caught it:
//  no test covered the mapping, and five days later d89f8f3 added `locationName` with the
//  correct mapping and repointed the Sales goals export at it — repairing the one visible
//  symptom and leaving the credential selection inverted underneath.
//
//  THE TRAP THIS PINS. The two stores are branded for a street in the OTHER store's city:
//  Century is at 341 SW Century Dr in BEND, Baseline is on Baseline Rd in HILLSBORO. Read
//  quickly, the correct mapping looks like a bug, so it keeps getting "fixed".
//
//  WHAT IT ASSERTS AGAINST, AND WHY NOT GX CORE.
//  user_admin.gs is not a second opinion — it is the SOURCE. Its STORE_KEYS_MAP sits next
//  to the real API keys, seeds the Store Keys sheet, and that sheet is what gets pushed
//  into DUTCHIE_STORE_KEYS_JSON. So the binding contract is dutchie_proxy.STORES ↔
//  user_admin.STORE_KEYS_MAP, and a disagreement between them is the live defect.
//  GX Core's `dutchie_name` is deliberately NOT the oracle here: it publishes 'River Rd'
//  where the key is 'River', so it agrees on the pair in question but not on vocabulary.
//  Asserting against it would fail for reasons that have nothing to do with this bug.
// ============================================================

const { load, run, _eq_, _ok_ } = require('./_harness.js');

const gs = load(['dutchie_proxy.gs', 'user_admin.gs']);
const { STORES, STORE_KEYS_MAP, DUTCHIE_TO_SLUG, SLUG_TO_NAME } = gs;

const tests = {};

// The headline pair, spelled out rather than derived, so a reader sees the answer without
// having to re-derive it and a wrong "fix" fails on a line that states the fact.
tests.theTwoThatGetSwapped = function () {
  const bySlug = {};
  STORES.forEach(function (s) { bySlug[s.slug] = s; });

  _eq_('century uses the Bend key (341 SW Century Dr, Bend OR)', bySlug.century.dutchieName, 'Bend');
  _eq_('baseline uses the Hillsboro key (Baseline Rd, Hillsboro OR)', bySlug.baseline.dutchieName, 'Hillsboro');

  // State the inversion as its own assertion: if someone swaps the rows, this names what happened.
  _ok_('century and baseline are not pointed at each other',
       bySlug.century.dutchieName !== 'Hillsboro' && bySlug.baseline.dutchieName !== 'Bend');
};

// The general contract: every store's key must round-trip back to that same store.
tests.everyKeyRoundTripsToItsOwnSlug = function () {
  STORES.forEach(function (s) {
    _eq_(s.slug + ': DUTCHIE_TO_SLUG[' + s.dutchieName + '] returns to ' + s.slug,
         DUTCHIE_TO_SLUG[s.dutchieName], s.slug);
  });
};

// A dutchieName with no key is not a mislabel — getDutchieStoreKey_ throws and the store
// goes dark. Catch a typo here rather than on the kiosk.
tests.everyDutchieNameHasAKey = function () {
  STORES.forEach(function (s) {
    _ok_(s.slug + ': "' + s.dutchieName + '" exists in STORE_KEYS_MAP',
         Object.prototype.hasOwnProperty.call(STORE_KEYS_MAP, s.dutchieName));
  });
};

// Both directions, so a store added to one map and forgotten in the other is caught.
tests.theTwoMapsCoverTheSameStores = function () {
  const fromStores = STORES.map(function (s) { return s.dutchieName; }).sort();
  const fromKeys   = Object.keys(STORE_KEYS_MAP).sort();
  _eq_('STORES dutchieNames === STORE_KEYS_MAP keys', fromStores, fromKeys);

  const slugsFromStores = STORES.map(function (s) { return s.slug; }).sort();
  const slugsFromMap    = Object.keys(DUTCHIE_TO_SLUG).map(function (k) { return DUTCHIE_TO_SLUG[k]; }).sort();
  _eq_('STORES slugs === DUTCHIE_TO_SLUG targets', slugsFromStores, slugsFromMap);
};

// locationName keys the Sales goals export (goals.gs: dashGoals[s.locationName]). It is a
// separate field from dutchieName on purpose, but for these six they coincide — and it was
// locationName being RIGHT while dutchieName was WRONG that let the 2026-05 inversion hide.
// Pinning them together means the next inversion breaks a test instead of being papered over.
tests.locationNameAgreesWithDutchieName = function () {
  STORES.forEach(function (s) {
    _eq_(s.slug + ': locationName tracks dutchieName', s.locationName, s.dutchieName);
  });
};

// Display names are this app's own vocabulary and must not drift into the key vocabulary —
// 'Century' must never become a dutchieName, or the key lookup silently misses.
tests.displayNamesStayOutOfTheKeyVocabulary = function () {
  STORES.forEach(function (s) {
    _eq_(s.slug + ': SLUG_TO_NAME agrees with STORES.name', SLUG_TO_NAME[s.slug], s.name);
  });
  _ok_('no brand name is being used as a Dutchie key',
       !Object.prototype.hasOwnProperty.call(STORE_KEYS_MAP, 'Century') &&
       !Object.prototype.hasOwnProperty.call(STORE_KEYS_MAP, 'Baseline'));
};

run('store_key_mapping', tests);
