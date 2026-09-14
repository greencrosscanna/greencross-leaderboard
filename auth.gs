// ============================================================
//  Green Cross — Auth & Session  (auth.gs)
//  Session tokens, password hashing, role enforcement.
//  All functions are pure request-handlers — no side effects
//  beyond reading/writing ScriptProperties via getProps_().
// ============================================================

function sessionSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty(GC_SESSION_SECRET_KEY);
  if (!secret) {
    secret = Utilities.getUuid() + ':' + Utilities.getUuid();
    props.setProperty(GC_SESSION_SECRET_KEY, secret);
  }
  return secret;
}

function hashPass_(pass) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pass));
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function signSession_(payload) {
  const sig = Utilities.computeHmacSha256Signature(payload, sessionSecret_());
  return Utilities.base64EncodeWebSafe(sig);
}

function issueSessionToken_(user) {
  const exp = Date.now() + GC_SESSION_TTL_MS;
  const payload = [String(user).toLowerCase().trim(), exp].join(':');
  return payload + ':' + signSession_(payload);
}

function validateSessionToken_(token) {
  if (!token) return { ok: false, error: 'Auth required' };
  const parts = String(token).split(':');
  if (parts.length !== 3) return { ok: false, error: 'Invalid session' };
  const [user, expStr, sig] = parts;
  const exp = Number(expStr || 0);
  if (!user || !exp || Date.now() > exp) return { ok: false, error: 'Session expired' };
  const payload = user + ':' + exp;
  if (sig !== signSession_(payload)) return gxCoreSignedSession_(token);
  return { ok: true, user: user };
}

/**
 * A token that did not verify with OUR key may still be a GX Core token, signed with the shared
 * GC_SESSION_SECRET. Same user:exp:sig shape; only the key differs.
 *
 * WHY. Leaderboard signs with GC_PERF_SESSION_SECRET, a key no other project holds, so every
 * Core-minted session -- including `gxdevlogin.sh`'s read-only dev viewer -- failed here with
 * "Invalid session", and Leaderboard was the one app nobody could check signed in. Accepting BOTH
 * keys fixes that without re-keying: every existing kiosk and director token is ours and still
 * verifies on the line above, so nobody is signed out.
 *
 * WHAT THE CORE PATH IS ALLOWED. verifySession re-checks the GRANT, not just the signature, so a
 * revoked user fails here on the very next request (our own tokens only re-check on writes). The
 * Core role is translated with the same own-key map login uses; an unmapped role is refused. The
 * session carries `via: 'gxcore'`, which requireRole_ / requireStore_ / the write chokepoint / renew
 * all read:
 *   - no local-roster lookup: the role comes from Core, never from gc_perf_users
 *   - a Core store_manager is REFUSED store routes: nothing here can place them on a store, and a
 *     guess puts a manager on another shop's numbers
 *   - writes need Core's canEdit, so the viewer stays read-only whatever the write-grant mode says
 *   - renew is refused, so a 2-hour dev session cannot be exchanged for a 7-day token of ours
 *
 * Only reached when OUR signature fails, so a normal request never pays for the library call.
 */
function gxCoreSignedSession_(token) {
  var refused = { ok: false, error: 'Invalid session' };
  var v;
  try {
    if (typeof GXCore === 'undefined' || !GXCore || typeof GXCore.verifySession !== 'function') return refused;
    v = GXCore.verifySession(String(token), 'performance');
  } catch (e) {
    return refused;
  }
  if (!v || !v.ok) {
    // Forward Core's reason only where it changes what the person should do; otherwise keep ours.
    if (v && (v.code === 'session_expired' || v.code === 'no_access')) {
      return { ok: false, error: v.code === 'no_access' ? 'Access revoked' : 'Session expired', code: v.code };
    }
    return refused;
  }
  var role = own_(GX_ROLE_TO_LOCAL, String(v.role || '').toLowerCase());
  if (!role) return refused;
  return { ok: true, user: String(v.user || '').toLowerCase(), via: 'gxcore', role: role, canEdit: v.canEdit === true };
}

function requireAuth_(params) {
  return validateSessionToken_(params.token || params.session || params.auth || '');
}

function requireRole_(auth, allowedRoles) {
  if (auth && auth.via === 'gxcore') {
    if (!allowedRoles.includes(auth.role)) throw new Error('Insufficient permissions');
    return;
  }
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  const u = users[auth.user];
  if (!u) throw new Error('User not found');
  if (!allowedRoles.includes(u.role)) {
    throw new Error('Insufficient permissions');
  }
}

