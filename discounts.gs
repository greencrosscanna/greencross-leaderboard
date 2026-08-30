// ============================================================
//  Green Cross — Discount Classification  (discounts.gs)
//  A live registry of Dutchie discount definitions plus a
//  per-discount exclusion config. Together they define the
//  "budtender discount" basis: LOYALTY point redemptions and
//  AUTOMATIC promos/vendor days are never counted against staff;
//  discretionary (Code/Manual) discounts follow the saved config.
//
//  Why a registry: transaction discount lines carry a name but
//  discountId is always 0, and the POS API reports loyalty as
//  applicationMethod "Code" (not "Loyalty"). So we classify by:
//    - applicationMethod === 'Automatic'          → automatic
//    - name contains "redemption"                 → loyalty
//    - otherwise (Code / Manual)                  → discretionary
//  The registry is unioned across all stores (a discount is
//  defined per-location) and refreshed off the hot path.
// ============================================================

const GC_DISCOUNT_REGISTRY_KEY = 'GC_DISCOUNT_REGISTRY_JSON'; // { builtAt, byName: { name: {appMethod, code, klass} } }
const GC_DISCOUNT_EXCL_KEY     = 'GC_DISCOUNT_EXCL_JSON';     // LEGACY local copy of the overrides — fallback only, see readDiscConfig_
const GC_DISCOUNT_RULES_CORE_KEY = 'discountRules';           // GX Core kv key — SOURCE OF TRUTH for { overrides: { name: true|false } }

/* OWNERSHIP, 2026-08-30 — the two halves of this file now live in different places:
 *
 *   REGISTRY  (GC_DISCOUNT_REGISTRY_KEY)  stays OURS. It is a derived cache of Dutchie's discount
 *     definitions, rebuilt every 6-12h from this app's own credentials and classified by
 *     classifyDiscount_. Nothing human-edited about it; nothing outside this app can rebuild it.
 *
 *   OVERRIDES ({ overrides: { name: bool } })  moved to GX CORE kv `discountRules`. They are a
 *     compensation setting, not a Leaderboard setting: GX Crew's incentive tray edits them next to
 *     the thresholds (already in Core kv `incentiveThresholds`), because to whoever sets the scheme
 *     they are one screen and one decision. This app READS them and applies them to transaction
 *     data — the half of the incentive engine that stayed here.
 *
 * Before this, Crew edited them by calling THIS app's ?action=discountrules_save over HTTP with the
 * deploy secret — app-to-app, which the shared brain forbids, and it made a pay-affecting setting
 * depend on our /exec being up. Leaderboard no longer writes the overrides at all; see
 * saveDiscountSettings_ for why there is deliberately no write-through.
 */

// Discretionary discounts seeded OFF (excluded) by default. Owner-confirmed 2026-08-07.
const DISCOUNT_SEED_EXCLUDED = [
  'Employee Discount',
  '$2 GOOGLE REVIEW PRE-ROLL',
  'Employee Only | 40% off Apparel',
];

// Loyalty point/reward redemptions. Dutchie's POS API reports these as
// applicationMethod "Code", but every one contains "redemption" in its name.
const LOYALTY_NAME_RE = /redemption/i;

/** Classify one discount definition → 'automatic' | 'loyalty' | 'discretionary'. */
function classifyDiscount_(name, applicationMethod) {
  if (applicationMethod === 'Automatic') return 'automatic';
  if (LOYALTY_NAME_RE.test(name || '')) return 'loyalty';
  return 'discretionary';
}

/**
 * Rebuild the registry by unioning /reporting/discounts across every store.
 * Writes to ScriptProperties. Makes one Dutchie call per store — NEVER call
 * this on the hot (aggregation) path.
 */
