// ============================================================
//  discounts.gs — where the discretionary-discount OVERRIDES
//  come from, and what happens when GX Core cannot answer.
//
//  The overrides moved to GX Core kv `discountRules` on
//  2026-08-30 (GX Crew edits them there). They decide which
//  promotions count against a staff discount rate, which feeds
//  the incentive bonus — so a wrong answer here does not throw,
//  it pays someone the wrong amount.
//
//  Two things are worth a gate:
//    1. Core wins when it answers, and the LOCAL copy wins over
//       the seed when Core does not. A silent fall back to the
//       seed would reset every human decision to the 2026-08-07
//       defaults and look completely normal.
//    2. The fallback is VISIBLE. `source` must say which copy
//       was used, because that is the only signal anyone gets.
//
//  Run:  node tests/discount_overrides_source_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

// Build a sandbox whose GX Core kv and ScriptProperties we control.
// `coreValue` is exactly what GXCore.getKv returns: a raw string, null,
// or a thrown error (Core unreachable).
function boot(coreValue, localProperty) {
  const props = {};
  if (localProperty !== undefined) props['GC_DISCOUNT_EXCL_JSON'] = localProperty;
  const logs = [];
  const noProps = {
    getProperty: function (k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
    setProperty: function (k, v) { props[k] = v; return this; },
    deleteProperty: function (k) { delete props[k]; return this; },
    getProperties: function () { return props; },
    setProperties: function () { return this; },
  };
  const S = H.load(['dutchie_proxy.gs', 'discounts.gs'], {
    stubs: {
      Logger: { log: function (m) { logs.push(String(m)); } },
      PropertiesService: {
        getScriptProperties: function () { return noProps; },
        getUserProperties: function () { return noProps; },
        getDocumentProperties: function () { return noProps; },
      },
      GXCore: {
        getKv: function (key) {
          if (key !== 'discountRules') throw new Error('unexpected kv key: ' + key);
          if (coreValue instanceof Error) throw coreValue;
          return coreValue;
        },
      },
    },
  });
  S.resetDiscountMemos_();
  return { S: S, logs: logs, props: props };
}

const CORE_JSON = JSON.stringify({
  overrides: { 'Employee Discount': true, 'Manager Comp': true, 'Birthday 10%': false },
});

// ── 1. GX Core is the source of truth ────────────────────────
function test_core_wins_() {
  const b = boot(CORE_JSON, JSON.stringify({ overrides: { 'Employee Discount': false } }));
  const cfg = b.S.readDiscConfig_();
  _eq_('source is core', cfg.source, 'core');
  _eq_('no fallback reason', cfg.fallbackReason, null);
  _eq_('Core value wins over a disagreeing local copy', cfg.overrides['Employee Discount'], true);
  _eq_('a Core-only rule is present', cfg.overrides['Manager Comp'], true);
  _eq_('Core silence is not logged', b.logs.length, 0);

  // The rule actually reaches the classifier.
  _ok_('excluded per Core', b.S.isExcludedDiscount_('Employee Discount') === true);
  _ok_('counted per Core', b.S.isExcludedDiscount_('Birthday 10%') === false);
}

// ── 2. Fallbacks, and that they are audible ──────────────────
function test_fallback_to_local_property_() {
  const local = JSON.stringify({ overrides: { 'Employee Discount': true, 'Stale Only': true } });

  [['Core unreachable', new Error('boom')],
   ['Core key missing', null],
   ['Core key empty',   '   '],
   ['Core not JSON',    '{not json'],
   ['Core has no overrides', JSON.stringify({ thresholds: 1 })],
  ].forEach(function (c) {
    const b = boot(c[1], local);
    const cfg = b.S.readDiscConfig_();
    _eq_(c[0] + ' → property', cfg.source, 'property');
    _eq_(c[0] + ' → local rule applied', cfg.overrides['Stale Only'], true);
    _ok_(c[0] + ' → reason recorded', typeof cfg.fallbackReason === 'string' && cfg.fallbackReason.length > 0);
    _eq_(c[0] + ' → logged exactly once', b.logs.length, 1);
    _ok_(c[0] + ' → log names the fallback', /FALLBACK/.test(b.logs[0]));
  });
}

function test_fallback_to_seed_when_nothing_stored_() {
  const b = boot(null, undefined);
  const cfg = b.S.readDiscConfig_();
  _eq_('no Core, no property → seed', cfg.source, 'seed');
  _eq_('seed excludes the owner-confirmed list', cfg.overrides['Employee Discount'], true);
  _eq_('seed is logged', b.logs.length, 1);
}

function test_fallback_is_reported_on_the_settings_payload_() {
  // getDiscountSettings_ is what the tray and ?action=discountrules render. If the source
  // did not ride along, a fallback would be invisible to everyone but the log reader.
  const b = boot(new Error('down'), JSON.stringify({ overrides: { 'Employee Discount': true } }));
  b.props['GC_DISCOUNT_REGISTRY_JSON'] = JSON.stringify({
    builtAt: new Date().toISOString(),
    byName: { 'Employee Discount': { appMethod: 'Manual', code: '', klass: 'discretionary' } },
  });
  const out = b.S.getDiscountSettings_();
  _eq_('payload carries the source', out.source, 'property');
  _ok_('payload carries the reason', typeof out.fallbackReason === 'string' && out.fallbackReason.length > 0);
  _eq_('payload still lists the discount', out.discretionary.length, 1);
  _eq_('and its state', out.discretionary[0].excluded, true);
}

// ── 3. Reads are memoized — the hot path calls this per discount line ──
function test_memoised_per_execution_() {
  let calls = 0;
  const props = {};
  const S = H.load(['dutchie_proxy.gs', 'discounts.gs'], {
    stubs: {
      PropertiesService: {
        getScriptProperties: function () {
          return { getProperty: function (k) { return props[k] || null; }, setProperty: function () { return this; },
                   deleteProperty: function () { return this; }, getProperties: function () { return props; },
                   setProperties: function () { return this; } };
        },
        getUserProperties: function () { return this.getScriptProperties(); },
        getDocumentProperties: function () { return this.getScriptProperties(); },
      },
      GXCore: { getKv: function () { calls++; return CORE_JSON; } },
    },
  });
  S.resetDiscountMemos_();

  // 500 discount lines, as one busy store's pay period would produce.
  for (let i = 0; i < 500; i++) S.isExcludedDiscount_('Birthday 10%');
  _eq_('GXCore.getKv hit once for 500 discount lines', calls, 1);

  // ...and the memo is droppable, or a warm instance serves rules Crew already changed.
  S.resetDiscountMemos_();
  S.isExcludedDiscount_('Birthday 10%');
  _eq_('reset re-reads GX Core', calls, 2);
}

// ── 4. Class rules still beat the overrides ──────────────────
function test_class_rules_still_win_() {
  // A loyalty redemption is excluded even if someone marks it counted in Core,
  // and an automatic promo is excluded on the registry's word alone.
  const b = boot(JSON.stringify({ overrides: { 'Points Redemption': false, 'Vendor Day': false } }),
                 undefined);
  b.props['GC_DISCOUNT_REGISTRY_JSON'] = JSON.stringify({
    builtAt: new Date().toISOString(),
    byName: { 'Vendor Day': { appMethod: 'Automatic', code: '', klass: 'automatic' } },
  });
  b.S.resetDiscountMemos_();
  _ok_('loyalty excluded despite the override', b.S.isExcludedDiscount_('Points Redemption') === true);
  _ok_('automatic excluded despite the override', b.S.isExcludedDiscount_('Vendor Day') === true);
}

// ── 5. This app no longer writes the overrides ───────────────
function test_save_refuses_and_writes_nothing_() {
  const b = boot(CORE_JSON, undefined);
  const r = b.S.saveDiscountSettings_({ overrides: JSON.stringify({ 'Employee Discount': false }) });
  _eq_('save refuses', r.ok, false);
  _eq_('and says so', r.written, false);
  _ok_('and names where to edit', /Crew/.test(r.error || ''));
  _eq_('nothing was written to the local property',
       b.props['GC_DISCOUNT_EXCL_JSON'] === undefined, true);
  // The refusal must not poison the memo either — the next read still comes from Core.
  _eq_('Core still wins after a refused save', b.S.readDiscConfig_().overrides['Employee Discount'], true);
}

H.run('discount overrides source', {
  test_core_wins_,
  test_fallback_to_local_property_,
  test_fallback_to_seed_when_nothing_stored_,
  test_fallback_is_reported_on_the_settings_payload_,
  test_memoised_per_execution_,
  test_class_rules_still_win_,
  test_save_refuses_and_writes_nothing_,
});
