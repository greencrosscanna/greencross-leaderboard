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
  { employee_id: 'e1', full_name: 'Casey Nguyen',  dutchie_employee_id: '101', home_store: 'portland-rd', status: 'active' },
  { employee_id: 'e2', full_name: 'Drew Phillips', dutchie_employee_id: '202', home_store: 'corporate', status: 'active' },
  { employee_id: 'e3', full_name: 'Robin Vega',    dutchie_employee_id: '303', home_store: '',          status: 'active' },
  // Crew of RIVER, but lingering on Portland's 30-day roster from a covered shift. STORES reaches
  // portland before river, so first-store-wins attribution used to file them under Portland.
  { employee_id: 'e4', full_name: 'Jamie Cruz',    dutchie_employee_id: '505', home_store: 'river-rd',  status: 'active' },
];

// store_id is deliberately NOT the app slug for River — that translation through the shared
// registry is the part a hand-rolled map gets wrong.
// The REAL registry, as GX Core publishes it. Four of the six store_ids differ from this app's
// slug — that translation is the whole reason the gate goes through the registry and not a hand map.
const CORE_STORES = [
  { store_id: 'bend',        display_name: 'Century',    dutchie_name: 'Hillsboro',   color: '#fff', sort_order: '1' },
  { store_id: 'center',      display_name: 'Center',     dutchie_name: 'Center',      color: '#fff', sort_order: '2' },
  { store_id: 'commercial',  display_name: 'Commercial', dutchie_name: 'Commercial',  color: '#fff', sort_order: '3' },
  { store_id: 'hillsboro',   display_name: 'Baseline',   dutchie_name: 'Bend',        color: '#fff', sort_order: '4' },
  { store_id: 'portland-rd', display_name: 'Portland',   dutchie_name: 'Portland Rd', color: '#fff', sort_order: '5' },
  { store_id: 'river-rd',    display_name: 'River',      dutchie_name: 'River',       color: '#fff', sort_order: '6' },
];

// This app's own 30-day sales roster — everyone below rang something at Portland recently.
const APP_ROSTER = {
  portland: [
    { id: '101', name: 'Casey Nguyen',  initials: 'CN' },
    { id: '202', name: 'Drew Phillips', initials: 'DP' },
    { id: '303', name: 'Robin Vega',    initials: 'RV' },
    { id: '404', name: 'Pat Okafor',    initials: 'PO' },   // no GX Core row at all
    { id: '505', name: 'Jamie Cruz',    initials: 'JC' },
  ],
  river: [
    { id: '202', name: 'Drew Phillips', initials: 'DP' },
    { id: '505', name: 'Jamie Cruz',    initials: 'JC' },
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

const S = H.load(['gx_roster.gs', 'dutchie_proxy.gs', 'endpoints.gs', 'dutchie_fetch.gs', 'goals.gs', 'auth.gs'], {
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
  extraExports: '"resetPPCache": function () { _ppStartCache_ = null; _propsCache_ = null; _gxRosterMemo_ = null; }',
});

function RealDateUTC(y, m, d, h, mi, se) { return Date.UTC(y, m, d, h, mi, se); }

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
  _eq_('portland-rd translates to the app slug portland', map['portland-rd'], 'portland');
  _eq_('bend translates to century, not bend', map['bend'], 'century');
  _eq_('hillsboro translates to baseline', map['hillsboro'], 'baseline');
}

// ── The gate is only inert when home_store really is absent ──
function test_gateActiveSignal_() {
  const r = S.gxRoster_();
  _eq_('withHomeStore counts the rows that carry one', r.withHomeStore, 3);
  _ok_('Drew resolves to his Core row by dutchie id', !!r.byDutchieId['202']);
  _eq_('and that row is corporate', r.byDutchieId['202'].homeStore, 'corporate');
}

// ── Call site: getDirectorStaff's roster fill ────────────────
// Top Performers pads its list with roster names at $0 so it shows all staff, not just sellers.
// That fill had two faults, both fixed by the same gate:
//   1. corporate staff (no store) were padded in at $0, and
//   2. storeSlug came from whichever store reached the name first in STORES order.
function test_directorStaff_rosterFill_() {
  H.setNow(RealDateUTC(2026, 6, 15, 19, 0, 0));   // 2026-07-15 12:00 PDT — mid-month, mid-period
  S.resetPPCache();
  try {
    // No transactions anywhere: every name in the result got there via the roster fill.
    const out = S.getDirectorStaff({ period: 'mtd' }, { byStoreAgg: {}, byStoreToday: {} });
    const by  = Object.create(null);
    out.staff.forEach(function (s2) { by[s2.nameKey] = s2; });

    _ok_('a store crew member is still padded in', !!by['casey_nguyen']);
    _eq_('and lands at their own store', by['casey_nguyen'].storeSlug, 'portland');
    _eq_('padded-in staff carry no sales', by['casey_nguyen'].sales, 0);

    // The reported bug.
    _eq_('corporate staff are no longer padded in at $0', by['drew_phillips'], undefined);

    // The attribution bug: Jamie is on BOTH rosters, and portland comes first in STORES.
    _ok_('a two-roster name is still padded in', !!by['jamie_cruz']);
    _eq_('and lands at their HOME store, not the first one round the loop',
         by['jamie_cruz'].storeSlug, 'river');

    // Fails open — these two must never be dropped by the gate.
    _ok_('no Core record at all is still padded in', !!by['pat_okafor']);
    _ok_('blank home_store is still padded in', !!by['robin_vega']);
  } finally {
    H.setNow(null);
    S.resetPPCache();
  }
}

// A corporate covering a shift SOLD something — the gate must not touch that path.
function test_directorStaff_corporateWhoTransacts_() {
  H.setNow(RealDateUTC(2026, 6, 15, 19, 0, 0));
  S.resetPPCache();
  try {
    const out = S.getDirectorStaff({ period: 'mtd' }, {
      byStoreAgg: {
        portland: { byEmployee: {
          '202': { id: '202', name: 'Drew Phillips', initials: 'DP', sales: 1250, transactions: 20,
                   items: 48, discounts: 30, discountsBdt: 12, subtotal: 1280 },
        } },
      },
      byStoreToday: {},
    });
    const drew = out.staff.filter(function (s2) { return s2.nameKey === 'drew_phillips'; })[0];
    _ok_('a corporate who transacted DOES appear', !!drew);
    _eq_('with their real sales, not zeroed', drew && drew.sales, 1250);
    _eq_('attributed to the store they rang them at', drew && drew.storeSlug, 'portland');
  } finally {
    H.setNow(null);
    S.resetPPCache();
  }
}

H.run('gx_roster', {
  test_gxBelongsToStore_,
  test_gxBelongsToStore_failsOpen_,
  test_storeIdTranslation_,
  test_gateActiveSignal_,
  test_directorStaff_rosterFill_,
  test_directorStaff_corporateWhoTransacts_,
});
