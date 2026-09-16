#!/usr/bin/env node
/* The client cache refuses a FAILED payload — _withCache / _isErrorPayload in index.html.
 *
 * THE BUG. _withCache's "don't cache errors" line read `if (!data || data.ok === false)`, which is
 * right for a single route's reply and useless for the two things that actually go through it.
 * fetchKioskAll ASSEMBLES { today, leaderboard, badges } out of three separate calls and
 * fetchDirectorAll receives { summary, stores, staff, alerts, ... } — neither bundle has a
 * top-level `ok` at all. So a kiosk payload whose `today.ok === false` passed the guard, was
 * written to localStorage, and SURVIVED A RELOAD: normalizeKioskData_ defaults every missing field,
 * so that entry paints a complete, confident board reading $0 sold, 0%, no ticker — off disk, at
 * 4am, on the most visible screen in the company. Nothing rejects and nothing logs.
 *
 * WHY THE OBVIOUS ONE-LINER IS NOT THE FIX. `|| (data.today && data.today.ok === false)` names one
 * key and misses its siblings: a failed `leaderboard` normalizes to an empty staff array (a board
 * announcing nobody sold anything) and a failed `badges` to an empty trophy row. test_leaderboard
 * and test_badges below are red against that version as well as against the original.
 *
 * WHY IT IS NOT A DEEP SCAN EITHER. One level, because every value in a bundle is a whole route's
 * reply with `ok` at its top. Deeper and it starts reading fields that carry ok:false as DATA —
 * getStoreLeaderboard's SPIFF state is exactly that, and was renamed `spiffOk` to dodge the
 * collision. test_ok_deeper_is_data pins that.
 *
 * WHAT IT MUST NOT BREAK. Refusing to write must not throw a good board away: the fetched data is
 * still returned to the caller (test_failed_bundle_still_returned) and the last wholly good entry
 * stays on disk for the stale path (test_last_good_survives). Those two are the reason a partial
 * failure can fail the whole entry without making a morning worse.
 *
 * Per tests/_harness.js's rule this NEVER reimplements the subject. It lifts the real cache tier
 * (_mem, _getCached, _setCache, _getStaleCache, _isErrorPayload, _withCache) as a REGION of the
 * shipped index.html, and the real fetchKioskAll / fetchDirectorAll / fetchStoreToday /
 * fetchStoreLeaderboard / fetchStoreBadges by name, so the bundle shapes come from shipped code —
 * add a fourth call to fetchKioskAll and this suite drives it. Only gasCall is stubbed; that is
 * the network, not the subject. The harness itself is not reused: it loads .gs files and this code
 * lives in the monolith (same approach as big_sale_banner_test.js).
 *
 * Run:  node tests/cache_error_payload_test.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// The whole two-tier cache block, start of state to end of the wrapper. Taken as a region rather
// than function-by-function on purpose: _isErrorPayload does not exist in the broken version, and a
// by-name grab would fail structurally there instead of failing on BEHAVIOR. Both markers are in
// both versions, so the assertions below are what goes red.
const CACHE_START = src.indexOf('\n  var _mem = {};');
const CACHE_END   = src.indexOf('\n  // ── JSONP helper');
if (CACHE_START < 0 || CACHE_END < 0 || CACHE_END < CACHE_START) {
  throw new Error('cache block not found in index.html');
}
const CACHE = src.slice(CACHE_START, CACHE_END);

// One top-level-in-the-IIFE function. Bodies are indented 2 spaces, so a line that is exactly
// "  }" closes them; nested callbacks close deeper and cannot terminate early.
function grab(name) {
  const re = new RegExp('\\n  function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n');
  const m = src.match(re);
  if (!m) throw new Error('function not found in index.html: ' + name);
  return m[0];
}
const CODE = CACHE + '\n' + ['fetchStoreToday', 'fetchStoreLeaderboard', 'fetchStoreBadges',
                             'fetchKioskAll', 'fetchDirectorAll'].map(grab).join('\n');

// The kiosk's own paint gate, at file scope rather than inside the IIFE. Lifted so the boundary
// between the two gates can be ASSERTED rather than asserted-in-a-comment — see the null case.
const PAINT_GATE = (src.match(/\nfunction kioskDataError_\(rawData\) \{[\s\S]*?\n\}\n/) || [])[0];
if (!PAINT_GATE) throw new Error('kioskDataError_ not found in index.html');

// ── A localStorage real enough to catch the bug ────────────────────────────────────────────────
// Only the part index.html uses: getItem/setItem/removeItem, values coerced to strings, and
// enumerable keys (clearAvatarCaches walks Object.keys(localStorage)).
function makeStorage() {
  const bag = Object.create(null);
  return {
    getItem(k)    { return Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : null; },
    setItem(k, v) { bag[k] = String(v); },
    removeItem(k) { delete bag[k]; },
    _keys()       { return Object.keys(bag); },
    _raw()        { return bag; },
  };
}

function make() {
  const env = { calls: [], responses: {}, now: 1789500000000 };   // 2026-09-16 ~04:00 PT
  const storage = makeStorage();

  /* A clock the test drives. _setCache and _getCached both key off Date.now(), and two writes in
   * the same millisecond make "the entry was not overwritten" pass by coincidence — it did, against
   * the broken version, until the clock was pinned. */
  class ClockDate extends Date {
    constructor(...a) { if (!a.length) super(env.now); else super(...a); }
    static now() { return env.now; }
  }
  ClockDate.UTC = Date.UTC;
  ClockDate.parse = Date.parse;

  const sandbox = {
    console, Promise, JSON, Object, Array,
    Date: ClockDate,
    localStorage: storage,
    USE_FIXTURES: false,
    GC: { THRESHOLDS: { bigTransactionMin: 300 } },
    fetchFixture() { throw new Error('fixtures must not be reached with USE_FIXTURES=false'); },
    // The network boundary, and the only stub in this file.
    gasCall(action, extra) {
      env.calls.push({ action, extra });
      if (!(action in env.responses)) throw new Error('no stubbed response for action: ' + action);
      const r = env.responses[action];
      return typeof r === 'function' ? r() : Promise.resolve(r);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE + '\n' + PAINT_GATE +
    '\nthis.api = {' +
    '  withCache: _withCache, getCached: _getCached, setCache: _setCache,' +
    '  getStale: _getStaleCache, mem: function() { return _mem; },' +
    '  paintGate: kioskDataError_,' +
    '  kioskAll: fetchKioskAll, directorAll: fetchDirectorAll };', sandbox);

  env.api     = sandbox.api;
  env.storage = storage;
  env.reply   = (action, payload) => { env.responses[action] = payload; };
  env.advance = ms => { env.now += ms; };
  env.stored  = key => {
    const raw = storage.getItem('gc_cache_' + key);
    return raw === null ? null : JSON.parse(raw);
  };
  return env;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────
// Field names and nesting copied from the shipped endpoints (getStoreToday / getStoreLeaderboard /
// getStoreBadges / buildDirectorAllInner_), not invented.
const GOOD_TODAY = {
  storeSlug: 'river-rd', storeName: 'River Rd', goal: 18000, revenue: 9123.45,
  transactions: 87, avgOrderValue: 104.87, pctToGoal: 0.507, isPreOpen: false,
  hourly: [0, 0, 0, 400, 900], ticker: [{ who: 'Lina', qty: 2, price: 88, ts: '2026-09-16 11:04:00' }],
  latestTxnTs: '2026-09-16 11:04:00', refreshToken: 'rt-1', eomKey: 'lina_ortiz',
};
const GOOD_LB = {
  storeSlug: 'river-rd', storeName: 'River Rd', date: '2026-09-16',
  staff: [{ rank: 1, name: 'Lina', nameKey: 'lina_ortiz', sales: 4100, transactions: 31 }],
  onShift: [{ name: 'Lina', nameKey: 'lina_ortiz', status: 'on', sales: 4100, note: null }],
  avatarConfigs: {}, spiffOn: true, spiffOk: false, spiffPrograms: [], eomKey: 'lina_ortiz',
};
const GOOD_BADGES = {
  badges: [{ id: 'aov-avenger', label: 'AOV Avenger', winner: 'Lina', detail: '$104.87' }],
};
// The router's catch (dutchie_proxy.gs) — every sub-call failure arrives in exactly this shape.
const FAILED = { ok: false, error: 'Dutchie unavailable' };

const KIOSK_KEY = 'kiosk_river-rd';

/* THE BUNDLE IS ASSEMBLED ON THE SERVER NOW (kioskall, 2026-09-16) — and this suite is about the
 * CACHE, not about who assembled it. Both are served: the single route with the three payloads in
 * their slots, and the three legacy routes fixture mode and the polls still use. Which of them
 * fetchKioskAll actually calls is kiosk_one_call_test.js's question; every assertion below reads
 * the bundle that comes back, so it holds either way and would survive the route being renamed. */
function kioskFetch(env, over) {
  over = over || {};
  const today  = 'today'       in over ? over.today       : GOOD_TODAY;
  const lb     = 'leaderboard' in over ? over.leaderboard : GOOD_LB;
  const badges = 'badges'      in over ? over.badges      : GOOD_BADGES;
  env.reply('kioskall',         { today: today, leaderboard: lb, badges: badges });
  env.reply('storetoday',       today);
  env.reply('storeleaderboard', lb);
  env.reply('storebadges',      badges);
  return env.api.kioskAll('river-rd');
}

/* Let the background half of stale-while-revalidate land. When a FRESH entry is already cached,
 * _withCache resolves from it straight away and the network response is handled a microtask later
 * — so asserting on storage the instant the await returns reads the cache BEFORE the write that
 * should not happen, and the broken version passes. */
const flush = () => new Promise(r => setImmediate(() => setImmediate(r)));

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'value') + ': expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a));
}

