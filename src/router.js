// ============================================================
//  Green Cross — Sales Dashboard
//  Hash-based Router
//
//  Routes:
//    #/login              → login form (unauthenticated default)
//    #/director           → director view (owner, director)
//    #/store/:slug        → kiosk view (store_manager, asst_manager, budtender)
//    #/leaderboard        → cross-store staff table (director+)
//
//  Auth guard: any route other than /login redirects to /login
//  if there's no valid session. After login, router.navigate()
//  sends the user to their role-appropriate home.
// ============================================================

window.GC = window.GC || {};

GC.router = (function() {

  var _currentRoute = null;
  var _app = null;

  // ── Route definitions ──────────────────────────────────
  // Each entry: { pattern: RegExp, roles: string[]|null, render: fn(params) }
  // roles: null means unauthenticated allowed (login page only)
  var routes = [
    {
      id: 'login',
      pattern: /^\/login$/,
      roles: null,   // public
      render: function() { GC.views.renderLogin(); },
    },
    {
      id: 'director',
      pattern: /^\/director$/,
      roles: ['owner','director'],
      render: function() { GC.views.renderDirector(); },
    },
    {
      id: 'store',
      pattern: /^\/store\/([a-z]+)$/,
      roles: ['owner','director','store_manager','asst_manager','budtender'],
      render: function(params) { GC.views.renderKiosk(params[1]); },
    },
    {
      id: 'leaderboard',
      pattern: /^\/leaderboard$/,
      roles: ['owner','director'],
      render: function() { GC.views.renderLeaderboard(); },
    },
    {
      id: 'settings',
      pattern: /^\/settings$/,
      roles: ['owner','director'],
      render: function() { GC.views.renderSettings(); },
    },
    {
      id: 'avatar',
      pattern: /^\/avatar$/,
      roles: ['owner','director','store_manager','asst_manager','budtender'],
      render: function(params, queryParams) { GC.views.renderAvatar(queryParams); },
    },
  ];

  // ── Dispatch ───────────────────────────────────────────
  function dispatch(hash) {
    // Normalise: strip leading #, ensure leading /
    var raw = (hash || '').replace(/^#/, '') || '/login';
    if (raw === '' || raw === '/') raw = '/login';

    // Split path from query string (e.g. /avatar?employee=john_doe)
    var qIdx   = raw.indexOf('?');
    var path   = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    var qs     = qIdx >= 0 ? raw.slice(qIdx + 1) : '';

    // Parse query params into a plain object
    var queryParams = {};
    if (qs) {
      qs.split('&').forEach(function(pair) {
        var eq = pair.indexOf('=');
        if (eq > 0) {
          queryParams[decodeURIComponent(pair.slice(0, eq))] =
            decodeURIComponent(pair.slice(eq + 1));
        }
      });
    }

    // Find matching route
    var matched = null;
    var params  = null;
    for (var i = 0; i < routes.length; i++) {
      var m = path.match(routes[i].pattern);
      if (m) { matched = routes[i]; params = m; break; }
    }

    if (!matched) {
      // Unknown path → send home (respects auth)
      navigate(GC.auth.isAuthenticated() ? GC.auth.homeRoute() : '#/login');
      return;
    }

    // Auth guard
    if (matched.roles !== null) {
      // Route requires auth
      if (!GC.auth.isAuthenticated()) {
        navigate('#/login');
        return;
      }
      var session = GC.auth.load();
      if (matched.roles.indexOf(session.role) === -1) {
        // Authenticated but wrong role → send to own home
        navigate(GC.auth.homeRoute());
        return;
      }
    } else {
      // Public route: if already authenticated, redirect home
      if (GC.auth.isAuthenticated()) {
        navigate(GC.auth.homeRoute());
        return;
      }
    }

    _currentRoute = matched.id;
    matched.render(params, queryParams);
  }

  // ── Navigate ───────────────────────────────────────────
  function navigate(hash) {
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    } else {
      // Already at this hash — trigger render manually
      dispatch(hash);
    }
  }

  // ── Init ───────────────────────────────────────────────
  function init() {
    _app = document.getElementById('app');
    if (!_app) {
      console.error('[GC.router] #app element not found');
      return;
    }
    window.addEventListener('hashchange', function() {
      dispatch(window.location.hash);
    });

    // Global click handler for .lb-ava chips with data-ava-nav attribute.
    // Handles clicks anywhere inside the puck (e.g. on the img child).
    document.addEventListener('click', function(e) {
      var puck = e.target.closest('[data-ava-nav]');
      if (!puck) return;
      var key = puck.getAttribute('data-ava-nav');
      if (key) navigate('#/avatar?employee=' + encodeURIComponent(key));
    });

    // Dispatch on initial load
    dispatch(window.location.hash);
  }

  return {
    init: init,
    navigate: navigate,
    currentRoute: function() { return _currentRoute; },
  };
})();

// ============================================================
//  Views registry — each view module registers itself here.
//  The router calls these methods; stubs prevent errors if a
//  view file hasn't loaded yet.
// ============================================================
GC.views = {
  renderLogin:       function() { console.warn('[GC.views] renderLogin not registered'); },
  renderDirector:    function() { console.warn('[GC.views] renderDirector not registered'); },
  renderKiosk:       function(slug) { console.warn('[GC.views] renderKiosk not registered:', slug); },
  renderLeaderboard: function() { console.warn('[GC.views] renderLeaderboard not registered'); },
  renderSettings:    function() { console.warn('[GC.views] renderSettings not registered'); },
  renderAvatar:      function(qp) { console.warn('[GC.views] renderAvatar not registered', qp); },
};
