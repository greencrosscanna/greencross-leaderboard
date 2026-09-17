#!/usr/bin/env node
/* ============================================================================================
 *  The kiosk cold start — an instant paint, and an age that comes from the DATA
 *
 *  THE PROBLEM THIS PINS. fetchKioskAll caches for 3 minutes. A load INSIDE that window paints
 *  instantly from cache; a load outside it — the 04:00 nightly reload, a TV switched on in the
 *  morning, a slideshow returning to a store it has not shown for a while — waited on the network
 *  with nothing but a loading shell on a wall screen. That wait has no useful ceiling: Sales
 *  measured the /exec second hop on 2026-09-15 and 6 of 174 requests fired SIX-WIDE (3.4%) do not
 *  FAIL, they HANG, 11 to 60 seconds, while their siblings answer in three. Six-wide is the shape a
 *  load fires, which is why that is the condition quoted; the 174 were authenticated store-month
 *  pulls rather than `libversion`, and the wider sweeps in the same run were at this account's
 *  30-execution cap, so neither "10%" nor an averaged "3-10%" is a rate anything should carry.
 *  (Reconciled from the raw timings 2026-09-17 — ledger in greencross-sales/CLAUDE.md, v2.597.)
 *  Our JSONP timeout is 65s and deliberately so.
 *  So a blank board for over a minute, and a "fall back to cache on failure" fix cannot help —
 *  the damage is done while everybody waits, and the handler runs after the wait rather than
 *  instead of it.
 *
 *  AND THE SECOND HALF, WHICH IS WORSE. markStale stamped `new Date()` the first time it ran, so a
 *  board painted from an hour-old cache announced "showing numbers from 1 min ago". That is a
 *  number the kiosk was never given, on a screen the public can see, and it breaks the rule written
 *  three lines above it in index.html: "it shows numbers it was given, or it shows nothing and says
 *  why. It never shows a number it made up." The age has to come from the cache entry's own `ts`.
 *
 *  WHAT IS REAL HERE. Per tests/_harness.js's rule this reimplements nothing it is testing: the
 *  cache tier, fetchKioskAll, hasKioskCache, kioskDataError_, kioskRouteSlug_, GC.views.renderKiosk,
 *  and the whole DATA UNAVAILABLE + remote-reload block are LIFTED out of the shipped index.html and
 *  run. `kiosk` itself is built from the module's own export literal, also lifted, so forgetting to
 *  export paintStale fails here rather than passing.
 *
 *  Stubbed, deliberately, and none of it is the subject: render / renderLoading / normalizeKioskData_
 *  (markup and shape conversion, covered by kiosk_hero_test.js), and init — reduced to the three
 *  side effects this path depends on, two of which call the real lifted code.
 * ========================================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (m, c) => { c ? (pass++, console.log('  ok  ' + m)) : (fail++, console.log('  FAIL ' + m)); };

// ── Lifting ────────────────────────────────────────────────────────────────────────────────────
function slice(startNeedle, endNeedle, label) {
  const a = src.indexOf(startNeedle);
  if (a < 0) throw new Error('index.html: could not find ' + label + ' (' + startNeedle + ')');
  const b = src.indexOf(endNeedle, a + startNeedle.length);
  if (b < 0) throw new Error('index.html: could not find the end of ' + label);
  return src.slice(a, b);
}

// 1. The two-tier cache + the stale-while-revalidate wrapper.
const cacheSrc = slice('  // ── Cache (two-tier', '  // ── JSONP helper', 'the cache tier');
// 2. fetchKioskAll, with its 3-minute TTL — the window whose OUTSIDE is the bug.
const fetchSrc = slice('  function fetchKioskAll(storeSlug, onFresh) {', '\n  return {\n', 'fetchKioskAll');
// 3. hasKioskCache, lifted out of the api module's export literal rather than retyped.
const hasSrc = 'var ' + slice('hasKioskCache: function(slug) {', '\n    },', 'hasKioskCache')
  .replace('hasKioskCache: ', 'hasKioskCache = ') + '\n    };';
// 4. The route guard and the "a response that failed is not data" check.
const routeSrc = slice('function kioskRouteSlug_() {', '\n}\n', 'kioskRouteSlug_') + '\n}\n';
const errSrc   = slice('function kioskDataError_(rawData) {', '\n}\n', 'kioskDataError_') + '\n}\n';
// 5. The paint path itself.
const renderKioskSrc = slice('GC.views.renderKiosk = function(slug) {', '\n};\n', 'renderKiosk') + '\n};\n';
// 6. DATA UNAVAILABLE through the end of the remote-reload block.
const unavailSrc = slice('  // ══ DATA UNAVAILABLE', '  // ── Render: Header', 'the DATA UNAVAILABLE block');
// 7. The kiosk module's OWN export literal — so a missing export is a failure, not a silent pass.
const exportsSrc = 'var kiosk = ' + slice('  return {\n    render:          render,', '\n  };', 'the kiosk export literal')
  .replace('  return {', '{') + '\n  };';

if (!/function paintStale/.test(unavailSrc)) {
  console.log('  FAIL paintStale is not in the DATA UNAVAILABLE block — the cold-start paint is missing');
  process.exit(1);
}

const GOOD = () => ({
  today: {
    storeSlug: 'river-rd', storeName: 'River Rd',
    revenue: 12450, goal: 14000, pctToGoal: 0.889, refreshToken: 'tok-cached',
    onShift: [], hourly: [], ticker: [],
  },
  leaderboard: { staff: [] },
  badges: { badges: [] },
});
// What fetchStoreToday itself answers with when the backend refuses. Note the level: it is the
// STORETODAY payload, not the assembled kiosk bundle — { ok:false } here is what kioskDataError_
// has to catch, and it RESOLVES, so nothing rejects anywhere.
const BAD_TODAY = () => ({ ok: false, error: 'Dutchie is down' });

const MIN = 60 * 1000;

// ── One sandbox per scenario ───────────────────────────────────────────────────────────────────
function build(opts) {
  opts = opts || {};
  const store = Object.create(null);           // stands in for localStorage
  const app = { id: 'app', innerHTML: '' };
  const nodes = { app: app };
  const timers = [];
  const log = { renders: [], inits: [], loading: 0, reloads: 0 };

  /* fetchKioskAll asks the server for the assembled board in ONE call now (`kioskall`,
   * 2026-09-16) instead of fanning out to three. Both are wired here and both are held open by
   * the same land()/die(), because this suite is about what the SCREEN does while the network is
   * slow or dead — which is the same question whoever assembled the payload. The three fixture-mode
   * deferreds stay: fetchKioskAll still fans out when USE_FIXTURES is on. */
  const defer = () => { const d = {}; d.p = new Promise((res, rej) => { d.res = res; d.rej = rej; }); return d; };
  const dToday = defer(), dLb = defer(), dBadges = defer(), dBundle = defer();
  // The three fixture-mode deferreds have no consumer on the live path any more, and node kills
  // the process on an unhandled rejection — so die() rejecting them would abort the suite rather
  // than exercise it. One inert handler each; the assertions still read dBundle.
  [dToday, dLb, dBadges].forEach((d) => d.p.catch(() => {}));

  const doc = {
    getElementById(id) {
      if (id === 'kioskGoalSold') {
        // The real board carries this element; the unavailable panel does not. showUnavailable
        // reads exactly this to decide whether there is a board worth keeping.
        return /id="kioskGoalSold"/.test(app.innerHTML) ? { id: id } : null;
      }
      return nodes[id] || null;
    },
    createElement(tag) {
      const el = { tagName: tag, id: '', className: '', innerHTML: '',
                   remove() { if (el.id) delete nodes[el.id]; } };
      return el;
    },
    querySelector() { return null; },
    body: { firstChild: null, insertBefore(el) { nodes[el.id] = el; }, classList: { add() {}, remove() {} } },
  };

  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Promise, Object, Array, String, Number, Error,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; },
    },
    document: doc,
    window: { location: { hash: '#/store/river-rd', reload() { log.reloads++; } },
              addEventListener() {}, removeEventListener() {} },
    e: (v) => String(v == null ? '' : v).replace(/[&<>"]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    USE_FIXTURES: false,
    // The three calls fetchKioskAll fans out to. All three share one controllable promise so a test
    // can hold the network open (the HANG case) or land it on demand.
    fetchStoreToday: () => dToday.p,
    fetchStoreLeaderboard: () => dLb.p,
    fetchStoreBadges: () => dBadges.p,
    // The one call the board is fetched with. Anything else a lifted function might reach for
    // hangs forever rather than resolving by accident — a silent resolve would make a test about
    // waiting pass without waiting.
    gasCall: (action) => (action === 'kioskall' ? dBundle.p : new Promise(() => {})),
    // Stubs — markup and shape conversion, neither of which is what this suite is about.
    render: (data, slug) => { log.renders.push({ slug, revenue: data.today.revenue });
                              return '<div id="kioskGoalSold">$' + data.today.revenue + '</div>'; },
    renderLoading: () => { log.loading++; return '<div class="kiosk-loading">Loading…</div>'; },
    normalizeKioskData_: (raw) => ({ today: raw.today,
                                     leaderboard: raw.leaderboard || {}, badges: raw.badges || {} }),
    refreshHourly() {}, _hideRareDrop() {},
  };
  ctx.window.GC = ctx.GC = { views: {}, esc: ctx.e, router: { onLeave() {} }, auth: { load: () => ({}) } };
  vm.createContext(ctx);

  vm.runInContext(cacheSrc + '\n' + fetchSrc + '\n' + hasSrc, ctx);
  vm.runInContext(routeSrc + '\n' + errSrc, ctx);
  vm.runInContext(unavailSrc, ctx);
  // init, reduced to the three side effects the cold-start path actually leans on. Two of the three
  // are the REAL lifted functions; the third is the one line that makes showUnavailable's downgrade
  // check see a board.
  vm.runInContext(
    'function init(data, slug) { _painted = slug; _clearStaleBanner();' +
    '  checkRemoteRefresh(slug, data.today.refreshToken); __initLog.push(slug); }', ctx);
  ctx.__initLog = log.inits;
  vm.runInContext(exportsSrc, ctx);
  ctx.GC.api = {
    fetchKioskAll: ctx.fetchKioskAll,
    hasKioskCache: ctx.hasKioskCache,
    getStaleCache: ctx._getStaleCache,
    fetchStoreToday: () => new Promise(() => {}),
    gasCall: () => new Promise(() => {}),
  };
  vm.runInContext(renderKioskSrc, ctx);

  if (opts.cache) store['gc_cache_kiosk_river-rd'] = JSON.stringify(opts.cache);

  return {
    ctx, app, nodes, log, store, timers,
    banner: () => (nodes.kioskStaleBanner ? nodes.kioskStaleBanner.innerHTML : ''),
    render: () => ctx.GC.views.renderKiosk('river-rd'),
    land: (today) => { dBundle.res({ today: today, leaderboard: { staff: [] }, badges: { badges: [] } });
                       dToday.res(today); dLb.res({ staff: [] }); dBadges.res({ badges: [] });
                       return new Promise((r) => setTimeout(r, 0)); },
    die: (e2) => { dBundle.rej(e2); dToday.rej(e2); dLb.rej(e2); dBadges.rej(e2);
                   return new Promise((r) => setTimeout(r, 0)); },
  };
}

