// ============================================================
//  A closed period is scored against the rules that applied TO IT
//
//  Run:  node tests/incentive_frozen_scheme_test.js
//
//  WHY THIS SUITE EXISTS
//  ---------------------
//  getIncentiveData_ freezes a completed period's PERFORMANCE — computed once, cached
//  forever, "these numbers paid people" — and, since the DST remediation, its GOAL as well
//  (asOfPeriodGoal_). The THRESHOLDS were still read live, for every period, always.
//
//  So editing the discount goal today silently re-scored every fortnight already paid: same
//  frozen sales, same frozen goal, different bar. Nothing errored and nothing looked odd —
//  the payload simply asserted that a 2025 period had been measured against a 2026 rule.
//
//  It is the same bug the goal half of this function already fixed, one field along, and the
//  same one GX Crew found on its own approval path on 2026-08-31.
//
//  THE THIRD ANSWER IS THE POINT. The 28 snapshots taken before the scheme was frozen have
//  no recorded scheme and nobody wrote down what it was. Substituting today's is the bug;
//  substituting the defaults is a different wrong number stated just as confidently. Unknown
//  is reported as unknown, and `thresholds` comes back null.
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

/* A real in-memory Script Properties, so a write in one call is visible to the next — the
   whole mechanism under test is "what got stored when the period closed". */
function makeProps(seed) {
  const store = Object.assign(Object.create(null), seed || {});
  return {
    store: store,
    api: {
      getProperty: k => (store[k] === undefined ? null : store[k]),
      setProperty: function (k, v) { store[k] = String(v); return this; },
      deleteProperty: function (k) { delete store[k]; return this; },
      getProperties: () => Object.assign({}, store),
      setProperties: function (o) { Object.assign(store, o); return this; },
    },
  };
}

const SCHEME_2025 = { budtender: { discountMaxPct: 2.75, aovTarget: 30, aovBonus: 25, discountBonus: 25,
                                   attendanceBonus: 15, txnQualify: 200, txnQualifyLowVol: 150, lowVolStores: [] },
                      manager:   { discountTiers: [{ bonus: 100 }, { bonus: 50 }], salesTiers: [],
                                   aovTarget: 30, aovBonus: 50, teamAttendancePerHead: 25 },
                      admin:     { tiers: [], maxPerStore: 50 } };
const SCHEME_TODAY = JSON.parse(JSON.stringify(SCHEME_2025));
SCHEME_TODAY.budtender.discountMaxPct = 1.0;      // the edit that used to reach back in time
SCHEME_TODAY.budtender.aovTarget = 33;

/* A frozen performance snapshot, in the shape getIncentiveData_ reads back. Seeding it means
   computeIncentivePerf_ is never called, so this suite touches no Dutchie stub at all. */
const PERF = { stores: {}, budtenders: [], adminName: 'Mike', adminActual: 0 };

const CLOSED = '2025-09-01';                       // safely in the past for any run date

function build(seed) {
  const props = makeProps(seed);
  const S = H.load(['endpoints.gs', 'dutchie_proxy.gs'], {
    stubs: {
      PropertiesService: {
        getScriptProperties: () => props.api,
        getUserProperties: () => props.api,
        getDocumentProperties: () => props.api,
      },
      GXCore: { getKv: k => (k === 'incentiveThresholds' ? JSON.stringify(SCHEME_TODAY) : '') },
      /* Live in dutchie_fetch.gs and goals.gs. Stubbed rather than loaded: this suite is about
         which SCHEME comes back, and pulling in the Dutchie fetch layer to round a number would
         make the fixture the thing under test. */
      r2_: n => Math.round(n * 100) / 100,
      asOfPeriodGoal_: () => 0,
      /* No transactions: the aggregation is not what is being tested, and an empty fetch still
         exercises the freeze-on-close path in full. */
      fetchAllStoresTransactions_: () => ({}),
      /* getRoles_ IS defined in the loaded source, so it runs for real and only needs its
         warning sink; a stub here would be shadowed by the declaration and quietly ignored. */
      gxRosterWarn_: () => {},
      aggregateTransactions_: () => ({ byEmployee: {}, storeTotal: {} }),
    },
    extraExports: '"resetPPCache": function () { _ppStartCache_ = null; _propsCache_ = null; _incThreshCache_ = null; }',
  });
  S.resetPPCache();
  return { S, props };
}

const seedFor = (pp, scheme) => {
  const s = { ['GC_INC_PERF_v2_' + pp]: JSON.stringify(PERF) };
  if (scheme) s['GC_INC_SCHEME_' + pp] = JSON.stringify(scheme);
  return s;
};


// ── 1. a closed period reports the scheme it was SCORED against ──
function test_closedPeriodServesItsFrozenScheme() {
  const { S } = build(seedFor(CLOSED, SCHEME_2025));
  const d = S.getIncentiveData_(CLOSED, false);
  _eq_('source says frozen', d.thresholds_source, 'frozen');
  _eq_("the bar is the 2025 one, not today's", d.thresholds.budtender.discountMaxPct, 2.75);
  _eq_('the whole scheme comes back, not just the bar', d.thresholds.budtender.aovTarget, 30);
  _eq_('and the period really is closed', d.payPeriod.current, false);
}

