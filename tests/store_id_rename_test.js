#!/usr/bin/env node
/* The store_id ↔ app slug mapping survives a RENAME (dutchie_fetch.gs, dutchie_proxy.gs).
 *
 * Leaderboard calls its stores century/river/baseline/…; GX Core calls the same six
 * bend/river-rd/hillsboro/…. Everything cross-app is keyed on Core's id, so one translation sits
 * under the SPIFF row, the SPIFF kiosk token, the hourly-shape lookups and the sales join.
 *
 * Until 2026-09-09 that translation was DERIVED by lowercasing Core's display_name, and it worked
 * only because every display name happened to lowercase to this app's slug. Rename a store in the
 * Command Center and:
 *
 *   · coreStoreId_ silently returns the SLUG instead of the store_id — so SPIFF rows for that
 *     store stop matching (spiffFilterRows_ compares store_id), its kiosk token is looked up at
 *     cfg.spiffKiosk.century instead of .bend and comes back empty, and the hourly shape misses.
 *   · the kiosk's color overlay stops placing that store, so it keeps the color compiled into
 *     the page while the other five keep tracking the registry.
 *
 * Every one of those is silent — no error, no log, a screen that looks entirely fine. Found by
 * core-admin against gx-stores.js's header, which names this app as the example.
 *
 * STORES already carried the answer explicitly (`storeId`, added 2026-08-29 because "store_id is
 * Core-owned and unambiguous"); the code simply predated it. These pin that it is read, not
 * re-derived, and that the derivation survives ONLY as a fallback for a store not yet in the table.
 *
 * Per tests/_harness.js's rule these never reimplement — both files are read off disk.
 */
'use strict';
const { load, run, _eq_, _ok_ } = require('./_harness');

/* The live registry, 2026-09-09, straight from ?action=gxstores. */
const REAL = [
  { store_id: 'bend',        display_name: 'Century',    color: '#22D3EE' },
  { store_id: 'center',      display_name: 'Center',     color: '#3B82F6' },
  { store_id: 'commercial',  display_name: 'Commercial', color: '#A855F7' },
  { store_id: 'hillsboro',   display_name: 'Baseline',   color: '#6366F1' },
  { store_id: 'portland-rd', display_name: 'Portland',   color: '#D946EF' },
  { store_id: 'river-rd',    display_name: 'River',      color: '#EC4899' },
];

/* The same six AFTER somebody renames two of them in the Command Center. Nothing else moved —
   the ids are identical, which is the point: an id is stable and a display name is not. */
const RENAMED = REAL.map(function (s) {
  if (s.store_id === 'bend')      return Object.assign({}, s, { display_name: 'Century Drive' });
  if (s.store_id === 'hillsboro') return Object.assign({}, s, { display_name: 'Baseline & Cedar' });
  return s;
});

let REGISTRY = REAL;

function mount() {
  return load(['dutchie_proxy.gs', 'dutchie_fetch.gs'], {
    stubs: {
      GXCore: {
        getStores: function () { return REGISTRY; },
        getKv: function () { return null; },
      },
    },
  });
}

const PAIRS = [
  ['baseline',   'hillsboro'],
  ['center',     'center'],
  ['century',    'bend'],
  ['commercial', 'commercial'],
  ['portland',   'portland-rd'],
  ['river',      'river-rd'],
];

