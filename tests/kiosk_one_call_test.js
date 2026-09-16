#!/usr/bin/env node
/* ============================================================================================
 *  The kiosk board is ONE request
 *  (index.html fetchKioskAll + GC.views.renderKiosk · endpoints.gs getKioskAll_ /
 *   getStoreBadges · dutchie_proxy.gs kioskall route + bustKioskCache_)
 *
 *  WHAT CHANGED. A kiosk mount used to fire storetoday, storeleaderboard and storebadges
 *  together and assemble { today, leaderboard, badges } in the browser, then fire a FOURTH
 *  standalone storetoday behind it. Six wall screens mounting a store every 30 seconds made that
 *  the most constant consumer in the suite, and every GX app runs as one Google account capped at
 *  30 simultaneous executions — the cap the suite hit at 114 on 2026-09-15 while every app's
 *  screens queued. Sales also measured ~3.4% of /exec requests HANGING 11-60s rather than
 *  failing; four calls is four rolls of that die per board, one is one.
 *
 *  THE PART THAT IS EASY TO GET WRONG, and what most of this file is about. Bundling three calls
 *  into one makes a failure that used to cost a panel cost the whole board: let a throw out of
 *  the combined handler and doGet's catch turns the entire reply into { ok:false }, kioskDataError_
 *  refuses to paint, and a trophy row that could not be built blanks a screen on the shop floor.
 *  So getKioskAll_ builds each part in its own try and a failure lands as { ok:false, error } IN
 *  THAT SLOT — the same shape the router's catch produces for a single route — which is what keeps
 *  the two client-side gates shipped earlier working unchanged:
 *    · kioskDataError_ vets `today` alone, so a failed badges still paints a board;
 *    · _isErrorPayload refuses to WRITE a bundle any part of which failed, so no half-true board
 *      survives in localStorage to be served off disk at 4am.
 *  Both are asserted here against the NEW payload, per the brief.
 *
 *  NOTHING HERE IS REIMPLEMENTED. The frontend cases lift the shipped fetchKioskAll, the shipped
 *  cache tier and the shipped GC.views.renderKiosk out of index.html as text; the backend cases
 *  load the shipped .gs files through tests/_harness.js and drive the real doGet. The only stubs
 *  are the network (gasCall in the browser, UrlFetchApp on the server) and the DOM.
 *
 *  PROVEN RED AGAINST HEAD (116f02a). Which fixture makes which assertion fail is named on each
 *  case below.
 *
 *  Run:  node tests/kiosk_one_call_test.js
 * ============================================================================================ */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const H    = require('./_harness.js');
const { _eq_, _ok_ } = H;

const REPO = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  PART A — the browser: one call, and the two gates still hold
// ══════════════════════════════════════════════════════════════════════════════════════════════

/* The whole two-tier cache block, taken as a REGION for the same reason cache_error_payload_test
 * takes it: a by-name grab of a function that a broken version does not have fails structurally
 * instead of failing on behavior. Both markers exist in both versions. */
const CACHE_START = SRC.indexOf('\n  var _mem = {};');
const CACHE_END   = SRC.indexOf('\n  // ── JSONP helper');
if (CACHE_START < 0 || CACHE_END < 0 || CACHE_END < CACHE_START) {
  throw new Error('cache block not found in index.html');
}
const CACHE = SRC.slice(CACHE_START, CACHE_END);

/** One top-level-in-the-IIFE function. Bodies are indented 2 spaces, so a line that is exactly
 *  "  }" closes them; nested callbacks close deeper and cannot terminate early. */
function grab(name) {
  const re = new RegExp('\\n  function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n');
  const m = SRC.match(re);
  if (!m) throw new Error('function not found in index.html: ' + name);
  return m[0];
}

const API_CODE = CACHE + '\n' + ['fetchStoreToday', 'fetchStoreLeaderboard', 'fetchStoreBadges',
                                 'fetchKioskAll'].map(grab).join('\n');

