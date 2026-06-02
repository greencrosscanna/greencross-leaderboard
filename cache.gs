// ============================================================
//  Green Cross — Cache Infrastructure  (cache.gs)
//  Chunked CacheService helpers (>100 KB payloads),
//  the proactive 5-min director-data pre-build trigger,
//  and kiosk cache warmup.
// ============================================================

// ── Chunked CacheService helpers ─────────────────────────────
// GAS CacheService max value size = 100KB. For large payloads
// we split into 90KB chunks and store them as key_0, key_1, …
// plus a key_meta entry with the chunk count.
// NOTE: CHUNK_SIZE const is defined in dutchie_proxy.gs for load-order safety.

function saveChunkedCache_(cache, key, json, ttlSeconds) {
  const chunks = [];
  for (let i = 0; i < json.length; i += CHUNK_SIZE) {
    chunks.push(json.slice(i, i + CHUNK_SIZE));
  }
  const entries = {};
  chunks.forEach(function(chunk, i) { entries[key + '_' + i] = chunk; });
  entries[key + '_meta'] = String(chunks.length);
  cache.putAll(entries, ttlSeconds);
}

function getChunkedCache_(cache, key) {
  const metaRaw = cache.get(key + '_meta');
  if (!metaRaw) return null;
  const count = parseInt(metaRaw, 10);
  if (!count || count < 1) return null;
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(key + '_' + i);
  const vals = cache.getAll(keys);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const v = vals[key + '_' + i];
    if (!v) return null; // a chunk expired — treat as miss
    parts.push(v);
  }
  return parts.join('');
}

// ============================================================
//  PROACTIVE DIRECTOR CACHE
//
//  Architecture:
//    • A time-based GAS trigger calls refreshDirectorCache()
//      every 2 minutes on Google's servers.
//    • It builds the full directorall dataset and writes it
//      to CacheService in 90KB chunks (GAS 100KB limit).
//    • doGet('directorall') reads from the chunk cache first;
//      if warm it returns immediately with zero Dutchie calls.
//    • On a cold cache (first load / GAS restart) it falls
//      through to buildDirectorAll_() and warms the cache.
//
//  Setup (one-time):
//    Open this script in script.google.com → Run → setupDirectorTrigger
//    You'll see "Trigger created" in the Execution Log.
//    Verify in Triggers (clock icon) that the 2-min trigger exists.
// ============================================================

/**
 * Core build function used by both doGet and the proactive trigger.
 * Fetches all Dutchie data for the given period and returns the
 * full directorall payload object.
 */
function buildDirectorAll_(period) {
  period = period || 'mtd';
  const params = { period: period };
  const range  = getDateRange_(period);
  const prior  = getPriorRange_(range);
  const todayR = getDateRange_('today');
  const mtdR   = period === 'mtd' ? null : getDateRange_('mtd');

  const storeTrendCache = getStoreTrendCache_();
  const rangeList = [range, prior, todayR];
  if (mtdR) rangeList.push(mtdR);
  if (!storeTrendCache) rangeList.push(getDateRange_('30d'));

  const fetched      = fetchAllStoresTransactionsMulti_(rangeList);
  const byStore      = fetched[0];
  const prevByStore  = fetched[1];
  const byStoreToday = fetched[2];
  const byStoreMTD   = mtdR ? fetched[3] : byStore;
  const byStore30d   = storeTrendCache ? null : fetched[rangeList.length - 1];
  const storeTrends  = storeTrendCache || saveStoreTrendCache_(byStore30d) || {};

  const summary       = getDirectorSummary(params, { byStore, prevByStore });
  const stores        = getDirectorStores(params,  { byStore, byStoreToday, byStore30d, storeTrends });
  const staff         = getDirectorStaff(params,   { byStore, byStore30d });
  const alerts        = getDirectorAlerts(         { byStore: byStoreMTD });
  const today         = getDirectorToday(byStoreToday);
  const avatarConfigs = getAvatarConfigs_();
  const eomKey        = (getEomCurrent_() || {}).employeeKey || null;

  return { summary, stores, staff, alerts, today, avatarConfigs, eomKey };
}

/**
 * Called by the time-based trigger every 2 minutes.
 * Builds and caches directorall for 'mtd' (and 'pp' if needed).
 * Runs on Google's servers — no browser involved.
 */
function refreshDirectorCache() {
  const cache = CacheService.getScriptCache();
  const periods = ['mtd', 'pp'];
  // Uncomment to also pre-warm the PP cache:
  // periods.push('pp');
  periods.forEach(function(period) {
    try {
      const result = buildDirectorAll_(period);
      const json   = JSON.stringify(result);
      saveChunkedCache_(cache, 'gc_dirall_v2_' + period, json, 360); // 6-min TTL — outlasts 5-min trigger
      Logger.log('refreshDirectorCache: cached ' + period + ' (' + json.length + ' bytes)');
    } catch(e) {
      Logger.log('refreshDirectorCache error [' + period + ']: ' + e.message);
    }
  });
}

/**
 * Run once from the GAS editor (Run → setupDirectorTrigger) to install
 * the 2-minute proactive cache trigger.
 */
function setupDirectorTrigger() {
  // Remove any existing triggers for this function to avoid duplicates
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'refreshDirectorCache'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('refreshDirectorCache')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('✅ Trigger created: refreshDirectorCache every 5 minutes.');
  Logger.log('   Verify in Triggers panel (clock icon in GAS editor).');
  // Run once immediately to warm the cache right away
  refreshDirectorCache();
  Logger.log('✅ Cache warmed.');
}
