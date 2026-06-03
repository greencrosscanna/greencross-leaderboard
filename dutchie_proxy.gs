// ============================================================
//  Green Cross — Sales Performance Dashboard
//  Google Apps Script Backend (dutchie_proxy.gs)
//  Main entry point, constants, and shared utilities.
//
//  Deploy as: Execute as: User deploying the web app
//             Access: Anyone (uses our own HMAC session auth)
//
//  Phase 1 (complete): auth endpoints + static fixture data
//  Phase 2 (current):  real Dutchie API data endpoints wired
//
//  Setup checklist (run from Script Editor, not HTTP):
//    1. setUserPassword_('username', '<password>', 'director', null, 'Display Name', 'IN')
//    2. setUserPassword_('username', '<password>', 'store_manager', 'slug', 'Display Name', 'IN')
//       ... repeat for each user — do NOT commit passwords to source
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
const GC_YOY1_CACHE_KEY     = 'GC_YOY1_CACHE_JSON'; // permanent cache for 1-year-ago data (busts each PP)
const GC_YOY2_CACHE_KEY     = 'GC_YOY2_CACHE_JSON'; // permanent cache for 2-year-ago data (busts each PP)
const GC_EXCLUDED_KEY       = 'GC_EXCLUDED_JSON';   // array of excluded employee nameKeys
const GC_ROLES_KEY           = 'GC_ROLES_JSON';          // { nameKey: 'budtender'|'asst_manager'|'store_manager' }
const ROLE_LABELS = { budtender: 'Budtender', asst_manager: 'Asst. Manager', store_manager: 'Store Manager' };
const GC_MANUAL_PP_KEY      = 'GC_MANUAL_PP_GOALS_JSON'; // slug→final PP goal overrides
const GC_AVATAR_CONFIGS_KEY  = 'GC_AVATAR_CONFIGS_JSON'; // { nameKey: { ...avatar_config } }
const GC_HOURLY_DIST_KEY     = 'GC_HOURLY_DIST_JSON';   // per-store same-DOW hourly revenue weights, cached per day
const GC_EOM_KEY             = 'gc_eom_current';         // { employeeKey, since } — Employee of the Month
const PP_DAYS                = 14;     // pay-period length in days
const TARGET_LOOKBACK_MONTHS = 6;      // rolling lookback for target calculation
const DUTCHIE_TAKE           = 5000;   // max transactions per Dutchie API page
const DUTCHIE_MAX_PAGES      = 10;     // pagination safety cap (10 × 5000 = 50k txns/store-range)
const STORE_TODAY_TTL_S      = 55;     // GAS CacheService TTL for storeToday / storeLB responses
const DUTCHIE_BASE           = 'https://api.pos.dutchie.com';

// IANA timezone — handles PDT/PST DST transitions automatically.
const STORE_TZ = 'America/Los_Angeles';

// Store open/close hours (PT, 24-hour)
const STORE_OPEN_HOUR  = 8;   // 8 am
const STORE_CLOSE_HOUR = 22;  // 10 pm
const STORE_HOURS      = STORE_CLOSE_HOUR - STORE_OPEN_HOUR; // 14

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

// Chunk size for CacheService (leave headroom below 100KB limit)
const CHUNK_SIZE = 90000; // bytes per chunk

// Request-scoped memoization — reset to null at start of each GAS execution.
var _goalsCache_    = null;
var _yoyGoalsCache_ = null;
var _ppStartCache_  = null;   // currentPPStart_() result for this execution
var _propsCache_    = null;   // getProps_() — ScriptProperties singleton per execution

// ── Pay-period helpers ───────────────────────────────────────────────────────

/**
 * Returns the ScriptProperties object, reading it only once per GAS execution.
 * Use this instead of PropertiesService.getScriptProperties() in hot paths.
 */
function getProps_() {
  if (!_propsCache_) _propsCache_ = PropertiesService.getScriptProperties();
  return _propsCache_;
}

/**
 * Returns the UTC-ms start of the CURRENT pay period, plus PP_MS (the period length).
 * Reads the anchor once per GAS execution and caches the result in _ppStartCache_.
 *
 * @param  {GoogleAppsScript.Properties.Properties=} props  Optional pre-fetched ScriptProperties.
 * @return {{ ppStartMs: number, PP_MS: number }}
 */
