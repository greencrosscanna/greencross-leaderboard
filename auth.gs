// ============================================================
//  Green Cross — Auth & Session  (auth.gs)
//  Session tokens and role enforcement (passwords live in GX Core).
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
 *   - no roster lookup: the role comes from the Core session itself
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
  // Our own token names a user and nothing else. Their role comes from GX Core's roster, so a
  // role changed or removed in the Command Center applies here within the roster cache window.
  const u = lbRosterUser_(auth.user);
  if (!u) throw new Error('User not found');
  if (!allowedRoles.includes(u.role)) {
    throw new Error('Insufficient permissions');
  }
}

function requireStore_(auth, slug) {
  const store = STORES.find(s => s.slug === slug);
  if (!store) throw new Error('Unknown store: ' + slug);

  // A Core-signed session has no roster lookup here to place a manager on a store, so refuse rather
  // than hand them every shop. Directors and viewers pass.
  if (auth && auth.via === 'gxcore') {
    if (auth.role === 'store_manager' || auth.role === 'asst_manager') {
      throw new Error('Access denied for store: ' + slug);
    }
    return store;
  }

  // Directors can access all stores; a manager only their own GX Core home store. Someone no longer
  // on the roster gets no store at all -- the old local list let an unknown user through here.
  const u = lbRosterUser_(auth.user);
  if (!u) throw new Error('Access denied for store: ' + slug);
  if ((u.role === 'store_manager' || u.role === 'asst_manager') && u.storeSlug !== slug) {
    throw new Error('Access denied for store: ' + slug);
  }
  return store;
}

/**
 * The heartbeat's renewal. Re-issues a 7-day token -- ONLY while the person still has access.
 *
 * THE HOLE (closed 2026-09-14, found by Sales in its own copy). The client renews every 6 hours once
 * within 48h of expiry, and this used to mint a fresh token for any valid signature. So a session
 * never ended: someone removed in the Command Center stayed signed in for as long as their screen
 * stayed open, and reads never re-check the grant. Now the renewal asks GX Core first:
 *   - roleForApp answers null  -> refused (no_access). The token they hold still runs to its expiry,
 *     at most 48h from here, and then they are signed out for good.
 *   - roleForApp THROWS        -> renewed anyway. A Core bounce on the wrong six-hour tick must not
 *     sign a wall screen out mid-shift; the next tick asks again.
 *   - a Core-signed session    -> never renewed here. It is not ours to extend, and renewing would
 *     trade a short dev session for a 7-day token of ours that skips every Core re-check.
 *
 * Safe to ship blind in a way the login fallback was not: writegrantaudit showed every local user
 * resolves to a Core role (10 of 10 on 2026-09-14), so no current signed-in person is refused.
 */
function renewSession_(auth) {
  if (!auth || !auth.ok) return { ok: false, error: (auth && auth.error) || 'Auth required' };
  if (auth.via === 'gxcore') {
    return { ok: false, error: 'This session cannot be renewed here — sign in again.', code: 'not_renewable' };
  }
  var role = null, coreErr = null;
  try {
    role = GXCore.roleForApp(String(auth.user || '').toLowerCase(), 'performance');
  } catch (e) {
    coreErr = (e && e.message) || String(e);
  }
  if (!role && !coreErr) {
    Logger.log('[renew/REFUSED] ' + auth.user + ' — no performance grant in GX Core');
    return { ok: false, error: 'Your access to Leaderboard has been removed. Ask Sky to restore it.', code: 'no_access' };
  }
  if (coreErr) Logger.log('[renew] could not confirm ' + auth.user + ' with GX Core, renewing anyway: ' + coreErr);
  return {
    ok: true,
    token: issueSessionToken_(auth.user),
    expiresAt: new Date(Date.now() + GC_SESSION_TTL_MS).toISOString(),
  };
}

