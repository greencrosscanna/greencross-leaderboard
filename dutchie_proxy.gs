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
const GC_NICKNAMES_KEY       = 'GC_NICKNAMES_JSON';
const GC_TARGET_CACHE_KEY   = 'GC_ROLLING_TARGET_CACHE_JSON';
const GC_GOALS_CACHE_KEY    = 'GC_GOALS_CACHE_JSON';
const GC_STRETCH_KEY        = 'GC_STRETCH_MULTIPLIER';  // stored as decimal, e.g. 0.025 = 2.5%
const GC_YOY_GOALS_KEY      = 'GC_YOY_GOALS_JSON';
const GC_YOY2_CACHE_KEY     = 'GC_YOY2_CACHE_JSON'; // permanent cache for 2-year-ago data
const GC_EXCLUDED_KEY       = 'GC_EXCLUDED_JSON';   // array of excluded employee nameKeys
const GC_MANUAL_PP_KEY      = 'GC_MANUAL_PP_GOALS_JSON'; // slug→final PP goal overrides
const GC_AVATAR_CONFIGS_KEY  = 'GC_AVATAR_CONFIGS_JSON'; // { nameKey: { ...avatar_config } }
const PP_DAYS                = 14;   // pay-period length in days
const TARGET_LOOKBACK_MONTHS = 6;    // rolling lookback for target calculation
const DUTCHIE_BASE          = 'https://api.pos.dutchie.com';

// IANA timezone — handles PDT/PST DST transitions automatically.
const STORE_TZ = 'America/Los_Angeles';

// Store open/close hours (PT, 24-hour)
const STORE_OPEN_HOUR  = 8;   // 8 am
const STORE_CLOSE_HOUR = 22;  // 10 pm
const STORE_HOURS      = STORE_CLOSE_HOUR - STORE_OPEN_HOUR; // 14

// Request-scoped memoization — reset to null at start of each GAS execution.
var _goalsCache_    = null;
var _yoyGoalsCache_ = null;

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

// Discount names to exclude from the staff discount-rate calculation.
// These are applied by the loyalty system — not by the budtender.
// Case-insensitive substring match against tx.discounts[].discountName.
// Source: 2026-05-25-Discounts export — all Type=Loyalty entries.
const EXCLUDED_DISCOUNT_KEYWORDS = [
  'point redemption',  // "$X off - X point redemption" (all point tiers)
  'reward 1',          // "Reward 1 - Green Cross Edible - 100 point redemption"
  'reward 2',          // "Reward 2 - Green Cross Preroll - 100 point redemption"
];