function currentPPStart_(props) {
  if (_ppStartCache_) return _ppStartCache_;
  var p         = props || getProps_();
  var anchorStr = p.getProperty(GC_PAY_PERIOD_ANCHOR) || '2026-05-11';
  var anchorMs  = ptDateToUtcMs_(anchorStr);
  var PP_MS     = PP_DAYS * 24 * 60 * 60 * 1000;
  var todayMs   = ptDateToUtcMs_(ptNow_().dateStr);
  var daysSince = Math.round((todayMs - anchorMs) / (24 * 60 * 60 * 1000));
  var ppOffset  = daysSince >= 0
    ? Math.floor(daysSince / PP_DAYS)
    : Math.ceil(daysSince / PP_DAYS) - 1;
  _ppStartCache_ = { ppStartMs: anchorMs + ppOffset * PP_MS, PP_MS: PP_MS };
  return _ppStartCache_;
}

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

      // Serve from proactive cache — set by the 2-minute time trigger.
      // Browser requests make zero Dutchie UrlFetch calls when cache is warm.
      const dirCacheKey = 'gc_dirall_v2_' + period;
      const dirCache    = CacheService.getScriptCache();
      try {
        const chunks = getChunkedCache_(dirCache, dirCacheKey);
        if (chunks) return jsonOut(JSON.parse(chunks), params.callback);
      } catch(e) { /* cache miss or parse error — fall through to fetch */ }

      // Cache cold (first load or after GAS restart) — fetch now and warm it.
      const result = buildDirectorAll_(period);
      saveChunkedCache_(dirCache, dirCacheKey, JSON.stringify(result), 360);
      return jsonOut(result, params.callback);
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
      const store    = requireStore_(auth, params.store);
      const todayRes = getStoreToday(store, params);
      todayRes.eomKey = (getEomCurrent_() || {}).employeeKey || null;
      return jsonOut(todayRes, params.callback);
    }
    if (params.action === 'storeleaderboard') {
      const store  = requireStore_(auth, params.store);
      const lbRes  = getStoreLeaderboard(store, params);
      lbRes.eomKey = (getEomCurrent_() || {}).employeeKey || null;
      return jsonOut(lbRes, params.callback);
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
    if (params.action === 'prefetchyoy1') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(prefetchYoY1_(), params.callback);
    }
    if (params.action === 'prefetchyoy2') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(prefetchYoY2_(), params.callback);
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
    if (params.action === 'storediag') {
      requireRole_(auth, ['owner','director']);
      var diagSlug = params.store || 'river';
      var diagProps = PropertiesService.getScriptProperties();
      var stretch   = getStretchMultiplier_();

      // Rolling cache (stored as { ppStart, goals: { slug: {...} } })
      var rollingCache = {};
      try { rollingCache = JSON.parse(diagProps.getProperty(GC_GOALS_CACHE_KEY) || '{}'); } catch(e2) {}
      var gr = (rollingCache.goals && rollingCache.goals[diagSlug]) || {};

      // YoY cache
      var yoyCache = {};
      try { yoyCache = JSON.parse(diagProps.getProperty(GC_YOY_GOALS_KEY) || '{}'); } catch(e2) {}
      var gy = (yoyCache.goals && yoyCache.goals[diagSlug]) || {};

      // Y1 sub-cache
      var y1Cache = {};
      try { y1Cache = JSON.parse(diagProps.getProperty(GC_YOY1_CACHE_KEY) || '{}'); } catch(e2) {}
      var y1PP  = (y1Cache.ppTotals  && y1Cache.ppTotals[diagSlug])  || 0;
      var y1Dow = (y1Cache.dowAvg    && y1Cache.dowAvg[diagSlug])    || {};

      // Y2 sub-cache
      var y2Cache = {};
      try { y2Cache = JSON.parse(diagProps.getProperty(GC_YOY2_CACHE_KEY) || '{}'); } catch(e2) {}
      var y2PP = (y2Cache.totals && y2Cache.totals[diagSlug]) || 0;

      // Resolved goal (what the kiosk actually uses)
      var resolved = resolveGoal_(diagSlug);
      var pt = ptNow_();

      return jsonOut({
        store:      diagSlug,
        stretch:    stretch,
        y1CacheKey: y1Cache.key || null,
        y2CacheKey: y2Cache.key || null,
        y1PP:       Math.round(y1PP),
        y2PP:       Math.round(y2PP),
        realizedGrowth: gy.realizedGrowth || 0,
        rolling: {
          ppGoal:    gr.ppGoal  || 0,
          monthly:   gr.monthly || 0,
          dowAvg:    gr.dowAvg  || {},
          computedAt: gr.computedAt || null,
        },
        yoy: {
          ppGoal:    gy.ppGoal  || 0,
          monthly:   gy.monthly || 0,
          dowAvg:    gy.dowAvg  || {},
          yoyFrom:   gy.yoyFrom || null,
          yoyTo:     gy.yoyTo   || null,
          computedAt: gy.computedAt || null,
        },
        resolved: {
          effectivePP: resolved.effectivePP,
          useManual:   resolved.useManual,
          stretch:     resolved.stretch,
          dowAvg:      resolved.g.dowAvg || {},
          todayDow:    pt.dow,
          todayGoal:   getDailyGoal_(diagSlug),
        },
      }, params.callback);
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

    if (params.action === 'saveeom') {
      requireRole_(auth, ['owner','director']);
      var eomKey = params.key || null;
      if (eomKey) {
        PropertiesService.getScriptProperties().setProperty(GC_EOM_KEY,
          JSON.stringify({ employeeKey: eomKey, since: new Date().toISOString() }));
      } else {
        PropertiesService.getScriptProperties().deleteProperty(GC_EOM_KEY);
      }
      return jsonOut({ ok: true }, params.callback);
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

    // ── Historical EOD snapshots ───────────────────────────
    if (params.action === 'historicaldir') {
      requireRole_(auth, ['owner','director']);
      var dateStr = (params.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return jsonOut({ ok: false, error: 'Invalid date — expected YYYY-MM-DD' }, params.callback);
      }
      return jsonOut(getHistoricalDirector_(dateStr), params.callback);
    }

    if (params.action === 'bugreport') {
      return jsonOut(handleBugReport_(params), params.callback);
    }

    if (params.action === 'renew') {
      // Silently re-issue a fresh session token (used by the client heartbeat).
      if (!auth.ok) return jsonOut({ ok: false, error: auth.error || 'Auth required' }, params.callback);
      const newToken = issueSessionToken_(auth.user);
      const newExp   = new Date(Date.now() + GC_SESSION_TTL_MS).toISOString();
      return jsonOut({ ok: true, token: newToken, expiresAt: newExp }, params.callback);
    }

    if (params.action === 'setuptrigger') {
      requireRole_(auth, ['owner','director']);
      setupDirectorTrigger();
      return jsonOut({ ok: true, message: 'Trigger installed and cache warmed.' }, params.callback);
    }

    return jsonOut({ ok: false, error: 'Unknown action: ' + params.action }, params.callback);

  } catch(err) {
    Logger.log('doGet error: ' + err.message + '\n' + err.stack);
    return jsonOut({ ok: false, error: err.message }, params.callback);
  }
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
  // ⚠️  Credentials have been removed from source control.
  // Users are already live in ScriptProperties (GC_STORE_USERS_KEY).
  //
  // To add or update a single user, call setUserPassword_() directly from the
  // Script Editor with the desired credentials — do NOT commit passwords to source.
  //
  // To remove stale placeholder accounts from an earlier dev build, uncomment:
  // const props = PropertiesService.getScriptProperties();
  // const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  // ['sofia','maya','devon','priya','marcus','tyler'].forEach(k => delete users[k]);
  // props.setProperty(GC_USERS_KEY, JSON.stringify(users));

  Logger.log('bootstrapAllUsers: credentials are managed in ScriptProperties — nothing to do here.');
}