function requireStore_(auth, slug) {
  const store = STORES.find(s => s.slug === slug);
  if (!store) throw new Error('Unknown store: ' + slug);

  // A Core-signed session has no local roster row to place a manager on a store, so refuse rather
  // than hand them every shop. Directors and viewers pass, exactly as they do on the local path.
  if (auth && auth.via === 'gxcore') {
    if (auth.role === 'store_manager' || auth.role === 'asst_manager') {
      throw new Error('Access denied for store: ' + slug);
    }
    return store;
  }

  // Directors can access all stores; store_manager can only access their own
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  const u = users[auth.user];
  if (u && u.role === 'store_manager' && u.storeSlug !== slug) {
    throw new Error('Access denied for store: ' + slug);
  }
  return store;
}

// Owner-only roster of the local user store — no password hashes. Answers "what users do I have"
// and lets us diff the local store against GX Core before the shared-login migration.
function listUsers_() {
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  const out = Object.keys(users).sort().map(function(k) {
    const u = users[k] || {};
    return {
      user_id:     k,
      displayName: u.displayName || '',
      role:        u.role || '',
      storeSlug:   u.storeSlug || '',
      storeName:   u.storeName || '',
      initials:    u.initials || '',
    };
  });
  return { ok: true, count: out.length, users: out };
}

/**
 * Shared sign-on, the same shape Sales already uses: try GX Core first, fall back to this app's own
 * user store so a GX Core hiccup can never lock the floor out at open.
 *
 * WHY GX CORE IS NOT SIMPLY TRUSTED
 * Its vocabulary is not this app's. `login` returns the app_access role ('director' / 'editor') and
 * `store` from users.default_store, a GX Core store_id. This app switches on 'owner' /
 * 'store_manager' / 'budtender' and routes on ITS OWN historical slugs (hillsboro is 'baseline',
 * bend is 'century'). Two ways that goes wrong, both silent:
 *   - an unmapped role falls through homeRoute()'s default to '#/director', putting a store manager
 *     on the all-stores view
 *   - an empty or unmapped store makes homeRoute() fall back to 'baseline', sending every manager to
 *     the wrong shop's kiosk
 * When this was written (2026-08) all ten performance grants had default_store empty, so every store
 * manager would have landed somewhere wrong. Hence gxSessionUsable_: a GX Core result is only accepted
 * when it translates cleanly, and anything else falls back to local.
 * *Corrected 2026-09-14:* GX Core's app_roster now shows all ten grants resolving -- four directors,
 * six editors each with a default_store that maps here -- so the fallback is no longer needed by
 * anyone. What remains is the fallback on a REFUSAL, handled by gxLocalAfterCoreRefusal_ below.
 *
 * Directors need no store, so they move to shared sign-on now. Managers follow automatically once
 * users.default_store is filled in on the GX Core side -- no code change needed here.
 */
function loginUser(params) {
  if (!params.user || !params.pass) {
    return { ok: false, error: 'Missing credentials' };
  }

  var coreRefusal = null, path = 'local_core_unreachable';
  try {
    if (typeof GXCore !== 'undefined' && GXCore && GXCore.login) {
      var g = GXCore.login(params.user, params.pass, 'performance');
      if (g && g.ok) {
        var mapped = gxSessionUsable_(g);
        if (mapped) {
          Logger.log('[login] ' + mapped.user + ' via GX CORE (role=' + mapped.role +
                     ', store=' + (mapped.storeSlug || 'all') + ')');
          gxRecordLoginPath_('gxcore', mapped.user, '');
          return mapped;
        }
        Logger.log('[login] ' + params.user + ' authenticated in GX Core but the session was not ' +
                   'usable here (role=' + g.role + ', store="' + (g.store || '') + '") — using local');
        path = 'local_core_unusable';
      } else if (g) {
        coreRefusal = g;   // Core ANSWERED no. That is a decision, not an outage.
      }
    }
  } catch (e) {
    Logger.log('[login/GXCore] ' + (e && e.message || e));   // never block sign-in on a Core problem
  }
  if (coreRefusal) return gxLocalAfterCoreRefusal_(params, coreRefusal);
  var local = _loginUserLocal_(params);
  if (local.ok) gxRecordLoginPath_(path, local.user, '');
  return local;
}

