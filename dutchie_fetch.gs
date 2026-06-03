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
 * Paginated parallel transaction fetch — the shared engine behind all three
 * public fetch functions. Handles Dutchie's 5 000-record page cap so periods
 * with more transactions than that are no longer silently truncated.
 *
 * Strategy: fire every request's first page in one parallel fetchAll(). Any
 * response whose RAW page is full (=== DUTCHIE_TAKE) might have more, so its
 * next page is queued and the still-incomplete requests are fetched in the next
 * parallel round. Most ranges finish in one round (no overflow); only busy
 * store-ranges pay for extra rounds. Bounded by DUTCHIE_MAX_PAGES.
 *
 * @param {Array} reqs  [{ key, storeKey, fromUTC, toUTC }] — key identifies the
 *                      caller's bucket (e.g. slug, or "rangeIdx:slug").
 * @return {Object} { key: rawTxns[] } — UNFILTERED, UNSORTED raw transactions.
 *                  Callers apply the Retail filter (and any sort) themselves.
 */
function fetchTxnPagesByKey_(reqs) {
  const byKey = {};
  reqs.forEach(function(r) { byKey[r.key] = []; });

  let pending = reqs.map(function(r) { return { r: r, skip: 0 }; });
  let round = 0;

  while (pending.length && round < DUTCHIE_MAX_PAGES) {
    round++;
    const httpReqs = pending.map(function(p) {
      const qs = [
        'FromDateUTC=' + encodeURIComponent(p.r.fromUTC),
        'ToDateUTC='   + encodeURIComponent(p.r.toUTC),
        'IncludeDetail=true',
        'Skip=' + p.skip,
        'Take=' + DUTCHIE_TAKE,
      ].join('&');
      return {
        url: DUTCHIE_BASE + '/reporting/transactions?' + qs,
        headers: {
          Authorization: 'Basic ' + Utilities.base64Encode(p.r.storeKey + ':'),
          Accept: 'application/json',
        },
        muteHttpExceptions: true,
      };
    });

    const responses = UrlFetchApp.fetchAll(httpReqs);
    const next = [];
    responses.forEach(function(resp, i) {
      const p = pending[i];
      if (resp.getResponseCode() !== 200) {
        Logger.log('Dutchie ' + resp.getResponseCode() + ' for ' + p.r.key + ' (skip ' + p.skip + ')');
        return; // keep whatever pages we already have for this key
      }
      let data;
      try { data = JSON.parse(resp.getContentText()); }
      catch(e) { Logger.log('Parse error for ' + p.r.key + ': ' + e.message); return; }
      const page = Array.isArray(data) ? data : (data.transactions || data.data || []);
      byKey[p.r.key] = byKey[p.r.key].concat(page);
      // A full raw page means there may be more — queue the next page.
      if (page.length >= DUTCHIE_TAKE) next.push({ r: p.r, skip: p.skip + DUTCHIE_TAKE });
    });
    pending = next;
  }

  if (pending.length) {
    Logger.log('⚠️ fetchTxnPagesByKey_: hit DUTCHIE_MAX_PAGES (' + DUTCHIE_MAX_PAGES +
      ') — data may be truncated for: ' + pending.map(function(p){ return p.r.key; }).join(', '));
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

/**
 * Returns hourly revenue weights for a store based on the last 4 same-DOW days.
 * Result: { 9: 0.045, 10: 0.082, ... 22: 0.031 } — fractions that sum to 1.0.
 * Cached per store+DOW per calendar day; the first call of each day fires 4
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
  for (let w = 1; w <= 4; w++) {
    const fromMs = todayMs - w * 7 * MS_DAY;
    const toMs   = fromMs + MS_DAY - 1;
    const qs = 'FromDateUTC=' + encodeURIComponent(new Date(fromMs).toISOString())
      + '&ToDateUTC=' + encodeURIComponent(new Date(toMs).toISOString())
      + '&IncludeDetail=true&Skip=0&Take=' + DUTCHIE_TAKE;
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

  const total = Object.values(hourSums).reduce((s, v) => s + v, 0);
  if (total === 0) return null;

  const dist = {};
  for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
    dist[h] = Math.round((hourSums[h] || 0) / total * 10000) / 10000; // 4 dp
  }

  // Cache — purge stale keys (keep ≤ 60 entries: 6 stores × 7 DOWs × ~1.4 safety)
  cache[cacheKey] = dist;
  const keys = Object.keys(cache).sort();
  while (keys.length > 60) { delete cache[keys.shift()]; }
  try { props.setProperty(GC_HOURLY_DIST_KEY, JSON.stringify(cache)); } catch(e) {}

  return dist;
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
// Net sales = post-discount, pre-tax  (matches greencross-dashboard convention)
//   Dutchie field: totalBeforeTax → subtotal → total (fallback)
// Gross sales = net + discounts (pre-discount, pre-tax)
function txNet_(tx)      { return Number(tx.totalBeforeTax || tx.subtotal || tx.total || 0); }
function txTotal_(tx)    { return txNet_(tx); }   // alias — all revenue uses net
function txSubtotal_(tx) { return txNet_(tx) + txDiscount_(tx); }  // gross = net + discounts
function txDiscount_(tx) { return Number(tx.totalDiscount  || tx.discountTotal || 0); }

/**
 * Returns only the portion of the discount that counts against a budtender —
 * i.e. total discount minus any system-applied discounts (loyalty, points, etc.).
 * Used for discount-rate flagging; revenue calculations still use txDiscount_().
 */
function txDiscountBudtender_(tx) {
  var discountList = tx.discounts || [];
  if (!discountList.length) return txDiscount_(tx);  // no detail → use total
  var excluded = 0;
  discountList.forEach(function(d) {
    var name = (d.discountName || d.discountReason || '').toLowerCase();
    if (EXCLUDED_DISCOUNT_KEYWORDS.some(function(kw) { return name.indexOf(kw) !== -1; })) {
      excluded += Number(d.amount || 0);
    }
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
  let totalSales = 0, totalSubtotal = 0, totalDiscounts = 0, totalItems = 0;
  const byEmployee = {};

  txns.forEach(function(tx) {
    const sales    = txTotal_(tx);
    const sub      = txSubtotal_(tx);
    const disc     = txDiscount_(tx);
    const discBdt  = txDiscountBudtender_(tx);  // excludes loyalty/system discounts
    const items    = txItems_(tx);
    const emp      = txEmployee_(tx);
    const empKey   = emp.name.toLowerCase().replace(/\s+/g, '_');

    totalSales     += sales;
    totalSubtotal  += sub;
    totalDiscounts += disc;
    totalItems     += items;

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
    discountRate:   totalSubtotal > 0 ? r3_(totalDiscounts / totalSubtotal) : 0,
    byEmployee:     byEmployee,
  };
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