const tests = {

  'every store resolves to its GX Core id': function () {
    REGISTRY = REAL;
    const M = mount();
    PAIRS.forEach(function (p) {
      _eq_(p[0], M.coreStoreId_({ slug: p[0] }), p[1]);
    });
  },

  'the six ids match the live registry — the table is not drifting from Core': function () {
    REGISTRY = REAL;
    const M = mount();
    const fromTable = M.STORES.map(function (s) { return s.storeId; }).sort();
    const fromCore  = REAL.map(function (s) { return s.store_id; }).sort();
    _eq_('ids', fromTable, fromCore);
  },

  'A RENAME DOES NOT MOVE ANY id — the bug this exists for': function () {
    REGISTRY = RENAMED;
    const M = mount();
    // Under the old display-name derivation, 'century' returned 'century' and 'baseline'
    // returned 'baseline' here, and every store_id-keyed lookup for those two silently missed.
    PAIRS.forEach(function (p) {
      _eq_(p[0] + ' after rename', M.coreStoreId_({ slug: p[0] }), p[1]);
    });
  },

  'a store object carrying its own storeId is trusted directly': function () {
    REGISTRY = RENAMED;
    const M = mount();
    _eq_('explicit', M.coreStoreId_({ slug: 'century', storeId: 'bend' }), 'bend');
  },

  'the id→slug map prefers the explicit pairs over the registry': function () {
    REGISTRY = RENAMED;
    const M = mount();
    const map = M.gxStoreIdToAppSlug_();
    _eq_('bend', map['bend'], 'century');
    _eq_('hillsboro', map['hillsboro'], 'baseline');
    // …and the four that were never renamed are unaffected either way.
    _eq_('river-rd', map['river-rd'], 'river');
  },

  'a store Core knows and this app does not still resolves, via the registry fallback': function () {
    // The seventh-store case: the fallback is a fallback, not dead code.
    REGISTRY = REAL.concat([{ store_id: 'newberg', display_name: 'Newberg', color: '#fff' }]);
    const M = mount();
    _eq_('registry fallback', M.gxStoreIdToAppSlug_()['newberg'], 'newberg');
    _eq_('and coreStoreId_ passes it through', M.coreStoreId_({ slug: 'newberg' }), 'newberg');
  },

  'an unknown slug returns itself rather than throwing': function () {
    REGISTRY = REAL;
    const M = mount();
    _eq_('unknown', M.coreStoreId_({ slug: 'nowhere' }), 'nowhere');
    _eq_('empty', M.coreStoreId_({ slug: '' }), '');
    _eq_('null store', M.coreStoreId_(null), '');
  },

  /* ── what the browser is sent ─────────────────────────────────────────────────────── */

  'gxstores carries app_slug, so the client never derives it from a display name': function () {
    REGISTRY = REAL;
    const M = mount();
    const out = M.getGxStores_();
    _ok_('ok', out.ok === true);
    const bySlug = {};
    out.stores.forEach(function (s) { bySlug[s.store_id] = s.app_slug; });
    PAIRS.forEach(function (p) { _eq_(p[1] + '.app_slug', bySlug[p[1]], p[0]); });
  },

  'app_slug survives a rename too — it is the whole reason it is sent': function () {
    REGISTRY = RENAMED;
    const M = mount();
    const out = M.getGxStores_();
    const bySlug = {};
    out.stores.forEach(function (s) { bySlug[s.store_id] = s.app_slug; });
    _eq_('bend', bySlug['bend'], 'century');
    _eq_('hillsboro', bySlug['hillsboro'], 'baseline');
    // display_name still carries the NEW name — we send both; only the key is stable.
    const byId = {};
    out.stores.forEach(function (s) { byId[s.store_id] = s.display_name; });
    _eq_('display_name is the live one', byId['bend'], 'Century Drive');
  },

  'a store Core knows and this app does not gets an EMPTY app_slug, not a guess': function () {
    REGISTRY = REAL.concat([{ store_id: 'newberg', display_name: 'Newberg', color: '#fff' }]);
    const M = mount();
    const row = M.getGxStores_().stores.filter(function (s) { return s.store_id === 'newberg'; })[0];
    _ok_('row is still sent', !!row);
    // Empty rather than 'newberg': the client warns about a store it cannot place. Guessing here
    // is what shipped a display-name-derived key to the browser in the first place.
    _eq_('app_slug', row.app_slug, '');
  },

  'building gxstores does not recurse through the slug map': function () {
    // getGxStores_ builds its id→slug map inline; gxStoreIdToAppSlug_ calls getGxStores_ for its
    // fallback. Routing the first through the second blew the stack on the first cold cache.
    REGISTRY = REAL;
    const M = mount();
    let threw = null;
    try { M.getGxStores_(); M.gxStoreIdToAppSlug_(); } catch (e) { threw = e; }
    _ok_('no stack overflow', threw === null);
  },
};

run('store_id_rename', tests);