/**
 * GX Core said NO, and the local password list might still say yes.
 *
 * THE HOLE. Until 2026-09-14 this fell straight through to _loginUserLocal_, so the local list was
 * consulted on ANY refusal, not only when Core was down. Someone removed in the Command Center, or
 * whose password was changed there, still signed in with the old local password -- for up to 7
 * days of reads, since only writes re-check the grant.
 *
 * WHY IT RECORDS BEFORE IT REFUSES. The local list and Core are two copies of a password that were
 * never kept in sync. A manager whose two passwords differ has been signing in on the LOCAL one
 * without knowing it, and refusing blind would lock them out at open. So cfg.lbLoginFallback starts
 * at 'observe': the old behavior, plus a record of exactly who would have been refused and why
 * (?action=loginfallbackaudit). Flip it to 'enforce' from the Command Center once that record is
 * clean -- the same evidence-first rollout as cfg.lbWriteGrantCheck.
 *
 * An OUTAGE still falls back in both modes: Core throwing never reaches this function.
 */
function gxLocalAfterCoreRefusal_(params, coreRefusal) {
  var local = _loginUserLocal_(params);
  if (!local.ok) return local;   // both said no: unchanged from before

  var code = String(coreRefusal.code || '');
  var enforcing = gxLoginFallbackMode_() === 'enforce';
  gxRecordLoginPath_(enforcing ? 'refused_after_core_refusal' : 'local_after_core_refusal', local.user, code);
  if (!enforcing) {
    Logger.log('[login/OBSERVE] would refuse ' + local.user + ' — GX Core said ' + (code || coreRefusal.error));
    return local;
  }
  Logger.log('[login/REFUSED] ' + local.user + ' — GX Core said ' + (code || coreRefusal.error));
  return {
    ok: false,
    error: code === 'no_access'
      ? 'Your access to Leaderboard has been removed. Ask Sky to restore it.'
      : 'Invalid username or password',
    code: code || 'bad_credentials',
  };
}

/**
 * 'observe' (default) or 'enforce', from GX Core kv so it flips without a deploy.
 * An unreadable setting HOLDS the last mode actually read -- a Core hiccup must never relax an
 * enforcing gate (crew's rule; see gxWriteGrantEnforcing_ for the same shape).
 */
function gxLoginFallbackMode_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('gxLoginFallbackMode');
  if (hit == null) {
    var props = PropertiesService.getScriptProperties();
    try {
      hit = String(GXCore.getKv('cfg.lbLoginFallback') || 'observe').trim().toLowerCase();
      props.setProperty('GC_LOGIN_FALLBACK_MODE_LAST', hit);
    } catch (e) {
      hit = String(props.getProperty('GC_LOGIN_FALLBACK_MODE_LAST') || 'observe');
      Logger.log('[login] could not read cfg.lbLoginFallback, holding last known mode: ' + hit);
    }
    cache.put('gxLoginFallbackMode', hit, 60);
  }
  return hit === 'enforce' ? 'enforce' : 'observe';
}

var GC_LOGIN_PATH_TALLY = 'GC_LOGIN_PATH_TALLY';   // { path: count } since the first recorded sign-in
var GC_LOGIN_PATH_LOG   = 'GC_LOGIN_PATH_LOG';     // capped ring of sign-ins that did NOT go through Core
var GC_LOGIN_PATH_CAP   = 50;
var GC_LOGIN_WOULD_REFUSE = 'GC_LOGIN_WOULD_REFUSE'; // { user: { core_code, last, count } } -- never rolls off

/**
 * Which way each sign-in actually went. Answers the two questions the local list's retirement
 * hangs on and nothing else could: is everyone already signing in through Core, and who would the
 * 'enforce' flip lock out. Best-effort -- a sign-in is never blocked or slowed by a failed record.
 */
function gxRecordLoginPath_(path, user, code) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var tally = JSON.parse(props.getProperty(GC_LOGIN_PATH_TALLY) || '{}');
    if (!own_(tally, 'since')) tally.since = new Date().toISOString();
    tally[path] = (Number(own_(tally, path)) || 0) + 1;
    props.setProperty(GC_LOGIN_PATH_TALLY, JSON.stringify(tally));
    if (path !== 'gxcore') {
      var ring = JSON.parse(props.getProperty(GC_LOGIN_PATH_LOG) || '[]');
      ring.push({ at: new Date().toISOString(), user: String(user || ''), path: path, core_code: code || '' });
      props.setProperty(GC_LOGIN_PATH_LOG, JSON.stringify(ring.slice(-GC_LOGIN_PATH_CAP)));
    }
    // Kept apart from the ring so one busy morning of ordinary fallbacks cannot push a would-be
    // lockout off the end of the record before anyone reads it.
    if (path === 'local_after_core_refusal' || path === 'refused_after_core_refusal') {
      var wr = JSON.parse(props.getProperty(GC_LOGIN_WOULD_REFUSE) || '{}');
      var key = String(user || '');
      var prev = own_(wr, key) || { count: 0 };
      wr[key] = { core_code: code || '', last: new Date().toISOString(), count: (Number(prev.count) || 0) + 1, enforced: path === 'refused_after_core_refusal' };
      props.setProperty(GC_LOGIN_WOULD_REFUSE, JSON.stringify(wr));
    }
  } catch (e) {
    Logger.log('[login/record] ' + ((e && e.message) || e));
  } finally {
    lock.releaseLock();
  }
}

