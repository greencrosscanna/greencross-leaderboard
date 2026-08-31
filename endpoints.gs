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
      const { ppStartMs, ppEndMs } = currentPPStart_();
      fromMs = ppStartMs;
      toMs   = ppEndMs;
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
    var trends = Object.create(null);
    STORES.forEach(function(store) {
      trends[store.slug] = trendFromByDay_(aggregateByDay_(byStore30d[store.slug] || []));
    });
    // CacheService max TTL is 21600s (6h); use 4h so trends refresh mid-day
    CacheService.getScriptCache().put(GC_STORE_TREND_CACHE_KEY, JSON.stringify(trends), 14400);
    return trends;
  } catch(e) { return null; }
}

/**
 * Employee nameKeys to keep OFF the board — anyone Crew has marked retired/merged/deleted.
 *
 * The old hand-maintained GC_EXCLUDED_JSON list is no longer consulted. Sky confirmed it held only
 * retired people, which employment status now covers, and status keeps working for anyone Crew
 * retires in future without a soul touching Leaderboard.
 *
 * Five call sites in this file filter through here, which is why teaching this one function about
 * status retired staff from the kiosk, leaderboard, director view and standings all at once.
 */
function getExcluded_() {
  var out = new Set();
  try {
    // excludedKeys is built from EVERY GX Core row, so someone Crew retired is off the board on the
    // next roster read -- it no longer waits for this app's 30-day Dutchie roster to be re-synced,
    // which is what left ten retired people (Rebeka Perez among them) on the board. retiredKeys is
    // folded into it, so this is a superset of what this function used to return.
    var r = gxRoster_();
    Object.keys(r.excludedKeys || {}).forEach(function (k) { out.add(k); });
    (r.retiredKeys || []).forEach(function (k) { out.add(k); });
  }
  catch (e) { gxRosterWarn_(e); }
  return out;
}

/**
 * Job titles, keyed by nameKey. GX Core only; Crew is the only editor.
 * role_title is free text there, so it is normalized to the three values this app switches on.
 * Anything that does not map (Director, Intake Manager) is left out, and the caller defaults it.
 */
function getRoles_() {
  var out = Object.create(null);
  try {
    var recs = gxAllRecs_();
    Object.keys(recs).forEach(function (k) {
      var role = gxNormaliseRole_(recs[k].roleTitle);
      if (role) out[k] = role;
    });
  } catch (e) { gxRosterWarn_(e); }
  return out;
}