function buildDiscountRegistry_() {
  var byName = {};
  STORES.forEach(function(st) {
    try {
      var key = getDutchieStoreKey_(st.slug);
      var d   = dutchieFetch_(key, '/reporting/discounts', {});
      var arr = Array.isArray(d) ? d : (d.data || d.discounts || d.items || []);
      (arr || []).forEach(function(x) {
        var nm = x.discountName;
        if (!nm || byName[nm]) return;
        byName[nm] = {
          appMethod: x.applicationMethod || '',
          code:      x.discountCode || '',
          klass:     classifyDiscount_(nm, x.applicationMethod || ''),
        };
      });
    } catch (e) { /* one store failing shouldn't abort the union */ }
  });
  var reg = { builtAt: new Date().toISOString(), byName: byName };
  getProps_().setProperty(GC_DISCOUNT_REGISTRY_KEY, JSON.stringify(reg));
  _discRegMemo_ = reg;
  return reg;
}

/** Rebuild only if missing or older than maxAgeHours. Off-hot-path (may hit Dutchie). */
function refreshDiscountRegistryIfStale_(maxAgeHours) {
  var raw = getProps_().getProperty(GC_DISCOUNT_REGISTRY_KEY);
  if (raw) {
    try {
      var reg = JSON.parse(raw);
      if (reg && reg.builtAt) {
        var ageMs = new Date().getTime() - new Date(reg.builtAt).getTime();
        if (ageMs < (maxAgeHours || 12) * 3600000) return reg;
      }
    } catch (e) {}
  }
  return buildDiscountRegistry_();
}

// ── Per-execution memoized reads ──
// The hot path must never hit Dutchie, and — since 2026-08-30 — must never hit GX Core per
// transaction either. isExcludedDiscount_ runs once per DISCOUNT LINE per transaction
// (txDiscountBudtender_, dutchie_fetch.gs), so an unmemoised GXCore.getKv would be a sheet read
// through a bound library thousands of times per aggregation. Read once, reuse for the execution.
var _discRegMemo_ = null, _discCfgMemo_ = null;

/**
 * Drop both memos. MUST be called at the top of every entry point, not just once at load:
 * Apps Script reuses a warm instance between requests, so a module-level memo outlives the request
 * that filled it. With the overrides in GX Core and Crew editing them there, a surviving memo means
 * an edit silently does nothing until the instance recycles — exactly the bug that hit the
 * thresholds (an aovTarget change appeared to do nothing for minutes). Called from doGet and from
 * the triggers that build cached aggregates carrying the budtender discount rate.
 *
 * Deliberately NOT a TTL: within one execution the rules must not change halfway through an
 * aggregation, or a single pay-period number is computed under two different rule sets.
 */
function resetDiscountMemos_() { _discRegMemo_ = null; _discCfgMemo_ = null; }

function readDiscountRegistry_() {
  if (_discRegMemo_) return _discRegMemo_;
  var raw = getProps_().getProperty(GC_DISCOUNT_REGISTRY_KEY);
  try { _discRegMemo_ = raw ? JSON.parse(raw) : { byName: {} }; }
  catch (e) { _discRegMemo_ = { byName: {} }; }
  if (!_discRegMemo_.byName) _discRegMemo_.byName = {};
  return _discRegMemo_;
}

/**
 * The discretionary-discount overrides, from GX Core kv `discountRules`.
 * Returns { overrides: {name: bool}, source: 'core'|'property'|'seed', fallbackReason: string|null }.
 *
 * Fallback order: GX Core → the legacy local property → the seed list. The fallback is LOUD by
 * design — it logs, and `source` rides along on every settings payload (?action=discountsettings and
 * ?action=discountrules). A silent fall back to a stale local copy while Crew edits Core is the exact
 * failure this move exists to remove: every staff discount rate would look fine and be wrong, and
 * nothing on the kiosk would say so. If `source` ever reads anything but 'core', either GX Core is
 * unreachable or the kv key is gone.
 *
 * Falling back rather than throwing is the same call getIncentiveThresholds_ makes: if GX Core is
 * down the board must keep scoring as it did, not repaint every staff member against defaults.
 */
