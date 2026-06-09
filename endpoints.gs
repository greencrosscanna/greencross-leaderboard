// ============================================================
//  Green Cross — Data Endpoints  (endpoints.gs)
//  getDirector*, getStore*, getLeaderboard* functions that
//  assemble payloads for the browser.  Also: avatar config,
//  date-range helpers, and admin data actions.
// ============================================================

/**
 * Convert a period string to a UTC date range suitable for Dutchie API calls.
 * All calendar math is done in local (Portland) time, then converted to UTC.
 *
 * @param  {string} period  'today' | 'wtd' | 'mtd' | 'qtd' | 'ytd'
 * @return {Object} { fromUTC, toUTC, fromLocal, toLocal, daysElapsed, totalDays, period }
 */
function getDateRange_(period) {
  const pt = ptNow_();
  const { year: y, month: m, day: d, dateStr: todayStr } = pt;

  // PT midnight today → UTC ms (DST-correct)
  const todayStartMs = ptDateToUtcMs_(todayStr);
  const todayEndMs   = todayStartMs + 24 * 60 * 60 * 1000 - 1;

  let fromMs, toMs;

  switch ((period || 'mtd').toLowerCase()) {
    case 'today':
      fromMs = todayStartMs;
      toMs   = todayEndMs;
      break;
    case 'wtd': {
      // Go back to Monday (PT)
      const daysToMon = pt.dow === 0 ? 6 : pt.dow - 1;
      fromMs = todayStartMs - daysToMon * 24 * 60 * 60 * 1000;
      toMs   = todayEndMs;
      break;
    }
    case 'qtd': {
      const qStartMonth = Math.floor(m / 3) * 3;
      const qStr = y + '-' + String(qStartMonth + 1).padStart(2, '0') + '-01';
      fromMs = ptDateToUtcMs_(qStr);
      toMs   = todayEndMs;
      break;
    }
    case 'ytd': {
      fromMs = ptDateToUtcMs_(y + '-01-01');
      toMs   = todayEndMs;
      break;
    }
    case 'pp': {
      // Bi-weekly pay period — anchor and offset via shared helper.
      const { ppStartMs, PP_MS } = currentPPStart_();
      fromMs = ppStartMs;
      toMs   = ppStartMs + PP_MS - 1;
      break;
    }
    case '30d': {
      fromMs = todayStartMs - 29 * 24 * 60 * 60 * 1000; // last 30 days incl. today
      toMs   = todayEndMs;
      break;
    }
    case 'mtd':
    default: {
      const mtdStr = y + '-' + String(m + 1).padStart(2, '0') + '-01';
      fromMs = ptDateToUtcMs_(mtdStr);
      toMs   = todayEndMs;
      break;
    }
  }

  // fromMs / toMs are already UTC ms — no further offset needed
  const fromUTC = new Date(fromMs);
  const toUTC   = new Date(toMs);

  function fmtDate(ms) {
    return Utilities.formatDate(new Date(ms), STORE_TZ, 'yyyy-MM-dd');
  }

  const DAY_MS      = 24 * 60 * 60 * 1000;
  const daysElapsed = Math.max(1, Math.round((todayStartMs - fromMs) / DAY_MS) + 1);
  // toMs is end-of-last-day, so (toMs - fromMs) already spans the whole range;
  // round() alone gives the inclusive day count (no +1, which would over-count).
  const totalDays   = Math.max(1, Math.round((toMs - fromMs) / DAY_MS));

  return {
    fromUTC:     fromUTC.toISOString(),
    toUTC:       toUTC.toISOString(),
    fromLocal:   fmtDate(fromMs),
    toLocal:     fmtDate(toMs),
    daysElapsed: daysElapsed,
    totalDays:   totalDays,
    period:      (period || 'mtd').toLowerCase(),
  };
}

/** Return the immediately prior period of the same length (for delta calculations). */
function getPriorRange_(currentRange) {
  const fromMs = new Date(currentRange.fromUTC).getTime();
  const toMs   = new Date(currentRange.toUTC).getTime();
  const span   = toMs - fromMs;
  return {
    fromUTC: new Date(fromMs - span - 1).toISOString(),
    toUTC:   new Date(fromMs - 1).toISOString(),
  };
}

/** Format a local-time date string "YYYY-MM-DD" from ms-since-epoch (UTC). */
function fmtDate_(ms) {
  const dt = new Date(ms);
  return dt.getUTCFullYear() + '-'
    + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-'
    + String(dt.getUTCDate()).padStart(2, '0');
}

// ── Store trend cache (GAS CacheService, 4-hour TTL) ──────────
// Caches the per-store trend30d + trendPct objects so the expensive
// 30-day Dutchie transaction fetch can be skipped on cache hits.
const GC_STORE_TREND_CACHE_KEY = 'gc_store_trends_v1';