/** Crew writes human job titles ("Asst. Manager"); this app switches on slugs. */
function gxNormaliseRole_(title) {
  var t = String(title || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (!t) return '';
  if (t.indexOf('asst') === 0 || t.indexOf('assistant') === 0) return 'asst_manager';
  if (t.indexOf('store manager') === 0 || t === 'manager')      return 'store_manager';
  if (t.indexOf('budtender') === 0)                             return 'budtender';
  return '';   // intake manager, director, etc. — not a leaderboard rank, leave the local value
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
/**
 * Current Employee of the Month, as { employeeKey: <nameKey>, since }.
 *
 * Employee of the Month is an HR function and belongs to Crew. Crew writes it to the GX Core kv
 * registry as `cfg.eom` = {"employee_id":"…","since":"…"}, keyed on employee_id — NOT on a name.
 * That keying is the point: the local copy below is keyed on a nameKey derived from the person's
 * name, so a rename in Crew silently drops the star off the kiosk. Same flaw Crew already fixed for
 * avatar seeds by pinning them to employee_number.
 *
 * GX Core wins when it has a value; the local Script Property is the fallback so there is no window
 * where EoM cannot be set while Crew's picker is still being built. Once Crew ships, the local
 * branch and Leaderboard's own picker both go.
 */
function getEomCurrent_() {
  var central = gxEomFromCore_();
  // undefined = Crew has never written the key, so the old local value is still the best answer.
  // null = Crew HAS written it and the answer is "nobody" (cleared, or an id nobody here sold under).
  // Falling back in that second case would put a stale star back on the kiosk after somebody
  // deliberately cleared it, which is worse than showing none.
  if (central !== undefined) return central;
  try {
    var raw = getProps_().getProperty(GC_EOM_KEY);
    if (!raw) return null;
    var p = JSON.parse(raw);
    return (p && p.employeeKey) ? p : null;
  } catch(e) { return null; }
}

/** Read cfg.eom from GX Core and resolve its employee_id back to this app's nameKey. */
function gxEomFromCore_() {
  try {
    var raw = GXCore.getKv('cfg.eom');
    if (raw === null || raw === undefined) return undefined;   // never written
    if (String(raw).trim() === '') return null;                // written empty == deliberately nobody
    var v = (typeof raw === 'object') ? raw : JSON.parse(raw);
    var empId = String((v && v.employee_id) || '').trim();
    if (!empId) return null;
    var byKey = gxRoster_().byKey || {};
    var found = null;
    Object.keys(byKey).forEach(function (k) {
      if (!found && byKey[k].employeeId === empId) found = k;
    });
    // employee_id that is not in this store's roster (e.g. a transfer, or nobody sold in 30 days)
    // resolves to nothing rather than falling back — Crew said who it is, and it is not this person.
    return found ? { employeeKey: found, since: (v && v.since) || '', source: 'gxcore' } : null;
  } catch (e) { gxRosterWarn_(e); return undefined; }   // unreadable -> let the local value stand
}

/** Normalize a Dutchie name into a lookup key (lowercase, no periods/quotes, spaces→underscore). */
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
  let totalRevenue  = 0;
  let totalGoal     = 0;
  let totalPaceGoal = 0;   // DOW-weighted expected-so-far, summed per store (NOT linear clock time)
  const combinedHourMap = Object.create(null);  // hour → { revenue, count }

  STORES.forEach(function(store) {
    const txns     = (byStoreToday || {})[store.slug] || [];
    const agg      = aggregateTransactions_(txns);
    const dailyGoal = getDailyGoal_(store.slug);

    totalRevenue  += agg.sales;
    totalGoal     += dailyGoal;
    totalPaceGoal += dailyGoal * expectedSalesFrac_(store, nowHour, nowMinute, dayFrac);

    // Merge hourly buckets
    const hm = aggregateByHour_(txns);
    Object.entries(hm).forEach(([h, v]) => {
      if (!combinedHourMap[h]) combinedHourMap[h] = { revenue: 0, count: 0 };
      combinedHourMap[h].revenue += v.revenue;
      combinedHourMap[h].count   += v.count;
    });
  });

  const pctToGoal  = totalGoal > 0 ? r3_(totalRevenue / totalGoal) : 0;
  // DOW-weighted chain pace (matches each store's hourly curve + Standings) — not linear clock time, so a
  // slow morning doesn't read as behind. Fraction of the day expected so far = totalPaceGoal / totalGoal.
  const paceGoal   = totalPaceGoal > 0 ? totalPaceGoal : totalGoal * dayFrac;
  const _expFrac   = totalGoal > 0 ? paceGoal / totalGoal : dayFrac;
  const pace       = paceGoal > 0.5 ? r3_((totalRevenue - paceGoal) / paceGoal) : 0;
  const paceGap    = paceGoal > 0.5 ? r2_(totalRevenue - paceGoal) : 0;  // + ahead, − behind
  const toGo       = Math.max(0, totalGoal - totalRevenue);
  const MIN_PROJ_HOURS = 2;
  const projectedRevenue = storeClosed
    ? totalRevenue
    : (elapsedHours >= MIN_PROJ_HOURS && _expFrac > 0.02)
      ? Math.round(totalRevenue / _expFrac)
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

  // Prime all stores' hourly distributions in ONE parallel fetch (was: 6 sequential per-store
  // fetches = 60–90s cold). After this, getHourlyDist_ below is a cache hit for every store.
  try { primeHourlyDist_(STORES); } catch(e) {}

  // Sum per-store hourly targets (reads from cache — primed just above / by kiosk views)
  const hourlyTargetMap = Object.create(null);
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
    // Chain-wide DOW-weighted position — see the note in getStoreToday. No single shape
    // here because this is six stores summed; the client uses the value and re-derives
    // its glide from the elapsed share of the day.
    expectedFrac:       r3_(_expFrac),
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

  // Prefer the day-cached per-store aggregates (merge to a chain total); fall back
  // to a raw fetch + aggregate when called standalone (directorsummary action).
  const curr = pre.byStoreAgg
    ? mergeAggs_(Object.values(pre.byStoreAgg))
    : aggregateTransactions_(Object.values(pre.byStore || fetchAllStoresTransactions_(range)).flat());
  const prev = pre.prevByStoreAgg
    ? mergeAggs_(Object.values(pre.prevByStoreAgg))
    : aggregateTransactions_(Object.values(pre.prevByStore || fetchAllStoresTransactions_(prior)).flat());

  const allEmps       = Object.values(curr.byEmployee).filter(e => !gxIsExcluded_(e));
  const _discRed      = discountRedLineDec_();   // 2× the discount target
  const flaggedEmps   = allEmps.filter(e => e.discountRate > _discRed);

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
  // pre.byStoreAgg is the day-cached per-store aggregate (preferred); byStore raw is
  // only fetched when neither is supplied (standalone directorstores action).
  const byStore      = pre.byStore      || (pre.byStoreAgg ? {} : fetchAllStoresTransactions_(range));
  const byStoreToday = pre.byStoreToday || (period === 'today' ? byStore : fetchAllStoresTransactions_(todayR));
  const byStore30d   = pre.byStore30d   || null;  // 30-day window for trends (pre-fetched by directorall)
  const storeTrends  = pre.storeTrends  || null;  // pre-computed { slug: {trend30d,trendPct} } from cache

  // Look up user records once for manager info
  const users = JSON.parse(
    PropertiesService.getScriptProperties().getProperty(GC_USERS_KEY) || '{}'
  );

  const storeSummaries = STORES.map(function(store) {
    const txnsToday = byStoreToday[store.slug] || [];
    const agg       = (pre.byStoreAgg && pre.byStoreAgg[store.slug]) || aggregateTransactions_(byStore[store.slug] || []);
    const aggToday  = aggregateTransactions_(txnsToday);

    const dailyGoal  = getDailyGoal_(store.slug);
    const periodGoal = getPeriodGoal_(store.slug, period, range);
    const vsplan     = periodGoal > 0 ? r3_((agg.sales - periodGoal) / periodGoal) : 0;

    // Pace for today: (revenue / goal) at DOW-weighted expected-so-far (matches the store's real
    // hourly curve, kiosk, and Standings — NOT linear clock time, so a slow morning doesn't read as
    // behind). Falls back to linear dayFrac if the hourly curve isn't warm yet.
    const { hour: nowLocalHour, minute: nowLocalMinute } = ptHourNow_();
    const elapsed      = Math.max(0, Math.min(nowLocalHour + nowLocalMinute / 60 - STORE_OPEN_HOUR, STORE_HOURS));
    const dayFrac      = elapsed / STORE_HOURS;
    const expectedFrac = expectedSalesFrac_(store, nowLocalHour, nowLocalMinute, dayFrac);
    const paceGoal     = dailyGoal * expectedFrac;
    const todayPace    = paceGoal > 0.5 ? r3_((aggToday.sales - paceGoal) / paceGoal) : 0;

    // Projected EOD: extrapolate along the DOW-weighted curve; requires 2+ hours of data
    const MIN_PROJ_HOURS = 2;
    const projectedRevenue = (elapsed >= MIN_PROJ_HOURS && expectedFrac > 0.02)
      ? Math.round(aggToday.sales / expectedFrac) : 0;
    const projectedPace    = (projectedRevenue > 0 && dailyGoal > 0)
      ? r3_((projectedRevenue - dailyGoal) / dailyGoal) : null;

    // Manager from user records
    const mgr = Object.values(users).find(u => u.storeSlug === store.slug && u.role === 'store_manager') || {};

    // Flagged employees (over 2× the discount target)
    const flaggedEmps = Object.values(agg.byEmployee).filter(e => e.discountRate > discountRedLineDec_());

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
      today:         { revenue: aggToday.sales, goal: dailyGoal, pace: todayPace, pctToGoal: dailyGoal > 0 ? r3_(aggToday.sales / dailyGoal) : 0, projected: projectedRevenue, projectedPace: projectedPace, dayFrac: r3_(dayFrac),
                       // Weighted pace position + the curve behind it, so the wall's hash marks
                       // land where the pace VALUE says they should (see getStoreToday).
                       expectedFrac: r3_(expectedFrac), hourShape: getHourlyDistCached_(store) || null,
                       transactions: aggToday.transactions, avgOrderValue: aggToday.avgOrderValue, avgUPT: aggToday.avgUPT, discountRate: aggToday.discountRate },
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
  const byStore   = pre.byStore   || (pre.byStoreAgg ? {} : fetchAllStoresTransactions_(range));
  const byStore30d = pre.byStore30d || null;

  // Build per-employee daily revenue buckets from the 30d window (for trend lines).
  const empDailyBuckets = Object.create(null); // { empKey: { 'YYYY-MM-DD': revenue } }
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
  const globalEmps = Object.create(null);

  STORES.forEach(function(store) {
    const agg = (pre.byStoreAgg && pre.byStoreAgg[store.slug]) || aggregateTransactions_(byStore[store.slug] || []);
    Object.values(agg.byEmployee).forEach(function(emp) {
      const key = emp.name.toLowerCase().replace(/\s+/g, '_');
      if (gxIsExcluded_(emp)) return;
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
        globalEmps[key].discountsBdt += emp.discountsBdt;
        globalEmps[key].subtotal     += emp.subtotal;
      }
    });
  });

  // Include the FULL active roster — employees with no sales in the selected period appear with $0, so
  // Top Performers lists all active staff (not only those who rang a sale this period). Sellers keep
  // their real stats; roster-only names get zeroed metrics and their role from the settings roster.
  //
  // gxBelongsToStore_ gates this fill for the same reason it gates the kiosk's off-shift cards
  // (getStoreToday / getStoreLeaderboard): the roster is derived from 30 days of transactions, so one
  // covered shift leaves someone on a store's roster indefinitely. Here that had a SECOND symptom —
  // this loop assigns storeSlug from whichever store reaches the name first, so Drew Phillips
  // (home_store 'corporate') was listed at $0 under portland or river purely by iteration order.
  // Gating on crew membership fixes both: non-crew stop being filled in at all, and everyone who is
  // filled in lands under the one store they actually belong to, not the first one round the loop.
  //
  // This never hides a SELLER. Anyone with transactions is already in globalEmps from the loop above,
  // which this gate does not touch — so a corporate covering a shift still ranks with their real
  // numbers. The gate fails open on an unknown home_store, and in that case attribution stays
  // first-store-wins as before.
  STORES.forEach(function(store) {
    (getEmployeeRoster_()[store.slug] || []).forEach(function(p) {
      const key = p.name.toLowerCase().replace(/\s+/g, '_');
      if (gxIsExcluded_(p)) return;
      if (!gxBelongsToStore_(p, store)) return;
      if (globalEmps[key]) return;   // already present from transactions — keep real stats
      globalEmps[key] = {
        initials:     p.initials,
        name:         p.name,
        role:         p.role || '',
        roleLabel:    p.roleLabel || '',
        storeSlug:    store.slug,
        storeName:    store.name,
        sales: 0, transactions: 0, items: 0, discounts: 0, discountsBdt: 0, subtotal: 0,
        tags: [],
      };
    });
  });

  // Per-employee TODAY aggregation (for the Top Performers "Today" tab) — from byStoreToday,
  // keyed the same way as the period aggregation so it lines up per employee. Period-independent,
  // so it rides along in every directorall payload (MTD + PP) and the tab needs no extra fetch.
  const byStoreToday = pre.byStoreToday || {};
  const todayByEmp = Object.create(null);
  STORES.forEach(function(store) {
    const aggT = aggregateTransactions_(byStoreToday[store.slug] || []);
    Object.values(aggT.byEmployee).forEach(function(emp) {
      const key = emp.name.toLowerCase().replace(/\s+/g, '_');
      if (gxIsExcluded_(emp)) return;
      if (!todayByEmp[key]) todayByEmp[key] = { sales: 0, transactions: 0, items: 0, discountsBdt: 0, subtotal: 0 };
      todayByEmp[key].sales        += emp.sales;
      todayByEmp[key].transactions += emp.transactions;
      todayByEmp[key].items        += emp.items;
      todayByEmp[key].discountsBdt += emp.discountsBdt;
      todayByEmp[key].subtotal     += emp.subtotal;
    });
  });

  // Re-derive metrics and apply tags
  const _roles = getRoles_();
  const staffList = Object.values(globalEmps).map(function(emp) {
    const aov    = emp.transactions > 0 ? r2_(emp.sales / emp.transactions) : 0;
    const upt    = emp.transactions > 0 ? r1_(emp.items / emp.transactions)  : 0;
    const disc   = emp.subtotal     > 0 ? r3_(emp.discountsBdt / emp.subtotal) : 0;  // discretionary basis (excl. loyalty/promos)
    const empKey = emp.name.toLowerCase().replace(/\s+/g, '_');
    const trend  = trendFromByDay_(empDailyBuckets[empKey] || {}, { useAverage: true });
    const _t     = todayByEmp[empKey] || { sales: 0, transactions: 0, items: 0, discountsBdt: 0, subtotal: 0 };

    const tags = [];
    const staffTagTooltips = [];
    // Discount flag/watch tags retired — the discretionary-basis discount rate is
    // shown as a relative bar, and Veteran-discount outliers surface in the
    // dedicated Veteran Discount Watch (peer-relative). No stale flat-threshold tags.

    return {
      initials:      emp.initials,
      name:          emp.name,
      nameKey:       nameToKey_(emp.name),  // canonical key before nickname — matches settings page
      role:          emp.role || '',
      roleLabel:     own_(ROLE_LABELS, _roles[nameToKey_(emp.name)]) || emp.roleLabel || ROLE_LABELS.budtender,  // unassigned staff default to Budtender (matches Settings)
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
      today: {
        sales:         _t.sales,
        transactions:  _t.transactions,
        avgOrderValue: _t.transactions > 0 ? r2_(_t.sales / _t.transactions) : 0,
        avgUPT:        _t.transactions > 0 ? r1_(_t.items / _t.transactions)  : 0,
        discountRate:  _t.subtotal     > 0 ? r3_(_t.discountsBdt / _t.subtotal) : 0,
      },
    };
  });

  // Sort by sales, assign ranks, badge top performers
  staffList.sort((a, b) => b.sales - a.sales);
  const _nicknames = getNicknames_();
  staffList.forEach(function(s, i) {
    s.rank = i + 1;
    // fullName (management view): nickname REPLACES the first name but the Dutchie
    // last name is kept — e.g. "Sunshine Ward". No nickname → full Dutchie name.
    // s.name here is still the full Dutchie name ("First Last").
    var _nk = _nicknames[s.nameKey];
    if (_nk) {
      var _parts = s.name.trim().split(/\s+/);
      var _last  = _parts.length > 1 ? _parts[_parts.length - 1] : '';   // surname = last token
      s.fullName = _last ? _nk + ' ' + _last : _nk;                       // "Nickname Lastname"
    } else {
      s.fullName = s.name;   // full Dutchie name
    }
    s.name = applyNickname_(s.name, _nicknames);   // short display (first name / nickname) — kiosk + ticker
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
  const byStore   = pre.byStore || (pre.byStoreAgg ? {} : fetchAllStoresTransactions_(range));
  const plans     = getStorePlans_();
  const alerts    = [];
  const discWatch = [];

  STORES.forEach(function(store) {
    const agg          = (pre.byStoreAgg && pre.byStoreAgg[store.slug]) || aggregateTransactions_(byStore[store.slug] || []);
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

    // (Discount-watch alert retired — superseded by the Veteran Discount Watch,
    //  which is peer-relative on the discretionary basis.)
  });

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
/**
 * Drop cache entries older than `cutoff`, keeping today's and other stores'.
 *
 * The prune this replaces read the date with k.split(':')[1], but the key is
 * '<slug>:dow:<date>' -- index 1 is the literal string 'dow'. 'dow' < a yyyy-MM-dd
 * cutoff is always false, so nothing was ever deleted and the property grew without
 * bound toward the 9KB-per-value ScriptProperties limit, at which point setProperty
 * throws inside the leaderboard payload. Anchoring on the date at the END of the key
 * also means an entry in any other shape is unrecognized, and dropped rather than kept
 * forever -- which is what clears the entries left behind by the shared-key era.
 *
 * @param {Object} cache
 * @param {string} cutoff  yyyy-MM-dd; entries dated before this are removed
 * @return {Object} the same object, pruned in place
 */
function pruneEmpTargetCache_(cache, cutoff) {
  cache = cache || {};
  Object.keys(cache).forEach(function(k) {
    const m = /:(\d{4}-\d{2}-\d{2})$/.exec(k);
    if (!m || m[1] < cutoff) delete cache[k];
  });
  return cache;
}

/**
 * How busy `todayDow` is at this store relative to an average day, measured from the
 * SAME 28-day window the targets are built from — so it needs no goal state and no
 * second fetch, and it moves with the store instead of a hardcoded curve.
 *
 * Used only to aim an all-days average at a specific weekday. Returns 1 (no change)
 * whenever the evidence is too thin to trust: a weekday needs at least 2 dates of
 * store history, and the result is clamped to [0.5, 1.5] so one freak day — a holiday,
 * an outage, a soft open — cannot double or erase somebody's target.
 *
 * @param {Object} storeDays  { 'yyyy-MM-dd': storeSalesThatDay }
 * @param {number} todayDow   0=Sun … 6=Sat
 * @return {number} multiplier, 1 when indeterminate
 */
function storeDowFactor_(storeDays, todayDow) {
  const sums   = [0,0,0,0,0,0,0];
  const counts = [0,0,0,0,0,0,0];
  Object.keys(storeDays || {}).forEach(function(dateStr) {
    const v = storeDays[dateStr];
    if (!(v > 0)) return;
    const d = new Date(dateStr + 'T12:00:00').getDay();
    sums[d]   += v;
    counts[d] += 1;
  });

  if (counts[todayDow] < 2) return 1;

  const avgs = [];
  for (let d = 0; d <= 6; d++) if (counts[d] > 0) avgs.push(sums[d] / counts[d]);
  if (avgs.length < 2) return 1;

  const overall = avgs.reduce(function(a, b) { return a + b; }, 0) / avgs.length;
  if (!(overall > 0)) return 1;

  const factor = (sums[todayDow] / counts[todayDow]) / overall;
  if (!isFinite(factor) || factor <= 0) return 1;
  return Math.min(1.5, Math.max(0.5, factor));
}

/**
 * Pure per-employee target math, split out of computeEmpTargets_ so the kiosk, the
 * emptargetdiag route and tests/emp_targets_test.js all run THE SAME code. The
 * question this has to answer is "why is this person's target above that person's",
 * which the returned number alone cannot answer — so `detail` reports the basis each
 * target was computed on, not just the result.
 *
 * @param {Array}  txns      Transactions covering the 28-day window
 * @param {number} todayDow  0=Sun … 6=Sat
 * @param {number} fallback  Target for an employee with no usable history
 * @return {Object} { targets: {nameKey: dollars}, detail: {nameKey: {...}} }
 */
function empTargetsFromTxns_(txns, todayDow, fallback) {
  // Group: nameKey → { dateStr → dailySales }, and the store's own totals per
  // date (every ringing employee, so the weekday shape below is the store's).
  const empDays   = Object.create(null);
  const storeDays = Object.create(null);
  (txns || []).forEach(function(tx) {
    const ts  = tx.transactionDateLocalTime || tx.transactionDate || '';
    const day = ts.slice(0, 10);
    if (!day || day.length < 10) return;
    storeDays[day] = (storeDays[day] || 0) + txTotal_(tx);

    const emp = txEmployee_(tx);
    const key = emp.name.toLowerCase().replace(/\s+/g, '_');
    if (!key || key === 'unknown') return;
    if (!empDays[key]) empDays[key] = {};
    empDays[key][day] = (empDays[key][day] || 0) + txTotal_(tx);
  });

  const dowFactor = storeDowFactor_(storeDays, todayDow);

  // Average daily sales per employee — same day-of-week only, then +2.5 %.
  // Using the same DOW (e.g. only Sundays on a Sunday) means the target
  // reflects actual Sunday traffic, not a blend of busy Fridays and slow Tuesdays.
  // Fall back to all worked days if fewer than 2 same-DOW samples exist.
  const targets = {};
  const detail  = {};
  Object.entries(empDays).forEach(function([key, days]) {
    // Same-day-of-week entries
    const sameDowVals = Object.entries(days)
      .filter(([dateStr, v]) => v > 0 && new Date(dateStr + 'T12:00:00').getDay() === todayDow)
      .map(([, v]) => v);

    // Fall back to all worked days if we don't have at least 2 matching samples
    const usedSameDow = sameDowVals.length >= 2;
    const dayVals = usedSameDow
      ? sameDowVals
      : Object.values(days).filter(v => v > 0);

    const rawAvg = dayVals.length ? dayVals.reduce((s, v) => s + v, 0) / dayVals.length : 0;

    // A same-DOW average is already specific to today. An all-days average is NOT:
    // it blends every weekday this person worked, so used raw it hands a Sunday
    // filler the same number as a Saturday one. Scale it onto today's weekday using
    // the store's own shape from this same window. Only the fallback branch is
    // scaled — a target computed from real same-weekday history is left alone.
    const avg    = usedSameDow ? rawAvg : rawAvg * dowFactor;
    const target = dayVals.length === 0 ? fallback : Math.round(avg * 1.025);

    targets[key] = target;
    detail[key]  = {
      basis:        dayVals.length === 0 ? 'fallback'
                                         : (usedSameDow ? 'same-dow' : 'all-days-dow-scaled'),
      daysWorked:   Object.keys(days).length,
      sameDowCount: sameDowVals.length,
      sampleCount:  dayVals.length,
      avgDaily:     Math.round(avg),
      rawAvgDaily:  Math.round(rawAvg),
      dowFactor:    usedSameDow ? 1 : Math.round(dowFactor * 1000) / 1000,
      target:       target,
      days:         days,
    };
  });

  return { targets: targets, detail: detail };
}

function computeEmpTargets_(storeSlug, dailyGoal) {
  const props    = PropertiesService.getScriptProperties();
  const cacheRaw = props.getProperty(GC_EMP_TARGET_CACHE_KEY) || '{}';
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

  const todayDow = pt.dow;   // 0=Sun … 6=Sat
  const fallback = dailyGoal > 0 ? Math.round(dailyGoal / 4) : 0;
  const targets  = empTargetsFromTxns_(txns, todayDow, fallback).targets;

  // Persist: keep entries for other stores/dates in the cache, add ours
  cache[cacheKey] = targets;
  props.setProperty(GC_EMP_TARGET_CACHE_KEY,
    JSON.stringify(pruneEmpTargetCache_(cache, fmtDate_(todayStartMs - 2 * 24 * 60 * 60 * 1000))));

  return targets;
}

/**
 * Read-only explanation of today's per-employee targets for one store. Answers
 * "how was this number set" with the inputs, not just the output — it reuses
 * empTargetsFromTxns_, so it can never drift from what the kiosk actually shows.
 *
 * Deliberately does NOT write the target cache: a diagnostic that mutates the
 * thing it measures is worse than none.
 *
 * @param {string} storeSlug
 * @return {Object}
 */
function diagEmpTargets_(storeSlug, dowOverride) {
  const pt           = ptNow_();
  const today        = pt.dateStr;
  const todayStartMs = ptDateToUtcMs_(today);
  const dailyGoal    = getDailyGoal_(storeSlug);
  const fallback     = dailyGoal > 0 ? Math.round(dailyGoal / 4) : 0;

  let txns = [];
  try {
    txns = fetchStoreTransactions_(
      storeSlug,
      new Date(todayStartMs - 28 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(todayStartMs - 1).toISOString()
    );
  } catch (e) {
    return { ok: false, error: 'fetch failed: ' + e.message, store: storeSlug };
  }

  // dowOverride lets us ask "what would Tuesday's targets be" without waiting for
  // Tuesday — the same-DOW basis means every weekday produces a different table.
  const useDow = (dowOverride === 0 || dowOverride) ? Number(dowOverride) : pt.dow;
  const res  = empTargetsFromTxns_(txns, useDow, fallback);
  const rows = Object.keys(res.detail).map(function(k) {
    const d = res.detail[k];
    return {
      nameKey:      k,
      target:       d.target,
      basis:        d.basis,
      avgDaily:     d.avgDaily,
      daysWorked:   d.daysWorked,
      sameDowCount: d.sameDowCount,
      sampleCount:  d.sampleCount,
      rawAvgDaily:  d.rawAvgDaily,
      dowFactor:    d.dowFactor,
      days:         d.days,
    };
  }).sort(function(a, b) { return b.target - a.target; });

  return {
    ok:        true,
    store:     storeSlug,
    date:      today,
    dow:       useDow,
    dailyGoal: dailyGoal,
    fallback:  fallback,
    txnCount:  txns.length,
    employees: rows,
  };
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
  const tickerFirstNames = Object.create(null);
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

  // Pace & projection — DOW-WEIGHTED so a slow morning doesn't read as "behind." Expected-so-far follows
  // the store's historical hourly sales curve (same shape as the by-hour target notches + Standings pace),
  // NOT linear clock time. Mornings are slow and afternoons busy, so linear time over-expects early and
  // makes a team feel grossly behind when they're actually on track — which demotivates. Falls back to
  // linear time if the hourly curve isn't warm yet.
  const elapsedHours = Math.max(0, Math.min(nowHour + nowMinute / 60 - STORE_OPEN_HOUR, STORE_HOURS));
  const dayFrac      = STORE_HOURS > 0 ? elapsedHours / STORE_HOURS : 0;
  const expectedFrac = isPreOpen ? dayFrac : expectedSalesFrac_(store, nowHour, nowMinute, dayFrac);
  const paceGoal     = dailyGoal * expectedFrac;
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

  // Project EOD revenue on the DOW-weighted curve (sales ÷ expected-fraction-by-now) so a slow morning
  // projects to the real finish, not a linear under-shoot that makes the goal look out of reach. Guard a
  // tiny expectedFrac early in the day (paired with the ≥2h gate) to avoid a wild projection.
  const MIN_PROJ_HOURS = 2;
  const projectedRevenue = (isPreOpen || storeClosed)
    ? agg.sales
    : (elapsedHours >= MIN_PROJ_HOURS && expectedFrac > 0.02)
      ? Math.round(agg.sales / expectedFrac)
      : 0;

  // Hourly bar chart. FREEZE completed hours so a past hour's bar never changes after it ends
  // (bug: "today by hour totals changing after the period passed" — re-aggregating live let late-settling
  // txns / in-place return adjustments shift a finished hour). The first pull after an hour completes
  // snapshots it; later pulls read the snapshot. Only the CURRENT hour stays live; the daily total
  // (agg.sales) still nets returns. Snapshot is per-store-per-day; yesterday's key is pruned on write.
  const _today    = ptNow_().dateStr;
  const _freezeK  = 'GC_HOURFREEZE_' + store.slug + '_' + _today;
  const _props    = getProps_();
  let _frozen = Object.create(null);
  try { _frozen = JSON.parse(_props.getProperty(_freezeK) || '{}'); } catch (e) {}
  let _freezeDirty = false;

  // NEVER FREEZE A ZERO. A failed Dutchie call is indistinguishable from a quiet hour downstream —
  // fetchTxnPagesByKey_ returns [] on a non-200 or a parse error — so an outage made every completed
  // hour read $0, and the freeze locked those zeros in for the rest of the day. That is the "hourly
  // data is missing from when the app was down" bug: the sales were in Dutchie the whole time, but
  // 12p/1p/2p stayed empty on the kiosk long after it recovered.
  //
  // A zero is exactly the value freezing has no reason to protect: the freeze exists so a settled
  // hour's bar can't drift, and $0 has nothing to drift from. If the hour really was empty, deriving
  // it live returns $0 anyway. Treating a stored 0 as "not frozen yet" also HEALS a day already
  // poisoned by an outage — the real number lands on the next poll, no migration needed.
  const dispRev = Object.create(null);
  for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
    const liveRev = Math.round((hourMap[h] || { revenue: 0 }).revenue);
    if (!isPreOpen && h < nowHour) {           // completed hour → serve/lock the frozen value
      if (!(_frozen[h] > 0) && liveRev > 0) { _frozen[h] = liveRev; _freezeDirty = true; }
      dispRev[h] = _frozen[h] > 0 ? _frozen[h] : liveRev;
    } else {
      dispRev[h] = liveRev;                    // current/future/pre-open → live
    }
  }
  if (_freezeDirty) {
    try {
      _props.setProperty(_freezeK, JSON.stringify(_frozen));
      const _y = Utilities.formatDate(new Date(ptDateToUtcMs_(_today) - 12 * 3600000), STORE_TZ, 'yyyy-MM-dd');
      _props.deleteProperty('GC_HOURFREEZE_' + store.slug + '_' + _y);   // prune prior day
    } catch (e) {}
  }

  // When pre-open, all bars are "final" (no current/projected)
  const maxRevenue = Math.max(1, ...Object.keys(dispRev).map(h => dispRev[h]));
  const hourly = [];
  for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
    const lbl = h === 12 ? '12p' : h < 12 ? h + 'a' : (h - 12) + 'p';
    hourly.push({
      hour:      lbl,
      revenue:   dispRev[h] || 0,
      pct:       r1_(((dispRev[h] || 0) / maxRevenue) * 100),
      current:   !isPreOpen && h === nowHour,
      projected: !isPreOpen && h > nowHour,
    });
  }

  // Per-hour targets: scale daily goal by the same-DOW historical shape. Cache-ONLY read so the kiosk
  // NEVER pays the cold multi-fetch (that was the 60s+ load) — the warmer primes the shape going into the
  // day. If the shape isn't warm yet (e.g. right after a deploy), fall back to FLAT targets so the line is
  // never missing and the load stays instant; it fills in with the real curve on the next warm.
  let hourlyTargets = null;
  try {
    const dist = getHourlyDistCached_(store);
    const _nH  = STORE_CLOSE_HOUR - STORE_OPEN_HOUR;
    hourlyTargets = [];
    for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
      hourlyTargets.push(dist ? Math.round(dailyGoal * (dist[h] || 0)) : Math.round(dailyGoal / _nH));
    }
  } catch(e) {
    Logger.log('hourlyTargets error: ' + e);
  }

  // Build shift strip: active employees (have transactions today) + known
  // roster employees who haven't transacted yet (shown as off-shift).
  const _shiftNicks = getNicknames_();
  const activeEmps = Object.values(agg.byEmployee)
    .filter(emp => !gxIsExcluded_(emp))
    .sort((a, b) => b.sales - a.sales)
    .map(emp => ({
      initials:     emp.initials,
      name:         applyNickname_(emp.name, _shiftNicks),  // apply nickname for consistent display
      nameKey:      nameToKey_(emp.name),  // pre-nickname canonical key — frontend uses this for initials + avatar lookup
      status:       'on',
      sales:        emp.sales,
      transactions: emp.transactions || 0,  // stored in EOD snapshot → historical view shows per-employee txns
      note:         null,
    }));

  const activeIds = new Set(
    Object.values(agg.byEmployee).map(e => String(e.id)).filter(Boolean)
  );
  const activeNames = new Set(
    Object.values(agg.byEmployee).map(e => e.name.toLowerCase())
  );

  // Pull in roster employees not yet seen today (apply nicknames so display is consistent).
  //
  // gxBelongsToStore_ gates this list, and ONLY this list. The roster is derived from 30 days of
  // transactions, so anyone who covered a single shift here lingers as an "off shift" ghost card
  // every day after — Drew Phillips (home_store 'corporate') sat on both Portland and River that
  // way. Someone who is not this store's crew is only on this board when they are actually
  // transacting, and a transactor is in activeEmps above, which this gate never touches.
  // The gate fails open when home_store is unknown, so nobody vanishes on a cold lookup.
  const rosterEmps = (getEmployeeRoster_()[store.slug] || [])
    .filter(e => !activeIds.has(String(e.id)) && !activeNames.has(e.name.toLowerCase()) && !gxIsExcluded_(e)
                 && gxBelongsToStore_(e, store))
    .map(e => ({
      initials:     e.initials,
      name:         applyNickname_(e.name, _shiftNicks),
      nameKey:      nameToKey_(e.name),  // pre-nickname canonical key
      status:       'off',
      sales:        0,
      transactions: 0,
      note:         null,
    }));

  const onShift = activeEmps.concat(rosterEmps);

  // Helper: build a ticker item from a transaction
  function makeTicker_(tx) {
    const emp = txEmployee_(tx);
    const displayName = applyNickname_(emp.name, _tickerNicks);
    return {
      who:    disambiguateTicker_(displayName),
      // Stable key so the kiosk can tie a sale to that person's card without name guessing
      whoKey: nameToKey_(emp.name),
      qty:    txItems_(tx),   // distinct SKUs — see txItems_ for cannabis UPT rationale
      price:  txTotal_(tx),
      ts:     tx.transactionDateLocalTime || tx.transactionDate || '',
    };
  }

  // What counts as a "big" sale. Rides in from the client (GC.THRESHOLDS.bigTransactionMin) so there
  // is one source for it; the default only matters to a caller that doesn't send one. Declared up here
  // because BOTH big-sale surfaces below read it — the standing trophy and the 15-minute window list.
  const bigMin = Number(params && params.bigMin) > 0 ? Number(params.bigMin) : 100;

  // Biggest single transaction of the day. The kiosk shows this as a standing "Biggest Sale"
  // trophy, so it has to be the real day's best — the 10-item ticker seed can't tell you that,
  // and a kiosk restarted at 5pm would otherwise crown an afternoon sale.
  //
  // It also has to CLEAR THE BAR. This used to be an unconditional max, so on a slow morning the
  // trophy crowned whatever the day's largest ticket happened to be — a $68 sale wearing "BIGGEST
  // SALE" reads as a joke on the kiosk and devalues the trophy on the day it IS earned. Same floor
  // as the banner/flame treatment (bigMin, the client's GC.THRESHOLDS.bigTransactionMin), so all
  // three big-sale surfaces agree on what counts as big. Below the floor there is simply no trophy.
  function topSaleToday_() {
    let best = null;
    for (let i = 0; i < txns.length; i++) {
      const tx = txns[i];
      if (gxIsExcluded_(txEmployee_(tx))) continue;
      if (txTotal_(tx) < bigMin) continue;
      if (!best || txTotal_(tx) > best.price) best = makeTicker_(tx);
    }
    return best;
  }
  const topSale = isPreOpen ? null : topSaleToday_();

  // Big sales still inside the kiosk's reward window. The kiosk paints its big-sale treatment
  // from the SALE'S timestamp rather than from when the event happened to arrive, so a reload —
  // or a slideshow rotation coming back around — restores the banner and the seller's flame with
  // the right time left on them. Uses the same bigMin floor as the trophy above.
  const BIG_SALE_WINDOW_MIN = 15;
  function recentBigSales_() {
    // Transaction stamps are local-time strings, so build the cutoff as the same kind of string
    // and compare lexicographically — the same trick the sinceTs cursor uses.
    const cutMs = Utilities.formatDate(
      new Date(Date.now() - BIG_SALE_WINDOW_MIN * 60 * 1000), STORE_TZ, "yyyy-MM-dd'T'HH:mm:ss");
    const out = [];
    for (let i = txns.length - 1; i >= 0 && out.length < 10; i--) {
      const tx = txns[i];
      const ts = tx.transactionDateLocalTime || tx.transactionDate || '';
      if (ts < cutMs) break;                       // txns are chronological — nothing older qualifies
      if (txTotal_(tx) < bigMin) continue;
      if (gxIsExcluded_(txEmployee_(tx))) continue;
      out.push(makeTicker_(tx));
    }
    return out;                                    // newest first
  }
  const bigSales = isPreOpen ? [] : recentBigSales_();

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
      .filter(tx => !gxIsExcluded_(txEmployee_(tx)))
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
      topSale:           topSale,
      bigSales:          bigSales,
    };
  }

  // Full response: ticker seed = last 10 transactions newest-first (exclude excluded employees)
  const recentTxns = txns.slice().reverse()
    .filter(tx => !gxIsExcluded_(txEmployee_(tx)))
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
    // The DOW-weighted position the pace VALUE above is measured against, plus the curve
    // it came from. The client needs the shape, not just the number: it redraws the pace
    // marker every render so the line glides, and it cannot do that from a value that is
    // up to 5 minutes stale. Without these the marker falls back to linear clock time --
    // which is what made the gauge disagree with its own pace percentage.
    expectedFrac:       r3_(expectedFrac),
    hourShape:          getHourlyDistCached_(store) || null,
    transactions:       agg.transactions,
    avgOrderValue:      agg.avgOrderValue,
    avgUPT:             agg.avgUPT,
    totalDiscounts:     agg.totalDiscounts,
    discountRate:       agg.discountRate,
    onShift:            onShift,
    hourly:             hourly,
    hourlyTargets:      hourlyTargets,
    ticker:             ticker,
    topSale:            topSale,
    bigSales:           bigSales,
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

  // Drop anyone GX Core says is gone BEFORE ranking, so the ranks read 1..n over people who are
  // actually here. This list feeds the kiosk's ranked staff grid and was the one current-period
  // surface with no status filter at all -- a retired budtender still active in Dutchie ranked
  // normally on it. Store crew is deliberately NOT filtered here: a covering budtender's sales are
  // this store's sales today and belong on today's board. Only the weekly trophies are gated on
  // whose store it is -- see getStoreBadges.
  const empList = Object.values(agg.byEmployee)
    .filter(emp => !gxIsExcluded_(emp))
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
  const runningTotals = Object.create(null);
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

  // SPIFF sell-through for this store's crew, joined on the Dutchie employee id that both
  // sides already carry. Wrapped: SPIFF is a separate app and this is the all-staff kiosk —
  // if it is down, cards render without a SPIFF row rather than not rendering at all.
  let _spiff = { ok: false, byId: {} };
  try { _spiff = spiffForStore_(store); } catch (e) { Logger.log('spiffForStore_ failed: ' + e); }

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
      // null when SPIFF has no row for this person — which is NOT the same as a row at zero.
      // Someone at 0 of 5 still gets a card row; only "no program at all" is absent.
      spiff:         _spiff.byId[String(emp.id || '')] || null,
      note:          null,
    };
  });

  // Build onShift roster: employees active today (on) + roster-only employees (off)
  // Mirrors the same logic in getStoreToday so _onShift stays fresh on lb refresh.
  const activeNames  = new Set(empList.map(e => e.name.toLowerCase()));
  const onShiftActive = empList.map(emp => ({
    initials: emp.initials,
    name:     applyNickname_(emp.name, _storeNicknames),
    nameKey:  nameToKey_(emp.name),   // pre-nickname key for avatar config lookup
    status:   'on',
    sales:    emp.sales,
    note:     null,
  }));
  // Same store-crew gate as getStoreToday — see the note there. Both have to apply it or the
  // 5-minute leaderboard refresh would put the ghost cards straight back on the board.
  const onShiftRoster = (getEmployeeRoster_()[store.slug] || [])
    .filter(e => !activeNames.has(e.name.toLowerCase()) && !gxIsExcluded_(e)
                 && gxBelongsToStore_(e, store))
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

  // Who can hold one of THIS store's trophies. Three gates, in order:
  //   1. at least 3 transactions this week -- a single shift should not win an average
  //   2. GX Core does not say they are gone (retired / merged / deleted)
  //   3. this is their store, per Crew's home_store
  // Gate 3 is the Zach B fix: he is Baseline's and was appearing on Center's "This Week's Trophies"
  // because badges were awarded purely on who rang transactions here, with no notion of whose crew
  // they are. His sales at Center still count toward Center's revenue and still show on today's
  // board -- he just does not carry Center's award. gxBelongsToStore_ fails open, so a person GX
  // Core has no home_store for, or a cold store registry, leaves this exactly as it was.
  const emps = Object.values(agg.byEmployee)
    .filter(e => e.transactions >= 3)
    .filter(e => !gxIsExcluded_(e))
    .filter(e => gxBelongsToStore_(e, store));

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
  /* No prototype, and this one is the most reachable in the app. It looks up rawConfigs by an
     EMPLOYEE-DERIVED key and, failing that, by each underscore-separated SEGMENT of that key — so a
     name segment of "constructor" or "__proto__" returns the inherited member and a FUNCTION lands
     where an avatar config JSON string belongs. The segment loop is what widens it: a whole key would
     have to match, a segment only has to appear. Same class pricecards found in their counters and
     spiff found dropping budtenders out of a merge entirely. */
  var resolved = Object.create(null);
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
/**
 * Avatar configs, keyed by nameKey. GX Core only — Crew and #/avatar are both EDITORS of it.
 *
 * The local GC_AVATAR_CONFIGS_JSON fallback is gone. It made the migration lossless, but a value
 * that lived only here could not be removed from Crew: clearing it there just let the local copy
 * resurface, because "Core has nothing" and "Core has not been told" looked identical. The two
 * local-only avatars (Zachary Rodriguez, Tyson Farris) were backfilled into Core first.
 *
 * A `seed` is stamped INTO avatar_config, pinned to employee_number, so a rename cannot regenerate a
 * different face. Crew used to do that stamping and this app did not, which is why it now happens in
 * GXCore.setAvatar for every writer (Core v225). Pass the config through untouched so it is honored.
 */
