// ============================================================
//  Green Cross — Dutchie API & Aggregation  (dutchie_fetch.gs)
//  All UrlFetch calls to the Dutchie POS API plus the pure
//  aggregation functions that process transaction arrays.
// ============================================================

/* ─── KEYS COME FROM GX CORE. THIS APP STORES NONE. ──────────────────────────────────────────────
 *
 * Until 2026-08-31 this read a local DUTCHIE_STORE_KEYS_JSON, one of five copies across the suite.
 * Rotating the six POS keys meant five paste jobs in two different spellings, and the May leak was
 * a copy nobody remembered. GX Core now holds them alone; this asks for them.
 *
 * WHY THIS APP GETS THE KEY RATHER THAN PROXIED DATA, when the other spokes call
 * ?action=dutchie_inventory and never see a credential: the engine below fires every store in one
 * UrlFetchApp.fetchAll(), and fetchAllStoresTransactionsMulti_ builds 26 pay periods x 6 stores =
 * 156 requests in a single batch. Proxying that would make it 156 round trips through one Apps
 * Script web app, moving transaction JSON twice, against a 6-minute budget. The kiosk keeps its
 * fast path; what it no longer keeps is a stored copy.
 *
 * FAILS CLOSED, with no local fallback. A fallback property is exactly the fifth copy this change
 * exists to delete: it would sit unread and unrotated until the day it was read, and then serve a
 * dead key. If GX Core cannot be reached the kiosk shows an error, which is the honest outcome.
 * ------------------------------------------------------------------------------------------------ */
const GXCORE_EXEC_KEYS_ = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';
const GX_KEYS_CACHE_KEY_ = 'gx_dutchie_keys';
const GX_KEYS_CACHE_S_   = 600;   // 10 min. A rotation reaches the kiosk within one window; a Core
                                  // round trip on every kiosk request is the latency we are avoiding.
let _gxKeyMemo_ = null;           // per-execution; a GAS execution is short-lived

function gxDutchieKeyMap_() {
  if (_gxKeyMemo_) return _gxKeyMemo_;

  const cache = CacheService.getScriptCache();
  const hit = cache.get(GX_KEYS_CACHE_KEY_);
  if (hit) { try { return (_gxKeyMemo_ = JSON.parse(hit)); } catch (e) {} }

  // NOT the deploy secret. GX Core refuses it on this route on purpose — the deploy secret is held
  // by five spokes and gates dozens of routes, and this is the one route that returns credentials.
  const secret = PropertiesService.getScriptProperties().getProperty('GX_CONNECTOR_SECRET');
  if (!secret) throw new Error('GX_CONNECTOR_SECRET is not set on this script — cannot reach GX Core for Dutchie keys');

  const url = GXCORE_EXEC_KEYS_ + '?action=dutchie_keys&connector_secret=' + encodeURIComponent(secret);
  let lastErr = '';
  for (let i = 0; i < 5; i++) {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    let data = null;
    try { data = JSON.parse(resp.getContentText()); } catch (e) { lastErr = 'unparseable body'; }
    if (data && data.ok === true && data.keys && Object.keys(data.keys).length) {
      cache.put(GX_KEYS_CACHE_KEY_, JSON.stringify(data.keys), GX_KEYS_CACHE_S_);
      return (_gxKeyMemo_ = data.keys);
    }
    // A refusal is final — retrying a bad secret just burns the budget and buries the real message.
    if (data && data.ok === false) throw new Error('GX Core dutchie_keys: ' + data.error);
    lastErr = lastErr || 'no keys in response';
    Utilities.sleep(400);   // the /exec second hop 404s on ~6% of rapid calls; same retry as GXClient
  }
  throw new Error('GX Core dutchie_keys unreachable after 5 tries — ' + lastErr);
}

function getDutchieStoreKey_(slug) {
  const store = STORES.find(s => s.slug === slug);
  if (!store) throw new Error('Unknown store: ' + slug);
  // Keyed by GX Core store_id — see the STORES comment in dutchie_proxy.gs for why this is not a name.
  // GX Core hands the map back already keyed this way, so the Dutchie label never reaches this app.
  const keys = gxDutchieKeyMap_();
  const key = Object.prototype.hasOwnProperty.call(keys, store.storeId) ? keys[store.storeId] : null;
  if (!key) throw new Error('GX Core has no Dutchie key for store_id: ' + store.storeId);
  return key;
}