/** The record above, plus the mode and the one-line answer. Names included: director or secret only. */
function gxLoginFallbackAudit_() {
  var props = PropertiesService.getScriptProperties();
  var tally = {}, ring = [], wr = {};
  try { tally = JSON.parse(props.getProperty(GC_LOGIN_PATH_TALLY) || '{}'); } catch (e) {}
  try { ring  = JSON.parse(props.getProperty(GC_LOGIN_PATH_LOG) || '[]'); } catch (e) {}
  try { wr    = JSON.parse(props.getProperty(GC_LOGIN_WOULD_REFUSE) || '{}'); } catch (e) {}
  var names = Object.keys(wr).filter(function (u) { return !wr[u].enforced; }).sort();
  return {
    ok: true,
    mode: gxLoginFallbackMode_(),
    tally: tally,
    wouldRefuse: names.map(function (u) { return { user: u, core_code: wr[u].core_code, last: wr[u].last, count: wr[u].count }; }),
    refused: Object.keys(wr).filter(function (u) { return wr[u].enforced; }).sort()
      .map(function (u) { return { user: u, core_code: wr[u].core_code, last: wr[u].last, count: wr[u].count }; }),
    recent: ring,
    safeToEnforce: names.length === 0 && Number(own_(tally, 'gxcore') || 0) > 0,
    note: names.length
      ? 'DO NOT set cfg.lbLoginFallback=enforce yet: these people are signing in on a local password GX Core refuses. Fix their GX Core password or access first.'
      : 'No sign-in has relied on a local password GX Core refused. Enforcing would lock nobody out of what the record has seen.',
  };
}

/**
 * Own-key map lookup. A LOOKUP TABLE IS NOT A WHITELIST.
 *
 * Every plain object inherits constructor, __proto__, toString, valueOf, hasOwnProperty and
 * isPrototypeOf, so all six return something truthy from ANY map and sail through a plain
 * `if (MAP[input])` gate. Price Cards found this the expensive way: their router gated on
 * `if (!READ_ACTIONS[action])` and ?action=toString served their entire pricing sheet to anyone
 * with the bare /exec URL.
 *
 * Measured here before fixing: GX_ROLE_TO_LOCAL['constructor'] and GX_STOREID_TO_SLUG['__proto__']
 * were both truthy. toString and valueOf missed only because the call sites lowercase first, which
 * is luck, not a defense -- 'constructor' and '__proto__' are already lowercase.
 *
 * Use this anywhere a map decides something, rather than trusting the lookup.
 */