function getStoreTrendCache_() {
  try {
    var raw = CacheService.getScriptCache().get(GC_STORE_TREND_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

function saveStoreTrendCache_(byStore30d) {
  try {
    var trends = {};
    STORES.forEach(function(store) {
      trends[store.slug] = trendFromByDay_(aggregateByDay_(byStore30d[store.slug] || []));
    });
    // CacheService max TTL is 21600s (6h); use 4h so trends refresh mid-day
    CacheService.getScriptCache().put(GC_STORE_TREND_CACHE_KEY, JSON.stringify(trends), 14400);
    return trends;
  } catch(e) { return null; }
}

/** Returns a Set of excluded employee nameKeys. */
function getExcluded_() {
  const raw = getProps_().getProperty(GC_EXCLUDED_KEY);
  try { return new Set(raw ? JSON.parse(raw) : []); } catch(e) { return new Set(); }
}

function getRoles_() {
  var raw = getProps_().getProperty(GC_ROLES_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch(e) { return {}; }
}

/**
 * Aggregate live-sales feed for the Sky wall — merges recent transactions
 * across all stores in ONE server-side fetch and caches it ~25 s, so every
 * viewer shares a single Dutchie hit instead of each client polling 6 stores.
 * @return {Object} { ok, sold, ticker:[{slug,who,qty,price,ts}], latestTs }
 */
function getAggTicker_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('gc_aggticker_v1');
  if (hit) { try { return JSON.parse(hit); } catch(e) {} }

  var range    = getDateRange_('today');
  var byStore  = fetchAllStoresTransactions_(range);
  var excluded = getExcluded_();
  var nicks    = getNicknames_();
  var sold = 0, items = [];

  STORES.forEach(function(store) {
    var txns = byStore[store.slug] || [];
    txns.forEach(function(tx) { sold += txNet_(tx); });
    // Newest ~12 sales per store for the feed (skip excluded employees).
    var recent = txns.filter(function(tx) {
      return !excluded.has(nameToKey_(txEmployee_(tx).name));
    }).slice(-12);
    recent.forEach(function(tx) {
      var emp = txEmployee_(tx);
      items.push({
        slug:  store.slug,
        who:   applyNickname_(emp.name, nicks),
        qty:   txItems_(tx),
        price: txTotal_(tx),
        ts:    tx.transactionDateLocalTime || tx.transactionDate || '',
      });
    });
  });

  items.sort(function(a, b) { return (a.ts < b.ts) ? 1 : (a.ts > b.ts) ? -1 : 0; }); // newest first
  items = items.slice(0, 40);

  var out = { ok: true, sold: r2_(sold), ticker: items, latestTs: items.length ? items[0].ts : '' };
  try { cache.put('gc_aggticker_v1', JSON.stringify(out), 25); } catch(e) {}
  return out;
}

/** Returns the current Employee of the Month record { employeeKey, since }, or null if unset. */
function getEomCurrent_() {
  try {
    var raw = getProps_().getProperty(GC_EOM_KEY);
    if (!raw) return null;
    var p = JSON.parse(raw);
    return (p && p.employeeKey) ? p : null;
  } catch(e) { return null; }
}

/** Normalise a Dutchie name into a lookup key (lowercase, no periods/quotes, spaces→underscore). */
function nameToKey_(name) {
  return (name || '').toLowerCase().replace(/["'`]/g, '').replace(/\./g, '').replace(/\s+/g, '_').trim();
}

/**
 * Apply nickname to a raw Dutchie name.
 * - If a nickname is stored → return it exactly as typed (e.g. "Nate", "Zach B.")
 * - If no nickname stored   → return first name only, stripping the last initial
 *   (e.g. "Chris C." → "Chris"). Use Settings to disambiguate duplicates.
 *
 * Fallback: Dutchie sometimes returns only a first name ("Nathan") while the
 * roster (and saved key) has the full "Nathan W." — if the exact key misses,
 * we scan for any stored key whose first segment matches the single-word name.
 */
function applyNickname_(name, nicknames) {
  if (!name) return name;

  const key = nameToKey_(name);

  // 1. Exact key match → return stored nickname verbatim
  if (nicknames && nicknames[key]) return nicknames[key];

  // 2. First-name-only fallback for Dutchie name inconsistency
  const parts = name.trim().split(/\s+/);
  if (nicknames && parts.length === 1) {
    const firstKey = nameToKey_(parts[0]);
    const found = Object.keys(nicknames).find(function(k) {
      return k === firstKey || k.indexOf(firstKey + '_') === 0;
    });
    if (found) return nicknames[found];
  }

  // 3. No nickname — return first name only, stripping any embedded quotes
  return parts[0].replace(/["'`]/g, '');
}

function firstName_(name) {
  return (name || '').split(' ')[0] || name;
}

/**
 * Aggregate today's performance across all stores for the director hero row.
 * Returns the same shape as getStoreToday() so the director can reuse gauge logic.
 *
 * @param {Object} byStoreToday  { storeSlug: [txn, ...] } — pre-fetched today txns
 */
function getDirectorToday(byStoreToday) {
  const { hour: nowHour, minute: nowMinute } = ptHourNow_();
  const elapsedHours = Math.max(0, Math.min(nowHour + nowMinute / 60 - STORE_OPEN_HOUR, STORE_HOURS));
  const dayFrac      = STORE_HOURS > 0 ? elapsedHours / STORE_HOURS : 0;

  const minutesLeft = STORE_CLOSE_HOUR * 60 - (nowHour * 60 + nowMinute);
  const storeClosed = minutesLeft <= 0;
  const _remH  = Math.floor(Math.max(0, minutesLeft) / 60);
  const _remM  = Math.max(0, minutesLeft) % 60;
  const timeRemainingLabel = storeClosed
    ? 'Closed'
    : _remH + ':' + String(_remM).padStart(2, '0');

  // Aggregate revenue + goals across all stores
  let totalRevenue = 0;
  let totalGoal    = 0;
  const combinedHourMap = {};  // hour → { revenue, count }

  STORES.forEach(function(store) {
    const txns     = (byStoreToday || {})[store.slug] || [];
    const agg      = aggregateTransactions_(txns);
    const dailyGoal = getDailyGoal_(store.slug);

    totalRevenue += agg.sales;
    totalGoal    += dailyGoal;

    // Merge hourly buckets
    const hm = aggregateByHour_(txns);
    Object.entries(hm).forEach(([h, v]) => {
      if (!combinedHourMap[h]) combinedHourMap[h] = { revenue: 0, count: 0 };
      combinedHourMap[h].revenue += v.revenue;
      combinedHourMap[h].count   += v.count;
    });
  });

  const pctToGoal  = totalGoal > 0 ? r3_(totalRevenue / totalGoal) : 0;
  const paceGoal   = totalGoal * dayFrac;
  const pace       = paceGoal > 0.5 ? r3_((totalRevenue - paceGoal) / paceGoal) : 0;
  const paceGap    = paceGoal > 0.5 ? r2_(totalRevenue - paceGoal) : 0;  // + ahead, − behind
  const toGo       = Math.max(0, totalGoal - totalRevenue);
  const MIN_PROJ_HOURS = 2;
  const projectedRevenue = storeClosed
    ? totalRevenue
    : elapsedHours >= MIN_PROJ_HOURS
      ? Math.round(totalRevenue / dayFrac)
      : 0;

  // Build hourly array (same shape as getStoreToday hourly)
  const maxRevenue = Math.max(1, ...Object.values(combinedHourMap).map(h => h.revenue));
  const hourly = [];
  for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
    const d   = combinedHourMap[h] || { revenue: 0, count: 0 };
    const lbl = h === 12 ? '12p' : h < 12 ? h + 'a' : (h - 12) + 'p';
    hourly.push({
      hour:      lbl,
      revenue:   Math.round(d.revenue),
      pct:       r1_((d.revenue / maxRevenue) * 100),
      current:   h === nowHour,
      projected: h > nowHour,
    });
  }

  // Sum per-store hourly targets (reads from cache — free after kiosk views have primed it)
  const hourlyTargetMap = {};
  STORES.forEach(function(store) {
    const dailyGoal = getDailyGoal_(store.slug);
    if (dailyGoal <= 0) return;
    try {
      const dist = getHourlyDist_(store);
      if (!dist) return;
      for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
        hourlyTargetMap[h] = (hourlyTargetMap[h] || 0) + Math.round(dailyGoal * (dist[h] || 0));
      }
    } catch(e) {}
  });
  const hasTargets = Object.keys(hourlyTargetMap).length > 0;
  const hourlyTargets = hasTargets
    ? hourly.map(function(_, i) { return hourlyTargetMap[STORE_OPEN_HOUR + i] || 0; })
    : null;

  return {
    revenue:            r2_(totalRevenue),
    goal:               totalGoal,
    pctToGoal:          pctToGoal,
    pace:               pace,
    paceGap:            paceGap,
    toGo:               toGo,
    dayFrac:            r3_(dayFrac),
    projectedRevenue:   projectedRevenue,
    timeRemainingLabel: timeRemainingLabel,
    hourly:             hourly,
    hourlyTargets:      hourlyTargets,
  };
}

function getDirectorSummary(params, pre) {
  pre = pre || {};
  const period = params.period || 'mtd';
  const range  = getDateRange_(period);
  const prior  = getPriorRange_(range);

  // Use pre-fetched data when called from directorall, otherwise fetch independently.
  const currByStore = pre.byStore     || fetchAllStoresTransactions_(range);
  const prevByStore = pre.prevByStore || fetchAllStoresTransactions_(prior);

  const allCurr = Object.values(currByStore).flat();
  const allPrev = Object.values(prevByStore).flat();

  const curr = aggregateTransactions_(allCurr);
  const prev = aggregateTransactions_(allPrev);

  const _excluded     = getExcluded_();
  const allEmps       = Object.values(curr.byEmployee).filter(e => !_excluded.has(nameToKey_(e.name)));
  const flaggedEmps   = allEmps.filter(e => e.discountRate > DISCOUNT_FLAG_THRESHOLD);

  // Sales per hour: total sales ÷ (elapsed days × store open hours)
  const salesPerHour  = range.daysElapsed > 0
    ? Math.round(curr.sales / (range.daysElapsed * STORE_HOURS))
    : 0;
  const prevSPH       = range.daysElapsed > 0
    ? Math.round(prev.sales / (range.daysElapsed * STORE_HOURS))
    : 0;

  return {
    period:    period,
    dateRange: { from: range.fromLocal, to: range.toLocal },
    totalSales:     curr.sales,
    transactions:   curr.transactions,
    avgOrderValue:  curr.avgOrderValue,
    avgUPT:         curr.avgUPT,
    totalDiscounts: curr.totalDiscounts,
    discountRate:   curr.discountRate,
    flaggedStaff:   flaggedEmps.length,
    flaggedStaffBreakdown: { repeat: flaggedEmps.length, new: 0 },
    activeStaff:    allEmps.length,
    storeCount:     STORES.length,
    salesPerHour:   salesPerHour,
    deltas: {
      totalSalesPct:   prev.sales       > 0 ? r3_((curr.sales - prev.sales) / prev.sales) : 0,
      transactions:    curr.transactions - prev.transactions,
      avgOrderValue:   r2_(curr.avgOrderValue  - prev.avgOrderValue),
      avgUPT:          r1_(curr.avgUPT         - prev.avgUPT),
      totalDiscounts:  r2_(curr.totalDiscounts - prev.totalDiscounts),
      discountRatePts: r3_(curr.discountRate   - prev.discountRate),
      salesPerHour:    salesPerHour - prevSPH,
    },
    lastUpdated: new Date().toISOString(),
  };
}

function getDirectorStores(params, pre) {
  pre = pre || {};
  const period   = params.period || 'mtd';
  const range    = getDateRange_(period);
  const todayR   = period === 'today' ? range : getDateRange_('today');
  const plans    = getStorePlans_();

  // Use pre-fetched data when called from directorall, otherwise fetch independently.
  const byStore      = pre.byStore      || fetchAllStoresTransactions_(range);
  const byStoreToday = pre.byStoreToday || (period === 'today' ? byStore : fetchAllStoresTransactions_(todayR));
  const byStore30d   = pre.byStore30d   || null;  // 30-day window for trends (pre-fetched by directorall)
  const storeTrends  = pre.storeTrends  || null;  // pre-computed { slug: {trend30d,trendPct} } from cache

  // Look up user records once for manager info
  const users = JSON.parse(
    PropertiesService.getScriptProperties().getProperty(GC_USERS_KEY) || '{}'
  );

  const storeSummaries = STORES.map(function(store) {
    const txns      = byStore[store.slug]      || [];
    const txnsToday = byStoreToday[store.slug] || [];
    const agg       = aggregateTransactions_(txns);
    const aggToday  = aggregateTransactions_(txnsToday);

    const dailyGoal  = getDailyGoal_(store.slug);
    const periodGoal = getPeriodGoal_(store.slug, period, range);
    const vsplan     = periodGoal > 0 ? r3_((agg.sales - periodGoal) / periodGoal) : 0;

    // Pace for today: (revenue / goal) at current time fraction (PT, DST-aware)
    const { hour: nowLocalHour, minute: nowLocalMinute } = ptHourNow_();
    const elapsed      = Math.max(0, Math.min(nowLocalHour + nowLocalMinute / 60 - STORE_OPEN_HOUR, STORE_HOURS));
    const dayFrac      = elapsed / STORE_HOURS;
    const paceGoal     = dailyGoal * dayFrac;
    const todayPace    = paceGoal > 0.5 ? r3_((aggToday.sales - paceGoal) / paceGoal) : 0;

    // Projected EOD: extrapolate current run rate; requires 2+ hours of data
    const MIN_PROJ_HOURS = 2;
    const projectedRevenue = (elapsed >= MIN_PROJ_HOURS && dayFrac > 0)
      ? Math.round(aggToday.sales / dayFrac) : 0;
    const projectedPace    = (projectedRevenue > 0 && dailyGoal > 0)
      ? r3_((projectedRevenue - dailyGoal) / dailyGoal) : null;

    // Manager from user records
    const mgr = Object.values(users).find(u => u.storeSlug === store.slug && u.role === 'store_manager') || {};

    // Flagged employees
    const flaggedEmps = Object.values(agg.byEmployee).filter(e => e.discountRate > DISCOUNT_FLAG_THRESHOLD);

    // Tags: top / watch / flag (mutually exclusive, escalating severity)
    const tags = [];
    const tagTooltips = [];
    const vsplanPct = Math.abs(Math.round(vsplan * 100));
    if (vsplan >  0.05) { tags.push('top');  tagTooltips.push('+' + vsplanPct + '% over plan MTD'); }
    else if (vsplan < -0.08) { tags.push('flag');  tagTooltips.push(vsplanPct + '% behind plan MTD'); }
    else if (vsplan <  0)    { tags.push('watch'); tagTooltips.push(vsplanPct + '% behind plan MTD'); }

    return {
      slug:          store.slug,
      name:          store.name,
      staffCount:    Object.keys(agg.byEmployee).length,
      manager:       { name: mgr.displayName || '', initials: mgr.initials || '', role: 'store_manager' },
      rank:          0,  // assigned after sort
      sales:         agg.sales,
      goal:          periodGoal,
      vsplan:        vsplan,
      transactions:  agg.transactions,
      avgOrderValue: agg.avgOrderValue,
      avgUPT:        agg.avgUPT,
      discountRate:  agg.discountRate,
      ...(storeTrends && storeTrends[store.slug]
           ? storeTrends[store.slug]
           : trendFromByDay_(byStore30d ? aggregateByDay_(byStore30d[store.slug] || []) : {})),
      tags:          tags,
      tagTooltips:   tagTooltips,
      today:         { revenue: aggToday.sales, goal: dailyGoal, pace: todayPace, pctToGoal: dailyGoal > 0 ? r3_(aggToday.sales / dailyGoal) : 0, projected: projectedRevenue, projectedPace: projectedPace, dayFrac: r3_(dayFrac) },
      flagCount:     flaggedEmps.length,
    };
  });

  // Sort by MTD % of plan descending (goal performance), assign ranks
  storeSummaries.sort((a, b) => (b.vsplan || 0) - (a.vsplan || 0));
  storeSummaries.forEach((s, i) => { s.rank = i + 1; });

  return {
    period:      period,
    dateRange:   { from: range.fromLocal, to: range.toLocal },
    stores:      storeSummaries,
    lastUpdated: new Date().toISOString(),
  };
}

function getDirectorStaff(params, pre) {
  pre = pre || {};
  const period    = params.period || 'mtd';
  const range     = getDateRange_(period);
  // Use pre-fetched data when called from directorall, otherwise fetch independently.
  const byStore   = pre.byStore   || fetchAllStoresTransactions_(range);
  const byStore30d = pre.byStore30d || null;

  // Build per-employee daily revenue buckets from the 30d window (for trend lines).
  const empDailyBuckets = {}; // { empKey: { 'YYYY-MM-DD': revenue } }
  if (byStore30d) {
    STORES.forEach(function(store) {
      (byStore30d[store.slug] || []).forEach(function(tx) {
        const emp = txEmployee_(tx);
        const key = emp.name.toLowerCase().replace(/\s+/g, '_');
        const ts  = tx.transactionDateLocalTime || tx.transactionDate || '';
        const day = ts.slice(0, 10);
        if (!day || day.length < 10) return;
        if (!empDailyBuckets[key]) empDailyBuckets[key] = {};
        empDailyBuckets[key][day] = (empDailyBuckets[key][day] || 0) + txTotal_(tx);
      });
    });
  }

  // Aggregate employees globally across all stores (skip excluded employees)
  const globalEmps = {};
  const _dirExcluded = getExcluded_();

  STORES.forEach(function(store) {
    const agg = aggregateTransactions_(byStore[store.slug] || []);
    Object.values(agg.byEmployee).forEach(function(emp) {
      const key = emp.name.toLowerCase().replace(/\s+/g, '_');
      if (_dirExcluded.has(nameToKey_(emp.name))) return;
      if (!globalEmps[key]) {
        globalEmps[key] = Object.assign({}, emp, {
          storeSlug: store.slug,
          storeName: store.name,
          tags: [],
        });
      } else {
        // Employee processed transactions at multiple stores (rare edge case)
        globalEmps[key].sales        += emp.sales;
        globalEmps[key].transactions += emp.transactions;
        globalEmps[key].items        += emp.items;
        globalEmps[key].discounts    += emp.discounts;
        globalEmps[key].subtotal     += emp.subtotal;
      }
    });
  });

  // Re-derive metrics and apply tags
  const _roles = getRoles_();
  const staffList = Object.values(globalEmps).map(function(emp) {
    const aov    = emp.transactions > 0 ? r2_(emp.sales / emp.transactions) : 0;
    const upt    = emp.transactions > 0 ? r1_(emp.items / emp.transactions)  : 0;
    const disc   = emp.subtotal     > 0 ? r3_(emp.discounts / emp.subtotal)   : 0;
    const empKey = emp.name.toLowerCase().replace(/\s+/g, '_');
    const trend  = trendFromByDay_(empDailyBuckets[empKey] || {}, { useAverage: true });

    const tags = [];
    const staffTagTooltips = [];
    const discPct = Math.round(disc * 1000) / 10;  // e.g. 0.082 → 8.2
    if      (disc > DISCOUNT_WATCH_THRESHOLD) { tags.push('flag');  staffTagTooltips.push(discPct + '% avg discount — above 8% threshold'); }
    else if (disc > DISCOUNT_FLAG_THRESHOLD)  { tags.push('watch'); staffTagTooltips.push(discPct + '% avg discount — above 6.5% threshold'); }

    return {
      initials:      emp.initials,
      name:          emp.name,
      nameKey:       nameToKey_(emp.name),  // canonical key before nickname — matches settings page
      role:          emp.role || '',
      roleLabel:     _roles[nameToKey_(emp.name)] ? ROLE_LABELS[_roles[nameToKey_(emp.name)]] : (emp.roleLabel || ''),
      storeSlug:     emp.storeSlug,
      storeName:     emp.storeName,
      hoursWorked:   0,   // Dutchie doesn't expose schedule hours; integrate separately
      sales:         emp.sales,
      transactions:  emp.transactions,
      avgOrderValue: aov,
      avgUPT:        upt,
      discountRate:  disc,
      trendPct:      trend.trendPct,
      trend30d:      trend.trend30d,
      tags:          tags,
      tagTooltips:   staffTagTooltips,
    };
  });

  // Sort by sales, assign ranks, badge top performers
  staffList.sort((a, b) => b.sales - a.sales);
  const _nicknames = getNicknames_();
  staffList.forEach(function(s, i) {
    s.rank = i + 1;
    s.name = applyNickname_(s.name, _nicknames);
    // nameKey stays as the pre-nickname canonical key for avatar lookup
    if (i < 3 && !s.tags.includes('flag')) s.tags.push('top');
  });

  return {
    period:      period,
    dateRange:   { from: range.fromLocal, to: range.toLocal },
    totalActive: staffList.filter(s => s.transactions > 0).length,
    staff:       staffList,
    lastUpdated: new Date().toISOString(),
  };
}

/** Same as getDirectorStaff but shaped for the /leaderboard view. */
function getLeaderboardStaff(params, pre) {
  const data = getDirectorStaff(params, pre);
  return {
    period:        data.period,
    totalStaff:    data.totalActive,
    showing:       data.staff.length,
    avatarConfigs: getAvatarConfigs_(),
    staff:         data.staff.map(s => ({
      rank:          s.rank,
      initials:      s.initials,
      name:          s.name,
      role:          s.roleLabel || s.role || '',
      hours:         s.hoursWorked || 0,
      storeSlug:     s.storeSlug,
      storeName:     s.storeName,
      sales:         s.sales,
      transactions:  s.transactions,
      avgOrderValue: s.avgOrderValue,
      avgUPT:        s.avgUPT,
      discountRate:  s.discountRate,
      trendPct:      s.trendPct,
      trend30d:      s.trend30d,
      tags:          s.tags,
    })),
  };
}

function getDirectorAlerts(pre) {
  pre = pre || {};
  const range     = getDateRange_('mtd');
  // Use pre-fetched data when called from directorall, otherwise fetch independently.
  const byStore   = pre.byStore || fetchAllStoresTransactions_(range);
  const plans     = getStorePlans_();
  const alerts    = [];
  const discWatch = [];

  STORES.forEach(function(store) {
    const agg          = aggregateTransactions_(byStore[store.slug] || []);
    // DOW-weighted expected revenue for the completed days of the month. (The old
    // formula divided by days-elapsed instead of days-in-month, so every store was
    // always flagged ~−60-95% behind. This compares MTD sales against the realistic
    // to-date bar.)
    const proratedGoal = getProratedMonthGoalToDate_(store.slug);

    // Store behind plan?
    if (proratedGoal > 0) {
      const vsplan = (agg.sales - proratedGoal) / proratedGoal;
      if (vsplan < -0.05) {
        alerts.push({
          id:          'a-store-' + store.slug,
          severity:    vsplan < -0.10 ? 'hi' : 'mid',
          icon:        '📉',
          title:       store.name + ' is ' + Math.round(vsplan * 100) + '% vs. plan MTD',
          description: 'Avg ticket $' + agg.avgOrderValue + ' · Discount rate ' + Math.round(agg.discountRate * 100) + '%.',
          when:        'Updated just now',
          ctaLabel:    'Open store →',
          ctaTarget:   'store:' + store.slug,
        });
      }
    }

    // High-discount employees (min 10 transactions to reduce noise)
    Object.values(agg.byEmployee).forEach(function(emp) {
      if (emp.discountRate > DISCOUNT_FLAG_THRESHOLD && emp.transactions >= 10) {
        discWatch.push({
          employeeId:     emp.id || '',
          name:           emp.name,
          initials:       emp.initials,
          storeSlug:      store.slug,
          storeName:      store.name,
          discountRate:   emp.discountRate,
          ordersOver15Pct: Math.round(emp.transactions * emp.discountRate),
          topReason:      null,  // requires Dutchie discount reason data
          reasonNote:     null,
        });
      }
    });
  });

  // Discount alert when any staff flagged
  if (discWatch.length > 0) {
    const names = discWatch.slice(0, 3).map(w =>
      w.name + ' (' + Math.round(w.discountRate * 100) + '%)'
    ).join(', ');
    alerts.push({
      id:          'a-discount',
      severity:    'hi',
      icon:        '⚠️',
      title:       discWatch.length + ' staff exceeded ' + Math.round(DISCOUNT_FLAG_THRESHOLD * 100) + '% discount threshold',
      description: names + (discWatch.length > 3 ? ' and ' + (discWatch.length - 3) + ' more.' : '.'),
      when:        'Rolling ' + range.daysElapsed + '-day',
      ctaLabel:    'Review →',
      ctaTarget:   'discount-watch',
    });
  }

  // Sort hi → mid → info
  const sevOrder = { hi: 0, mid: 1, info: 2 };
  alerts.sort((a, b) => (sevOrder[a.severity] || 2) - (sevOrder[b.severity] || 2));

  // Chain avg discount
  const allTxns  = Object.values(byStore).flat();
  const chainAgg = aggregateTransactions_(allTxns);

  return {
    alerts:               alerts,
    discountWatch:        discWatch,
    chainAvgDiscountRate: chainAgg.discountRate,
    lastUpdated:          new Date().toISOString(),
  };
}

// ============================================================
// EMPLOYEE STRETCH TARGETS
// ============================================================

/**
 * Returns a map of { nameKey: targetDollars } for every employee at a store.
 *
 * Algorithm:
 *   1. Fetch the last 28 days of transactions (excluding today).
 *   2. Group each transaction by employee × local-date to get daily sales.
 *   3. For each employee, average all days they actually worked (days with $0 are excluded —
 *      absent days shouldn't drag the target down).
 *   4. Multiply the average by 1.025 (+2.5 % stretch).
 *   5. Fall back to Math.round(dailyGoal / 4) for employees with no history.
 *
 * Results are cached in ScriptProperties keyed by store + date so the 28-day
 * fetch only runs ONCE per store per day, not on every 30-second poll.
 *
 * @param {string} storeSlug
 * @param {number} dailyGoal  Store-level daily goal (used for fallback)
 * @return {Object}  { nameKey: targetDollars, ... }
 */
function computeEmpTargets_(storeSlug, dailyGoal) {
  const props    = PropertiesService.getScriptProperties();
  const cacheRaw = props.getProperty(GC_TARGET_CACHE_KEY) || '{}';
  let   cache    = {};
  try { cache = JSON.parse(cacheRaw); } catch (e) { cache = {}; }

  const pt      = ptNow_();
  const today   = pt.dateStr;
  const cacheKey = storeSlug + ':dow:' + today;

  // Return cached result if it was computed today and has at least one entry
  if (cache[cacheKey] && typeof cache[cacheKey] === 'object'
      && Object.keys(cache[cacheKey]).length > 0) {
    return cache[cacheKey];
  }

  // Build a 28-day window ending yesterday (PT).
  // fetchStoreTransactions_ expects ISO 8601 strings, not raw ms.
  const todayStartMs  = ptDateToUtcMs_(today);
  const windowFromISO = new Date(todayStartMs - 28 * 24 * 60 * 60 * 1000).toISOString();
  const windowToISO   = new Date(todayStartMs - 1).toISOString();

  let txns = [];
  try {
    txns = fetchStoreTransactions_(storeSlug, windowFromISO, windowToISO);
  } catch (e) {
    // Fetch failed — return without caching so the next poll retries
    return {};
  }

  // Don't cache an empty result — let the next poll retry the fetch
  if (txns.length === 0) return {};

  // Group: nameKey → { dateStr → dailySales }
  const empDays = {};
  txns.forEach(function(tx) {
    const emp    = txEmployee_(tx);
    const key    = emp.name.toLowerCase().replace(/\s+/g, '_');
    if (!key || key === 'unknown') return;
    const ts     = tx.transactionDateLocalTime || tx.transactionDate || '';
    const day    = ts.slice(0, 10);
    if (!day || day.length < 10) return;
    if (!empDays[key]) empDays[key] = {};
    empDays[key][day] = (empDays[key][day] || 0) + txTotal_(tx);
  });

  // Average daily sales per employee — same day-of-week only, then +2.5 %.
  // Using the same DOW (e.g. only Sundays on a Sunday) means the target
  // reflects actual Sunday traffic, not a blend of busy Fridays and slow Tuesdays.
  // Fall back to all worked days if fewer than 2 same-DOW samples exist.
  const todayDow = pt.dow;   // 0=Sun … 6=Sat
  const fallback = dailyGoal > 0 ? Math.round(dailyGoal / 4) : 0;
  const targets  = {};
  Object.entries(empDays).forEach(function([key, days]) {
    // Same-day-of-week entries
    const sameDowVals = Object.entries(days)
      .filter(([dateStr, v]) => v > 0 && new Date(dateStr + 'T12:00:00').getDay() === todayDow)
      .map(([, v]) => v);

    // Fall back to all worked days if we don't have at least 2 matching samples
    const dayVals = sameDowVals.length >= 2
      ? sameDowVals
      : Object.values(days).filter(v => v > 0);

    if (dayVals.length === 0) { targets[key] = fallback; return; }
    const avg = dayVals.reduce((s, v) => s + v, 0) / dayVals.length;
    targets[key] = Math.round(avg * 1.025);
  });

  // Persist: keep entries for other stores/dates in the cache, add ours
  // Prune stale entries (> 2 days old) to avoid unbounded growth
  const cutoff = fmtDate_(todayStartMs - 2 * 24 * 60 * 60 * 1000);
  Object.keys(cache).forEach(function(k) {
    const datePart = k.split(':')[1] || '';
    if (datePart && datePart < cutoff) delete cache[k];
  });
  cache[cacheKey] = targets;
  props.setProperty(GC_TARGET_CACHE_KEY, JSON.stringify(cache));

  return targets;
}

// ============================================================
// STORE / KIOSK ENDPOINTS
// ============================================================

function getStoreToday(store, params) {
  // Cache full responses for 55 seconds (skip when sinceTs polling — those need live data)
  const isSincePoll = params && params.sinceTs;
  if (!isSincePoll) {
    const scriptCache = CacheService.getScriptCache();
    const cacheKey    = 'storeToday:' + store.slug;
    const hit         = scriptCache.get(cacheKey);
    if (hit) {
      try { return JSON.parse(hit); } catch(e) {}
    }
  }

  const { hour: nowHour, minute: nowMinute } = ptHourNow_();

  // Pre-open: before 8 am show previous day's final stats so openers can
  // see what the closing shift accomplished without fetching empty today data.
  const isPreOpen = nowHour < STORE_OPEN_HOUR;

  const todayR = getDateRange_('today');

  // Yesterday's UTC window (DST-correct)
  const todayStartMs = ptDateToUtcMs_(ptNow_().dateStr);
  const ydayMs       = todayStartMs - 24 * 60 * 60 * 1000;
  const ydayRange    = {
    fromUTC: new Date(ydayMs).toISOString(),
    toUTC:   new Date(todayStartMs - 1).toISOString(),
  };

  const fetchRange = isPreOpen ? ydayRange : todayR;
  const txns   = fetchStoreTransactions_(store.slug, fetchRange.fromUTC, fetchRange.toUTC);
  const agg    = aggregateTransactions_(txns);
  const hourMap = aggregateByHour_(txns);

  // First-name frequency map so ticker can show "Zachary B." vs "Zachary R."
  // Use the full employee roster (all known staff at this store) so that
  // an off-shift Zachary still triggers disambiguation for the on-shift one.
  // Apply nicknames first so we disambiguate on display names, not raw Dutchie names.
  const _tickerNicks = getNicknames_();
  const tickerFirstNames = {};
  const fullRoster = (getEmployeeRoster_()[store.slug] || []);
  const rosterSource = fullRoster.length > 0 ? fullRoster : Object.values(agg.byEmployee);
  rosterSource.forEach(emp => {
    const displayName = applyNickname_(emp.name, _tickerNicks);
    const fn = (displayName || '').split(' ')[0].toLowerCase();
    tickerFirstNames[fn] = (tickerFirstNames[fn] || 0) + 1;
  });
  function disambiguateTicker_(name) {
    const parts = (name || '').trim().split(/\s+/);
    const fn    = (parts[0] || '').toLowerCase();
    if ((tickerFirstNames[fn] || 0) > 1 && parts.length > 1) {
      return parts[0] + ' ' + parts[parts.length - 1][0].toUpperCase() + '.';
    }
    return parts[0] || name;
  }

  // Goal: use yesterday's DOW when pre-open so % reflects how yesterday did
  // vs yesterday's target. Pre-open DOW: (today.dow + 6) % 7 (e.g. Mon→Sun).
  const todayDow    = ptNow_().dow;
  const yesterdayDow = (todayDow + 6) % 7;
  const dailyGoal = isPreOpen
    ? getDailyGoalForDow_(store.slug, yesterdayDow)
    : getDailyGoal_(store.slug);

  // Pace & projection
  const elapsedHours = Math.max(0, Math.min(nowHour + nowMinute / 60 - STORE_OPEN_HOUR, STORE_HOURS));
  const dayFrac      = STORE_HOURS > 0 ? elapsedHours / STORE_HOURS : 0;
  const paceGoal     = dailyGoal * dayFrac;
  // Pre-open: pace = how far above/below yesterday's goal the final result was
  const pace = isPreOpen
    ? (dailyGoal > 0 ? r3_((agg.sales - dailyGoal) / dailyGoal) : 0)
    : (paceGoal > 0.5 ? r3_((agg.sales - paceGoal) / paceGoal) : 0);
  const pctToGoal = dailyGoal > 0 ? r3_(agg.sales / dailyGoal) : 0;

  // Time remaining label
  const minutesLeft = STORE_CLOSE_HOUR * 60 - (nowHour * 60 + nowMinute);
  const storeClosed = !isPreOpen && minutesLeft <= 0;
  const _remH   = Math.floor(Math.max(0, minutesLeft) / 60);
  const _remM   = Math.max(0, minutesLeft) % 60;
  const _remFmt = _remH + ':' + String(_remM).padStart(2, '0');
  const timeRemainingLabel = isPreOpen  ? 'Pre-open'
    : storeClosed                       ? 'Closed'
    : _remFmt;

  // Project EOD revenue
  const MIN_PROJ_HOURS = 2;
  const projectedRevenue = (isPreOpen || storeClosed)
    ? agg.sales
    : elapsedHours >= MIN_PROJ_HOURS
      ? Math.round(agg.sales / dayFrac)
      : 0;

  // Hourly bar chart — when pre-open, all bars are "final" (no current/projected)
  const maxRevenue = Math.max(1, ...Object.values(hourMap).map(h => h.revenue));
  const hourly = [];
  for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
    const d   = hourMap[h] || { revenue: 0, count: 0 };
    const lbl = h === 12 ? '12p' : h < 12 ? h + 'a' : (h - 12) + 'p';
    hourly.push({
      hour:      lbl,
      revenue:   Math.round(d.revenue),
      pct:       r1_((d.revenue / maxRevenue) * 100),
      current:   !isPreOpen && h === nowHour,
      projected: !isPreOpen && h > nowHour,
    });
  }

  // Per-hour targets: scale daily goal by same-DOW historical hourly weights.
  // Falls back to flat (dailyGoal / numHours) if no historical data available.
  let hourlyTargets = null;
  try {
    const dist = getHourlyDist_(store);
    if (dist) {
      hourlyTargets = [];
      for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
        hourlyTargets.push(Math.round(dailyGoal * (dist[h] || 0)));
      }
    }
  } catch(e) {
    Logger.log('hourlyTargets error: ' + e);
  }

  // Build shift strip: active employees (have transactions today) + known
  // roster employees who haven't transacted yet (shown as off-shift).
  const _excluded   = getExcluded_();
  const _shiftNicks = getNicknames_();
  const activeEmps = Object.values(agg.byEmployee)
    .filter(emp => !_excluded.has(nameToKey_(emp.name)))
    .sort((a, b) => b.sales - a.sales)
    .map(emp => ({
      initials: emp.initials,
      name:     applyNickname_(emp.name, _shiftNicks),  // apply nickname for consistent display
      nameKey:  nameToKey_(emp.name),  // pre-nickname canonical key — frontend uses this for initials + avatar lookup
      status:   'on',
      sales:    emp.sales,
      note:     null,
    }));

  const activeIds = new Set(
    Object.values(agg.byEmployee).map(e => String(e.id)).filter(Boolean)
  );
  const activeNames = new Set(
    Object.values(agg.byEmployee).map(e => e.name.toLowerCase())
  );

  // Pull in roster employees not yet seen today (apply nicknames so display is consistent)
  const rosterEmps = (getEmployeeRoster_()[store.slug] || [])
    .filter(e => !activeIds.has(String(e.id)) && !activeNames.has(e.name.toLowerCase()) && !_excluded.has(nameToKey_(e.name)))
    .map(e => ({
      initials: e.initials,
      name:     applyNickname_(e.name, _shiftNicks),
      nameKey:  nameToKey_(e.name),  // pre-nickname canonical key
      status:   'off',
      sales:    0,
      note:     null,
    }));

  const onShift = activeEmps.concat(rosterEmps);

  // Helper: build a ticker item from a transaction
  function makeTicker_(tx) {
    const emp = txEmployee_(tx);
    const displayName = applyNickname_(emp.name, _tickerNicks);
    return {
      who:   disambiguateTicker_(displayName),
      qty:   txItems_(tx),   // distinct SKUs — see txItems_ for cannabis UPT rationale
      price: txTotal_(tx),
      ts:    tx.transactionDateLocalTime || tx.transactionDate || '',
    };
  }

  // Latest transaction timestamp — used as cursor for incremental polls
  const latestTxnTs = txns.length > 0
    ? (txns[txns.length - 1].transactionDateLocalTime || txns[txns.length - 1].transactionDate || '')
    : '';

  // sinceTs: lightweight delta response (only new transactions + updated totals)
  const sinceTs = params && params.sinceTs;
  if (sinceTs) {
    // Pre-open: no new transactions arriving — return updated labels/goal only
    const newTxns = isPreOpen ? [] : txns
      .filter(tx => (tx.transactionDateLocalTime || tx.transactionDate || '') > sinceTs)
      .filter(tx => !_excluded.has(nameToKey_(txEmployee_(tx).name)))
      .reverse();   // newest first for ticker display
    return {
      isUpdate:          true,
      isPreOpen:         isPreOpen,
      revenue:           agg.sales,
      transactions:      agg.transactions,
      avgOrderValue:     agg.avgOrderValue,
      avgUPT:            agg.avgUPT,
      totalDiscounts:    agg.totalDiscounts,
      discountRate:      agg.discountRate,
      pctToGoal:         pctToGoal,
      pace:              pace,
      projectedRevenue:  projectedRevenue,
      goal:              dailyGoal,
      toGo:              (storeClosed || isPreOpen) ? Math.max(0, dailyGoal - agg.sales) : Math.max(0, dailyGoal - agg.sales),
      timeRemainingLabel: timeRemainingLabel,
      latestTxnTs:       latestTxnTs,
      newTicker:         newTxns.map(makeTicker_),
      hourly:            hourly,
    };
  }

  // Full response: ticker seed = last 10 transactions newest-first (exclude excluded employees)
  const recentTxns = txns.slice().reverse()
    .filter(tx => !_excluded.has(nameToKey_(txEmployee_(tx).name)))
    .slice(0, 10);
  const ticker = recentTxns.map(makeTicker_);

  const result = {
    storeSlug:          store.slug,
    storeName:          store.name,
    goal:               dailyGoal,
    revenue:            agg.sales,
    pctToGoal:          pctToGoal,
    pace:               pace,
    projectedRevenue:   projectedRevenue,
    toGo:               Math.max(0, dailyGoal - agg.sales),
    timeRemainingLabel: timeRemainingLabel,
    isPreOpen:          isPreOpen,
    dayFrac:            r3_(dayFrac),
    transactions:       agg.transactions,
    avgOrderValue:      agg.avgOrderValue,
    avgUPT:             agg.avgUPT,
    totalDiscounts:     agg.totalDiscounts,
    discountRate:       agg.discountRate,
    onShift:            onShift,
    hourly:             hourly,
    hourlyTargets:      hourlyTargets,
    ticker:             ticker,
    latestTxnTs:        latestTxnTs,
    lastUpdated:        new Date().toISOString(),
  };

  // Store in GAS cache for 55 seconds (full loads only — sinceTs polls bypass this)
  if (!isSincePoll) {
    try {
      const scriptCache = CacheService.getScriptCache();
      scriptCache.put('storeToday:' + store.slug, JSON.stringify(result), STORE_TODAY_TTL_S);
    } catch(e) {}
  }

  return result;
}

function getStoreLeaderboard(store, params) {
  // Cache full responses for 55 seconds so morning warmup + repeated kiosk loads
  // don't each pay the full Dutchie fetch cost.
  const scriptCache = CacheService.getScriptCache();
  const lbCacheKey  = 'storeLB:' + store.slug;
  const lbHit       = scriptCache.get(lbCacheKey);
  if (lbHit) {
    try { return JSON.parse(lbHit); } catch(e) {}
  }

  const { hour: nowHour } = ptHourNow_();
  const isPreOpen = nowHour < STORE_OPEN_HOUR;

  // Pre-open: show yesterday's leaderboard so openers can see closing staff results
  const todayR = getDateRange_('today');
  const todayStartMs = ptDateToUtcMs_(ptNow_().dateStr);
  const ydayRange = {
    fromUTC: new Date(todayStartMs - 24 * 60 * 60 * 1000).toISOString(),
    toUTC:   new Date(todayStartMs - 1).toISOString(),
  };
  const fetchRange = isPreOpen ? ydayRange : todayR;

  const txns = fetchStoreTransactions_(store.slug, fetchRange.fromUTC, fetchRange.toUTC);
  const agg  = aggregateTransactions_(txns);
  const today = todayR.toLocal;   // always use real today for streak date tracking

  // Load streaks — only write updates when showing real today data
  const props     = PropertiesService.getScriptProperties();
  const streaks   = JSON.parse(props.getProperty(GC_STREAKS_KEY) || '{}');
  const yesterday = fmtDate_(new Date(todayStartMs - 24 * 60 * 60 * 1000));

  const empList = Object.values(agg.byEmployee)
    .sort((a, b) => b.sales - a.sales);

  // Keys for employees who transacted today — used to detect absent employees below
  const activeKeys = new Set();

  empList.forEach(function(emp) {
    const key = store.slug + ':' + emp.name.toLowerCase().replace(/\s+/g, '_');
    activeKeys.add(key);
    const s = streaks[key] || { days: 0, lastDate: '' };

    if (s.lastDate === yesterday) {
      // Consecutive day — extend streak
      s.days     = (s.days || 0) + 1;
      s.lastDate = today;
    } else if (s.lastDate !== today) {
      // Gap in attendance — reset to 1 (today counts as day 1)
      s.days     = 1;
      s.lastDate = today;
    }
    streaks[key] = s;
    emp._streak  = s.days;
  });

  // Break streaks for roster members who had no transactions today.
  // Without this pass an absent employee's streak would persist indefinitely.
  (getEmployeeRoster_()[store.slug] || []).forEach(function(p) {
    const key = store.slug + ':' + (p.name || '').toLowerCase().replace(/\s+/g, '_');
    if (activeKeys.has(key)) return;          // already updated above
    const s = streaks[key];
    if (!s) return;                           // no history yet, nothing to break
    // If their last sale was before yesterday, their streak is broken
    if (s.lastDate && s.lastDate < yesterday) {
      s.days     = 0;
      s.lastDate = '';                        // cleared so next active day starts at 1
      streaks[key] = s;
    }
  });

  // Only persist streak updates when showing live today data
  if (!isPreOpen) props.setProperty(GC_STREAKS_KEY, JSON.stringify(streaks));

  // Compute "leading since" — walk txns chronologically, find when the
  // current day-leader last took the #1 spot and hasn't lost it since.
  const leaderName    = empList.length > 0 ? empList[0].name : '';
  const leaderKey     = leaderName.toLowerCase().replace(/\s+/g, '_');
  const runningTotals = {};
  let   currentLeader = null;
  let   leadingSinceTs = '';

  txns.forEach(function(tx) {
    const emp    = txEmployee_(tx);
    const empKey = emp.name.toLowerCase().replace(/\s+/g, '_');
    if (!empKey || emp.name === 'Unknown') return;
    runningTotals[empKey] = (runningTotals[empKey] || 0) + txTotal_(tx);

    // Who's leading right now?
    let topKey = null, topAmt = 0;
    Object.entries(runningTotals).forEach(([k, v]) => {
      if (v > topAmt) { topAmt = v; topKey = k; }
    });

    if (topKey && topKey !== currentLeader) {
      currentLeader = topKey;
      if (topKey === leaderKey) {
        leadingSinceTs = tx.transactionDateLocalTime || tx.transactionDate || '';
      }
    }
  });

  // Format "2026-05-22T13:34:05.000" → "1:34 PM"
  function fmtLeadingSince_(tsStr) {
    if (!tsStr || tsStr.length < 16) return '';
    const h = parseInt(tsStr.substring(11, 13), 10);
    const m = parseInt(tsStr.substring(14, 16), 10);
    if (isNaN(h) || isNaN(m)) return '';
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12  = h % 12 || 12;
    return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
  }

  const leaderLeadingSince = fmtLeadingSince_(leadingSinceTs);

  // Personal stretch targets — computed from 28-day history, cached per day
  const dailyGoal   = getDailyGoal_(store.slug);
  const empTargets  = computeEmpTargets_(store.slug, dailyGoal);
  const fallbackTgt = dailyGoal > 0 ? Math.round(dailyGoal / 4) : 0;

  const _storeNicknames = getNicknames_();
  const staff = empList.map((emp, i) => {
    const nameKey = nameToKey_(emp.name);  // canonical key before nickname — matches settings page
    const target  = empTargets[emp.name.toLowerCase().replace(/\s+/g, '_')] || fallbackTgt;
    return {
      rank:          i + 1,
      initials:      emp.initials,
      name:          applyNickname_(emp.name, _storeNicknames),
      nameKey:       nameKey,   // pre-nickname key for avatar config lookup
      sales:         emp.sales,
      transactions:  emp.transactions,
      avgOrderValue: emp.avgOrderValue,
      avgUPT:        emp.avgUPT || 0,
      discountRate:  emp.discountRate,
      streakDays:    emp._streak != null ? emp._streak : 1,
      leadingSince:  i === 0 ? leaderLeadingSince : '',
      target:        target,
      note:          null,
    };
  });

  // Build onShift roster: employees active today (on) + roster-only employees (off)
  // Mirrors the same logic in getStoreToday so _onShift stays fresh on lb refresh.
  const _excluded    = getExcluded_();
  const activeNames  = new Set(empList.map(e => e.name.toLowerCase()));
  const onShiftActive = empList.map(emp => ({
    initials: emp.initials,
    name:     applyNickname_(emp.name, _storeNicknames),
    nameKey:  nameToKey_(emp.name),   // pre-nickname key for avatar config lookup
    status:   'on',
    sales:    emp.sales,
    note:     null,
  }));
  const onShiftRoster = (getEmployeeRoster_()[store.slug] || [])
    .filter(e => !activeNames.has(e.name.toLowerCase()) && !_excluded.has(nameToKey_(e.name)))
    .map(e => ({
      initials: e.initials,
      name:     applyNickname_(e.name, _storeNicknames),
      nameKey:  nameToKey_(e.name),   // pre-nickname key for avatar config lookup
      status:   'off',
      sales:    0,
      note:     null,
    }));
  const onShift = onShiftActive.concat(onShiftRoster);

  const result = {
    storeSlug:    store.slug,
    storeName:    store.name,
    date:         today,
    staff:        staff,
    onShift:      onShift,
    lastUpdated:  new Date().toISOString(),
    avatarConfigs: getAvatarConfigs_(),
  };

  // Store in GAS cache for 55 seconds (same window as storetoday)
  try { scriptCache.put(lbCacheKey, JSON.stringify(result), STORE_TODAY_TTL_S); } catch(e) {}

  return result;
}

function getStoreBadges(store, params) {
  const period = (params && params.period) || 'week';
  const range  = getDateRange_(period === 'week' ? 'wtd' : period);
  const txns   = fetchStoreTransactions_(store.slug, range.fromUTC, range.toUTC);
  const agg    = aggregateTransactions_(txns);

  // Need at least 3 transactions per employee to be badge-eligible
  const emps = Object.values(agg.byEmployee).filter(e => e.transactions >= 3);

  if (emps.length === 0) {
    return {
      storeSlug: store.slug, storeName: store.name,
      period:    period,     badges:    [],
      lastUpdated: new Date().toISOString(),
    };
  }

  const badges = [];

  const best = (arr, fn) => arr.reduce((b, e) => fn(e) > fn(b) ? e : b, arr[0]);
  const worst = (arr, fn) => arr.reduce((b, e) => fn(e) < fn(b) ? e : b, arr[0]);

  // 💰 AOV Avenger — highest average order value
  const aovKing = best(emps, e => e.avgOrderValue);
  badges.push({
    id: 'aov-avenger', icon: '💰', label: 'AOV Avenger', type: 'gold',
    winner: aovKing.name,   // full name — frontend matches by name, not first name
    detail: '$' + aovKing.avgOrderValue + ' avg ticket',
  });

  // 👑 Upsell King — highest avg items per ticket
  const uptKing = best(emps, e => e.avgUPT);
  badges.push({
    id: 'upsell-king', icon: '👑', label: 'Upsell King', type: 'gold',
    winner: uptKing.name,
    detail: uptKing.avgUPT + ' items/ticket',
  });

  // 🧼 Cleanest Receipts — lowest discount rate (min 10 txns)
  const cleanEmps = emps.filter(e => e.transactions >= 10);
  if (cleanEmps.length > 0) {
    const cleanest = worst(cleanEmps, e => e.discountRate);
    badges.push({
      id: 'cleanest', icon: '🧼', label: 'Cleanest Receipts', type: 'silver',
      winner: cleanest.name,
      detail: Math.round(cleanest.discountRate * 100) + '% discount rate',
    });
  }

  // 🔥 Top Sales — most total revenue
  const topSales = best(emps, e => e.sales);
  badges.push({
    id: 'top-sales', icon: '🔥', label: 'Top Sales', type: 'gold',
    winner: topSales.name,
    detail: '$' + Math.round(topSales.sales).toLocaleString() + ' this week',
  });

  // 🤝 The Closer — most transactions
  const closer = best(emps, e => e.transactions);
  badges.push({
    id: 'the-closer', icon: '🤝', label: 'The Closer', type: 'silver',
    winner: closer.name,
    detail: closer.transactions + ' tickets',
  });

  // 🎯 Transaction King — most individual items sold across all transactions
  //    (distinct from The Closer = ticket count, and Upsell King = avg UPT)
  const volumeKing = best(emps, e => e.items);
  badges.push({
    id: 'txn-king', icon: '🎯', label: 'Transaction King', type: 'silver',
    winner: volumeKing.name,
    detail: volumeKing.items + ' items sold',
  });

  // Apply nicknames to all badge winners
  const _badgeNicks = getNicknames_();
  badges.forEach(function(b) {
    if (b.winner) b.winner = applyNickname_(b.winner, _badgeNicks);
  });

  return {
    storeSlug:   store.slug,
    storeName:   store.name,
    period:      period,
    badges:      badges,
    lastUpdated: new Date().toISOString(),
  };
}

// ============================================================
// PLAN MANAGEMENT
// ============================================================

/**
 * HTTP endpoint: set a daily/monthly goal for one store.
 * POST params: store (slug), daily (number), monthly (number)
 * Example: ?action=setplan&token=...&store=baseline&daily=8500&monthly=255000
 */
function setStorePlan(params) {
  if (!params.store) return { ok: false, error: 'store param required' };
  const store = STORES.find(s => s.slug === params.store);
  if (!store) return { ok: false, error: 'Unknown store: ' + params.store };

  const plans = getStorePlans_();
  plans[params.store] = plans[params.store] || {};

  if (params.daily)   plans[params.store].daily   = Number(params.daily);
  if (params.monthly) plans[params.store].monthly = Number(params.monthly);

  PropertiesService.getScriptProperties().setProperty(GC_STORE_PLANS_KEY, JSON.stringify(plans));
  Logger.log('Plan updated: ' + params.store + ' → ' + JSON.stringify(plans[params.store]));
  return { ok: true, store: params.store, plan: plans[params.store] };
}

// ============================================================
// AVATAR CONFIG
// ============================================================

/**
 * Resolves avatarConfigs against a roster employee list.
 * Dutchie transaction data often uses a single display name (e.g. "Sunshine") while the
 * roster stores the full legal name (e.g. "Maria Sunshine" → key "maria_sunshine").
 * Tries the full roster key first, then each individual segment, so "sunshine" config
 * is found regardless of which position it occupies in the roster key.
 * Returns a new map keyed by roster emp.key so callers can do a direct lookup.
 */
function resolveAvatarConfigs_(employees, rawConfigs) {
  var resolved = {};
  (employees || []).forEach(function(emp) {
    var key = emp.key;
    // 1. Exact match
    var cfg = rawConfigs[key] || null;
    // 2. Try each name segment (handles first-name-only keys saved from kiosk)
    if (!cfg) {
      var segments = key.split('_');
      for (var i = 0; i < segments.length; i++) {
        if (rawConfigs[segments[i]]) { cfg = rawConfigs[segments[i]]; break; }
      }
    }
    if (cfg) resolved[key] = cfg;
  });
  return resolved;
}

/** Returns the full avatar config map { nameKey: configObject }. */
function getAvatarConfigs_() {
  var raw = PropertiesService.getScriptProperties().getProperty(GC_AVATAR_CONFIGS_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch(e) { return {}; }
}

/**
 * Save one employee's avatar config.
 * Expects params.nameKey (string) and params.config (JSON string of avatar config object).
 */
function saveAvatarConfig_(params) {
  if (!params.nameKey) return { ok: false, error: 'nameKey required' };
  var configStr = params.config;
  if (!configStr) return { ok: false, error: 'config required' };
  var config;
  try { config = JSON.parse(configStr); } catch(e) {
    return { ok: false, error: 'Invalid config JSON: ' + e.message };
  }
  var configs = getAvatarConfigs_();
  configs[params.nameKey] = config;
  PropertiesService.getScriptProperties().setProperty(GC_AVATAR_CONFIGS_KEY, JSON.stringify(configs));
  Logger.log('[avatar] saved config for ' + params.nameKey);
  return { ok: true, nameKey: params.nameKey };
}

/**
 * Remove one employee's avatar config so they revert to showing initials.
 * Deletes every key that matches any segment of params.nameKey (handles the
 * first-name-only key mismatch between kiosk and roster).
 */
function clearAvatarConfig_(params) {
  if (!params.nameKey) return { ok: false, error: 'nameKey required' };
  var configs = getAvatarConfigs_();
  var segments = params.nameKey.split('_');
  // Delete exact key and any single-segment variant (e.g. "sunshine" from "maria_sunshine")
  var deleted = [];
  [params.nameKey].concat(segments).forEach(function(k) {
    if (configs[k]) { delete configs[k]; deleted.push(k); }
  });
  PropertiesService.getScriptProperties().setProperty(GC_AVATAR_CONFIGS_KEY, JSON.stringify(configs));
  Logger.log('[avatar] cleared config for ' + params.nameKey + ' (keys removed: ' + deleted.join(', ') + ')');
  return { ok: true, nameKey: params.nameKey, deleted: deleted };
}
