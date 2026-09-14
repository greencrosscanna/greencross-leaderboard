// ============================================================
//  auth.gs — shared sign-in: Core-signed sessions, and the local-password fallback
//
//  Two holes closed on 2026-09-14, both about the second password list this app keeps:
//
//    1. A GX Core token was rejected outright ("Invalid session"), because this app signs with
//       its OWN key. So the suite's read-only dev session could not open Leaderboard at all.
//       It is now accepted -- and must stay NARROW: read-only unless Core says canEdit, no store
//       routes for a manager nothing here can place, and never renewable into a 7-day token of ours.
//
//    2. When GX Core REFUSED a sign-in, the local list was consulted anyway, so someone removed
//       in the Command Center still got in on an old password. That is now recorded
//       (cfg.lbLoginFallback = observe) and refused once flipped to enforce. An OUTAGE must still
//       fall back in both modes, or a Core hiccup locks the floor out at open.
//
//  Run:  node tests/shared_signin_test.js
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

const OUR_KEY  = 'our-perf-secret';
const CORE_KEY = 'shared-core-secret';

function hmac(payload, key) {
  return crypto.createHmac('sha256', key).update(payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
}
function tokenFor(user, key, expMs) {
  const exp = expMs || (Date.now() + 3600 * 1000);
  return user + ':' + exp + ':' + hmac(user + ':' + exp, key);
}
function sha256Bytes(s) { return Array.from(crypto.createHash('sha256').update(String(s)).digest()).map(b => (b > 127 ? b - 256 : b)); }
function hashHex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

let props, cache, core, logs;

function build(opts) {
  opts = opts || {};
  props = Object.assign({
    GC_PERF_SESSION_SECRET: OUR_KEY,
    gc_perf_users: JSON.stringify({
      dean: { passHash: hashHex('local-pass'), role: 'store_manager', storeSlug: 'baseline', displayName: 'Dean' },
      sky:  { passHash: hashHex('sky-pass'),   role: 'owner', displayName: 'Sky' },
    }),
  }, opts.props || {});
  cache = {};
  logs = [];
  core = Object.assign({
    kv: {},                        // cfg.* values
    kvThrows: false,
    login: null,                   // function(user, pass, app) or null
    verify: function (token, app) {
      const parts = String(token).split(':');
      if (parts.length !== 3 || parts[2] !== hmac(parts[0] + ':' + parts[1], CORE_KEY)) {
        return { ok: false, error: 'Invalid session', code: 'invalid_session' };
      }
      const role = ({ 'gx-dev': 'viewer', mike: 'director', tj: 'editor', odd: 'constructor', gone: null })[parts[0]];
      if (!role) return { ok: false, error: 'No access to ' + app, code: 'no_access', user: parts[0] };
      return { ok: true, user: parts[0], app: app, role: role, canEdit: role !== 'viewer' };
    },
    roleForApp: function (u) { return u === 'gx-dev' ? 'viewer' : 'director'; },
  }, opts.core || {});

  return H.load(['dutchie_proxy.gs', 'auth.gs'], {
    stubs: {
      Logger: { log: function (m) { logs.push(String(m)); } },
      Utilities: Object.assign({}, {
        computeHmacSha256Signature: function (payload, key) { return hmac(payload, key); },
        base64EncodeWebSafe: function (s) { return s; },   // hmac() already returns web-safe base64
        computeDigest: function (_, s) { return sha256Bytes(s); },
        DigestAlgorithm: { SHA_256: 'SHA_256' },
        getUuid: function () { return '00000000-0000-0000-0000-000000000000'; },
        formatDate: function () { return ''; },
      }),
      PropertiesService: { getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
          setProperty: function (k, v) { props[k] = String(v); return this; },
        };
      } },
      CacheService: { getScriptCache: function () {
        return {
          get: function (k) { return Object.prototype.hasOwnProperty.call(cache, k) ? cache[k] : null; },
          put: function (k, v) { cache[k] = v; },
        };
      } },
      GXCore: {
        verifySession: function (t, a) { return core.verify(t, a); },
        roleForApp: function (u, a) { return core.roleForApp(u, a); },
        getKv: function (k) { if (core.kvThrows) throw new Error('Core unreachable'); return core.kv[k]; },
        login: function (u, p, a) { return core.login(u, p, a); },
        getStores: function () { throw new Error('offline'); },
      },
    },
  });
}

