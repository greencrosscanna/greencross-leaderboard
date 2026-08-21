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
  if (sig !== signSession_(payload)) return { ok: false, error: 'Invalid session' };
  return { ok: true, user: user };
}

function requireAuth_(params) {
  return validateSessionToken_(params.token || params.session || params.auth || '');
}

function requireRole_(auth, allowedRoles) {
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
 * At the time of writing ALL TEN performance grants have default_store empty, so every store manager
 * would land somewhere wrong. Hence gxSessionUsable_: a GX Core result is only accepted when it
 * translates cleanly. Anything else falls back to local, which is exactly today's behaviour.
 *
 * Directors need no store, so they move to shared sign-on now. Managers follow automatically once
 * users.default_store is filled in on the GX Core side -- no code change needed here.
 */
function loginUser(params) {
  if (!params.user || !params.pass) {
    return { ok: false, error: 'Missing credentials' };
  }

  try {
    if (typeof GXCore !== 'undefined' && GXCore && GXCore.login) {
      var g = GXCore.login(params.user, params.pass, 'performance');
      if (g && g.ok) {
        var mapped = gxSessionUsable_(g);
        if (mapped) {
          Logger.log('[login] ' + mapped.user + ' via GX CORE (role=' + mapped.role +
                     ', store=' + (mapped.storeSlug || 'all') + ')');
          return mapped;
        }
        Logger.log('[login] ' + params.user + ' authenticated in GX Core but the session was not ' +
                   'usable here (role=' + g.role + ', store="' + (g.store || '') + '") — using local');
      }
    }
  } catch (e) {
    Logger.log('[login/GXCore] ' + (e && e.message || e));   // never block sign-in on a Core problem
  }
  return _loginUserLocal_(params);
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
 * is luck, not a defence -- 'constructor' and '__proto__' are already lowercase.
 *
 * Use this anywhere a map decides something, rather than trusting the lookup.
 */
function own_(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** GX Core store_id -> this app's historical slug. Anything absent is deliberately unmapped. */
var GX_STOREID_TO_SLUG = {
  hillsboro: 'baseline', bend: 'century', 'portland-rd': 'portland',
  'river-rd': 'river', center: 'center', commercial: 'commercial',
};
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
    slug = own_(GX_STOREID_TO_SLUG, String(g.store).toLowerCase()) || null;
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

/**
 * Write DUTCHIE_STORE_KEYS_JSON to ScriptProperties.
 * Params: keys — JSON string of { dutchieName: apiKey, ... }
 * Auth:   director token required
 */
function adminSetStoreKeys(params) {
  if (!params.keys) return { ok: false, error: 'keys param required' };
  let parsed;
  try {
    parsed = JSON.parse(params.keys);
  } catch(e) {
    return { ok: false, error: 'keys must be valid JSON: ' + e.message };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'keys must be a JSON object' };
  }
  PropertiesService.getScriptProperties().setProperty('DUTCHIE_STORE_KEYS_JSON', JSON.stringify(parsed));
  Logger.log('Store keys updated: ' + Object.keys(parsed).join(', '));
  return { ok: true, stores: Object.keys(parsed) };
}

// ============================================================
//  WRITE AUTHORISATION — re-check the GRANT, not just the signature
// ============================================================

/**
 * Actions that MUTATE something. Everything here gets the grant re-check; everything else is a
 * read and is deliberately left alone.
 *
 * The list is of WRITES rather than of reads on purpose. Miss a write and it merely keeps today's
 * behaviour (signature-only); misclassify a READ as a write and a Core hiccup blanks a board at
 * open. The failure modes are not symmetric, so the list that fails safe is the one we maintain.
 *
 * NEW WRITE ACTION? ADD IT HERE.
 */
var GX_WRITE_ACTIONS = [
  'applydiscounttargets', 'backfillsnapshots', 'bootstrapdirectors', 'bustdist', 'clearavatar',
  'clearmanualgoal', 'goalbackfill', 'goalbackfillbulk', 'goalpush', 'installeodguard',
  'recalculategoals', 'recalculateyoygoals', 'refreshdiscounts', 'refreshtargets', 'saveavatar',
  'savediscountsettings', 'saveincentive', 'savemanualgoals', 'savesettings', 'setplan',
  'setstorekeys', 'setuptrigger', 'setuser', 'syncemployees',
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
    hit = 'off';
    try { hit = String(GXCore.getKv('cfg.lbWriteGrantCheck') || 'off').trim().toLowerCase(); }
    catch (e) { hit = 'off'; }        // Core unreachable -> do not start enforcing
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
  };
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
    return { ok: true, gxcore: GXCore.libVersion() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