// ── The bug itself ─────────────────────────────────────────────────────────────────────────────

t('a kiosk bundle whose today FAILED is never written to localStorage', async () => {
  const env = make();
  const data = await kioskFetch(env, { today: FAILED });
  eq(data.today.ok, false, 'fixture sanity — today really did fail');
  eq(env.stored(KIOSK_KEY), null, 'localStorage entry for ' + KIOSK_KEY);
  eq(env.storage._keys().length, 0, 'localStorage keys written');
});

t('...and it does not survive into the memory tier either', async () => {
  const env = make();
  await kioskFetch(env, { today: FAILED });
  eq(env.api.getCached(KIOSK_KEY, 3 * 60 * 1000), null, '_getCached after a failed today');
  eq(Object.keys(env.api.mem()).length, 0, '_mem entries');
});

t('a failed LEADERBOARD poisons the bundle too (the sibling a today-only guard misses)', async () => {
  const env = make();
  const data = await kioskFetch(env, { leaderboard: FAILED });
  eq(data.today.revenue, GOOD_TODAY.revenue, 'fixture sanity — today is good here');
  eq(env.stored(KIOSK_KEY), null, 'localStorage entry for ' + KIOSK_KEY);
});

t('a failed BADGES poisons the bundle too', async () => {
  const env = make();
  await kioskFetch(env, { badges: FAILED });
  eq(env.stored(KIOSK_KEY), null, 'localStorage entry for ' + KIOSK_KEY);
});

