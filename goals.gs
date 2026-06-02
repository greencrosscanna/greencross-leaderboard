// ============================================================
//  Green Cross — Goals & Targets  (goals.gs)
//  Pay-period goal calculation, YoY comparisons, daily/DOW
//  targets, and the daily trigger that refreshes them.
// ============================================================

/**
 * Returns all store plans.
 * Stored in ScriptProperties as GC_STORE_PLANS_KEY:
 *   { "baseline": { "monthly": 255000, "daily": 8500 }, ... }
 */
function getStorePlans_() {
  const raw = getProps_().getProperty(GC_STORE_PLANS_KEY);
  return JSON.parse(raw || '{}');
}

/** Returns the nickname map { nameKey: displayName }, with keys normalised (no periods). */
function getNicknames_() {
  const raw = getProps_().getProperty(GC_NICKNAMES_KEY);
  try {
    const stored = raw ? JSON.parse(raw) : {};
    // Normalise stored keys: strip periods so "zachary_b." and "zachary_b" both work
    const out = {};
    Object.keys(stored).forEach(function(k) {
      const clean = k.replace(/\./g, '').trim();
      if (stored[k] && clean) out[clean] = stored[k];
    });
    return out;
  } catch(e) { return {}; }
}

/**
 * Returns which goal set is active for a store: whichever of rolling vs. YoY
 * produces the higher PP goal. Never lowers the bar.
 * @param {Object} gr  Rolling goals object for the store
 * @param {Object} gy  YoY goals object for the store
 * @returns {'rolling'|'yoy'}
 */
function activeGoalSource_(gr, gy) {
  var rPP = (gr && gr.ppGoal) ? gr.ppGoal : 0;
  var yPP = (gy && gy.ppGoal) ? gy.ppGoal : 0;
  return (yPP > rPP) ? 'yoy' : 'rolling';
}

/**
 * Returns the manual PP goal overrides map: { slug: finalPPGoal (number) }.
 * When a store has an entry here it overrides max(rolling, yoy) entirely.
 * Stretch is NOT applied on top — the stored value IS the goal.
 */