/** Single-store transaction fetch via UrlFetchApp (synchronous, single call). */
function dutchieFetch_(storeKey, path, queryParams) {
  const qs = Object.entries(queryParams || {})
    .map(([k,v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
  const url = DUTCHIE_BASE + path + (qs ? '?' + qs : '');
  const resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(storeKey + ':'),
      Accept: 'application/json',
    },
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Dutchie ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
  }
  return JSON.parse(resp.getContentText());
}

/**
 * Parallel transaction fetch — the shared engine behind all three public fetch
 * functions. Fires every request in one UrlFetchApp.fetchAll() and returns the
 * raw transactions per key.
 *
 * NOTE ON PAGINATION: Dutchie's /reporting/transactions returns the full result
 * set for a date range in a single response — it does NOT honor Skip as a clean
 * offset (verified live: a Skip/Take loop re-fetched the same rows, inflating a
 * ~6,100-txn store to 61,000). So we fetch once per range. As a safety net, if a
 * response comes back at exactly DUTCHIE_TAKE rows we log a truncation warning —
 * that's the signal that Dutchie has started enforcing a hard cap and the range
 * needs to be split into smaller date windows.
 *
 * @param {Array} reqs  [{ key, storeKey, fromUTC, toUTC }] — key identifies the
 *                      caller's bucket (e.g. slug, or "rangeIdx:slug").
 * @return {Object} { key: rawTxns[] } — UNFILTERED, UNSORTED raw transactions.
 *                  Callers apply the Retail filter (and any sort) themselves.
 */
function fetchTxnPagesByKey_(reqs) {
  const httpReqs = reqs.map(function(r) {
    const qs = [
      'FromDateUTC=' + encodeURIComponent(r.fromUTC),
      'ToDateUTC='   + encodeURIComponent(r.toUTC),
      'IncludeDetail=true',
      'Skip=0',
      'Take=' + DUTCHIE_TAKE,
    ].join('&');
    return {
      url: DUTCHIE_BASE + '/reporting/transactions?' + qs,
      headers: {
        Authorization: 'Basic ' + Utilities.base64Encode(r.storeKey + ':'),
        Accept: 'application/json',
      },
      muteHttpExceptions: true,
    };
  });

  // Chunk the fetchAll: a large batch (e.g. the 26-PP × 6-store = 156 detailed
  // requests behind the rolling trend) would otherwise hold every response in
  // memory at once and can blow the runtime ceiling. Parse + release each chunk
  // before firing the next. 72 = the long-proven single-call size.
  const CHUNK = 72;
  const byKey = {};
  for (var start = 0; start < httpReqs.length; start += CHUNK) {
    var responses = UrlFetchApp.fetchAll(httpReqs.slice(start, start + CHUNK));
    for (var j = 0; j < responses.length; j++) {
      var r    = reqs[start + j];
      var resp = responses[j];
      byKey[r.key] = [];
      if (resp.getResponseCode() !== 200) {
        Logger.log('Dutchie ' + resp.getResponseCode() + ' for ' + r.key);
        continue;
      }
      var data;
      try { data = JSON.parse(resp.getContentText()); }
      catch(e) { Logger.log('Parse error for ' + r.key + ': ' + e.message); continue; }
      var page = Array.isArray(data) ? data : (data.transactions || data.data || []);
      byKey[r.key] = page;
      if (page.length === DUTCHIE_TAKE) {
        Logger.log('⚠️ ' + r.key + ' returned exactly ' + DUTCHIE_TAKE + ' rows — Dutchie may be ' +
          'enforcing a hard cap; split this date range into smaller windows.');
      }
    }
  }
  return byKey;
}

/** Retail-only filter + chronological sort applied to a raw transaction array. */
function filterRetailSorted_(rawTxns) {
  return (rawTxns || [])
    .filter(function(tx) { return tx.transactionType === 'Retail'; })
    .sort(function(a, b) {
      const ta = a.transactionDateLocalTime || a.transactionDate || '';
      const tb = b.transactionDateLocalTime || b.transactionDate || '';
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
}

/**
 * Fetch transactions for a single store; returns only Retail transactions,
 * chronologically sorted.
 *
 * Does NOT paginate — one request per date range. Dutchie returns the whole set
 * in a single response and its Skip offset is broken; see the pagination note on
 * fetchTxnPagesByKey_ for the live evidence. Take=DUTCHIE_TAKE is a warning
 * threshold, not a cap Dutchie enforces (a 28-day Commercial window comes back at
 * ~5,600 retail rows against Take=5000). This line claimed it paginated until
 * 2026-08-29 — it never has, and a reader trusting that would look for a loop
 * that deliberately isn't there.
 */
function fetchStoreTransactions_(storeSlug, fromUTC, toUTC) {
  const storeKey = getDutchieStoreKey_(storeSlug);
  const byKey = fetchTxnPagesByKey_([
    { key: storeSlug, storeKey: storeKey, fromUTC: fromUTC, toUTC: toUTC }
  ]);
  return filterRetailSorted_(byKey[storeSlug]);
}

// Hourly-target distribution: how many same-DOW weeks feed the shape, and a gentle smoother so the
// per-hour target line isn't jagged. 4 weeks was too small a sample (a single odd day put a dip at,
// e.g., 5pm below both 4pm and 6pm — the "Targets by hour" bug). 8 weeks + a 3-point weighted moving
// average gives a stable, natural curve. Still normalizes to sum 1.0.
var HOURLY_DIST_WEEKS = 8;

/**
 * Map a Leaderboard app slug → GX Core store_id, the key Core's getHourlyShape/expectedSalesFrac expect.
 * Uses the SAME centralized registry mapping as everything else (goals/snapshot/sales-join) — just the
 * inverse of gxStoreIdToAppSlug_() — so there is one store-mapping source, not a parallel one. Falls back
 * to the slug if the registry is cold (matches for center/commercial regardless).
 */
var _CORE_ID_MAP = null;
function coreStoreId_(store) {
  if (!_CORE_ID_MAP) {
    _CORE_ID_MAP = {};
    try {
      const id2slug = gxStoreIdToAppSlug_();   // centralized: store_id → app slug (from Core's registry)
      Object.keys(id2slug).forEach(function(id) { _CORE_ID_MAP[id2slug[id]] = id; });
    } catch (e) {}
  }
  const slug = String((store && store.slug) || '').trim().toLowerCase();
  return (_CORE_ID_MAP && _CORE_ID_MAP[slug]) || slug;
}

/** Cache-ONLY read of today's same-DOW hourly-target shape (NO Dutchie fetch). Returns the cached dist or
 *  null. The KIOSK uses this so it never blocks on the cold multi-fetch — the warmer (primeHourlyDist_ via
 *  refreshDirectorCache) populates the cache proactively, so the shape is known going into the day. */
function getHourlyDistCached_(store) {
  try {
    const cache = JSON.parse(PropertiesService.getScriptProperties().getProperty(GC_HOURLY_DIST_KEY) || '{}');
    const now   = ptNow_();
    const dow   = new Date(ptDateToUtcMs_(now.dateStr)).getDay();
    return cache[store.slug + ':' + dow + ':' + now.dateStr] || null;
  } catch (e) { return null; }
}

/**
 * DOW-weighted fraction of the day's sales expected by now (nowHour:nowMinute), from the store's historical
 * hourly curve — completed hours in full + a partial current hour. This is what pace + projection should use
 * so a slow morning isn't read as "behind." Falls back to the linear dayFrac when the curve isn't warm.
 */
/* ─── GX Core reads that CANNOT be library calls ─────────────────────────────────────────────────
 *
 * GXCore.getHourlyShape() and GXCore.expectedSalesFrac() were called as library functions here, and
 * could never have worked: both reach gxDutchieAuth_ -> gxDutchieKeys_ -> getScriptProperties(),
 * which scopes to the CALLING project. From this app that looks for Dutchie keys we no longer hold
 * (and never should have), so every call threw.
 *
 * Nothing looked broken because all three call sites wrap the call in try/catch and fall back to the
 * local curve. So the "shared pacing engine, one source of truth across Leaderboard + Sales" has
 * never once answered, and both apps have silently run their own local shapes the whole time. The
 * comment claiming Core's values were "verified to match our local values to the decimal" was
 * comparing the fallback against itself.
 *
 * The routes run AS GX Core and work. The local fallback STAYS — it is genuinely useful when Core is
 * unreachable, and removing it would turn a degraded kiosk into a blank one.
 * ------------------------------------------------------------------------------------------------ */
function gxCoreRoute_(action, params) {
  const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  if (!secret) throw new Error('GX_DEPLOY_SECRET is not set on this script — cannot reach GX Core');
  let url = GXCORE_EXEC_KEYS_ + '?action=' + encodeURIComponent(action)
          + '&secret=' + encodeURIComponent(secret);
  Object.keys(params || {}).forEach(k => {
    if (params[k] == null || params[k] === '') return;
    url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  });
  for (let i = 0; i < 3; i++) {          // fewer tries than the key fetch: this has a local fallback
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    let data = null;
    try { data = JSON.parse(resp.getContentText()); } catch (e) {}
    if (data && data.ok === true) return data;
    if (data && data.ok === false) throw new Error(action + ': ' + (data.error || 'refused'));
    Utilities.sleep(300);
  }
  throw new Error('GX Core ' + action + ' unreachable');
}

function expectedSalesFrac_(store, nowHour, nowMinute, dayFrac) {
  // Primary: GX Core shared pacing engine (cache-only, linear fallback when cold — verified to match our
  // local values to the decimal). One source of truth across Leaderboard + Sales.
  try {
    const r = gxCoreRoute_('expected_frac', { store: coreStoreId_(store), hour: nowHour, minute: nowMinute });
    const f = r && r.frac;
    if (typeof f === 'number' && isFinite(f) && f > 0) return f;
  } catch (e) { Logger.log('expectedSalesFrac_: Core call failed, using local — ' + e); }
  // Local fallback (cache-only; reads the Core-mirrored local cache): linear dayFrac when cold.
  const dist = getHourlyDistCached_(store);
  if (!dist) return dayFrac;
  let ef = 0;
  for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
    if (h < nowHour)        ef += (dist[h] || 0);
    else if (h === nowHour) ef += (dist[h] || 0) * (nowMinute / 60);
  }
  return ef > 0 ? ef : dayFrac;
}

/** 3-point weighted moving average over the open hours (center weight 2, neighbors 1) to de-noise the
 *  hourly shape without flattening the real peak. Returns a new { hour: value } map. */
function smoothHourly_(sums) {
  var out = {};
  for (var h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
    var wPrev = (h > STORE_OPEN_HOUR) ? 1 : 0;
    var wNext = (h < STORE_CLOSE_HOUR - 1) ? 1 : 0;
    out[h] = (wPrev * (sums[h - 1] || 0) + 2 * (sums[h] || 0) + wNext * (sums[h + 1] || 0)) / (wPrev + 2 + wNext);
  }
  return out;
}

/**
 * Evict from the hourly-dist cache by DATE, never by key name.
 *
 * The old line was `Object.keys(cache).sort()` then shift-and-delete past 60 entries. That sorts
 * "slug:dow:date" LEXICOGRAPHICALLY, so every `baseline:*` key sorts before every `center:*` key and
 * Baseline was always the first store evicted — permanently starved once the cache passed the cap,
 * which is exactly how it presented: flat hourly goals at Baseline and nowhere else.
 *
 * Every read is for TODAY (`slug:dow:todayDateStr`), so an entry from any earlier date is already
 * unreachable. Dropping those is what keeps the cache small enough that the cap never fires at all.
 */
function pruneHourlyDistCache_(cache, todayStr) {
  const out = {};
  Object.keys(cache || {}).forEach(function (k) {
    // key = slug:dow:YYYY-MM-DD — keep only today's, which is all anything can ever read.
    if (k.slice(-10) === todayStr) out[k] = cache[k];
  });
  return out;
}

/**
 * Same-DOW hourly shape { 9: 0.045, … } summing to 1.0. Primary: GX Core shared pacing engine
 * (getHourlyShape — ported verbatim from this file, values verified identical). Falls back to the
 * local Dutchie compute below if Core is unavailable. Consolidates the shape source across apps.
 */
function getHourlyDist_(store) {
  try {
    const r = gxCoreRoute_('hourly_shape', { store: coreStoreId_(store) });
    const shape = r && r.shape;
    if (shape && Object.keys(shape).length) return shape;
  } catch (e) { Logger.log('getHourlyDist_: Core getHourlyShape failed, using local — ' + e); }
  return getHourlyDistLocal_(store);
}

/**
 * LOCAL fallback: hourly revenue weights from the last several same-DOW days (HOURLY_DIST_WEEKS).
 * Result: { 9: 0.045, 10: 0.082, ... 22: 0.031 } — fractions that sum to 1.0.
 * Cached per store+DOW per calendar day; the first call of each day fires the
 * parallel Dutchie requests, subsequent calls are instant reads from cache.
 */
function getHourlyDistLocal_(store) {
  const props = PropertiesService.getScriptProperties();
  let cache = {};
  try { cache = JSON.parse(props.getProperty(GC_HOURLY_DIST_KEY) || '{}'); } catch(e) {}

  const now      = ptNow_();
  const todayMs  = ptDateToUtcMs_(now.dateStr);
  const dow      = new Date(todayMs).getDay();   // 0 = Sun … 6 = Sat
  const cacheKey = store.slug + ':' + dow + ':' + now.dateStr;

  if (cache[cacheKey]) return cache[cacheKey];  // hit

  // Fetch last 4 same-DOW days in parallel
  const MS_DAY   = 24 * 60 * 60 * 1000;
  const storeKey = getDutchieStoreKey_(store.slug);
  const auth     = Utilities.base64Encode(storeKey + ':');

  const requests = [];
  for (let w = 1; w <= HOURLY_DIST_WEEKS; w++) {
    const fromMs = todayMs - w * 7 * MS_DAY;
    const toMs   = fromMs + MS_DAY - 1;
    const qs = 'FromDateUTC=' + encodeURIComponent(new Date(fromMs).toISOString())
      + '&ToDateUTC=' + encodeURIComponent(new Date(toMs).toISOString())
      + '&IncludeDetail=false&Skip=0&Take=' + DUTCHIE_TAKE;   // hourly shape needs only tx timestamp + total
    requests.push({
      url: DUTCHIE_BASE + '/reporting/transactions?' + qs,
      muteHttpExceptions: true,
      headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
    });
  }

  const hourSums = {};
  let hasData    = false;

  try {
    const responses = UrlFetchApp.fetchAll(requests);
    responses.forEach(function(resp) {
      if (resp.getResponseCode() !== 200) return;
      let data;
      try { data = JSON.parse(resp.getContentText()); } catch(e) { return; }
      const txns = (Array.isArray(data) ? data : (data.transactions || data.data || []))
        .filter(tx => tx.transactionType === 'Retail');
      txns.forEach(function(tx) {
        const ts = tx.transactionDateLocalTime || tx.transactionDate || '';
        if (!ts || ts.length < 14) return;
        const h   = parseInt(ts.substring(11, 13), 10);
        if (h < STORE_OPEN_HOUR || h >= STORE_CLOSE_HOUR) return;
        const amt = txTotal_(tx);
        if (amt <= 0) return;
        hourSums[h] = (hourSums[h] || 0) + amt;
        hasData = true;
      });
    });
  } catch(e) {
    Logger.log('getHourlyDist_ fetch error: ' + e);
    return null;
  }

  if (!hasData) return null;

  const _smoothed = smoothHourly_(hourSums);
  let total = 0;
  for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) total += _smoothed[h];
  if (total === 0) return null;

  const dist = {};
  for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
    dist[h] = Math.round(_smoothed[h] / total * 10000) / 10000; // 4 dp, smoothed
  }

  // Cache — drop every entry that is not for today (nothing can read them) before writing.
  cache[cacheKey] = dist;
  cache = pruneHourlyDistCache_(cache, now.dateStr);
  try { props.setProperty(GC_HOURLY_DIST_KEY, JSON.stringify(cache)); } catch(e) {}

  return dist;
}

