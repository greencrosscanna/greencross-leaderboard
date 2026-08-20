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
  var role = GX_ROLE_TO_LOCAL[String(g.role || '').toLowerCase()];
  if (!role) return null;

  var needsStore = (role !== 'owner' && role !== 'director');
  var slug = null;
  if (g.store) {
    slug = GX_STOREID_TO_SLUG[String(g.store).toLowerCase()] || null;
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