function own_(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * GX Core store_id -> this app's historical slug.
 *
 * DEMOTED to an offline fallback: gxSlugForStoreId_ derives the slug from GX Core's live
 * registry first and only falls back here. Kept rather than deleted -- the consolidation note
 * asked for deletion on the grounds that the slug IS display_name lowercased, which is true
 * (verified against live gxstores 2026-08-28, all six agree) -- but deleting it outright would
 * make a GX Core outage a LOGIN outage, because this map is what places a manager on a store.
 * A registry that is merely stale is survivable; one that is unreachable at sign-in is not.
 */
var GX_STOREID_TO_SLUG = {
  hillsboro: 'baseline', bend: 'century', 'portland-rd': 'portland',
  'river-rd': 'river', center: 'center', commercial: 'commercial',
};

/**
 * GX Core store_id -> this app's slug, from the LIVE registry, falling back to the static map.
 *
 * The slug is display_name lowercased. Deriving it means a store renamed or added in the Command
 * Center places correctly here without a deploy -- which is the whole point of the consolidation:
 * the hardcoded table stops being the source of truth and becomes what it claims to be.
 *
 * Still fails CLOSED. A derived slug is only accepted if this app actually has a STORES entry for
 * it, and an unknown store_id returns null so the caller refuses the session rather than guessing.
 * Guessing here would put a manager on somebody else's store.
 *
 * @param {string} storeId  GX Core store_id, e.g. 'hillsboro'
 * @return {string|null}
 */
function gxSlugForStoreId_(storeId) {
  var id = String(storeId || '').toLowerCase();
  if (!id) return null;

  try {
    var reg = getGxStores_();
    if (reg && reg.ok && reg.stores) {
      for (var i = 0; i < reg.stores.length; i++) {
        if (String(reg.stores[i].store_id || '').toLowerCase() !== id) continue;
        var derived = String(reg.stores[i].display_name || '').trim().toLowerCase();
        // Only trust a derived slug this app can actually serve.
        if (derived && STORES.some(function (x) { return x.slug === derived; })) return derived;
        break;   // Core knows this store but we cannot serve it -- fall through to the map
      }
    }
  } catch (e) { /* Core unreachable -- the fallback below is the point */ }

  return own_(GX_STOREID_TO_SLUG, id) || null;
}
/** GX Core app_access role -> a role homeRoute() and requireRole_ actually understand. */
var GX_ROLE_TO_LOCAL = {
  owner: 'owner', director: 'director', admin: 'director',
  editor: 'store_manager', manager: 'store_manager', viewer: 'budtender',
};

/**
 * Translate a GX Core session, or return null if it cannot be translated safely.
 * Null means "fall back to local" — never "guess and route them somewhere".
 */
function gxSessionUsable_(g) {
  var role = own_(GX_ROLE_TO_LOCAL, String(g.role || '').toLowerCase());
  if (!role) return null;

  var needsStore = (role !== 'owner' && role !== 'director');
  var slug = null;
  if (g.store) {
    slug = gxSlugForStoreId_(g.store);
    if (!slug) return null;                 // a store we cannot place: do not guess
  }
  if (needsStore && !slug) return null;     // manager with no store would default to Baseline

  var store = slug ? STORES.filter(function (x) { return x.slug === slug; })[0] : null;
  var name  = String(g.displayName || g.user || '');
  return {
    ok: true,
    token:       issueSessionToken_(String(g.user || '').toLowerCase()),
    user:        String(g.user || '').toLowerCase(),
    displayName: name,
    initials:    name.trim().split(/\s+/).slice(0, 2)
                   .map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '??',
    role:        role,
    storeSlug:   slug,
    storeName:   store ? store.name : null,
    expiresAt:   new Date(Date.now() + GC_SESSION_TTL_MS).toISOString(),
    source:      'gxcore',
  };
}

function _loginUserLocal_(params) {
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  const key   = String(params.user).toLowerCase().trim();
  const hash  = hashPass_(String(params.pass));
  const u     = users[key];

  if (!u || u.passHash !== hash) {
    return { ok: false, error: 'Invalid username or password' };
  }

  const exp = new Date(Date.now() + GC_SESSION_TTL_MS).toISOString();
  return {
    ok:          true,
    token:       issueSessionToken_(key),
    user:        key,
    displayName: u.displayName || key,
    initials:    u.initials || key.slice(0,2).toUpperCase(),
    role:        u.role || 'budtender',
    storeSlug:   u.storeSlug || null,
    storeName:   u.storeName || null,
    expiresAt:   exp,
  };
}

// ── Setup: run once from the Script Editor ────────────────────
// Example: setUserPassword_('username', '<password>', 'director', null, 'Display Name', 'IN')
function setUserPassword_(username, password, role, storeSlug, displayName, initials) {
  if (!username || !password || !role) throw new Error('username, password, and role are required');
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  const store = storeSlug ? STORES.find(s => s.slug === storeSlug) : null;
  users[username.toLowerCase().trim()] = {
    passHash:    hashPass_(String(password)),
    role:        role,
    storeSlug:   storeSlug || null,
    storeName:   store ? store.name : null,
    displayName: displayName || username,
    initials:    initials || username.slice(0,2).toUpperCase(),
  };
  props.setProperty(GC_USERS_KEY, JSON.stringify(users));
  Logger.log('User set: ' + username + ' / role: ' + role);
  return { ok: true, user: username };
}

/**
 * Create or update a user account.
 * Params: username, password, role, storeSlug, displayName, initials
 * Auth:   director token required
 */
function adminSetUser(params) {
  if (!params.username) return { ok: false, error: 'username required' };
  if (!params.password) return { ok: false, error: 'password required' };
  if (!params.role)     return { ok: false, error: 'role required' };

  const validRoles = ['director', 'store_manager', 'budtender', 'owner'];
  if (!validRoles.includes(params.role)) {
    return { ok: false, error: 'Invalid role: ' + params.role };
  }

  return setUserPassword_(
    params.username,
    params.password,
    params.role,
    params.storeSlug || null,
    params.displayName || params.username,
    params.initials || ''
  );
}

/* adminSetStoreKeys was REMOVED 2026-08-31, with the setstorekeys route that called it.
 * This app stores no Dutchie key. GX Core holds the only copy and hands one out over
 * ?action=dutchie_keys, gated by GX_CONNECTOR_SECRET. Writing DUTCHIE_STORE_KEYS_JSON here would
 * update a property nothing reads, which is worse than doing nothing: it looks like a rotation.
 */

// ============================================================
//  WRITE AUTHORIZATION — re-check the GRANT, not just the signature
// ============================================================

/**
 * Actions that MUTATE something. Everything here gets the grant re-check; everything else is a
 * read and is deliberately left alone.
 *
 * The list is of WRITES rather than of reads on purpose. Miss a write and it merely keeps today's
 * behavior (signature-only); misclassify a READ as a write and a Core hiccup blanks a board at
 * open. The failure modes are not symmetric, so the list that fails safe is the one we maintain.
 *
 * NEW WRITE ACTION? ADD IT HERE.
 */
var GX_WRITE_ACTIONS = [
  'applydiscounttargets', 'backfillsnapshots', 'bootstrapdirectors', 'bustdist', 'clearavatar',
  'clearmanualgoal', 'goalbackfill', 'goalbackfillbulk', 'goalpush', 'installeodguard',
  // kioskrefresh writes a Script Property, so it belongs here. Note this gates only the SESSION
  // route; the secret-gated twin sits above requireAuth_ and is unaffected — deliberately, since
  // it is the escape hatch for the case where GX Core is the thing that is down.
  'kioskrefresh',
  'recalculategoals', 'recalculateyoygoals', 'refreshdiscounts', 'refreshtargets', 'saveavatar',
  'savediscountsettings', 'saveincentive', 'savemanualgoals', 'savesettings', 'setplan',
  'setuptrigger', 'setuser', 'syncemployees',
];
// `bugreport` is deliberately NOT here: filing a bug is how someone reports being broken, and it
// must not be the thing that refuses them. `renew` is not here either -- refusing to renew a
// session is what session expiry already does, and gating it would just turn a clean re-login
// into a confusing one.

function gxIsWriteAction_(action) {
  return GX_WRITE_ACTIONS.indexOf(String(action || '').toLowerCase()) !== -1;
}

/**
 * Is the write grant check ENFORCING? Read from GX Core kv so it can be flipped from the Command
 * Center without a deploy. Default OFF -- see gxCheckWriteGrant_ for why it ships dark.
 */
function gxWriteGrantEnforcing_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('gxWriteGrantMode');
  if (hit == null) {
    var props = PropertiesService.getScriptProperties();
    try {
      hit = String(GXCore.getKv('cfg.lbWriteGrantCheck') || 'off').trim().toLowerCase();
      props.setProperty('GC_WRITE_GRANT_MODE_LAST', hit);   // remember the last KNOWN-GOOD answer
    } catch (e) {
      // A FALLBACK ON AN AUTH PATH MUST BE NO MORE PERMISSIVE THAN THE THING IT REPLACES (crew's
      // rule, and this is exactly the case it catches). Defaulting to 'off' here would mean an
      // unreachable GX Core silently DISABLES enforcement -- a Core outage would quietly reopen
      // the very window this check exists to close, and nothing would say so. Fall back to the
      // last mode we actually read instead, so the failure can hold the line but never relax it.
      hit = String(props.getProperty('GC_WRITE_GRANT_MODE_LAST') || 'off');
      Logger.log('[writegrant] could not read cfg.lbWriteGrantCheck, holding last known mode: ' + hit);
    }
    cache.put('gxWriteGrantMode', hit, 60);
  }
  return hit === 'on';
}

