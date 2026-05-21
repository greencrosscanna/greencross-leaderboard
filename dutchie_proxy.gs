// ============================================================
//  Green Cross — Sales Performance Dashboard
//  Google Apps Script Backend (dutchie_proxy.gs)
//
//  Deploy as: Execute as: User deploying the web app
//             Access: Anyone (uses our own HMAC session auth)
//
//  Phase 1 (complete): auth endpoints + static fixture data
//  Phase 2 (current):  real Dutchie API data endpoints wired
//
//  Setup checklist (run from Script Editor, not HTTP):
//    1. setUserPassword_('sky', 'gcadmin', 'director', null, 'Sky Pinnick', 'SP')
//    2. setUserPassword_('sofia', 'gc123', 'store_manager', 'baseline', 'Sofia Alvarez', 'SA')
//       ... repeat for each store manager
//    3. setStorePlans_({ baseline: { monthly: 255000, daily: 8500 }, ... })
//    4. Store Dutchie keys: Script Properties → DUTCHIE_STORE_KEYS_JSON
//       {"Baseline":"key...","Center":"key...","Century":"key...","Commercial":"key...","Portland Rd":"key...","River Rd":"key..."}
//    5. Deploy as web app → copy URL → set GC.api.GAS_URL in api.js
//    6. Set GC.api.USE_FIXTURES = false in api.js
// ============================================================

// ── Constants ─────────────────────────────────────────────────
const GC_USERS_KEY          = 'gc_perf_users';
const GC_SESSION_SECRET_KEY = 'GC_PERF_SESSION_SECRET';
const GC_SESSION_TTL_MS     = 7 * 24 * 60 * 60 * 1000;
const GC_STORE_PLANS_KEY    = 'GC_STORE_PLANS_JSON';
const GC_STREAKS_KEY        = 'GC_STREAKS_JSON';
const DUTCHIE_BASE          = 'https://api.pos.dutchie.com';

// Portland, OR: UTC-7 (PDT Apr–Oct) / UTC-8 (PST Nov–Mar)
// Update STORE_TZ_OFFSET_MS in November.
const STORE_TZ_OFFSET_MS = 7 * 60 * 60 * 1000; // PDT

// Store open/close hours (local time, 24-hour)
const STORE_OPEN_HOUR  = 9;
const STORE_CLOSE_HOUR = 22; // 10 pm
const STORE_HOURS      = STORE_CLOSE_HOUR - STORE_OPEN_HOUR; // 13

// Discount flag threshold
const DISCOUNT_FLAG_THRESHOLD  = 0.065;
const DISCOUNT_WATCH_THRESHOLD = 0.080;

// Canonical store list — slugs must match src/fixtures/ filenames
// and the frontend GC.STORES registry in utils.js
const STORES = [
  { slug: 'baseline',   name: 'Baseline',   dutchieName: 'Baseline' },
  { slug: 'center',     name: 'Center',     dutchieName: 'Center' },
  { slug: 'century',    name: 'Century',    dutchieName: 'Century' },
  { slug: 'commercial', name: 'Commercial', dutchieName: 'Commercial' },
  { slug: 'portland',   name: 'Portland',   dutchieName: 'Portland Rd' },
  { slug: 'river',      name: 'River',      dutchieName: 'River Rd' },
];