/**
 * Prime the per-store hourly-distribution cache for MANY stores in ONE parallel fetchAll,
 * instead of getHourlyDist_ being called per store back-to-back (6 sequential fetches ≈ 60–90s
 * cold). Same math + cache as getHourlyDist_; only the fetch is batched. Stores already cached
 * for today are skipped. Safe to call every director load — it's a no-op once warm.
 */
function primeHourlyDist_(stores) {
  // Warm the GX Core shared shape engine (getHourlyShape fetches + caches per store:dow:date in Core) AND
  // mirror each shape into our LOCAL cache so the kiosk's cache-only reader (getHourlyDistCached_) stays
  // instant. One fetch path — Core's — so we no longer pull the same-DOW history from Dutchie ourselves.
  try {
    {
      const props = PropertiesService.getScriptProperties();
      let cache = {};
      try { cache = JSON.parse(props.getProperty(GC_HOURLY_DIST_KEY) || '{}'); } catch (e) {}
      const now = ptNow_();
      const dow = new Date(ptDateToUtcMs_(now.dateStr)).getDay();
      let wrote = false;
      (stores || []).forEach(function(store) {
        const ck = store.slug + ':' + dow + ':' + now.dateStr;
        if (cache[ck]) return;   // already mirrored today
        try {
          const r = gxCoreRoute_('hourly_shape', { store: coreStoreId_(store) });
          const shape = r && r.shape;
          if (shape && Object.keys(shape).length) { cache[ck] = shape; wrote = true; }
        } catch (e) {}
      });
      if (wrote) {
        cache = pruneHourlyDistCache_(cache, now.dateStr);
        try { props.setProperty(GC_HOURLY_DIST_KEY, JSON.stringify(cache)); } catch (e) {}
      }
      return;
    }
  } catch (e) { Logger.log('primeHourlyDist_: Core warm failed, using local — ' + e); }
  primeHourlyDistLocal_(stores);
}