/**
 * Re-check that the caller still has a `performance` grant in GX Core before letting a write land.
 *
 * WHY THIS EXISTS. validateSessionToken_ proves WHO you are -- it checks an HMAC signature and an
 * expiry. It does not prove you still have ACCESS. Our session TTL is 7 days, so without this a
 * revocation in GX Core was advisory for up to a week on this app.
 *
 * WHY GXCore.roleForApp AND NOT verifySession. verifySession validates a CORE-SIGNED token. Even
 * when GXCore.login authenticates the user we mint our OWN token with issueSessionToken_ and
 * discard Core's, so verifySession would reject 100% of our callers and take the whole write
 * surface down. roleForApp asks the by-USER question instead. It also handles superadmin FIRST --
 * getGrantsForUser reads app_access only, so a superadmin with no explicit row looks identical to
 * a revoked user, and failing closed on that would lock Sky out of the app he uses most.
 *
 * WHY IT SHIPS DARK. Users who authenticate against the LOCAL store rather than GX Core may have
 * no app_access row at all, and enforcing on them would lock them out of writes with no warning.
 * So while the flag is off this still COMPUTES the answer and logs what it WOULD have refused --
 * a built-in dry run. Turn cfg.lbWriteGrantCheck to "on" once the log is quiet.
 *
 * FAILS CLOSED when enforcing, including if GX Core is unreachable: failing open on an auth check
 * is the same as having no check. Reads are untouched and still fail open, so a Core outage can
 * never blank a board at open.
 */