function readDiscConfig_() {
  if (_discCfgMemo_) return _discCfgMemo_;
  var hasOverrides = function (c) { return !!(c && c.overrides && typeof c.overrides === 'object'); };
  var label = 'GX Core kv `' + GC_DISCOUNT_RULES_CORE_KEY + '`';

  var why = '', raw = null;
  try { raw = GXCore.getKv(GC_DISCOUNT_RULES_CORE_KEY); }
  catch (e) { why = 'GXCore.getKv threw: ' + ((e && e.message) || e); }
  if (!why && (raw === null || raw === undefined || String(raw).trim() === '')) why = label + ' is empty or missing';
  if (!why) {
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e2) { why = label + ' is not valid JSON'; }
    if (!why && !hasOverrides(parsed)) why = label + ' has no `overrides` object';
    if (!why) { _discCfgMemo_ = { overrides: parsed.overrides, source: 'core', fallbackReason: null }; return _discCfgMemo_; }
  }

  var local = null;
  try { local = JSON.parse(getProps_().getProperty(GC_DISCOUNT_EXCL_KEY) || 'null'); } catch (e3) {}
  var src = hasOverrides(local) ? 'property' : 'seed';
  Logger.log('[discounts] FALLBACK: ' + why + '. Reading discount overrides from the LOCAL ' + src +
             ' copy instead. If GX Crew has edited the rules since, every staff discount rate this ' +
             'execution produces is computed under the OLD rules.');

  if (src === 'property') { _discCfgMemo_ = { overrides: local.overrides, source: 'property', fallbackReason: why }; }
  else {
    var ov = {};
    DISCOUNT_SEED_EXCLUDED.forEach(function (n) { ov[n] = true; });
    _discCfgMemo_ = { overrides: ov, source: 'seed', fallbackReason: why };
  }
  return _discCfgMemo_;
}

/**
 * Should this discount (by name) be excluded from the budtender discount basis?
 * Loyalty and Automatic are ALWAYS excluded (class rules win over any config);
 * discretionary discounts follow the saved per-discount override (default counted).
 */
function isExcludedDiscount_(name) {
  if (!name) return false;
  if (LOYALTY_NAME_RE.test(name)) return true;              // loyalty — robust even if registry stale
  var r = readDiscountRegistry_().byName[name];
  if (r && r.klass === 'automatic') return true;           // promos / vendor days
  var cfg = readDiscConfig_();
  if (cfg.overrides && Object.prototype.hasOwnProperty.call(cfg.overrides, name)) return !!cfg.overrides[name];
  return false;                                            // discretionary default: counted
}

/**
 * Assemble the discount-settings payload for the admin toggle UI. Refreshes the
 * registry if stale (off hot path). Returns the discretionary discounts with
 * their current include/exclude state, plus the locked auto-excluded groups.
 */
function getDiscountSettings_() {
  var reg = refreshDiscountRegistryIfStale_(6);
  var cfg = readDiscConfig_();          // GX Core kv, with a LOGGED fallback — see readDiscConfig_
  var overrides = cfg.overrides || {};
  var discretionary = [], automatic = [], loyalty = [];
  Object.keys(reg.byName || {}).forEach(function (nm) {
    var r = reg.byName[nm];
    if (r.klass === 'automatic') { automatic.push(nm); return; }
    if (r.klass === 'loyalty')   { loyalty.push(nm); return; }
    var excluded = Object.prototype.hasOwnProperty.call(overrides, nm) ? !!overrides[nm] : false;
    discretionary.push({ name: nm, code: r.code || '', method: r.appMethod || '', excluded: excluded });
  });
  discretionary.sort(function (a, b) { return a.name.localeCompare(b.name); });
  automatic.sort(); loyalty.sort();
  return {
    ok: true, builtAt: reg.builtAt || null,
    discretionary: discretionary,
    autoExcluded: { automatic: automatic, loyalty: loyalty },
    counts: { automatic: automatic.length, loyalty: loyalty.length, discretionary: discretionary.length },
    // WHERE THE RULES CAME FROM. 'core' is the only healthy answer; anything else means this app is
    // scoring staff against a copy GX Crew cannot edit. Surfaced in the settings tray and returned
    // by ?action=discountrules so the fallback is diagnosable without reading the logs.
    source: cfg.source || 'core',
    fallbackReason: cfg.fallbackReason || null,
    editedIn: 'GX Crew → Incentive settings (stored in GX Core kv `' + GC_DISCOUNT_RULES_CORE_KEY + '`)',
  };
}

