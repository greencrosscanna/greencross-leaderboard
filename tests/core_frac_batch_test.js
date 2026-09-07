#!/usr/bin/env node
/* NO GX Core call for the fraction; ONE for the curve — expectedSalesFrac_ in dutchie_fetch.gs.
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
 * BATCHING WAS NOT THE END OF IT. On 2026-09-07 the same telemetry over a full day showed that even
 * one call per render made expected_frac 59.7% of ALL calls reaching Core and 55% of its execution —
 * still the largest single load on the shared brain. So the call is gone, not batched further: the
 * fraction is derivable from a curve this app already mirrors from Core daily.
 *
 * What must stay true:
 *   · the fraction costs ZERO Core round trips, however many times it is asked;
 *   · it equals what GX Core's own expectedSalesFrac would return for the same curve — asserted
 *     against a verbatim copy of the shipped function, not assumed;
 *   · the linear fallback still catches a genuinely missing curve, and never a zero;
 *   · the CURVE is still fetched from Core, once, batched — that call is the shared source of truth
 *     and must not follow the fraction out the door.
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

console.log('\nNo call at all for the fraction');

/* THE CHANGE, 2026-09-07: expectedSalesFrac_ makes NO GX Core round trip.
 *
 * It used to batch six trips into one, which this file was written to protect and which the header
 * above still records. GX Core's telemetry then measured what even ONE call per render cost:
 * expected_frac was 59.7% of ALL calls reaching Core over 24h and 55% of its execution time — the
 * largest single load on the shared brain.
 *
 * It is gone rather than batched further, because the number was always derivable here. The curve is
 * mirrored from Core daily (primeHourlyDist_, run every 5 minutes by refreshDirectorCache) and the
 * arithmetic below is line-for-line Core's own. One source of truth is preserved — the CURVE is the
 * truth, and the fraction is a clock applied to it. */
{
  const ctx = ctxFor('ok');
  ctx.coreStoreId_ = s => s.slug;
  for (let i = 0; i < 20; i++) STORES.forEach(s => ctx.expectedSalesFrac_(s, 11, 0, 0.5));
  const n = ctx.__calls.filter(u => u.indexOf('expected_frac') >= 0).length;
  ok(`120 asks cost ZERO expected_frac calls (made ${n})`, n === 0);
  ok('and no GX Core round trip of any kind on the pacing path',
     ctx.__calls.filter(u => u.indexOf('hourly_shape') >= 0).length === 0);
}

/* THE EQUIVALENCE THE CHANGE RESTS ON, asserted rather than assumed.
 *
 * Deleting the Core call is only safe if the local answer IS Core's answer. So this runs GX Core's
 * expectedSalesFrac — pasted verbatim from gx_dutchie.gs:949, the shipped source — over the same
 * curve and demands the same number. Both loops run 8..22 (GX_HOURLY_OPEN and STORE_OPEN_HOUR are
 * both 8, CLOSE both 22); if either side ever moves, this fails rather than drifting quietly.
 *
 * A pasted copy is exactly what tests/_harness.js warns against for the code UNDER test, and is the
 * right thing here: the point is to compare two independent implementations, so the reference has to
 * be independent. */
{
  const CURVE = { 8: 0, 9: 0.02, 10: 0.05, 11: 0.09, 12: 0.16, 13: 0.12 };
  const OPEN = 8, CLOSE = 22;
  function coreExpectedSalesFrac(dist, nowHour, nowMinute, dayFrac) {   // gx_dutchie.gs:949
    if (!dist) return dayFrac;
    let ef = 0;
    for (let h = OPEN; h < CLOSE; h++) {
      if (h < nowHour)        ef += (dist[h] || 0);
      else if (h === nowHour) ef += (dist[h] || 0) * (nowMinute / 60);
    }
    return ef > 0 ? ef : dayFrac;
  }

  const probe = ctxFor('ok');
  const now = probe.ptNow_();
  const dow = new Date(probe.ptDateToUtcMs_(now.dateStr)).getDay();
  const seeded = {};
  seeded[probe.GC_HOURLY_DIST_KEY] = JSON.stringify({ ['center:' + dow + ':' + now.dateStr]: CURVE });

  let same = 0, checked = 0;
  const ctx = ctxFor('down', seeded);     // 'down' proves it needs no Core even when Core is there
  for (const [h, m] of [[9, 0], [10, 30], [11, 0], [11, 30], [12, 45], [13, 59]]) {
    const mine = ctx.expectedSalesFrac_({ slug: 'center' }, h, m, 0.99);
    const theirs = coreExpectedSalesFrac(CURVE, h, m, 0.99);
    checked++;
    if (Math.abs(mine - theirs) < 1e-12) same++;
  }
  ok(`the local answer matches GX Core's own arithmetic at every hour tested (${same}/${checked})`,
     same === checked);
  ok('and it is not just returning the linear fallback',
     Math.abs(ctx.expectedSalesFrac_({ slug: 'center' }, 11, 30, 0.99) - 0.99) > 1e-9);
}

/* THE CLOCK STILL MOVES THE NUMBER. The old memo was keyed by hour:minute so a long execution could
   not serve a stale pace; that memo is gone, but the property it protected must survive it. */
{
  const CURVE = { 8: 0, 9: 0.02, 10: 0.05, 11: 0.09, 12: 0.16 };
  const probe = ctxFor('ok');
  const now = probe.ptNow_();
  const dow = new Date(probe.ptDateToUtcMs_(now.dateStr)).getDay();
  const seeded = {};
  seeded[probe.GC_HOURLY_DIST_KEY] = JSON.stringify({ ['bend:' + dow + ':' + now.dateStr]: CURVE });
  const ctx = ctxFor('down', seeded);
  const a = ctx.expectedSalesFrac_({ slug: 'bend' }, 11, 0, 0.5);
  const b = ctx.expectedSalesFrac_({ slug: 'bend' }, 11, 30, 0.5);
  ok(`a later minute prices higher (${a.toFixed(4)} → ${b.toFixed(4)})`, b > a);
}

/* THE FALLBACK CHAIN IS UNCHANGED — a genuinely missing curve still degrades to the linear ramp
   rather than to zero. The pace bar is what staff read, and a silent zero reads as "you have sold
   nothing". This is the one behavior that must survive every rewrite of this file. */
{
  const ctx = ctxFor('down');            // no seeded curve → getHourlyDistCached_ returns null
  const out = STORES.map(s => ctx.expectedSalesFrac_(s, 11, 0, 0.5));
  ok('every store falls back to the linear fraction', out.every(v => v === 0.5));
  ok('and it did not reach for GX Core to rescue itself',
     ctx.__calls.filter(u => u.indexOf('expected_frac') >= 0).length === 0);
}
{
  const ctx = ctxFor('ok');
  ctx.coreStoreId_ = s => s.slug;
  const v = ctx.expectedSalesFrac_({ slug: 'not-a-store' }, 11, 0, 0.44);
  ok('an unknown store falls back rather than returning 0/NaN', v === 0.44);
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