function getAvatarConfigs_() {
  var out = Object.create(null);
  try {
    var recs = gxAllRecs_();
    Object.keys(recs).forEach(function (k) {
      if (recs[k].avatarConfig) out[k] = recs[k].avatarConfig;
    });
  } catch (e) { gxRosterWarn_(e); }
  return out;
}

/**
 * Save one employee's avatar config.
 * Expects params.nameKey (string) and params.config (JSON string of avatar config object).
 */
function saveAvatarConfig_(params) {
  if (!params.nameKey) return { ok: false, error: 'nameKey required' };
  var configStr = params.config;
  if (!configStr) return { ok: false, error: 'config required' };
  try { JSON.parse(configStr); } catch(e) {
    return { ok: false, error: 'Invalid config JSON: ' + e.message };
  }
  // Writes to GX CORE, not to a local copy. #/avatar is a second EDITOR (staff build their own
  // face; Crew can also set one) but there must only be one STORE — and, since Core v225, one WRITE:
  // GXCore.setAvatar. Writing locally is what let an avatar exist here and not in Crew, where it
  // then could not be changed or removed.
  return gxWriteAvatarToCore_(params.nameKey, configStr);
}

/**
 * Remove one employee's avatar config so they revert to showing initials.
 * Deletes every key that matches any segment of params.nameKey (handles the
 * first-name-only key mismatch between kiosk and roster).
 */