/**
 * Sign-in goes through GX Core, and only GX Core.
 *
 * THE LOCAL PASSWORD LIST WAS RETIRED 2026-09-15. This app used to keep its own copy of every
 * password and role (Script Property gc_perf_users) and fell back to it -- first whenever Core
 * refused, then (from 2026-09-14, cfg.lbLoginFallback=enforce) only when Core was unreachable. Two
 * copies of a password that nobody kept in sync is how someone removed in the Command Center kept
 * signing in here. Now there is one copy.
 *
 * THE TRADE, stated plainly: if GX Core is DOWN, nobody can sign in to Leaderboard until it is back.
 * People already signed in are unaffected -- their token is ours, and role checks fall back to the
 * last roster GX Core gave us (lbCoreRoster_). Wall screens hold 7-day tokens that renew through a
 * Core bounce (renewSession_), so an outage does not blank the floor.
 *
 * WHY GX CORE IS NOT SIMPLY TRUSTED
 * Its vocabulary is not this app's. `login` returns the app_access role ('director' / 'editor') and
 * `store` from users.default_store, a GX Core store_id; this app switches on 'owner' /
 * 'store_manager' / 'budtender' and routes on its own historical slugs (hillsboro is 'baseline').
 * An unmapped role would land a manager on the director view, and an unmapped store would send them
 * to Baseline's kiosk. So gxSessionUsable_ accepts a Core result only when it translates cleanly --
 * and since there is no longer anything to fall back to, one that does not is REFUSED with a reason
 * Sky can act on, rather than guessed at.
 */