function gxCheckWriteGrant_(auth, action) {
  // A Core-signed session writes only if Core itself says this role may edit. Independent of the
  // enforcing flag: the dev viewer is read-only by construction, not by a setting.
  if (auth && auth.via === 'gxcore' && auth.canEdit !== true) {
    Logger.log('[writegrant/REFUSED] ' + auth.user + ' -> ' + action + ' — Core-signed read-only session');
    return { ok: false, error: 'This session is read-only, so this change was not saved.', code: 'read_only', user: auth.user };
  }
  var enforcing = gxWriteGrantEnforcing_();
  var role = null, err = null;
  try {
    role = GXCore.roleForApp(String(auth.user || '').toLowerCase(), 'performance');
  } catch (e) {
    err = (e && e.message) || String(e);
  }

  if (role && !err) return { ok: true, role: role };

  var why = err
    ? 'GX Core could not be reached to confirm access (' + err + ')'
    : 'access to this app has been revoked in GX Core';

  if (!enforcing) {
    // Dry run: record precisely who would have been refused and why, so turning this on is a
    // decision made from evidence rather than a hope.
    Logger.log('[writegrant/DRYRUN] would refuse ' + auth.user + ' -> ' + action + ' — ' + why);
    return { ok: true, dryRun: true };
  }

  // Fail LOUD and name the reason. A write that silently no-ops is worse than a refused one --
  // the person believes they saved.
  Logger.log('[writegrant/REFUSED] ' + auth.user + ' -> ' + action + ' — ' + why);
  return {
    ok: false,
    error: err
      ? 'Could not confirm your access with GX Core, so this change was not saved. Try again in a moment.'
      : 'Your access to Leaderboard has been removed, so this change was not saved. Ask Sky to restore it.',
    code: err ? 'grant_check_unavailable' : 'no_access',
    user: auth.user,
  };
}

/**
 * Proves the write gate is REALLY wired, rather than reporting that it exists.
 * Stealing inventory's point: a check that cannot fail reads as a pass, so the refusal is
 * asserted here, not assumed. Pre-auth and read-only -- it reports no user data.
 */
function gxWriteAuthProbe_() {
  var pinned = null, hasRoleForApp = false, refusesGarbage = null, coreErr = null;
  try { if (typeof GXCore.libVersion === 'function') pinned = GXCore.libVersion(); } catch (e) {}
  try { hasRoleForApp = (typeof GXCore.roleForApp === 'function'); } catch (e) {}
  try {
    // A user id that cannot exist. roleForApp must return null (no grant), not throw and not
    // invent a role. If this ever reads true-ish, the gate is decorative.
    refusesGarbage = !GXCore.roleForApp('__no_such_user_' + Utilities.getUuid().slice(0, 8), 'performance');
  } catch (e) { coreErr = (e && e.message) || String(e); }

  return {
    ok: true,
    pinned: pinned,
    hasRoleForApp: hasRoleForApp,
    refusesUnknownUser: refusesGarbage,
    enforcing: gxWriteGrantEnforcing_(),
    gatedActions: GX_WRITE_ACTIONS.length,
    coreError: coreErr,
    // The ADMIT half, COUNTS ONLY -- no names, so this can stay pre-auth alongside the rest.
    // refusesUnknownUser proves the gate refuses the bad; this proves whether it would admit the
    // good, which is the half that decides if the flag can be turned on at all. Names are behind
    // action=writegrantaudit (owner/director), because WHO is refused is nobody else's business.
    admit: gxAdmitCounts_(),
  };
}

/** Counts-only slice of the admit test, cached briefly -- it asks GX Core once per local user. */
function gxAdmitCounts_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('gxAdmitCounts');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var out;
  try {
    var a = gxWriteGrantAudit_();
    out = { ok: true, counts: a.counts, safeToEnforce: a.safeToEnforce };
  } catch (e) {
    out = { ok: false, error: (e && e.message) || String(e) };
  }
  cache.put('gxAdmitCounts', JSON.stringify(out), 300);
  return out;
}

/**
 * Reports the GXCore library version this deployment is bound to (GXCore.libVersion(), added in
 * v153). An older pin has no libVersion(), which is itself the answer — the error is reported, not
 * thrown, so the check never 500s.
 */
