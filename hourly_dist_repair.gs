// ============================================================
//  Hourly-goal cache repair — run repairHourlyDistCache()
//
//  SYMPTOM: hourly goals flat at Baseline, correct at the other five stores.
//
//  CAUSE: every write site capped GC_HOURLY_DIST_JSON at 60 entries by doing
//      Object.keys(cache).sort()  then shift-and-delete
//  which evicts in ALPHABETICAL order. Keys are "slug:dow:YYYY-MM-DD", so every `baseline:*`
//  key sorts ahead of every `center:*` key and Baseline was ALWAYS the first store dropped.
//  The kiosk reads this cache only (getHourlyDistCached_ never fetches), so a missing entry
//  becomes a flat curve. Baseline was structurally starved; no other store could reach the cap.
//
//  Every read is for TODAY, so entries from earlier dates are unreachable — they were the dead
//  weight pushing the cache over 60 in the first place.
//
//  THIS FUNCTION is the live repair: it drops only the unreachable past-date entries. No store
//  loses the curve it is currently showing. The 2-minute refreshDirectorCache trigger then fills
//  Baseline back in. It is safe to run at any time, including from a kiosk-facing production app.
//
//  It is deliberately NOT a bustdist — deleting the whole property would flatten all six stores
//  until the next warm.
//
//  The permanent fix is in dutchie_fetch.gs (pruneHourlyDistCache_), which needs a deploy.
//  Until that deploys, re-running this occasionally keeps Baseline healthy.
// ============================================================

function repairHourlyDistCache() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(GC_HOURLY_DIST_KEY);
  if (!raw) { Logger.log('GC_HOURLY_DIST_JSON is not set — nothing to repair.'); return { ok: true, before: 0 }; }

  var cache = JSON.parse(raw);
  var now = ptNow_();
  var today = now.dateStr;

  var before = Object.keys(cache);
  var kept = {};
  before.forEach(function (k) { if (k.slice(-10) === today) kept[k] = cache[k]; });

  props.setProperty(GC_HOURLY_DIST_KEY, JSON.stringify(kept));

  var keptKeys = Object.keys(kept).sort();
  Logger.log('Entries before: ' + before.length + '   after: ' + keptKeys.length
           + '   (dropped ' + (before.length - keptKeys.length) + ' unreachable past-date entries)');
  Logger.log("Today's entries: " + (keptKeys.join(', ') || '(none)'));

  var haveToday = STORES.filter(function (s) {
    return keptKeys.some(function (k) { return k.indexOf(s.slug + ':') === 0; });
  }).map(function (s) { return s.slug; });
  var missing = STORES.map(function (s) { return s.slug; }).filter(function (sl) {
    return haveToday.indexOf(sl) === -1;
  });

  Logger.log('Stores WITH a curve today: ' + (haveToday.join(', ') || '(none)'));
  Logger.log('Stores still MISSING: ' + (missing.join(', ') || '(none)')
           + (missing.length ? ' — the 2-minute trigger will fill these within ~2 min.' : ''));
  return { ok: true, before: before.length, after: keptKeys.length, missing: missing };
}

/** Read-only. Shows what the hourly-dist cache holds, without changing anything. */
function inspectHourlyDistCache() {
  var raw = PropertiesService.getScriptProperties().getProperty(GC_HOURLY_DIST_KEY);
  if (!raw) { Logger.log('GC_HOURLY_DIST_JSON is not set.'); return { set: false }; }
  var keys = Object.keys(JSON.parse(raw)).sort();
  var today = ptNow_().dateStr;
  var todays = keys.filter(function (k) { return k.slice(-10) === today; });
  Logger.log('total entries: ' + keys.length + '   for today (' + today + '): ' + todays.length);
  Logger.log("today's: " + (todays.join(', ') || '(none)'));
  return { set: true, total: keys.length, today: todays };
}
