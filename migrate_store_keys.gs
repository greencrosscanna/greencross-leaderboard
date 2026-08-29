// ============================================================
//  ONE-TIME MIGRATION — DUTCHIE_STORE_KEYS_JSON: name-keyed  ->  GX Core store_id
//
//  Run migrateStoreKeysToStoreId() ONCE in this project's editor, then deploy the matching code
//  change (dutchie_proxy.gs STORES + dutchie_fetch.gs getDutchieStoreKey_).
//
//  ORDER MATTERS. The old code reads keys[store.dutchieName]; the new code reads keys[store.storeId].
//  Whichever you change first, the kiosk fails CLOSED (throws "No Dutchie key for store_id: …")
//  until the other lands — it never serves the WRONG store's numbers. Run this, then deploy
//  immediately. Off-peak is kind but not required.
//
//  WHY THE REMAP IS NOT THE IDENTITY. This project's labels had Bend and Hillsboro transposed:
//  the key labelled 'Bend' serves the Hillsboro/Baseline store, and 'Hillsboro' serves Bend/Century.
//  Confirmed 2026-08-28 by measurement (6/6 employees per store) and 2026-08-29 by comparing key
//  material against Inventory, Sales and GX Core, which all label them the other way round.
//
//  Safe to re-run: it detects an already-migrated property and does nothing.
//  DELETE THIS FILE once the migration has run and the deploy is verified.
// ============================================================

// Old label -> GX Core store_id. Note bend/hillsboro cross over. That crossing IS the bug.
var LEGACY_LABEL_TO_STORE_ID = {
  'Hillsboro':   'bend',          // key labelled Hillsboro actually serves Bend / Century
  'Bend':        'hillsboro',     // key labelled Bend actually serves Hillsboro / Baseline
  'Center':      'center',
  'Commercial':  'commercial',
  'Portland Rd': 'portland-rd',
  'River':       'river-rd',
};

var EXPECTED_STORE_IDS = ['bend', 'center', 'commercial', 'hillsboro', 'portland-rd', 'river-rd'];

function migrateStoreKeysToStoreId() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('DUTCHIE_STORE_KEYS_JSON');
  if (!raw) throw new Error('DUTCHIE_STORE_KEYS_JSON is not set — nothing to migrate.');

  var cur = JSON.parse(raw);
  var labels = Object.keys(cur);

  // Already migrated?
  var already = labels.filter(function (l) { return EXPECTED_STORE_IDS.indexOf(l) !== -1; });
  if (already.length === labels.length && labels.length === 6) {
    Logger.log('Already store_id-keyed. No change. Labels: ' + labels.sort().join(', '));
    return { ok: true, migrated: false, labels: labels.sort() };
  }

  var out = {};
  var unmapped = [];
  labels.forEach(function (label) {
    var id = Object.prototype.hasOwnProperty.call(LEGACY_LABEL_TO_STORE_ID, label)
      ? LEGACY_LABEL_TO_STORE_ID[label] : null;
    if (!id) { unmapped.push(label); return; }
    out[id] = cur[label];
  });

  if (unmapped.length) {
    throw new Error('Unrecognised label(s), refusing to write: ' + unmapped.join(', '));
  }
  var missing = EXPECTED_STORE_IDS.filter(function (id) { return !out[id]; });
  if (missing.length) {
    throw new Error('Would leave store(s) with no key, refusing to write: ' + missing.join(', '));
  }

  props.setProperty('DUTCHIE_STORE_KEYS_JSON', JSON.stringify(out));
  Logger.log('Migrated. Now keyed by store_id: ' + Object.keys(out).sort().join(', '));
  return { ok: true, migrated: true, labels: Object.keys(out).sort() };
}

/** Read-only check. Logs which vocabulary the property currently uses. No key values are logged. */
function checkStoreKeyVocabulary() {
  var raw = PropertiesService.getScriptProperties().getProperty('DUTCHIE_STORE_KEYS_JSON');
  if (!raw) { Logger.log('DUTCHIE_STORE_KEYS_JSON is NOT SET.'); return { set: false }; }
  var labels = Object.keys(JSON.parse(raw)).sort();
  var isStoreId = labels.join(',') === EXPECTED_STORE_IDS.slice().sort().join(',');
  Logger.log((isStoreId ? 'store_id-keyed (migrated)' : 'legacy NAME-keyed') + ': ' + labels.join(', '));
  return { set: true, storeIdKeyed: isStoreId, labels: labels };
}
