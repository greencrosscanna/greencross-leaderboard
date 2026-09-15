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
  const entries = Object.create(null);
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
//      every 5 minutes on Google's servers.
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
//    Verify in Triggers (clock icon) that the 5-min trigger exists.
// ============================================================

/**
 * Core build function used by both doGet and the proactive trigger.
 * Fetches all Dutchie data for the given period and returns the
 * full directorall payload object.
 */
function buildDirectorAll_(period, hardRefresh) {
  return withTxnMemo_(function () { return buildDirectorAllInner_(period, hardRefresh); });   // one download of today per build
}

function buildDirectorAllInner_(period, hardRefresh) {
  period = period || 'mtd';
  const params = { period: period };
  const range  = getDateRange_(period);
  const prior  = getPriorRange_(range);
  const todayR = getDateRange_('today');
  const mtdR   = period === 'mtd' ? null : getDateRange_('mtd');

  const storeTrendCache = getStoreTrendCache_();
  resetStoresUnavailable_();   // only failures from THIS build belong on the board

  // Day-cached per-store aggregates: settled closed days come from CacheService,
  // only today (+ pre-6am yesterday) is pulled live. hardRefresh re-pulls + re-locks.
  const byStoreAgg     = byStoreAggCached_(range, hardRefresh);
  const prevByStoreAgg = byStoreAggCached_(prior, hardRefresh);                 // prior period fully settled → all cached
  const byStoreMTDAgg  = mtdR ? byStoreAggCached_(mtdR, hardRefresh) : byStoreAgg;

  // Still pulled live/raw: TODAY (intraday pace, ticker, today card) and the
  // 30-day trend window (only when the trend cache is cold).
  const rawList = [todayR];
  if (!storeTrendCache) rawList.push(getDateRange_('30d'));
  const rawFetched   = fetchAllStoresTransactionsMulti_(rawList);
  const byStoreToday = rawFetched[0];
  const byStore30d   = storeTrendCache ? null : rawFetched[rawList.length - 1];
  const storeTrends  = storeTrendCache || saveStoreTrendCache_(byStore30d) || {};

  const summary       = getDirectorSummary(params, { byStoreAgg, prevByStoreAgg });
  const stores        = getDirectorStores(params,  { byStoreAgg, byStoreToday, byStore30d, storeTrends });
  const staff         = getDirectorStaff(params,   { byStoreAgg, byStore30d, byStoreToday });
  const alerts        = getDirectorAlerts(         { byStoreAgg: byStoreMTDAgg });
  const today         = getDirectorToday(byStoreToday);
  const avatarConfigs = getAvatarConfigs_();
  const eomKey        = (getEomCurrent_() || {}).employeeKey || null;

  // Stores this build could not read. Their numbers above are empty, not measured -- the screen
  // must say "Unavailable" for them rather than draw $0. See markStoreUnavailable_.
  const unavailableStores = storesUnavailable_();

  return { summary, stores, staff, alerts, today, avatarConfigs, eomKey, discountTarget: getDiscountTargetDec_(), unavailableStores };
}

/* How long a built directorall payload is served. Shared by this trigger and the directorall route
 * so the two cannot drift. It was 360s: a refresh that ran past six minutes (they ran up to 7.5 on
 * 2026-09-15) let the cache lapse, and the next director tab rebuilt the whole thing inside a web
 * request — on the same crowded account the slow refresh was already crowding. 15 minutes rides
 * out a slow or skipped run; a healthy one still replaces it every five. */
var DIRECTOR_CACHE_TTL_S = 900;

/**
 * Called by the time-based trigger every 5 minutes.
 * Builds and caches directorall for 'mtd' and 'pp'.
 * Runs on Google's servers — no browser involved.
 */
function refreshDirectorCache() {
  /* NEVER TWO AT ONCE. There was no guard, and a run that outlasted five minutes simply had the next
   * one start on top of it, both downloading the same day from Dutchie. Every GX app runs as one
   * Google account capped at 30 simultaneous executions; the overlap is how this trigger came to
   * hold one or two of those slots nearly all day on 2026-09-15.
   *
   * The USER lock, not the script lock, on purpose: bugMailOnce_ waits up to 5s on the script lock
   * inside a staff-facing request, and a refresh holding it for a minute would put that wait on
   * every bug report filed meanwhile. Nothing else takes the user lock. tryLock(0): a run that finds
   * one already going has nothing to add, so it leaves at once rather than queueing. Apps Script
   * releases the lock itself if a run dies, so a crashed refresh cannot wedge the next. */
  const runLock = LockService.getUserLock();
  if (!runLock.tryLock(0)) {
    Logger.log('refreshDirectorCache: previous run still going — skipped');
    return;
  }
  try {
    withTxnMemo_(refreshDirectorCacheLocked_);   // mtd and pp share one download of today
  } finally {
    runLock.releaseLock();
  }
}

function refreshDirectorCacheLocked_() {
  refreshStoreRegistry_();   // the store list comes from GX Core -- see dutchie_proxy.gs
  // Warm-instance guard: this trigger builds a cached aggregate that carries the budtender
  // discount rate, and the discount overrides now come from GX Core (readDiscConfig_).
  // Drop the per-execution memo so a warm instance cannot score against rules Crew has changed.
  resetDiscountMemos_();
  const cache = CacheService.getScriptCache();

  // Precompute the per-store hourly-target SHAPE for today so the kiosk "by hour" chart never waits on
  // it (it's pure same-DOW history — known going into the day). primeHourlyDist_ batches all stores in ONE
  // fetchAll and no-ops once warm, so this warms the new day within minutes of midnight and re-warms fast
  // after a deploy/cache-clear. Without it, the FIRST kiosk load of a store each morning paid the cold
  // multi-fetch cost (60s+). Cheap here (background trigger); saves the staff-facing wait.
  try { primeHourlyDist_(STORES); } catch (e) { Logger.log('refreshDirectorCache: primeHourlyDist_ error: ' + e.message); }

  const periods = ['mtd', 'pp'];
  periods.forEach(function(period) {
    try {
      const result = buildDirectorAll_(period);
      const json   = JSON.stringify(result);
      saveChunkedCache_(cache, 'gc_dirall_v2_' + period, json, DIRECTOR_CACHE_TTL_S);
      Logger.log('refreshDirectorCache: cached ' + period + ' (' + json.length + ' bytes)');
    } catch(e) {
      Logger.log('refreshDirectorCache error [' + period + ']: ' + e.message);
    }
  });

  // Keep the discount registry fresh (only rebuilds if >12h stale → ~2×/day).
  try { refreshDiscountRegistryIfStale_(12); }
  catch(e) { Logger.log('refreshDirectorCache: registry refresh error: ' + e.message); }
}

/**
 * Run once from the GAS editor (Run → setupDirectorTrigger) to install
 * the 5-minute proactive cache trigger.
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
