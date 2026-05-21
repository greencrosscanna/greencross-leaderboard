// ============================================================
//  Green Cross — Sales Performance Dashboard
//  Google Apps Script Backend (dutchie_proxy.gs)
//
//  Deploy as: Execute as: User deploying the web app
//             Access: Anyone (uses our own HMAC session auth)
//
//  Phase 1 (current): auth endpoints only — all data comes
//                     from static fixtures in src/fixtures/
//  Phase 2: wire the Dutchie API data endpoints below
// ============================================================

// ── Constants ─────────────────────────────────────────────
const GC_USERS_KEY          = 'gc_perf_users';
const GC_SESSION_SECRET_KEY = 'GC_PERF_SESSION_SECRET';
const GC_SESSION_TTL_MS     = 7 * 24 * 60 * 60 * 1000;
const DUTCHIE_BASE          = 'https://api.pos.dutchie.com';

// Canonical store list — slugs must match src/fixtures/ filenames
// and the frontend GC.STORES registry in utils.js
const STORES = [
  { slug: 'baseline',   name: 'Baseline',   dutchieName: 'Baseline' },
  { slug: 'center',     name: 'Center',     dutchieName: 'Center' },
  { slug: 'century',    name: 'Century',    dutchieName: 'Century' },
  { slug: 'commercial', name: 'Commercial', dutchieName: 'Commercial' },
  { slug: 'portland',   name: 'Portland',   dutchieName: 'Portland Rd' },
  { slug: 'river',      name: 'River',      dutchieName: 'River Rd' },
];

// ── Router ────────────────────────────────────────────────
function doGet(e) {
  const params = e.parameter || {};

  // Serve the frontend when no action
  if (!params.action) {
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('Green Cross — Performance')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  try {
    // ── Public: auth ────────────────────────────────────
    if (params.action === 'login') {
      return jsonOut(loginUser(params), params.callback);
    }

    if (params.action === 'ping') {
      return jsonOut({ ok: true, ts: new Date().toISOString() }, params.callback);
    }

    // ── Auth required from here ──────────────────────────
    const auth = requireAuth_(params);
    if (!auth.ok) return jsonOut(auth, params.callback);

    // ── Director endpoints ───────────────────────────────
    if (params.action === 'directorsummary') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getDirectorSummary(params), params.callback);
    }
    if (params.action === 'directorstores') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getDirectorStores(params), params.callback);
    }
    if (params.action === 'directorstaff') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getDirectorStaff(params), params.callback);
    }
    if (params.action === 'directoralerts') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(getDirectorAlerts(), params.callback);
    }

    // ── Store / Kiosk endpoints ──────────────────────────
    if (params.action === 'storetoday') {
      const store = requireStore_(auth, params.store);
      return jsonOut(getStoreToday(store, params), params.callback);
    }
    if (params.action === 'storeleaderboard') {
      const store = requireStore_(auth, params.store);
      return jsonOut(getStoreLeaderboard(store, params), params.callback);
    }
    if (params.action === 'storebadges') {
      const store = requireStore_(auth, params.store);
      return jsonOut(getStoreBadges(store, params), params.callback);
    }

    // ── Plan management ──────────────────────────────────
    if (params.action === 'setplan') {
      requireRole_(auth, ['owner','director']);
      return jsonOut(setStorePlan(params), params.callback);
    }

    // ── Admin (run once from editor, not HTTP) ───────────
    // setUserPassword_(username, password, role, storeSlug)

    return jsonOut({ ok: false, error: 'Unknown action: ' + params.action }, params.callback);

  } catch(err) {
    Logger.log('Error: ' + err.message + '\n' + err.stack);
    return jsonOut({ ok: false, error: err.message }, params.callback);
  }
}

// ── Auth ───────────────────────────────────────────────────

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
  // In Phase 2, look up user record to get role
  // For now: all authenticated users are considered valid if the token is good
  // TODO: extend user records to include role, then enforce here
}

function requireStore_(auth, slug) {
  // In Phase 2, verify the authenticated user has access to this store
  // (directors can access all; store-level users only their own store)
  const store = STORES.find(s => s.slug === slug);
  if (!store) throw new Error('Unknown store: ' + slug);
  return store;
}

function loginUser(params) {
  if (!params.user || !params.pass) {
    return { ok: false, error: 'Missing credentials' };
  }
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

// ── Setup: run once from the editor to create user accounts ──
// Example: setUserPassword_('sky', 'gcadmin', 'director', null, 'Sky Pinnick', 'SP')
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

// ── Director Data Endpoints ────────────────────────────────
// Phase 2: these will query the Dutchie API and aggregate.
// For now they return stub responses; frontend uses fixtures.

function getDirectorSummary(params) {
  // TODO Phase 2: aggregate transactions across all stores
  // for the requested period. Use getDutchieTransactions()
  // with the store key for each of the 6 stores.
  return { ok: false, error: 'Phase 2 not yet implemented — use fixtures' };
}

function getDirectorStores(params) {
  return { ok: false, error: 'Phase 2 not yet implemented — use fixtures' };
}

function getDirectorStaff(params) {
  return { ok: false, error: 'Phase 2 not yet implemented — use fixtures' };
}

function getDirectorAlerts() {
  return { ok: false, error: 'Phase 2 not yet implemented — use fixtures' };
}

// ── Store / Kiosk Data Endpoints ───────────────────────────

function getStoreToday(store, params) {
  return { ok: false, error: 'Phase 2 not yet implemented — use fixtures' };
}

function getStoreLeaderboard(store, params) {
  return { ok: false, error: 'Phase 2 not yet implemented — use fixtures' };
}

function getStoreBadges(store, params) {
  return { ok: false, error: 'Phase 2 not yet implemented — use fixtures' };
}

// ── Plan Management ────────────────────────────────────────

function setStorePlan(params) {
  // TODO: validate and write to a StorePlan sheet
  return { ok: false, error: 'Plan management not yet implemented' };
}

// ── Dutchie API helper (from greencross-inventory pattern) ─

function getDutchieStoreKey_(slug) {
  const props = PropertiesService.getScriptProperties();
  const keys  = JSON.parse(props.getProperty('DUTCHIE_STORE_KEYS_JSON') || '{}');
  const store = STORES.find(s => s.slug === slug);
  if (!store) throw new Error('Unknown store: ' + slug);
  return keys[store.dutchieName];
}

function dutchieFetch_(storeKey, path, queryParams) {
  const qs = Object.entries(queryParams || {})
    .map(([k,v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
  const url = DUTCHIE_BASE + path + (qs ? '?' + qs : '');
  const resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(storeKey + ':'),
      Accept: 'application/json',
    },
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Dutchie API error ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0,200));
  }
  return JSON.parse(resp.getContentText());
}

// ── JSONP wrapper ─────────────────────────────────────────

function jsonOut(data, callback) {
  const json = JSON.stringify(data);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