// ── Run once from Script Editor to add/update director accounts ──
// Safe to re-run — only updates the listed users, leaves others intact.
function bootstrapDirectors() {
  // ⚠️  Credentials removed from source — see bootstrapAllUsers() comment above.
  // Use setUserPassword_() from the Script Editor to update individual accounts.
  Logger.log('bootstrapDirectors: credentials are managed in ScriptProperties — nothing to do here.');
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
  // ⚠️  API keys removed from source — keys are stored in ScriptProperties
  // under DUTCHIE_STORE_KEYS_JSON.  To update a key use the setstorekeys
  // HTTP action (director/owner role required) or set the property directly
  // in the GAS Script Editor → Project Settings → Script Properties.
  Logger.log('bootstrapStoreKeys: keys are managed in ScriptProperties — nothing to do here.');
}

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

// ── Morning cache warm-up ─────────────────────────────────
// Runs via time-based trigger at 7:50am PT so the first kiosk
// viewer at open doesn't pay the cold-start Dutchie fetch penalty.
// Warms storetoday AND storeleaderboard so fetchKioskAll (which needs
// both) renders the heatmap instantly on first page view.
function warmAllKioskCaches_() {
  STORES.forEach(function(store) {
    try {
      getStoreToday(store, {});
      Logger.log('[warmup] storetoday ' + store.slug + ' cached');
    } catch(e) {
      Logger.log('[warmup] storetoday ' + store.slug + ' failed: ' + e.message);
    }
    try {
      getStoreLeaderboard(store, {});
      Logger.log('[warmup] storeleaderboard ' + store.slug + ' cached');
    } catch(e) {
      Logger.log('[warmup] storeleaderboard ' + store.slug + ' failed: ' + e.message);
    }
  });
}