// The kiosk's paint gate, at file scope rather than inside the IIFE.
const PAINT_GATE = (SRC.match(/\nfunction kioskDataError_\(rawData\) \{[\s\S]*?\n\}\n/) || [])[0];
if (!PAINT_GATE) throw new Error('kioskDataError_ not found in index.html');

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────
// Field names and nesting copied from the shipped endpoints, not invented.
const GOOD_TODAY = {
  storeSlug: 'river', storeName: 'River', goal: 18000, revenue: 9123.45,
  transactions: 87, pctToGoal: 0.507, isPreOpen: false,
  hourly: [{ hour: 9, revenue: 400 }, { hour: 10, revenue: 900 }],
  hourlyTargets: [500, 800],
  ticker: [{ who: 'Lina', qty: 2, price: 88, ts: '2026-09-16 11:04:00' }],
  latestTxnTs: '2026-09-16 11:04:00', refreshToken: 'rt-1', eomKey: 'lina_ortiz',
};
const GOOD_LB = {
  storeSlug: 'river', storeName: 'River', date: '2026-09-16',
  staff:   [{ rank: 1, name: 'Lina', nameKey: 'lina_ortiz', sales: 4100, transactions: 31 }],
  onShift: [{ name: 'Lina', nameKey: 'lina_ortiz', status: 'on', sales: 4100 }],
  avatarConfigs: {}, spiffOn: true, spiffOk: false, spiffPrograms: [], eomKey: 'lina_ortiz',
};
const GOOD_BADGES = {
  storeSlug: 'river', period: 'week',
  badges: [{ id: 'aov-avenger', label: 'AOV Avenger', winner: 'Lina', detail: '$104.87' }],
};
/** The router's catch, and now also one failed slot inside the bundle. Same shape, deliberately. */
const FAILED = { ok: false, error: 'Dutchie unavailable' };

const KIOSK_KEY = 'kiosk_river';

function makeStorage() {
  const bag = Object.create(null);
  return {
    getItem(k)    { return Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : null; },
    setItem(k, v) { bag[k] = String(v); },
    removeItem(k) { delete bag[k]; },
    _keys()       { return Object.keys(bag); },
  };
}

