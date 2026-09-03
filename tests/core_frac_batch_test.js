#!/usr/bin/env node
/* One GX Core call for every store — coreFracs_ / expectedSalesFrac_ in dutchie_fetch.gs.
 *
 * expectedSalesFrac_ is called from four places, several inside per-store loops, and it used to make
 * its OWN GX Core round trip every time. GX Core's request telemetry measured the bill on
 * 2026-09-03: expected_frac was 46% of ALL traffic reaching GX Core — the single largest caller of
 * anything — with hourly_shape another 9%. Six stores meant six /exec round trips per refresh, and
 * the kiosks poll constantly by design.
 *
 * That is also why the kiosk was the app showing "Offline — data from 109153 min ago" that morning
 * while spiff, which makes one call, loaded fine: /exec has intermittent bad spells, every trip is
 * an independent roll against them, and six rolls per refresh is six chances to lose.
 *
 * What must stay true:
 *   · ONE Core call prices every store, however many times expectedSalesFrac_ is asked;
 *   · a FAILED batch is remembered too — gxCoreRoute_ retries three times with sleeps, so an outage
 *     used to cost six stores x three attempts of dead waiting on every render;
 *   · the local curve and the linear fallback are untouched, so a Core outage degrades exactly as
 *     it did before;
 *   · crossing a minute re-prices, rather than serving a stale pace.
 *
 * Per tests/_harness.js's rule this never reimplements: it loads the shipped .gs and calls the real
 * function. UrlFetchApp is stubbed so every Core round trip is counted.
 */
'use strict';
const { load } = require('./_harness');

let pass = 0, fail = 0;
const ok = (m, c) => { c ? (pass++, console.log('  ok  ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const FRACS = { bend: 0.11, center: 0.15, commercial: 0.13,
                hillsboro: 0.14, 'portland-rd': 0.09, 'river-rd': 0.09 };

const SHAPES = Object.keys(FRACS).reduce((o, id) => { o[id] = { 10: 0.4, 11: 0.6 }; return o; }, {});

/* `mode` decides how the fake GX Core behaves. Every fetch is recorded, so "how many round trips did
 * a render cost" is the thing under test, not an implementation detail. */
function ctxFor(mode, props) {
  const calls = [];
  const fetch = (url) => {
    calls.push(String(url));
    if (mode === 'down') throw new Error('GX Core unreachable');
    if (mode === 'refuse') {
      return { getContentText: () => JSON.stringify({ ok: false, error: 'refused' }), getResponseCode: () => 200 };
    }
    if (String(url).indexOf('hourly_shape') >= 0) {
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, count: 6, shapes: SHAPES }),
      };
    }
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, hour: 11, minute: 0, count: 6, fracs: FRACS }),
    };
  };
  // dutchie_proxy.gs comes along for ptNow_ / ptDateToUtcMs_, which getHourlyDistCached_ uses to
  // build its cache key. Loading it is how the local-curve assertion exercises the real lookup.
  const ctx = load(['dutchie_fetch.gs', 'dutchie_proxy.gs'], {
    stubs: {
      UrlFetchApp: { fetch, fetchAll: () => [] },
      /* Seeds the REAL local-curve store rather than trying to replace getHourlyDistCached_.
         A top-level function cannot be overridden by assigning to the returned exports object —
         the sandbox closure already bound it — so an attempted stub silently does nothing and the
         test passes or fails for the wrong reason. Feed the data source instead. */
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: k => (k === 'GX_DEPLOY_SECRET' ? 'test-secret' : ((props || {})[k] || null)),
          setProperty() {},
        }),
      },
    },
  });
  ctx.__calls = calls;
  return ctx;
}

const STORES = Object.keys(FRACS).map(id => ({ slug: id }));

console.log('\nOne call for every store');

/* THE POINT OF THE CHANGE. Six stores, one round trip. */
{
  const ctx = ctxFor('ok');
  ctx.coreStoreId_ = s => s.slug;                  // bypass the registry map; not what is under test
  const out = STORES.map(s => ctx.expectedSalesFrac_(s, 11, 0, 0.5));
  const coreCalls = ctx.__calls.filter(u => u.indexOf('expected_frac') >= 0);
  ok(`six stores cost ONE GX Core call (made ${coreCalls.length})`, coreCalls.length === 1);
  ok('and it asks for every store at once', /stores=all/.test(coreCalls[0] || ''));
  ok('each store still gets its own value', out[0] === 0.11 && out[5] === 0.09);
  ok('no per-store store= parameter is sent any more', !/[?&]store=/.test(coreCalls[0] || ''));
}

/* Repeated asks within one execution must be free — four call sites exist. */
{
  const ctx = ctxFor('ok');
  ctx.coreStoreId_ = s => s.slug;
  for (let i = 0; i < 20; i++) STORES.forEach(s => ctx.expectedSalesFrac_(s, 11, 0, 0.5));
  const n = ctx.__calls.filter(u => u.indexOf('expected_frac') >= 0).length;
  ok(`120 asks still cost ONE call (made ${n})`, n === 1);
}

/* A FAILED BATCH IS REMEMBERED. This is the resilience half, and it matters as much as the batching:
   gxCoreRoute_ retries three times with sleeps, so without this an outage cost six stores x three
   attempts of dead waiting on every single render, with the kiosk sitting there for it. */
{
  const ctx = ctxFor('down');
  ctx.coreStoreId_ = s => s.slug;
  // no seeded curve, so the real getHourlyDistCached_ returns null → linear fallback
  const out = STORES.map(s => ctx.expectedSalesFrac_(s, 11, 0, 0.5));
  const n = ctx.__calls.filter(u => u.indexOf('expected_frac') >= 0).length;
  ok(`a Core outage is attempted ONCE per execution, not once per store (fetches=${n})`, n <= 3);
  ok('every store falls back to the linear fraction', out.every(v => v === 0.5));
}