// ══ (a) A COLD LOAD WITH A STALE ENTRY PAINTS, ON THE FIRST FRAME ═══════════════════════════════
// Red before the fix: renderKiosk painted kiosk.renderLoading and then sat on the network. With the
// fetch held open — the 11-to-60-second HANG Sales measured — the board stayed a loading shell.
(function coldLoadPaintsInstantly() {
  const t = build({ cache: { data: GOOD(), ts: Date.now() - 70 * MIN } });
  t.render();
  ok('(a) cold load paints the cached board on the first frame', /id="kioskGoalSold"/.test(t.app.innerHTML));
  ok('(a) it is the CACHED numbers, not invented ones', /\$12450/.test(t.app.innerHTML));
  ok('(a) no loading shell was shown', t.log.loading === 0);
  ok('(a) no "Live data unavailable" panel', !/This screen is not showing/.test(t.app.innerHTML));
  // Nothing has failed yet, so the banner must not claim anything has.
  ok('(a) the banner says it is updating, not that live data is unavailable',
     /updating/.test(t.banner()) && !/Live data unavailable/.test(t.banner()));
})();

// ══ (b) THE AGE COMES FROM THE ENTRY'S ts ═══════════════════════════════════════════════════════
// Two guards, because they fail for different reasons. The first is red against the shipped
// markStale on its own (it ignored any as-of and stamped now); the second is the end-to-end proof
// that the cold paint actually passes the entry's timestamp in.
(function ageComesFromTheData() {
  const t = build({ cache: { data: GOOD(), ts: Date.now() - 70 * MIN } });
  t.ctx.markStale('connection', Date.now() - 70 * MIN);
  ok('(b) markStale labels an as-of an hour ago as 1 hr 10 min', /from 1 hr 10 min ago/.test(t.banner()));
  ok('(b) it does NOT fabricate "1 min"', !/from 1 min ago/.test(t.banner()));

  const u = build({ cache: { data: GOOD(), ts: Date.now() - 70 * MIN } });
  u.render();
  ok('(b) the cold paint labels the board with the cache entry\'s own age',
     /Showing numbers from 1 hr 10 min ago/.test(u.banner()));
  ok('(b) an hour-old board does not say "1 min"', !/from 1 min ago/.test(u.banner()));

  // And the label itself, across the units it has to survive on a wall screen.
  const L = u.ctx.staleAgeLabel_;
  ok('(b) 3 min reads "3 min"',          L(3 * MIN) === '3 min');
  ok('(b) 59 min stays in minutes',      L(59 * MIN) === '59 min');
  ok('(b) 90 min reads "1 hr 30 min"',   L(90 * MIN) === '1 hr 30 min');
  ok('(b) 843 min reads "14 hr 3 min"',  L(843 * MIN) === '14 hr 3 min');
  ok('(b) 25 h reads "1 day 1 hr"',      L(25 * 60 * MIN) === '1 day 1 hr');
  ok('(b) never rounds an age down to zero', L(200) === '1 min');
})();

