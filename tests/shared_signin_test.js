// ============================================================
//  auth.gs — shared sign-in: Core-signed sessions, Core-only sign-in, and the GX Core roster
//
//  Two holes closed on 2026-09-14, both about the second password list this app kept:
//
//    1. A GX Core token was rejected outright ("Invalid session"), because this app signs with
//       its OWN key. So the suite's read-only dev session could not open Leaderboard at all.
//       It is now accepted -- and must stay NARROW: read-only unless Core says canEdit, no store
//       routes for a manager nothing here can place, and never renewable into a 7-day token of ours.
//
//    2. When GX Core REFUSED a sign-in, the local list was consulted anyway, so someone removed
//       in the Command Center still got in on an old password. That is now recorded
//       (cfg.lbLoginFallback = observe) and refused once flipped to enforce.
//
//  Then on 2026-09-15 the list itself was retired. Sign-in is GX Core only, and a signed-in person's
//  role and store come from GX Core's app_roster (lbCoreRoster_), with the last roster fetched
//  standing in during an outage so people already signed in keep working.
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

let props, cache, core, logs, fetches;

/* GX Core's app_roster answer for performance, in the shape gxAppRoster_ returns. */
const ROSTER = {
  ok: true, app: 'performance',
  grants: [
    { user_id: 'mike', role: 'director', store: '', displayName: 'Mike Kettler' },
    { user_id: 'dean', role: 'editor', store: 'hillsboro', displayName: 'Dean Deloof' },
    { user_id: 'tj',   role: 'editor', store: 'river-rd', displayName: 'TJ Peterson' },
    { user_id: 'sky',  role: 'editor', store: 'hillsboro', displayName: 'Sky Pinnick' },
    { user_id: 'odd',  role: 'constructor', store: '', displayName: 'Odd' },
  ],
  superadmins: [{ user_id: 'sky', role: 'admin(superadmin)', store: '' }],
};