// ── 2. THE BUG: moving the live bar must not re-score a paid fortnight ──
function test_liveEditDoesNotReachBackIntoAPaidPeriod() {
  const { S } = build(seedFor(CLOSED, SCHEME_2025));
  const d = S.getIncentiveData_(CLOSED, false);
  _ok_('the live scheme is NOT what came back',
       d.thresholds.budtender.discountMaxPct !== SCHEME_TODAY.budtender.discountMaxPct);
  _eq_('it is the frozen one', d.thresholds.budtender.discountMaxPct, 2.75);
  _eq_('and the live aovTarget did not leak in either', d.thresholds.budtender.aovTarget, 30);
}

// ── 3. no recorded scheme is reported as unknown, never as today's ──
function test_unrecordedSchemeIsNotSubstituted() {
  const { S } = build(seedFor(CLOSED, null));       // the 28 pre-existing snapshots
  const d = S.getIncentiveData_(CLOSED, false);
  _eq_('source says unrecorded', d.thresholds_source, 'unrecorded');
  _eq_('thresholds is null, so nothing can be scored by accident', d.thresholds, null);
}

// ── 4. a half-written scheme is unknown too, not partially applied ──
function test_incompleteSchemeCountsAsUnrecorded() {
  const { S } = build(seedFor(CLOSED, { budtender: SCHEME_2025.budtender }));   // no manager, no admin
  const d = S.getIncentiveData_(CLOSED, false);
  _eq_('incomplete counts as unknown', d.thresholds_source, 'unrecorded');
  _eq_('thresholds is null', d.thresholds, null);
}

// ── 5. unparseable stored JSON degrades, it does not throw ──
function test_corruptSchemeDegrades() {
  const seed = seedFor(CLOSED, null);
  seed['GC_INC_SCHEME_' + CLOSED] = '{not json';
  const { S } = build(seed);
  const d = S.getIncentiveData_(CLOSED, false);
  _eq_('still answers', d.thresholds_source, 'unrecorded');
  _eq_('with no scheme', d.thresholds, null);
}

// ── 6. the OPEN period is scored live — freezing it would be the opposite bug ──
function test_openPeriodIsScoredLive() {
  const probe = build({});
  const cur = probe.S.getIncentiveData_(null, false).payPeriod.start;
  /* A scheme deliberately STORED against the open period's key: the current period must ignore
     it. Otherwise a period that closed, froze, and then reopened at a boundary would keep
     serving a stale bar to the fortnight people are still selling in. */
  const { S } = build({ ['GC_INC_PERF_v2_' + cur]: JSON.stringify(PERF),
                        ['GC_INC_SCHEME_' + cur]: JSON.stringify(SCHEME_2025) });
  const d = S.getIncentiveData_(cur, false);
  _eq_('source says live', d.thresholds_source, 'live');
  _eq_("and it is today's bar", d.thresholds.budtender.discountMaxPct, 1.0);
}

// ── 7. closing a period WRITES the scheme beside the performance ──
function test_closingAPeriodFreezesTheSchemeWithIt() {
  const { S, props } = build({});                  // nothing cached: the first view after close
  const d = S.getIncentiveData_(CLOSED, false);
  _ok_('the performance snapshot was written', !!props.store['GC_INC_PERF_v2_' + CLOSED]);
  _ok_('and the scheme was written in the same breath', !!props.store['GC_INC_SCHEME_' + CLOSED]);
  _eq_('this read already reports it as frozen', d.thresholds_source, 'frozen');
  _eq_("and it is the scheme that was live at close", d.thresholds.budtender.discountMaxPct, 1.0);
  /* The point of freezing: read it again after the live bar moves and it must not follow. */
  const again = build(Object.assign({}, props.store));
  const d2 = again.S.getIncentiveData_(CLOSED, false);
  _eq_('a later read still sees the scheme as at close', d2.thresholds.budtender.discountMaxPct, 1.0);
  _eq_('and still calls it frozen', d2.thresholds_source, 'frozen');
}

// ── 8. the scheme key must not land in the frozenperiods inventory ──
function test_schemeKeyIsOutsideTheSnapshotPrefix() {
  /* frozenperiods globs GC_INC_PERF_ to name the snapshots that exist ONLY in this app — the
     list that decides what a migration has to carry. A scheme key caught by that prefix would
     be reported as a pay period with no rows and no total. */
  _ok_('GC_INC_SCHEME_ does not start with GC_INC_PERF_',
       ('GC_INC_SCHEME_' + CLOSED).indexOf('GC_INC_PERF_') !== 0);
  const proxy = require('fs').readFileSync(__dirname + '/../dutchie_proxy.gs', 'utf8');
  _ok_('and frozenperiods still filters on that prefix (this suite is vacuous otherwise)',
       proxy.indexOf("indexOf('GC_INC_PERF_') !== 0") > -1);
}

H.run('incentive frozen scheme', {
  test_closedPeriodServesItsFrozenScheme,
  test_liveEditDoesNotReachBackIntoAPaidPeriod,
  test_unrecordedSchemeIsNotSubstituted,
  test_incompleteSchemeCountsAsUnrecorded,
  test_corruptSchemeDegrades,
  test_openPeriodIsScoredLive,
  test_closingAPeriodFreezesTheSchemeWithIt,
  test_schemeKeyIsOutsideTheSnapshotPrefix,
});
