// ============================================================
//  THE STORE LIST COMES FROM GX CORE — refreshStoreRegistry_ (dutchie_proxy.gs)
//
//  Bug: "A new store would never appear on the board" — the list was typed into the code.
//  The rules Sky chose on 2026-09-14, each asserted below:
//    - the six known stores keep their order, slugs and locationName (kiosk URLs, saved goals,
//      ledgers and Sales' goal keys cannot move); only their NAME follows Core
//    - a new store is added after them, in Core's sort_order
//    - a store removed from the registry leaves the live board
//    - distribution centers are never on the board
//    - the list is NEVER empty: Core -> last good answer -> the six
//  And one knock-on: saving manual goals must not erase a store that is briefly off the list.
//
//  Run:  node tests/store_registry_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

const CORE = [
  { store_id: 'bend',        display_name: 'Century',    dutchie_name: 'Bend',        sort_order: 1, is_dc: false },
  { store_id: 'center',      display_name: 'Center',     dutchie_name: 'Center',      sort_order: 2, is_dc: false },
  { store_id: 'commercial',  display_name: 'Commercial', dutchie_name: 'Commercial',  sort_order: 3, is_dc: false },
  { store_id: 'hillsboro',   display_name: 'Baseline',   dutchie_name: 'Hillsboro',   sort_order: 4, is_dc: false },
  { store_id: 'portland-rd', display_name: 'Portland',   dutchie_name: 'Portland Rd', sort_order: 5, is_dc: false },
  { store_id: 'river-rd',    display_name: 'River',      dutchie_name: 'River Rd',    sort_order: 6, is_dc: false },
];

let rows, coreThrows, props, cache;

function build() {
  props = {}; cache = {};
  return H.load(['dutchie_proxy.gs', 'goals.gs'], {
    stubs: {
      GXCore: {
        getStores: function () { if (coreThrows) throw new Error('GX Core unreachable'); return rows; },
        getKv: function () { return null; },
      },
      PropertiesService: { getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
          setProperty: function (k, v) { props[k] = String(v); return this; },
        };
      } },
      CacheService: { getScriptCache: function () {
        return {
          get: function (k) { return Object.prototype.hasOwnProperty.call(cache, k) ? cache[k] : null; },
          put: function (k, v) { cache[k] = v; },
          remove: function (k) { delete cache[k]; },
        };
      } },
    },
  });
}

const slugs = (A) => A.STORES.map((s) => s.slug);