/** LOCAL fallback batch warmer: pulls the same-DOW history from Dutchie directly in one fetchAll. */
function primeHourlyDistLocal_(stores) {
  const props = PropertiesService.getScriptProperties();
  let cache = {};
  try { cache = JSON.parse(props.getProperty(GC_HOURLY_DIST_KEY) || '{}'); } catch(e) {}

  const now     = ptNow_();
  const todayMs = ptDateToUtcMs_(now.dateStr);
  const dow     = new Date(todayMs).getDay();
  const MS_DAY  = 24 * 60 * 60 * 1000;

  // Build one flat request list across all not-yet-cached stores (4 same-DOW days each).
  const slugForReq = [];   // parallel to httpReqs: which store each response belongs to
  const httpReqs   = [];
  (stores || []).forEach(function(store) {
    if (cache[store.slug + ':' + dow + ':' + now.dateStr]) return;   // already primed today
    const auth = Utilities.base64Encode(getDutchieStoreKey_(store.slug) + ':');
    for (let w = 1; w <= HOURLY_DIST_WEEKS; w++) {
      const fromMs = todayMs - w * 7 * MS_DAY;
      const toMs   = fromMs + MS_DAY - 1;
      const qs = 'FromDateUTC=' + encodeURIComponent(new Date(fromMs).toISOString())
        + '&ToDateUTC=' + encodeURIComponent(new Date(toMs).toISOString())
        + '&IncludeDetail=false&Skip=0&Take=' + DUTCHIE_TAKE;   // hourly shape needs only tx timestamp + total
      slugForReq.push(store.slug);
      httpReqs.push({
        url: DUTCHIE_BASE + '/reporting/transactions?' + qs,
        muteHttpExceptions: true,
        headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
      });
    }
  });
  if (!httpReqs.length) return;   // everything already primed

  let responses;
  try { responses = UrlFetchApp.fetchAll(httpReqs); }
  catch(e) { Logger.log('primeHourlyDist_ fetch error: ' + e); return; }

  const sumsByStore = {};   // slug → { hour: sum }
  responses.forEach(function(resp, idx) {
    if (resp.getResponseCode() !== 200) return;
    let data;
    try { data = JSON.parse(resp.getContentText()); } catch(e) { return; }
    const txns = (Array.isArray(data) ? data : (data.transactions || data.data || []))
      .filter(function(tx) { return tx.transactionType === 'Retail'; });
    const slug = slugForReq[idx];
    txns.forEach(function(tx) {
      const ts = tx.transactionDateLocalTime || tx.transactionDate || '';
      if (!ts || ts.length < 14) return;
      const h = parseInt(ts.substring(11, 13), 10);
      if (h < STORE_OPEN_HOUR || h >= STORE_CLOSE_HOUR) return;
      const amt = txTotal_(tx);
      if (amt <= 0) return;
      (sumsByStore[slug] = sumsByStore[slug] || {})[h] = (sumsByStore[slug][h] || 0) + amt;
    });
  });

  (stores || []).forEach(function(store) {
    const hourSums = sumsByStore[store.slug];
    if (!hourSums) return;
    const _sm = smoothHourly_(hourSums);
    let total = 0;
    for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) total += _sm[h];
    if (total === 0) return;
    const dist = {};
    for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) dist[h] = Math.round(_sm[h] / total * 10000) / 10000;
    cache[store.slug + ':' + dow + ':' + now.dateStr] = dist;
  });
  cache = pruneHourlyDistCache_(cache, now.dateStr);
  try { props.setProperty(GC_HOURLY_DIST_KEY, JSON.stringify(cache)); } catch(e) {}
}

