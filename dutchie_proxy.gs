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
//    4. Store Dutchie keys: Script Properties → DUTCHIE_STORE_KEYS_JSON, keyed by GX CORE store_id:
//       {"bend":"key...","center":"key...","commercial":"key...","hillsboro":"key...","portland-rd":"key...","river-rd":"key..."}
//       (Before 2026-08-29 this was keyed by Dutchie store NAME. The example here used a THIRD set
//        of labels again — "Baseline"/"Century"/"River Rd" — matching neither the property nor Core.
//        Keyed by store_id there is exactly one correct spelling, and it is the one Core publishes.)
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
// Store-level rolling PP targets, written nightly by refreshTargetsAll. It owns this
// property outright: it rebuilds the whole object and setProperty REPLACES, so anything
// else stored here is erased at 3am. Per-employee daily targets used to share it and were
// silently wiped every night -- they now live in GC_EMP_TARGET_CACHE_KEY below.
const GC_TARGET_CACHE_KEY   = 'GC_ROLLING_TARGET_CACHE_JSON';
// Per-employee daily targets, keyed '<slug>:dow:<yyyy-MM-dd>' -> { nameKey: dollars }.
const GC_EMP_TARGET_CACHE_KEY = 'GC_EMP_TARGET_CACHE_JSON';
const GC_GOALS_CACHE_KEY    = 'GC_GOALS_CACHE_JSON';
const GC_STRETCH_KEY        = 'GC_STRETCH_MULTIPLIER';  // stored as decimal, e.g. 0.025 = 2.5%
const GC_YOY_GOALS_KEY      = 'GC_YOY_GOALS_JSON';
const GC_YOY1_CACHE_KEY     = 'GC_YOY1_CACHE_JSON'; // permanent cache for 1-year-ago data (busts each PP)
const GC_YOY2_CACHE_KEY     = 'GC_YOY2_CACHE_JSON'; // permanent cache for 2-year-ago data (busts each PP)
const GC_EXCLUDED_KEY       = 'GC_EXCLUDED_JSON';   // array of excluded employee nameKeys
const GC_ROLES_KEY           = 'GC_ROLES_JSON';          // { nameKey: 'budtender'|'asst_manager'|'store_manager' }
const ROLE_LABELS = { budtender: 'Budtender', asst_manager: 'Asst. Manager', store_manager: 'Store Manager' };
const GC_MANUAL_PP_KEY      = 'GC_MANUAL_PP_GOALS_JSON'; // slug→final PP goal overrides
// Kiosk display: show the SPIFF sell-through row on staff cards. Stored as TEXT 'true'/'false'
// per the suite rule (booleans are text; read with a truthy check, never === true). Default
// OFF -- SPIFF is a vendor program that is not always running, and an empty row on every
// card is worse than no row at all.
const GC_SPIFF_SHOW_KEY     = 'GC_SPIFF_SHOW';
const GC_AVATAR_CONFIGS_KEY  = 'GC_AVATAR_CONFIGS_JSON'; // { nameKey: { ...avatar_config } }
const GC_HOURLY_DIST_KEY     = 'GC_HOURLY_DIST_JSON';   // per-store same-DOW hourly revenue weights, cached per day
const GC_EOM_KEY             = 'gc_eom_current';         // { employeeKey, since } — Employee of the Month
const GC_INCENTIVE_INPUTS_KEY = 'GC_INCENTIVE_INPUTS_JSON';  // { ppStart: { nameKey: { att:bool, spiff:num } } }
const GC_INCENTIVE_THRESH_KEY = 'GC_INCENTIVE_THRESH_JSON';  // editable bonus thresholds (see incentiveDefaults_)
const PP_DAYS                = 14;     // pay-period length in days
const TARGET_LOOKBACK_MONTHS = 6;      // rolling lookback for target calculation
const DUTCHIE_TAKE           = 5000;   // Take param sent to Dutchie; also the truncation-warning threshold
const STORE_TODAY_TTL_S      = 55;     // GAS CacheService TTL for storeToday / storeLB responses
const DUTCHIE_BASE           = 'https://api.pos.dutchie.com';

// IANA timezone — handles PDT/PST DST transitions automatically.
const STORE_TZ = 'America/Los_Angeles';

// Store open/close hours (PT, 24-hour)
const STORE_OPEN_HOUR  = 8;   // 8 am
const STORE_CLOSE_HOUR = 22;  // 10 pm
const STORE_HOURS      = STORE_CLOSE_HOUR - STORE_OPEN_HOUR; // 14

