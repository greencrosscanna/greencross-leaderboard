// ============================================================
//  payPeriodCfg_ — where the pay-period calendar comes from
//  Run:  node tests/pay_period_source_test.js
//
//  THE BUG THIS EXISTS TO PREVENT (bug_mtmd4le4_crra, sev high, filed by
//  core-admin 2026-09-04; Sky's decision the same day).
//
//  GX Core's kv is the registry: cfg.payPeriodAnchor and cfg.payPeriodDays.
//  Crew reads it. SPIFF reads it. Leaderboard did NOT — it read its own
//  Script Property, falling back to a string literal that happened to match.
//  Four apps agreeing by coincidence rather than construction.
//
//  Leaderboard is the one that mattered, because it is not a consumer of pay
//  periods but the PUBLISHER: it writes period_goals and publishes
//  goal_publications, which Sales and Crew inherit. So the app whose
//  boundaries everyone else adopts derived them from a value nobody else
//  could see or edit. The day the anchor moves in the Command Center, Crew
//  and SPIFF follow and this app does not — and it publishes goals for a
//  fortnight payroll is not running. Silently: every app reads its own
//  configured source correctly, and a date that is merely WRONG still parses.
//
//  The length had the same split with a nastier failure mode. The anchor is a
//  Script Property (global, live, no deploy) while the length was a code
//  constant needing a push and a redeploy, so a cadence change could
//  HALF-APPLY — anchor moves instantly, length lags, and in between the
//  calendar matches neither the old nor the new one with nothing erroring.
//  Hence both values, one resolver.
//
//  Note the harness stubs GXCore as a Proxy that THROWS on any access, so the
//  default run here exercises the unreachable-Core path. That is the kiosk
//  case and it must still produce a board.
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

const S = H.load(['dutchie_proxy.gs'], {
  extraExports: '"resetPPCache": function () { _ppStartCache_ = null; _propsCache_ = null; _ppCfgCache_ = null; },'
              + '"setGXCore": function (v) { GXCore = v; }',
});

/** Resolve the calendar with a given fake GX Core and optional local property. */
function resolve(gxcore, localAnchor) {
  S.resetPPCache();
  S.setGXCore(gxcore);
  const props = { getProperty: function () { return localAnchor || null; } };
  return S.payPeriodCfg_(props);
}
const CORE = (a, d) => ({ getKv: function (k) {
  return k === 'cfg.payPeriodAnchor' ? a : k === 'cfg.payPeriodDays' ? d : null; } });
const DEAD = { getKv: function () { throw new Error('GX Core unreachable'); } };

/** The registry wins */
function test_registryWins_() {
  const c = resolve(CORE('2026-06-01', '14'), '2026-05-11');
  _eq_('anchor comes from GX Core, not the local property', c.anchor, '2026-06-01');
  _eq_('length comes from GX Core too', c.days, 14);
  _eq_('and it says so', c.source, 'gxcore');
}

/** A cadence change applies to BOTH halves at once */
function test_cadenceMovesBothHalves_() {
  // The half-apply window: this is the case that used to be impossible to
  // express, because the length lived in code and could not move with the anchor.
  const c = resolve(CORE('2026-06-01', '7'), null);
  _eq_('a weekly cadence is honored', c.days, 7);
  _eq_('together with its anchor', c.anchor, '2026-06-01');
}

/** Fallback order: Core → local property → literal */
function test_fallbackOrder_() {
  const c1 = resolve(DEAD, '2026-04-27');
  _eq_('Core unreachable → the local property', c1.anchor, '2026-04-27');
  _eq_('and it is labeled as the fallback', c1.source, 'script-property');
  _eq_('length falls back to the default', c1.days, 14);

  const c2 = resolve(DEAD, null);
  _eq_('neither available → the literal default', c2.anchor, '2026-05-11');
  _eq_('labeled as the last resort', c2.source, 'default');
}