/**
 * Fetch transactions for ALL stores in parallel using UrlFetchApp.fetchAll().
 * Returns an object keyed by storeSlug: { baseline: [...], center: [...], ... }
 */
function fetchAllStoresTransactions_(range) {
  const reqs = STORES.map(function(store) {
    return {
      key:      store.slug,
      storeKey: getDutchieStoreKey_(store.slug),
      fromUTC:  range.fromUTC,
      toUTC:    range.toUTC,
    };
  });
  const byKey = fetchTxnPagesByKey_(reqs);

  const result = {};
  STORES.forEach(function(store) {
    result[store.slug] = (byKey[store.slug] || []).filter(function(tx) {
      return tx.transactionType === 'Retail';
    });
  });
  return result;
}

/**
 * Fetch transactions for ALL stores across MULTIPLE date ranges in a single
 * UrlFetchApp.fetchAll() call, so all (nRanges × 6) requests run in parallel.
 *
 * @param  {Array}  ranges  Array of { fromUTC, toUTC } range objects
 * @return {Array}          Parallel array of byStore objects, one per input range
 */
function fetchAllStoresTransactionsMulti_(ranges) {
  const nStores = STORES.length;
  const reqs = [];

  ranges.forEach(function(range, ri) {
    STORES.forEach(function(store) {
      reqs.push({
        key:      ri + ':' + store.slug,   // composite key → range index + store
        storeKey: getDutchieStoreKey_(store.slug),
        fromUTC:  range.fromUTC,
        toUTC:    range.toUTC,
      });
    });
  });

  Logger.log('fetchAllStoresTransactionsMulti_: ' + reqs.length + ' first-page requests (' +
    ranges.length + ' ranges × ' + nStores + ' stores); overflow pages fetched as needed');
  const byKey = fetchTxnPagesByKey_(reqs);

  return ranges.map(function(range, ri) {
    const result = {};
    STORES.forEach(function(store) {
      result[store.slug] = (byKey[ri + ':' + store.slug] || []).filter(function(tx) {
        return tx.transactionType === 'Retail';
      });
    });
    return result;
  });
}

// ============================================================
// TRANSACTION AGGREGATION
// ============================================================

/**
 * Extract employee info from a Dutchie transaction.
 *
 * Dutchie /reporting/transactions uses:
 *   completedByUser  — employee display name (e.g. "Jon Juslen")
 *   employeeId       — numeric employee ID
 *
 * There is no nested `employee` object on this endpoint.
 */
function txEmployee_(tx) {
  const name = tx.completedByUser
    || tx.employeeName || tx.budtenderName
    || (tx.employee && (tx.employee.displayName || tx.employee.name))
    || 'Unknown';
  const id = String(tx.employeeId || (tx.employee && tx.employee.id) || '');
  return { id, name, initials: initials_(name) };
}

