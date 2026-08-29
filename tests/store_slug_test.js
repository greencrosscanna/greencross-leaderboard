// ============================================================
//  auth.gs — gxSlugForStoreId_: GX Core store_id → this app's slug
//
//  The slug IS display_name lowercased, so it can be derived from the live registry
//  instead of a hardcoded map — that is the point of the store-registry consolidation:
//  a store renamed or added in the Command Center should place correctly here with no
//  deploy. Verified against live gxstores 2026-08-28; all six agree.
//
//  What these assertions really guard is the two ways deriving could go WRONG, both of
//  which end with somebody signed in to the wrong store's data:
//
//    1. Core unreachable must not become "cannot sign in". The static map stays as an
//       offline fallback for exactly this. A stale registry is survivable; an
//       unreachable one at sign-in is not.
//    2. An unknown store must still FAIL CLOSED. gxSessionUsable_ refuses the session on
//       null rather than guessing — a manager placed by a guess lands on another store's
//       numbers, which is the failure this whole area keeps producing.
//
//  Run:  node tests/store_slug_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

// The live registry, verbatim from ?action=gxstores on 2026-08-28.
const CORE_STORES = [
  { store_id: 'bend',        display_name: 'Century',    dutchie_name: 'Bend',        color: '#22D3EE', sort_order: '1' },
  { store_id: 'center',      display_name: 'Center',     dutchie_name: 'Center',      color: '#3B82F6', sort_order: '2' },
  { store_id: 'commercial',  display_name: 'Commercial', dutchie_name: 'Commercial',  color: '#A855F7', sort_order: '3' },
  { store_id: 'hillsboro',   display_name: 'Baseline',   dutchie_name: 'Hillsboro',   color: '#6366F1', sort_order: '4' },
  { store_id: 'portland-rd', display_name: 'Portland',   dutchie_name: 'Portland Rd', color: '#D946EF', sort_order: '5' },
  { store_id: 'river-rd',    display_name: 'River',      dutchie_name: 'River Rd',    color: '#EC4899', sort_order: '6' },
];

let _cache = {};
let _coreMode = 'ok';          // 'ok' | 'throw' | 'empty' | custom rows

function build(mode) {
  _coreMode = mode || 'ok';
  _cache = {};
  return H.load(['dutchie_proxy.gs', 'auth.gs'], {
    stubs: {
      CacheService: {
        getScriptCache: function () {
          return {
            get: function (k) { return Object.prototype.hasOwnProperty.call(_cache, k) ? _cache[k] : null; },
            put: function (k, v) { _cache[k] = v; },
          };
        },
      },
      GXCore: {
        getStores: function () {
          if (_coreMode === 'throw') throw new Error('GX Core unreachable');
          if (_coreMode === 'empty') return [];
          return Array.isArray(_coreMode) ? _coreMode : CORE_STORES;
        },
      },
    },
  });
}

function test_derivesEverySlugFromTheLiveRegistry() {
  const S = build('ok');
  _eq_('hillsboro is Baseline',   S.gxSlugForStoreId_('hillsboro'),   'baseline');
  _eq_('bend is Century',         S.gxSlugForStoreId_('bend'),        'century');
  _eq_('portland-rd is Portland', S.gxSlugForStoreId_('portland-rd'), 'portland');
  _eq_('river-rd is River',       S.gxSlugForStoreId_('river-rd'),    'river');
  _eq_('center is Center',        S.gxSlugForStoreId_('center'),      'center');
  _eq_('commercial is Commercial',S.gxSlugForStoreId_('commercial'),  'commercial');
}

function test_derivedMatchesTheStaticMapExactly() {
  // If these ever diverge, one of them is lying about where a manager belongs.
  const S = build('ok');
  Object.keys(S.GX_STOREID_TO_SLUG).forEach(function (id) {
    _eq_('derived === map for ' + id, S.gxSlugForStoreId_(id), S.GX_STOREID_TO_SLUG[id]);
  });
}

function test_caseInsensitiveOnTheStoreId() {
  const S = build('ok');
  _eq_('mixed case store_id', S.gxSlugForStoreId_('HillsBoro'), 'baseline');
  _eq_('trailing case',       S.gxSlugForStoreId_('BEND'),      'century');
}

function test_coreOutageFallsBackRatherThanLockingPeopleOut() {
  const S = build('throw');
  _eq_('throw → static map', S.gxSlugForStoreId_('hillsboro'), 'baseline');
  _eq_('throw → static map', S.gxSlugForStoreId_('river-rd'),  'river');

  const S2 = build('empty');
  _eq_('empty registry → static map', S2.gxSlugForStoreId_('bend'), 'century');
}

function test_unknownStoreFailsClosed() {
  const S = build('ok');
  _eq_('unknown id is null', S.gxSlugForStoreId_('gresham'), null);
  _eq_('empty id is null',   S.gxSlugForStoreId_(''),        null);
  _eq_('null id is null',    S.gxSlugForStoreId_(null),      null);
  // Prototype keys must not resolve through the fallback map — own_ exists for this.
  _eq_('__proto__ is null',    S.gxSlugForStoreId_('__proto__'),   null);
  _eq_('constructor is null',  S.gxSlugForStoreId_('constructor'), null);
}

function test_storeCoreKnowsButThisAppCannotServe() {
  // A seventh store added in the Command Center. This app has no STORES entry, no fixtures
  // and no Dutchie key for it, so placing a manager there would be a guess. Null, not a slug.
  const S = build(CORE_STORES.concat([
    { store_id: 'gresham', display_name: 'Gresham', dutchie_name: 'Gresham', color: '#fff', sort_order: '7' },
  ]));
  _eq_('unservable new store is refused', S.gxSlugForStoreId_('gresham'), null);
  _eq_('and the others still resolve',    S.gxSlugForStoreId_('hillsboro'), 'baseline');
}

function test_aRenameInCoreMovesTheSlugWithoutADeploy() {
  // The whole reason for deriving. Core renames Baseline; the app follows, because the
  // renamed display_name is still one this app serves.
  const renamed = CORE_STORES.map(function (s) {
    return s.store_id === 'hillsboro' ? Object.assign({}, s, { display_name: 'Century' }) : s;
  });
  const S = build(renamed);
  _eq_('follows the live display_name', S.gxSlugForStoreId_('hillsboro'), 'century');
  _ok_('and disagrees with the stale map on purpose',
       S.gxSlugForStoreId_('hillsboro') !== S.GX_STOREID_TO_SLUG['hillsboro']);
}

H.run('store_slug', {
  test_derivesEverySlugFromTheLiveRegistry,
  test_derivedMatchesTheStaticMapExactly,
  test_caseInsensitiveOnTheStoreId,
  test_coreOutageFallsBackRatherThanLockingPeopleOut,
  test_unknownStoreFailsClosed,
  test_storeCoreKnowsButThisAppCannotServe,
  test_aRenameInCoreMovesTheSlugWithoutADeploy,
});
