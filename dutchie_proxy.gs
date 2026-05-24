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
const GC_EMPLOYEES_KEY      = 'GC_STORE_EMPLOYEES_JSON';
const GC_PAY_PERIOD_ANCHOR  = 'GC_PAY_PERIOD_ANCHOR'; // stored as "YYYY-MM-DD" local date
const GC_TARGET_CACHE_KEY   = 'GC_ROLLING_TARGET_CACHE_JSON';
const PP_DAYS                = 14;   // pay-period length in days
const TARGET_LOOKBACK_MONTHS = 6;    // rolling lookback for target calculation
const DUTCHIE_BASE          = 'https://api.pos.dutchie.com';

// IANA timezone — handles PDT/PST DST transitions automatically.
const STORE_TZ = 'America/Los_Angeles';

// Store open/close hours (PT, 24-hour)
const STORE_OPEN_HOUR  = 8;   // 8 am
const STORE_CLOSE_HOUR = 22;  // 10 pm
const STORE_HOURS      = STORE_CLOSE_HOUR - STORE_OPEN_HOUR; // 14

// ── PT timezone helpers ──────────────────────────────────────────────────────

/**
 * Get current date/time parts in PT (DST-aware via Utilities.formatDate).
 * Returns { year, month (0-indexed), day, hour, minute, dow (0=Sun), dateStr }
 */
function ptNow_() {
  const now = new Date();
  const str = Utilities.formatDate(now, STORE_TZ, 'yyyy-MM-dd HH:mm:ss');
  // u = ISO weekday: 1=Mon … 7=Sun.  % 7 makes Sun=0, Mon=1 … Sat=6.
  const dow = parseInt(Utilities.formatDate(now, STORE_TZ, 'u'), 10) % 7;
  return {
    year:    parseInt(str.slice(0, 4), 10),
    month:   parseInt(str.slice(5, 7), 10) - 1,   // 0-indexed
    day:     parseInt(str.slice(8, 10), 10),
    hour:    parseInt(str.slice(11, 13), 10),
    minute:  parseInt(str.slice(14, 16), 10),
    dow,
    dateStr: str.slice(0, 10),   // 'YYYY-MM-DD'
  };
}

/**
 * Convert a PT date string ('YYYY-MM-DD') to UTC milliseconds for midnight PT
 * on that date. Correct for both PDT (UTC-7) and PST (UTC-8).
 */
function ptDateToUtcMs_(ptDateStr) {
  const [y, mo, d] = ptDateStr.split('-').map(Number);
  // Probe at noon UTC — avoids any ambiguity around midnight or DST transitions.
  const noon  = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const ptH   = parseInt(Utilities.formatDate(noon, STORE_TZ, 'H'), 10);
  const offMs = (12 - ptH) * 3600000;   // PDT → 7h, PST → 8h
  // PT midnight = Date.UTC(y,mo-1,d,0,0,0) + offset
  return Date.UTC(y, mo - 1, d) + offMs;
}

/**
 * Get PT hour + minute right now (DST-aware).
 * Returns { hour, minute }
 */
function ptHourNow_() {
  const str = Utilities.formatDate(new Date(), STORE_TZ, 'HH:mm');
  return { hour: parseInt(str.slice(0, 2), 10), minute: parseInt(str.slice(3, 5), 10) };
}

// Discount flag threshold
const DISCOUNT_FLAG_THRESHOLD  = 0.065;
const DISCOUNT_WATCH_THRESHOLD = 0.080;

