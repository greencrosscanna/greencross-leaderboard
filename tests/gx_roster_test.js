// ============================================================
//  gx_roster.gs — the store-crew gate (gxBelongsToStore_)
//
//  This gate decides two things now, not one:
//    1. whose trophies a store shows (original use), and
//    2. who appears on the board as an OFF-SHIFT ghost card
//       (added 2026-08-22 — endpoints.gs getStoreToday /
//       getStoreLeaderboard).
//
//  The board use is why this suite exists. The roster is built
//  from 30 days of transactions, so one covered shift left
//  Drew Phillips (home_store 'corporate') parked on Portland
//  and River as an off-shift card every day afterwards.
//
//  The gate FAILS OPEN by design. Those cases are asserted here
//  too: a regression that made it fail CLOSED would silently
//  empty the kiosk, which is far worse than the bug it fixes.
//
//  Run:  node tests/gx_roster_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

// GX Core rows, shaped like the real getEmployees() payload.
const CORE_ROWS = [
  { employee_id: 'e1', full_name: 'Casey Nguyen',  dutchie_employee_id: '101', home_store: 'portland',  status: 'active' },
  { employee_id: 'e2', full_name: 'Drew Phillips', dutchie_employee_id: '202', home_store: 'corporate', status: 'active' },
  { employee_id: 'e3', full_name: 'Robin Vega',    dutchie_employee_id: '303', home_store: '',          status: 'active' },
];

// store_id is deliberately NOT the app slug for River — that translation through the shared
// registry is the part a hand-rolled map gets wrong.
const CORE_STORES = [
  { store_id: 'portland', display_name: 'Portland', dutchie_name: 'Portland', color: '#fff', sort_order: '1' },
  { store_id: 'river-rd', display_name: 'River',    dutchie_name: 'River Rd', color: '#fff', sort_order: '2' },
];

// This app's own 30-day sales roster — everyone below rang something at Portland recently.
const APP_ROSTER = {
  portland: [
    { id: '101', name: 'Casey Nguyen',  initials: 'CN' },
    { id: '202', name: 'Drew Phillips', initials: 'DP' },
    { id: '303', name: 'Robin Vega',    initials: 'RV' },
    { id: '404', name: 'Pat Okafor',    initials: 'PO' },   // no GX Core row at all
  ],
  river: [
    { id: '202', name: 'Drew Phillips', initials: 'DP' },
  ],
};

const rosterProps = {
  getProperty: function (k) {
    return k === 'GC_STORE_EMPLOYEES_JSON' ? JSON.stringify(APP_ROSTER) : null;
  },
  setProperty: function () { return this; },
  deleteProperty: function () { return this; },
  getProperties: function () { return {}; },
  setProperties: function () { return this; },
};

const S = H.load(['gx_roster.gs', 'dutchie_proxy.gs', 'endpoints.gs'], {
  stubs: {
    PropertiesService: {
      getScriptProperties: function () { return rosterProps; },
      getUserProperties:   function () { return rosterProps; },
      getDocumentProperties: function () { return rosterProps; },
    },
    GXCore: {
      getEmployees: function () { return CORE_ROWS; },
      getStores:    function () { return CORE_STORES; },
    },
  },
});

const PORTLAND = { slug: 'portland', name: 'Portland' };
const RIVER    = { slug: 'river',    name: 'River' };

// ── The gate ─────────────────────────────────────────────────
function test_gxBelongsToStore_() {
  const casey = { id: '101', name: 'Casey Nguyen' };
  const drew  = { id: '202', name: 'Drew Phillips' };

  _ok_('crew member belongs at their own store', S.gxBelongsToStore_(casey, PORTLAND));
  _eq_('crew member does NOT belong at another store', S.gxBelongsToStore_(casey, RIVER), false);

  // The reported bug: corporate staff on a store board.
  _eq_('corporate home_store is not any store\'s crew (portland)', S.gxBelongsToStore_(drew, PORTLAND), false);
  _eq_('corporate home_store is not any store\'s crew (river)',    S.gxBelongsToStore_(drew, RIVER),    false);
}

// ── Fails open — the cases that must NEVER hide anybody ───────
function test_gxBelongsToStore_failsOpen_() {
  _ok_('no GX Core record at all → shown',
       S.gxBelongsToStore_({ id: '404', name: 'Pat Okafor' }, PORTLAND));
  _ok_('Core record with a blank home_store → shown',
       S.gxBelongsToStore_({ id: '303', name: 'Robin Vega' }, PORTLAND));
  _ok_('unknown person, no id → shown',
       S.gxBelongsToStore_({ id: '', name: 'Nobody Here' }, PORTLAND));
}

// ── The store-id → app-slug translation the gate runs on ──────
// 'river-rd' vs 'river' is the whole reason this goes through the registry.
function test_storeIdTranslation_() {
  const map = S.gxStoreIdToAppSlug_();
  _eq_('river-rd translates to the app slug river', map['river-rd'], 'river');
  _eq_('portland translates to itself', map['portland'], 'portland');
}

// ── The gate is only inert when home_store really is absent ──
function test_gateActiveSignal_() {
  const r = S.gxRoster_();
  _eq_('withHomeStore counts the rows that carry one', r.withHomeStore, 2);
  _ok_('Drew resolves to his Core row by dutchie id', !!r.byDutchieId['202']);
  _eq_('and that row is corporate', r.byDutchieId['202'].homeStore, 'corporate');
}

H.run('gx_roster', {
  test_gxBelongsToStore_,
  test_gxBelongsToStore_failsOpen_,
  test_storeIdTranslation_,
  test_gateActiveSignal_,
});