t('two failed parts at once are still just one refusal', async () => {
  const env = make();
  await kioskFetch(env, { today: FAILED, badges: FAILED });
  eq(env.stored(KIOSK_KEY), null, 'localStorage entry for ' + KIOSK_KEY);
});

// ── The director bundle goes through the same wrapper ──────────────────────────────────────────

t('a director bundle whose summary FAILED is not cached', async () => {
  const env = make();
  env.reply('directorall', { summary: FAILED, stores: [], staff: [], alerts: [], today: {} });
  await env.api.directorAll('mtd');
  eq(env.stored('director_mtd'), null, 'localStorage entry for director_mtd');
});

t('the original top-level guard still holds: {ok:false} from the router catch is not cached', async () => {
  const env = make();
  env.reply('directorall', FAILED);
  await env.api.directorAll('mtd');
  eq(env.stored('director_mtd'), null, 'localStorage entry for director_mtd');
});

// ── What must NOT change: good payloads still cache ────────────────────────────────────────────

t('a wholly good kiosk bundle IS cached, to disk and to memory', async () => {
  const env = make();
  await kioskFetch(env);
  const entry = env.stored(KIOSK_KEY);
  eq(entry === null, false, 'localStorage entry for ' + KIOSK_KEY + ' exists');
  eq(entry.data.today.revenue, GOOD_TODAY.revenue, 'cached revenue');
  eq(entry.data.leaderboard.staff.length, 1, 'cached staff rows');
  eq(entry.data.badges.badges.length, 1, 'cached badges');
  eq(typeof entry.ts, 'number', 'cache entry timestamp');
  eq(env.api.getCached(KIOSK_KEY, 3 * 60 * 1000) === null, false, '_getCached finds it');
});