// Run once from the GAS editor to install the daily 7:50am PT trigger.
// PT = UTC-8 (PST) / UTC-7 (PDT); trigger at UTC hour 15 covers both.
function installWarmupTrigger() {
  // Remove any existing warmup triggers
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'warmAllKioskCaches_'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });

  // Install daily trigger at 14:00–15:00 UTC (7–8am PT covers PST+PDT)
  ScriptApp.newTrigger('warmAllKioskCaches_')
    .timeBased()
    .atHour(15)
    .everyDays(1)
    .create();

  Logger.log('[warmup] Trigger installed — fires daily at UTC 15:xx (~7:50am PT)');
}

// ── Bug reporter ─────────────────────────────────────────────
function handleBugReport_(b) {
  const props   = PropertiesService.getScriptProperties();
  let   bugSsId = props.getProperty('GC_LEADERBOARD_BUG_SS_ID');
  let   bugSs;

  if (!bugSsId) {
    bugSs   = SpreadsheetApp.create('GC Leaderboard — Bug Reports');
    bugSsId = bugSs.getId();
    props.setProperty('GC_LEADERBOARD_BUG_SS_ID', bugSsId);
  } else {
    bugSs = SpreadsheetApp.openById(bugSsId);
  }

  let sheet = bugSs.getSheetByName('Bugs');
  if (!sheet) {
    sheet = bugSs.getSheets()[0];
    sheet.setName('Bugs');
    sheet.getRange(1, 1, 1, 8).setValues([[
      'Timestamp', 'Reporter', 'Priority', 'Title', 'Description', 'Store', 'Role', 'Version / Route'
    ]]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
  }

  const ts = new Date();
  sheet.appendRow([
    ts,
    b.reporter  || '',
    b.priority  || 'medium',
    b.title     || '',
    b.desc      || '',
    b.appStore  || '',
    b.appRole   || '',
    ((b.appVer || '') + ' ' + (b.appRoute || '')).trim(),
  ]);

  try {
    const emoji = { low: '🟢', medium: '🟡', high: '🔴' }[b.priority] || '🟡';
    MailApp.sendEmail({
      to:      'sky@greencrosscanna.com',
      subject: emoji + ' Leaderboard Bug [' + (b.priority || 'medium') + ']: ' + b.title,
      body: [
        'Reporter : ' + (b.reporter || ''),
        'Priority : ' + (b.priority || 'medium'),
        'Store    : ' + (b.appStore || ''),
        'Role     : ' + (b.appRole  || ''),
        'Version  : ' + (b.appVer   || ''),
        'Route    : ' + (b.appRoute || ''),
        'Time     : ' + Utilities.formatDate(ts, STORE_TZ, 'M/d/yy h:mm a'),
        '',
        b.desc || '(no details provided)',
      ].join('\n'),
    });
  } catch(mailErr) { /* non-fatal */ }

  return { ok: true };
}

// ============================================================
// SETTINGS ENDPOINTS
// ============================================================

// Job titles for management users — keyed by username (login name)
const MANAGEMENT_JOB_TITLES = {
  'sky':   'President',
  'mike':  'Director of Retail',
  'shawn': 'Director of Internal Operations',
  'tawny': 'Inventory Manager',
};

/**
 * Returns director/owner users as employee-like objects for the Management section.
 * Derives the list from existing GC_USERS_KEY entries with role director/owner.
 */
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
  var props = getProps_();
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
      var stretch  = getStretchMultiplier_();
      var manuals  = getManualPPGoals_();
      var manualPP = manuals[s.slug] ? parseFloat(manuals[s.slug]) : null;
      // Always use max(rolling, yoy) as the computed base
      var rPP = gr.ppGoal || 0;
      var yPP = gy.ppGoal || 0;
      var computedActivePP = Math.max(rPP, yPP);
      // Treat saved manual as auto-derived only if it matches max(R,Y)×stretch
      // within 1% — i.e. the user saved the computed value rather than a true override.
      var expectedPP = computedActivePP * (1 + stretch);
      var isStretchDerived = !!(manualPP && manualPP > 0 && expectedPP > 0 &&
        Math.abs(manualPP - expectedPP) / expectedPP < 0.01);
      var effectivePP = (manualPP && manualPP > 0 && !isStretchDerived)
        ? manualPP
        : Math.round(computedActivePP * (1 + stretch));
      var hasManual = !!(manualPP && manualPP > 0 && !isStretchDerived);
      var src = (yPP > rPP) ? 'yoy' : 'rolling'; // for activeSource label only
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
    eom:              getEomCurrent_(),  // { employeeKey, since } | null
    roles:            getRoles_(),
  };
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

  // Save employee roles
  if (params.roles !== undefined) {
    try {
      var ro = JSON.parse(params.roles);
      props.setProperty(GC_ROLES_KEY, JSON.stringify(ro));
    } catch(e) {
      return { ok: false, error: 'Invalid roles JSON: ' + e.message };
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