/* A refusal (ok:false) is a failure too, and must not be retried per store either. */
{
  const ctx = ctxFor('refuse');
  ctx.coreStoreId_ = s => s.slug;
  STORES.forEach(s => ctx.expectedSalesFrac_(s, 11, 0, 0.5));
  const n = ctx.__calls.filter(u => u.indexOf('expected_frac') >= 0).length;
  ok(`a refused batch is also remembered (fetches=${n})`, n <= 3);
}

/* THE FALLBACK CHAIN IS UNCHANGED — a Core outage must degrade exactly as it did before. */
{
  const CURVE = { 8: 0, 9: 0.02, 10: 0.05, 11: 0.09, 12: 0.16 };
  // Build the key getHourlyDistCached_ actually looks up: slug:dow:YYYY-MM-DD in Pacific.
  const probe = ctxFor('ok');
  const now = probe.ptNow_();
  const dow = new Date(probe.ptDateToUtcMs_(now.dateStr)).getDay();
  const seeded = {};
  seeded[probe.GC_HOURLY_DIST_KEY] = JSON.stringify({ ['center:' + dow + ':' + now.dateStr]: CURVE });

  const ctx = ctxFor('down', seeded);
  const v = ctx.expectedSalesFrac_({ slug: 'center' }, 11, 30, 0.99);
  const want = 0.02 + 0.05 + 0.09 * 0.5;           // hours before 11, plus half of hour 11
  ok(`the local mirrored curve still answers when Core is down (${v.toFixed(4)} vs ${want.toFixed(4)})`,
     Math.abs(v - want) < 1e-9);
  ok('and it did NOT silently fall through to the linear fraction', Math.abs(v - 0.99) > 1e-9);
}

/* CROSSING A MINUTE RE-PRICES. A memo keyed only by store would serve a stale pace to a long
   execution; pace is a function of the clock. */
{
  const ctx = ctxFor('ok');
  ctx.coreStoreId_ = s => s.slug;
  ctx.expectedSalesFrac_({ slug: 'bend' }, 11, 0, 0.5);
  ctx.expectedSalesFrac_({ slug: 'bend' }, 11, 1, 0.5);      // one minute later
  const n = ctx.__calls.filter(u => u.indexOf('expected_frac') >= 0).length;
  ok(`a new minute re-prices rather than serving a stale pace (calls=${n})`, n === 2);
}

/* A store missing from the batch must fall through, not become zero or NaN — the pace bar is what
   staff read, and a silent zero reads as "you have sold nothing". */
{
  const ctx = ctxFor('ok');
  ctx.coreStoreId_ = s => s.slug;
  const v = ctx.expectedSalesFrac_({ slug: 'not-a-store' }, 11, 0, 0.44);
  ok('a store absent from the batch falls back rather than returning 0/NaN', v === 0.44);
}

console.log('\nThe curve itself — one call, not one per store');

/* hourly_shape was 15% of everything reaching GX Core, second only to expected_frac, because this
   app asked per store in two places: getHourlyDist_ on demand, and the daily mirror loop. */
{
  const ctx = ctxFor('ok');
  ctx.coreStoreId_ = s => s.slug;
  // guarded: a build without the batch falls through to the local builder, which throws for an
  // unknown store and would end the run rather than failing this assertion.
  STORES.forEach(s => { try { ctx.getHourlyDist_(s); } catch (e) {} });
  const n = ctx.__calls.filter(u => u.indexOf('hourly_shape') >= 0).length;
  ok(`six curves cost ONE GX Core call (made ${n})`, n === 1);
  ok('and it asks for every store at once', ctx.__calls.some(u => /hourly_shape/.test(u) && /stores=all/.test(u)));
}

/* Repeated asks in one execution are free — this runs inside loops. */
{
  const ctx = ctxFor('ok');
  ctx.coreStoreId_ = s => s.slug;
  for (let i = 0; i < 15; i++) STORES.forEach(s => { try { ctx.getHourlyDist_(s); } catch (e) {} });
  const n = ctx.__calls.filter(u => u.indexOf('hourly_shape') >= 0).length;
  ok(`90 asks still cost ONE call (made ${n})`, n === 1);
}

/* A FAILED BATCH IS REMEMBERED, same as the fracs — gxCoreRoute_ retries three times with sleeps,
   so without this an outage cost every store its own three attempts on one render. */
{
  const ctx = ctxFor('down');
  ctx.coreStoreId_ = s => s.slug;
  STORES.forEach(s => { try { ctx.getHourlyDist_(s); } catch (e) {} });
  const n = ctx.__calls.filter(u => u.indexOf('hourly_shape') >= 0).length;
  ok(`a Core outage is attempted ONCE per execution, not once per store (fetches=${n})`, n <= 3);
}

/* The value must still arrive, and fall through to the local builder when it does not. */
{
  const ctx = ctxFor('ok');
  ctx.coreStoreId_ = s => s.slug;
  let shape = null; try { shape = ctx.getHourlyDist_({ slug: 'center' }); } catch (e) {}
  ok('the curve comes back from the batch', shape && shape[11] === 0.6);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
