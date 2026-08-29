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