// ── Router ────────────────────────────────────────────────────
function doGet(e) {
  const params = e.parameter || {};

  // Serve the frontend when no action
  if (!params.action) {
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('Green Cross — Performance')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  try {
    // ── Public: auth ──────────────────────────────────────
    if (params.action === 'login') {
      return jsonOut(loginUser(params), params.callback);
    }
    if (params.action === 'ping') {
      return jsonOut({ ok: true, ts: new Date().toISOString() }, params.callback);
    }

    // ── Auth required from here ────────────────────────────
    const auth = requireAuth_(params);
    if (!auth.ok) return jsonOut(auth, params.callback);

    // ── Director endpoints ─────────────────────────────────
    if (params.action === 'directorsummary') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getDirectorSummary(params), params.callback);
    }
    if (params.action === 'directorstores') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getDirectorStores(params), params.callback);
    }
    if (params.action === 'directorstaff') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getDirectorStaff(params), params.callback);
    }
    if (params.action === 'directoralerts') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getDirectorAlerts(), params.callback);
    }
    if (params.action === 'leaderboardstaff') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getLeaderboardStaff(params), params.callback);
    }

    // ── Store / Kiosk endpoints ────────────────────────────
    if (params.action === 'storetoday') {
      const store = requireStore_(auth, params.store);
      return jsonOut(getStoreToday(store, params), params.callback);
    }
    if (params.action === 'storeleaderboard') {
      const store = requireStore_(auth, params.store);
      return jsonOut(getStoreLeaderboard(store, params), params.callback);
    }
    if (params.action === 'storebadges') {
      const store = requireStore_(auth, params.store);
      return jsonOut(getStoreBadges(store, params), params.callback);
    }

    // ── Plan management ────────────────────────────────────
    if (params.action === 'setplan') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(setStorePlan(params), params.callback);
    }

    return jsonOut({ ok: false, error: 'Unknown action: ' + params.action }, params.callback);

  } catch(err) {
    Logger.log('doGet error: ' + err.message + '\n' + err.stack);
    return jsonOut({ ok: false, error: err.message }, params.callback);
  }
}

// ============================================================
// AUTH
// ============================================================

function sessionSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty(GC_SESSION_SECRET_KEY);
  if (!secret) {
    secret = Utilities.getUuid() + ':' + Utilities.getUuid();
    props.setProperty(GC_SESSION_SECRET_KEY, secret);
  }
  return secret;
}

function hashPass_(pass) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pass));
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function signSession_(payload) {
  const sig = Utilities.computeHmacSha256Signature(payload, sessionSecret_());
  return Utilities.base64EncodeWebSafe(sig);
}

function issueSessionToken_(user) {
  const exp = Date.now() + GC_SESSION_TTL_MS;
  const payload = [String(user).toLowerCase().trim(), exp].join(':');
  return payload + ':' + signSession_(payload);
}

function validateSessionToken_(token) {
  if (!token) return { ok: false, error: 'Auth required' };
  const parts = String(token).split(':');
  if (parts.length !== 3) return { ok: false, error: 'Invalid session' };
  const [user, expStr, sig] = parts;
  const exp = Number(expStr || 0);
  if (!user || !exp || Date.now() > exp) return { ok: false, error: 'Session expired' };
  const payload = user + ':' + exp;
  if (sig !== signSession_(payload)) return { ok: false, error: 'Invalid session' };
  return { ok: true, user: user };
}

function requireAuth_(params) {
  return validateSessionToken_(params.token || params.session || params.auth || '');
}

function requireRole_(auth, allowedRoles) {
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  const u = users[auth.user];
  if (!u) throw new Error('User not found');
  if (!allowedRoles.includes(u.role)) {
    throw new Error('Insufficient permissions');
  }
}

function requireStore_(auth, slug) {
  const store = STORES.find(s => s.slug === slug);
  if (!store) throw new Error('Unknown store: ' + slug);

  // Directors can access all stores; store_manager can only access their own
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  const u = users[auth.user];
  if (u && u.role === 'store_manager' && u.storeSlug !== slug) {
    throw new Error('Access denied for store: ' + slug);
  }
  return store;
}

function loginUser(params) {
  if (!params.user || !params.pass) {
    return { ok: false, error: 'Missing credentials' };
  }
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  const key   = String(params.user).toLowerCase().trim();
  const hash  = hashPass_(String(params.pass));
  const u     = users[key];

  if (!u || u.passHash !== hash) {
    return { ok: false, error: 'Invalid username or password' };
  }

  const exp = new Date(Date.now() + GC_SESSION_TTL_MS).toISOString();
  return {
    ok:          true,
    token:       issueSessionToken_(key),
    user:        key,
    displayName: u.displayName || key,
    initials:    u.initials || key.slice(0,2).toUpperCase(),
    role:        u.role || 'budtender',
    storeSlug:   u.storeSlug || null,
    storeName:   u.storeName || null,
    expiresAt:   exp,
  };
}

