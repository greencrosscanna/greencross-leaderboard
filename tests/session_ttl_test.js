// ============================================================
//  Sign-ins last 30 days (Sky, 2026-11-23: "my computers are private, 30 days is okay")
//
//  Was 7 days. One server constant, GC_SESSION_TTL_MS in dutchie_proxy.gs, sets every token this
//  app mints AND the expiresAt the browser trusts, so this suite checks both ends with the real
//  code: the shipped .gs files loaded as text, and the real GC.auth block lifted from index.html.
//
//  What must hold:
//    - every path that mints a session (password login, portal handoff's shared translation,
//      heartbeat renew) hands out 30 days, and the token itself is still good on day 29 and dead
//      on day 31 -- the signature check, not just the label
//    - the browser keeps the session in localStorage (survives closing the browser) and does not
//      cut it short with its own clock
//    - kiosks are unchanged: the heartbeat still renews only inside the last 48 hours
//
//  Run:  node tests/session_ttl_test.js
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 23, 18, 0, 0);   // 2026-11-23 10:00 PT
const KEY = 'our-perf-secret';

function hmac(payload, key) {
  return crypto.createHmac('sha256', key).update(payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
}

function build() {
  const props = { GC_PERF_SESSION_SECRET: KEY, GX_DEPLOY_SECRET: 'deploy-secret' };
  return H.load(['dutchie_proxy.gs', 'auth.gs'], {
    stubs: {
      GXCORE_EXEC_KEYS_: 'https://core.example/exec',
      Utilities: {
        computeHmacSha256Signature: function (payload, key) { return hmac(payload, key); },
        base64EncodeWebSafe: function (s) { return s; },
        getUuid: function () { return '00000000-0000-0000-0000-000000000000'; },
        sleep: function () {},
        formatDate: H.formatDate,
      },
      PropertiesService: { getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
          setProperty: function (k, v) { props[k] = String(v); return this; },
        };
      } },
      GXCore: {
        login: function (u) { return { ok: true, user: u, role: 'director', store: '', displayName: 'Sky Pinnick' }; },
        roleForApp: function () { return 'director'; },
        verifySession: function () { return { ok: false, code: 'invalid_session' }; },
        getStores: function () { throw new Error('offline'); },
      },
    },
  });
}

/* The real GC.auth block from index.html, run against fake storage and a fake API. */
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const AUTH_START = SRC.indexOf('GC.auth = (function() {');
const AUTH_END = SRC.indexOf('GC.presence = (function()', AUTH_START);
if (AUTH_START < 0 || AUTH_END < 0) throw new Error('GC.auth block not found in index.html');
const AUTH_BLOCK = SRC.slice(AUTH_START, AUTH_END);

function fakeStorage() {
  const m = {};
  return {
    data: m,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; },
  };
}

function browser(nowMs) {
  const w = { local: fakeStorage(), session: fakeStorage(), renews: [], intervals: [] };
  const GC = { api: { gasCall: function (action, p) {
    w.renews.push({ action: action, params: p });
    return Promise.resolve({ ok: true, token: 'renewed', expiresAt: new Date(nowMs + 30 * DAY).toISOString() });
  } } };
  class FixedDate extends Date {
    constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
    static now() { return nowMs; }
  }
  w.auth = new Function('GC', 'localStorage', 'sessionStorage', 'setInterval', 'clearInterval', 'console', 'Date',
    AUTH_BLOCK + '\n; return GC.auth;')(
    GC, w.local, w.session,
    function (f, ms) { w.intervals.push({ f: f, ms: ms }); return w.intervals.length; },
    function () {},
    { log: function () {}, warn: function () {} },
    FixedDate);
  return w;
}