// Canonical store list — slugs must match src/fixtures/ filenames
// and the frontend GC.STORES registry in utils.js.
// dutchieName = the key used in DUTCHIE_STORE_KEYS_JSON ScriptProperty.
// Confirmed from GX2 Dashboard STORE_KEYS (May 2026):
//   Bend       → Baseline
//   Hillsboro  → Century
const STORES = [
  { slug: 'baseline',   name: 'Baseline',   dutchieName: 'Bend',        locationName: 'Hillsboro'   },
  { slug: 'center',     name: 'Center',     dutchieName: 'Center',      locationName: 'Center'      },
  { slug: 'century',    name: 'Century',    dutchieName: 'Hillsboro',   locationName: 'Bend'        },
  { slug: 'commercial', name: 'Commercial', dutchieName: 'Commercial',  locationName: 'Commercial'  },
  { slug: 'portland',   name: 'Portland',   dutchieName: 'Portland Rd', locationName: 'Portland Rd' },
  { slug: 'river',      name: 'River',      dutchieName: 'River',       locationName: 'River'       },
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
    // Public: computed daily + monthly goals for all stores, keyed by Sales Dashboard names.
    // No auth required — consumed by greencross-dashboard for the current pay period.
    if (params.action === 'getdailygoals') {
      return jsonOut(getDailyGoals_(), params.callback);
    }

    // ── One-time API key bootstrap (only works if key not yet set) ─
    if (params.action === 'initapikey') {
      var props = PropertiesService.getScriptProperties();
      if (props.getProperty('GC_API_READONLY_KEY')) {
        return jsonOut({ ok: false, error: 'Already initialised' }, params.callback);
      }
      var k = (params.key || '').trim();
      if (!k) return jsonOut({ ok: false, error: 'Missing key param' }, params.callback);
      props.setProperty('GC_API_READONLY_KEY', k);
      return jsonOut({ ok: true, msg: 'API key set' }, params.callback);
    }

    // ── Read-only goals for Sales Dashboard (API key auth) ─
    if (params.action === 'goals') {
      var storedKey = PropertiesService.getScriptProperties().getProperty('GC_API_READONLY_KEY');
      if (storedKey && params.apiKey !== storedKey) {
        return jsonOut({ ok: false, error: 'Unauthorized' }, params.callback);
      }
      return jsonOut(getGoalsForDashboard_(), params.callback);
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
      const today   = getDirectorToday(byStoreToday);
      const avatarConfigs = getAvatarConfigs_();
      return jsonOut({ summary, stores, staff, alerts, today, avatarConfigs }, params.callback);
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
      return jsonOut(recalculateGoals_(), params.callback);
    }
    if (params.action === 'recalculategoals') {
      requireRole_(auth, ['owner','director']);
      var rollingResult = recalculateGoals_();
      var yoyResult     = recalculateYoYGoals_();
      return jsonOut({ ok: rollingResult.ok && yoyResult.ok, rolling: rollingResult, yoy: yoyResult }, params.callback);
    }
    if (params.action === 'recalculateyoygoals') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(recalculateYoYGoals_(), params.callback);
    }

    // ── Plan management ────────────────────────────────────
    if (params.action === 'setplan') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(setStorePlan(params), params.callback);
    }

    if (params.action === 'getsettings') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getSettings_(params), params.callback);
    }
    if (params.action === 'savesettings') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(saveSettings_(params), params.callback);
    }
    if (params.action === 'savemanualgoals') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(saveManualGoals_(params), params.callback);
    }
    // Diagnostic: logs one raw transaction to Apps Script execution log.
    // Director-only. Dumps Script Property keys + goal cache structure.
    if (params.action === 'goalsdiag') {
      requireRole_(auth, ['owner','director']);
      var props = PropertiesService.getScriptProperties();
      var allKeys = Object.keys(props.getProperties());
      var cacheRaw = props.getProperty('GC_GOALS_CACHE_JSON') || '{}';
      var cache = {};
      try { cache = JSON.parse(cacheRaw); } catch(e) {}
      var result = {};
      ['baseline','century'].forEach(function(slug) {
        var g = cache[slug] || {};
        result[slug] = { ppGoal: g.ppGoal, dowAvg: g.dowAvg, computedAt: g.computedAt };
      });
      return jsonOut({ propKeys: allKeys, goalsBySlug: result, cacheTopKeys: Object.keys(cache) }, params.callback);
    }

    // Director-only. Call from browser: ?action=txdiag&store=baseline&token=TOKEN
    if (params.action === 'txdiag') {
      requireRole_(auth, ['owner','director']);
      var diagSlug  = params.store || STORES[0].slug;
      var diagRange = getDateRange_('mtd');
      var diagTxns  = fetchStoreTransactions_(diagSlug, diagRange.fromUTC, diagRange.toUTC);
      // Find a transaction that has a non-zero discount
      var diagTx = diagTxns.find(function(t) { return txDiscount_(t) > 0; }) || diagTxns[0];
      if (diagTx) {
        Logger.log('=== RAW TRANSACTION (store: ' + diagSlug + ') ===');
        Logger.log(JSON.stringify(diagTx, null, 2));
      } else {
        Logger.log('No transactions found for ' + diagSlug);
      }
      return jsonOut({ ok: true, found: !!diagTx, store: diagSlug,
        discountFields: diagTx ? {
          totalDiscount: diagTx.totalDiscount,
          discountTotal: diagTx.discountTotal,
          discounts:     diagTx.discounts,
          lineItemSample: (diagTx.items || diagTx.lineItems || diagTx.lineitemList || []).slice(0,2),
        } : null
      }, params.callback);
    }

    if (params.action === 'saveavatar') {
      return jsonOut(saveAvatarConfig_(params), params.callback);
    }
    if (params.action === 'clearavatar') {
      return jsonOut(clearAvatarConfig_(params), params.callback);
    }
    // Lightweight endpoint for the avatar picker — all authenticated roles.
    // Returns the employee roster + avatar config map without computing goals.
    if (params.action === 'getavatardata') {
      var avRoster  = getEmployeeRoster_();
      var avEmpMap  = {};
      STORES.forEach(function(store) {
        (avRoster[store.slug] || []).forEach(function(emp) {
          var key = nameToKey_(emp.name);
          if (!avEmpMap[key] && emp.name && emp.name !== 'Unknown') {
            avEmpMap[key] = { key: key, name: emp.name, store: store.name };
          }
        });
      });
      var avEmployees = Object.values(avEmpMap).sort(function(a, b) { return a.name.localeCompare(b.name); });
      var allAvEmployees = avEmployees.concat(getManagementEmployees_());
      return jsonOut({ ok: true, employees: allAvEmployees, avatarConfigs: resolveAvatarConfigs_(allAvEmployees, getAvatarConfigs_()) }, params.callback);
    }

    // ── One-shot: seed director accounts (owner only, safe to re-run) ──
    if (params.action === 'bootstrapdirectors') {
      requireRole_(auth, ['owner','director']);
      bootstrapDirectors();
      return jsonOut({ ok: true, message: 'Directors bootstrapped' }, params.callback);
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
  setUserPassword_('sky',    '0762ZW', 'director',      null,         'Sky Pinnick',   'SP');
  setUserPassword_('mike',   'Q6564J', 'director',      null,         'Mike Kettler',  'MK');
  setUserPassword_('shawn',  'XY1112', 'director',      null,         'Shawn Todd',    'ST');
  setUserPassword_('tawny',  '13C19U', 'director',      null,         'Tawny Vierra',  'TV');
  setUserPassword_('dean',    'gc123',   'store_manager', 'baseline',   'Dean Deloof',   'DD');
  setUserPassword_('tj',      'gc123',   'store_manager', 'river',      'TJ Peterson',   'TP');
  setUserPassword_('scott',   'gc123',   'store_manager', 'portland',   'Scott Penner',  'SP');
  setUserPassword_('tyson',   'gc123',   'store_manager', 'center',     'Tyson Farris',  'TF');
  setUserPassword_('mariana', 'gc123',   'store_manager', 'commercial', 'Mariana Moxie', 'MM');
  setUserPassword_('chris',   'gc123',   'store_manager', 'century',    'Chris Carney',  'CC');
  Logger.log('All users bootstrapped.');
}