function clearAvatarConfig_(params) {
  if (!params.nameKey) return { ok: false, error: 'nameKey required' };
  // The old version also deleted single-segment variants ("sunshine" from "maria_sunshine") because
  // the local map had accumulated duplicate keys for one person. Keying on employee_id removes the
  // whole problem: there is exactly one row to clear.
  return gxWriteAvatarToCore_(params.nameKey, '');
}

/**
 * Write (or clear) one employee's avatar in GX Core, resolved from this app's nameKey.
 *
 * THE WRITE ITSELF IS NOT OURS ANY MORE. avatar_config lives on the GX Core employees row, and it
 * was being written from two apps — Crew and here — each wrapping gxUpsertEmployee in its own
 * read-merge-write. Same row, same field, two implementations that did not agree: Crew's pinned the
 * avatar seed to employee_number, retried lock contention and verified that a clear actually landed;
 * this one did none of those. Which behavior a staff member got depended on which app they happened
 * to be standing in front of. GXCore.setAvatar is that logic once, in the app that owns the row
 * (Core v225). Ownership is by LAYER: gx-theme renders, GX Core writes, Crew manages staff, and this
 * app keeps the kiosk entry point staff actually reach — #/avatar is not going away, and who may
 * edit whose avatar stays our decision.
 *
 * WHY THIS NO LONGER BUILDS A COMPLETE ROW. It used to, deliberately: a partial
 * {employee_id, avatar_config} under an old pin (patch-by-default only landed in Core v139, and this
 * app pinned v128 on 2026-08-20) ran the older build-from-scratch path, and gxWrite_ rebuilt every
 * column from those two keys — which is how a live employee record lost its name, home store, role,
 * Dutchie id and employee number in one avatar save that day. That reasoning was correct and is now
 * handled inside the library: setAvatar patches through gxUpsertEmployee, which treats '' as "leave
 * this column alone", and a removal passes clear='avatar_config' and then re-reads to confirm the
 * field is empty. The defense moved; it was not dropped. The pin still matters — setAvatar does not
 * exist before v225 — so re-pin AND deploy before assuming this call resolves.
 */