// Canonical store list — slugs must match src/fixtures/ filenames
// and the frontend GC.STORES registry in utils.js.
// dutchieName = the key used in DUTCHIE_STORE_KEYS_JSON ScriptProperty.
// Confirmed from GX2 Dashboard STORE_KEYS (May 2026):
//   Bend       → Baseline
//   Hillsboro  → Century
const STORES = [
  { slug: 'baseline',   name: 'Baseline',   dutchieName: 'Bend'        },
  { slug: 'center',     name: 'Center',     dutchieName: 'Center'      },
  { slug: 'century',    name: 'Century',    dutchieName: 'Hillsboro'   },
  { slug: 'commercial', name: 'Commercial', dutchieName: 'Commercial'  },
  { slug: 'portland',   name: 'Portland',   dutchieName: 'Portland Rd' },
  { slug: 'river',      name: 'River',      dutchieName: 'River'       },
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
    if (params.action === 'directorall') {
      requireRole_(auth, ['owner','director']);
      const period = params.period || 'mtd';
      const range  = getDateRange_(period);
      const prior  = getPriorRange_(range);
      const todayR = getDateRange_('today');
      // For mtd (default), byStore also serves as byStoreMTD — no 4th fetch needed.
      const mtdR   = period === 'mtd' ? null : getDateRange_('mtd');

      // ONE mega-batch: 4 (or 5) ranges × 6 stores = 24–30 parallel HTTP requests.
      // This replaces 6 sequential fetchAll calls and cuts execution time ~3–6×.
      // Ranges: [0] current period, [1] prior period, [2] today, [3?] mtd, [last] 30-day window
      const range30d = getDateRange_('30d');
      const rangeList = [range, prior, todayR];
      if (mtdR) rangeList.push(mtdR);
      rangeList.push(range30d); // always last

      const fetched      = fetchAllStoresTransactionsMulti_(rangeList);
      const byStore      = fetched[0];  // current period
      const prevByStore  = fetched[1];  // prior period (for summary deltas)
      const byStoreToday = fetched[2];  // today (for store pace)
      const byStoreMTD   = mtdR ? fetched[3] : byStore; // mtd (for alerts)
      const byStore30d   = fetched[rangeList.length - 1]; // 30-day window (for trends)

      const summary = getDirectorSummary(params, { byStore, prevByStore });
      const stores  = getDirectorStores(params,  { byStore, byStoreToday, byStore30d });
      const staff   = getDirectorStaff(params,   { byStore, byStore30d });
      const alerts  = getDirectorAlerts(         { byStore: byStoreMTD });
      return jsonOut({ summary, stores, staff, alerts }, params.callback);
    }
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

    // ── Employee roster ────────────────────────────────────
    if (params.action === 'syncemployees') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(syncEmployeeRoster_(), params.callback);
    }

    if (params.action === 'refreshtargets') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(refreshTargetsAll(), params.callback);
    }

    // ── Plan management ────────────────────────────────────
    if (params.action === 'setplan') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(setStorePlan(params), params.callback);
    }

    // ── Admin: user & key management (director only) ───────
    if (params.action === 'setuser') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(adminSetUser(params), params.callback);
    }
    if (params.action === 'setstorekeys') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(adminSetStoreKeys(params), params.callback);
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

// ── ONE-TIME BOOTSTRAP — run from editor, then delete ─────────
// Select bootstrapAllUsers in the function dropdown and click Run.
// ── ONE-TIME: install daily roster refresh trigger ────────────
// Select this function in the Script Editor dropdown and click Run.
// Requires: Review Permissions → allow "Manage triggers" scope.
function installRosterTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncEmployeeRoster_')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncEmployeeRoster_')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
  Logger.log('Daily roster trigger installed (6am PT).');
}

function bootstrapAllUsers() {
  // Remove stale placeholder usernames from earlier development
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  ['sofia','maya','devon','priya','marcus','tyler'].forEach(k => delete users[k]);
  props.setProperty(GC_USERS_KEY, JSON.stringify(users));

  // Set real users
  setUserPassword_('sky',     'gcadmin', 'director',      null,         'Sky Pinnick',   'SP');
  setUserPassword_('dean',    'gc123',   'store_manager', 'baseline',   'Dean Deloof',   'DD');
  setUserPassword_('tj',      'gc123',   'store_manager', 'river',      'TJ Peterson',   'TP');
  setUserPassword_('scott',   'gc123',   'store_manager', 'portland',   'Scott Penner',  'SP');
  setUserPassword_('tyson',   'gc123',   'store_manager', 'center',     'Tyson Farris',  'TF');
  setUserPassword_('mariana', 'gc123',   'store_manager', 'commercial', 'Mariana Moxie', 'MM');
  setUserPassword_('chris',   'gc123',   'store_manager', 'century',    'Chris Carney',  'CC');
  Logger.log('All users bootstrapped.');
}

function bootstrapStorePlans() {
  setStorePlans_({
    baseline:   { monthly: 255000, daily: 8500 },
    center:     { monthly: 246000, daily: 8200 },
    century:    { monthly: 204000, daily: 6800 },
    commercial: { monthly: 216000, daily: 7200 },
    portland:   { monthly: 237000, daily: 7900 },
    river:      { monthly: 252000, daily: 8400 },
  });
  Logger.log('Store plans saved.');
}