function getManualPPGoals_() {
  var raw = getProps_().getProperty(GC_MANUAL_PP_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch(e) { return {}; }
}

/**
 * Lazy-compute store-level revenue goals for the current pay period.
 *
 * Fetches the last 12 completed pay periods (= 168 days = 24 occurrences of each
 * day of week) in parallel via fetchAllStoresTransactionsMulti_, then computes:
 *   ppGoal  — average of 12 PP revenue totals
 *   dowAvg  — { 0..6: avg daily revenue } where 0=Sun,1=Mon,...,6=Sat (matches ptNow_().dow)
 *   monthly — exact sum of DOW averages × actual weekday count for current month
 *
 * Results are cached in ScriptProperties keyed by PP start date and are valid
 * for the entire 14-day pay period. _goalsCache_ provides request-scope memoization
 * so repeated calls within one HTTP request don't re-read ScriptProperties.
 *
 * @param  {boolean} forceRecompute  True → ignore cache and recompute from Dutchie
 * @return {Object}  { storeSlug: { ppGoal, dowAvg, monthly, ppStart, ppEnd, computedAt } }
 */
function getOrComputeGoals_(forceRecompute) {
  // Request-scope memo
  if (!forceRecompute && _goalsCache_) return _goalsCache_;

  const props = getProps_();

  // Determine current PP start
  const { ppStartMs, PP_MS } = currentPPStart_(props);
  const ppStartStr   = Utilities.formatDate(new Date(ppStartMs), STORE_TZ, 'yyyy-MM-dd');
  const ppEndStr     = Utilities.formatDate(new Date(ppStartMs + PP_MS - 1), STORE_TZ, 'yyyy-MM-dd');

  // Check ScriptProperties cache
  if (!forceRecompute) {
    let cached = {};
    try { cached = JSON.parse(props.getProperty(GC_GOALS_CACHE_KEY) || '{}'); } catch(e) {}
    if (cached.ppStart === ppStartStr && cached.goals) {
      _goalsCache_ = cached.goals;
      return _goalsCache_;
    }
  }

  Logger.log('[goals] Computing goals for PP ' + ppStartStr + '…');

  // Build 12 prior completed PP date ranges
  const ranges = [];
  for (var i = 12; i >= 1; i--) {
    var fromMs = ppStartMs - i * PP_MS;
    var toMs   = fromMs + PP_MS - 1;
    ranges.push({ fromUTC: new Date(fromMs).toISOString(), toUTC: new Date(toMs).toISOString() });
  }
  // Report range: oldest PP start → newest completed PP end
  var reportFromStr = Utilities.formatDate(new Date(ppStartMs - 12 * PP_MS), STORE_TZ, 'yyyy-MM-dd');
  var reportToStr   = Utilities.formatDate(new Date(ppStartMs - 1), STORE_TZ, 'yyyy-MM-dd');

  // 72 parallel requests (12 PP ranges × 6 stores)
  Logger.log('[goals] Firing ' + (ranges.length * STORES.length) + ' parallel requests…');
  var fetched = fetchAllStoresTransactionsMulti_(ranges);

  var goals = {};
  STORES.forEach(function(store) {
    // Merge all 12 PP ranges into one daily revenue map and track per-PP totals
    var allByDay = {};
    var ppTotals = [];

    fetched.forEach(function(byStore) {
      var txns   = byStore[store.slug] || [];
      var ppDay  = aggregateByDay_(txns);
      var ppSum  = 0;
      Object.keys(ppDay).forEach(function(day) {
        allByDay[day] = (allByDay[day] || 0) + ppDay[day];
        ppSum += ppDay[day];
      });
      ppTotals.push(ppSum);
    });

    // PP goal: average of the 12 completed PP totals
    var ppGoal = ppTotals.length > 0
      ? Math.round(ppTotals.reduce(function(a, b) { return a + b; }, 0) / ppTotals.length)
      : 0;

    // DOW averages — use Utilities.formatDate with STORE_TZ for DST-correct weekday
    // Convention: 'u' format gives 1=Mon…7=Sun; % 7 → Mon=1,…,Sat=6,Sun=0 (matches ptNow_().dow)
    var dowBuckets = {0:[],1:[],2:[],3:[],4:[],5:[],6:[]};
    Object.keys(allByDay).forEach(function(day) {
      var d   = new Date(Date.UTC(Number(day.slice(0,4)), Number(day.slice(5,7))-1, Number(day.slice(8,10)), 12));
      var dow = parseInt(Utilities.formatDate(d, STORE_TZ, 'u'), 10) % 7;  // Mon=1…Sun=0
      dowBuckets[dow].push(allByDay[day]);
    });

    var flatDaily = ppGoal > 0 ? Math.round(ppGoal / PP_DAYS) : 0;
    var dowAvg = {};
    for (var d = 0; d <= 6; d++) {
      var vals = dowBuckets[d];
      dowAvg[d] = vals.length > 0
        ? Math.round(vals.reduce(function(a, b) { return a + b; }, 0) / vals.length)
        : flatDaily;
    }

    // Monthly = exact weekday count for the current calendar month × DOW averages.
    // Cached at compute time; getMonthlyGoal_() recomputes live so it stays accurate
    // as the month changes without requiring a full Recalculate.
    var pt      = ptNow_();
    var monthly = computeAccurateMonthly_(dowAvg, pt.year, pt.month);

    goals[store.slug] = {
      ppGoal:     ppGoal,
      dowAvg:     dowAvg,
      monthly:    monthly,
      ppStart:    ppStartStr,
      ppEnd:      ppEndStr,
      computedAt: new Date().toISOString(),
    };

    Logger.log('[goals] ' + store.slug
      + ' pp=$' + ppGoal
      + ' mon=$' + dowAvg[1] + ' fri=$' + dowAvg[5] + ' sat=$' + dowAvg[6]
      + ' mo=$' + monthly);
  });

  // Persist to ScriptProperties
  props.setProperty(GC_GOALS_CACHE_KEY, JSON.stringify({
    ppStart:     ppStartStr,
    computedAt:  new Date().toISOString(),
    reportFrom:  reportFromStr,
    reportTo:    reportToStr,
    goals:       goals,
  }));
  _goalsCache_ = goals;
  return goals;
}

/** Force-recompute goals from Dutchie. Called via ?action=recalculategoals or nightly trigger. */
function recalculateGoals_() {
  try {
    var goals = getOrComputeGoals_(true);
    return { ok: true, stores: Object.keys(goals).length };
  } catch(e) {
    Logger.log('recalculateGoals_ error: ' + e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Lazy-compute YoY store-level revenue goals.
 *
 * Fetches a 6-PP window (±3 PPs) centered on the equivalent week from 52 weeks
 * ago (364 days = exactly 52 weeks, preserves day-of-week alignment).
 * 36 parallel requests (6 ranges × 6 stores). Cached per PP start date.
 *
 * The stretch multiplier applied on top represents the YoY growth target —
 * e.g. 2.5% stretch = "we want to grow 2.5% over last year this period."
 *
 * @param  {boolean} forceRecompute  True → ignore cache and recompute
 * @return {Object}  { storeSlug: { ppGoal, dowAvg, monthly, yoyFrom, yoyTo, computedAt } }
 */
function getOrComputeYoYGoals_(forceRecompute) {
  if (!forceRecompute && _yoyGoalsCache_) return _yoyGoalsCache_;

  var props = getProps_();
  var { ppStartMs, PP_MS } = currentPPStart_(props);
  var ppStartStr = Utilities.formatDate(new Date(ppStartMs), STORE_TZ, 'yyyy-MM-dd');

  // Check cache
  if (!forceRecompute) {
    var cached = {};
    try { cached = JSON.parse(props.getProperty(GC_YOY_GOALS_KEY) || '{}'); } catch(e) {}
    if (cached.ppStart === ppStartStr && cached.goals) {
      _yoyGoalsCache_ = cached.goals;
      return _yoyGoalsCache_;
    }
  }

  // Equivalent base: 52 weeks (364 days) ago — preserves day-of-week alignment
  var YEAR_MS         = 364 * 24 * 60 * 60 * 1000;
  var yoyBaseMs       = ppStartMs - YEAR_MS;          // Y1: 1 year ago (same season)
  var yoy2BaseMs      = ppStartMs - 2 * YEAR_MS;     // Y2: 2 years ago (same season — avoids Q4 vs Q2 mismatch)

  // 6 bi-weekly windows around each anchor (−3 to +2 PPs)
  var ranges = [];   // year-ago windows
  var ranges2 = [];  // two-years-ago windows
  for (var i = -3; i <= 2; i++) {
    var f1 = yoyBaseMs  + i * PP_MS;
    var f2 = yoy2BaseMs + i * PP_MS;
    ranges.push ({ fromUTC: new Date(f1).toISOString(), toUTC: new Date(f1 + PP_MS - 1).toISOString() });
    ranges2.push({ fromUTC: new Date(f2).toISOString(), toUTC: new Date(f2 + PP_MS - 1).toISOString() });
  }

  var yoyFrom = Utilities.formatDate(new Date(yoyBaseMs - 3 * PP_MS), STORE_TZ, 'yyyy-MM-dd');
  var yoyTo   = Utilities.formatDate(new Date(yoyBaseMs + 3 * PP_MS - 1), STORE_TZ, 'yyyy-MM-dd');

  var yoy2From = Utilities.formatDate(new Date(yoy2BaseMs - 3 * PP_MS), STORE_TZ, 'yyyy-MM-dd');
  var yoy2To   = Utilities.formatDate(new Date(yoy2BaseMs + 3 * PP_MS - 1), STORE_TZ, 'yyyy-MM-dd');
  Logger.log('[yoy] Computing YoY goals for PP ' + ppStartStr
    + ' | Y1 window: ' + yoyFrom + ' – ' + yoyTo
    + ' | Y2 window: ' + yoy2From + ' – ' + yoy2To + ' (6mo prior to Y1)');

  // Y2 data (~18 months ago) is purely historical — cache aggregated PP totals permanently.
  // Key on the range start dates so a new PP automatically busts the cache.
  var y2CacheKey = ranges2.map(function(r) { return r.fromUTC.slice(0,10); }).join(',');
  var ppTotalsY2ByStore = null; // { slug: avgPPSales }
  try {
    var y2Cached = JSON.parse(props.getProperty(GC_YOY2_CACHE_KEY) || '{}');
    if (y2Cached.key === y2CacheKey && y2Cached.totals) {
      Logger.log('[yoy] Y2 cache hit — skipping 36 Dutchie requests');
      ppTotalsY2ByStore = y2Cached.totals;
    }
  } catch(e2) { /* ignore, will refetch */ }

  if (!ppTotalsY2ByStore) {
    Logger.log('[yoy] Y2 cache miss — fetching 36 historical requests');
    var fetchedY2 = fetchAllStoresTransactionsMulti_(ranges2);
    ppTotalsY2ByStore = {};
    STORES.forEach(function(store) {
      var ppTotals = [];
      fetchedY2.forEach(function(byStore) {
        var txns   = byStore[store.slug] || [];
        var byDay  = aggregateByDay_(txns);
        var ppSum  = 0;
        Object.keys(byDay).forEach(function(day) { ppSum += byDay[day]; });
        ppTotals.push(ppSum);
      });
      ppTotalsY2ByStore[store.slug] = ppTotals.length > 0
        ? ppTotals.reduce(function(a, b) { return a + b; }, 0) / ppTotals.length
        : 0;
    });
    try {
      props.setProperty(GC_YOY2_CACHE_KEY, JSON.stringify({ key: y2CacheKey, totals: ppTotalsY2ByStore }));
      Logger.log('[yoy] Y2 aggregates cached for key: ' + y2CacheKey);
    } catch(e2) { Logger.log('[yoy] Y2 cache save failed: ' + e2.message); }
  }

  // Y1 data (1 year ago) is also historical within a PP — cache aggregated totals + DOW buckets.
  var y1CacheKey = ranges.map(function(r) { return r.fromUTC.slice(0,10); }).join(',');
  var y1Cache = null; // { ppTotals: { slug: avg }, dowByDay: { slug: { 'YYYY-MM-DD': sales } } }
  try {
    var y1Cached = JSON.parse(props.getProperty(GC_YOY1_CACHE_KEY) || '{}');
    if (y1Cached.key === y1CacheKey && y1Cached.ppTotals && y1Cached.dowAvg) {
      Logger.log('[yoy] Y1 cache hit — skipping 36 Dutchie requests');
      y1Cache = y1Cached;
    }
  } catch(e1) { /* ignore, will refetch */ }

  var ppTotalsY1ByStore = {};
  var dowAvgByStore     = {}; // { slug: { 0..6: avgSales } } — pre-aggregated, tiny payload

  if (y1Cache) {
    ppTotalsY1ByStore = y1Cache.ppTotals;
    dowAvgByStore     = y1Cache.dowAvg;
  } else {
    Logger.log('[yoy] Y1 cache miss — fetching 36 historical requests');
    var fetchedY1 = fetchAllStoresTransactionsMulti_(ranges);
    STORES.forEach(function(store) {
      var allByDay = {}, ppTotals = [];
      fetchedY1.forEach(function(byStore) {
        var txns  = byStore[store.slug] || [];
        var ppDay = aggregateByDay_(txns);
        var ppSum = 0;
        Object.keys(ppDay).forEach(function(day) { allByDay[day] = (allByDay[day] || 0) + ppDay[day]; ppSum += ppDay[day]; });
        ppTotals.push(ppSum);
      });
      var ppAvg = ppTotals.length > 0 ? ppTotals.reduce(function(a,b){return a+b;},0)/ppTotals.length : 0;
      ppTotalsY1ByStore[store.slug] = ppAvg;
      var dowBuckets = {0:[],1:[],2:[],3:[],4:[],5:[],6:[]};
      Object.keys(allByDay).forEach(function(day) {
        var d   = new Date(Date.UTC(Number(day.slice(0,4)), Number(day.slice(5,7))-1, Number(day.slice(8,10)), 12));
        var dow = parseInt(Utilities.formatDate(d, STORE_TZ, 'u'), 10) % 7;
        dowBuckets[dow].push(allByDay[day]);
      });
      var flatD = ppAvg > 0 ? ppAvg / PP_DAYS : 0;
      var dAvg = {};
      for (var d = 0; d <= 6; d++) {
        var vals = dowBuckets[d];
        dAvg[d] = vals.length > 0 ? Math.round(vals.reduce(function(a,b){return a+b;},0)/vals.length) : Math.round(flatD);
      }
      dowAvgByStore[store.slug] = dAvg;
    });
    try {
      props.setProperty(GC_YOY1_CACHE_KEY, JSON.stringify({ key: y1CacheKey, ppTotals: ppTotalsY1ByStore, dowAvg: dowAvgByStore }));
      Logger.log('[yoy] Y1 aggregates cached for key: ' + y1CacheKey);
    } catch(e1) { Logger.log('[yoy] Y1 cache save failed: ' + e1.message); }
  }

  // Max realized growth applied to YoY baseline (caps outlier years — new stores, one-off events)
  var MAX_REALIZED_GROWTH = 0.20; // 20%

  var goals = {};
  var pt    = ptNow_();

  STORES.forEach(function(store) {
    // ── Year-ago baseline (from cache) ────────────────────
    var ppY1        = ppTotalsY1ByStore[store.slug] || 0;
    var dowAvgY1    = dowAvgByStore[store.slug]     || {};

    // ── Two-years-ago baseline (for realized growth rate) — from cache ──
    var ppY2 = ppTotalsY2ByStore[store.slug] || 0;

    // ── Realized growth rate (Y1 vs Y2, floored at 0, capped at MAX) ──
    // Guard: if Y2 < 50% of Y1 the store was newly open 2 years ago — unreliable
    // baseline, so treat as growth = 0% rather than projecting a new-store ramp.
    var realizedGrowth = 0;
    if (ppY2 > 0 && ppY1 > 0 && ppY2 >= 0.5 * ppY1) {
      realizedGrowth = Math.max(0, Math.min(MAX_REALIZED_GROWTH, (ppY1 - ppY2) / ppY2));
    }

    // ── Forward goal = Y1 × (1 + realizedGrowth) ──────────
    var ppGoal    = ppY1 > 0 ? Math.round(ppY1 * (1 + realizedGrowth)) : 0;
    var flatDaily = ppGoal > 0 ? Math.round(ppGoal / PP_DAYS) : 0;

    // ── Scale cached DOW averages by realized growth ──────
    var dowAvg = {};
    for (var d = 0; d <= 6; d++) {
      var base  = dowAvgY1[d] != null ? dowAvgY1[d] : flatDaily / (1 + realizedGrowth);
      dowAvg[d] = Math.round(base * (1 + realizedGrowth));
    }

    var monthly = computeAccurateMonthly_(dowAvg, pt.year, pt.month);

    goals[store.slug] = {
      ppGoal:        ppGoal,
      dowAvg:        dowAvg,
      monthly:       monthly,
      yoyFrom:       yoyFrom,
      yoyTo:         yoyTo,
      ppStart:       ppStartStr,
      realizedGrowth: Math.round(realizedGrowth * 1000) / 1000, // stored for display (e.g. 0.124 = 12.4%)
      computedAt:    new Date().toISOString(),
    };

    Logger.log('[yoy] ' + store.slug + ' Y1=$' + Math.round(ppY1) + ' Y2=$' + Math.round(ppY2)
      + ' growth=' + Math.round(realizedGrowth * 100) + '% → pp=$' + ppGoal + ' mon=$' + monthly);
  });

  props.setProperty(GC_YOY_GOALS_KEY, JSON.stringify({
    ppStart:    ppStartStr,
    computedAt: new Date().toISOString(),
    yoyFrom:    yoyFrom,
    yoyTo:      yoyTo,
    goals:      goals,
  }));
  _yoyGoalsCache_ = goals;
  return goals;
}

/** Force-recompute YoY goals. */
function recalculateYoYGoals_() {
  try {
    var goals = getOrComputeYoYGoals_(true);
    return { ok: true, stores: Object.keys(goals).length };
  } catch(e) {
    Logger.log('recalculateYoYGoals_ error: ' + e.message);
    return { ok: false, error: e.message };
  }
}

/** Prefetch + cache Y1 data only (36 requests). Called from frontend before recalculate. */
function prefetchYoY1_() {
  try {
    var props     = getProps_();
    var { ppStartMs, PP_MS } = currentPPStart_(props);
    var YEAR_MS   = 364 * 24 * 60 * 60 * 1000;
    var yoyBaseMs = ppStartMs - YEAR_MS;

    var ranges = [];
    for (var i = -3; i <= 2; i++) {
      var f = yoyBaseMs + i * PP_MS;
      ranges.push({ fromUTC: new Date(f).toISOString(), toUTC: new Date(f + PP_MS - 1).toISOString() });
    }

    var y1CacheKey = ranges.map(function(r) { return r.fromUTC.slice(0,10); }).join(',');
    var fetched = fetchAllStoresTransactionsMulti_(ranges);
    var ppTotalsY1ByStore = {}, dowAvgByStore = {};
    STORES.forEach(function(store) {
      var allByDay = {}, ppTotals = [];
      fetched.forEach(function(byStore) {
        var txns  = byStore[store.slug] || [];
        var ppDay = aggregateByDay_(txns);
        var ppSum = 0;
        Object.keys(ppDay).forEach(function(day) { allByDay[day] = (allByDay[day] || 0) + ppDay[day]; ppSum += ppDay[day]; });
        ppTotals.push(ppSum);
      });
      var ppAvg = ppTotals.length > 0 ? ppTotals.reduce(function(a,b){return a+b;},0)/ppTotals.length : 0;
      ppTotalsY1ByStore[store.slug] = ppAvg;
      // Pre-compute DOW averages (7 numbers) instead of caching raw daily data (84+ entries)
      var dowBuckets = {0:[],1:[],2:[],3:[],4:[],5:[],6:[]};
      Object.keys(allByDay).forEach(function(day) {
        var d   = new Date(Date.UTC(Number(day.slice(0,4)), Number(day.slice(5,7))-1, Number(day.slice(8,10)), 12));
        var dow = parseInt(Utilities.formatDate(d, STORE_TZ, 'u'), 10) % 7;
        dowBuckets[dow].push(allByDay[day]);
      });
      var flatDaily = ppAvg > 0 ? ppAvg / PP_DAYS : 0;
      var dowAvg = {};
      for (var d = 0; d <= 6; d++) {
        var vals = dowBuckets[d];
        dowAvg[d] = vals.length > 0 ? Math.round(vals.reduce(function(a,b){return a+b;},0)/vals.length) : Math.round(flatDaily);
      }
      dowAvgByStore[store.slug] = dowAvg;
    });
    // ~1KB payload — well within 9KB script property limit
    props.setProperty(GC_YOY1_CACHE_KEY, JSON.stringify({ key: y1CacheKey, ppTotals: ppTotalsY1ByStore, dowAvg: dowAvgByStore }));
    Logger.log('[prefetchYoY1_] cached Y1 (ppTotals + dowAvg) for key: ' + y1CacheKey);
    return { ok: true };
  } catch(e) {
    Logger.log('prefetchYoY1_ error: ' + e.message);
    return { ok: false, error: e.message };
  }
}

/** Prefetch + cache Y2 data only (36 requests). Called from frontend before recalculate. */
function prefetchYoY2_() {
  try {
    var props     = getProps_();
    var { ppStartMs, PP_MS } = currentPPStart_(props);
    var YEAR_MS    = 364 * 24 * 60 * 60 * 1000;
    var yoyBaseMs  = ppStartMs - YEAR_MS;
    var yoy2BaseMs = ppStartMs - 2 * YEAR_MS; // 2 years ago, same season as Y1

    var ranges2 = [];
    for (var i = -3; i <= 2; i++) {
      var f = yoy2BaseMs + i * PP_MS;
      ranges2.push({ fromUTC: new Date(f).toISOString(), toUTC: new Date(f + PP_MS - 1).toISOString() });
    }

    var y2CacheKey = ranges2.map(function(r) { return r.fromUTC.slice(0,10); }).join(',');
    var fetched = fetchAllStoresTransactionsMulti_(ranges2);
    var ppTotalsY2ByStore = {};
    STORES.forEach(function(store) {
      var ppTotals = [];
      fetched.forEach(function(byStore) {
        var txns  = byStore[store.slug] || [];
        var byDay = aggregateByDay_(txns);
        var ppSum = 0;
        Object.keys(byDay).forEach(function(day) { ppSum += byDay[day]; });
        ppTotals.push(ppSum);
      });
      ppTotalsY2ByStore[store.slug] = ppTotals.length > 0 ? ppTotals.reduce(function(a,b){return a+b;},0)/ppTotals.length : 0;
    });
    props.setProperty(GC_YOY2_CACHE_KEY, JSON.stringify({ key: y2CacheKey, totals: ppTotalsY2ByStore }));
    Logger.log('[prefetchYoY2_] cached Y2 for key: ' + y2CacheKey);
    return { ok: true };
  } catch(e) {
    Logger.log('prefetchYoY2_ error: ' + e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Returns the stored stretch multiplier (e.g. 0.025 for 2.5%).
 * Clamped to [0, 0.05]. Defaults to 0 if not set.
 */
function getStretchMultiplier_() {
  var raw = getProps_().getProperty(GC_STRETCH_KEY);
  var val = parseFloat(raw || '0');
  return isNaN(val) ? 0 : Math.max(0, Math.min(0.05, val));
}

/**
 * Count occurrences of each day-of-week in a calendar month (PT-aware).
 * Returns { 0..6: count } using the same DOW convention as ptNow_().dow
 * (1=Mon, 2=Tue, …, 6=Sat, 0=Sun).
 *
 * @param {number} year   Full year (e.g. 2026)
 * @param {number} month  0-indexed month (0=Jan, 11=Dec)
 */
function monthDowCounts_(year, month) {
  var daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  var counts = {0:0, 1:0, 2:0, 3:0, 4:0, 5:0, 6:0};
  for (var d = 1; d <= daysInMonth; d++) {
    var dt  = new Date(Date.UTC(year, month, d, 12));   // noon UTC → correct PT date
    var dow = parseInt(Utilities.formatDate(dt, STORE_TZ, 'u'), 10) % 7; // Mon=1…Sun=0
    counts[dow]++;
  }
  return counts;
}

/**
 * Compute the exact monthly revenue goal by summing each day of the month's
 * DOW average. Accounts for the fact that months have different numbers of
 * each weekday (e.g. May 2026 has 5 Mondays but 4 Sundays).
 *
 * @param {Object} dowAvg  { 0..6: avgDailyRevenue }
 * @param {number} year    Full year
 * @param {number} month   0-indexed month
 * @return {number} Rounded monthly revenue goal
 */
function computeAccurateMonthly_(dowAvg, year, month) {
  var counts = monthDowCounts_(year, month);
  var total  = 0;
  for (var d = 0; d <= 6; d++) {
    total += (dowAvg[d] || 0) * (counts[d] || 0);
  }
  return Math.round(total);
}

/**
 * Count day-of-week occurrences from the 1st of the month through `throughDay`
 * (inclusive, clamped to the month length). Mirror of monthDowCounts_ but bounded
 * to the elapsed portion of the month. Returns { 0:Sun … 6:Sat }.
 */
function dowCountsThroughDay_(year, month, throughDay) {
  var counts = { 0:0, 1:0, 2:0, 3:0, 4:0, 5:0, 6:0 };
  var daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  var last = Math.min(throughDay, daysInMonth);
  for (var d = 1; d <= last; d++) {
    var dt  = new Date(Date.UTC(year, month, d, 12));   // noon UTC → correct PT date
    var dow = parseInt(Utilities.formatDate(dt, STORE_TZ, 'u'), 10) % 7;
    counts[dow]++;
  }
  return counts;
}

/**
 * DOW-weighted expected revenue for the COMPLETED days of the current month
 * (the 1st through yesterday), including the active stretch multiplier. This is
 * the "where MTD sales should be by now" bar for the behind-plan alert.
 *
 * Completed days only (excludes today) so an in-progress day never makes a store
 * look spuriously behind mid-shift. On the 1st there are no completed days → 0,
 * so no store can be flagged behind plan on day 1.
 *
 * Falls back to flat linear proration (completed days / days-in-month) when a
 * store has no day-of-week profile yet.
 *
 * @return {number} expected MTD revenue to date, or 0 if it can't be computed.
 */
function getProratedMonthGoalToDate_(slug) {
  var pt          = ptNow_();
  var completed   = pt.day - 1;                 // days fully elapsed this month
  if (completed <= 0) return 0;                 // day 1 → nothing completed yet

  var res = resolveGoal_(slug);
  var g   = res.g;

  if (g && g.dowAvg) {
    var counts = dowCountsThroughDay_(pt.year, pt.month, completed);
    var total  = 0;
    for (var d = 0; d <= 6; d++) total += (g.dowAvg[d] || 0) * (counts[d] || 0);
    return Math.round(total * (1 + (res.stretch || 0)));
  }

  // Fallback: flat linear when no DOW shape exists.
  var monthly = getMonthlyGoal_(slug);
  if (monthly <= 0) return 0;
  var daysInMonth = new Date(Date.UTC(pt.year, pt.month + 1, 0)).getUTCDate();
  return Math.round(monthly * (completed / daysInMonth));
}

/**
 * Resolve the effective goal set for a store:
 *   1. Manual PP override → scales computed DOW ratios to match the override
 *   2. Otherwise → max(rolling, yoy) + stretch
 * Returns { g (goals object with dowAvg), effectivePP, useManual, stretch }
 */
function resolveGoal_(slug) {
  var stretch = getStretchMultiplier_();
  var manuals = getManualPPGoals_();
  var rGoals  = getOrComputeGoals_();
  var yGoals  = getOrComputeYoYGoals_();
  var gr = (rGoals && rGoals[slug]) || {};
  var gy = (yGoals && yGoals[slug]) || {};
  var rPP = gr.ppGoal || 0;
  var yPP = gy.ppGoal || 0;
  var g   = (yPP > rPP) ? gy : gr; // use the higher source for DOW shape
  var computedMaxPP = Math.max(rPP, yPP);

  var manualRaw = manuals[slug];
  var manualPP  = manualRaw ? parseFloat(manualRaw) : NaN;
  if (!isNaN(manualPP) && manualPP > 0) {
    // Treat as stretch-derived only if it matches max(R,Y)×stretch within 1%.
    var expectedPP_      = computedMaxPP * (1 + stretch);
    var isStretchDerived = expectedPP_ > 0 &&
      Math.abs(manualPP - expectedPP_) / expectedPP_ < 0.01;
    if (!isStretchDerived) {
      // True manual override — scale DOW averages proportionally to the override PP
      var computedPP = g.ppGoal || 1;
      var scale = manualPP / computedPP;
      var scaledAvg = {};
      if (g.dowAvg) {
        for (var d = 0; d <= 6; d++) {
          scaledAvg[d] = (g.dowAvg[d] || 0) * scale;
        }
      }
      var scaledG = { ppGoal: manualPP, dowAvg: scaledAvg };
      return { g: scaledG, effectivePP: manualPP, useManual: true, stretch: 0 };
    }
  }
  return { g: g, effectivePP: g.ppGoal || 0, useManual: false, stretch: stretch };
}

/**
 * Daily revenue goal — higher of rolling vs. YoY per store + stretch.
 * Manual PP override (if set) bypasses computed goals entirely; stretch not applied on top.
 */
function getDailyGoal_(slug) {
  try {
    var res = resolveGoal_(slug);
    var g   = res.g;
    if (g && g.dowAvg) {
      var dow  = ptNow_().dow;
      var base = g.dowAvg[dow] || Math.round((g.ppGoal || 0) / PP_DAYS);
      return Math.round(base * (1 + res.stretch));
    }
  } catch(e) { Logger.log('getDailyGoal_ error: ' + e.message); }
  var stretch = getStretchMultiplier_();
  var plan = (getStorePlans_())[slug] || {};
  if (plan.daily)   return Math.round(plan.daily   * (1 + stretch));
  if (plan.monthly) return Math.round(plan.monthly / 30.4 * (1 + stretch));
  return 0;
}

/** Monthly revenue goal — exact weekday count. Manual override scales DOW ratios; otherwise max(rolling,yoy) + stretch. */
function getMonthlyGoal_(slug) {
  try {
    var res = resolveGoal_(slug);
    var g   = res.g;
    if (g && g.dowAvg) {
      var pt      = ptNow_();
      var monthly = computeAccurateMonthly_(g.dowAvg, pt.year, pt.month);
      return Math.round(monthly * (1 + res.stretch));
    }
  } catch(e) { Logger.log('getMonthlyGoal_ error: ' + e.message); }
  var stretch = getStretchMultiplier_();
  var plan = (getStorePlans_())[slug] || {};
  if (plan.monthly) return Math.round(plan.monthly * (1 + stretch));
  if (plan.daily)   return Math.round(plan.daily * 30.4 * (1 + stretch));
  return 0;
}

/**
 * Public endpoint payload — computed daily goals (all 7 DOWs, 0=Sun) and monthly goal
 * for every store, keyed by the Sales Dashboard's budget-sheet store names (locationName).
 * Uses the same resolveGoal_() logic as the kiosk / leaderboard.
 */
function getDailyGoals_() {
  var pt       = ptNow_();
  var MONTHS   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var result   = {};
  STORES.forEach(function(s) {
    var res     = resolveGoal_(s.slug);
    var g       = res.g;
    var stretch = res.stretch;
    var dow     = [];
    for (var d = 0; d <= 6; d++) {
      if (g && g.dowAvg) {
        var base = g.dowAvg[d] || Math.round((g.ppGoal || 0) / PP_DAYS);
        dow.push(Math.round(base * (1 + stretch)));
      } else {
        var plan  = (getStorePlans_())[s.slug] || {};
        var daily = plan.daily   ? Math.round(plan.daily   * (1 + stretch))
                  : plan.monthly ? Math.round(plan.monthly / 30.4 * (1 + stretch))
                  : 0;
        dow.push(daily);
      }
    }
    result[s.locationName] = { monthly: getMonthlyGoal_(s.slug), dow: dow };
  });
  return { month: MONTHS[pt.month], year: pt.year, stores: result };  // pt.month is 0-indexed
}

/**
 * Daily revenue goal for a specific day-of-week (0=Sun,1=Mon,...,6=Sat).
 * Used to look up yesterday's goal when displaying pre-open stats.
 */
function getDailyGoalForDow_(slug, dow) {
  try {
    var res = resolveGoal_(slug);
    var g   = res.g;
    if (g && g.dowAvg) {
      var base = g.dowAvg[dow] || Math.round((g.ppGoal || 0) / PP_DAYS);
      return Math.round(base * (1 + res.stretch));
    }
  } catch(e) { Logger.log('getDailyGoalForDow_ error: ' + e.message); }
  return getDailyGoal_(slug);
}

/** PP revenue target — manual override if set, otherwise max(rolling, yoy) + stretch. */
function getPayPeriodTarget_(slug) {
  try {
    var res = resolveGoal_(slug);
    return res.effectivePP ? Math.round(res.effectivePP * (1 + res.stretch)) : 0;
  } catch(e) {
    Logger.log('getPayPeriodTarget_ error: ' + e.message);
    return 0;
  }
}

/**
 * Returns the prorated revenue goal for a given period based on rolling daily avg.
 *   'today' → one day's target
 *   'pp'    → 14-day pay-period target
 *   others  → dailyAvg × range.daysElapsed
 */
function getPeriodGoal_(slug, period, range) {
  const pp = getPayPeriodTarget_(slug);
  if (!pp) return 0;
  const daily = pp / PP_DAYS;
  if (period === 'today') return Math.round(daily);
  if (period === 'pp')    return Math.round(pp);
  const elapsed = (range && range.daysElapsed) || 0;
  return Math.round(daily * elapsed);
}

/**
 * Compute and cache 14-day pay-period targets for all stores.
 * Fetches TARGET_LOOKBACK_MONTHS monthly chunks in parallel
 * (6 months × 6 stores = 36 parallel HTTP requests via fetchAll).
 *
 * Run nightly via installTargetRefreshTrigger(), or on-demand via
 * ?action=refreshtargets (director auth required).
 *
 * Formula: (net_sales over 6 months) / (actual days) × 14
 */
function refreshTargetsAll() {
  const props = PropertiesService.getScriptProperties();
  // Use PT date so that a run at e.g. 11 pm PT (= midnight UTC) uses the correct PT month.
  const pt = ptNow_();
  const y  = pt.year;
  const m  = pt.month;   // 0-indexed

  // Build monthly ranges: current month + prior (TARGET_LOOKBACK_MONTHS-1) months
  const ranges = [];
  for (let i = TARGET_LOOKBACK_MONTHS - 1; i >= 0; i--) {
    const rYear  = m - i < 0 ? y - 1 : y;
    const rMonth = ((m - i) % 12 + 12) % 12;   // 0-indexed, wraps correctly
    const firstStr = rYear + '-' + String(rMonth + 1).padStart(2, '0') + '-01';
    // last day of the month: day 0 of next month
    const lastDate = new Date(Date.UTC(rYear, rMonth + 1, 0));
    const lastStr  = Utilities.formatDate(lastDate, STORE_TZ, 'yyyy-MM-dd');
    ranges.push({
      fromUTC: new Date(ptDateToUtcMs_(firstStr)).toISOString(),
      toUTC:   new Date(ptDateToUtcMs_(i === 0 ? pt.dateStr : lastStr) + 24 * 60 * 60 * 1000 - 1).toISOString(),
    });
  }

  // One mega-batch: 6 months × 6 stores = 36 parallel HTTP requests
  const fetched = fetchAllStoresTransactionsMulti_(ranges);

  // Sum net sales per store across all months
  const netBySlug = {};
  STORES.forEach(s => { netBySlug[s.slug] = 0; });
  fetched.forEach(byStore => {
    STORES.forEach(s => {
      (byStore[s.slug] || []).forEach(tx => { netBySlug[s.slug] += txNet_(tx); });
    });
  });

  // Lookback: PT first day of oldest month → PT today (actual calendar days)
  const oldestYear  = m - (TARGET_LOOKBACK_MONTHS - 1) < 0 ? y - 1 : y;
  const oldestMonth = ((m - (TARGET_LOOKBACK_MONTHS - 1)) % 12 + 12) % 12;
  const firstDayStr  = oldestYear + '-' + String(oldestMonth + 1).padStart(2, '0') + '-01';
  const lookbackMs   = ptDateToUtcMs_(pt.dateStr) - ptDateToUtcMs_(firstDayStr);
  const lookbackDays = Math.max(1, Math.round(lookbackMs / (24 * 60 * 60 * 1000)));

  const cache  = {};
  const report = {};
  STORES.forEach(s => {
    const ppTarget = Math.round(netBySlug[s.slug] / lookbackDays * PP_DAYS);
    cache[s.slug]  = { ppTarget, computedAt: new Date().toISOString() };
    report[s.slug] = ppTarget;
    Logger.log('[targets] ' + s.slug + ': net=' + Math.round(netBySlug[s.slug])
      + ' / ' + lookbackDays + 'd × 14 → pp=$' + ppTarget);
  });

  props.setProperty(GC_TARGET_CACHE_KEY, JSON.stringify(cache));
  return { ok: true, lookbackDays, targets: report };
}

/**
 * Install a daily 3 AM trigger for target refresh.
 * Run once from Script Editor — do NOT call via HTTP.
 */
function installTargetRefreshTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'refreshTargetsAll')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('refreshTargetsAll')
    .timeBased().atHour(3).everyDays(1).create();
  Logger.log('Daily target refresh trigger installed (3 AM).');
}

// ── Setup helper (run from editor) ────────────────────────────
/**
 * Write store plans.  Call from Script Editor:
 *   setStorePlans_({
 *     baseline:   { monthly: 255000, daily: 8500 },
 *     ...
 *   });
 */
function setStorePlans_(plans) {
  PropertiesService.getScriptProperties().setProperty(GC_STORE_PLANS_KEY, JSON.stringify(plans));
  Logger.log('Plans saved: ' + JSON.stringify(plans));
  return { ok: true };
}

/** Save per-store manual PP goal overrides. Expects params.goals = JSON string of { slug: value }. */
function saveManualGoals_(params) {
  if (!params.goals) return { ok: false, error: 'Missing goals param' };
  var parsed;
  try { parsed = JSON.parse(params.goals); } catch(e) {
    return { ok: false, error: 'Invalid JSON: ' + e.message };
  }
  // Validate and clean: only known store slugs, positive numbers (or null/0 to clear)
  var known = {};
  STORES.forEach(function(s) { known[s.slug] = true; });
  var clean = {};
  Object.keys(parsed).forEach(function(slug) {
    if (!known[slug]) return;
    var v = parseFloat(parsed[slug]);
    if (v > 0) clean[slug] = v;
    // 0 / null / '' → omit (clears the override)
  });
  PropertiesService.getScriptProperties().setProperty(GC_MANUAL_PP_KEY, JSON.stringify(clean));
  Logger.log('[manualGoals] saved: ' + JSON.stringify(clean));
  return { ok: true };
}

/**
 * Returns monthly revenue goals for all 12 months of the current year, keyed by
 * Dutchie store name (matching the Sales Dashboard's STORES[].name convention).
 * Uses the same max(rolling, yoy) + stretch + manual override logic as the leaderboard.
 * Response: { ok: true, goals: { dutchieName: { Jan: X, Feb: Y, ... } } }
 */
function getGoalsForDashboard_() {
  var MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var year = ptNow_().year;
  var dashGoals = {};
  STORES.forEach(function(s) {
    try {
      var res = resolveGoal_(s.slug);  // { g, effectivePP, useManual, stretch }
      var g   = res.g;
      if (!g || !g.dowAvg) return;
      var monthly = {};
      MONTH_NAMES.forEach(function(name, i) {
        var base = computeAccurateMonthly_(g.dowAvg, year, i);
        monthly[name] = Math.round(base * (1 + res.stretch));
      });
      dashGoals[s.locationName || s.dutchieName] = monthly;
    } catch(e) {
      Logger.log('getGoalsForDashboard_ error for ' + s.slug + ': ' + e.message);
    }
  });
  return { ok: true, goals: dashGoals };
}