function gxWriteAvatarToCore_(nameKey, configStr) {
  var rec = (gxRoster_().byKey || {})[nameKey];
  if (!rec || !rec.employeeId) {
    return { ok: false, error: 'No GX Core employee matches "' + nameKey + '". Avatars are stored ' +
             'on the employee record now; ask Crew to add this person to the roster.' };
  }
  var r;
  try {
    // employee_id, not the nameKey: setAvatar accepts either, but our roster already resolved this
    // person on the Dutchie id join, which a name match cannot get wrong. '' clears — setAvatar owns
    // the clear= mechanics and the verification, so do not special-case it here.
    r = GXCore.setAvatar(rec.employeeId, configStr || '', 'performance');
  } catch (e) {
    return { ok: false, error: 'GX Core write failed: ' + (e && e.message || e) };
  }
  if (!r || r.ok !== true) {
    return { ok: false, error: (r && r.error) || 'GX Core rejected the write',
             retryable: !!(r && r.retryable) };
  }
  gxRosterBust_();          // the roster cache, so the next read sees the new value
  gxBustDisplayCaches_();   // and the rendered staff lists, so the face changes on the next load
  Logger.log('[avatar] ' + (configStr ? 'saved' : 'cleared') + ' in GX Core for ' +
             rec.fullName + ' (' + rec.employeeId + ')');
  return { ok: true, nameKey: nameKey, employee_id: r.employee_id || rec.employeeId,
           name: r.name, seed: r.seed, cleared: !!r.cleared };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Period Standings — manager-facing, all stores vs current-PP goal.
//  The live, self-serve version of the standings Mike broadcasts a few times per
//  period. NO bonus figures. Cheap by design: completed-day sales come from the
//  EOD_Snapshots sheet (one read), and only TODAY is pulled fresh from Dutchie.
//  Pace/projection is computed client-side from elapsedFrac.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Which source served the settled portion of the last standings computation, and when.
 * Public-readable via action=libversion — no sales figures, just the connector name, a row count
 * and a timestamp.
 *
 * WRITES ONLY ON CHANGE. Kiosks poll standings continuously; an unconditional
 * PropertiesService.setProperty here would burn the daily write quota and slow every call. In steady
 * state this costs one read and no write.
 */
function recordStandingsSource_(source, rowCount) {
  try {
    var props = getProps_();
    var prev  = props.getProperty('GC_STANDINGS_SOURCE') || '';
    var stamp = source + '@' + new Date().toISOString() + '#' + (rowCount || 0);
    // Compare the source and row count, ignoring the timestamp — otherwise every call is a "change".
    if (prev.split('@')[0] === source && prev.split('#')[1] === String(rowCount || 0)) return;
    props.setProperty('GC_STANDINGS_SOURCE', stamp);
  } catch (e) {}
}
function getStandingsSource_() {
  try { return getProps_().getProperty('GC_STANDINGS_SOURCE') || ''; } catch (e) { return ''; }
}

function getStandings_(hardRefresh) {
  var cache  = CacheService.getScriptCache();
  if (!hardRefresh) {
    var cached = cache.get('gc_standings_v1');
    if (cached) { try { return JSON.parse(cached); } catch (e) {} }
  }

  var props     = getProps_();
  var pp        = currentPPStart_(props);
  var ppStartMs = pp.ppStartMs, PP_MS = pp.PP_MS;   // PP_MS: duration only, see linearFrac below
  var DAY_MS    = 86400000;
  var nowMs     = Date.now();

  var ppStartStr = pp.ppStartStr;
  var ppEndStr   = pp.ppEndStr;
  var todayStr   = Utilities.formatDate(new Date(nowMs),                 STORE_TZ, 'yyyy-MM-dd');
  var daysTotal  = PP_DAYS;
  // Which day of the period today is — counted in PT CALENDAR days. Dividing elapsed ms by DAY_MS
  // is an hour out for the rest of any period containing a DST change, which flips this to the
  // wrong day for the hour either side of midnight.
  var dayNum     = Math.max(1, Math.min(daysTotal,
                     Math.round((ptDateToUtcMs_(todayStr) - ptDateToUtcMs_(ppStartStr)) / DAY_MS) + 1));

  // Per-store PP sales. SETTLED days (ppStart..yesterday) come from GX Core's shared sales cache
  // (closing-report net = Dutchie EOD to the penny). TODAY is not in the cache until it settles overnight,
  // so pull only today live. Falls back to the whole-settled-range Dutchie pull if the cache is momentarily
  // unavailable, so standings never breaks.
  // (Re-migrated to getSalesDaily 2026-08-13 after core-admin hardened the nightly refresh — retry +
  //  self-heal + alert-on-partial, GX Core @83 — and re-audited 0 stale over 30 days. The ~11% drift in
  //  Aug was stale trailing days, now fixed. The nightly eodGuardCheck_ tripwire watches for any recurrence.)
  var todayStartMs = ptDateToUtcMs_(todayStr);
  var yestStr      = Utilities.formatDate(new Date(todayStartMs - 12 * 3600000), STORE_TZ, 'yyyy-MM-dd');

  var ppSales = Object.create(null);
  STORES.forEach(function(s) { ppSales[s.slug] = 0; });

  // Settled portion — GX Core cache, with a Dutchie fallback.
  if (ppStartStr <= yestStr) {
    var usedCache = false;
    try {
      var id2slug = gxStoreIdToAppSlug_();
      var rows = GXCore.getSalesDaily('', ppStartStr, yestStr) || [];
      if (rows.length) {
        rows.forEach(function(r) {
          var slug = id2slug[String(r.store)] || String(r.store);
          // ppSales is Object.create(null) (line above), so it has NO hasOwnProperty — calling it
          // as a method threw TypeError on the first row, the bare catch below swallowed it, and
          // usedCache stayed false. The GX Core cache branch has therefore never once succeeded;
          // every pay-period figure came from the Dutchie fallback. Numbers were right, the cache
          // was dead weight. Same safe idiom as own_() in auth.gs.
          if (Object.prototype.hasOwnProperty.call(ppSales, slug)) ppSales[slug] += Number(r.net || 0);
        });
        usedCache = true;
      }
    } catch (e) {}
    // Record WHICH source actually served this, the way Sales' gxpin reports qb.last_source. Before
    // this, "the cache is working" was unfalsifiable from outside: standings is auth-gated, the
    // fallback produces the same numbers, and the failure was a swallowed TypeError. That is exactly
    // how this branch ran zero times for its entire life without anyone noticing.
    recordStandingsSource_(usedCache ? 'gxcore' : 'dutchie', usedCache ? rows.length : 0);
    if (!usedCache) {   // cache down → fallback: settled days from Dutchie
      try {
        var settledRange = { fromUTC: new Date(ppStartMs).toISOString(), toUTC: new Date(todayStartMs - 1).toISOString() };
        var settledAgg   = byStoreAggCached_(settledRange, hardRefresh);
        STORES.forEach(function(s) { ppSales[s.slug] += (settledAgg[s.slug] || {}).sales || 0; });
      } catch (e) {}
    }
  }

  // Today (live) — the cache has no today row.
  try {
    var todayRange = { fromUTC: new Date(todayStartMs).toISOString(), toUTC: new Date(Math.min(nowMs, todayStartMs + DAY_MS - 1)).toISOString() };
    var todayAgg   = byStoreAggCached_(todayRange, hardRefresh);
    STORES.forEach(function(s) { ppSales[s.slug] += (todayAgg[s.slug] || {}).sales || 0; });
  } catch (e) {}

  // Day-of-week weighted "expected by now" — a Monday is not a Friday. Uses each
  // store's dowAvg curve (0=Sun..6=Sat) rather than a flat goal/14, so the pace
  // line tracks the real sales shape of the days that have actually elapsed.
  var DOW = [], elapsedFull = [], todayIdx = -1;
  for (var i = 0; i < daysTotal; i++) {
    var noonMs = ppStartMs + i * DAY_MS + 12 * 3600000;   // noon dodges DST edges
    var dStr   = Utilities.formatDate(new Date(noonMs), STORE_TZ, 'yyyy-MM-dd');
    var u      = parseInt(Utilities.formatDate(new Date(noonMs), STORE_TZ, 'u'), 10); // 1=Mon..7=Sun
    DOW.push(u % 7);                    // 7(Sun)->0, 1..6 -> Mon..Sat
    elapsedFull.push(dStr < todayStr);
    if (dStr === todayStr) todayIdx = i;
  }
  var ptn        = ptHourNow_();
  var elapsedHrs = Math.max(0, Math.min((ptn.hour + ptn.minute / 60) - STORE_OPEN_HOUR, STORE_HOURS));
  var intraday   = STORE_HOURS > 0 ? elapsedHrs / STORE_HOURS : 0;
  function expectedParts(dowAvg) {
    if (!dowAvg) return null;
    var total = 0, soFar = 0;
    for (var j = 0; j < daysTotal; j++) {
      var w = Number(dowAvg[DOW[j]]) || 0;
      total += w;
      if (elapsedFull[j])      soFar += w;                 // fully completed day
      else if (j === todayIdx) soFar += w * intraday;      // today, so far
    }
    return { soFar: soFar, total: total };
  }
  var linearFrac = Math.max(0, Math.min(1, (nowMs - ppStartMs) / PP_MS)); // fallback

  var users = {};
  try { users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}'); } catch (e) {}
  var chainTarget = 0, chainSales = 0, chainSoFar = 0, chainTotal = 0;
  var stores = STORES.map(function(store) {
    var sales = ppSales[store.slug] || 0;
    var res = null;
    try { res = resolveGoal_(store.slug); } catch (e) {}
    var target = res ? (res.effectivePP || 0) : 0;
    var parts  = res && res.g ? expectedParts(res.g.dowAvg) : null;
    var ef     = (parts && parts.total > 0) ? parts.soFar / parts.total : linearFrac;
    if (parts) { chainSoFar += parts.soFar; chainTotal += parts.total; }
    var mgr = Object.values(users).find(function(u) {
      return u.storeSlug === store.slug && u.role === 'store_manager';
    }) || {};
    chainTarget += target; chainSales += sales;
    return {
      slug:         store.slug,
      name:         store.name,
      mgrName:      mgr.displayName || '',
      target:       Math.round(target),
      sales:        Math.round(sales),
      expectedFrac: r3_(ef),
      hourShape:    getHourlyDistCached_(store) || null,
    };
  });
  var chainEf = chainTotal > 0 ? chainSoFar / chainTotal : linearFrac;

  var out = {
    ok: true,
    payPeriod: { start: ppStartStr, end: ppEndStr, dayNum: dayNum, daysTotal: daysTotal },
    chain:     { target: Math.round(chainTarget), sales: Math.round(chainSales), expectedFrac: r3_(chainEf) },
    stores:    stores,
  };
  try { cache.put('gc_standings_v1', JSON.stringify(out), 90); } catch (e) {}
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Incentive Dashboard (bonus calculation) — owner + Mike only.
//  Mirrors the Google Sheet "Green Cross Incentive Program". The bonus MATH is
//  done client-side (live edits); this endpoint just assembles the raw inputs:
//  per-staff PP performance, per-store aggregates + official goal, saved manual
//  inputs (attendance / SPIFF), and the editable thresholds.
// ─────────────────────────────────────────────────────────────────────────────

/** Default (editable) bonus thresholds. Amounts in $, discounts/AOV as shown. */
function incentiveDefaults_() {
  return {
    hoursPerPeriod: 80,
    budtender: {
      txnQualify: 200,               // min transactions to qualify for perf bonuses
      txnQualifyLowVol: 150,         // lower bar for low-volume stores
      lowVolStores: ['center', 'portland'],
      aovTarget: 33, aovBonus: 25,   // +$ if qualified & AOV ≥ target
      discountMaxPct: 1.5, discountBonus: 25, // +$ if qualified & discretionary discount ≤ max% (loyalty/promos already excluded)
      attendanceBonus: 15,           // +$ if 100% attendance
    },
    manager: {
      salesTiers: [ { pct: 110, bonus: 300 }, { pct: 105, bonus: 200 }, { pct: 100, bonus: 100 } ],
      discountTiers: [ { maxPct: 1.5, bonus: 100 }, { maxPct: 2.0, bonus: 50 } ],
      aovTarget: 33, aovBonus: 50,
      teamAttendancePerHead: 25,      // +$ per team member with 100% attendance
    },
    admin: {
      tiers: [ { pct: 110, bonus: 600 }, { pct: 105, bonus: 450 }, { pct: 100, bonus: 300 } ],
      maxPerStore: 50,                // cap = #stores × this
    },
  };
}

/* GX CORE HOLDS THE THRESHOLDS NOW (kv `incentiveThresholds`), because they are not Leaderboard's.
 * GX Crew owns compensation and edits them there; this app still READS them, both for the incentive
 * payload and — the part that is easy to miss — for the kiosk's discount coloring, which takes its
 * target from budtender.discountMaxPct. Two copies of that number means the board grades staff
 * against a goal nobody set on it.
 *
 * Cached for the execution: getKv is a sheet read, and the discount path asks for this per store.
 * The cache is CLEARED AT THE TOP OF doGet, and that is not optional — Apps Script reuses a warm
 * instance across requests, so a module-level global outlives the request that filled it. Without
 * the reset, changing a threshold in GX Core appeared to do nothing for minutes at a time: the
 * write landed, the sheet held the new value, and this app kept serving the old one. Caught by
 * setting aovTarget to 34 and watching it keep reporting 33.
 *
 * Falls back to the local ScriptProperty and then to the built-in defaults. That order matters —
 * if GX Core is unreachable this app must keep scoring exactly as it did rather than silently
 * reverting everyone to defaults, which would repaint the whole board and change the incentive. */
var _incThreshCache_ = null;
function getIncentiveThresholds_() {
  if (_incThreshCache_) return _incThreshCache_;
  var ok = function (t) { return t && t.budtender && t.manager && t.admin; };
  try {
    var fromCore = JSON.parse(GXCore.getKv('incentiveThresholds') || 'null');
    if (ok(fromCore)) { _incThreshCache_ = fromCore; return fromCore; }
  } catch (e) {}
  try {
    var saved = JSON.parse(getProps_().getProperty(GC_INCENTIVE_THRESH_KEY) || 'null');
    if (ok(saved)) { _incThreshCache_ = saved; return saved; }
  } catch(e) {}
  _incThreshCache_ = incentiveDefaults_();
  return _incThreshCache_;
}

/** Access gate: username allowlist (sky + Mike — both are 'director' role, so role check won't distinguish them). */
function incentiveAccessOk_(auth) {
  if (!auth || !auth.ok || !auth.user) return false;
  var u = String(auth.user).toLowerCase();
  return u === 'sky' || u === 'mike';
}

/**
 * Assemble the incentive dashboard payload. Defaults to the current pay period;
 * pass a 'YYYY-MM-DD' ppStart to view a past period (for comparison vs Dutchie
 * reports, or history). Also returns the list of selectable periods.
 */
function getIncentiveData_(ppStartParam, forceRefresh) {
  var props = getProps_();
  var cur   = currentPPStart_(props);

  var selMs = ppStartParam ? ptDateToUtcMs_(ppStartParam) : cur.ppStartMs;
  var ppStartStr = Utilities.formatDate(new Date(selMs), STORE_TZ, 'yyyy-MM-dd');
  var ppEndStr   = Utilities.formatDate(new Date(ppEndMs_(selMs)), STORE_TZ, 'yyyy-MM-dd');
  var isCurrent  = selMs === cur.ppStartMs;

  // Selectable periods: current + last 8 completed.
  var periods = [];
  for (var pi = 0; pi <= 8; pi++) {
    var ms = ppShift_(cur.ppStartMs, -pi);
    periods.push({
      start:   Utilities.formatDate(new Date(ms), STORE_TZ, 'yyyy-MM-dd'),
      end:     Utilities.formatDate(new Date(ppEndMs_(ms)), STORE_TZ, 'yyyy-MM-dd'),
      current: pi === 0,
    });
  }

  // ── Performance data (the expensive fetch + aggregation) ──
  // A completed period is FROZEN: computed once (first view after it closes),
  // cached permanently, and NEVER recomputed — these numbers paid people, so a
  // hard-refresh must never change them. forceRefresh is ignored for completed
  // periods; only the CURRENT (open, still-settling) period is fetched live.
  var perfKey = 'GC_INC_PERF_v2_' + ppStartStr;   // v2: full-store aggregation (includes managers/excluded sellers)
  var perf = null, fromCache = false;
  if (!isCurrent) {
    try { var c = props.getProperty(perfKey); if (c) { perf = JSON.parse(c); fromCache = true; } } catch(e) {}
  }
  if (!perf) {
    perf = computeIncentivePerf_(props, selMs);
    if (!isCurrent) { try { props.setProperty(perfKey, JSON.stringify(perf)); } catch(e) {} }
  }

  // ── Overlay the mutable bits fresh: goal target, saved inputs, thresholds ──
  var managers = [], adminTarget = 0;
  STORES.forEach(function(store) {
    var slug = store.slug;
    var st = perf.stores[slug] || { sales: 0, discount: 0, aov: 0, mgrName: '', mgrKey: '' };
    // As-of target: a COMPLETED period reads its frozen goal (the one that paid people); only the
    // current open period resolves live. Fixes past-period re-scoring at rollover (Sales note_msxk1v0i).
    var goal = 0;
    try { goal = asOfPeriodGoal_(slug, ppStartStr, isCurrent); } catch(e) {}
    managers.push({
      name: st.mgrName, nameKey: st.mgrKey || nameToKey_(st.mgrName),
      storeSlug: slug, storeName: store.name,
      target: goal, sales: st.sales, discount: st.discount, aov: st.aov,
    });
    adminTarget += goal;
  });

  var allInputs = Object.create(null);
  try { allInputs = JSON.parse(props.getProperty(GC_INCENTIVE_INPUTS_KEY) || '{}'); } catch(e) {}

  return {
    ok: true,
    payPeriod: { start: ppStartStr, end: ppEndStr, current: isCurrent, cached: fromCache },
    periods:    periods,
    admin:      { name: perf.adminName, target: r2_(adminTarget), actual: perf.adminActual, stores: STORES.length },
    managers:   managers,
    budtenders: perf.budtenders,
    saved:      allInputs[ppStartStr] || {},   // { nameKey: { att, spiff } }
    thresholds: getIncentiveThresholds_(),
  };
}

/**
 * The cacheable performance slice: fetch the PP window and derive per-budtender
 * stats + per-store team aggregates + admin actual. No goal/target/inputs here —
 * those are overlaid fresh so a cached completed period still reflects the current
 * goal and edited attendance/SPIFF.
 */
function computeIncentivePerf_(props, selMs) {
  // End derived from selMs's own next-period start: a period containing a DST change is 14
  // calendar days but not 14 * 24h, so a nominal length would clip or overrun it by an hour.
  var range   = { fromUTC: new Date(selMs).toISOString(), toUTC: new Date(ppEndMs_(selMs)).toISOString() };
  var byStore = fetchAllStoresTransactions_(range);
  var roles   = getRoles_();
  var users   = {};
  try { users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}'); } catch(e) {}

  // Classify: management (owner/director) is skipped; store managers are counted
  // in the store total but shown as the manager row (not a budtender). NOTE: we
  // intentionally do NOT apply the leaderboard exclusion (getExcluded_) — the
  // incentive must include every seller (incl. managers) to match Dutchie's raw
  // leader report, which is what the sheet used.
  var mgmtKeys = {}, adminName = 'Mike Kettler', storeMgrName = {}, storeMgrKey = {};
  Object.keys(users).forEach(function(uname) {
    var u = users[uname] || {};
    if (u.role === 'owner' || u.role === 'director') {
      mgmtKeys[nameToKey_(u.displayName || uname)] = true;
      if (String(uname).toLowerCase() === 'mike' || /(^|\s)mike\b/i.test(u.displayName || '')) adminName = u.displayName || 'Mike';
    }
    if (u.role === 'store_manager' && u.storeSlug) {
      storeMgrName[u.storeSlug] = u.displayName || uname;
      storeMgrKey[u.storeSlug]  = nameToKey_(u.displayName || uname);
    }
  });

  function mean(arr) { return arr.length ? arr.reduce(function(a, b) { return a + b; }, 0) / arr.length : 0; }

  var budtenders = [], stores = {}, adminActual = 0;
  STORES.forEach(function(store) {
    var slug = store.slug;
    var agg  = aggregateTransactions_(byStore[slug] || []);   // every seller who rang — no exclusion
    var mgrKey = storeMgrKey[slug] || '', mgrName = storeMgrName[slug] || '';
    var storeSales = 0, dList = [], aList = [];
    Object.keys(agg.byEmployee).forEach(function(k) {
      var emp = agg.byEmployee[k];
      var nk  = nameToKey_(emp.name);
      storeSales += emp.sales || 0;                            // store total incl. the manager's own sales
      var isMgr = (mgrKey && nk === mgrKey) || roles[nk] === 'store_manager';
      if (isMgr) { if (!mgrKey) mgrKey = nk; if (!mgrName) mgrName = emp.name; return; }
      if (mgmtKeys[nk]) return;
      var aov  = emp.transactions > 0 ? emp.sales / emp.transactions : 0;
      // Budtender-controlled discount only: excludes loyalty redemptions,
      // automatic promos, and any discretionary discount toggled off (discounts.gs).
      var disc = emp.subtotal     > 0 ? emp.discountsBdt / emp.subtotal : 0;
      budtenders.push({
        name: emp.name, nameKey: nk, storeSlug: slug, storeName: store.name,
        txn: emp.transactions || 0, sales: r2_(emp.sales), discount: disc, aov: aov,
      });
      dList.push(disc); aList.push(aov);       // store avg = budtenders only (matches the sheet's AVERAGEIF)
    });
    stores[slug] = {
      sales: r2_(storeSales), discount: mean(dList), aov: mean(aList),
      mgrName: mgrName, mgrKey: mgrKey || nameToKey_(mgrName),
    };
    adminActual += storeSales;
  });

  return { adminName: adminName, adminActual: r2_(adminActual), stores: stores, budtenders: budtenders };
}

/**
 * Persist incentive manual inputs (attendance/SPIFF) for a pay period, and/or the
 * editable thresholds. params.ppStart, params.inputs (JSON {nameKey:{att,spiff}}),
 * params.thresholds (JSON).
 */
function saveIncentiveInputs_(params) {
  var props = getProps_();
  if (params.inputs && params.ppStart) {
    var all = Object.create(null);
    try { all = JSON.parse(props.getProperty(GC_INCENTIVE_INPUTS_KEY) || '{}'); } catch(e) {}
    var incoming = {};
    try { incoming = JSON.parse(params.inputs); } catch(e) { return { ok: false, error: 'bad inputs' }; }
    all[params.ppStart] = incoming;
    props.setProperty(GC_INCENTIVE_INPUTS_KEY, JSON.stringify(all));
  }
  if (params.thresholds) {
    try {
      var t = JSON.parse(params.thresholds);
      if (t && t.budtender && t.manager && t.admin) props.setProperty(GC_INCENTIVE_THRESH_KEY, JSON.stringify(t));
    } catch(e) { return { ok: false, error: 'bad thresholds' }; }
  }
  return { ok: true };
}