function bootstrapStoreKeys() {
  adminSetStoreKeys({ keys: JSON.stringify({
    'Hillsboro':   '77e157f3fcdf43d9864daf0420df8c97',
    'Center':      '6a7e9c3187a6471d8a0a2d05cfa92023',
    'Commercial':  'd97da3cef3f74dd087cee7d4239a851d',
    'Bend':        'a2de33457b8f4d35972d3c47832207eb',
    'Portland Rd': '5671f32c2c2a4756811e9513945815f4',
    'River':       '5212417431014845a6db39bcb4ccef6b',
  })});
  Logger.log('Store keys saved.');
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
      // Bi-weekly pay period. Anchor date stored in ScriptProperties as "YYYY-MM-DD".
      // Default: 2026-05-11 (the pay period start confirmed in the incentive sheet).
      const anchorStr    = PropertiesService.getScriptProperties().getProperty(GC_PAY_PERIOD_ANCHOR) || '2026-05-11';
      const anchorMs     = ptDateToUtcMs_(anchorStr);
      const PP_MS        = 14 * 24 * 60 * 60 * 1000;
      const daysSince    = (todayStartMs - anchorMs) / (24 * 60 * 60 * 1000);
      const periodsBack  = daysSince >= 0 ? Math.floor(daysSince / 14) : Math.ceil(daysSince / 14) - 1;
      fromMs = anchorMs + periodsBack * PP_MS;
      toMs   = fromMs + PP_MS - 1;
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
/**
 * Daily revenue goal derived from the 6-month rolling pay-period target.
 * Falls back to static plan if no target has been computed yet.
 */
function getDailyGoal_(slug) {
  const pp = getPayPeriodTarget_(slug);
  if (pp > 0) return Math.round(pp / PP_DAYS);
  const plan = (getStorePlans_())[slug] || {};
  if (plan.daily)   return plan.daily;
  if (plan.monthly) return Math.round(plan.monthly / 30.4);
  return 0;
}

/** Monthly goal derived from pay-period target (pp × 30.4/14). */
function getMonthlyGoal_(slug) {
  const pp = getPayPeriodTarget_(slug);
  if (pp > 0) return Math.round(pp * 30.4 / PP_DAYS);
  const plan = (getStorePlans_())[slug] || {};
  if (plan.monthly) return plan.monthly;
  if (plan.daily)   return Math.round(plan.daily * 30.4);
  return 0;
}

/**
 * Returns the cached 14-day (pay-period) net sales target for a store.
 * Populated by refreshTargetsAll() which runs nightly via trigger.
 */
function getPayPeriodTarget_(slug) {
  const props = PropertiesService.getScriptProperties();
  const cache = JSON.parse(props.getProperty(GC_TARGET_CACHE_KEY) || '{}');
  return (cache[slug] && cache[slug].ppTarget) || 0;
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
    cache[s.slug]  = { ppTarget, computedAt: now.toISOString() };
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
  return txns
    .filter(tx => tx.transactionType === 'Retail')
    .sort((a, b) => {
      const ta = a.transactionDateLocalTime || a.transactionDate || '';
      const tb = b.transactionDateLocalTime || b.transactionDate || '';
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
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

/**
 * Fetch transactions for ALL stores across MULTIPLE date ranges in a single
 * UrlFetchApp.fetchAll() call, so all (nRanges × 6) requests run in parallel.
 *
 * @param  {Array}  ranges  Array of { fromUTC, toUTC } range objects
 * @return {Array}          Parallel array of byStore objects, one per input range
 */
function fetchAllStoresTransactionsMulti_(ranges) {
  const nStores = STORES.length;
  const allRequests = [];

  ranges.forEach(function(range) {
    STORES.forEach(function(store) {
      const storeKey = getDutchieStoreKey_(store.slug);
      const qs = [
        'FromDateUTC='   + encodeURIComponent(range.fromUTC),
        'ToDateUTC='     + encodeURIComponent(range.toUTC),
        'IncludeDetail=true',
        'Skip=0',
        'Take=5000',
      ].join('&');
      allRequests.push({
        url: DUTCHIE_BASE + '/reporting/transactions?' + qs,
        headers: {
          Authorization: 'Basic ' + Utilities.base64Encode(storeKey + ':'),
          Accept: 'application/json',
        },
        muteHttpExceptions: true,
      });
    });
  });

  Logger.log('fetchAllStoresTransactionsMulti_: firing ' + allRequests.length + ' requests (' + ranges.length + ' ranges × ' + nStores + ' stores)');
  const responses = UrlFetchApp.fetchAll(allRequests);

  return ranges.map(function(range, ri) {
    const result = {};
    STORES.forEach(function(store, si) {
      const resp = responses[ri * nStores + si];
      try {
        if (resp.getResponseCode() !== 200) {
          Logger.log('Dutchie ' + resp.getResponseCode() + ' for ' + store.slug + ' range[' + ri + ']');
          result[store.slug] = [];
          return;
        }
        const data = JSON.parse(resp.getContentText());
        const txns = Array.isArray(data) ? data : (data.transactions || data.data || []);
        result[store.slug] = txns.filter(tx => tx.transactionType === 'Retail');
      } catch(e) {
        Logger.log('Parse error for ' + store.slug + ' range[' + ri + ']: ' + e.message);
        result[store.slug] = [];
      }
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
 *   trend30d  — ordered array of daily revenue values (oldest → newest)
 *   trendPct  — (last-7d avg − prior-7d avg) / prior-7d avg, clamped to 3 decimals
 */
function trendFromByDay_(byDay) {
  const days     = Object.keys(byDay).sort();
  const trend30d = days.map(function(d) { return Math.round(byDay[d]); });
  const n        = days.length;
  if (n < 7) return { trend30d: trend30d, trendPct: 0 };
  const last7    = days.slice(Math.max(0, n - 7)).reduce(function(s, d) { return s + byDay[d]; }, 0);
  const prior    = days.slice(Math.max(0, n - 14), Math.max(0, n - 7));
  if (prior.length === 0) return { trend30d: trend30d, trendPct: 0 };
  const prior7   = prior.reduce(function(s, d) { return s + byDay[d]; }, 0);
  const trendPct = prior7 > 0 ? r3_((last7 - prior7) / prior7) : 0;
  return { trend30d: trend30d, trendPct: trendPct };
}

// ============================================================
// ============================================================
// EMPLOYEE ROSTER
// ============================================================

/**
 * Returns the cached employee roster from ScriptProperties.
 * Shape: { "baseline": [{id, name, initials}, ...], "center": [...], ... }
 */
function getEmployeeRoster_() {
  const raw = PropertiesService.getScriptProperties().getProperty(GC_EMPLOYEES_KEY);
  return JSON.parse(raw || '{}');
}

/**
 * Build/refresh the employee roster from the last 30 days of transactions.
 * Employees are keyed by employeeId so duplicates are merged.
 * Run manually via the syncemployees action, or call from a time-based trigger.
 */
function syncEmployeeRoster_() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const range30 = {
    fromUTC: thirtyDaysAgo.toISOString(),
    toUTC:   new Date().toISOString(),
  };

  Logger.log('syncEmployeeRoster_: fetching 30-day transactions for all stores…');
  const byStore = fetchAllStoresTransactions_(range30);
  const roster = {};

  STORES.forEach(function(store) {
    const seen = {};
    (byStore[store.slug] || []).forEach(function(tx) {
      const emp = txEmployee_(tx);
      const key = String(emp.id || emp.name);
      if (emp.name !== 'Unknown' && !seen[key]) {
        seen[key] = { id: emp.id, name: emp.name, initials: emp.initials };
      }
    });
    roster[store.slug] = Object.values(seen)
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  PropertiesService.getScriptProperties().setProperty(GC_EMPLOYEES_KEY, JSON.stringify(roster));
  const counts = STORES.map(s => s.slug + ':' + (roster[s.slug] || []).length).join(', ');
  Logger.log('Roster saved — ' + counts);
  return { ok: true, counts: Object.fromEntries(STORES.map(s => [s.slug, (roster[s.slug] || []).length])) };
}

// ============================================================
// DIRECTOR ENDPOINTS
// ============================================================

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
    const nowLocalHour = ptHourNow_().hour;
    const elapsed      = Math.max(0, Math.min(nowLocalHour - STORE_OPEN_HOUR, STORE_HOURS));
    const dayFrac      = elapsed / STORE_HOURS;
    const paceGoal     = dailyGoal * dayFrac;
    const todayPace    = paceGoal > 0 ? r3_((aggToday.sales - paceGoal) / paceGoal) : 0;

    // Manager from user records
    const mgr = Object.values(users).find(u => u.storeSlug === store.slug && u.role === 'store_manager') || {};

    // Flagged employees
    const flaggedEmps = Object.values(agg.byEmployee).filter(e => e.discountRate > DISCOUNT_FLAG_THRESHOLD);

    // Tags: top / watch / flag (mutually exclusive, escalating severity)
    const tags = [];
    if (vsplan >  0.05) tags.push('top');
    else if (vsplan < -0.08) tags.push('flag');   // ≥8% behind plan → flag
    else if (vsplan <  0)    tags.push('watch');  // any behind plan  → watch

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
      ...trendFromByDay_(byStore30d ? aggregateByDay_(byStore30d[store.slug] || []) : {}),
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
    const aov    = emp.transactions > 0 ? r2_(emp.sales / emp.transactions) : 0;
    const upt    = emp.transactions > 0 ? r1_(emp.items / emp.transactions)  : 0;
    const disc   = emp.subtotal     > 0 ? r3_(emp.discounts / emp.subtotal)   : 0;
    const empKey = emp.name.toLowerCase().replace(/\s+/g, '_');
    const trend  = trendFromByDay_(empDailyBuckets[empKey] || {});

    const tags = [];
    if      (disc > DISCOUNT_WATCH_THRESHOLD) tags.push('flag');   // >8%       → flag (serious)
    else if (disc > DISCOUNT_FLAG_THRESHOLD)  tags.push('watch');  // 6.5–8%   → watch (mild)

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
      trendPct:      trend.trendPct,
      trend30d:      trend.trend30d,
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
function getLeaderboardStaff(params, pre) {
  const data = getDirectorStaff(params, pre);
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
  const todayR = getDateRange_('today');
  const txns   = fetchStoreTransactions_(store.slug, todayR.fromUTC, todayR.toUTC);
  const agg    = aggregateTransactions_(txns);
  const hourMap = aggregateByHour_(txns);

  // First-name frequency map so ticker can show "Zachary B." vs "Zachary R."
  // Use the full employee roster (all known staff at this store) so that
  // an off-shift Zachary still triggers disambiguation for the on-shift one.
  const tickerFirstNames = {};
  const fullRoster = (getEmployeeRoster_()[store.slug] || []);
  const rosterSource = fullRoster.length > 0 ? fullRoster : Object.values(agg.byEmployee);
  rosterSource.forEach(emp => {
    const fn = (emp.name || '').split(' ')[0].toLowerCase();
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

  const dailyGoal = getDailyGoal_(store.slug);

  // Pace: how far ahead/behind goal given elapsed store time (PT, DST-aware)
  const { hour: nowHour, minute: nowMinute } = ptHourNow_();
  const elapsedHours = Math.max(0, Math.min(nowHour + nowMinute / 60 - STORE_OPEN_HOUR, STORE_HOURS));
  const dayFrac      = STORE_HOURS > 0 ? elapsedHours / STORE_HOURS : 0;
  const paceGoal     = dailyGoal * dayFrac;
  const pace         = paceGoal > 0.5 ? r3_((agg.sales - paceGoal) / paceGoal) : 0;
  const pctToGoal    = dailyGoal > 0  ? r3_(agg.sales / dailyGoal)              : 0;

  // Time remaining (PT, store hours 8 am – 10 pm)
  const minutesLeft  = STORE_CLOSE_HOUR * 60 - (nowHour * 60 + nowMinute);
  const storeClosed  = minutesLeft <= 0;
  // Format as H:MM (e.g. "5:47", "0:23"), with special cases near close
  const _remH   = Math.floor(Math.max(0, minutesLeft) / 60);
  const _remM   = Math.max(0, minutesLeft) % 60;
  const _remFmt = _remH + ':' + String(_remM).padStart(2, '0');
  const timeRemainingLabel =
    storeClosed         ? 'Closed'
    : minutesLeft <= 0  ? 'Closed'
    : _remFmt;

  // Project EOD revenue (straight-line); after close it's the actual final number.
  // Require at least MIN_PROJ_HOURS of elapsed store time before extrapolating —
  // before that threshold the multiplier is too large (e.g. 14× at the 1-hour mark)
  // and one big early transaction blows up the projection. Below the threshold we
  // return 0 so the kiosk renders "—" instead of a misleading number.
  const MIN_PROJ_HOURS = 2;
  const projectedRevenue = storeClosed
    ? agg.sales
    : elapsedHours >= MIN_PROJ_HOURS
      ? Math.round(agg.sales / dayFrac)
      : 0;

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

  // Build shift strip: active employees (have transactions today) + known
  // roster employees who haven't transacted yet (shown as off-shift).
  const activeEmps = Object.values(agg.byEmployee)
    .sort((a, b) => b.sales - a.sales)
    .map(emp => ({
      initials: emp.initials,
      name:     emp.name,
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

  // Pull in roster employees not yet seen today
  const rosterEmps = (getEmployeeRoster_()[store.slug] || [])
    .filter(e => !activeIds.has(String(e.id)) && !activeNames.has(e.name.toLowerCase()))
    .map(e => ({
      initials: e.initials,
      name:     e.name,
      status:   'off',
      sales:    0,
      note:     null,
    }));

  const onShift = activeEmps.concat(rosterEmps);

  // Helper: build a ticker item from a transaction
  function makeTicker_(tx) {
    const emp = txEmployee_(tx);
    return {
      who:   disambiguateTicker_(emp.name),
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
    const newTxns = txns
      .filter(tx => (tx.transactionDateLocalTime || tx.transactionDate || '') > sinceTs)
      .reverse();   // newest first for ticker display
    return {
      isUpdate:          true,
      revenue:           agg.sales,
      transactions:      agg.transactions,
      avgOrderValue:     agg.avgOrderValue,
      pctToGoal:         pctToGoal,
      pace:              pace,
      projectedRevenue:  projectedRevenue,
      toGo:              storeClosed ? 0 : Math.max(0, dailyGoal - agg.sales),
      timeRemainingLabel: timeRemainingLabel,
      latestTxnTs:       latestTxnTs,
      newTicker:         newTxns.map(makeTicker_),
    };
  }

  // Full response: ticker seed = last 10 transactions newest-first
  const recentTxns = txns.slice().reverse().slice(0, 10);
  const ticker = recentTxns.map(makeTicker_);

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
    latestTxnTs:        latestTxnTs,
    lastUpdated:        new Date().toISOString(),
  };
}

function getStoreLeaderboard(store, params) {
  const todayR = getDateRange_('today');
  const txns   = fetchStoreTransactions_(store.slug, todayR.fromUTC, todayR.toUTC);
  const agg    = aggregateTransactions_(txns);
  const today  = todayR.toLocal;

  // Load and update streaks
  const props     = PropertiesService.getScriptProperties();
  const streaks   = JSON.parse(props.getProperty(GC_STREAKS_KEY) || '{}');
  const yesterday = fmtDate_(new Date(today).getTime() - 24 * 60 * 60 * 1000);

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

  props.setProperty(GC_STREAKS_KEY, JSON.stringify(streaks));

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

  const staff = empList.map((emp, i) => {
    const nameKey = emp.name.toLowerCase().replace(/\s+/g, '_');
    const target  = empTargets[nameKey] || fallbackTgt;
    return {
      rank:          i + 1,
      initials:      emp.initials,
      name:          emp.name,
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
// ADMIN ENDPOINTS (called by user_admin.gs Sheet)
// ============================================================

/**
 * Create or update a user account.
 * Params: username, password, role, storeSlug, displayName, initials
 * Auth:   director token required
 */
function adminSetUser(params) {
  if (!params.username) return { ok: false, error: 'username required' };
  if (!params.password) return { ok: false, error: 'password required' };
  if (!params.role)     return { ok: false, error: 'role required' };

  const validRoles = ['director', 'store_manager', 'budtender', 'owner'];
  if (!validRoles.includes(params.role)) {
    return { ok: false, error: 'Invalid role: ' + params.role };
  }

  return setUserPassword_(
    params.username,
    params.password,
    params.role,
    params.storeSlug || null,
    params.displayName || params.username,
    params.initials || ''
  );
}

/**
 * Write DUTCHIE_STORE_KEYS_JSON to ScriptProperties.
 * Params: keys — JSON string of { dutchieName: apiKey, ... }
 * Auth:   director token required
 */
function adminSetStoreKeys(params) {
  if (!params.keys) return { ok: false, error: 'keys param required' };
  let parsed;
  try {
    parsed = JSON.parse(params.keys);
  } catch(e) {
    return { ok: false, error: 'keys must be valid JSON: ' + e.message };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'keys must be a JSON object' };
  }
  PropertiesService.getScriptProperties().setProperty('DUTCHIE_STORE_KEYS_JSON', JSON.stringify(parsed));
  Logger.log('Store keys updated: ' + Object.keys(parsed).join(', '));
  return { ok: true, stores: Object.keys(parsed) };
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