t('a wholly good director bundle IS cached', async () => {
  const env = make();
  env.reply('directorall', {
    summary: { revenue: 1 }, stores: [{ slug: 'river-rd' }], staff: [], alerts: [],
    today: { revenue: 1 }, avatarConfigs: {}, eomKey: null, discountTarget: 0, unavailableStores: [],
  });
  await env.api.directorAll('mtd');
  eq(env.stored('director_mtd') === null, false, 'localStorage entry for director_mtd exists');
});

t('falsy fields that are DATA do not read as failure (spiffOk:false, isPreOpen:false, goal 0)', async () => {
  const env = make();
  await kioskFetch(env, {
    today: Object.assign({}, GOOD_TODAY, { goal: 0, revenue: 0, isPreOpen: false }),
    leaderboard: Object.assign({}, GOOD_LB, { spiffOn: false, spiffOk: false, staff: [] }),
    badges: { badges: [] },
  });
  eq(env.stored(KIOSK_KEY) === null, false,
     'a genuinely quiet pre-open morning must still cache');
});

t('an ok:false one level DEEPER is data, and so is one inside an array', async () => {
  /* THE ONE-LEVEL RULE, pinned. `{ok:false, error, byId, programs}` is the literal return of
   * spiff.gs's spiffForStore_, and its ok:false is the ORDINARY state — "SPIFF row disabled in
   * Settings", or a fortnight with nothing published (spiff.gs:536, and the note at :178 that
   * ok:true with zero rows is normal). getStoreLeaderboard flattens it to the scalar `spiffOk`
   * today, so nothing trips this now; the day anyone passes the object through, a recursive scan
   * would stop caching the kiosk at every store where SPIFF is simply switched off. The array is
   * the same question for `spiffPrograms`. */
  const env = make();
  await kioskFetch(env, {
    leaderboard: Object.assign({}, GOOD_LB, {
      spiff:         { ok: false, error: 'SPIFF row disabled in Settings', byId: {}, programs: [] },
      spiffPrograms: [{ program_id: 'p1', product: 'Cartridge', ok: false }],
    }),
  });
  eq(env.stored(KIOSK_KEY) === null, false,
     'ok:false below the sub-response level must not refuse the entry');
});

// ── Refusing to WRITE must not cost a board ────────────────────────────────────────────────────

t('the failed bundle is still RETURNED to the caller, so the kiosk can say why', async () => {
  const env = make();
  const data = await kioskFetch(env, { today: FAILED });
  eq(data === null || data === undefined, false, '_withCache must resolve, not swallow');
  eq(data.today.error, 'Dutchie unavailable', 'the error text reaches kioskDataError_');
});