// ── Setup: run once from the Script Editor ────────────────────
// Example: setUserPassword_('sky', 'gcadmin', 'director', null, 'Sky Pinnick', 'SP')
function setUserPassword_(username, password, role, storeSlug, displayName, initials) {
  if (!username || !password || !role) throw new Error('username, password, and role are required');
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  const store = storeSlug ? STORES.find(s => s.slug === storeSlug) : null;
  users[username.toLowerCase().trim()] = {
    passHash:    hashPass_(String(password)),
    role:        role,
    storeSlug:   storeSlug || null,
    storeName:   store ? store.name : null,
    displayName: displayName || username,
    initials:    initials || username.slice(0,2).toUpperCase(),
  };
  props.setProperty(GC_USERS_KEY, JSON.stringify(users));
  Logger.log('User set: ' + username + ' / role: ' + role);
  return { ok: true, user: username };
}

// ============================================================
// DATE HELPERS
// ============================================================

/**
 * Convert a period string to a UTC date range suitable for Dutchie API calls.
 * All calendar math is done in local (Portland) time, then converted to UTC.
 *
 * @param  {string} period  'today' | 'wtd' | 'mtd' | 'qtd' | 'ytd'
 * @return {Object} { fromUTC, toUTC, fromLocal, toLocal, daysElapsed, totalDays, period }
 */