// ══ (c) BOTH FAILURE BRANCHES KEEP THE STALE BOARD ══════════════════════════════════════════════
// A backend answering { ok:false } RESOLVES, so the .catch never sees it — it is the commoner
// wobble and the one a catch-only fix leaves blank. Red before: with nothing painted, _painted was
// null and showUnavailable wiped the screen for the "Live data unavailable" panel.
(function okFalseBranch() {
  const t = build({ cache: { data: GOOD(), ts: Date.now() - 70 * MIN } });
  t.render();
  return t.land(BAD_TODAY()).then(() => {
    ok('(c) ok:false keeps the cached board on screen', /id="kioskGoalSold"/.test(t.app.innerHTML));
    ok('(c) ok:false does not paint the unavailable panel', !/This screen is not showing/.test(t.app.innerHTML));
    ok('(c) ok:false now says live data is unavailable', /Live data unavailable/.test(t.banner()));
    ok('(c) ok:false keeps the age from the DATA, not from when it failed',
       /from 1 hr 10 min ago/.test(t.banner()));
    ok('(c) ok:false names the reason', /Dutchie is down/.test(t.banner()));
  });
})();

(function catchBranch() {
  const t = build({ cache: { data: GOOD(), ts: Date.now() - 70 * MIN } });
  t.render();
  return t.die(new Error('JSONP timeout: …/exec')).then(() => {
    ok('(c) a rejected fetch keeps the cached board on screen', /id="kioskGoalSold"/.test(t.app.innerHTML));
    ok('(c) a rejected fetch does not paint the unavailable panel',
       !/This screen is not showing/.test(t.app.innerHTML));
    ok('(c) a rejected fetch keeps the age from the DATA',  /from 1 hr 10 min ago/.test(t.banner()));
  });
})();

