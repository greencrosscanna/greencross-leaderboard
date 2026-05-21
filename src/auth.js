// ============================================================
//  Green Cross — Sales Dashboard
//  Auth — session handling (client side)
//
//  Server-side pattern mirrors greencross-inventory:
//    HMAC-SHA256 token: "user:exp:sig"
//    Validated on every request via ?token=... param
//
//  Client stores the session as JSON in localStorage under
//  GC_PERF_SESSION (distinct from inventory's GC_AUTH_SESSION
//  to avoid cross-app collisions).
// ============================================================

window.GC = window.GC || {};

GC.auth = (function() {
  var SESSION_KEY = 'GC_PERF_SESSION';

  // ── Save session after successful login ────────────────
  function save(data) {
    // data: { token, user, role, storeId, storeName, expiresAt }
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(data));
    } catch(e) {
      console.warn('[GC.auth] Could not save session:', e);
    }
  }

  // ── Load session from localStorage ────────────────────
  function load() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !s.token || !s.expiresAt) return null;
      if (new Date(s.expiresAt) < new Date()) {
        clear();
        return null;
      }
      return s;
    } catch(e) {
      return null;
    }
  }

  // ── Clear session (logout) ─────────────────────────────
  function clear() {
    localStorage.removeItem(SESSION_KEY);
  }

  // ── Check whether a valid session exists ──────────────
  function isAuthenticated() {
    return load() !== null;
  }

  // ── Redirect path based on role ───────────────────────
  function homeRoute() {
    var s = load();
    if (!s) return '#/login';
    switch (s.role) {
      case 'owner':
      case 'director':
        return '#/director';
      case 'store_manager':
      case 'asst_manager':
      case 'budtender':
        return '#/store/' + (s.storeSlug || 'baseline');
      default:
        return '#/director';
    }
  }

  return { save: save, load: load, clear: clear, isAuthenticated: isAuthenticated, homeRoute: homeRoute };
})();