function getDateRange_(period) {
  const nowUTC     = new Date();
  // Convert "now" to local calendar time using fixed UTC offset
  const nowLocalMs = nowUTC.getTime() - STORE_TZ_OFFSET_MS;
  const nowLocal   = new Date(nowLocalMs);
  const y = nowLocal.getUTCFullYear();
  const m = nowLocal.getUTCMonth();   // 0-indexed
  const d = nowLocal.getUTCDate();

  // Start/end of today in local time, expressed as UTC ms
  const todayStartMs = Date.UTC(y, m, d);
  const todayEndMs   = todayStartMs + 24 * 60 * 60 * 1000 - 1;

  let fromMs, toMs;

  switch ((period || 'mtd').toLowerCase()) {
    case 'today':
      fromMs = todayStartMs;
      toMs   = todayEndMs;
      break;
    case 'wtd': {
      const dow = nowLocal.getUTCDay(); // 0 = Sunday
      fromMs = todayStartMs - dow * 24 * 60 * 60 * 1000;
      toMs   = todayEndMs;
      break;
    }
    case 'qtd': {
      const qStartMonth = Math.floor(m / 3) * 3;
      fromMs = Date.UTC(y, qStartMonth, 1);
      toMs   = todayEndMs;
      break;
    }
    case 'ytd':
      fromMs = Date.UTC(y, 0, 1);
      toMs   = todayEndMs;
      break;
    case 'mtd':
    default:
      fromMs = Date.UTC(y, m, 1);
      toMs   = todayEndMs;
      break;
  }

  // Convert local → UTC for API (add offset back)
  const fromUTC = new Date(fromMs + STORE_TZ_OFFSET_MS);
  const toUTC   = new Date(toMs   + STORE_TZ_OFFSET_MS);

  function fmtDate(ms) {
    const dt = new Date(ms);
    return dt.getUTCFullYear() + '-'
      + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-'
      + String(dt.getUTCDate()).padStart(2, '0');
  }

  const DAY_MS      = 24 * 60 * 60 * 1000;
  const daysElapsed = Math.max(1, Math.round((todayStartMs - fromMs) / DAY_MS) + 1);
  const totalDays   = Math.max(1, Math.round((toMs - fromMs) / DAY_MS) + 1);

  return {
    fromUTC:     fromUTC.toISOString(),
    toUTC:       toUTC.toISOString(),
    fromLocal:   fmtDate(fromMs),
    toLocal:     fmtDate(todayStartMs),
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

// ============================================================
// PLAN HELPERS
// ============================================================

/**
 * Returns all store plans.
 * Stored in ScriptProperties as GC_STORE_PLANS_JSON:
 *   { "baseline": { "monthly": 255000, "daily": 8500 }, ... }
 */
function getStorePlans_() {
  const raw = PropertiesService.getScriptProperties().getProperty(GC_STORE_PLANS_KEY);
  return JSON.parse(raw || '{}');
}

/** Returns the daily revenue goal for a store (0 if not set). */
function getDailyGoal_(slug) {
  const plan = (getStorePlans_())[slug] || {};
  if (plan.daily) return plan.daily;
  if (plan.monthly) return Math.round(plan.monthly / 30.4);
  return 0;
}

/** Returns the monthly revenue goal for a store (0 if not set). */
function getMonthlyGoal_(slug) {
  const plan = (getStorePlans_())[slug] || {};
  if (plan.monthly) return plan.monthly;
  if (plan.daily) return Math.round(plan.daily * 30.4);
  return 0;
}

// ── Setup helper (run from editor) ────────────────────────────
/**
 * Write store plans.  Call from Script Editor:
 *   setStorePlans_({
 *     baseline:   { monthly: 255000, daily: 8500 },
 *     center:     { monthly: 246000, daily: 8200 },
 *     century:    { monthly: 204000, daily: 6800 },
 *     commercial: { monthly: 216000, daily: 7200 },
 *     portland:   { monthly: 237000, daily: 7900 },
 *     river:      { monthly: 252000, daily: 8400 },
 *   });
 */
function setStorePlans_(plans) {
  PropertiesService.getScriptProperties().setProperty(GC_STORE_PLANS_KEY, JSON.stringify(plans));
  Logger.log('Plans saved: ' + JSON.stringify(plans));
  return { ok: true };
}

// ============================================================
// DUTCHIE FETCH HELPERS
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
 * Fetch transactions for a single store; returns only Retail transactions.
 * Fetches up to 5 000 records per call. For periods with more than ~3 000
 * transactions per store, add a pagination loop here.
 */
function fetchStoreTransactions_(storeSlug, fromUTC, toUTC) {
  const storeKey = getDutchieStoreKey_(storeSlug);
  const data = dutchieFetch_(storeKey, '/reporting/transactions', {
    FromDateUTC:   fromUTC,
    ToDateUTC:     toUTC,
    IncludeDetail: 'true',
    Skip:          0,
    Take:          5000,
  });
  const txns = Array.isArray(data) ? data : (data.transactions || data.data || []);
  return txns.filter(tx => tx.transactionType === 'Retail');
}

/**
 * Fetch transactions for ALL stores in parallel using UrlFetchApp.fetchAll().
 * Returns an object keyed by storeSlug: { baseline: [...], center: [...], ... }
 */
function fetchAllStoresTransactions_(range) {
  const requests = STORES.map(function(store) {
    const storeKey = getDutchieStoreKey_(store.slug);
    const qs = [
      'FromDateUTC='   + encodeURIComponent(range.fromUTC),
      'ToDateUTC='     + encodeURIComponent(range.toUTC),
      'IncludeDetail=true',
      'Skip=0',
      'Take=5000',
    ].join('&');
    return {
      url: DUTCHIE_BASE + '/reporting/transactions?' + qs,
      headers: {
        Authorization: 'Basic ' + Utilities.base64Encode(storeKey + ':'),
        Accept: 'application/json',
      },
      muteHttpExceptions: true,
    };
  });

  const responses = UrlFetchApp.fetchAll(requests);
  const result = {};

  STORES.forEach(function(store, i) {
    try {
      const resp = responses[i];
      if (resp.getResponseCode() !== 200) {
        Logger.log('Dutchie ' + resp.getResponseCode() + ' for ' + store.slug);
        result[store.slug] = [];
        return;
      }
      const data = JSON.parse(resp.getContentText());
      const txns = Array.isArray(data) ? data : (data.transactions || data.data || []);
      result[store.slug] = txns.filter(tx => tx.transactionType === 'Retail');
    } catch(e) {
      Logger.log('Parse error for ' + store.slug + ': ' + e.message);
      result[store.slug] = [];
    }
  });

  return result;
}

// ============================================================
// TRANSACTION AGGREGATION
// ============================================================

/**
 * Extract employee info from a transaction, handling Dutchie field variants.
 * Dutchie POS may use employee.displayName, employee.firstName+lastName,
 * or top-level employeeName depending on the endpoint version.
 */
function txEmployee_(tx) {
  if (tx.employee && typeof tx.employee === 'object') {
    const name = tx.employee.displayName
      || ((tx.employee.firstName || '') + ' ' + (tx.employee.lastName || '')).trim()
      || 'Unknown';
    return {
      id:       tx.employee.id || tx.employee.employeeId || '',
      name:     name || 'Unknown',
      initials: tx.employee.initials || initials_(name),
    };
  }
  const name = tx.employeeName || tx.budtenderName || 'Unknown';
  return { id: tx.employeeId || '', name, initials: initials_(name) };
}

function initials_(name) {
  return (name || '')
    .split(' ')
    .filter(Boolean)
    .map(p => p[0].toUpperCase())
    .join('')
    .slice(0, 2);
}

// Safely extract numeric fields from a transaction
function txTotal_(tx)    { return Number(tx.total          || tx.netSales     || 0); }
function txSubtotal_(tx) { return Number(tx.subtotal       || tx.grossSales   || tx.total || 0); }
function txDiscount_(tx) { return Number(tx.discountTotal  || tx.totalDiscount || 0); }
function txItems_(tx) {
  const items = tx.lineItems || tx.lineitemList || tx.items || [];
  if (!items.length) return 1;
  return items.reduce((sum, li) => sum + (Number(li.quantity) || 1), 0);
}

/** Aggregate a transaction array → summary + per-employee breakdown. */
function aggregateTransactions_(txns) {
  let totalSales = 0, totalSubtotal = 0, totalDiscounts = 0, totalItems = 0;
  const byEmployee = {};

  txns.forEach(function(tx) {
    const sales    = txTotal_(tx);
    const sub      = txSubtotal_(tx);
    const disc     = txDiscount_(tx);
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
        items:        0, discounts:    0, subtotal: 0,
      };
    }
    const e = byEmployee[empKey];
    e.sales        += sales;
    e.transactions += 1;
    e.items        += items;
    e.discounts    += disc;
    e.subtotal     += sub;
  });

  const count = txns.length;

  // Derive per-employee metrics
  Object.values(byEmployee).forEach(function(e) {
    e.avgOrderValue = e.transactions > 0 ? r2_(e.sales / e.transactions) : 0;
    e.avgUPT        = e.transactions > 0 ? r1_(e.items / e.transactions) : 0;
    e.discountRate  = e.subtotal     > 0 ? r3_(e.discounts / e.subtotal) : 0;
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
    // Dutchie local-time field: transactionDateLocalTime; fallback to UTC date
    const dtStr = tx.transactionDateLocalTime || tx.transactionDate || '';
    if (!dtStr) return;
    const h = new Date(dtStr).getHours();
    if (h < 0 || h > 23) return;
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

// ============================================================
// DIRECTOR ENDPOINTS
// ============================================================

function getDirectorSummary(params) {
  const period = params.period || 'mtd';
  const range  = getDateRange_(period);
  const prior  = getPriorRange_(range);

  // Parallel batch: current period + prior period (2 × 6 HTTP calls)
  const currByStore = fetchAllStoresTransactions_(range);
  const prevByStore = fetchAllStoresTransactions_(prior);

  const allCurr = Object.values(currByStore).flat();
  const allPrev = Object.values(prevByStore).flat();

  const curr = aggregateTransactions_(allCurr);
  const prev = aggregateTransactions_(allPrev);

  const allEmps       = Object.values(curr.byEmployee);
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

function getDirectorStores(params) {
  const period   = params.period || 'mtd';
  const range    = getDateRange_(period);
  const todayR   = period === 'today' ? range : getDateRange_('today');
  const plans    = getStorePlans_();

  // Batch: period data + today data (parallel)
  const byStore      = fetchAllStoresTransactions_(range);
  const byStoreToday = period === 'today' ? byStore : fetchAllStoresTransactions_(todayR);

  // Look up user records once for manager info
  const users = JSON.parse(
    PropertiesService.getScriptProperties().getProperty(GC_USERS_KEY) || '{}'
  );

  const storeSummaries = STORES.map(function(store) {
    const txns      = byStore[store.slug]      || [];
    const txnsToday = byStoreToday[store.slug] || [];
    const agg       = aggregateTransactions_(txns);
    const aggToday  = aggregateTransactions_(txnsToday);

    const monthlyGoal  = getMonthlyGoal_(store.slug);
    const dailyGoal    = getDailyGoal_(store.slug);
    const proratedGoal = monthlyGoal > 0
      ? monthlyGoal * (range.daysElapsed / (range.totalDays || 30))
      : 0;
    const vsplan = proratedGoal > 0 ? r3_((agg.sales - proratedGoal) / proratedGoal) : 0;

    // Pace for today: (revenue / goal) at current time fraction
    const now          = new Date();
    const nowLocalHour = new Date(now.getTime() - STORE_TZ_OFFSET_MS).getUTCHours();
    const elapsed      = Math.max(0, Math.min(nowLocalHour - STORE_OPEN_HOUR, STORE_HOURS));
    const dayFrac      = elapsed / STORE_HOURS;
    const paceGoal     = dailyGoal * dayFrac;
    const todayPace    = paceGoal > 0 ? r3_((aggToday.sales - paceGoal) / paceGoal) : 0;

    // Manager from user records
    const mgr = Object.values(users).find(u => u.storeSlug === store.slug && u.role === 'store_manager') || {};

    // Flagged employees
    const flaggedEmps = Object.values(agg.byEmployee).filter(e => e.discountRate > DISCOUNT_FLAG_THRESHOLD);

    // Tags
    const tags = [];
    if (vsplan >  0.05)  tags.push('top');
    if (vsplan < -0.08)  { tags.push('flag'); tags.push('watch'); }
    else if (vsplan < 0) tags.push('watch');

    return {
      slug:          store.slug,
      name:          store.name,
      staffCount:    Object.keys(agg.byEmployee).length,
      manager:       { name: mgr.displayName || '', initials: mgr.initials || '', role: 'store_manager' },
      rank:          0,  // assigned after sort
      sales:         agg.sales,
      vsplan:        vsplan,
      transactions:  agg.transactions,
      avgOrderValue: agg.avgOrderValue,
      avgUPT:        agg.avgUPT,
      discountRate:  agg.discountRate,
      trendPct:      0,    // requires multi-day bucketing (TODO)
      trend30d:      [],   // requires 30-day query (TODO)
      tags:          tags,
      today:         { revenue: aggToday.sales, goal: dailyGoal, pace: todayPace },
      flagCount:     flaggedEmps.length,
    };
  });

  // Sort by sales descending, assign ranks
  storeSummaries.sort((a, b) => b.sales - a.sales);
  storeSummaries.forEach((s, i) => { s.rank = i + 1; });

  return {
    period:      period,
    dateRange:   { from: range.fromLocal, to: range.toLocal },
    stores:      storeSummaries,
    lastUpdated: new Date().toISOString(),
  };
}

function getDirectorStaff(params) {
  const period  = params.period || 'mtd';
  const range   = getDateRange_(period);
  const byStore = fetchAllStoresTransactions_(range);

  // Aggregate employees globally across all stores
  const globalEmps = {};

  STORES.forEach(function(store) {
    const agg = aggregateTransactions_(byStore[store.slug] || []);
    Object.values(agg.byEmployee).forEach(function(emp) {
      const key = emp.name.toLowerCase().replace(/\s+/g, '_');
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
  const staffList = Object.values(globalEmps).map(function(emp) {
    const aov  = emp.transactions > 0 ? r2_(emp.sales / emp.transactions) : 0;
    const upt  = emp.transactions > 0 ? r1_(emp.items / emp.transactions)  : 0;
    const disc = emp.subtotal     > 0 ? r3_(emp.discounts / emp.subtotal)   : 0;

    const tags = [];
    if (disc > DISCOUNT_FLAG_THRESHOLD)  tags.push('flag');
    if (disc > DISCOUNT_WATCH_THRESHOLD) tags.push('watch');

    return {
      initials:      emp.initials,
      name:          emp.name,
      role:          emp.role || '',
      roleLabel:     emp.roleLabel || '',
      storeSlug:     emp.storeSlug,
      storeName:     emp.storeName,
      hoursWorked:   0,   // Dutchie doesn't expose schedule hours; integrate separately
      sales:         emp.sales,
      transactions:  emp.transactions,
      avgOrderValue: aov,
      avgUPT:        upt,
      discountRate:  disc,
      trendPct:      0,   // requires prior-period comparison (see getDirectorSummary pattern)
      trend30d:      [],  // requires 30 daily data points (TODO)
      tags:          tags,
    };
  });

  // Sort by sales, assign ranks, badge top performers
  staffList.sort((a, b) => b.sales - a.sales);
  staffList.forEach(function(s, i) {
    s.rank = i + 1;
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
function getLeaderboardStaff(params) {
  const data = getDirectorStaff(params);
  return {
    period:     data.period,
    totalStaff: data.totalActive,
    showing:    data.staff.length,
    staff:      data.staff.map(s => ({
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

function getDirectorAlerts() {
  const range     = getDateRange_('mtd');
  const byStore   = fetchAllStoresTransactions_(range);
  const plans     = getStorePlans_();
  const alerts    = [];
  const discWatch = [];

  STORES.forEach(function(store) {
    const agg          = aggregateTransactions_(byStore[store.slug] || []);
    const monthlyGoal  = getMonthlyGoal_(store.slug);
    const proratedGoal = monthlyGoal > 0
      ? monthlyGoal * (range.daysElapsed / (range.totalDays || 30))
      : 0;

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
// STORE / KIOSK ENDPOINTS
// ============================================================

function getStoreToday(store, params) {
  const todayR = getDateRange_('today');
  const txns   = fetchStoreTransactions_(store.slug, todayR.fromUTC, todayR.toUTC);
  const agg    = aggregateTransactions_(txns);
  const hourMap = aggregateByHour_(txns);

  const dailyGoal = getDailyGoal_(store.slug);

  // Pace: how far ahead/behind goal given elapsed store time
  const now          = new Date();
  const nowLocal     = new Date(now.getTime() - STORE_TZ_OFFSET_MS);
  const nowHour      = nowLocal.getUTCHours();
  const nowMinute    = nowLocal.getUTCMinutes();
  const elapsedHours = Math.max(0, Math.min(nowHour + nowMinute / 60 - STORE_OPEN_HOUR, STORE_HOURS));
  const dayFrac      = STORE_HOURS > 0 ? elapsedHours / STORE_HOURS : 0;
  const paceGoal     = dailyGoal * dayFrac;
  const pace         = paceGoal > 0.5 ? r3_((agg.sales - paceGoal) / paceGoal) : 0;
  const pctToGoal    = dailyGoal > 0  ? r3_(agg.sales / dailyGoal)              : 0;

  // Project EOD revenue (straight-line projection)
  const projectedRevenue = dayFrac > 0.05
    ? Math.round(agg.sales / dayFrac)
    : agg.sales;

  // Time remaining label
  const hoursLeft = Math.max(0, STORE_CLOSE_HOUR - nowHour);
  const timeRemainingLabel = hoursLeft > 1 ? hoursLeft + 'h remaining'
    : hoursLeft === 1 ? '~1h remaining'
    : 'Closing soon';

  // Hourly bar chart
  const maxRevenue = Math.max(1, ...Object.values(hourMap).map(h => h.revenue));
  const hourly = [];
  for (let h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
    const d   = hourMap[h] || { revenue: 0, count: 0 };
    const lbl = h === 12 ? '12p' : h < 12 ? h + 'a' : (h - 12) + 'p';
    hourly.push({
      hour:      lbl,
      revenue:   Math.round(d.revenue),
      pct:       r1_((d.revenue / maxRevenue) * 100),
      current:   h === nowHour,
      projected: h > nowHour,
    });
  }

  // On-shift: staff with ≥1 transaction today (sorted by sales desc)
  const onShift = Object.values(agg.byEmployee)
    .sort((a, b) => b.sales - a.sales)
    .map(emp => ({
      initials: emp.initials,
      name:     emp.name,
      status:   'on',
      sales:    emp.sales,
      note:     null,
    }));

  // Ticker seed: last 8 transactions in reverse chronological order
  const recentTxns = txns.slice().reverse().slice(0, 8);
  const ticker = recentTxns.map(function(tx) {
    const emp   = txEmployee_(tx);
    const items = tx.lineItems || tx.lineitemList || tx.items || [];
    const topItem = items.length > 0
      ? (items[0].productName || items[0].name || 'item')
      : 'item';
    return {
      who:   emp.name.split(' ')[0],
      item:  topItem.slice(0, 40),
      price: txTotal_(tx),
      ts:    tx.transactionDateLocalTime || tx.transactionDate || '',
    };
  });

  return {
    storeSlug:          store.slug,
    storeName:          store.name,
    goal:               dailyGoal,
    revenue:            agg.sales,
    pctToGoal:          pctToGoal,
    pace:               pace,
    projectedRevenue:   projectedRevenue,
    toGo:               Math.max(0, dailyGoal - agg.sales),
    timeRemainingLabel: timeRemainingLabel,
    transactions:       agg.transactions,
    avgOrderValue:      agg.avgOrderValue,
    onShift:            onShift,
    hourly:             hourly,
    ticker:             ticker,
    tickerPool:         [],   // client polls every 30s; new txns arrive via fresh fetch
    lastUpdated:        new Date().toISOString(),
  };
}

function getStoreLeaderboard(store, params) {
  const todayR = getDateRange_('today');
  const txns   = fetchStoreTransactions_(store.slug, todayR.fromUTC, todayR.toUTC);
  const agg    = aggregateTransactions_(txns);
  const today  = todayR.toLocal;

  // Load and update streaks
  const props   = PropertiesService.getScriptProperties();
  const streaks = JSON.parse(props.getProperty(GC_STREAKS_KEY) || '{}');

  const empList = Object.values(agg.byEmployee)
    .sort((a, b) => b.sales - a.sales);

  empList.forEach(function(emp) {
    const key = store.slug + ':' + emp.name.toLowerCase().replace(/\s+/g, '_');
    const s   = streaks[key] || { days: 0, lastDate: '' };

    const yesterday = fmtDate_(new Date(today).getTime() - 24 * 60 * 60 * 1000);

    if (s.lastDate === yesterday) {
      s.days    = (s.days || 0) + 1;
      s.lastDate = today;
    } else if (s.lastDate !== today) {
      s.days    = 1;
      s.lastDate = today;
    }
    streaks[key] = s;
    emp._streak = s.days;
  });

  props.setProperty(GC_STREAKS_KEY, JSON.stringify(streaks));

  const staff = empList.map((emp, i) => ({
    rank:          i + 1,
    initials:      emp.initials,
    name:          emp.name,
    sales:         emp.sales,
    transactions:  emp.transactions,
    avgOrderValue: emp.avgOrderValue,
    discountRate:  emp.discountRate,
    streakDays:    emp._streak || 1,
    note:          null,
  }));

  return {
    storeSlug:   store.slug,
    storeName:   store.name,
    date:        today,
    staff:       staff,
    lastUpdated: new Date().toISOString(),
  };
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
    winner: firstName_(aovKing.name),
    detail: '$' + aovKing.avgOrderValue + ' avg ticket',
  });

  // 👑 Upsell King — highest avg items per ticket
  const uptKing = best(emps, e => e.avgUPT);
  badges.push({
    id: 'upsell-king', icon: '👑', label: 'Upsell King', type: 'gold',
    winner: firstName_(uptKing.name),
    detail: uptKing.avgUPT + ' items/ticket',
  });

  // 🧼 Cleanest Receipts — lowest discount rate (min 10 txns)
  const cleanEmps = emps.filter(e => e.transactions >= 10);
  if (cleanEmps.length > 0) {
    const cleanest = worst(cleanEmps, e => e.discountRate);
    badges.push({
      id: 'cleanest', icon: '🧼', label: 'Cleanest Receipts', type: 'silver',
      winner: firstName_(cleanest.name),
      detail: Math.round(cleanest.discountRate * 100) + '% discount rate',
    });
  }

  // 🔥 Top Sales — most total revenue
  const topSales = best(emps, e => e.sales);
  badges.push({
    id: 'top-sales', icon: '🔥', label: 'Top Sales', type: 'gold',
    winner: firstName_(topSales.name),
    detail: '$' + Math.round(topSales.sales).toLocaleString() + ' this week',
  });

  // 🤝 The Closer — most transactions
  const closer = best(emps, e => e.transactions);
  badges.push({
    id: 'the-closer', icon: '🤝', label: 'The Closer', type: 'silver',
    winner: firstName_(closer.name),
    detail: closer.transactions + ' tickets',
  });

  return {
    storeSlug:   store.slug,
    storeName:   store.name,
    period:      period,
    badges:      badges,
    lastUpdated: new Date().toISOString(),
  };
}

function firstName_(name) {
  return (name || '').split(' ')[0] || name;
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
// JSONP WRAPPER
// ============================================================

function jsonOut(data, callback) {
  const json = JSON.stringify(data);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