// ══ (d) NOTHING CACHED — THE UNAVAILABLE PANEL, STILL ═══════════════════════════════════════════
// Not red before the fix, and deliberately so: it is the guard that the instant paint did not
// widen into inventing a board out of nothing.
(function nothingCached() {
  const t = build({});
  t.render();
  ok('(d) with nothing cached the loading shell is what shows first', t.log.loading === 1);
  ok('(d) nothing was painted from a board that does not exist', t.log.renders.length === 0);
  return t.die(new Error('Could not reach the server')).then(() => {
    ok('(d) the failure lands on the unavailable panel', /This screen is not showing/.test(t.app.innerHTML));
    ok('(d) the panel refuses to imply a $0 day', /It is not a \$0 day/.test(t.app.innerHTML));
    ok('(d) and it retries on its own', t.timers.length > 0);
  });
})();

// ══ (e) A CACHED ERROR IS NOT A BOARD ═══════════════════════════════════════════════════════════
// normalizeKioskData_ defaults every missing field to 0, so an { ok:false } payload normalizes into
// a confident $0 day. That is the seven-hour River Rd bug; served out of localStorage it would
// survive a reload. kioskDataError_ has to vet the cached payload too, not just the live one.
(function cachedErrorIsNotPainted() {
  const t = build({ cache: { data: { today: BAD_TODAY() }, ts: Date.now() - 10 * MIN } });
  t.render();
  ok('(e) a cached error payload is never painted as a board', t.log.renders.length === 0);
  ok('(e) the loading shell is shown instead', t.log.loading === 1);
  ok('(e) and no age label is invented for it', t.banner() === '');
})();