/**
 * THIS APP NO LONGER WRITES THE OVERRIDES. Refuses, loudly, and says where to edit them.
 *
 * It used to persist them to the local ScriptProperty. Once GX Core kv `discountRules` became the
 * source of truth (readDiscConfig_), that write is READ BY NOTHING: the property is only ever
 * consulted as a fallback when Core is unreachable. Leaving the writer in place would have been the
 * worst outcome available — the settings tray would report "Saved ✓", the toggles would come back
 * from Core on the next load exactly as they were, and the only visible symptom would be discount
 * rates that quietly disagree with the rules someone believes they set. This app has done that
 * before with Employee of the Month; see the 'saveeom' note in dutchie_proxy.gs.
 *
 * A write-THROUGH to GX Core was the obvious alternative and is deliberately not taken. There is no
 * bound-library writer (GXCore.setKv does not exist), so it would mean this app POSTing to Core's
 * secret-gated ?action=set_config — which re-creates the second writer and the app-to-app HTTP hop
 * that moving the rules to Core existed to remove, only pointed the other way. One writer, and it is
 * GX Crew, which owns compensation.
 *
 * Deliberately still a route rather than a deleted one: during the Leaderboard-then-Crew cutover an
 * explicit "edit it in Crew" beats an 'unknown action', which reads as a network fault.
 */
function saveDiscountSettings_(params) {
  var attempted = {};
  try { attempted = JSON.parse((params && params.overrides) || '{}'); } catch (e) {}
  Logger.log('[discounts] REFUSED a discount-override write. GX Core kv `' + GC_DISCOUNT_RULES_CORE_KEY +
             '` owns these now; edit them in GX Crew. Attempted: ' + JSON.stringify(attempted));
  return {
    ok: false,
    error: 'Discount rules are no longer edited here. They live in GX Core kv `' +
           GC_DISCOUNT_RULES_CORE_KEY + '` and are edited in GX Crew → Incentive settings.',
    editedIn: 'GX Crew → Incentive settings',
    coreKey: GC_DISCOUNT_RULES_CORE_KEY,
    written: false,
  };
}

// ============================================================
//  Veteran-discount monitoring (loss-prevention backstop)
//  The incentive rewards a low discount rate; this surfaces the
//  outliers who apply the Veteran discount far more often than
//  their store peers — the "winker" signal. Uses share-of-orders
//  (less basket-size distortion than $ rate) + peer-relative.
// ============================================================

// The discount target rate (decimal) — the single knob behind the incentive bonus
// line AND the leaderboard color/KPI. Source of truth = the incentive budtender
// discountMaxPct (percent), editable in Settings and the incentive tray. Green at
// or under target, amber up to 2× target, red above. Default 1.5%.
function getDiscountTargetDec_() {
  try {
    var pct = getIncentiveThresholds_().budtender.discountMaxPct;
    if (pct != null && !isNaN(pct) && pct > 0) return pct / 100;
  } catch (e) {}
  return 0.015;
}
// The "red" line — staff above this are flagged and colored red on the leaderboard.
function discountRedLineDec_() { return 2 * getDiscountTargetDec_(); }

const VET_NAME_RE = /veteran/i;