/** A kiosk that cannot reach GX Core still shows a board */
function test_kioskSurvivesOutage_() {
  // Survived and logged, never thrown — this runs on the all-staff kiosk.
  let threw = false;
  try { resolve(DEAD, null); } catch (e) { threw = true; }
  _ok_('an unreachable registry does not throw', !threw);

  let threw2 = false;
  try { resolve({ getKv: function () { return undefined; } }, null); } catch (e) { threw2 = true; }
  _ok_('a registry that answers with nothing does not throw', !threw2);
}

/** Garbage in the registry does not become the calendar */
function test_garbageIsRefused_() {
  // A date that is merely WRONG still parses, so the guard is on SHAPE. Anything
  // that is not YYYY-MM-DD is refused and the fallback runs.
  ['', 'not-a-date', '2026/06/01', '06-01-2026', null].forEach(function (bad) {
    const c = resolve(CORE(bad, '14'), '2026-04-27');
    _eq_('junk anchor "' + String(bad) + '" is refused', c.anchor, '2026-04-27');
  });
  [ '0', '-14', 'fourteen', '' ].forEach(function (bad) {
    const c = resolve(CORE('2026-06-01', bad), null);
    _eq_('junk length "' + String(bad) + '" falls back to the default', c.days, 14);
  });
}

/** One value from the registry, one from fallback, is allowed */
function test_mixedSources_() {
  const c = resolve(CORE('2026-06-01', null), null);
  _eq_('anchor still taken from Core', c.anchor, '2026-06-01');
  _eq_('length falls back', c.days, 14);
  _ok_('and the mixed source is visible', /default-days/.test(c.source));
}

/** The resolved calendar is what the boundary math uses */
function test_boundaryMathUsesIt_() {
  // The whole point: currentPPStart_ must derive from the registry, not from
  // the property it used to read directly.
  S.resetPPCache(); S.setGXCore(CORE('2026-06-01', '14'));
  H.setNow(Date.UTC(2026, 5, 10, 19, 0, 0));  // 2026-06-10, noon PT
  const pp = S.currentPPStart_({ getProperty: function () { return '2026-05-11'; } });
  _eq_('period start follows the REGISTRY anchor', H.fmtPT(pp.ppStartMs), '2026-06-01');
  _eq_('and its length', pp.PP_MS, 14 * 24 * 60 * 60 * 1000);

  // A 7-day cadence must actually shorten the period, not just the reported number.
  S.resetPPCache(); S.setGXCore(CORE('2026-06-01', '7'));
  const pp7 = S.currentPPStart_({ getProperty: function () { return null; } });
  _eq_('a weekly cadence moves the boundary', H.fmtPT(pp7.ppStartMs), '2026-06-08');
  _eq_('and the reported length', pp7.PP_MS, 7 * 24 * 60 * 60 * 1000);
}

/** Today’s live values are unchanged — this reads, it does not move anything */
function test_todayIsUnchanged_() {
  // cfg.payPeriodAnchor = 2026-05-11 and cfg.payPeriodDays = 14 in GX Core right
  // now, identical to the literals this app used to carry. Nothing about the
  // calendar changes: no boundary moves, no frozen snapshot is orphaned, no
  // closed payroll history is re-keyed.
  const viaCore  = resolve(CORE('2026-05-11', '14'), null);
  const viaLocal = resolve(DEAD, null);
  _eq_('registry and old literal agree on the anchor', viaCore.anchor, viaLocal.anchor);
  _eq_('and on the length', viaCore.days, viaLocal.days);
}

// Release the frozen clock before the summary — a leaked freeze would silently
// change the meaning of any suite that runs after this one in the same process.
H.setNow(null);

H.run('pay-period source', {
  test_registryWins_:            test_registryWins_,
  test_cadenceMovesBothHalves_:  test_cadenceMovesBothHalves_,
  test_fallbackOrder_:           test_fallbackOrder_,
  test_kioskSurvivesOutage_:     test_kioskSurvivesOutage_,
  test_garbageIsRefused_:        test_garbageIsRefused_,
  test_mixedSources_:            test_mixedSources_,
  test_boundaryMathUsesIt_:      test_boundaryMathUsesIt_,
  test_todayIsUnchanged_:        test_todayIsUnchanged_,
});