function getLibVersion_() {
  try {
    if (typeof GXCore === 'undefined' || !GXCore) return { ok: false, error: 'GXCore not bound' };
    if (typeof GXCore.libVersion !== 'function') return { ok: false, error: 'pinned GXCore has no libVersion() - pre-v153' };
    // standings_source names the connector that actually served the settled portion of the last
    // standings computation — 'gxcore@<iso>#<rows>' or 'dutchie@<iso>#0'. Same idea as Sales'
    // qb.last_source. It rides on this route because this is the one PUBLIC diagnostic here, and a
    // check that needs a session is a check nobody runs right after a deploy.
    // No sales figures: a connector name, a row count, a timestamp.
    return { ok: true, gxcore: GXCore.libVersion(), standings_source: getStandingsSource_() || '(not computed since deploy)' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Truncated SHA-256 of THIS project's GC_SESSION_SECRET, for comparing against GX Core without
 * either side revealing a value. Core publishes 625516f184e4f203.
 *
 * WHY IT MATTERS: Core and every spoke read the same PROPERTY NAME, and a project with no value
 * auto-generates a random one. So matching names prove nothing -- two projects can hold different
 * secrets under one name and their tokens will not interoperate. If this matches Core, our tokens
 * are Core-verifiable and the write gate could collapse into GXCore.requireAuth(p, "performance").
 * If it does not, our roleForApp-alongside-our-own-signature design is the only correct one.
 *
 * Owner/director gated: it reveals no secret, but it is nobody else's business.
 */
function gxSessionFingerprint_() {
  var v = PropertiesService.getScriptProperties().getProperty('GC_SESSION_SECRET');
  if (!v) return { ok: false, error: 'GC_SESSION_SECRET is not set on this project' };
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, v, Utilities.Charset.UTF_8);
  var hex = d.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
  return {
    ok: true,
    property: 'GC_SESSION_SECRET',
    fingerprint: hex.slice(0, 16),
    algorithm: 'sha256, first 16 hex chars',
    gxCorePublished: '625516f184e4f203',
    matchesCore: hex.slice(0, 16) === '625516f184e4f203',
  };
}

/**
 * THE ADMIT TEST, for OUR population — would enforcing lock anyone out?
 *
 * "Refuses the bad" and "admits the good" are two different assertions, and writeauthprobe only
 * makes the first. This makes the second, against the users we actually have.
 *
 * WHY IT CANNOT BE BORROWED. Inventory ran a positive admit test and it does not transfer: they
 * retired their local-login fallback, so every signed-in Inventory user provably has an app_access
 * row. We kept ours, so our population CAN contain signed-in users with no grant — the exact group
 * sales found roleForApp returning null for, including their own app owner. A green result on their
 * app says nothing about that group on ours.
 *
 * Sky is also the WRONG test subject here: superadmin resolves first inside roleForApp, so he is
 * the account most likely to pass when everyone else fails. What matters is the non-superadmin rows.
 *
 * Read-only, no writes, no grant mutation. Owner/director gated — same audience as listusers, which
 * already returns this roster.
 */
function gxWriteGrantAudit_() {
  var users = JSON.parse(PropertiesService.getScriptProperties().getProperty(GC_USERS_KEY) || '{}');
  var ids = Object.keys(users).sort();

  var admitted = [], refusedNoGrant = [], errored = [];
  ids.forEach(function (id) {
    var role = null, err = null;
    try { role = GXCore.roleForApp(String(id).toLowerCase(), 'performance'); }
    catch (e) { err = (e && e.message) || String(e); }
    var rec = { user: id, localRole: (users[id] || {}).role || '' };
    if (err)        { rec.error = err; errored.push(rec); }
    else if (role)  { rec.coreRole = role; admitted.push(rec); }
    else            { refusedNoGrant.push(rec); }
  });

  return {
    ok: true,
    // The three buckets, named. Offered to inventory/pricecards as shared vocabulary so the suite
    // does not grow three names for the same states.
    counts: {
      admitted:        admitted.length,
      refused_no_grant: refusedNoGrant.length,
      refused_unavailable: errored.length,
      total:           ids.length,
    },
    // WOULD FLIPPING THE FLAG BE SAFE? This is the whole question, answered rather than estimated.
    safeToEnforce: refusedNoGrant.length === 0 && errored.length === 0,
    admitted:         admitted,
    refused_no_grant: refusedNoGrant,     // <- anyone here is locked out of writes the moment we enforce
    refused_unavailable: errored,
    note: refusedNoGrant.length
      ? 'DO NOT set cfg.lbWriteGrantCheck=on until these users have a performance grant in GX Core, or they lose writes.'
      : 'Every local user resolves to a GX Core role. Enforcing would admit them all.',
  };
}