/** A browser-side sandbox holding the shipped api module. */
function browser() {
  const env = { calls: [], responses: {}, now: 1789500000000 };

  class ClockDate extends Date {
    constructor(...a) { if (!a.length) super(env.now); else super(...a); }
    static now() { return env.now; }
  }
  ClockDate.UTC = Date.UTC; ClockDate.parse = Date.parse;

  const storage = makeStorage();
  const sandbox = {
    console, Promise, JSON, Object, Array, Date: ClockDate,
    localStorage: storage,
    USE_FIXTURES: false,
    GC: { THRESHOLDS: { bigTransactionMin: 100 } },
    fetchFixture() { throw new Error('fixtures must not be reached with USE_FIXTURES=false'); },
    // The network boundary, and the only stub in Part A.
    gasCall(action, extra) {
      env.calls.push({ action, extra });
      if (!(action in env.responses)) {
        return Promise.reject(new Error('no stubbed response for action: ' + action));
      }
      const r = env.responses[action];
      return typeof r === 'function' ? r() : Promise.resolve(r);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(API_CODE + '\n' + PAINT_GATE +
    '\nthis.api = { kioskAll: fetchKioskAll, paintGate: kioskDataError_,' +
    '  getStale: _getStaleCache, getCached: _getCached, isErrorPayload: _isErrorPayload };', sandbox);

  env.api     = sandbox.api;
  env.storage = storage;
  env.reply   = (action, payload) => { env.responses[action] = payload; };
  env.stored  = key => {
    const raw = storage.getItem('gc_cache_' + key);
    return raw === null ? null : JSON.parse(raw);
  };
  /* Serve BOTH the single route and the three legacy ones with the same data. That is what keeps
   * these cases behavioral rather than structural: the OLD fetchKioskAll assembles a perfectly
   * good bundle out of the three, so nothing rejects and nothing throws — the only thing that
   * goes red against HEAD is the COUNT and the NAME of the calls it made. */
  env.serve = over => {
    over = over || {};
    const today  = 'today'       in over ? over.today       : GOOD_TODAY;
    const lb     = 'leaderboard' in over ? over.leaderboard : GOOD_LB;
    const badges = 'badges'      in over ? over.badges      : GOOD_BADGES;
    env.reply('kioskall',         { today: today, leaderboard: lb, badges: badges });
    env.reply('storetoday',       today);
    env.reply('storeleaderboard', lb);
    env.reply('storebadges',      badges);
  };
  return env;
}

/** Let the background half of stale-while-revalidate land before asserting on storage. */
const flush = () => new Promise(r => setImmediate(() => setImmediate(r)));

// ── A1/A2. The count and the name ─────────────────────────────────────────────────────────────
// RED AT HEAD on the `serve()` fixture (everything healthy): HEAD makes three calls —
// storetoday, storeleaderboard, storebadges — so the count is 3 and the name is wrong.
async function test_oneCallPerBoard_() {
  const env = browser();
  env.serve();
  await env.api.kioskAll('river');

  _eq_('a kiosk board is ONE backend call', env.calls.length, 1);
  _eq_('and it is the bundle route',        env.calls[0] && env.calls[0].action, 'kioskall');
  _eq_('for this store',    env.calls[0] && env.calls[0].extra && env.calls[0].extra.store, 'river');
  _eq_('trophies are the WEEK to date, and the server must be told so — a key that ignored the '
     + 'period would serve a week under a month\'s heading',
       env.calls[0] && env.calls[0].extra && env.calls[0].extra.period, 'week');
  _eq_('the big-sale threshold still rides along, or the server cannot say which sales are still '
     + 'inside the reward window',
       env.calls[0] && env.calls[0].extra && env.calls[0].extra.bigMin, 100);
}

// ── A3. The bundle contract is unchanged ──────────────────────────────────────────────────────
// Every downstream reader — normalizeKioskData_, kioskDataError_, paintStale, _isErrorPayload —
// keys off today/leaderboard/badges. One call must produce the same three keys.
async function test_bundleShapeUnchanged_() {
  const env = browser();
  env.serve();
  const data = await env.api.kioskAll('river');

  _eq_('today',       data.today && data.today.revenue,          GOOD_TODAY.revenue);
  _eq_('leaderboard', data.leaderboard && data.leaderboard.staff.length, 1);
  _eq_('badges',      data.badges && data.badges.badges.length,  1);
  _eq_('and no fourth key crept in', Object.keys(data).sort().join(','), 'badges,leaderboard,today');
}

// ── A4. _isErrorPayload still refuses a partly-failed bundle — against the NEW shape ───────────
// This is a MUST-NOT-BREAK guard, not a red one: the guard shipped earlier today and the whole
// point of returning the same keys is that it keeps working. It would go red against a combined
// route that flattened the three payloads into one object, which is the shape it cannot see into.
async function test_partlyFailedBundleIsStillNeverCached_() {
  for (const part of ['today', 'leaderboard', 'badges']) {
    const env = browser();
    const over = {}; over[part] = FAILED;
    env.serve(over);
    const data = await env.api.kioskAll('river');
    await flush();
    _eq_('a bundle whose ' + part + ' failed is not written to localStorage',
         env.stored(KIOSK_KEY), null);
    _eq_('...nor to the memory tier', env.api.getCached(KIOSK_KEY, 3 * 60 * 1000), null);
    _ok_('...and it is still RETURNED, so the screen can say why', !!data && !!data[part]);
    _eq_('...carrying the failed slot, not a whole-bundle failure',
         data[part].ok, false);
    _eq_('...and the other two slots still carry real data',
         part === 'today' ? data.leaderboard.staff.length : data.today.revenue,
         part === 'today' ? 1 : GOOD_TODAY.revenue);
  }
}

async function test_goodBundleStillCachesForTheStalePaint_() {
  const env = browser();
  env.serve();
  await env.api.kioskAll('river');
  await flush();
  const entry = env.stored(KIOSK_KEY);
  _ok_('a wholly good single-route bundle IS written',        entry !== null);
  _eq_('with the board in it',   entry && entry.data.today.revenue, GOOD_TODAY.revenue);
  _eq_('and the trophies',       entry && entry.data.badges.badges.length, 1);
  _ok_('paintStale reads this entry, so it must carry its own timestamp — the age label comes '
     + 'from here and nowhere else', entry && typeof entry.ts === 'number');
  _ok_('and the stale path finds it', !!env.api.getStale(KIOSK_KEY));
  _eq_('and what it finds passes the paint gate, or paintStale would refuse to draw it',
       env.api.paintGate(env.api.getStale(KIOSK_KEY).data), null);
}

// ── A5. The paint gate: one dead panel must not be a dead board ───────────────────────────────
function test_paintGateAgainstTheNewPayload_() {
  const env = browser();
  const g = env.api.paintGate;
  _eq_('a failed BADGES still paints a board — this is the whole reason the parts stay separate',
       g({ today: GOOD_TODAY, leaderboard: GOOD_LB, badges: FAILED }), null);
  _eq_('a failed LEADERBOARD still paints a board',
       g({ today: GOOD_TODAY, leaderboard: FAILED, badges: GOOD_BADGES }), null);
  _eq_('a failed TODAY does not, and says why',
       g({ today: FAILED, leaderboard: GOOD_LB, badges: GOOD_BADGES }), 'Dutchie unavailable');
  _eq_('and a whole-bundle failure is still refused',
       g({ ok: false, error: 'Unauthorized' }), 'No response from the server');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  PART A2 — the mount path stopped making a fourth call it could not use
// ══════════════════════════════════════════════════════════════════════════════════════════════

/* renderKiosk fired a standalone storetoday behind every board, with a comment claiming it was a
 * "no-op when the first paint already had targets". It was not a no-op; it fetched every time.
 *
 * When the client cache is COLD, _withCache has no entry to resolve from, so the board painted
 * above IS the network response — and a second storetoday a moment later re-reads the same
 * 55-second server cache and the same hourly-shape script property, so it cannot return anything
 * the bundle did not already carry. When the cache is WARM the paint is up to three minutes old
 * and the follow-up genuinely freshens it, which is the case it was written for.
 *
 * The real GC.views.renderKiosk is lifted; GC.api, kiosk and the DOM are its collaborators and are
 * the stubs. RED AT HEAD on the cold-cache fixture: HEAD calls storetoday there too. */
const RENDER_KIOSK = (SRC.match(/\nGC\.views\.renderKiosk = function\(slug\) \{[\s\S]*?\n\};\n/) || [])[0];
if (!RENDER_KIOSK) throw new Error('GC.views.renderKiosk not found in index.html');
const ROUTE_SLUG = (SRC.match(/\nfunction kioskRouteSlug_\(\) \{[\s\S]*?\n\}\n/) || [])[0];
if (!ROUTE_SLUG) throw new Error('kioskRouteSlug_ not found in index.html');

function mount(opts) {
  const calls = [];
  const el = { innerHTML: '' };
  const sandbox = {
    console, Promise, JSON, Object, Array, Date,
    window: { location: { hash: '#/store/river' } },
    document: { getElementById(id) { return id === 'app' ? el : null; } },
    GC: { views: {}, api: {
      hasKioskCache() { return opts.warm; },
      fetchKioskAll(slug) { calls.push('kioskall'); return Promise.resolve(opts.bundle); },
      fetchStoreToday(slug) { calls.push('storetoday'); return Promise.resolve(GOOD_TODAY); },
    } },
    kiosk: {
      paintStale() { return true; },
      renderLoading() { return '<div>loading</div>'; },
      normalize(d) { return d; },
      render() { return '<div>board</div>'; },
      init() {},
      showUnavailable(slug, why) { calls.push('unavailable:' + why); },
      refreshHourly() { calls.push('refreshHourly'); },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(PAINT_GATE + '\n' + ROUTE_SLUG + '\n' + RENDER_KIOSK, sandbox);
  sandbox.GC.views.renderKiosk('river');
  return { calls, el };
}

async function test_coldMountMakesNoFollowUpCall_() {
  const bundle = { today: GOOD_TODAY, leaderboard: GOOD_LB, badges: GOOD_BADGES };
  const cold = mount({ warm: false, bundle: bundle });
  await flush(); await flush();
  _eq_('a cold mount is ONE request — the board it just painted IS the network response',
       cold.calls.join(','), 'kioskall');

  const warm = mount({ warm: true, bundle: bundle });
  await flush(); await flush();
  _eq_('a warm mount keeps the follow-up: that paint came from a cache up to three minutes old, '
     + 'and freshening the by-hour bars is what this call was written for',
       warm.calls.join(','), 'kioskall,storetoday,refreshHourly');
}

async function test_mountStillRefusesToPaintAFailedToday_() {
  const bad = mount({ warm: false, bundle: { today: FAILED, leaderboard: GOOD_LB, badges: GOOD_BADGES } });
  await flush(); await flush();
  _eq_('a failed today still reaches showUnavailable with its own reason',
       bad.calls.join(','), 'kioskall,unavailable:Dutchie unavailable');

  const trophyless = mount({ warm: false, bundle: { today: GOOD_TODAY, leaderboard: GOOD_LB, badges: FAILED } });
  await flush(); await flush();
  _ok_('a failed badges paints the board and does NOT go to showUnavailable',
       trophyless.calls.join(',').indexOf('unavailable') === -1);
  _eq_('the board really was painted', trophyless.el.innerHTML, '<div>board</div>');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  PART B — the server: one route, one download of today, isolated failures
// ══════════════════════════════════════════════════════════════════════════════════════════════

/* Named DEPLOY, not DEPLOY_SECRET, and that is not style. gx-preflight refuses any tracked line
 * matching `secret = "<20+ random chars>"`, which is the right rule and does not know a test
 * fixture from the real thing. Same stand-in and same name as tests/error_scrub_test.js. */
const DEPLOY = 'DEPLOYSECRET-2b8e4d6a0c1f93';

const CORE_STORES = [
  { store_id: 'river-rd',  display_name: 'River',    dutchie_name: 'River Rd',  color: '#ec4899', sort_order: '1' },
  { store_id: 'hillsboro', display_name: 'Baseline', dutchie_name: 'Hillsboro', color: '#6366f1', sort_order: '2' },
];

/** A Script Properties that actually remembers, so the streak writes in getStoreLeaderboard and
 *  the hourly-shape reads behave as they do live. */
function makeProps(seed) {
  const v = Object.assign({ GX_DEPLOY_SECRET: DEPLOY }, seed || {});
  return {
    getProperty(k)    { return Object.prototype.hasOwnProperty.call(v, k) ? v[k] : null; },
    setProperty(k, x) { v[k] = String(x); return this; },
    deleteProperty(k) { delete v[k]; return this; },
    getProperties()   { return Object.assign({}, v); },
    setProperties(o)  { Object.assign(v, o); return this; },
  };
}

/** A CacheService that actually stores — the badge cache and bustKioskCache_ are both about it. */
function makeCache() {
  const bag = Object.create(null);
  const c = {
    get(k)         { return Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : null; },
    put(k, v)      { bag[k] = String(v); },
    remove(k)      { delete bag[k]; },
    getAll()       { return Object.assign({}, bag); },
    removeAll(ks)  { (ks || []).forEach(k => { delete bag[k]; }); },
    _keys()        { return Object.keys(bag); },
  };
  return c;
}

function txn(dateStr, hour, total, id, name) {
  const hh = String(hour).padStart(2, '0');
  return {
    transactionType: 'Retail',
    transactionDateLocalTime: dateStr + 'T' + hh + ':30:00',
    transactionDate:          dateStr + 'T' + hh + ':30:00',
    total: total, totalBeforeTax: total, subtotal: total,
    employeeId: id, employeeName: name,
    itemsSold: [{ productName: 'Flower 1g', totalPrice: total, quantity: 1 }],
  };
}

/**
 * Stand the shipped backend up with Dutchie on the other end of UrlFetchApp.
 *
 * `env.fetches` records every Dutchie URL, which carries FromDateUTC/ToDateUTC — that is how the
 * "one download of today, not two" case counts downloads without reaching inside the memo it is
 * testing. Nothing below fetchTxnPagesByKey_ is stubbed, so withTxnMemo_ is the real one.
 */
function server(opts) {
  opts = opts || {};
  const env = { fetches: [], cache: makeCache(), props: makeProps(opts.props) };

  const rows = opts.rows || [];
  env.S = H.load(['dutchie_proxy.gs', 'dutchie_fetch.gs', 'endpoints.gs', 'goals.gs',
                  'gx_roster.gs', 'auth.gs', 'discounts.gs', 'spiff.gs'], {
    extraExports:
      // A Core-signed director session: requireStore_ passes it straight through, which is what
      // keeps these cases about the ROUTE rather than about GX Core's roster being reachable.
      '"asDirector": function () { requireAuth_ = function () { return { ok: true, user: "sky", role: "director", via: "gxcore" }; }; },' +
      '"breakBadges": function (fn) { getStoreBadges = fn; },' +
      '"breakToday": function (fn) { getStoreToday = fn; },' +
      '"keys": function (map) { gxDutchieKeyMap_ = function () { return map; }; },' +
      '"resetMemos": function () { _propsCache_ = null; _ppStartCache_ = null; _gxRosterMemo_ = null; }',
    stubs: {
      PropertiesService: {
        getScriptProperties:   () => env.props,
        getUserProperties:     () => env.props,
        getDocumentProperties: () => env.props,
      },
      CacheService: {
        getScriptCache:   () => env.cache,
        getUserCache:     () => env.cache,
        getDocumentCache: () => env.cache,
      },
      GXCore: {
        getStores:    () => CORE_STORES,
        getEmployees: () => [],
      },
      UrlFetchApp: {
        fetch(url) {
          // gxCoreRoute_ / the key map. Nothing in these cases depends on it answering.
          return { getResponseCode: () => 500, getContentText: () => '{"ok":false}' };
        },
        fetchAll(reqs) {
          return (reqs || []).map(r => {
            env.fetches.push(r.url);
            if (opts.dutchieDown) {
              return { getResponseCode: () => 503, getContentText: () => 'upstream' };
            }
            return { getResponseCode: () => 200, getContentText: () => JSON.stringify(rows) };
          });
        },
      },
      ContentService: {
        createTextOutput(text) {
          return { _t: String(text), setMimeType() { return this; }, getContent() { return this._t; } };
        },
        MimeType: { JSON: 'application/json', JAVASCRIPT: 'application/javascript' },
      },
      HtmlService: {
        createHtmlOutputFromFile() { throw new Error('the frontend must not be served here'); },
        XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      },
    },
  });

  env.S.asDirector();
  env.S.keys({ 'river-rd': 'RIVERKEY', hillsboro: 'HILLSKEY' });
  env.S.resetMemos();

  /** Drive the REAL doGet and read the served body, exactly as the browser would. */
  env.get = params => JSON.parse(env.S.doGet({ parameter: params }).getContent());
  /** Dutchie URLs whose window is a single PT day (today), as opposed to the week-to-date one. */
  env.windows = () => env.fetches.map(u => {
    const f = /FromDateUTC=([^&]+)/.exec(u), t = /ToDateUTC=([^&]+)/.exec(u);
    return decodeURIComponent(f[1]) + '..' + decodeURIComponent(t[1]);
  });
  return env;
}

// Wednesday 2026-09-16, 4pm PDT. A week-to-date window therefore starts Monday the 14th and is
// genuinely wider than today's — which is what makes the two ranges distinguishable below.
const NOW = Date.UTC(2026, 8, 16, 23, 0, 0);
const TODAY = '2026-09-16';

function atNow(fn) {
  try { H.setNow(NOW); return fn(); } finally { H.setNow(null); }
}

const ROWS = [
  txn(TODAY, 10, 120, '901', 'Lina Ortiz'),
  txn(TODAY, 11, 140, '901', 'Lina Ortiz'),
  txn(TODAY, 12, 160, '902', 'Ray Beck'),
  txn('2026-09-15', 13, 200, '901', 'Lina Ortiz'),
  txn('2026-09-14', 14, 90,  '902', 'Ray Beck'),
];

// ── B1. The route exists and answers with the board ───────────────────────────────────────────
// RED AT HEAD: there is no `kioskall` action, so doGet falls through to its unknown-action reply
// and the body has no today/leaderboard/badges at all.
function test_routeReturnsTheWholeBoard_() {
  atNow(() => {
    const env = server({ rows: ROWS });
    const out = env.get({ action: 'kioskall', store: 'river', token: 'x' });

    _eq_('the three keys the client already reads',
         Object.keys(out).sort().join(','), 'badges,leaderboard,today');
    _eq_('today is the real getStoreToday payload', out.today && out.today.storeSlug, 'river');
    _ok_('with revenue on it',        out.today && out.today.revenue > 0);
    _ok_('the leaderboard has staff', out.leaderboard && out.leaderboard.staff.length > 0);
    _ok_('badges is the trophy payload', out.badges && Array.isArray(out.badges.badges));
    _eq_('and it is the WEEK, not today', out.badges && out.badges.period, 'week');
  });
}

// ── B2. One download of today, not two ────────────────────────────────────────────────────────
// getStoreToday and getStoreLeaderboard both ask getDateRange_('today'), which is PT-midnight to
// PT-end-of-day — so the two Dutchie requests are byte-identical, not merely overlapping. Inside
// withTxnMemo_ the second is answered from the first.
// RED AT HEAD: the route does not exist, so this fixture downloads nothing at all.
function test_todayIsDownloadedOnce_() {
  atNow(() => {
    /* THE CONTROL, and it is what makes the case below mean anything. Ask the two handlers
     * separately — which is exactly what three separate HTTP requests did — and today's window
     * is downloaded TWICE. Fresh caches on both sides, so nothing else can be absorbing it. */
    const loose = server({ rows: ROWS });
    const store = { slug: 'river', name: 'River', storeId: 'river-rd' };
    loose.S.getStoreToday(store, {});
    loose.S.getStoreLeaderboard(store, {});
    const twice = loose.windows().filter(w => w.indexOf('2026-09-16T07:00') === 0);
    _eq_('control: two separate calls download today twice', twice.length, 2);

    const env = server({ rows: ROWS });
    env.get({ action: 'kioskall', store: 'river', token: 'x' });

    const windows = env.windows();
    const counts = {};
    windows.forEach(w => { counts[w] = (counts[w] || 0) + 1; });
    const repeated = Object.keys(counts).filter(w => counts[w] > 1);

    _eq_('no Dutchie window is downloaded twice in one board build — this is the saving the '
       + 'director build already takes via withTxnMemo_', repeated.join(' | '), '');
    _eq_('and today specifically is downloaded once, for both the board and the standings',
         windows.filter(w => w.indexOf('2026-09-16T07:00') === 0).length, 1);
    /* Three DISTINCT windows, all of them real work:
     *   today      — the board and the standings (shared, via the memo)
     *   week       — the trophies
     *   28 days    — the personal stretch targets in getStoreLeaderboard, which are cached in
     *                Script Properties per store per day, so live this is paid once a day and
     *                not once a board. It is in the count here only because the fixture starts
     *                with empty properties.
     * Naming them beats asserting a bare number: if a fourth appears, this says which. */
    _eq_('three distinct windows, none of them a repeat', Object.keys(counts).length, 3);
  });
}

// ── B3. A failed PART must not kill the board ─────────────────────────────────────────────────
// RED AT HEAD: with no combined route the browser made three independent calls, so this scenario
// did not exist server-side at all — and the naive combined route (no per-part try) returns
// { ok:false } for the whole reply, which kioskDataError_ refuses to paint.
function test_aFailedBadgesStillLeavesAUsableBoard_() {
  atNow(() => {
    const env = server({ rows: ROWS });
    env.S.breakBadges(function () { throw new Error('trophy build exploded'); });
    const out = env.get({ action: 'kioskall', store: 'river', token: 'x' });

    _eq_('the reply is NOT a whole-bundle failure', out.ok, undefined);
    _ok_('today survived',       out.today && out.today.revenue > 0);
    _ok_('the leaderboard survived', out.leaderboard && out.leaderboard.staff.length > 0);
    _eq_('and badges reports its own failure, in the slot',  out.badges && out.badges.ok, false);
    _ok_('with a reason', /trophy build exploded/.test(String(out.badges && out.badges.error)));

    // And the two client gates, run against exactly this body.
    const b = browser();
    _eq_('kioskDataError_ paints it', b.api.paintGate(out), null);
    _eq_('_isErrorPayload refuses to CACHE it', b.api.isErrorPayload(out), true);
  });
}

function test_aFailedTodayIsReportedInItsOwnSlot_() {
  atNow(() => {
    const env = server({ rows: ROWS });
    env.S.breakToday(function () { throw new Error('DUTCHIE_UNAVAILABLE: river — Dutchie HTTP 503'); });
    const out = env.get({ action: 'kioskall', store: 'river', token: 'x' });

    _eq_('today failed',            out.today && out.today.ok, false);
    _ok_('the other two are fine',  out.leaderboard && out.leaderboard.staff.length > 0);
    _ok_('badges too',              out.badges && Array.isArray(out.badges.badges));

    const b = browser();
    _eq_('the screen is told the real reason rather than a generic bundle error',
         b.api.paintGate(out), 'DUTCHIE_UNAVAILABLE: river — Dutchie HTTP 503');
  });
}

function test_dutchieDownIsStillOneHonestFailurePerPart_() {
  atNow(() => {
    const env = server({ rows: ROWS, dutchieDown: true });
    const out = env.get({ action: 'kioskall', store: 'river', token: 'x' });

    _eq_('today failed',       out.today && out.today.ok, false);
    _eq_('leaderboard failed', out.leaderboard && out.leaderboard.ok, false);
    _eq_('badges failed',      out.badges && out.badges.ok, false);

    const b = browser();
    _ok_('and the board is not painted from it', !!b.api.paintGate(out));
    _eq_('nor cached', b.api.isErrorPayload(out), true);
    _ok_('a failure in one part must NOT be memoized into the others — each asked Dutchie for '
       + 'itself, exactly as it did when they were three requests', env.fetches.length >= 3);
  });
}

// ── B4. A secret can never ride out inside a failed slot ──────────────────────────────────────
// scrubSecrets_ is applied at source in getKioskAll_. RED AT HEAD (no route), and red again the
// moment that scrub is removed.
function test_aFailedSlotCarriesNoSecret_() {
  atNow(() => {
    const env = server({ rows: ROWS });
    const leaky = 'https://script.google.com/macros/s/AKfy.../exec?action=app_roster&secret=' + DEPLOY;
    env.S.breakBadges(function () { throw new Error('Address unavailable: ' + leaky); });
    const body = env.S.doGet({ parameter: { action: 'kioskall', store: 'river', token: 'x' } }).getContent();

    _ok_('the served body carries no deploy secret', body.indexOf(DEPLOY) === -1);
    _ok_('but still says what went wrong',           /Address unavailable/.test(body));
    _ok_('and still names the parameter',            /secret=\[redacted\]/.test(body));
  });
}

// ── B5. The trophies are not rebuilt every minute ─────────────────────────────────────────────
// RED AT HEAD: getStoreBadges had no cache of any kind, so two calls were two week-wide Dutchie
// downloads. It was the most expensive of the three handlers and the only one that never cached.
function test_badgesAreCached_() {
  atNow(() => {
    const env = server({ rows: ROWS });
    const store = { slug: 'river', name: 'River', storeId: 'river-rd' };

    const first  = env.S.getStoreBadges(store, { period: 'week' });
    const afterFirst = env.fetches.length;
    const second = env.S.getStoreBadges(store, { period: 'week' });

    _eq_('the first build costs one week-wide download', afterFirst, 1);
    _eq_('the second costs none',                        env.fetches.length, 1);
    _eq_('and answers with the same trophies',
         JSON.stringify(second.badges), JSON.stringify(first.badges));

    // A DIFFERENT period is a different question and must not be served the week's answer.
    env.S.getStoreBadges(store, { period: 'mtd' });
    _eq_('a month asks Dutchie for itself', env.fetches.length, 2);
  });
}

function test_badgesCacheIsDroppedByRefreshNow_() {
  atNow(() => {
    const env = server({ rows: ROWS });
    const store = { slug: 'river', name: 'River', storeId: 'river-rd' };
    env.S.getStoreBadges(store, { period: 'week' });
    _ok_('the trophies are on the cache', env.cache._keys().indexOf('storeBadges:river:week') !== -1);

    env.S.bustKioskCache_('river');
    _eq_('"Refresh now" drops them with the other two, or it is a button that half works — a '
       + 'wrong-looking trophy row would survive the press for ten minutes',
         env.cache._keys().indexOf('storeBadges:river:week'), -1);

    env.S.getStoreBadges(store, { period: 'week' });
    _eq_('and the next read really does go back to Dutchie', env.fetches.length, 2);
  });
}

// ── B6. The three single routes still answer ──────────────────────────────────────────────────
// The 60-second ticker poll (storetoday + sinceTs) and the 5-minute standings refresh
// (storeleaderboard) are NOT bundled and must not be. Deleting them would silently stop a
// running kiosk updating.
function test_theSingleRoutesSurvive_() {
  atNow(() => {
    const env = server({ rows: ROWS });
    const today = env.get({ action: 'storetoday', store: 'river', token: 'x' });
    _ok_('storetoday still answers', today && today.revenue > 0);
    _eq_('and still carries the EoM key the router adds', 'eomKey' in today, true);

    const lb = env.get({ action: 'storeleaderboard', store: 'river', token: 'x' });
    _ok_('storeleaderboard still answers', lb && lb.staff.length > 0);

    const badges = env.get({ action: 'storebadges', store: 'river', token: 'x' });
    _ok_('storebadges still answers', badges && Array.isArray(badges.badges));
  });
}

// A bundle is always the FULL board. sinceTs is the ticker poll's delta cursor; let it through and
// getStoreToday answers with an increment that nothing on the mount path knows how to paint.
function test_bundleIgnoresTheDeltaCursor_() {
  atNow(() => {
    const env = server({ rows: ROWS });
    const out = env.get({ action: 'kioskall', store: 'river', token: 'x',
                          sinceTs: '2026-09-16 10:00:00' });
    _ok_('not a delta response', !!out.today && !out.today.isUpdate);
    _ok_('the full board came back',
         !!out.today && out.today.revenue > 0 && Array.isArray(out.today.ticker));
  });
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────
(async function () {
  const asyncTests = [
    ['test_oneCallPerBoard_',                     test_oneCallPerBoard_],
    ['test_bundleShapeUnchanged_',                test_bundleShapeUnchanged_],
    ['test_partlyFailedBundleIsStillNeverCached_', test_partlyFailedBundleIsStillNeverCached_],
    ['test_goodBundleStillCachesForTheStalePaint_', test_goodBundleStillCachesForTheStalePaint_],
    ['test_coldMountMakesNoFollowUpCall_',        test_coldMountMakesNoFollowUpCall_],
    ['test_mountStillRefusesToPaintAFailedToday_', test_mountStillRefusesToPaintAFailedToday_],
  ];
  const sync = {};
  for (const [name, fn] of asyncTests) {
    let err = null;
    try { await fn(); } catch (e) { err = e; }
    sync[name] = () => { if (err) throw err; };
  }

  Object.assign(sync, {
    test_paintGateAgainstTheNewPayload_,
    test_routeReturnsTheWholeBoard_,
    test_todayIsDownloadedOnce_,
    test_aFailedBadgesStillLeavesAUsableBoard_,
    test_aFailedTodayIsReportedInItsOwnSlot_,
    test_dutchieDownIsStillOneHonestFailurePerPart_,
    test_aFailedSlotCarriesNoSecret_,
    test_badgesAreCached_,
    test_badgesCacheIsDroppedByRefreshNow_,
    test_theSingleRoutesSurvive_,
    test_bundleIgnoresTheDeltaCursor_,
  });

  H.run('KIOSK ONE CALL', sync);
}());
