#!/usr/bin/env node
/* ─── Check-in: an open screen tells GX Core it is there ─────────────────────────────────────────
 *   RUN:  node tests/presence_checkin_test.js
 *
 * This feeds the Command Center's "Who's on now" panel. Two things must hold: the panel gets the truth
 * about which screen this is, and a check-in can NEVER affect what a kiosk shows. Executes the real
 * block lifted from index.html against fake timers, storage and client.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };

const start = SRC.indexOf('GC.presence = (function()');
const end = SRC.indexOf('GC.presence.start();', start);
if (start < 0 || end < 0) throw new Error('GC.presence block not found in index.html');
const BLOCK = SRC.slice(start, end);

function world(o) {
  o = o || {};
  const store = Object.assign({}, o.stored || {});
  const w = { calls: [], timeouts: [], intervals: [], store };
  const localStorage = o.noStorage
    ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
    : { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  const client = o.noClient ? null : {
    jsonp(action, params, opts) {
      w.calls.push({ action, params, opts });
      if (o.clientThrows) throw new Error('dev guard');
      return o.clientRejects ? Promise.reject(new Error('timeout')) : Promise.resolve({ ok: true });
    }
  };
  const session = o.session === undefined ? { user: 'kiosk-bend', storeSlug: 'bend' } : o.session;
  const GC = {
    VERSION: 'v1.931',
    gxCore: () => client,
    auth: { load: () => { if (o.loadThrows) throw new Error('corrupt'); return session; } },
  };
  const window = { location: { hash: o.hash === undefined ? '#/store/bend' : o.hash, hostname: o.host || 'greencrosscanna.github.io' } };
  const document = { hidden: !!o.hidden };
  w.P = new Function('GC', 'window', 'document', 'localStorage', 'setTimeout', 'setInterval',
    BLOCK + '\n; return GC.presence;')(GC, window, document, localStorage,
      (f, ms) => { w.timeouts.push({ f, ms }); }, (f, ms) => { w.intervals.push({ f, ms }); });
  return w;
}

console.log('\n1. the check-in says which screen this is');
{
  const w = world(); w.P.ping();
  const c = w.calls[0];
  ok(c.action === 'presence_ping', 'it calls the route GX Core serves');
  ok(c.params.app === 'performance', 'under this app key, which is not "leaderboard"');
  ok(c.params.store === 'bend' && c.params.screen === 'kiosk', 'a store route is that store\'s kiosk');
  ok(c.params.user === 'kiosk-bend', 'with who is signed in');
  ok(c.params.version === '1.931', 'and the version without its v, because the panel adds one');
  ok(c.params.visible === '1', 'a screen in front reads as visible');

  const d = world({ hash: '#/store/river-rd', session: { user: 'sky', storeSlug: '' } }); d.P.ping();
  ok(d.calls[0].params.store === 'river-rd', 'a director on a store kiosk reports that store, not their own');

  const h = world({ hash: '#/director', session: { user: 'sky', storeSlug: '' }, hidden: true }); h.P.ping();
  ok(h.calls[0].params.screen === 'director' && h.calls[0].params.store === '', 'the director screen reports itself, with no store');
  ok(h.calls[0].params.visible === '0', 'and a background tab says so');
}

console.log('\n2. one id per browser, across reloads');
{
  const w = world(); w.P.ping(); w.P.ping();
  const id = w.calls[0].params.cid;
  ok(id.length >= 8, 'long enough for GX Core to accept it');
  ok(/^[A-Za-z0-9_-]+$/.test(id), 'and made only of characters GX Core keeps');
  ok(w.calls[1].params.cid === id, 'the same id on the next check-in');
  ok(world({ stored: { gc_presence_cid: 'kept-from-before' } }).P.cid() === 'kept-from-before', 'and after a reload');
  const n = world({ noStorage: true }); n.P.ping(); n.P.ping();
  ok(n.calls[1].params.cid === n.calls[0].params.cid, 'blocked storage still gives a steady id for this page');
}

console.log('\n3. it can never affect the page');
{
  const none = world({ session: null }); none.P.ping();
  ok(none.calls.length === 0, 'nobody signed in sends nothing');
  let threw = false;
  try {
    world({ noClient: true }).P.ping();
    world({ clientThrows: true }).P.ping();
    world({ clientRejects: true }).P.ping();
    world({ loadThrows: true }).P.ping();
  } catch (e) { threw = true; }
  ok(!threw, 'a missing client, a throwing client, a failed call and a corrupt session all stay silent');
  const r = world(); r.P.ping();
  ok(r.calls[0].opts.retries === 0, 'one try only: a report must not add retries to a loaded GX Core');
}

console.log('\n4. the schedule');
{
  const w = world(); w.P.start();
  ok(w.intervals[0].ms === 300000, 'every 5 minutes, which GX Core\'s 12-minute "on" window depends on');
  ok(w.timeouts[0].ms <= 60000, 'first check-in inside a minute');
  const b = [];
  for (let i = 0; i < 20; i++) { const x = world(); x.P.start(); b.push(x.timeouts[0].ms); }
  ok(new Set(b).size > 1, 'and spread out, so a release reloading every screen does not arrive as one wave');
  const l = world({ host: 'localhost' }); l.P.start();
  ok(l.timeouts.length === 0 && l.intervals.length === 0, 'a local preview never appears as a store screen');
  ok(/GC\.presence\.start\(\);/.test(SRC), 'and the page actually starts it');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
