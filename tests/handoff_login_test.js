#!/usr/bin/env node
/* Opened from a staff-portal tile — handoff_login.   RUN: node tests/handoff_login_test.js
 *
 * GX Core checks the code (greencross-command-center tests/handoff_test.js: expiry, single use,
 * wrong app, grant re-read). What can go wrong HERE:
 *   - asking GX Core for some app other than performance (a code for Inventory would then sign in);
 *   - handing back GX Core's token instead of this app's own, mapped session;
 *   - a refusal that still returns a token, or a person who cannot be placed getting guessed at;
 *   - the frontend letting the hash router see the code, or re-sending a single-use code.
 * Runs the real handoffLogin_ with GX Core and the role/store mapping stubbed. */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, l) => { c ? (pass++, console.log('  PASS  ' + l)) : (fail++, console.log('  FAIL  ' + l)); };
const auth = fs.readFileSync(path.join(__dirname, '..', 'auth.gs'), 'utf8');
const proxy = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function pick(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; }
  return src.slice(i, j + 1);
}
const RE = /var HANDOFF_CODE_RE_ = (\/.*\/);/.exec(auth);
const CODE = 'h1.' + 'Q'.repeat(43);

function run(params, o) {
  o = o || {};
  const st = { fetches: [], refreshed: 0 };
  const UrlFetchApp = { fetch: (url, opts) => {
    st.fetches.push({ url, opts });
    if (o.throws) throw new Error('dns');
    const g = o.core || { ok: true, user: 'tawny', role: 'editor', store: 'river-rd', token: 'CORE:TOKEN:SIG', expiresAt: 'x' };
    return { getContentText: () => (typeof g === 'string' ? g : JSON.stringify(g)) };
  } };
  const gxSessionUsable_ = o.unusable ? () => null
    : g => ({ ok: true, token: 'LOCAL:' + g.user, user: g.user, role: g.role === 'editor' ? 'store_manager' : 'director', storeSlug: 'river', source: 'gxcore' });
  const f = new Function('UrlFetchApp', 'gxSessionUsable_', 'refreshStoreRegistry_', 'Logger', 'GXCORE_EXEC_KEYS_',
    'var HANDOFF_CODE_RE_ = ' + RE[1] + ';\n' + pick(auth, 'handoffLogin_') + '\nreturn handoffLogin_;');
  const h = f(UrlFetchApp, gxSessionUsable_, () => { st.refreshed++; }, { log() {} }, 'https://core.test/exec');
  return { r: h(params), st };
}

console.log('\n1. a good code → this app\'s OWN session, mapped like a password sign-in');
{
  const { r, st } = run({ code: CODE });
  ok(st.fetches.length === 1 && st.fetches[0].url === 'https://core.test/exec', 'GX Core asked once');
  const body = JSON.parse(st.fetches[0].opts.payload);
  ok(body.action === 'handoff_exchange' && body.code === CODE && body.app === 'performance', 'for app=performance, always');
  ok(st.fetches[0].opts.method === 'post', 'in a POST body');
  ok(r.ok && r.token === 'LOCAL:tawny' && r.role === 'store_manager' && r.storeSlug === 'river', 'returns the mapped local session (own token, own role word, own store slug)');
  ok(JSON.stringify(r).indexOf('CORE:TOKEN') < 0, "and GX Core's token is not passed through");
  ok(st.refreshed === 1, 'the live store list is loaded first (doPost skips doGet\'s prelude)');
}

console.log('\n2. refusals carry no token');
{
  const bad = run({ code: 'h1.short' });
  ok(!bad.r.ok && bad.r.code === 'invalid_code' && bad.st.fetches.length === 0, 'a malformed code is refused without asking GX Core');
  const app = run({ code: CODE, app: 'inventory' });
  ok(JSON.parse(app.st.fetches[0].opts.payload).app === 'performance', 'an app named in the request is ignored — still performance');
  for (const c of ['invalid_code', 'code_expired', 'wrong_app', 'session_expired']) {
    const x = run({ code: CODE }, { core: { ok: false, code: c, error: 'nope' } });
    ok(!x.r.ok && x.r.code === c && !x.r.token, 'GX Core says ' + c + ' → refused with that code, no token');
  }
  const na = run({ code: CODE }, { core: { ok: false, code: 'no_access' } });
  ok(!na.r.ok && /access to Leaderboard/.test(na.r.error), 'no_access → the same plain message a password sign-in gives');
  const un = run({ code: CODE }, { unusable: true });
  ok(!un.r.ok && un.r.code === 'core_unusable' && !un.r.token, 'a person who cannot be placed is refused, not guessed at');
  const html_ = run({ code: CODE }, { core: '<html>Drive</html>' });
  ok(!html_.r.ok && !html_.r.token, 'an HTML page instead of JSON → refused');
  const net = run({ code: CODE }, { throws: true });
  ok(!net.r.ok && net.r.code === 'core_unreachable', 'GX Core unreachable → core_unreachable');
}

console.log('\n3. wiring');
{
  ok(/if \(body\.action === 'handoff_login'\) return jsonOut\(handoffLogin_\(body\)\);/.test(proxy), 'doPost routes handoff_login');
  const tag = html.indexOf('gx-theme/gx-handoff.js"></script>');
  const router = html.indexOf('GC.router.init();');
  const run_ = html.indexOf("GXHandoff.run({\n    app: 'performance'");
  ok(tag > 0 && tag < html.indexOf('gx-theme/gx-client.js'), 'gx-handoff.js loads before everything else from gx-theme');
  ok(run_ > 0 && run_ < router, 'the hand-off starts before the hash router');
  ok(/postJSON\('handoff_login', \{ action: 'handoff_login', code: code \},\s*\{ retries: 0/.test(html), 'traded through this backend, never re-sent');
  ok(/save: function \(r\) \{ GC\.auth\.save\(r\); \}/.test(html), 'saved by GC.auth.save, like every sign-in');
}

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
