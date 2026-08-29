// ============================================================
//  verifyStoreKeyMapping() — ask DUTCHIE which store each key opens, and check it against Core.
//
//  This is the only check that cannot be fooled by a mislabelled map, because it does not read any
//  of our labels. It calls Dutchie's /whoami with each key and compares the location Dutchie names
//  against the store_id we filed that key under.
//
//  Four written sources in this repo once asserted the Bend/Hillsboro mapping and three of them had
//  it backwards. Documentation is not evidence. This is.
//
//  Read-only. Logs no key material. Safe to run any time.
// ============================================================

// GX Core store_id -> the city Dutchie reports for that location. From /whoami, 2026-08-29.
var EXPECTED_CITY_BY_STORE_ID = {
  'bend':        'Bend',
  'center':      'Salem',
  'commercial':  'Salem',
  'hillsboro':   'Hillsboro',
  'portland-rd': 'Salem',
  'river-rd':    'Salem',
};

// The distinguishing check for the pair that was transposed: locationId is unambiguous.
var EXPECTED_LOCATION_ID = {
  'bend': 1297, 'center': 1346, 'commercial': 1347,
  'hillsboro': 1345, 'portland-rd': 1517, 'river-rd': 1296,
};

function verifyStoreKeyMapping() {
  var keys = JSON.parse(PropertiesService.getScriptProperties()
    .getProperty('DUTCHIE_STORE_KEYS_JSON') || '{}');

  var ids = Object.keys(EXPECTED_LOCATION_ID);
  var bad = [];

  ids.forEach(function (id) {
    if (!Object.prototype.hasOwnProperty.call(keys, id)) {
      bad.push(id + ': NO KEY under this store_id');
      return;
    }
    var resp = UrlFetchApp.fetch('https://api.pos.dutchie.com/whoami', {
      headers: {
        Authorization: 'Basic ' + Utilities.base64Encode(keys[id] + ':'),
        Accept: 'application/json',
      },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) {
      bad.push(id + ': HTTP ' + resp.getResponseCode());
      return;
    }
    var d = JSON.parse(resp.getContentText());
    var okId   = d.locationId === EXPECTED_LOCATION_ID[id];
    var okCity = String(d.city || '') === EXPECTED_CITY_BY_STORE_ID[id];
    Logger.log((okId && okCity ? 'OK   ' : 'WRONG') + '  ' + id
             + '  ->  ' + d.locationName + '  (' + d.city + ', locationId ' + d.locationId + ')');
    if (!okId || !okCity) {
      bad.push(id + ': key opens locationId ' + d.locationId + ' (' + d.city + '), expected '
             + EXPECTED_LOCATION_ID[id] + ' (' + EXPECTED_CITY_BY_STORE_ID[id] + ')');
    }
  });

  // Legacy NAME labels may still be present as a rollback path. Report them, don't judge them.
  var legacy = Object.keys(keys).filter(function (k) { return ids.indexOf(k) === -1; });
  if (legacy.length) Logger.log('note: legacy name labels still present (rollback path): ' + legacy.sort().join(', '));

  if (bad.length) {
    Logger.log('FAILED:\n  ' + bad.join('\n  '));
    throw new Error('Store key mapping is WRONG for: ' + bad.length + ' store(s). See log.');
  }
  Logger.log('All six store_ids open the store GX Core says they should. Mapping verified against Dutchie.');
  return { ok: true, verified: ids.length, legacyLabelsPresent: legacy.sort() };
}

/* ── Drop the legacy NAME labels once the store_id deploy has proven itself ──────────────────────
   DUTCHIE_STORE_KEYS_JSON currently answers to BOTH spellings of the same six keys: the store_ids
   the running code uses, and the old Dutchie-name labels ('Bend', 'Hillsboro', …) left in place on
   2026-08-29 as the rollback path. Version 486 resolves keys by NAME, so while those labels exist a
   rollback to it still works.

   Run this only when you are satisfied v488 is staying. It refuses unless verifyStoreKeyMapping()
   would pass first, because dropping the fallback while the primary is wrong takes the kiosk down
   with no way back.

   AFTER THIS RUNS, ROLLING BACK TO 486 WILL FAIL CLOSED — 486 will find no key under any name it
   knows. That is the intended end state (one vocabulary, no ambiguity), but it is a one-way door
   until someone re-adds the labels by hand. */
function dropLegacyStoreKeyLabels() {
  var v = verifyStoreKeyMapping();          // throws if any store_id opens the wrong store
  if (!v || !v.ok) throw new Error('verification did not pass — refusing to drop the fallback');

  var props = PropertiesService.getScriptProperties();
  var cur = JSON.parse(props.getProperty('DUTCHIE_STORE_KEYS_JSON') || '{}');
  var ids = Object.keys(EXPECTED_LOCATION_ID);

  var out = {}, dropped = [];
  Object.keys(cur).forEach(function (k) {
    if (ids.indexOf(k) !== -1) out[k] = cur[k]; else dropped.push(k);
  });
  var missing = ids.filter(function (id) { return !out[id]; });
  if (missing.length) throw new Error('refusing to write — would leave no key for: ' + missing.join(', '));

  props.setProperty('DUTCHIE_STORE_KEYS_JSON', JSON.stringify(out));
  Logger.log('Dropped ' + dropped.length + ' legacy label(s): ' + (dropped.sort().join(', ') || '(none)'));
  Logger.log('Now store_id only: ' + Object.keys(out).sort().join(', ') + '  — rollback to 486 will no longer work.');
  return { ok: true, dropped: dropped.sort(), remaining: Object.keys(out).sort() };
}