H.run('session TTL (30 days)', {

  constantIsThirtyDays: function () {
    const A = build();
    _eq_('GC_SESSION_TTL_MS is 30 days', A.GC_SESSION_TTL_MS, 30 * DAY);
  },

  tokenLivesThirtyDays: function () {
    H.setNow(T0);
    const A = build();
    const tok = A.issueSessionToken_('Sky');
    _eq_('the token carries an expiry 30 days out', Number(tok.split(':')[1]), T0 + 30 * DAY);
    H.setNow(T0 + 29 * DAY);
    _eq_('still valid on day 29 (would have died on day 7)', A.validateSessionToken_(tok), { ok: true, user: 'sky' });
    H.setNow(T0 + 31 * DAY);
    _eq_('expired on day 31', A.validateSessionToken_(tok), { ok: false, error: 'Session expired' });
    H.setNow(null);
  },

  loginHandsOutThirtyDays: function () {
    H.setNow(T0);
    const A = build();
    const r = A.loginUser({ user: 'sky', pass: 'x' });
    _eq_('director sign-in succeeds', r.ok, true);
    _eq_('expiresAt the browser stores is 30 days out', r.expiresAt, new Date(T0 + 30 * DAY).toISOString());
    _eq_('and the token agrees with it', Number(r.token.split(':')[1]), T0 + 30 * DAY);
    H.setNow(null);
  },

  renewHandsOutThirtyDays: function () {
    H.setNow(T0);
    const A = build();
    const r = A.renewSession_({ ok: true, user: 'sky' });
    _eq_('renew succeeds', r.ok, true);
    _eq_('renewed expiresAt is 30 days out', r.expiresAt, new Date(T0 + 30 * DAY).toISOString());
    H.setNow(null);
  },

  browserKeepsSessionInLocalStorage: function () {
    const w = browser(T0);
    w.auth.save({ token: 't', user: 'sky', role: 'director', expiresAt: new Date(T0 + 30 * DAY).toISOString() });
    _ok_('saved to localStorage (survives closing the browser)', w.local.getItem('GC_PERF_SESSION') !== null);
    _eq_('nothing written to sessionStorage', Object.keys(w.session.data), []);
    w.auth.clear();
    _eq_('sign-out removes it', w.local.getItem('GC_PERF_SESSION'), null);
  },

  browserHasNoShorterCap: function () {
    const exp = new Date(T0 + 30 * DAY).toISOString();
    const late = browser(T0 + 29 * DAY);
    late.local.setItem('GC_PERF_SESSION', JSON.stringify({ token: 't', user: 'sky', role: 'director', expiresAt: exp }));
    _ok_('a session on day 29 still loads in the browser', late.auth.load() !== null);
    _eq_('and still routes the director home', late.auth.homeRoute(), '#/director');

    const past = browser(T0 + 31 * DAY);
    past.local.setItem('GC_PERF_SESSION', JSON.stringify({ token: 't', user: 'sky', role: 'director', expiresAt: exp }));
    _eq_('past the server expiry it is dropped', past.auth.load(), null);
    _eq_('and cleared from storage', past.local.getItem('GC_PERF_SESSION'), null);

    _ok_('no leftover 7-day constant anywhere in index.html', SRC.indexOf('7 * 24 * 60 * 60') === -1);
  },

  kioskHeartbeatUnchanged: function () {
    const exp = T0 + 30 * DAY;
    const fresh = browser(T0);
    fresh.local.setItem('GC_PERF_SESSION', JSON.stringify({ token: 't', user: 'kiosk', role: 'budtender', storeSlug: 'baseline', expiresAt: new Date(exp).toISOString() }));
    fresh.auth.startHeartbeat();
    _eq_('heartbeat still ticks every 6 hours', fresh.intervals[0].ms, 6 * 60 * 60 * 1000);
    fresh.intervals[0].f();
    _eq_('no renew with 30 days left', fresh.renews.length, 0);

    const near = browser(exp - 47 * 60 * 60 * 1000);
    near.local.setItem('GC_PERF_SESSION', JSON.stringify({ token: 't', user: 'kiosk', role: 'budtender', storeSlug: 'baseline', expiresAt: new Date(exp).toISOString() }));
    near.auth.startHeartbeat();
    near.intervals[0].f();
    _eq_('renews inside the last 48 hours, as before', near.renews.length, 1);
    _eq_('through the renew route', near.renews[0] && near.renews[0].action, 'renew');
  },
});