t('the last wholly good entry survives a later partial failure', async () => {
  const env = make();
  await kioskFetch(env);                            // good morning
  const good = env.stored(KIOSK_KEY);
  env.advance(90 * 1000);                           // a minute and a half later...
  await kioskFetch(env, { today: FAILED });         // ...Dutchie drops out
  await flush();                                    // the cached entry answered first; let the fetch land
  const after = env.stored(KIOSK_KEY);
  eq(after === null, false, 'the good entry must still be on disk');
  eq(after.data.today.revenue, GOOD_TODAY.revenue, 'cached revenue after the failure');
  eq(after.ts, good.ts, 'the good entry must not have been overwritten');
  eq(env.api.getStale(KIOSK_KEY).data.today.revenue, GOOD_TODAY.revenue,
     '_getStaleCache (the stale-paint path) still gets a true board');
  eq(env.api.getCached(KIOSK_KEY, 3 * 60 * 1000).today.revenue, GOOD_TODAY.revenue,
     'the memory tier is not cleared by a failure either');
});

// ── Degenerate responses ───────────────────────────────────────────────────────────────────────

t('an ABSENT part is the paint gate\'s job, not the cache\'s — and it is caught there', async () => {
  /* WHERE THE LINE IS, and why it is drawn here rather than one gate further out.
   *
   * _isErrorPayload refuses what REPORTS failure. A bundle of nulls reports nothing, and the cache
   * cannot tell a null sub-RESPONSE from a null scalar SLOT — directorall legitimately carries
   * `eomKey: null`, and getStoreToday `hourlyTargets: null`, so "any null refuses" would stop
   * caching every good director payload ever built. Not reachable in practice either: jsonOut only
   * ever emits an object, so a null part means GAS called the callback with nothing.
   *
   * kioskDataError_ asks the other question — is this recognizable as data — and answers it
   * correctly, which is exactly why both gates exist and neither replaces the other. */
  const env = make();
  const data = await kioskFetch(env, { today: null, leaderboard: null, badges: null });
  eq(data.today, null, 'still returned to the caller');
  eq(env.api.paintGate(data), 'No response from the server',
     'kioskDataError_ must refuse to paint a bundle with no today');
  eq(env.api.paintGate({ today: FAILED }), 'Dutchie unavailable',
     'and must still refuse a today that failed, cached or not');
  eq(env.api.paintGate({ today: GOOD_TODAY }), null,
     'and must still pass a good today — the paint gate is not weakened by this change');
});

t('a non-object response is refused', async () => {
  const env = make();
  env.reply('directorall', 'Service invoked too many times');
  await env.api.directorAll('mtd');
  eq(env.stored('director_mtd'), null, 'a bare string is not a payload');
});

// ── The revalidate path is deliberately untouched ──────────────────────────────────────────────

t('onFresh still fires on a background refresh (this fix changes persistence only)', async () => {
  const env = make();
  await kioskFetch(env);                       // seed a fresh entry
  let fresh = null;
  const served = await env.api.withCache(KIOSK_KEY, 3 * 60 * 1000,
    () => Promise.resolve({ today: Object.assign({}, GOOD_TODAY, { revenue: 9999 }),
                            leaderboard: GOOD_LB, badges: GOOD_BADGES }),
    d => { fresh = d; });
  eq(served.today.revenue, GOOD_TODAY.revenue, 'the cached entry is served immediately');
  await new Promise(r => setImmediate(r));
  eq(fresh && fresh.today.revenue, 9999, 'onFresh receives the background response');
  eq(env.stored(KIOSK_KEY).data.today.revenue, 9999, 'and the good background response replaces it');
});

(async () => {
  for (const q of queue) {
    try { await q.fn(); console.log('  ok  ' + q.name); pass++; }
    catch (err) { console.log('  FAIL ' + q.name + ' — ' + err.message); fail++; }
  }
  console.log(fail === 0
    ? '\n✅ cache_error_payload ALL PASS (' + pass + '/' + (pass + fail) + ')'
    : '\n❌ cache_error_payload ' + fail + ' FAILED (' + pass + '/' + (pass + fail) + ')');
  process.exit(fail === 0 ? 0 : 1);
})();