function _median_(arr) {
  if (!arr.length) return 0;
  var s = arr.slice().sort(function(a, b){ return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Per-seller Veteran-discount stats over a trailing window (default 30 days).
 * Returns rows (sellers with >= minTxn transactions), per-store median vet
 * share-of-orders, distribution percentiles, and chain rates.
 */
function computeVetStats_(days, minTxn) {
  days   = Math.min(Math.max(days || 30, 7), 90);
  minTxn = minTxn || 20;
  var now   = new Date().getTime();
  var range = { fromUTC: new Date(now - days * 86400000).toISOString(), toUTC: new Date(now).toISOString() };
  var byStore = fetchAllStoresTransactions_(range);
  var emp = {};   // key -> { name, storeSlug, sales, subtotal, vet, vetCount, bdt, txn }
  Object.keys(byStore).forEach(function(slug) {
    (byStore[slug] || []).forEach(function(tx) {
      var e = txEmployee_(tx), k = nameToKey_(e.name);
      var o = emp[k] || (emp[k] = { name: e.name, nameKey: k, storeSlug: slug, sales: 0, subtotal: 0, vet: 0, vetCount: 0, bdt: 0, txn: 0 });
      o.sales    += txTotal_(tx);
      o.subtotal += txSubtotal_(tx);
      o.bdt      += txDiscountBudtender_(tx);
      o.txn++;
      (tx.discounts || []).forEach(function(d) {
        if (VET_NAME_RE.test(d.discountName || '')) { o.vet += Number(d.amount || 0); o.vetCount++; }
      });
    });
  });
  var rows = Object.keys(emp).map(function(k) {
    var o = emp[k];
    return { name: o.name, nameKey: k, storeSlug: o.storeSlug, txn: o.txn, sales: Math.round(o.sales),
      vetRate:   o.subtotal > 0 ? Math.round(o.vet / o.subtotal * 10000) / 100 : 0,
      bdtRate:   o.subtotal > 0 ? Math.round(o.bdt / o.subtotal * 10000) / 100 : 0,
      vetCount:  o.vetCount,
      vetPerTxn: o.txn > 0 ? Math.round(o.vetCount / o.txn * 1000) / 10 : 0 };
  }).filter(function(r) { return r.txn >= minTxn; });
  // Per-store median share-of-orders (peer baseline)
  var byStoreVals = {};
  rows.forEach(function(r) { (byStoreVals[r.storeSlug] = byStoreVals[r.storeSlug] || []).push(r.vetPerTxn); });
  var storeMedians = {};
  Object.keys(byStoreVals).forEach(function(s) { storeMedians[s] = Math.round(_median_(byStoreVals[s]) * 10) / 10; });
  return { days: days, rows: rows, storeMedians: storeMedians };
}

/**
 * Veteran-discount investigate flags. A seller is flagged when their share of
 * orders carrying a Veteran discount clears an absolute floor AND runs well
 * above their own store's median — i.e. high for their store, not just a
 * vet-dense location. Tunable via opts.
 */
function vetFlags_(days, opts) {
  opts = opts || {};
  var floor   = opts.floor   || 8;    // min vet share-of-orders (%) to consider
  var mult    = opts.mult    || 1.5;  // × store median
  var minTxn  = opts.minTxn  || 40;   // enough volume for a stable share
  var stats = computeVetStats_(days, minTxn);
  var flags = stats.rows.map(function(r) {
    var med = stats.storeMedians[r.storeSlug] || 0;
    var bar = Math.max(floor, Math.round(med * mult * 10) / 10);
    var rel = med > 0 ? Math.round(r.vetPerTxn / med * 10) / 10 : null;
    return { name: r.name, nameKey: r.nameKey, storeSlug: r.storeSlug, txn: r.txn,
      vetPerTxn: r.vetPerTxn, vetRate: r.vetRate, storeMedian: med, bar: bar, rel: rel,
      flagged: r.vetPerTxn >= bar };
  }).filter(function(f) { return f.flagged; })
    .sort(function(a, b) { return b.vetPerTxn - a.vetPerTxn; });
  return { ok: true, days: stats.days, floor: floor, mult: mult, minTxn: minTxn,
    storeMedians: stats.storeMedians, flags: flags };
}