H.run('store_registry', {

  unchangedRegistryKeepsTheSixExactly: function () {
    rows = CORE.slice(); coreThrows = false;
    const A = build();
    const r = A.refreshStoreRegistry_();
    _eq_('source is GX Core', r.source, 'core');
    _eq_('same six, same (board) order — not Core sort_order', slugs(A), ['baseline', 'center', 'century', 'commercial', 'portland', 'river']);
    _eq_('locationName kept, not derived (River is not "River Rd")',
      A.STORES.map((s) => s.locationName), ['Hillsboro', 'Center', 'Bend', 'Commercial', 'Portland Rd', 'River']);
  },

  newStoreAppendedWithItsOwnSlug: function () {
    rows = CORE.concat([
      { store_id: 'hood-river', display_name: 'Hood River', dutchie_name: 'Hood River OR', sort_order: 9 },
      { store_id: 'gresham',    display_name: 'Gresham',    dutchie_name: '',              sort_order: 7 },
    ]);
    coreThrows = false;
    const A = build();
    A.refreshStoreRegistry_();
    _eq_('new stores after the six, in Core sort_order', slugs(A).slice(6), ['gresham', 'hood-river']);
    const hr = A.STORES[7];
    _eq_('slug is URL-safe', hr.slug, 'hood-river');
    _eq_('storeId carried explicitly', hr.storeId, 'hood-river');
    _eq_('locationName from Dutchie name', hr.locationName, 'Hood River OR');
    _eq_('locationName falls back to the display name', A.STORES[6].locationName, 'Gresham');
  },

  removedStoreLeavesTheBoard: function () {
    rows = CORE.filter((r) => r.store_id !== 'center'); coreThrows = false;
    const A = build();
    A.refreshStoreRegistry_();
    _eq_('center gone, order of the rest kept', slugs(A), ['baseline', 'century', 'commercial', 'portland', 'river']);
  },

  distributionCentersNeverOnTheBoard: function () {
    rows = CORE.concat([{ store_id: 'dc', display_name: 'Warehouse', is_dc: 'TRUE', sort_order: 8 }]);
    coreThrows = false;
    const A = build();
    A.refreshStoreRegistry_();
    _ok_('a DC (text TRUE, as a sheet stores it) is excluded', slugs(A).indexOf('warehouse') === -1 && A.STORES.length === 6);
  },

  renameFollowsTheNameNotTheSlug: function () {
    rows = CORE.map((r) => r.store_id === 'river-rd' ? Object.assign({}, r, { display_name: 'River Road' }) : r);
    coreThrows = false;
    const A = build();
    A.refreshStoreRegistry_();
    const river = A.STORES.filter((s) => s.storeId === 'river-rd')[0];
    _eq_('slug unchanged', river.slug, 'river');
    _eq_('name follows Core', river.name, 'River Road');
  },

  slugCollisionIsDisambiguated: function () {
    rows = CORE.concat([{ store_id: 'center-2', display_name: 'Center', sort_order: 7 }]);
    coreThrows = false;
    const A = build();
    A.refreshStoreRegistry_();
    _eq_('a second "Center" cannot take the first one\'s slug', A.STORES[6].slug, 'center-center-2');
  },

  outageUsesTheLastGoodListNotTheSix: function () {
    rows = CORE.concat([{ store_id: 'gresham', display_name: 'Gresham', sort_order: 7 }]);
    coreThrows = false;
    const A = build();
    A.refreshStoreRegistry_();
    cache = {};                    // cache expired...
    coreThrows = true;             // ...and Core is down
    const r = A.refreshStoreRegistry_();
    _eq_('falls back to the last good answer', r.source, 'last-good');
    _ok_('which still has the store added before the outage', slugs(A).indexOf('gresham') === 6);
  },

  neverEmpty: function () {
    coreThrows = false; rows = [];
    const A = build();
    let r = A.refreshStoreRegistry_();
    _eq_('an empty registry answer is not "no stores"', r.source, 'known');
    _eq_('the six', A.STORES.length, 6);
    coreThrows = true;
    r = A.refreshStoreRegistry_();
    _eq_('Core down and nothing remembered: still the six', A.STORES.length, 6);
    rows = [{ store_id: 'dc', display_name: 'Warehouse', is_dc: true }]; coreThrows = false; cache = {};
    A.refreshStoreRegistry_();
    _eq_('a registry of only DCs is not "no stores" either', A.STORES.length, 6);
  },

  cachedAnswerSkipsTheLibraryCall: function () {
    rows = CORE.slice(); coreThrows = false;
    const A = build();
    A.refreshStoreRegistry_();
    coreThrows = true;   // would throw if called
    const r = A.refreshStoreRegistry_();
    _eq_('served from the 5-minute cache', r.source, 'core');
  },

  manualGoalSaveKeepsAStoreOffTheList: function () {
    rows = CORE.filter((r) => r.store_id !== 'center'); coreThrows = false;
    const A = build();
    props.GC_MANUAL_PP_GOALS_JSON = JSON.stringify({ center: 9000, river: 12000 });
    A.refreshStoreRegistry_();
    const key = Object.keys(props).find((k) => /MANUAL/.test(k));
    A.saveManualGoals_({ goals: JSON.stringify({ river: 13000, baseline: 0 }) });
    const saved = JSON.parse(props[key]);
    _eq_('center, briefly off the list, keeps its override', saved.center, 9000);
    _eq_('river updated', saved.river, 13000);
    _eq_('a 0 still clears a store that IS on the list', saved.baseline, undefined);
  },
});