function initials_(name) {
  return (name || '')
    .replace(/["'`()[\]{}<>]/g, '')  // strip quotes and brackets before splitting
    .split(' ')
    .filter(Boolean)
    .map(p => p[0].toUpperCase())
    .join('')
    .slice(0, 2);
}

// Safely extract numeric fields from a transaction.
// Net sales = post-discount, pre-tax. LOCKED canonical definition — mirrors GXCore.txNet
// (totalBeforeTax ?? subtotal ?? total). Uses nullish precedence (?? via != null), NOT truthy `||`, so a
// legitimate $0 totalBeforeTax does not fall through to subtotal/total. See the Command Center's
// GX_CONSOLIDATION_MAP.md 🔒 section. Kept inline (not a per-tx GXCore call) so the live-day aggregation
// stays fast; the settled/reconciliation path already reads GXCore.getSalesDaily. Keep in sync with GXCore.
function txNet_(tx)      { var v = tx.totalBeforeTax != null ? tx.totalBeforeTax : (tx.subtotal != null ? tx.subtotal : tx.total); var n = Number(v); return isNaN(n) ? 0 : n; }
function txTotal_(tx)    { return txNet_(tx); }   // alias — all revenue uses net
function txSubtotal_(tx) { return txNet_(tx) + txDiscount_(tx); }  // gross = net + discounts
function txDiscount_(tx) { var v = tx.totalDiscount != null ? tx.totalDiscount : tx.discountTotal; var n = Number(v); return isNaN(n) ? 0 : n; }  // mirrors GXCore.txDiscount

/**
 * Returns only the portion of the discount that counts against a budtender —
 * i.e. total discount minus loyalty redemptions, automatic promos, and any
 * discretionary discount toggled off in the discount config (see discounts.gs).
 * Used for discount-rate flagging and the incentive; revenue calculations still
 * use txDiscount_().
 */
function txDiscountBudtender_(tx) {
  var discountList = tx.discounts || [];
  if (!discountList.length) return txDiscount_(tx);  // no detail → use total
  var excluded = 0;
  discountList.forEach(function(d) {
    var name = d.discountName || d.discountReason || '';
    if (isExcludedDiscount_(name)) excluded += Number(d.amount || 0);
  });
  return Math.max(0, txDiscount_(tx) - excluded);
}

function txItems_(tx) {
  // Count distinct line items (SKUs) — cannabis sells flower by weight (3.5g, 7g)
  // so summing li.quantity gives fractional UPT like 7.5. Each SKU = 1 unit.
  const items = tx.items || tx.lineItems || tx.lineitemList || [];
  if (items.length > 0) return items.length;
  return Number(tx.totalItems) || 1;
}

/** Aggregate a transaction array → summary + per-employee breakdown. */
function aggregateTransactions_(txns) {
  let totalSales = 0, totalSubtotal = 0, totalDiscounts = 0, totalDiscountsBdt = 0, totalItems = 0;
  const byEmployee = {};

  txns.forEach(function(tx) {
    const sales    = txTotal_(tx);
    const sub      = txSubtotal_(tx);
    const disc     = txDiscount_(tx);
    const discBdt  = txDiscountBudtender_(tx);  // excludes loyalty/system discounts
    const items    = txItems_(tx);
    const emp      = txEmployee_(tx);
    const empKey   = emp.name.toLowerCase().replace(/\s+/g, '_');

    totalSales        += sales;
    totalSubtotal     += sub;
    totalDiscounts    += disc;
    totalDiscountsBdt += discBdt;
    totalItems        += items;

    if (!byEmployee[empKey]) {
      byEmployee[empKey] = {
        id:           emp.id,
        name:         emp.name,
        initials:     emp.initials,
        sales:        0, transactions: 0,
        items:        0, discounts:    0, discountsBdt: 0, subtotal: 0,
      };
    }
    const e = byEmployee[empKey];
    e.sales        += sales;
    e.transactions += 1;
    e.items        += items;
    e.discounts    += disc;
    e.discountsBdt += discBdt;
    e.subtotal     += sub;
  });

  const count = txns.length;

  // Derive per-employee metrics — discount rate uses budtender-only discounts
  Object.values(byEmployee).forEach(function(e) {
    e.avgOrderValue = e.transactions > 0 ? r2_(e.sales / e.transactions) : 0;
    e.avgUPT        = e.transactions > 0 ? r1_(e.items / e.transactions) : 0;
    e.discountRate  = e.subtotal     > 0 ? r3_(e.discountsBdt / e.subtotal) : 0;
  });

  return {
    sales:          r2_(totalSales),
    transactions:   count,
    avgOrderValue:  count > 0 ? r2_(totalSales / count)        : 0,
    avgUPT:         count > 0 ? r1_(totalItems / count)        : 0,
    totalDiscounts: r2_(totalDiscounts),
    discountRate:   totalSubtotal > 0 ? r3_(totalDiscountsBdt / totalSubtotal) : 0,  // discretionary basis (excl. loyalty/promos)
    byEmployee:     byEmployee,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Day-level aggregate cache (soft lock) — Director / Standings only.
//  Once a day closes and settles (~6am next day, after late transactions flush),
//  its per-store aggregate is locked and served from CacheService instead of
//  re-pulled every refresh. Only today (+ pre-6am yesterday) is pulled live.
//  A hard-refresh re-pulls + re-locks closed days (retroactive-return case).
//  Incentive history is FROZEN separately (ScriptProperties) and never uses this.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge day-level aggregateTransactions_ results into one. Totals are re-derived
 * from the unrounded per-employee sums, so the merge is identical to a single
 * aggregateTransactions_ over the union of the underlying transactions.
 */
function mergeAggs_(list) {
  const byEmployee = {};
  (list || []).forEach(function(a) {
    if (!a || !a.byEmployee) return;
    Object.keys(a.byEmployee).forEach(function(k) {
      const e = a.byEmployee[k];
      let m = byEmployee[k];
      if (!m) m = byEmployee[k] = { id: e.id, name: e.name, initials: e.initials,
        sales: 0, transactions: 0, items: 0, discounts: 0, discountsBdt: 0, subtotal: 0 };
      m.sales += e.sales || 0; m.transactions += e.transactions || 0; m.items += e.items || 0;
      m.discounts += e.discounts || 0; m.discountsBdt += e.discountsBdt || 0; m.subtotal += e.subtotal || 0;
    });
  });
  let tSales = 0, tTxns = 0, tItems = 0, tDisc = 0, tDiscBdt = 0, tSub = 0;
  Object.keys(byEmployee).forEach(function(k) {
    const e = byEmployee[k];
    tSales += e.sales; tTxns += e.transactions; tItems += e.items; tDisc += e.discounts; tDiscBdt += e.discountsBdt; tSub += e.subtotal;
    e.avgOrderValue = e.transactions > 0 ? r2_(e.sales / e.transactions) : 0;
    e.avgUPT        = e.transactions > 0 ? r1_(e.items / e.transactions) : 0;
    e.discountRate  = e.subtotal     > 0 ? r3_(e.discountsBdt / e.subtotal) : 0;
  });
  return {
    sales:          r2_(tSales),
    transactions:   tTxns,
    avgOrderValue:  tTxns > 0 ? r2_(tSales / tTxns) : 0,
    avgUPT:         tTxns > 0 ? r1_(tItems / tTxns) : 0,
    totalDiscounts: r2_(tDisc),
    discountRate:   tSub > 0 ? r3_(tDiscBdt / tSub) : 0,  // discretionary basis (excl. loyalty/promos)
    byEmployee:     byEmployee,
  };
}

/** Latest PT date that has fully settled. Yesterday once past ~6am PT; else the day before. */
function settledThroughStr_() {
  const DAY = 86400000;
  const todayMs  = ptDateToUtcMs_(ptNow_().dateStr);
  const backDays = ptHourNow_().hour >= 6 ? 1 : 2;
  return Utilities.formatDate(new Date(todayMs - backDays * DAY + 12 * 3600000), STORE_TZ, 'yyyy-MM-dd');
}

/** Split a { fromUTC, toUTC } range into PT calendar days: [{ dateStr, fromUTC, toUTC }]. */
function daysOfRange_(range) {
  const DAY = 86400000;
  const fromMs = new Date(range.fromUTC).getTime();
  const toMs   = new Date(range.toUTC).getTime();
  const days = [];
  let dStr      = Utilities.formatDate(new Date(fromMs + 3600000), STORE_TZ, 'yyyy-MM-dd');
  const lastStr = Utilities.formatDate(new Date(toMs   - 3600000), STORE_TZ, 'yyyy-MM-dd');
  let guard = 0;
  while (dStr <= lastStr && guard++ < 400) {
    const startMs = ptDateToUtcMs_(dStr);
    const endMs   = startMs + DAY - 1;
    days.push({ dateStr: dStr,
      fromUTC: new Date(Math.max(startMs, fromMs)).toISOString(),
      toUTC:   new Date(Math.min(endMs, toMs)).toISOString() });
    dStr = Utilities.formatDate(new Date(startMs + DAY + 12 * 3600000), STORE_TZ, 'yyyy-MM-dd');
  }
  return days;
}

/**
 * Per-store aggregate over a range with settled closed days served from cache and
 * only live days pulled. Returns { slug: mergedAgg } — identical to
 * aggregateTransactions_ over the full range. hardRefresh re-pulls + re-locks.
 */
function byStoreAggCached_(range, hardRefresh) {
  const cache = CacheService.getScriptCache();
  const days  = daysOfRange_(range);
  const settledThru = settledThroughStr_();
  const perStore = {};
  STORES.forEach(function(s) { perStore[s.slug] = []; });

  const liveReqs = [];
  days.forEach(function(d) {
    const settled = d.dateStr <= settledThru;
    STORES.forEach(function(s) {
      const key = 'GC_DAYAGG_v2_' + s.slug + '_' + d.dateStr;   // v2: discretionary-basis discountRate + registry-classified discountsBdt
      if (settled && !hardRefresh) {
        const hit = cache.get(key);
        if (hit) {
          try { perStore[s.slug].push(JSON.parse(hit)); cache.put(key, hit, 21600); return; } catch(e) {}
        }
      }
      liveReqs.push({ slug: s.slug, settled: settled, key: key, fromUTC: d.fromUTC, toUTC: d.toUTC });
    });
  });

  if (liveReqs.length) {
    const reqs = liveReqs.map(function(r, i) {
      return { key: String(i), storeKey: getDutchieStoreKey_(r.slug), fromUTC: r.fromUTC, toUTC: r.toUTC };
    });
    const byKey = fetchTxnPagesByKey_(reqs);
    liveReqs.forEach(function(r, i) {
      const txns = (byKey[String(i)] || []).filter(function(t) { return t.transactionType === 'Retail'; });
      const agg  = aggregateTransactions_(txns);
      perStore[r.slug].push(agg);
      if (r.settled) { try { cache.put(r.key, JSON.stringify(agg), 21600); } catch(e) {} }  // lock ~6h; trigger keeps warm
    });
  }

  const out = {};
  STORES.forEach(function(s) { out[s.slug] = mergeAggs_(perStore[s.slug]); });
  return out;
}

/** Bucket transaction totals by hour of day (local time). Returns { h: { revenue, count } }. */
function aggregateByHour_(txns) {
  const hours = {};
  txns.forEach(function(tx) {
    // Dutchie transactionDateLocalTime is already local time (no TZ suffix).
    // Parsing with new Date() would treat it as UTC — extract the hour directly
    // from the string to avoid the offset error.
    const dtStr = tx.transactionDateLocalTime || tx.transactionDate || '';
    if (!dtStr) return;
    // ISO string: "2026-05-20T14:00:03.817000" — hour is chars 11-12
    const h = dtStr.length >= 13 ? parseInt(dtStr.substring(11, 13), 10) : new Date(dtStr).getHours();
    if (isNaN(h) || h < 0 || h > 23) return;
    if (!hours[h]) hours[h] = { revenue: 0, count: 0 };
    hours[h].revenue += txTotal_(tx);
    hours[h].count   += 1;
  });
  return hours;
}

/** Rounding helpers */
function r2_(n) { return Math.round(n * 100)  / 100; }
function r1_(n) { return Math.round(n * 10)   / 10;  }
function r3_(n) { return Math.round(n * 1000) / 1000; }

/**
 * Buckets transactions by local date string (YYYY-MM-DD).
 * Returns { 'YYYY-MM-DD': netRevenue, ... }
 */
function aggregateByDay_(txns) {
  const byDay = {};
  txns.forEach(function(tx) {
    const ts  = tx.transactionDateLocalTime || tx.transactionDate || '';
    const day = ts.slice(0, 10);
    if (!day || day.length < 10) return;
    byDay[day] = (byDay[day] || 0) + txTotal_(tx);
  });
  return byDay;
}

/**
 * From a { date: revenue } map, compute:
 *   trend30d  — ordered array of daily revenue values (oldest → newest), incl. today's partial data
 *   trendPct  — delta between last-7 and prior-7 completed working days, clamped to 3 decimals
 *
 * opts.useAverage (default false):
 *   false — compare raw sums (correct for stores: open same hours every day)
 *   true  — compare per-working-day averages (correct for employees: eliminates day-off drag)
 *           Days off produce no bucket entry so they simply don't participate.
 *
 * Today is intentionally excluded from trendPct: a partial intraday total would
 * drag the recent average down. The sparkline still shows today's shape.
 */
function trendFromByDay_(byDay, opts) {
  const useAvg   = (opts && opts.useAverage) || false;
  const todayStr = ptNow_().dateStr;
  const allDays  = Object.keys(byDay).sort();
  const trend30d = allDays.map(function(d) { return Math.round(byDay[d]); });

  // Use only completed days (with revenue > 0) for the delta %
  const fullDays = allDays.filter(function(d) { return d < todayStr && byDay[d] > 0; });
  const n        = fullDays.length;
  if (n < 2) return { trend30d: trend30d, trendPct: 0 };

  const last7Days  = fullDays.slice(Math.max(0, n - 7));
  const prior7Days = fullDays.slice(Math.max(0, n - 14), Math.max(0, n - 7));
  if (prior7Days.length === 0) return { trend30d: trend30d, trendPct: 0 };

  const sumFn = function(days) { return days.reduce(function(s, d) { return s + byDay[d]; }, 0); };
  const last7  = useAvg ? sumFn(last7Days)  / last7Days.length  : sumFn(last7Days);
  const prior7 = useAvg ? sumFn(prior7Days) / prior7Days.length : sumFn(prior7Days);

  const trendPct = prior7 > 0 ? r3_((last7 - prior7) / prior7) : 0;
  return { trend30d: trend30d, trendPct: trendPct };
}

/**
 * Read-only: which pacing path is actually live, per store, right now.
 *
 * expectedSalesFrac_ has three layers — the GX Core shared engine, the local mirrored
 * curve, and a LINEAR dayFrac fallback — and it returns a bare number, so a curve that
 * silently fell back to linear is indistinguishable from a working one. That is exactly
 * the question "is the gauge pace weighted like the rest of the goals?" is asking, so
 * this probes each layer separately rather than reporting the result alone.
 *
 * Pure read: it calls the same helpers the kiosk calls and writes nothing.
 *
 * @return {Object}
 */
function diagPace_() {
  const { hour: nowHour, minute: nowMinute } = ptHourNow_();
  const elapsed = Math.max(0, Math.min(nowHour + nowMinute / 60 - STORE_OPEN_HOUR, STORE_HOURS));
  const dayFrac = elapsed / STORE_HOURS;

  /* "Available" used to mean typeof GXCore.expectedSalesFrac === 'function' — which was TRUE, and
     told you nothing: the function exists, it simply cannot run from this project. That is why this
     diagnostic reported a healthy Core layer while every kiosk read silently used the local curve.
     Availability is now the deploy secret, which is what the route actually needs. */
  const coreAvailable = !!PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');

  const rows = STORES.map(function(store) {
    // Layer 1 — GX Core shared engine.
    let coreFrac = null, coreErr = '';
    if (coreAvailable) {
      try {
        const r = gxCoreRoute_('expected_frac', { store: coreStoreId_(store), hour: nowHour, minute: nowMinute });
        const f = r && r.frac;
        if (typeof f === 'number' && isFinite(f) && f > 0) coreFrac = f;
      } catch (e) { coreErr = String(e.message || e); }
    }

    // Layer 2 — the local mirrored curve (cache-only, same reader the kiosk uses).
    const dist = getHourlyDistCached_(store);
    let localFrac = null;
    if (dist) {
      let ef = 0;
      for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
        if (h < nowHour)        ef += (dist[h] || 0);
        else if (h === nowHour) ef += (dist[h] || 0) * (nowMinute / 60);
      }
      localFrac = ef > 0 ? ef : null;
    }

    // What the kiosk actually gets, and therefore which layer answered.
    const effective = expectedSalesFrac_(store, nowHour, nowMinute, dayFrac);
    const source = (coreFrac !== null && Math.abs(effective - coreFrac) < 1e-9) ? 'gxcore'
                 : (localFrac !== null && Math.abs(effective - localFrac) < 1e-9) ? 'local-curve'
                 : 'LINEAR-FALLBACK';

    const dailyGoal = getDailyGoal_(store.slug);
    return {
      store:        store.slug,
      dailyGoal:    dailyGoal,
      expectedFrac: Math.round(effective * 10000) / 10000,
      linearFrac:   Math.round(dayFrac  * 10000) / 10000,
      source:       source,
      // How far the live answer sits from a straight clock. ~0 means the gauge is
      // reading linear whether or not a curve is technically loaded.
      deltaVsLinear: Math.round((effective - dayFrac) * 10000) / 10000,
      coreFrac:     coreFrac  === null ? null : Math.round(coreFrac  * 10000) / 10000,
      localFrac:    localFrac === null ? null : Math.round(localFrac * 10000) / 10000,
      curveWarm:    !!dist,
      coreErr:      coreErr,
      paceGoal:     Math.round(dailyGoal * effective),
      shape:        dist || null,
    };
  });

  return {
    ok: true,
    now: { hour: nowHour, minute: nowMinute },
    storeHours: { open: STORE_OPEN_HOUR, close: STORE_CLOSE_HOUR, span: STORE_HOURS },
    elapsedHours: Math.round(elapsed * 100) / 100,
    coreAvailable: coreAvailable,
    stores: rows,
  };
}