function loginUser(params) {
  if (!params.user || !params.pass) {
    return { ok: false, error: 'Missing credentials' };
  }

  var g;
  try {
    if (typeof GXCore === 'undefined' || !GXCore || !GXCore.login) throw new Error('GXCore library is not bound');
    g = GXCore.login(params.user, params.pass, 'performance');
  } catch (e) {
    Logger.log('[login/GXCore] unreachable: ' + ((e && e.message) || e));
    return { ok: false, error: 'Sign-in is unavailable right now because GX Core could not be reached. Try again in a minute.',
             code: 'core_unreachable' };
  }

  if (!g || !g.ok) {
    var code = String((g && g.code) || 'bad_credentials');
    Logger.log('[login/REFUSED] ' + params.user + ' — GX Core said ' + code);
    return {
      ok: false,
      error: code === 'no_access'
        ? 'Your access to Leaderboard has been removed. Ask Sky to restore it.'
        : 'Invalid username or password',
      code: code,
    };
  }

  var mapped = gxSessionUsable_(g);
  if (!mapped) {
    Logger.log('[login/UNUSABLE] ' + g.user + ' authenticated in GX Core but cannot be placed here ' +
               '(role=' + g.role + ', store="' + (g.store || '') + '")');
    return { ok: false, code: 'core_unusable',
             error: 'Your Leaderboard access is not fully set up (a manager needs a home store). ' +
                    'Ask Sky to set it in the Command Center.' };
  }
  Logger.log('[login] ' + mapped.user + ' via GX CORE (role=' + mapped.role + ', store=' + (mapped.storeSlug || 'all') + ')');
  return mapped;
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

  // The live store list carries the id->slug pair explicitly (refreshStoreRegistry_), including a
  // store added in the Command Center since this code was written. A rename cannot move it.
  for (var k = 0; k < STORES.length; k++) {
    if (String(STORES[k].storeId || '').toLowerCase() === id) return STORES[k].slug;
  }

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

/* ═══ WHO IS ON LEADERBOARD — GX Core's roster, not a local copy ═══════════════════════════════
 *
 * Replaces gc_perf_users as the answer to "what role and store does this signed-in person have".
 * GX Core's app_roster (secret-gated) is the only library-free read that carries BOTH the grant and
 * users.default_store; GXCore.roleForApp has the role but no store, and a manager without a store
 * cannot be placed.
 *
 * Cached for LB_ROSTER_TTL_S, so a change in the Command Center applies here within five minutes --
 * reads included, which the old list never managed (only writes and renewals re-checked).
 *
 * WHEN GX CORE CANNOT BE READ, the last roster it gave us is used (Script Property
 * GC_CORE_ROSTER_LAST), cached for a minute so an outage is not a Core call per request. That is a
 * copy of GX Core's answer, rewritten from GX Core on every refresh and holding no password; it keeps
 * signed-in people working through a bounce, which is the same fail-open-on-reads line the rest of
 * this app holds. Only with no roster ever fetched does a role check fail.
 */
var LB_ROSTER_CACHE_KEY = 'lbCoreRoster_v1';
var LB_ROSTER_LAST_PROP = 'GC_CORE_ROSTER_LAST';
var LB_ROSTER_TTL_S     = 300;

function lbCoreRoster_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(LB_ROSTER_CACHE_KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var props = PropertiesService.getScriptProperties();
  var fresh = null, err = '';
  try { fresh = lbFetchCoreRoster_(props); } catch (e) { err = (e && e.message) || String(e); }
  if (fresh) {
    var text = JSON.stringify(fresh);
    try { cache.put(LB_ROSTER_CACHE_KEY, text, LB_ROSTER_TTL_S); } catch (e) {}
    try { props.setProperty(LB_ROSTER_LAST_PROP, text); } catch (e) {}
    return fresh;
  }

  var last = props.getProperty(LB_ROSTER_LAST_PROP);
  if (last) {
    Logger.log('[roster] GX Core roster unavailable (' + err + '), using the last one fetched');
    try { cache.put(LB_ROSTER_CACHE_KEY, last, 60); } catch (e) {}
    return JSON.parse(last);
  }
  throw new Error('GX Core could not be reached to confirm who you are. Try again in a minute.');
}

/** One read of GX Core's app_roster, translated into this app's roles and store slugs. Throws on a bad read. */
function lbFetchCoreRoster_(props) {
  var secret = props.getProperty('GX_DEPLOY_SECRET');
  if (!secret) throw new Error('GX_DEPLOY_SECRET is not set on this script');
  var url = GXCORE_EXEC_KEYS_ + '?action=app_roster&app=performance&secret=' + encodeURIComponent(secret);
  var d = null, lastErr = '';
  for (var i = 0; i < 3 && !d; i++) {
    try {
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
      var body = resp.getContentText() || '';
      if (body.charAt(0) === '{') d = JSON.parse(body);
      else lastErr = 'HTTP ' + resp.getResponseCode();
    } catch (e) { lastErr = (e && e.message) || String(e); }
    if (!d) Utilities.sleep(400);   // the /exec second hop 404s on a few percent of calls
  }
  if (!d) throw new Error('app_roster unreachable: ' + lastErr);
  if (!d.ok) throw new Error('app_roster refused: ' + (d.error || 'no reason'));

  var users = {};
  function add(id, role, storeId, name) {
    var nm = String(name || id);
    users[id] = {
      user: id, role: role,
      storeSlug: storeId ? gxSlugForStoreId_(storeId) : null,
      displayName: nm,
      initials: nm.trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '??',
    };
  }
  (d.grants || []).forEach(function (g) {
    var id = String(g.user_id || '').toLowerCase().trim();
    var role = own_(GX_ROLE_TO_LOCAL, String(g.role || '').toLowerCase());
    if (id && role) add(id, role, g.store, g.displayName);
  });
  // A superadmin resolves to admin in GX Core whatever their grant row says (roleForApp checks it first).
  (d.superadmins || []).forEach(function (sa) {
    var id = String(sa.user_id || '').toLowerCase().trim();
    if (!id) return;
    var prev = own_(users, id);
    add(id, 'director', sa.store, (prev && prev.displayName) || sa.displayName);
  });
  // An empty roster is a bad read, not a decision to lock everyone out: refuse it so the last good one stands.
  if (!Object.keys(users).length) throw new Error('app_roster returned nobody');
  return { fetchedAt: new Date().toISOString(), users: users };
}

/**
 * EDITOR ONLY — select it in the function dropdown and press Run. Deletes the retired local password
 * list and the sign-in record that went with it, and nothing else. Nothing reads any of these since
 * v1.833 (sign-in is GX Core only). Safe to run twice: a key already gone is reported, not an error.
 *
 * No trailing underscore on purpose: Apps Script hides underscore functions from the Run menu.
 * It is not routed, so nothing over HTTP can call it.
 */
function deleteRetiredLoginProperties() {
  var keys = ['gc_perf_users', 'GC_LOGIN_PATH_TALLY', 'GC_LOGIN_PATH_LOG',
              'GC_LOGIN_WOULD_REFUSE', 'GC_LOGIN_FALLBACK_MODE_LAST'];
  var props = PropertiesService.getScriptProperties();
  var deleted = [], notFound = [];
  keys.forEach(function (k) {
    if (props.getProperty(k) == null) { notFound.push(k); return; }
    props.deleteProperty(k);
    deleted.push(k);
  });
  Logger.log('Deleted: ' + (deleted.join(', ') || 'none') + ' | Already gone: ' + (notFound.join(', ') || 'none'));
  return { deleted: deleted, alreadyGone: notFound };
}

/** Counts-only health of the roster read, for ?action=accessroster. */
function lbRosterStatus_() {
  var props = PropertiesService.getScriptProperties();
  var out = { ok: true, live: null, lastKnown: null };
  try {
    var r = lbFetchCoreRoster_(props), byRole = {}, managersPlaced = 0, managers = 0;
    Object.keys(r.users).forEach(function (k) {
      var u = r.users[k];
      byRole[u.role] = (byRole[u.role] || 0) + 1;
      if (u.role === 'store_manager' || u.role === 'asst_manager') { managers++; if (u.storeSlug) managersPlaced++; }
    });
    out.live = { ok: true, people: Object.keys(r.users).length, byRole: byRole,
                 managers: managers, managersPlacedOnAStore: managersPlaced };
  } catch (e) {
    out.ok = false;
    out.live = { ok: false, error: (e && e.message) || String(e) };
  }
  try {
    var last = JSON.parse(props.getProperty(LB_ROSTER_LAST_PROP) || 'null');
    out.lastKnown = last ? { fetchedAt: last.fetchedAt, people: Object.keys(last.users || {}).length } : null;
  } catch (e) { out.lastKnown = { error: 'unreadable' }; }
  return out;
}

/** The roster row for one signed-in user, or null if GX Core does not list them for Leaderboard. */
function lbRosterUser_(user) {
  return own_(lbCoreRoster_().users, String(user || '').toLowerCase().trim()) || null;
}

/** Every roster row, for display lookups (manager names). Never throws: a name is not worth a blank board. */
function lbRosterList_() {
  try {
    var u = lbCoreRoster_().users;
    return Object.keys(u).map(function (k) { return u[k]; });
  } catch (e) {
    Logger.log('[roster] ' + ((e && e.message) || e));
    return [];
  }
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
  'backfillsnapshots', 'bustdist', 'clearavatar',
  'clearmanualgoal', 'goalbackfill', 'goalbackfillbulk', 'goalpush', 'installeodguard',
  // kioskrefresh writes a Script Property, so it belongs here. Note this gates only the SESSION
  // route; the secret-gated twin sits above requireAuth_ and is unaffected — deliberately, since
  // it is the escape hatch for the case where GX Core is the thing that is down.
  'kioskrefresh',
  'recalculategoals', 'recalculateyoygoals', 'refreshdiscounts', 'refreshtargets', 'saveavatar',
  'savediscountsettings', 'savemanualgoals', 'savesettings', 'setplan',
  'setuptrigger', 'syncemployees',
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