// ══ (f) THE LIVE PAYLOAD STILL WINS, AND CLEARS THE LABEL ═══════════════════════════════════════
(function freshLands() {
  const t = build({ cache: { data: GOOD(), ts: Date.now() - 70 * MIN } });
  t.render();
  const fresh = GOOD().today; fresh.revenue = 18800; fresh.refreshToken = 'tok-live';
  return t.land(fresh).then(() => {
    ok('(f) the live numbers replace the cached ones', /\$18800/.test(t.app.innerHTML));
    ok('(f) the age label is gone once the board is live', !t.nodes.kioskStaleBanner);
    ok('(f) _staleSince is cleared', t.ctx._staleSince === null);
  });
})();

// ══ (g) THE REMOTE-RELOAD TOKEN IS NOT SEEDED FROM CACHE ════════════════════════════════════════
// checkRemoteRefresh reloads the page when the token CHANGES. Seed it from a cached payload and the
// first live response looks like somebody asked for a reload, so a screen that had simply been
// switched off reloads itself once for nothing — on six wall screens, every morning.
(function tokenNotSeededFromCache() {
  const t = build({ cache: { data: GOOD(), ts: Date.now() - 70 * MIN } });
  t.render();
  ok('(g) the cached token is not held as the boot token',
     !t.ctx.GC._kioskRefreshTokens['river-rd']);
  const fresh = GOOD().today; fresh.refreshToken = 'tok-live';
  return t.land(fresh).then(() => {
    // checkRemoteRefresh schedules the reload on a timer, so an unwanted one shows up as a queued
    // timer even though nothing has fired yet.
    ok('(g) the first live response schedules no reload', t.log.reloads === 0 && t.timers.length === 0);
    ok('(g) the live token is the one that gets held', t.ctx.GC._kioskRefreshTokens['river-rd'] === 'tok-live');
  });
})();

// ══ (h) A WARM CACHE IS UNCHANGED ═══════════════════════════════════════════════════════════════
// Inside fetchKioskAll's 3-minute TTL nothing about this path may change: no second paint, no age
// label on a board that is current.
(function warmCacheUntouched() {
  const t = build({ cache: { data: GOOD(), ts: Date.now() - 60 * 1000 } });
  t.render();
  ok('(h) a warm cache shows no loading shell', t.log.loading === 0);
  ok('(h) a warm cache is not painted through the stale path', t.banner() === '');
  return new Promise((r) => setTimeout(r, 0)).then(() => {
    ok('(h) the warm cached board is painted exactly once', t.log.renders.length === 1);
    ok('(h) and carries no age label', !t.nodes.kioskStaleBanner);
  });
})();

// ══ (i) retryDelay_ IS UNTOUCHED ════════════════════════════════════════════════════════════════
// Six screens that fail together must not come back together: on 2026-09-15 Leaderboard went from
// ~1 request a minute to 86 in the minute of 12:24 doing exactly that, against a Google account
// capped at 30 simultaneous executions and shared by every GX app. The instant paint is what makes
// the first-paint delay moot; it is not a licence to tighten this.
(function retrySpreadPreserved() {
  const t = build({});
  const vals = []; for (let i = 0; i < 400; i++) vals.push(t.ctx.retryDelay_());
  ok('(i) never retries sooner than 30s', Math.min.apply(null, vals) >= 30000);
  ok('(i) never later than 60s',          Math.max.apply(null, vals) < 60000);
  ok('(i) the spread is still randomized', Math.max.apply(null, vals) - Math.min.apply(null, vals) > 20000);
})();

// ── Summary (last line — gx-preflight tails it) ────────────────────────────────────────────────
setTimeout(function () {
  const total = pass + fail;
  console.log(fail === 0
    ? '✅ kiosk cold start / stale paint ALL PASS (' + pass + '/' + total + ')'
    : '❌ kiosk cold start / stale paint ' + fail + ' FAILED (' + pass + '/' + total + ')');
  if (fail > 0) process.exit(1);
}, 60);