// ── Run once from Script Editor to add/update director accounts ──
// Safe to re-run — only updates the listed users, leaves others intact.
function bootstrapDirectors() {
  setUserPassword_('sky',   '0762ZW', 'director', null, 'Sky Pinnick',  'SP');
  setUserPassword_('mike',  'Q6564J', 'director', null, 'Mike Kettler', 'MK');
  setUserPassword_('shawn', 'XY1112', 'director', null, 'Shawn Todd',   'ST');
  setUserPassword_('tawny', '13C19U', 'director', null, 'Tawny Vierra', 'TV');
  Logger.log('Directors bootstrapped.');
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

/** Returns the nickname map { nameKey: displayName }, with keys normalised (no periods). */
function getNicknames_() {
  const raw = PropertiesService.getScriptProperties().getProperty(GC_NICKNAMES_KEY);
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

/** Returns a Set of excluded employee nameKeys. */
function getExcluded_() {
  const raw = PropertiesService.getScriptProperties().getProperty(GC_EXCLUDED_KEY);
  try { return new Set(raw ? JSON.parse(raw) : []); } catch(e) { return new Set(); }
}

/** Normalise a Dutchie name into a lookup key (lowercase, no periods, spaces→underscore). */
function nameToKey_(name) {
  return (name || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, '_').trim();
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

  // 3. No nickname — return first name only (drops " C.", " W.", etc.)
  return parts[0];
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
  var raw = PropertiesService.getScriptProperties().getProperty(GC_MANUAL_PP_KEY);
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

  const props = PropertiesService.getScriptProperties();

  // Determine current PP start
  const anchorStr    = props.getProperty(GC_PAY_PERIOD_ANCHOR) || '2026-05-11';
  const anchorMs     = ptDateToUtcMs_(anchorStr);
  const PP_MS        = PP_DAYS * 24 * 60 * 60 * 1000;
  const todayStartMs = ptDateToUtcMs_(ptNow_().dateStr);
  const daysSince    = Math.round((todayStartMs - anchorMs) / (24 * 60 * 60 * 1000));
  const ppOffset     = daysSince >= 0 ? Math.floor(daysSince / PP_DAYS) : Math.ceil(daysSince / PP_DAYS) - 1;
  const ppStartMs    = anchorMs + ppOffset * PP_MS;
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

  var props      = PropertiesService.getScriptProperties();
  var anchorStr  = props.getProperty(GC_PAY_PERIOD_ANCHOR) || '2026-05-11';
  var anchorMs   = ptDateToUtcMs_(anchorStr);
  var PP_MS      = PP_DAYS * 24 * 60 * 60 * 1000;
  var todayMs    = ptDateToUtcMs_(ptNow_().dateStr);
  var daysSince  = Math.round((todayMs - anchorMs) / (24 * 60 * 60 * 1000));
  var ppOffset   = daysSince >= 0 ? Math.floor(daysSince / PP_DAYS) : Math.ceil(daysSince / PP_DAYS) - 1;
  var ppStartMs  = anchorMs + ppOffset * PP_MS;
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
  var YEAR_MS    = 364 * 24 * 60 * 60 * 1000;
  var yoyBaseMs  = ppStartMs - YEAR_MS;        // 1 year ago
  var yoy2BaseMs = ppStartMs - 2 * YEAR_MS;   // 2 years ago (for realized growth rate)

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

  Logger.log('[yoy] Computing YoY goals for PP ' + ppStartStr + ' (window: ' + yoyFrom + ' – ' + yoyTo + ')…');

  // Y2 data (2 years ago) is purely historical — cache aggregated PP totals permanently.
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
        var txns  = byStore[store.slug] || [];
        var ppSum = 0;
        Object.keys(aggregateByDay_(txns)).forEach(function(day) { ppSum += aggregateByDay_(txns)[day]; });
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

  // 36 parallel requests for Y1 (current season, 1 year ago)
  var fetchedY1 = fetchAllStoresTransactionsMulti_(ranges);

  // Max realized growth applied to YoY baseline (caps outlier years — new stores, one-off events)
  var MAX_REALIZED_GROWTH = 0.20; // 20%

  var goals = {};
  var pt    = ptNow_();

  STORES.forEach(function(store) {
    // ── Year-ago baseline ──────────────────────────────────
    var allByDayY1 = {};
    var ppTotalsY1 = [];
    fetchedY1.forEach(function(byStore) {
      var txns  = byStore[store.slug] || [];
      var ppDay = aggregateByDay_(txns);
      var ppSum = 0;
      Object.keys(ppDay).forEach(function(day) {
        allByDayY1[day] = (allByDayY1[day] || 0) + ppDay[day];
        ppSum += ppDay[day];
      });
      ppTotalsY1.push(ppSum);
    });
    var ppY1 = ppTotalsY1.length > 0
      ? ppTotalsY1.reduce(function(a, b) { return a + b; }, 0) / ppTotalsY1.length
      : 0;

    // ── Two-years-ago baseline (for realized growth rate) — from cache ──
    var ppY2 = ppTotalsY2ByStore[store.slug] || 0;

    // ── Realized growth rate (Y1 vs Y2, floored at 0, capped at MAX) ──
    var realizedGrowth = 0;
    if (ppY2 > 0 && ppY1 > 0) {
      realizedGrowth = Math.max(0, Math.min(MAX_REALIZED_GROWTH, (ppY1 - ppY2) / ppY2));
    }

    // ── Forward goal = Y1 × (1 + realizedGrowth) ──────────
    // Stretch is applied on top separately in resolveGoal_ / getDailyGoalForDow_.
    var ppGoal    = ppY1 > 0 ? Math.round(ppY1 * (1 + realizedGrowth)) : 0;
    var flatDaily = ppGoal > 0 ? Math.round(ppGoal / PP_DAYS) : 0;

    // ── DOW averages from Y1 data, scaled by realized growth ──
    var dowBuckets = {0:[],1:[],2:[],3:[],4:[],5:[],6:[]};
    Object.keys(allByDayY1).forEach(function(day) {
      var d   = new Date(Date.UTC(Number(day.slice(0,4)), Number(day.slice(5,7))-1, Number(day.slice(8,10)), 12));
      var dow = parseInt(Utilities.formatDate(d, STORE_TZ, 'u'), 10) % 7;
      dowBuckets[dow].push(allByDayY1[day]);
    });

    var dowAvg = {};
    for (var d = 0; d <= 6; d++) {
      var vals  = dowBuckets[d];
      var base  = vals.length > 0
        ? vals.reduce(function(a, b) { return a + b; }, 0) / vals.length
        : flatDaily / (1 + realizedGrowth); // un-scale so scaling below is consistent
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

/**
 * Returns the stored stretch multiplier (e.g. 0.025 for 2.5%).
 * Clamped to [0, 0.05]. Defaults to 0 if not set.
 */
function getStretchMultiplier_() {
  var raw = PropertiesService.getScriptProperties().getProperty(GC_STRETCH_KEY);
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
  var g  = (activeGoalSource_(gr, gy) === 'yoy') ? gy : gr;

  var manualRaw = manuals[slug];
  var manualPP  = manualRaw ? parseFloat(manualRaw) : NaN;
  if (!isNaN(manualPP) && manualPP > 0) {
    var computedPP = g.ppGoal || 1;
    // If the stored override is within 1% of computedPP × (1+stretch), treat it as
    // stretch-derived rather than a true manual override. This prevents stale manual
    // values from drifting when goals are recalculated (new ppGoal in cache) while
    // still preserving true manual overrides like Portland's intentional $39k target.
    var expectedPP      = computedPP * (1 + stretch);
    var isStretchDerived = Math.abs(manualPP - expectedPP) / Math.max(expectedPP, 1) < 0.01;
    if (isStretchDerived) {
      // Fall through → use computed × stretch (same as no manual override)
    } else {
      // True manual override — scale DOW averages proportionally to the override PP
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

  return {
    revenue:            r2_(totalRevenue),
    goal:               totalGoal,
    pctToGoal:          pctToGoal,
    pace:               pace,
    paceGap:            paceGap,
    toGo:               toGo,
    projectedRevenue:   projectedRevenue,
    timeRemainingLabel: timeRemainingLabel,
    hourly:             hourly,
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
      ...trendFromByDay_(byStore30d ? aggregateByDay_(byStore30d[store.slug] || []) : {}),
      tags:          tags,
      tagTooltips:   tagTooltips,
      today:         { revenue: aggToday.sales, goal: dailyGoal, pace: todayPace, pctToGoal: dailyGoal > 0 ? r3_(aggToday.sales / dailyGoal) : 0 },
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
  const staffList = Object.values(globalEmps).map(function(emp) {
    const aov    = emp.transactions > 0 ? r2_(emp.sales / emp.transactions) : 0;
    const upt    = emp.transactions > 0 ? r1_(emp.items / emp.transactions)  : 0;
    const disc   = emp.subtotal     > 0 ? r3_(emp.discounts / emp.subtotal)   : 0;
    const empKey = emp.name.toLowerCase().replace(/\s+/g, '_');
    const trend  = trendFromByDay_(empDailyBuckets[empKey] || {});

    const tags = [];
    const staffTagTooltips = [];
    const discPct = Math.round(disc * 1000) / 10;  // e.g. 0.082 → 8.2
    if      (disc > DISCOUNT_WATCH_THRESHOLD) { tags.push('flag');  staffTagTooltips.push(discPct + '% avg discount — above 8% threshold'); }
    else if (disc > DISCOUNT_FLAG_THRESHOLD)  { tags.push('watch'); staffTagTooltips.push(discPct + '% avg discount — above 6.5% threshold'); }

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
      tagTooltips:   staffTagTooltips,
    };
  });

  // Sort by sales, assign ranks, badge top performers
  staffList.sort((a, b) => b.sales - a.sales);
  const _nicknames = getNicknames_();
  staffList.forEach(function(s, i) {
    s.rank = i + 1;
    s.name = applyNickname_(s.name, _nicknames);
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

  // Build shift strip: active employees (have transactions today) + known
  // roster employees who haven't transacted yet (shown as off-shift).
  const _excluded = getExcluded_();
  const activeEmps = Object.values(agg.byEmployee)
    .filter(emp => !_excluded.has(nameToKey_(emp.name)))
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

  // Pull in roster employees not yet seen today (apply nicknames so display is consistent)
  const _rosterNicks = getNicknames_();
  const rosterEmps = (getEmployeeRoster_()[store.slug] || [])
    .filter(e => !activeIds.has(String(e.id)) && !activeNames.has(e.name.toLowerCase()) && !_excluded.has(nameToKey_(e.name)))
    .map(e => ({
      initials: e.initials,
      name:     applyNickname_(e.name, _rosterNicks),
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
    isPreOpen:          isPreOpen,
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
    const nameKey = emp.name.toLowerCase().replace(/\s+/g, '_');
    const target  = empTargets[nameKey] || fallbackTgt;
    return {
      rank:          i + 1,
      initials:      emp.initials,
      name:          applyNickname_(emp.name, _storeNicknames),
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
    storeSlug:    store.slug,
    storeName:    store.name,
    date:         today,
    staff:        staff,
    lastUpdated:  new Date().toISOString(),
    avatarConfigs: getAvatarConfigs_(),
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

// ============================================================
// SETTINGS ENDPOINTS
// ============================================================

function getSettings_(params) {
  var nicknames = getNicknames_();
  var roster    = getEmployeeRoster_();

  // Load both goal sets (lazy, cached for PP)
  var rollingGoals   = {};
  var yoyGoals       = {};
  var rollingComputedAt = null;
  var yoyComputedAt     = null;
  var yoyFrom = null, yoyTo = null;
  var reportFrom = null, reportTo = null;
  var props = PropertiesService.getScriptProperties();
  try {
    rollingGoals = getOrComputeGoals_();
    var rMeta = {};
    try { rMeta = JSON.parse(props.getProperty(GC_GOALS_CACHE_KEY) || '{}'); } catch(e) {}
    rollingComputedAt = rMeta.computedAt || null;
    reportFrom        = rMeta.reportFrom  || null;
    reportTo          = rMeta.reportTo    || null;
  } catch(e) { Logger.log('getSettings_: rolling load failed: ' + e.message); }

  try {
    yoyGoals = getOrComputeYoYGoals_();
    var yMeta = {};
    try { yMeta = JSON.parse(props.getProperty(GC_YOY_GOALS_KEY) || '{}'); } catch(e) {}
    yoyComputedAt = yMeta.computedAt || null;
    yoyFrom       = yMeta.yoyFrom    || null;
    yoyTo         = yMeta.yoyTo      || null;
  } catch(e) { Logger.log('getSettings_: yoy load failed: ' + e.message); }

  var DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Flatten roster
  var empMap = {};
  STORES.forEach(function(store) {
    (roster[store.slug] || []).forEach(function(emp) {
      var key = nameToKey_(emp.name);
      if (!empMap[key] && emp.name && emp.name !== 'Unknown') {
        empMap[key] = { key: key, name: emp.name, store: store.name };
      }
    });
  });
  var employees = Object.values(empMap).sort(function(a, b) {
    return a.name.localeCompare(b.name);
  });

  var pt = ptNow_();

  function buildGoalRow(g, gRolling) {
    var monthly = g.dowAvg
      ? computeAccurateMonthly_(g.dowAvg, pt.year, pt.month)
      : (g.monthly || 0);
    // delta vs rolling PP (only meaningful for YoY rows)
    var delta = (gRolling && gRolling.ppGoal && g.ppGoal)
      ? g.ppGoal - gRolling.ppGoal : null;
    return {
      ppGoal:  g.ppGoal  || 0,
      monthly: monthly,
      ppStart: g.ppStart || null,
      ppEnd:   g.ppEnd   || null,
      dowAvg:  g.dowAvg  || {},
      delta:   delta,
    };
  }

  var allEmployees = employees.concat(getManagementEmployees_());
  var excluded = Array.from(getExcluded_());
  return {
    ok:               true,
    stretch:          getStretchMultiplier_(),
    rollingComputedAt: rollingComputedAt,
    yoyComputedAt:    yoyComputedAt,
    reportFrom:       reportFrom,
    reportTo:         reportTo,
    yoyFrom:          yoyFrom,
    yoyTo:            yoyTo,
    dowLabels:        DOW_LABELS,
    goals:            STORES.map(function(s) {
      var gr       = rollingGoals[s.slug] || {};
      var gy       = yoyGoals[s.slug]    || {};
      var src      = activeGoalSource_(gr, gy);   // 'rolling' | 'yoy'
      var stretch  = getStretchMultiplier_();
      var manuals  = getManualPPGoals_();
      var manualPP = manuals[s.slug] ? parseFloat(manuals[s.slug]) : null;
      var computedActivePP = (src === 'yoy' ? gy : gr).ppGoal || 0;
      // If stored manual is within 1% of computed×stretch, treat as stretch-derived
      // (not a true manual). This keeps settings input in sync after goals recalculate.
      var expectedPP       = computedActivePP * (1 + stretch);
      var isStretchDerived = manualPP && manualPP > 0 && computedActivePP > 0 &&
        Math.abs(manualPP - expectedPP) / Math.max(expectedPP, 1) < 0.01;
      var effectivePP = (manualPP && manualPP > 0 && !isStretchDerived)
        ? manualPP
        : Math.round(computedActivePP * (1 + stretch));
      var hasManual = !!(manualPP && manualPP > 0 && !isStretchDerived);
      return {
        slug:         s.slug,
        name:         s.name,
        rolling:      buildGoalRow(gr, null),
        yoy:          buildGoalRow(gy, gr),
        active:       buildGoalRow(src === 'yoy' ? gy : gr, null),
        activeSource: src,
        effectivePP:  effectivePP,
        hasManual:    hasManual,
      };
    }),
    nicknames:        nicknames,
    employees:        allEmployees,
    excluded:         excluded,
    manualGoals:      getManualPPGoals_(),
    avatarConfigs:    resolveAvatarConfigs_(allEmployees, getAvatarConfigs_()),
  };
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

/** Returns the full avatar config map { nameKey: configObject }. */
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

function getAvatarConfigs_() {
  var raw = PropertiesService.getScriptProperties().getProperty(GC_AVATAR_CONFIGS_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch(e) { return {}; }
}

/**
 * Returns director/owner users as employee-like objects for the Management section.
 * Derives the list from existing GC_USERS_KEY entries with role director/owner.
 */
// Job titles for management users — keyed by username (login name)
const MANAGEMENT_JOB_TITLES = {
  'sky':   'President',
  'mike':  'Director of Retail',
  'shawn': 'Director of Internal Operations',
  'tawny': 'Inventory Manager',
};

function getManagementEmployees_() {
  var props = PropertiesService.getScriptProperties();
  var users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  var mgmt = [];
  Object.keys(users).forEach(function(username) {
    var u = users[username];
    if (u.role === 'director' || u.role === 'owner') {
      var key = nameToKey_(u.displayName || username);
      mgmt.push({
        key:       key,
        name:      u.displayName || username,
        initials:  u.initials || username.slice(0, 2).toUpperCase(),
        section:   'management',
        roleLabel: 'Admin',
        jobTitle:  MANAGEMENT_JOB_TITLES[username] || '',
      });
    }
  });
  return mgmt.sort(function(a, b) { return a.name.localeCompare(b.name); });
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

function saveSettings_(params) {
  var props = PropertiesService.getScriptProperties();

  // Save nicknames
  if (params.nicknames !== undefined) {
    try {
      var n = JSON.parse(params.nicknames);
      Object.keys(n).forEach(function(k) { if (!n[k]) delete n[k]; });
      props.setProperty(GC_NICKNAMES_KEY, JSON.stringify(n));
    } catch(e) {
      return { ok: false, error: 'Invalid nicknames JSON: ' + e.message };
    }
  }

  // Save excluded employees
  if (params.excluded !== undefined) {
    try {
      var ex = JSON.parse(params.excluded);
      if (!Array.isArray(ex)) throw new Error('not an array');
      props.setProperty(GC_EXCLUDED_KEY, JSON.stringify(ex));
    } catch(e) {
      return { ok: false, error: 'Invalid excluded JSON: ' + e.message };
    }
  }

  // Save stretch multiplier (0–0.05)
  if (params.stretch !== undefined) {
    var newS = parseFloat(params.stretch);
    if (isNaN(newS)) return { ok: false, error: 'Invalid stretch value' };
    newS = Math.max(0, Math.min(0.05, newS));

    // Auto-rescale stretch-derived manual PP overrides to the new stretch level.
    // "Stretch-derived" = stored value is within $50 of computedBase × (1 + oldStretch).
    // True manual overrides (e.g. Portland intentionally set above computed) are left alone.
    var oldS = parseFloat(props.getProperty(GC_STRETCH_KEY) || '0') || 0;
    if (Math.abs(newS - oldS) > 0.0001) {
      try {
        var manuals  = getManualPPGoals_();
        var rGoals   = getOrComputeGoals_();
        var yGoals   = getOrComputeYoYGoals_();
        var newManuals = {};
        Object.keys(manuals).forEach(function(slug) {
          var storedPP = parseFloat(manuals[slug]) || 0;
          if (!storedPP) return;
          var gr           = (rGoals && rGoals[slug]) || {};
          var gy           = (yGoals && yGoals[slug]) || {};
          var g            = (activeGoalSource_(gr, gy) === 'yoy') ? gy : gr;
          var computedBase = g.ppGoal || 0;
          if (!computedBase) { newManuals[slug] = storedPP; return; }
          // Is the stored value close to what computedBase × (1+oldStretch) would be?
          var stretchDerived = Math.abs(storedPP - computedBase * (1 + oldS)) < 50;
          newManuals[slug] = stretchDerived
            ? Math.round(computedBase * (1 + newS))   // rescale to new stretch
            : storedPP;                                // preserve true manual override
          Logger.log('[stretch rescale] ' + slug
            + ' stored=$' + storedPP + ' base=$' + computedBase
            + ' derived=' + stretchDerived + ' → $' + newManuals[slug]);
        });
        props.setProperty(GC_MANUAL_PP_KEY, JSON.stringify(newManuals));
      } catch(rescaleErr) {
        Logger.log('[stretch rescale] error (non-fatal): ' + rescaleErr.message);
      }
    }

    props.setProperty(GC_STRETCH_KEY, String(newS));
    Logger.log('[stretch] saved: ' + (newS * 100).toFixed(1) + '%');
  }

  return { ok: true };
}
