// ============================================================
//  Dutchie key migration — Dutchie NAME  ->  GX Core store_id
//
//  RUN  migrateStoreKeysToStoreId()  — that is the only thing you need to do in here.
//
//  ZERO DOWNTIME BY DESIGN. It does not replace the old labels, it ADDS the store_id ones
//  alongside them. So the property ends up holding both spellings of the same six keys:
//
//      {"Bend":"<k>", ..., "bend":"<k2>", "hillsboro":"<k>", ...}
//
//  Production is pinned to version 486, which is the OLD code and looks keys up by NAME. A
//  straight replace would have taken the kiosk down the moment it ran, and left it down until
//  a new version was deployed. Holding both means the running app keeps working, the new code
//  works the instant it deploys, and the order of the two no longer matters.
//
//  AFTER the store_id code is deployed and verified, run cleanupLegacyStoreKeyLabels() to drop
//  the six name entries. There is no rush and nothing breaks if it waits.
//
//  checkStoreKeyVocabulary() is read-only — safe to run any time. It never logs a key value.
//
//  WHY bend AND hillsboro CROSS OVER BELOW: this project's key labels had those two transposed.
//  The key labelled 'Bend' serves the Hillsboro/Baseline store and vice versa — confirmed by
//  measurement on 2026-08-28 and by comparing key material against GX Core, Inventory and Sales
//  on 2026-08-29, all three of which label them the other way. The crossing is the fix, not a typo.
// ============================================================

var LEGACY_LABEL_TO_STORE_ID = {
  'Hillsboro':   'bend',          // labelled Hillsboro, actually serves Bend / Century
  'Bend':        'hillsboro',     // labelled Bend, actually serves Hillsboro / Baseline
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
  var out = {};
  Object.keys(cur).forEach(function (k) { out[k] = cur[k]; });   // keep every existing label

  Object.keys(LEGACY_LABEL_TO_STORE_ID).forEach(function (label) {
    if (Object.prototype.hasOwnProperty.call(cur, label)) {
      out[LEGACY_LABEL_TO_STORE_ID[label]] = cur[label];
    }
  });

  var missing = EXPECTED_STORE_IDS.filter(function (id) { return !out[id]; });
  if (missing.length) {
    throw new Error('Refusing to write — these store_ids would have no key: ' + missing.join(', ')
                  + '. Present labels: ' + Object.keys(cur).sort().join(', '));
  }

  props.setProperty('DUTCHIE_STORE_KEYS_JSON', JSON.stringify(out));
  Logger.log('OK. Property now answers to both spellings: ' + Object.keys(out).sort().join(', '));
  Logger.log('Nothing has changed for the running app. Safe to deploy the store_id code whenever.');
  return { ok: true, labels: Object.keys(out).sort() };
}

/** Run only AFTER the store_id code is deployed and verified. Drops the six legacy name labels. */
function cleanupLegacyStoreKeyLabels() {
  var props = PropertiesService.getScriptProperties();
  var cur = JSON.parse(props.getProperty('DUTCHIE_STORE_KEYS_JSON') || '{}');
  var missing = EXPECTED_STORE_IDS.filter(function (id) { return !cur[id]; });
  if (missing.length) {
    throw new Error('Refusing to clean up — not fully migrated yet, missing: ' + missing.join(', '));
  }
  var out = {};
  EXPECTED_STORE_IDS.forEach(function (id) { out[id] = cur[id]; });
  props.setProperty('DUTCHIE_STORE_KEYS_JSON', JSON.stringify(out));
  Logger.log('Cleaned. Now store_id only: ' + Object.keys(out).sort().join(', '));
  return { ok: true, labels: Object.keys(out).sort() };
}

/** Read-only. Says which spellings the property currently answers to. Logs no key values. */
function checkStoreKeyVocabulary() {
  var raw = PropertiesService.getScriptProperties().getProperty('DUTCHIE_STORE_KEYS_JSON');
  if (!raw) { Logger.log('DUTCHIE_STORE_KEYS_JSON is NOT SET.'); return { set: false }; }
  var labels = Object.keys(JSON.parse(raw));
  var hasIds = EXPECTED_STORE_IDS.every(function (id) { return labels.indexOf(id) !== -1; });
  var hasNames = Object.keys(LEGACY_LABEL_TO_STORE_ID).some(function (n) { return labels.indexOf(n) !== -1; });
  Logger.log('store_id keys: ' + (hasIds ? 'YES' : 'no') + '   legacy name keys: ' + (hasNames ? 'YES' : 'no'));
  Logger.log('labels: ' + labels.sort().join(', '));
  return { set: true, storeIdKeyed: hasIds, legacyStillPresent: hasNames, labels: labels.sort() };
}

// ============================================================
//  RECOVERY — run restoreLegacyStoreKeyLabels() if the kiosk lost its Dutchie data.
//
//  WHAT WENT WRONG (2026-08-29): an earlier draft of migrateStoreKeysToStoreId() REPLACED the
//  name labels with store_id ones instead of adding them. Production is pinned to version 486,
//  which looks keys up by NAME, so after that ran NONE of the six resolved — not just the
//  transposed pair, because 'Center' !== 'center'. getDutchieStoreKey_ throws for every store.
//
//  This puts the name labels back ALONGSIDE the store_id ones, which is the state the migration
//  should have produced. v486 works again immediately, and the store_id code still works the
//  moment it deploys.
// ============================================================
function restoreLegacyStoreKeyLabels() {
  var props = PropertiesService.getScriptProperties();
  var cur = JSON.parse(props.getProperty('DUTCHIE_STORE_KEYS_JSON') || '{}');

  var missing = EXPECTED_STORE_IDS.filter(function (id) { return !cur[id]; });
  if (missing.length) {
    throw new Error('Cannot restore — these store_ids have no key to copy from: ' + missing.join(', ')
                  + '. Present labels: ' + Object.keys(cur).sort().join(', '));
  }

  var out = {};
  Object.keys(cur).forEach(function (k) { out[k] = cur[k]; });
  // store_id -> the legacy NAME v486 asks for. Inverse of LEGACY_LABEL_TO_STORE_ID.
  Object.keys(LEGACY_LABEL_TO_STORE_ID).forEach(function (label) {
    out[label] = cur[LEGACY_LABEL_TO_STORE_ID[label]];
  });

  props.setProperty('DUTCHIE_STORE_KEYS_JSON', JSON.stringify(out));
  var labels = Object.keys(out).sort();
  Logger.log('Restored. ' + labels.length + ' labels (expect 12): ' + labels.join(', '));
  Logger.log(labels.length === 12
    ? 'Both spellings present — v486 works now, and the store_id code will work when deployed.'
    : 'WARNING: expected 12 labels. Check the list above before trusting this.');
  return { ok: true, count: labels.length, labels: labels };
}