function build(opts) {
  opts = opts || {};
  props = Object.assign({
    GC_PERF_SESSION_SECRET: OUR_KEY,
    GX_DEPLOY_SECRET: 'deploy-secret',
  }, opts.props || {});
  cache = {};
  logs = [];
  fetches = [];
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
    roster: function () { return JSON.stringify(ROSTER); },   // app_roster body, or throw for an outage
  }, opts.core || {});

  return H.load(['dutchie_proxy.gs', 'auth.gs'], {
    stubs: {
      GXCORE_EXEC_KEYS_: 'https://core.example/exec',
      UrlFetchApp: { fetch: function (url) {
        fetches.push(url);
        const body = core.roster(url);
        return { getContentText: function () { return body; }, getResponseCode: function () { return 200; } };
      } },
      Logger: { log: function (m) { logs.push(String(m)); } },
      Utilities: Object.assign({}, {
        computeHmacSha256Signature: function (payload, key) { return hmac(payload, key); },
        base64EncodeWebSafe: function (s) { return s; },   // hmac() already returns web-safe base64
        computeDigest: function (_, s) { return sha256Bytes(s); },
        DigestAlgorithm: { SHA_256: 'SHA_256' },
        getUuid: function () { return '00000000-0000-0000-0000-000000000000'; },
        sleep: function () {},
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

  // ── 2. Sign-in is GX Core only ──────────────────────────────
  coreOkUsesCore: function () {
    const A = build({ core: { login: function () {
      return { ok: true, user: 'dean', role: 'editor', store: 'hillsboro', displayName: 'Dean' };
    } } });
    const r = A.loginUser({ user: 'dean', pass: 'core-pass' });
    _eq_('Core sign-in used when it translates', r.source, 'gxcore');
    _eq_('placed on his GX Core home store, in this app\'s slug', r.storeSlug, 'baseline');
    _ok_('with a token of ours that verifies', A.validateSessionToken_(r.token).ok === true);
  },

  coreRefusalIsFinal: function () {
    const A = build({ core: { login: function () { return { ok: false, code: 'bad_credentials' }; } } });
    const r = A.loginUser({ user: 'dean', pass: 'old-local-pass' });
    _eq_('Core says no: there is no second list to ask', r, { ok: false, error: 'Invalid username or password', code: 'bad_credentials' });
  },

  removedPersonToldWhy: function () {
    const A = build({ core: { login: function () { return { ok: false, code: 'no_access' }; } } });
    const r = A.loginUser({ user: 'dean', pass: 'right-pass' });
    _eq_('a removed person is refused', r.ok, false);
    _eq_('with the reason that tells them what to do', r.error, 'Your access to Leaderboard has been removed. Ask Sky to restore it.');
    _eq_('no token handed out', r.token, undefined);
  },

  outageRefusesWithAReason: function () {
    const A = build({ core: { login: function () { throw new Error('GX Core unreachable'); } } });
    const r = A.loginUser({ user: 'dean', pass: 'anything' });
    _eq_('Core down: sign-in refused, not waved through', r.ok, false);
    _eq_('as core_unreachable, so the screen can say "try again"', r.code, 'core_unreachable');
  },

  unplaceableManagerRefused: function () {
    const A = build({ core: { login: function () { return { ok: true, user: 'dean', role: 'editor', store: '' }; } } });
    const r = A.loginUser({ user: 'dean', pass: 'core-pass' });
    _eq_('a manager with no home store is refused rather than sent to Baseline', r.ok, false);
    _eq_('as core_unusable', r.code, 'core_unusable');
  },

  noLocalListLeft: function () {
    const src = ['auth.gs', 'dutchie_proxy.gs', 'endpoints.gs']
      .map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
    _ok_('nothing reads the retired gc_perf_users property',
      !/getProperty\(\s*(GC_USERS_KEY|'gc_perf_users')/.test(src) && !/GC_USERS_KEY\s*=/.test(src));
    _ok_('and no local password check survives', !/_loginUserLocal_|passHash/.test(src));
  },

  // ── 3. Role and store come from GX Core's roster ─────────────
  rosterGivesRoleAndStore: function () {
    const A = build();
    const dean = A.validateSessionToken_(tokenFor('dean', OUR_KEY));
    let threw = null;
    try { A.requireRole_(dean, ['owner', 'director']); } catch (e) { threw = e.message; }
    _eq_('an editor is not a director', threw, 'Insufficient permissions');
    threw = null;
    try { A.requireRole_(dean, ['owner', 'director', 'store_manager', 'asst_manager']); } catch (e) { threw = e.message; }
    _eq_('an editor is a store manager', threw, null);
    threw = null;
    try { A.requireStore_(dean, 'baseline'); } catch (e) { threw = e.message; }
    _eq_('his own store opens', threw, null);
    threw = null;
    try { A.requireStore_(dean, 'river'); } catch (e) { threw = e.message; }
    _eq_('another store does not', threw, 'Access denied for store: river');
    _ok_('the roster was asked for with the deploy secret', /action=app_roster&app=performance&secret=deploy-secret/.test(fetches[0]));
  },

  directorGetsEveryStore: function () {
    const A = build();
    const mike = A.validateSessionToken_(tokenFor('mike', OUR_KEY));
    let threw = null;
    try { A.requireRole_(mike, ['owner', 'director']); A.requireStore_(mike, 'river'); } catch (e) { threw = e.message; }
    _eq_('director: director routes and any store', threw, null);
  },

  superadminIsDirectorWhateverTheGrant: function () {
    const A = build();
    const sky = A.validateSessionToken_(tokenFor('sky', OUR_KEY));
    let threw = null;
    try { A.requireRole_(sky, ['owner', 'director']); } catch (e) { threw = e.message; }
    _eq_('a superadmin whose grant row says editor still gets director routes (Core resolves admin first)', threw, null);
  },

  removedPersonRefusedOnReads: function () {
    const A = build();
    const gone = A.validateSessionToken_(tokenFor('gone', OUR_KEY));
    let threw = null;
    try { A.requireRole_(gone, ['owner', 'director', 'store_manager', 'asst_manager']); } catch (e) { threw = e.message; }
    _eq_('a valid token for someone GX Core no longer lists is refused', threw, 'User not found');
    threw = null;
    try { A.requireStore_(gone, 'baseline'); } catch (e) { threw = e.message; }
    _eq_('including on store routes, which the old list let an unknown user through', threw, 'Access denied for store: baseline');
  },

  unmappedRoleDropped: function () {
    const A = build();
    _eq_('a grant role this app cannot translate (even an inherited key) puts nobody on the roster',
      A.lbRosterUser_('odd'), null);
  },

  rosterIsCached: function () {
    const A = build();
    A.lbRosterUser_('dean'); A.lbRosterUser_('mike'); A.lbRosterUser_('tj');
    _eq_('one GX Core read serves every lookup inside the cache window', fetches.length, 1);
  },

  outageUsesLastRoster: function () {
    const A = build();
    A.lbRosterUser_('dean');                         // a good read, remembered
    cache = {};                                      // cache expired
    core.roster = function () { throw new Error('GX Core unreachable'); };
    _eq_('Core down: the last roster still places a signed-in manager', A.lbRosterUser_('dean').storeSlug, 'baseline');
    _eq_('and the fallback is cached briefly, not re-fetched per request', (A.lbRosterUser_('mike') || {}).role, 'director');
    _ok_('retried a few times, then held', fetches.length <= 4);
  },

  badReadDoesNotOverwriteGoodRoster: function () {
    const A = build();
    A.lbRosterUser_('dean');
    cache = {};
    core.roster = function () { return JSON.stringify({ ok: true, grants: [], superadmins: [] }); };
    _eq_('an EMPTY roster is treated as a bad read, so nobody is locked out by it', (A.lbRosterUser_('dean') || {}).role, 'store_manager');
    cache = {};
    core.roster = function () { return '<!DOCTYPE html>'; };
    _eq_('nor is the /exec HTML flake', (A.lbRosterUser_('dean') || {}).role, 'store_manager');
  },

  noRosterEverFailsClosed: function () {
    const A = build({ core: { roster: function () { throw new Error('GX Core unreachable'); } } });
    let threw = null;
    try { A.requireRole_(A.validateSessionToken_(tokenFor('mike', OUR_KEY)), ['owner', 'director']); } catch (e) { threw = e.message; }
    _ok_('no roster ever fetched and Core down: the role check refuses rather than guessing', /could not be reached/.test(threw || ''));
  },

  managerNamesComeFromRoster: function () {
    const A = build();
    const names = A.lbRosterList_().filter(u => u.role === 'store_manager').map(u => u.displayName + '@' + u.storeSlug).sort();
    _eq_('store managers by home store, for the director and standings views', names, ['Dean Deloof@baseline', 'TJ Peterson@river']);
    core.roster = function () { throw new Error('down'); };
    cache = {}; props = { GC_PERF_SESSION_SECRET: OUR_KEY, GX_DEPLOY_SECRET: 'deploy-secret' };
    _eq_('a display lookup never throws, it just has no names', A.lbRosterList_(), []);
  },
});