H.run('shared sign-in', {

  // ── 1. Core-signed sessions ─────────────────────────────────
  ourTokenUnchanged: function () {
    const A = build();
    const r = A.validateSessionToken_(tokenFor('dean', OUR_KEY));
    _eq_('our own token still verifies, without touching Core', r, { ok: true, user: 'dean' });
  },

  coreViewerAcceptedReadOnly: function () {
    const A = build();
    const r = A.validateSessionToken_(tokenFor('gx-dev', CORE_KEY));
    _eq_('Core-signed dev viewer is accepted', r.ok, true);
    _eq_('marked as Core-signed', r.via, 'gxcore');
    _eq_('viewer maps to budtender, never director', r.role, 'budtender');
    _eq_('viewer cannot edit', r.canEdit, false);
  },

  forgedTokenRefused: function () {
    const A = build();
    _eq_('a token signed with neither key is refused',
      A.validateSessionToken_(tokenFor('mike', 'attacker-key')), { ok: false, error: 'Invalid session' });
  },

  coreUnreachableRefuses: function () {
    const A = build({ core: { verify: function () { throw new Error('Core down'); } } });
    _eq_('Core throwing never admits a foreign token',
      A.validateSessionToken_(tokenFor('gx-dev', CORE_KEY)), { ok: false, error: 'Invalid session' });
  },

  revokedCoreUserRefused: function () {
    const A = build();
    const r = A.validateSessionToken_(tokenFor('gone', CORE_KEY));
    _eq_('a Core token for a revoked user fails on the request itself', r.ok, false);
    _eq_('with Core\'s no_access code', r.code, 'no_access');
  },

  unmappedCoreRoleRefused: function () {
    const A = build();
    _eq_('a role this app cannot translate (even an inherited key) is refused',
      A.validateSessionToken_(tokenFor('odd', CORE_KEY)).ok, false);
  },

  roleComesFromCoreNotLocalList: function () {
    const A = build();
    const viewer = A.validateSessionToken_(tokenFor('gx-dev', CORE_KEY));
    let threw = null;
    try { A.requireRole_(viewer, ['owner', 'director']); } catch (e) { threw = e.message; }
    _eq_('viewer refused director routes', threw, 'Insufficient permissions');

    const dir = A.validateSessionToken_(tokenFor('mike', CORE_KEY));
    threw = null;
    try { A.requireRole_(dir, ['owner', 'director']); } catch (e) { threw = e.message; }
    _eq_('Core director admitted with NO local roster row (was "User not found")', threw, null);
  },

  coreManagerRefusedStoreRoutes: function () {
    const A = build();
    const mgr = A.validateSessionToken_(tokenFor('tj', CORE_KEY));
    _eq_('editor maps to store_manager', mgr.role, 'store_manager');
    let threw = null;
    try { A.requireStore_(mgr, 'river'); } catch (e) { threw = e.message; }
    _eq_('a manager nothing here can place gets no store at all, not every store', threw, 'Access denied for store: river');

    const viewer = A.validateSessionToken_(tokenFor('gx-dev', CORE_KEY));
    threw = null;
    try { A.requireStore_(viewer, 'river'); } catch (e) { threw = e.message; }
    _eq_('viewer reads a kiosk, as a local budtender does', threw, null);
  },

  coreViewerCannotWriteEvenWithAGrant: function () {
    const A = build({ core: { kv: { 'cfg.lbWriteGrantCheck': 'off' } } });
    const viewer = A.validateSessionToken_(tokenFor('gx-dev', CORE_KEY));
    const r = A.gxCheckWriteGrant_(viewer, 'savesettings');
    _eq_('write refused although roleForApp returns a grant and the check is in dry run', r.ok, false);
    _eq_('refused as read_only', r.code, 'read_only');

    const dir = A.validateSessionToken_(tokenFor('mike', CORE_KEY));
    _eq_('a Core director with canEdit still writes', A.gxCheckWriteGrant_(dir, 'savesettings').ok, true);
  },

  renewRefusesCoreSessions: function () {
    const A = build();
    const r = A.renewSession_(A.validateSessionToken_(tokenFor('gx-dev', CORE_KEY)));
    _eq_('a Core-signed session is never renewed into a token of ours', r.code, 'not_renewable');
    _eq_('and no token comes back', r.token, undefined);
    const src = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');
    const at = src.indexOf("params.action === 'renew'");
    _ok_('the renew route goes through renewSession_, not a token minted inline',
      src.slice(at, at + 600).indexOf('renewSession_(auth)') > 0 && src.slice(at, at + 600).indexOf('issueSessionToken_') === -1);
  },

  // ── 1b. Renewal re-checks the grant ─────────────────────────
  renewWhileGranted: function () {
    const A = build({ core: { roleForApp: function (u) { return u === 'dean' ? 'editor' : null; } } });
    const r = A.renewSession_(A.validateSessionToken_(tokenFor('dean', OUR_KEY)));
    _eq_('still granted: renewed', r.ok, true);
    _ok_('with a fresh token of ours that verifies', A.validateSessionToken_(r.token).ok === true);
  },

  renewRefusedOnceRemoved: function () {
    const A = build({ core: { roleForApp: function () { return null; } } });
    const r = A.renewSession_(A.validateSessionToken_(tokenFor('dean', OUR_KEY)));
    _eq_('removed in the Command Center: renewal refused', r.ok, false);
    _eq_('as no_access', r.code, 'no_access');
    _eq_('no token handed out', r.token, undefined);
  },

  renewSurvivesACoreBounce: function () {
    const A = build({ core: { roleForApp: function () { throw new Error('GX Core unreachable'); } } });
    const r = A.renewSession_(A.validateSessionToken_(tokenFor('dean', OUR_KEY)));
    _eq_('Core throwing: renewed anyway, so a wall screen is not signed out by a hiccup', r.ok, true);
  },

  renewNeedsAValidSession: function () {
    const A = build();
    _eq_('an invalid session renews nothing', A.renewSession_({ ok: false, error: 'Session expired' }),
      { ok: false, error: 'Session expired' });
  },

  // ── 2. The local-password fallback ──────────────────────────
  coreOkUsesCore: function () {
    const A = build({ core: { login: function () {
      return { ok: true, user: 'dean', role: 'editor', store: 'hillsboro', displayName: 'Dean' };
    } } });
    const r = A.loginUser({ user: 'dean', pass: 'core-pass' });
    _eq_('Core sign-in used when it translates', r.source, 'gxcore');
    _eq_('recorded as a Core sign-in', JSON.parse(props.GC_LOGIN_PATH_TALLY).gxcore, 1);
  },

  refusalObservedByDefault: function () {
    const A = build({ core: { login: function () { return { ok: false, code: 'bad_credentials' }; } } });
    const r = A.loginUser({ user: 'dean', pass: 'local-pass' });
    _eq_('observe (the default): old behavior, local password still admits', r.ok, true);
    const audit = A.gxLoginFallbackAudit_();
    _eq_('audit reports observe mode', audit.mode, 'observe');
    _eq_('and names who the flip would lock out', audit.wouldRefuse.map(x => x.user + '/' + x.core_code), ['dean/bad_credentials']);
    _eq_('so it is NOT safe to enforce', audit.safeToEnforce, false);
  },

  refusalEnforced: function () {
    const A = build({ core: { kv: { 'cfg.lbLoginFallback': 'enforce' },
                              login: function () { return { ok: false, code: 'no_access' }; } } });
    const r = A.loginUser({ user: 'dean', pass: 'local-pass' });
    _eq_('enforce: a Core refusal is final, the old local password no longer admits', r.ok, false);
    _eq_('with the reason that tells them what to do', r.code, 'no_access');
    _eq_('no token handed out', r.token, undefined);
    _eq_('recorded as refused, not as a would-refuse', A.gxLoginFallbackAudit_().refused.map(x => x.user), ['dean']);
  },

  outageStillFallsBackWhenEnforcing: function () {
    const A = build({ props: { GC_LOGIN_FALLBACK_MODE_LAST: 'enforce' },
                      core: { kv: { 'cfg.lbLoginFallback': 'enforce' },
                              login: function () { throw new Error('GX Core unreachable'); } } });
    const r = A.loginUser({ user: 'dean', pass: 'local-pass' });
    _eq_('Core THROWING is an outage: local still signs the floor in', r.ok, true);
    _eq_('recorded as unreachable', JSON.parse(props.GC_LOGIN_PATH_TALLY).local_core_unreachable, 1);
  },

  unreadableSettingHoldsEnforce: function () {
    const A = build({ props: { GC_LOGIN_FALLBACK_MODE_LAST: 'enforce' },
                      core: { kvThrows: true, login: function () { return { ok: false, code: 'bad_credentials' }; } } });
    _eq_('an unreadable setting holds the last KNOWN mode, never relaxes to observe',
      A.loginUser({ user: 'dean', pass: 'local-pass' }).ok, false);
  },

  bothRefuseUnchanged: function () {
    const A = build({ core: { login: function () { return { ok: false, code: 'bad_credentials' }; } } });
    const r = A.loginUser({ user: 'dean', pass: 'wrong' });
    _eq_('both lists say no: same answer as before', r, { ok: false, error: 'Invalid username or password' });
    _eq_('and nothing recorded as a would-refuse', props.GC_LOGIN_WOULD_REFUSE, undefined);
  },
});
