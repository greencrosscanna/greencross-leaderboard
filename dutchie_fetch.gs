// ============================================================
//  Green Cross — Dutchie API & Aggregation  (dutchie_fetch.gs)
//  All UrlFetch calls to the Dutchie POS API plus the pure
//  aggregation functions that process transaction arrays.
// ============================================================

function getDutchieStoreKey_(slug) {
  const props = PropertiesService.getScriptProperties();
  const keys  = JSON.parse(props.getProperty('DUTCHIE_STORE_KEYS_JSON') || '{}');
  const store = STORES.find(s => s.slug === slug);
  if (!store) throw new Error('Unknown store: ' + slug);
  const key = keys[store.dutchieName];
  if (!key) throw new Error('No Dutchie key for store: ' + store.dutchieName + '. Set DUTCHIE_STORE_KEYS_JSON in Script Properties.');
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
 * chronologically sorted. Paginates past the 5 000-record cap.
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
 * Returns hourly revenue weights for a store based on the last several same-DOW days (HOURLY_DIST_WEEKS).
 * Result: { 9: 0.045, 10: 0.082, ... 22: 0.031 } — fractions that sum to 1.0.
 * Cached per store+DOW per calendar day; the first call of each day fires the
 * parallel Dutchie requests, subsequent calls are instant reads from cache.
 */
function getHourlyDist_(store) {
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

  // Cache — purge stale keys (keep ≤ 60 entries: 6 stores × 7 DOWs × ~1.4 safety)
  cache[cacheKey] = dist;
  const keys = Object.keys(cache).sort();
  while (keys.length > 60) { delete cache[keys.shift()]; }
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
  const keys = Object.keys(cache).sort();
  while (keys.length > 60) { delete cache[keys.shift()]; }
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
