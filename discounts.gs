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
const GC_DISCOUNT_EXCL_KEY     = 'GC_DISCOUNT_EXCL_JSON';     // { overrides: { name: true|false } }  true = excluded

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

// ── Per-execution memoized reads (hot path must never hit Dutchie) ──
var _discRegMemo_ = null, _discCfgMemo_ = null;

function readDiscountRegistry_() {
  if (_discRegMemo_) return _discRegMemo_;
  var raw = getProps_().getProperty(GC_DISCOUNT_REGISTRY_KEY);
  try { _discRegMemo_ = raw ? JSON.parse(raw) : { byName: {} }; }
  catch (e) { _discRegMemo_ = { byName: {} }; }
  if (!_discRegMemo_.byName) _discRegMemo_.byName = {};
  return _discRegMemo_;
}

function readDiscConfig_() {
  if (_discCfgMemo_) return _discCfgMemo_;
  var raw = getProps_().getProperty(GC_DISCOUNT_EXCL_KEY);
  if (raw) { try { _discCfgMemo_ = JSON.parse(raw); } catch (e) { _discCfgMemo_ = null; } }
  if (!_discCfgMemo_ || !_discCfgMemo_.overrides) {
    var ov = {};
    DISCOUNT_SEED_EXCLUDED.forEach(function(n) { ov[n] = true; });
    _discCfgMemo_ = { overrides: ov };
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
  var cfg = (function () {
    var raw = getProps_().getProperty(GC_DISCOUNT_EXCL_KEY);
    if (raw) { try { return JSON.parse(raw); } catch (e) {} }
    var ov = {}; DISCOUNT_SEED_EXCLUDED.forEach(function (n) { ov[n] = true; });
    return { overrides: ov };
  })();
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
  };
}

/**
 * Persist discretionary discount toggles. params.overrides = JSON { name: bool }
 * (true = excluded). Class rules (loyalty/automatic) always win regardless of
 * what's saved here. Busts director/standings caches so rates refresh.
 */
function saveDiscountSettings_(params) {
  var incoming = {};
  try { incoming = JSON.parse(params.overrides || '{}'); } catch (e) { return { ok: false, error: 'bad overrides' }; }
  if (!incoming || typeof incoming !== 'object') return { ok: false, error: 'bad overrides' };
  var cfg = {};
  try { cfg = JSON.parse(getProps_().getProperty(GC_DISCOUNT_EXCL_KEY) || '{}'); } catch (e) {}
  var overrides = cfg.overrides || {};
  Object.keys(incoming).forEach(function (nm) { overrides[nm] = !!incoming[nm]; });
  getProps_().setProperty(GC_DISCOUNT_EXCL_KEY, JSON.stringify({ overrides: overrides }));
  _discCfgMemo_ = { overrides: overrides };
  // Director/standings aggregates cache the budtender discount rate; let them
  // rebuild so the new exclusions show (they carry a ≤6-min TTL regardless).
  try {
    var cache = CacheService.getScriptCache();
    cache.remove('gc_dirall_v2_pp'); cache.remove('gc_dirall_v2_mtd');
  } catch (e) {}
  return { ok: true, overrides: overrides };
}