// Discount flag threshold — the "Flagged Staff" KPI counts staff over this on the
// discretionary discount basis. Aligned with the leaderboard "red" color (>3%).
const DISCOUNT_FLAG_THRESHOLD  = 0.03;
const DISCOUNT_WATCH_THRESHOLD = 0.080;   // (unused since the flat-threshold discount tags/panel were retired)

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
//
// storeId = the GX Core `store_id` slug. It is BOTH the join key to Core's stores tab AND the key
// into DUTCHIE_STORE_KEYS_JSON. Credentials are keyed by store_id and nothing else.
//
// This field replaced `dutchieName` on 2026-08-29. That field held a Dutchie key LABEL, and this
// project's labels had Bend and Hillsboro TRANSPOSED relative to Core, Inventory and Sales — so the
// table below carried a compensating swap (slug 'century' → dutchieName 'Hillsboro') to cancel it out.
// Two errors multiplying to the right answer is why the mapping kept getting "fixed" and breaking the
// kiosk (PR #8, 2026-08-26). store_id is Core-owned and unambiguous, so the swap cannot recur.
const STORES = [
  { slug: 'baseline',   name: 'Baseline',   storeId: 'hillsboro',   locationName: 'Hillsboro'   },
  { slug: 'center',     name: 'Center',     storeId: 'center',      locationName: 'Center'      },
  { slug: 'century',    name: 'Century',    storeId: 'bend',        locationName: 'Bend'        },
  { slug: 'commercial', name: 'Commercial', storeId: 'commercial',  locationName: 'Commercial'  },
  { slug: 'portland',   name: 'Portland',   storeId: 'portland-rd', locationName: 'Portland Rd' },
  { slug: 'river',      name: 'River',      storeId: 'river-rd',    locationName: 'River'       },
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
 * Returns the CURRENT pay period's boundaries. Reads the anchor once per GAS execution and
 * caches the result in _ppStartCache_.
 *
 * Prefer ppStartStr/ppEndStr/ppEndMs over doing arithmetic on ppStartMs — see ppShift_ for why
 * `ppStartMs ± n * PP_MS` is a trap.
 *
 * @param  {GoogleAppsScript.Properties.Properties=} props  Optional pre-fetched ScriptProperties.
 * @return {{ ppStartMs: number, ppEndMs: number, ppStartStr: string, ppEndStr: string, PP_MS: number }}
 */
function currentPPStart_(props) {
  if (_ppStartCache_) return _ppStartCache_;
  var p         = props || getProps_();
  var anchorStr = p.getProperty(GC_PAY_PERIOD_ANCHOR) || '2026-05-11';
  var anchorMs  = ptDateToUtcMs_(anchorStr);
  var PP_MS     = PP_DAYS * 24 * 60 * 60 * 1000;
  var todayMs   = ptDateToUtcMs_(ptNow_().dateStr);
  // Math.round absorbs the ±1h a DST change puts into this difference, so the OFFSET is safe.
  var daysSince = Math.round((todayMs - anchorMs) / (24 * 60 * 60 * 1000));
  var ppOffset  = daysSince >= 0
    ? Math.floor(daysSince / PP_DAYS)
    : Math.ceil(daysSince / PP_DAYS) - 1;
  // Applying that offset is what used to be unsafe. This was `anchorMs + ppOffset * PP_MS`, which
  // lands an hour off PT midnight whenever the anchor and the target period sit on opposite sides
  // of a DST change — and an hour before midnight formats to the PREVIOUS DAY. With the 2026-05-11
  // (PDT) anchor that silently mis-dated every period before 2026-03-08, and would have moved the
  // LIVE period a day early from 2026-11-09. Shift calendar days instead; see ppShift_.
  var ppStartStr = ptDateShift_(anchorStr, ppOffset * PP_DAYS);
  var ppStartMs  = ptDateToUtcMs_(ppStartStr);
  _ppStartCache_ = {
    ppStartMs:  ppStartMs,
    // Derived from the NEXT period's start, so a DST-crossing period is still exactly 14 days.
    ppEndMs:    ptDateToUtcMs_(ptDateShift_(ppStartStr, PP_DAYS)) - 1,
    ppStartStr: ppStartStr,
    ppEndStr:   ptDateShift_(ppStartStr, PP_DAYS - 1),
    // Nominal length. Fine as a DURATION (elapsed fractions, flat daily splits); never use it to
    // derive a boundary date — that is ppShift_/ppEndMs_'s job.
    PP_MS:      PP_MS,
  };
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
 * Shift a PT calendar date by whole days. 'YYYY-MM-DD' in, 'YYYY-MM-DD' out.
 *
 * Date.UTC arithmetic on the y/m/d parts never touches a wall clock, so it cannot drift across a
 * DST change the way `ms + n * 86400000` does. Pay periods are defined in CALENDAR days — "the
 * period starts on the 17th" — so calendar arithmetic is the honest model for them.
 */
function ptDateShift_(ptDateStr, days) {
  const [y, mo, d] = ptDateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * UTC-ms of the PT midnight starting the pay period `n` periods away from the one at ppStartMs.
 * n is negative to walk backwards.
 *
 * ALWAYS use this instead of `ppStartMs ± n * PP_MS`. PP_MS is a NOMINAL 14 days; a period that
 * contains a DST change is 14 calendar days but 335 or 337 hours, so fixed-ms arithmetic lands an
 * hour off true midnight and formats back to the WRONG DATE — one day early going back from a PDT
 * anchor into PST. That is not hypothetical: it put five backfilled periods in GX Core period_goals
 * a day early, and made 2026-03-01..2026-03-15 a fifteen-day period carrying a 14-day goal total.
 */
function ppShift_(ppStartMs, n) {
  const startStr = Utilities.formatDate(new Date(ppStartMs), STORE_TZ, 'yyyy-MM-dd');
  return ptDateToUtcMs_(ptDateShift_(startStr, n * PP_DAYS));
}

/** Last millisecond of the pay period starting at ppStartMs (i.e. next period's start, minus 1). */
function ppEndMs_(ppStartMs) {
  return ppShift_(ppStartMs, 1) - 1;
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
  /* Apps Script reuses a warm instance between requests, so any module-level memo outlives the
     request that filled it. Thresholds now live in GX Core and Sky edits them there; a stale copy
     here means an edit silently does nothing until the instance recycles. Cleared per request. */
  _incThreshCache_ = null;
  /* Same reason, same fix: the discretionary-discount OVERRIDES moved to GX Core kv `discountRules`
     (2026-08-30) and GX Crew edits them there. They are memoized per execution because
     isExcludedDiscount_ runs per discount line per transaction — so the memo has to be dropped here
     or a warm kiosk instance keeps scoring against rules Crew already changed. */
  resetDiscountMemos_();

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
    // Public: board-eligibility health — counts only, no names. Reports the GXCore version we are
    // ACTUALLY running and whether home_store is arriving, because the eligibility gates fail open
    // and so break by quietly doing nothing. See gxRosterHealth_.
    if (params.action === 'rosterhealth') {
      return jsonOut(gxRosterHealth_(), params.callback);
    }
    // Public: which GXCore version this DEPLOYMENT is actually bound to. appsscript.json records the
    // PUSHED pin, and a pushed pin is not a deployed one -- those can disagree silently. Suite
    // standard, from inventory. An old pin has no libVersion(), which is itself the answer, so the
    // error is REPORTED rather than thrown: a diagnostic that 500s fails exactly when it is needed.
    if (params.action === 'libversion') {
      return jsonOut(getLibVersion_(), params.callback);
    }
    // Public: proves the write gate is really wired, including that a bogus user is actually
    // REFUSED. "hasRoleForApp:true" alone would be a comfortable lie.
    if (params.action === 'writeauthprobe') {
      return jsonOut(gxWriteAuthProbe_(), params.callback);
    }
    // Public: computed daily + monthly goals for all stores, keyed by Sales Dashboard names.
    // No auth required — consumed by greencross-dashboard for the current pay period.
    if (params.action === 'getdailygoals') {
      return jsonOut(getDailyGoals_(), params.callback);
    }

    // Public: store registry (incl. colors) from GX Core — single source. Colors aren't sensitive;
    // the frontend overlays these onto its hardcoded fallback so a Command Center color edit
    // propagates without an app deploy.
    if (params.action === 'gxstores') {
      return jsonOut(getGxStores_(), params.callback);
    }

    // ── One-time API key bootstrap (only works if key not yet set) ─
    if (params.action === 'initapikey') {
      var props = PropertiesService.getScriptProperties();
      if (props.getProperty('GC_API_READONLY_KEY')) {
        return jsonOut({ ok: false, error: 'Already initialized' }, params.callback);
      }
      var k = (params.key || '').trim();
      if (!k) return jsonOut({ ok: false, error: 'Missing key param' }, params.callback);
      props.setProperty('GC_API_READONLY_KEY', k);
      return jsonOut({ ok: true, msg: 'API key set' }, params.callback);
    }

    // GX_DEPLOY_SECRET is set from the Apps Script console (Project Settings → Script Properties),
    // and there is deliberately NO route to set it. There was one — an unauthenticated
    // initdeploysecret that refused once the property existed — and "already set → refuse" is inert
    // only for as long as the property stays set. A properties reset or a key rename re-arms it, and
    // the next caller then sets our secret to a value of their choosing: every publish fails closed
    // and Sales quietly renders stale revenue targets. Re-setting it is a console job.

    // ── Goal publishing to GX Core — DEPLOY-SECRET gated, not session gated ───────────────
    // These are machine routes: the nightly trigger and a deploy/console operator run them, and a
    // route that needs a browser session is a route nobody can run from a shell right after a
    // deploy. Same deploy-secret-only convention the suite uses for dev_claim/dev_update, and the
    // same secret GXCore.publishGoals itself demands — so this adds no new trust, it just moves the
    // existing one to the front door. Never returns the secret, and holds no auth fallback.
    if (params.action === 'publishgoals' || params.action === 'installtargetrefresh') {
      var _pgSecret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
      if (!_pgSecret) return jsonOut({ ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' }, params.callback);
      if ((params.secret || '') !== _pgSecret) return jsonOut({ ok: false, error: 'Unauthorized' }, params.callback);

      if (params.action === 'installtargetrefresh') {
        // Idempotent; installs the nightly 3am refreshTargetsAll trigger, which is also what carries
        // the goal publish — see the tail of refreshTargetsAll.
        installTargetRefreshTrigger();
        return jsonOut({ ok: true, installed: 'refreshTargetsAll daily @ 3am PT (carries publishGoals)' }, params.callback);
      }

      // Publish now, and report whether the trigger that normally carries it actually exists. The
      // error is REPORTED rather than thrown: a publish diagnostic that 500s fails exactly when you
      // need it to tell you why nothing published.
      var _pgTrig = ScriptApp.getProjectTriggers()
        .filter(function (t) { return t.getHandlerFunction() === 'refreshTargetsAll'; }).length;
      var _pgCarrier = { handler: 'refreshTargetsAll', installed: _pgTrig > 0, count: _pgTrig };
      try {
        var _pg = publishGoalsToCore_();
        _pg.carrierTrigger = _pgCarrier;
        return jsonOut(_pg, params.callback);
      } catch (e) {
        return jsonOut({ ok: false, error: String((e && e.message) || e), carrierTrigger: _pgCarrier }, params.callback);
      }
    }

    // ── Discount RULES, for GX Crew — DEPLOY-SECRET gated ─────────────────────────────────
    // Which promotions count against a staff discount rate. They live here because they filter the
    // TRANSACTION data — the half of the incentive that stayed in Leaderboard — but they are edited
    // in Crew's settings tray alongside the thresholds, because to whoever is setting the scheme
    // they are one screen and one decision.
    //
    // READ-ONLY as of 2026-08-30. The rules moved to GX Core kv `discountRules`; GX Crew edits them
    // there through Core's secret-gated set_config, so the app-to-app WRITE into this app is gone —
    // and with it the dependency of a pay-affecting setting on this /exec being up.
    //
    // `discountrules` is KEPT anyway, as a diagnostic rather than a data source. It answers the one
    // question you actually ask when discount rates look wrong — "what rules is Leaderboard applying
    // right now, and where did it get them?" — because it returns getDiscountSettings_ with the
    // classified registry AND `source`. `source` reading 'property' or 'seed' is the whole tell that
    // this app has fallen back off Core and is scoring against a copy Crew cannot edit. Nothing else
    // in the suite can see that; Core only knows what it stores, not what we read.
    //
    // `discountrules_save` is kept ONLY to refuse in words: during the cutover a Crew build that has
    // not moved yet gets "edit it in Crew", not a silent success against a property nothing reads.
    if (params.action === 'discountrules' || params.action === 'discountrules_save') {
      var _drSecret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
      if (!_drSecret) return jsonOut({ ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' }, params.callback);
      if ((params.secret || '') !== _drSecret) return jsonOut({ ok: false, error: 'Unauthorized' }, params.callback);
      return jsonOut(params.action === 'discountrules' ? getDiscountSettings_()
                                                       : saveDiscountSettings_(params), params.callback);
    }

    // ── Incentive PERFORMANCE slice, for GX Crew — DEPLOY-SECRET gated, READ ONLY ──────────
    // The Incentive dashboard is moving to GX Crew (2026-08-26). The split that survives the move:
    // Leaderboard stays the PERFORMANCE engine — it owns the Dutchie ingest, aggregateTransactions_,
    // the discretionary-discount classification and the frozen closed-period snapshots — and Crew
    // becomes the PAYOUT app, owning the bonus math, the attendance/SPIFF inputs and the Capstone
    // export. That is Sky's own contract sentence: SPIFF sets the goals, LB tracks the performance,
    // Crew reads the performance.
    //
    // So this hands Crew exactly what `incentive` hands the browser, and NOTHING ELSE:
    //   • no save twin. Crew owns the payout state; a second writer for one pay period is how the
    //     numbers diverge, and there would be no way to tell which copy paid people.
    //   • deploy-secret, not session. incentiveAccessOk_ gates on a logged-in username (sky/mike),
    //     which a server-to-server caller does not have and should not be issued one to fake.
    //     Same convention as publishgoals above.
    //   • the FROZEN path is preserved untouched: a completed period is still computed once and
    //     cached forever, so Crew reading history cannot cause a recompute of numbers that paid
    //     people. Crew must therefore never pass refresh for a closed period, and cannot — the
    //     parameter is deliberately not forwarded.
    //
    // TEMPORARY, AND KNOWN TO BE. This is app-to-app, which the shared brain forbids: everything
    // cross-app is supposed to go through GX Core. It is here because promoting per-employee
    // performance into GX Core needs a core-admin change plus an immutable library cut plus a
    // re-pin in every spoke, and Mike needs Incentive in Crew this week. A brain note is filed
    // asking for that promotion; SPIFF wants the same per-employee data, which is what justifies
    // doing it properly. DELETE THIS ROUTE when GX Core exposes the slice.
    // Placed ABOVE requireAuth_ deliberately: this is a machine caller with a secret and no
    // session, and every route below that line is rejected as 'not signed in' before it is
    // reached. publishgoals sits up here for the same reason.
    if (params.action === 'incentiveperf') {
      var _ipSecret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
      if (!_ipSecret) return jsonOut({ ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' }, params.callback);
      if ((params.secret || '') !== _ipSecret) return jsonOut({ ok: false, error: 'Unauthorized' }, params.callback);
      var _ipData = getIncentiveData_(params.ppStart, false);   // never forces a refresh — see above
      _ipData.source = 'leaderboard';                            // so a Crew payload always says where its numbers came from
      return jsonOut(_ipData, params.callback);
    }

    // Secret-gated, read-only: how today's per-employee targets were derived for one
    // store. Same secret as incentiveperf. Exists because the target is a per-person
    // rolling average, so "why is X's target above Y's" is only answerable from the
    // inputs — and clasp run is unavailable here, so diagnostics ship as web actions.
    /* Read-only inventory of the FROZEN closed-period snapshots.
     *
     * Incentive is being extracted from this app. These snapshots are the one piece of it that
     * exists ONLY here: GC_INC_PERF_v2_<ppStart> in this project's Script Properties, written once
     * when a period closes and deliberately never recomputed, because they are the numbers that
     * paid people. Crew's imported history covers 2025-08-04..2026-08-16 from the payout PDFs, so
     * anything AFTER that date has no second copy anywhere.
     *
     * Nothing can be safely deleted from this app until that set is known, so this names it. It
     * returns period keys, row counts and totals — never a person, never an amount per person. */
    /* Hand ONE frozen period over verbatim, so it can be archived in GX Core as the fixture the
     * engine port is validated against. Deliberately one period per call and never a bulk dump:
     * this is per-person sales data behind a compensation number, and a route that returns all 29
     * at once is a route somebody eventually calls by accident. */
    if (params.action === 'frozenperiod') {
      var _f1Secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
      if (!_f1Secret) return jsonOut({ ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' }, params.callback);
      if ((params.secret || '') !== _f1Secret) return jsonOut({ ok: false, error: 'Unauthorized' }, params.callback);
      var _f1Start = String(params.pp_start || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(_f1Start)) return jsonOut({ ok: false, error: 'pp_start required (YYYY-MM-DD)' }, params.callback);
      var _f1All = PropertiesService.getScriptProperties().getProperties();
      // Accept either key generation: the v1 keys predate the v2 aggregation and still hold real periods.
      var _f1Key = ['GC_INC_PERF_v2_' + _f1Start, 'GC_INC_PERF_' + _f1Start]
        .filter(function (k) { return _f1All[k]; })[0];
      if (!_f1Key) return jsonOut({ ok: false, error: 'no frozen snapshot for ' + _f1Start }, params.callback);
      return jsonOut({ ok: true, pp_start: _f1Start, key: _f1Key,
                       bytes: String(_f1All[_f1Key]).length, payload: _f1All[_f1Key] }, params.callback);
    }

    if (params.action === 'frozenperiods') {
      var _fpSecret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
      if (!_fpSecret) return jsonOut({ ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' }, params.callback);
      if ((params.secret || '') !== _fpSecret) return jsonOut({ ok: false, error: 'Unauthorized' }, params.callback);
      var _fpProps = PropertiesService.getScriptProperties().getProperties();
      var _fpOut = [];
      Object.keys(_fpProps).forEach(function (k) {
        if (k.indexOf('GC_INC_PERF_') !== 0) return;
        /* STRIP ONLY A REAL VERSION SEGMENT. The first cut used /^GC_INC_PERF_v?\d*_?/, and on the
           one v1-format key (GC_INC_PERF_2026-06-22, no `v`) the \d* ate the YEAR, yielding
           '-06-22'. That period sorts below every real date, so it would silently drop out of
           exists_only_here — the single field this route exists to produce. It did not change
           today's answer only because that period predates Crew's history cutoff. A tool that
           decides which payroll data gets migrated must not have a parser that can lose a year. */
        var row = { key: k, period: k.replace(/^GC_INC_PERF_(v\d+_)?/, ''), bytes: String(_fpProps[k] || '').length };
        try {
          var parsed = JSON.parse(_fpProps[k]);
          row.stores = parsed && parsed.stores ? Object.keys(parsed.stores).length : null;
          row.sellers = parsed && parsed.sellers ? Object.keys(parsed.sellers).length
                      : (parsed && parsed.budtenders ? parsed.budtenders.length : null);
          row.top_keys = parsed ? Object.keys(parsed).slice(0, 8) : [];
        } catch (e) { row.parse_error = String(e.message || e); }
        _fpOut.push(row);
      });
      _fpOut.sort(function (a, b) { return String(a.period).localeCompare(String(b.period)); });
      // The line that matters for the extraction: which of these Crew's imported history does NOT cover.
      var CREW_HISTORY_THROUGH = '2026-08-16';
      var _fpOnlyHere = _fpOut.filter(function (r) { return r.period > CREW_HISTORY_THROUGH; })
                              .map(function (r) { return r.period; });
      return jsonOut({ ok: true, count: _fpOut.length, periods: _fpOut,
                       crew_history_through: CREW_HISTORY_THROUGH,
                       exists_only_here: _fpOnlyHere,
                       note: 'exists_only_here is what a migration must carry; the rest is duplicated in crew_incentive_history' },
                     params.callback);
    }

    if (params.action === 'emptargetdiag') {
      var _etSecret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
      if (!_etSecret) return jsonOut({ ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' }, params.callback);
      if ((params.secret || '') !== _etSecret) return jsonOut({ ok: false, error: 'Unauthorized' }, params.callback);
      return jsonOut(diagEmpTargets_(params.store || STORES[0].slug, params.dow), params.callback);
    }

    // Secret-gated, read-only: what SPIFF is returning for one store and how much of it
    // survives the window filter and the roster join. Exists for the same reason as
    // emptargetdiag: "why is there no tick on this card" is only answerable from the inputs.
    if (params.action === 'spiffdiag') {
      var _spSecret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
      if (!_spSecret) return jsonOut({ ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' }, params.callback);
      if ((params.secret || '') !== _spSecret) return jsonOut({ ok: false, error: 'Unauthorized' }, params.callback);
      return jsonOut(diagSpiff_(params.store || STORES[0].slug), params.callback);
    }

    // Secret-gated, read-only: which pacing layer is actually answering per store --
    // GX Core's shared engine, the local mirrored curve, or the LINEAR fallback. The
    // three are indistinguishable from expectedSalesFrac_'s return value alone.
    if (params.action === 'pacediag') {
      var _pdSecret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
      if (!_pdSecret) return jsonOut({ ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' }, params.callback);
      if ((params.secret || '') !== _pdSecret) return jsonOut({ ok: false, error: 'Unauthorized' }, params.callback);
      return jsonOut(diagPace_(), params.callback);
    }

    // Secret-gated, read-only: why the "Today by hour" bars disagree with the SOLD number.
    // The bars for completed hours come from a per-store-per-day snapshot in ScriptProperties while
    // SOLD is always live, so those are the two numbers to put side by side — plus the live hour
    // buckets they are meant to agree with. Calls the SHIPPED hourFreezeDisplay_ rather than
    // re-deriving the rule here: a diagnostic that rebuilds the logic reports the logic it carries,
    // not the one running. WRITES NOTHING — the healed snapshot is shown, not persisted.
    if (params.action === 'hourdiag') {
      var _hdSecret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
      if (!_hdSecret) return jsonOut({ ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' }, params.callback);
      if ((params.secret || '') !== _hdSecret) return jsonOut({ ok: false, error: 'Unauthorized' }, params.callback);
      return jsonOut(diagHourFreeze_(params.store || ''), params.callback);
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

    // ── Write authorization: ONE chokepoint, so it cannot be forgotten per endpoint ──
    // The signature above proves who you are; it does not prove you still have access. This
    // re-checks the GRANT in GX Core for mutating actions only. Reads fall straight through and
    // still fail open, so a Core hiccup can never blank a board at open. Ships dark (dry-run) --
    // see gxCheckWriteGrant_.
    if (gxIsWriteAction_(params.action)) {
      const grant = gxCheckWriteGrant_(auth, params.action);
      if (!grant.ok) return jsonOut(grant, params.callback);
    }

    // Management-only: the ADMIT test. Would enforcing the write gate refuse any real user?
    // writeauthprobe asserts "refuses the bad"; this asserts "admits the good", which is the
    // half that decides whether the flag can safely be turned on.
    if (params.action === 'writegrantaudit') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(gxWriteGrantAudit_(), params.callback);
    }

    // Management-only: does THIS project's session secret match GX Core's? Determines whether our
    // tokens are Core-verifiable at all. Reveals a hash, never the value.
    if (params.action === 'sessionfingerprint') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(gxSessionFingerprint_(), params.callback);
    }

    // Management-only: current local user roster (no password hashes). Useful for the shared-login migration.
    if (params.action === 'listusers') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(listUsers_(), params.callback);
    }

    // ── EOD guardrail (sales-cache tripwire) ───────────────
    // Dry-run on demand: compute cache-vs-Dutchie drift and return it WITHOUT filing a bug.
    if (params.action === 'eodguard') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(eodGuardCheck_(true), params.callback);
    }
    // Install the nightly trigger (idempotent) without opening the GAS editor.
    if (params.action === 'installeodguard') {
      requireRole_(auth, ['owner','director']);
      installEodGuardTrigger();
      return jsonOut({ ok: true, installed: 'eodGuardCheck_ daily @ UTC 15:xx' }, params.callback);
    }
    // Goal ledger (as-of goals): run the producer capture/lock now and return the current frozen shape.
    if (params.action === 'goalledger') {
      requireRole_(auth, ['owner','director']);
      var _lg = refreshGoalLedger_();
      _lg.currentShape = getFrozenPeriodGoal_(_lg.current);
      _lg.published = publishGoalsSafe_('goalledger');   // a freeze changes the shape getDailyGoals_ reads
      return jsonOut(_lg, params.callback);
    }
    // Backfill a closed period's frozen goal (reconstructed as-of), locked. ?pp=yyyy-mm-dd (period start).
    if (params.action === 'goalbackfill') {
      requireRole_(auth, ['owner','director']);
      if (!params.pp) return jsonOut({ ok: false, error: 'need pp=yyyy-mm-dd (period start)' }, params.callback);
      return jsonOut(backfillPeriodGoal_(params.pp), params.callback);
    }
    // Push the local goal ledger into GX Core's shared period_goals table (one-time backfill; idempotent).
    if (params.action === 'goalpush') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(pushLocalLedgerToCentral_(), params.callback);
    }
    // Bulk backfill the last N closed periods (reconstructed as-of), locked + pushed to central. Idempotent
    // (skips already-locked periods) and time-budgeted (~4.5 min) so it stays under the 6-min GAS limit —
    // re-call to continue walking back. ?n=<periods> (default 12, max 40). For unblocking Sales' getPeriodGoals.
    if (params.action === 'goalbackfillbulk') {
      requireRole_(auth, ['owner','director']);
      var _bn = Math.min(Math.max(parseInt(params.n || '12', 10) || 12, 1), 40);
      var _bt0 = Date.now();
      var _bcur = currentPPStart_(getProps_());
      var _bdone = [], _bskip = [];
      for (var _bk = 1; _bk <= _bn; _bk++) {
        if (Date.now() - _bt0 > 270000) break;   // ~4.5 min budget
        var _bStart = Utilities.formatDate(new Date(ppShift_(_bcur.ppStartMs, -_bk)), STORE_TZ, 'yyyy-MM-dd');
        var _bex = getFrozenPeriodGoal_(_bStart);
        if (_bex && _bex.locked) { _bskip.push(_bStart); continue; }
        try { backfillPeriodGoal_(_bStart); _bdone.push(_bStart); } catch (e) {}
      }
      return jsonOut({ ok: true, backfilled: _bdone, alreadyLocked: _bskip, earliest: _bdone.concat(_bskip).sort()[0] || null }, params.callback);
    }
    // Verify a central period_goals read. ?pp=yyyy-mm-dd (or any date in the period); ?store=slug for one row.
    if (params.action === 'goalpeek') {
      requireRole_(auth, ['owner','director']);
      try { return jsonOut({ ok: true, central: GXCore.getPeriodGoals(params.store || '', params.pp || '') }, params.callback); }
      catch (e) { return jsonOut({ ok: false, error: String(e) }, params.callback); }
    }
    // Bust the cached hourly-target distribution so it recomputes (e.g., after widening the sample /
    // adding smoothing). Next storetoday/director load re-fetches the same-DOW shape.
    if (params.action === 'bustdist') {
      requireRole_(auth, ['owner','director']);
      PropertiesService.getScriptProperties().deleteProperty(GC_HOURLY_DIST_KEY);
      return jsonOut({ ok: true, busted: 'GC_HOURLY_DIST_KEY' }, params.callback);
    }
    // Inspect/clear stored PP goal overrides. No slug → returns the current map (read-only). ?slug=river →
    // removes that store's override (fixes a phantom override that the settings UI saved by mistake).
    if (params.action === 'clearmanualgoal') {
      requireRole_(auth, ['owner','director']);
      var _mp = getProps_();
      var _m = {}; try { _m = JSON.parse(_mp.getProperty(GC_MANUAL_PP_KEY) || '{}'); } catch (e) {}
      if (!params.slug) return jsonOut({ ok: true, current: _m }, params.callback);
      var _had = _m.hasOwnProperty(params.slug);
      delete _m[params.slug];
      _mp.setProperty(GC_MANUAL_PP_KEY, JSON.stringify(_m));
      var _mpub = publishGoalsSafe_('clearmanualgoal');   // clearing an override restores that store's stretch
      return jsonOut({ ok: true, cleared: params.slug, had: _had, remaining: _m, published: _mpub }, params.callback);
    }


    // ── Director endpoints ─────────────────────────────────
    if (params.action === 'directorall') {
      requireRole_(auth, ['owner','director']);
      const period = params.period || 'mtd';

      // Serve from proactive cache — set by the 2-minute time trigger.
      // Browser requests make zero Dutchie UrlFetch calls when cache is warm.
      const dirCacheKey = 'gc_dirall_v2_' + period;
      const dirCache    = CacheService.getScriptCache();
      const hardRefresh = params.refresh === '1' || params.refresh === true;
      if (!hardRefresh) {
        try {
          const chunks = getChunkedCache_(dirCache, dirCacheKey);
          if (chunks) return jsonOut(JSON.parse(chunks), params.callback);
        } catch(e) { /* cache miss or parse error — fall through to fetch */ }
      }

      // Cache cold (or hard refresh) — fetch now and warm it. hardRefresh re-pulls
      // + re-locks the day cache (retroactive-return case).
      const result = buildDirectorAll_(period, hardRefresh);
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

    if (params.action === 'aggticker') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getAggTicker_(), params.callback);
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
      var _rt = recalculateGoals_();
      _rt.published = publishGoalsSafe_('refreshtargets');
      return jsonOut(_rt, params.callback);
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
    if (params.action === 'ppseries') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getPPSeries_(params.store || 'baseline', parseInt(params.n, 10) || 26), params.callback);
    }
    // ── Period Standings (managers + directors) ────────────
    if (params.action === 'standings') {
      requireRole_(auth, ['owner','director','store_manager','asst_manager']);
      return jsonOut(getStandings_(params.refresh === '1' || params.refresh === true), params.callback);
    }
    // ── Incentive Dashboard (owner + Mike only) ────────────
    if (params.action === 'incentive' || params.action === 'saveincentive') {
      if (!incentiveAccessOk_(auth)) return jsonOut({ ok: false, error: 'Forbidden' }, params.callback);
      return jsonOut(
        params.action === 'incentive' ? getIncentiveData_(params.ppStart, params.refresh === '1' || params.refresh === true) : saveIncentiveInputs_(params),
        params.callback
      );
    }

    // ── Plan management ────────────────────────────────────
    if (params.action === 'setplan') {
      requireRole_(auth, ['owner','director']);
      var _sp = setStorePlan(params);
      _sp.published = publishGoalsSafe_('setplan');   // plans are getDailyGoals_'s fallback branch
      return jsonOut(_sp, params.callback);
    }

    if (params.action === 'getsettings') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getSettings_(params), params.callback);
    }
    if (params.action === 'savesettings') {
      requireRole_(auth, ['owner','director']);
      var _ss = saveSettings_(params);
      // Only the stretch multiplier moves the goal numbers; the other settings this route owns do
      // not, and getDailyGoals_ is a 6-store recompute we should not put in front of every save.
      if (params.stretch !== undefined && _ss && _ss.ok !== false) _ss.published = publishGoalsSafe_('savesettings:stretch');
      return jsonOut(_ss, params.callback);
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
      var cache = Object.create(null);
      try { cache = JSON.parse(cacheRaw); } catch(e) {}
      var result = Object.create(null);
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

      // Resolved goal (what the kiosk actually uses)
      var resolved = resolveGoal_(diagSlug);
      var pt = ptNow_();

      return jsonOut({
        store:      diagSlug,
        stretch:    stretch,
        y1CacheKey: y1Cache.key || null,
        y1PP:       Math.round(y1PP),   // same-season floor (raw year-ago avg)
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

    // Director-only. Enumerate distinct discount names booked in the current pay
    // period so we can see exactly how loyalty is recorded. ?action=discnames&token=TOKEN
    if (params.action === 'discnames') {
      requireRole_(auth, ['owner','director']);
      var _dprops = getProps_();
      var _dcur   = currentPPStart_(_dprops);
      var _drange = { fromUTC: new Date(_dcur.ppStartMs).toISOString(),
                      toUTC:   new Date(_dcur.ppEndMs).toISOString() };
      var _dbyStore = fetchAllStoresTransactions_(_drange);
      var _dnames = Object.create(null);   // discountName -> { count, amount, sampleKeys, sample, excluded }
      var _dgrand = { txTotal: 0, txWithDiscount: 0, totalDiscount: 0 };
      Object.keys(_dbyStore).forEach(function(_slug) {
        (_dbyStore[_slug] || []).forEach(function(_tx) {
          _dgrand.txTotal++;
          var _td = txDiscount_(_tx);
          if (_td > 0) _dgrand.txWithDiscount++;
          _dgrand.totalDiscount += _td;
          (_tx.discounts || []).forEach(function(_d) {
            var _nm = _d.discountName || _d.discountReason || '(unnamed)';
            if (!_dnames[_nm]) _dnames[_nm] = {
              count: 0, amount: 0,
              sampleKeys: Object.keys(_d),
              sample: _d,
              excluded: EXCLUDED_DISCOUNT_KEYWORDS.some(function(_kw) {
                return _nm.toLowerCase().indexOf(_kw) !== -1; }),
            };
            _dnames[_nm].count++;
            _dnames[_nm].amount += Number(_d.amount || 0);
          });
        });
      });
      Object.keys(_dnames).forEach(function(_n) { _dnames[_n].amount = Math.round(_dnames[_n].amount * 100) / 100; });
      _dgrand.totalDiscount = Math.round(_dgrand.totalDiscount * 100) / 100;
      return jsonOut({ ok: true,
        ppStart: Utilities.formatDate(new Date(_dcur.ppStartMs), STORE_TZ, 'yyyy-MM-dd'),
        grand: _dgrand, names: _dnames, currentExclusions: EXCLUDED_DISCOUNT_KEYWORDS }, params.callback);
    }

    // Director-only. Probe Dutchie for a discount-definitions endpoint (with Type)
    // so we can classify discounts live. ?action=discdefs&token=TOKEN[&store=baseline]
    if (params.action === 'discdefs') {
      requireRole_(auth, ['owner','director']);
      var _ddSlug = params.store || STORES[0].slug;
      var _ddKey  = getDutchieStoreKey_(_ddSlug);
      var _dd   = dutchieFetch_(_ddKey, '/reporting/discounts', {});
      var _arr  = Array.isArray(_dd) ? _dd : (_dd.data || _dd.discounts || _dd.items || []);
      var _byMethod = {}, _byAppMethod = {};
      var _rows = (_arr || []).map(function(_x) {
        var _dm = _x.discountMethod || '(none)', _am = _x.applicationMethod || '(none)';
        _byMethod[_dm]    = (_byMethod[_dm]    || 0) + 1;
        _byAppMethod[_am] = (_byAppMethod[_am] || 0) + 1;
        return {
          id: _x.discountId, name: _x.discountName, code: _x.discountCode || '',
          discountType: _x.discountType, discountMethod: _dm, applicationMethod: _am,
          isActive: _x.isActive, isDeleted: _x.isDeleted,
        };
      });
      return jsonOut({ ok: true, store: _ddSlug, count: _rows.length,
        byDiscountMethod: _byMethod, byApplicationMethod: _byAppMethod, rows: _rows }, params.callback);
    }

    // Director-only. Union the discount registry across ALL stores and join it
    // against this pay period's actual discount usage, with a derived class.
    // ?action=discaudit&token=TOKEN
    if (params.action === 'discaudit') {
      requireRole_(auth, ['owner','director']);
      var _daReg = Object.create(null);   // discountName -> { appMethod, code }  (tx discountId is always 0, so join by name)
      STORES.forEach(function(_st) {
        try {
          var _k = getDutchieStoreKey_(_st.slug);
          var _d = dutchieFetch_(_k, '/reporting/discounts', {});
          var _arr = Array.isArray(_d) ? _d : (_d.data || _d.discounts || _d.items || []);
          (_arr || []).forEach(function(_x) {
            var _nm = _x.discountName;
            if (_nm && !_daReg[_nm]) _daReg[_nm] = { appMethod: _x.applicationMethod || '', code: _x.discountCode || '' };
          });
        } catch (_e) {}
      });
      var _daProps = getProps_();
      var _daCur   = currentPPStart_(_daProps);
      var _daRange = { fromUTC: new Date(_daCur.ppStartMs).toISOString(),
                       toUTC:   new Date(_daCur.ppEndMs).toISOString() };
      var _daByStore = fetchAllStoresTransactions_(_daRange);
      var _daUsage = Object.create(null);   // discountName -> { count, amount }
      Object.keys(_daByStore).forEach(function(_slug) {
        (_daByStore[_slug] || []).forEach(function(_tx) {
          (_tx.discounts || []).forEach(function(_dd) {
            var _nm = _dd.discountName || _dd.discountReason || '(unnamed)';
            if (!_daUsage[_nm]) _daUsage[_nm] = { count: 0, amount: 0 };
            _daUsage[_nm].count++;
            _daUsage[_nm].amount += Number(_dd.amount || 0);
          });
        });
      });
      var _daRows = Object.keys(_daUsage).map(function(_nm) {
        var _u = _daUsage[_nm], _r = _daReg[_nm];
        var _app = _r ? _r.appMethod : '(NOT IN REGISTRY)';
        var _isLoyalty = /redemption/i.test(_nm);
        var _klass = _app === 'Automatic' ? 'Automatic'
                   : (_isLoyalty ? 'Loyalty'
                   : (_app === '(NOT IN REGISTRY)' ? 'Unknown' : _app));   // Code / Manual
        return { name: _nm, code: _r ? _r.code : '', count: _u.count,
          amount: Math.round(_u.amount * 100) / 100, appMethod: _app, klass: _klass };
      }).sort(function(a, b) { return b.amount - a.amount; });
      return jsonOut({ ok: true, registrySize: Object.keys(_daReg).length,
        ppStart: Utilities.formatDate(new Date(_daCur.ppStartMs), STORE_TZ, 'yyyy-MM-dd'),
        rows: _daRows }, params.callback);
    }

    // Director-only. Per-seller Veteran-discount distribution over a window, to
    // inform a realistic incentive target. ?action=vetaudit&token=TOKEN[&days=30]
    if (params.action === 'vetaudit') {
      requireRole_(auth, ['owner','director']);
      var _vaDays = parseInt(params.days, 10) || 30;
      var _vaStats = computeVetStats_(_vaDays, 20);
      var _vaRows = _vaStats.rows.slice().sort(function(a, b){ return b.vetRate - a.vetRate; });
      function _pct(arr, p) { if (!arr.length) return 0; var s = arr.slice().sort(function(a,b){return a-b;}); var i = Math.min(s.length-1, Math.floor(p/100*s.length)); return s[i]; }
      function _mean(a){ return a.length ? Math.round(a.reduce(function(x,y){return x+y;},0)/a.length*100)/100 : 0; }
      var _vr = _vaRows.map(function(r){return r.vetRate;});
      var _br = _vaRows.map(function(r){return r.bdtRate;});
      return jsonOut({ ok: true, days: _vaStats.days, sellers: _vaRows.length,
        storeMedians: _vaStats.storeMedians,
        vetRateDist: { mean:_mean(_vr), p50:_pct(_vr,50), p75:_pct(_vr,75), p90:_pct(_vr,90), max:_vr.length?Math.max.apply(null,_vr):0 },
        bdtRateDist: { mean:_mean(_br), p50:_pct(_br,50), p75:_pct(_br,75), p90:_pct(_br,90), max:_br.length?Math.max.apply(null,_br):0 },
        rows: _vaRows }, params.callback);
    }

    // Director/owner. Veteran-discount investigate flags (peer-relative share-of-orders).
    // Shown below Top Performers on the director view. ?action=vetflags&token=TOKEN[&days=30]
    if (params.action === 'vetflags') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(vetFlags_(parseInt(params.days, 10) || 30, {}), params.callback);
    }

    // Owner+Mike. Force the incentive discount thresholds to the agreed targets,
    // patching any saved override so the change actually takes effect.
    // ?action=applydiscounttargets&token=TOKEN&budtenderMax=1.5[&mgrFull=1.5&mgrPartial=2.0]
    if (params.action === 'applydiscounttargets') {
      if (!incentiveAccessOk_(auth)) return jsonOut({ ok: false, error: 'Forbidden' }, params.callback);
      var _bMax = parseFloat(params.budtenderMax); if (isNaN(_bMax)) _bMax = 1.5;
      var _mFull = parseFloat(params.mgrFull);    if (isNaN(_mFull)) _mFull = 1.5;
      var _mPart = parseFloat(params.mgrPartial); if (isNaN(_mPart)) _mPart = 2.0;
      var _th = getIncentiveThresholds_();   // saved-or-default (deep enough to patch)
      _th.budtender.discountMaxPct = _bMax;
      _th.manager.discountTiers = [ { maxPct: _mFull, bonus: _th.manager.discountTiers[0].bonus },
                                    { maxPct: _mPart, bonus: _th.manager.discountTiers[1].bonus } ];
      getProps_().setProperty(GC_INCENTIVE_THRESH_KEY, JSON.stringify(_th));
      return jsonOut({ ok: true, budtenderMax: _bMax, mgrFull: _mFull, mgrPartial: _mPart,
        discountTiers: _th.manager.discountTiers }, params.callback);
    }

    // Director-only. Probe whether transactions expose customer identity / a Vet
    // profile flag (for a future "unverified vet discount" metric). Read-only,
    // dumps only field NAMES + coarse shape — no customer PII values.
    // ?action=custprobe&token=TOKEN[&store=baseline]
    if (params.action === 'custprobe') {
      requireRole_(auth, ['owner','director']);
      var _cpSlug  = params.store || STORES[0].slug;
      var _cpRange = getDateRange_('mtd');
      var _cpTxns  = fetchStoreTransactions_(_cpSlug, _cpRange.fromUTC, _cpRange.toUTC);
      var _cpVet   = null, _cpAny = _cpTxns[0] || null;
      for (var _i = 0; _i < _cpTxns.length; _i++) {
        var _dl = _cpTxns[_i].discounts || [];
        if (_dl.some(function(d){ return /veteran/i.test(d.discountName || ''); })) { _cpVet = _cpTxns[_i]; break; }
      }
      function _custShape(tx) {
        if (!tx) return null;
        var topKeys = Object.keys(tx).filter(function(k){ return /customer|loyalt|member|patient|medical|profile|consumer/i.test(k); });
        var shape = Object.create(null);
        topKeys.forEach(function(k){
          var v = tx[k];
          shape[k] = (v && typeof v === 'object') ? { _keys: Object.keys(v) } : (typeof v);
        });
        return { customerRelatedTopKeys: topKeys, shape: shape, allTopKeysCount: Object.keys(tx).length };
      }
      return jsonOut({ ok: true, store: _cpSlug, vetTxnFound: !!_cpVet,
        vetTxnCustomerShape: _custShape(_cpVet), anyTxnCustomerShape: _custShape(_cpAny) }, params.callback);
    }

    // ── Discount settings (incentive exclusions) — director/owner only ──
    if (params.action === 'discountsettings') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getDiscountSettings_(), params.callback);
    }
    // Kept as an explicit refusal, not a writer — the overrides live in GX Core kv `discountRules`
    // and are edited in GX Crew. saveDiscountSettings_ explains why there is no write-through.
    if (params.action === 'savediscountsettings') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(saveDiscountSettings_(params), params.callback);
    }
    if (params.action === 'refreshdiscounts') {
      requireRole_(auth, ['owner','director']);
      var _rdReg = buildDiscountRegistry_();
      return jsonOut({ ok: true, builtAt: _rdReg.builtAt,
        count: Object.keys(_rdReg.byName || {}).length }, params.callback);
    }

    // 'saveeom' removed: Employee of the Month is set in Crew and stored in GX Core as cfg.eom,
    // keyed on employee_id. Nothing in this app writes it any more, and leaving a live write route
    // for a value this app no longer owns is how two sources of truth come back. The read path
    // (getEomCurrent_) still honors the old GC_EOM_KEY property, but only if Crew has never
    // written cfg.eom -- which it now has.

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
            avEmpMap[key] = { key: key, name: emp.name, store: store.name, dutchieId: String(emp.id || '') };
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
    // setstorekeys was REMOVED 2026-08-31. This app no longer stores a Dutchie key: it asks GX Core
    // for one over ?action=dutchie_keys and caches it for ten minutes. A route that writes a
    // property nothing reads is not harmless -- it is a loaded gun for whoever finds it and
    // concludes that rotating here does something.

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

    // Re-pull + rewrite EOD snapshots for the last N days (repairs historical
    // per-employee txns on snapshots taken before that field was captured).
    // Uses backfillDateRange_ — parallel fetchAll batches, safe for 31 days.
    if (params.action === 'backfillsnapshots') {
      requireRole_(auth, ['owner','director']);
      var _bfDays = Math.min(Math.max(parseInt(params.days, 10) || 7, 1), 31);
      var _bfFrom = Utilities.formatDate(new Date(Date.now() - _bfDays * 86400000), STORE_TZ, 'yyyy-MM-dd');
      backfillDateRange_(_bfFrom);   // toDateStr defaults to yesterday
      return jsonOut({ ok: true, message: 'Backfilled snapshots from ' + _bfFrom + ' through yesterday.' }, params.callback);
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
  // Keys are not managed here AT ALL any more (2026-08-31). GX Core holds the only copy; this app
  // fetches one per ten minutes over ?action=dutchie_keys and stores nothing. To rotate, set
  // DUTCHIE_STORE_KEYS_JSON in GX CORE -- doing it here would change nothing anywhere.
  Logger.log('bootstrapStoreKeys: nothing to do — GX Core is the only holder of Dutchie keys.');
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
  const roster = Object.create(null);

  STORES.forEach(function(store) {
    const seen = Object.create(null);
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
  // Warm-instance guard: this trigger builds a cached aggregate that carries the budtender
  // discount rate, and the discount overrides now come from GX Core (readDiscConfig_).
  // Drop the per-execution memo so a warm instance cannot score against rules Crew has changed.
  resetDiscountMemos_();
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
  const ts = new Date();

  // Central bug log — GX Command Center is the SINGLE source of truth for bug reports
  // (GX Core's central bug_reports table, shown in the cockpit; this app's key =
  // 'performance'). Real library fn is gxIngestBug (NOT ingestBug); it maps our keys
  // (desc→detail, priority→severity, appStore→store, appVer→app_version) internally.
  // Runs as Sky (GX Core owner) so the write is authorized.
  try {
    GXCore.gxIngestBug('performance', b.reporter, {
      title: b.title, desc: b.desc, priority: b.priority, store: b.appStore, appVer: b.appVer
    });
  } catch (e) { /* central unavailable — the email below is the no-lost-report fallback */ }

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

// (Deploy version-recording moved to GX Core's central `action=deploy_version` endpoint —
//  deploy.sh posts straight to it, so this app no longer needs a local record action. Bug
//  forwarding via GXCore.gxIngestBug is unchanged.)

// ── Store registry (incl. colors) from GX Core — the single source ───────────
// Cached ~15 min (colors change rarely). The frontend applies these over its hardcoded
// GC.STORES fallback, so a Command Center color edit propagates without an app deploy.
function getGxStores_() {
  try {
    const cache = CacheService.getScriptCache();
    const hit = cache.get('GC_GXSTORES_v1');
    if (hit) return JSON.parse(hit);
    const rows = GXCore.getStores() || [];
    const stores = rows.map(function(s) {
      return {
        store_id:     String(s.store_id || ''),
        display_name: String(s.display_name || ''),
        dutchie_name: String(s.dutchie_name || ''),
        color:        String(s.color || ''),
        sort_order:   String(s.sort_order || ''),
      };
    });
    const out = { ok: true, stores: stores };
    cache.put('GC_GXSTORES_v1', JSON.stringify(out), 300);   // 5 min — matches the Sky wall's color poll
    return out;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), stores: [] };
  }
}

// Map GX Core store_id → this app's slug (= display_name lowercased). The sales cache keys rows by
// GX store_id (bend, hillsboro, …); the app uses display-name slugs (century, baseline, …).
function gxStoreIdToAppSlug_() {
  const map = Object.create(null);
  try {
    const g = getGxStores_();
    ((g && g.stores) || []).forEach(function(s) {
      const slug = String(s.display_name || '').trim().toLowerCase();
      if (s.store_id && slug) map[String(s.store_id)] = slug;
    });
  } catch (e) {}
  return map;
}

/**
 * Run ONCE from the Apps Script editor (select reauthMail → Run) to re-grant the
 * send-email scope after a manifest change. Zero args so it runs directly, and it
 * calls MailApp — so running it triggers the "Authorization required" consent for
 * script.send_mail. Approve it, and you'll receive the confirmation email. After
 * that, bug-report emails work again (verify with ?action=bugpipetest).
 */
function reauthMail() {
  MailApp.sendEmail(
    'sky@greencrosscanna.com',
    '✅ Leaderboard re-auth test',
    'If you received this, the send-email scope is restored — bug-report emails will work again.'
  );
  return 'sent';
}

/**
 * Run ONCE from the Apps Script editor (select deleteDeploySecretProp → Run) to remove the
 * now-orphaned GC_DEPLOY_SECRET Script Property. It's dead data — deploy version-recording
 * moved to GX Core's central endpoint, so nothing here reads it anymore. The editor's Script
 * Properties panel is read-only once a project has >50 props, so this must be done in code.
 * Check the execution log for confirmation. Safe to delete this function afterward.
 */
function deleteDeploySecretProp() {
  const props = PropertiesService.getScriptProperties();
  const had = props.getProperty('GC_DEPLOY_SECRET') != null;
  props.deleteProperty('GC_DEPLOY_SECRET');
  const msg = 'GC_DEPLOY_SECRET ' + (had ? 'deleted.' : 'was not set (nothing to delete).');
  Logger.log(msg);
  return msg;
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
        jobTitle:  own_(MANAGEMENT_JOB_TITLES, username) || '',
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
  var empMap = Object.create(null);
  STORES.forEach(function(store) {
    (roster[store.slug] || []).forEach(function(emp) {
      var key = nameToKey_(emp.name);
      if (!empMap[key] && emp.name && emp.name !== 'Unknown') {
        // dutchieId is carried through deliberately: it is the join to GX Core's employee roster.
        // Joining on names is what silently orphans a person the moment Crew renames them.
        empMap[key] = { key: key, name: emp.name, store: store.name, dutchieId: String(emp.id || '') };
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
    discountTarget:   getDiscountTargetDec_(),   // decimal, e.g. 0.015 (drives incentive + leaderboard color)
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
    showSpiff:        spiffShowEnabled_(),   // kiosk staff cards show the SPIFF row
  };
}

/**
 * Flush the caches holding rendered staff lists, so a rename / new avatar / retirement shows on the
 * NEXT load instead of lingering for the 55s kiosk and 6-minute director TTLs.
 *
 * This used to be inline in saveSettings_, reached only when that route wrote nicknames or roles.
 * Those writes moved to Crew, so it is a named function now and the avatar write calls it too --
 * otherwise somebody rebuilds their face in #/avatar, sees nothing change, and does it again.
 */
function gxBustDisplayCaches_() {
  try {
    var _cc  = CacheService.getScriptCache();
    var keys = ['gc_dirall_v2_pp', 'gc_dirall_v2_mtd', 'gc_standings_v1', 'gc_aggticker_v1'];
    STORES.forEach(function (s) { keys.push('storeToday:' + s.slug, 'storeLB:' + s.slug); });
    _cc.removeAll(keys);
  } catch (e) {}
}

function saveSettings_(params) {
  var props = PropertiesService.getScriptProperties();
  var bustDisplay = false;   // still set by the settings this app owns; people data moved to Crew

  // The nicknames / excluded / roles branches are gone. Crew owns all three, and this app reads
  // them from GX Core. The Settings UI that posted them was removed with the Employees table, but
  // leaving the WRITE route live is how a second source of truth grows back -- a stray call would
  // have quietly repopulated local copies that the read path prefers over Crew for anyone Core does
  // not cover. savesettings still handles the settings this app genuinely owns (stretch,
  // discountTarget, goals), which is why the route itself stays.

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
        var newManuals = Object.create(null);
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

  // Save discount target % (0.5–10%). Single source of truth = the incentive
  // budtender discountMaxPct; patched here so the incentive bonus line AND the
  // leaderboard color/KPI move together. Bust the director caches so it shows.
  if (params.discountTarget !== undefined) {
    var newT = parseFloat(params.discountTarget);   // percent, e.g. 2.0
    if (isNaN(newT)) return { ok: false, error: 'Invalid discount target' };
    newT = Math.max(0.5, Math.min(10, newT));
    var th = getIncentiveThresholds_();
    th.budtender.discountMaxPct = newT;
    props.setProperty(GC_INCENTIVE_THRESH_KEY, JSON.stringify(th));
    try {
      var _c = CacheService.getScriptCache();
      _c.remove('gc_dirall_v2_pp'); _c.remove('gc_dirall_v2_mtd');
    } catch (e) {}
    Logger.log('[discountTarget] saved: ' + newT + '%');
  }

  // Kiosk SPIFF row on/off. Compared against the STRING 'true' rather than coerced, so a stray
  // 'false' cannot read as truthy -- the classic text-boolean trap this suite has a rule about.
  if (params.showSpiff !== undefined) {
    var _showSpiff = String(params.showSpiff) === 'true';
    props.setProperty(GC_SPIFF_SHOW_KEY, _showSpiff ? 'true' : 'false');
    // The standings payload carries the row and is cached per store; without this the toggle
    // appears to do nothing for up to a minute and somebody clicks it again.
    bustDisplay = true;
    Logger.log('[showSpiff] saved: ' + _showSpiff);
  }

  if (bustDisplay) gxBustDisplayCaches_();

  return { ok: true };
}
