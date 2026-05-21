// ============================================================
//  Green Cross — Sales Dashboard
//  API Client
//
//  USE_FIXTURES = true  → reads from src/fixtures/*.json
//                         (Phase 1: visual build, no backend)
//  USE_FIXTURES = false → calls GAS_URL via JSONP
//                         (Phase 2: real data)
//
//  To switch to real API:
//    1. Set GC.api.USE_FIXTURES = false
//    2. Set GC.api.GAS_URL to your deployed GAS web app URL
//    3. Ensure dutchie_proxy.gs is deployed and users are set
// ============================================================

window.GC = window.GC || {};

GC.api = (function() {

  var USE_FIXTURES = true;

  // Deployed GAS web app URL. Set this when wiring real API.
  var GAS_URL = '';

  // Fixtures base path (relative to index.html)
  var FX = 'src/fixtures/';

  // ── JSONP helper (same pattern as greencross-inventory) ──
  var _cbIndex = 0;
  function jsonp(url, params) {
    return new Promise(function(resolve, reject) {
      var cbName = '__gc_cb_' + (++_cbIndex);
      var timeout = setTimeout(function() {
        delete window[cbName];
        reject(new Error('JSONP timeout: ' + url));
      }, 15000);

      window[cbName] = function(data) {
        clearTimeout(timeout);
        delete window[cbName];
        var s = document.getElementById('__gc_jsonp_' + cbName);
        if (s) s.remove();
        resolve(data);
      };

      var qs = Object.assign({ callback: cbName }, params || {});
      var qStr = Object.keys(qs).map(function(k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(qs[k]);
      }).join('&');

      var script = document.createElement('script');
      script.id  = '__gc_jsonp_' + cbName;
      script.src = url + '?' + qStr;
      script.onerror = function() {
        clearTimeout(timeout);
        delete window[cbName];
        script.remove();
        reject(new Error('JSONP script error: ' + url));
      };
      document.head.appendChild(script);
    });
  }

  // ── Auth-aware GAS call ────────────────────────────────
  function gasCall(action, extra) {
    var session = GC.auth.load();
    var params = Object.assign({ action: action }, extra || {});
    if (session && session.token) params.token = session.token;
    return jsonp(GAS_URL, params);
  }

  // ── Fixture fetch ──────────────────────────────────────
  function fetchFixture(filename) {
    return fetch(FX + filename + '.json')
      .then(function(r) {
        if (!r.ok) throw new Error('Fixture not found: ' + filename);
        return r.json();
      });
  }

  // ── Fixture-mode login ─────────────────────────────────
  // Accepts hardcoded credentials so you can test routing
  // without a deployed GAS backend.
  //
  //  sky / gcadmin       → director
  //  sofia / gc123       → store_manager, baseline
  //  maya / gc123        → store_manager, river
  //  devon / gc123       → store_manager, portland
  //  priya / gc123       → store_manager, center
  //  marcus / gc123      → store_manager, commercial
  //  tyler / gc123       → store_manager, century
  var FIXTURE_USERS = {
    'sky':    { role: 'director',      storeSlug: null,         storeName: null,         initials: 'SP', displayName: 'Sky Pinnick' },
    'sofia':  { role: 'store_manager', storeSlug: 'baseline',   storeName: 'Baseline',   initials: 'SA', displayName: 'Sofia Alvarez' },
    'maya':   { role: 'store_manager', storeSlug: 'river',      storeName: 'River',      initials: 'MC', displayName: 'Maya Chen' },
    'devon':  { role: 'store_manager', storeSlug: 'portland',   storeName: 'Portland',   initials: 'DR', displayName: 'Devon Reyes' },
    'priya':  { role: 'store_manager', storeSlug: 'center',     storeName: 'Center',     initials: 'PS', displayName: 'Priya Singh' },
    'marcus': { role: 'store_manager', storeSlug: 'commercial', storeName: 'Commercial', initials: 'MJ', displayName: 'Marcus Johnson' },
    'tyler':  { role: 'store_manager', storeSlug: 'century',    storeName: 'Century',    initials: 'TB', displayName: 'Tyler Brooks' },
  };
  var FIXTURE_PASSWORD = 'gc123';
  var DIRECTOR_PASSWORD = 'gcadmin';

  function fixtureLogin(user, pass) {
    return new Promise(function(resolve) {
      setTimeout(function() {
        var key = (user || '').toLowerCase().trim();
        var u = FIXTURE_USERS[key];
        if (!u) return resolve({ ok: false, error: 'Invalid username or password' });
        var expectedPass = (key === 'sky') ? DIRECTOR_PASSWORD : FIXTURE_PASSWORD;
        if (pass !== expectedPass) return resolve({ ok: false, error: 'Invalid username or password' });
        var exp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        resolve({
          ok: true,
          token: 'fixture-token-' + key,
          user: key,
          displayName: u.displayName,
          initials: u.initials,
          role: u.role,
          storeSlug: u.storeSlug,
          storeName: u.storeName,
          expiresAt: exp,
        });
      }, 300); // simulate network delay
    });
  }

  // ── Public: login ──────────────────────────────────────
  function login(user, pass) {
    if (USE_FIXTURES) return fixtureLogin(user, pass);
    return gasCall('login', { user: user, pass: pass });
  }

  // ── Public: Director endpoints ─────────────────────────

  function fetchDirectorSummary(period) {
    period = period || 'mtd';
    if (USE_FIXTURES) return fetchFixture('director-summary');
    return gasCall('directorsummary', { period: period });
  }

  function fetchDirectorStores(period) {
    period = period || 'mtd';
    if (USE_FIXTURES) return fetchFixture('director-stores');
    return gasCall('directorstores', { period: period });
  }

  function fetchDirectorStaff(period) {
    period = period || 'mtd';
    if (USE_FIXTURES) return fetchFixture('director-staff');
    return gasCall('directorstaff', { period: period });
  }

  function fetchDirectorAlerts() {
    if (USE_FIXTURES) return fetchFixture('director-alerts');
    return gasCall('directoralerts');
  }

  // Convenience: fetch all four director payloads in parallel
  function fetchDirectorAll(period) {
    return Promise.all([
      fetchDirectorSummary(period),
      fetchDirectorStores(period),
      fetchDirectorStaff(period),
      fetchDirectorAlerts(),
    ]).then(function(results) {
      return {
        summary: results[0],
        stores:  results[1],
        staff:   results[2],
        alerts:  results[3],
      };
    });
  }

  // ── Public: Store / Kiosk endpoints ───────────────────
  // (stubs for Phase 2)

  function fetchStoreToday(storeSlug) {
    if (USE_FIXTURES) return fetchFixture('store-today-' + storeSlug);
    return gasCall('storetoday', { store: storeSlug });
  }

  function fetchStoreLeaderboard(storeSlug) {
    if (USE_FIXTURES) return fetchFixture('store-leaderboard-' + storeSlug);
    return gasCall('storeleaderboard', { store: storeSlug });
  }

  function fetchStoreBadges(storeSlug, period) {
    period = period || 'week';
    if (USE_FIXTURES) return fetchFixture('store-badges-' + storeSlug);
    return gasCall('storebadges', { store: storeSlug, period: period });
  }

  function fetchLeaderboardStaff(period) {
    if (USE_FIXTURES) return fetchFixture('leaderboard-staff');
    return gasCall('leaderboardstaff', { period: period || 'mtd' });
  }

  function fetchKioskAll(storeSlug) {
    return Promise.all([
      fetchStoreToday(storeSlug),
      fetchStoreLeaderboard(storeSlug),
      fetchStoreBadges(storeSlug, 'week'),
    ]).then(function(results) {
      return { today: results[0], leaderboard: results[1], badges: results[2] };
    });
  }

  return {
    USE_FIXTURES: USE_FIXTURES,
    GAS_URL: GAS_URL,
    login: login,
    fetchDirectorSummary: fetchDirectorSummary,
    fetchDirectorStores:  fetchDirectorStores,
    fetchDirectorStaff:   fetchDirectorStaff,
    fetchDirectorAlerts:  fetchDirectorAlerts,
    fetchDirectorAll:     fetchDirectorAll,
    fetchStoreToday:      fetchStoreToday,
    fetchStoreLeaderboard:fetchStoreLeaderboard,
    fetchStoreBadges:     fetchStoreBadges,
    fetchKioskAll:        fetchKioskAll,
    fetchLeaderboardStaff: fetchLeaderboardStaff,
  };
})();
