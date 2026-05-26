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

  var USE_FIXTURES = false;

  // Deployed GAS web app URL.
  var GAS_URL = 'https://script.google.com/macros/s/AKfycbxXqtL-rKjuzFQkyADWnHGEoM2ZSYp9g4t1J6vhyDTgHcfkEuQocYrN9DXV7_84Masuqg/exec';

  // Fixtures base path (relative to index.html)
  var FX = 'src/fixtures/';

  // ── Cache (two-tier: memory + localStorage) ───────────────
  // Serves stale data instantly while a background fetch updates the cache.
  var _mem = {};  // { key: { data, ts } }  — cleared on page reload

  function _getCached(key, ttlMs) {
    // 1. In-memory (fastest — same-session navigation)
    var m = _mem[key];
    if (m && (Date.now() - m.ts) < ttlMs) return m.data;
    // 2. localStorage (survives page reload / returning visit)
    try {
      var raw = localStorage.getItem('gc_cache_' + key);
      if (raw) {
        var entry = JSON.parse(raw);
        if (Date.now() - entry.ts < ttlMs) {
          _mem[key] = entry; // promote to memory
          return entry.data;
        }
      }
    } catch(e) {}
    return null;
  }

  function _setCache(key, data) {
    var entry = { data: data, ts: Date.now() };
    _mem[key] = entry;
    try { localStorage.setItem('gc_cache_' + key, JSON.stringify(entry)); } catch(e) {}
  }

  // Stale-while-revalidate wrapper.
  // Returns a Promise that resolves immediately with cached data (if fresh),
  // or with the network response if no cache. Either way a background network
  // request always runs; when it lands, onFresh(data) is called if provided.
  function _withCache(key, ttlMs, fetcher, onFresh) {
    var cached = _getCached(key, ttlMs);
    var networkPromise = fetcher().then(function(data) {
      _setCache(key, data);
      return data;
    });
    if (cached) {
      if (onFresh) networkPromise.then(onFresh).catch(function() {});
      return Promise.resolve(cached);
    }
    return networkPromise;
  }

  // ── JSONP helper (same pattern as greencross-inventory) ──
  var _cbIndex = 0;
  function jsonp(url, params) {
    return new Promise(function(resolve, reject) {
      var cbName = '__gc_cb_' + (++_cbIndex);
      var timeout = setTimeout(function() {
        delete window[cbName];
        reject(new Error('JSONP timeout: ' + url));
      }, 45000);

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
    return fetch(FX + filename + '.json', { cache: 'no-store' })
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
    'sky':     { role: 'director',      storeSlug: null,         storeName: null,         initials: 'SP', displayName: 'Sky Pinnick' },
    'dean':    { role: 'store_manager', storeSlug: 'baseline',   storeName: 'Baseline',   initials: 'DD', displayName: 'Dean Deloof' },
    'tj':      { role: 'store_manager', storeSlug: 'river',      storeName: 'River',      initials: 'TP', displayName: 'TJ Peterson' },
    'scott':   { role: 'store_manager', storeSlug: 'portland',   storeName: 'Portland',   initials: 'SP', displayName: 'Scott Penner' },
    'tyson':   { role: 'store_manager', storeSlug: 'center',     storeName: 'Center',     initials: 'TF', displayName: 'Tyson Farris' },
    'mariana': { role: 'store_manager', storeSlug: 'commercial', storeName: 'Commercial', initials: 'MM', displayName: 'Mariana Moxie' },
    'chris':   { role: 'store_manager', storeSlug: 'century',    storeName: 'Century',    initials: 'CC', displayName: 'Chris Carney' },
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

  function fetchSettings() {
    return gasCall('getsettings', {});
  }

  // Lightweight avatar data — employees list + avatarConfigs, no goals.
  // Accessible to all authenticated roles (not director-only).
  function fetchAvatarData() {
    return gasCall('getavatardata', {});
  }

  function saveSettings(plans, nicknames, excluded) {
    var params = {};
    if (plans)              params.plans     = JSON.stringify(plans);
    if (nicknames)          params.nicknames = JSON.stringify(nicknames);
    if (excluded !== undefined) params.excluded  = JSON.stringify(excluded);
    return gasCall('savesettings', params);
  }

  // Convenience: single GAS round-trip returning all four director payloads.
  // onFresh(data) — optional callback fired when background network refresh lands.
  function fetchDirectorAll(period, onFresh) {
    period = period || 'mtd';
    if (USE_FIXTURES) {
      return Promise.all([
        fetchFixture('director-summary'),
        fetchFixture('director-stores'),
        fetchFixture('director-staff'),
        fetchFixture('director-alerts'),
      ]).then(function(results) {
        return { summary: results[0], stores: results[1], staff: results[2], alerts: results[3] };
      });
    }
    var cacheKey = 'director_' + period;
    var TTL = 5 * 60 * 1000; // 5 minutes
    return _withCache(cacheKey, TTL, function() {
      return gasCall('directorall', { period: period });
    }, onFresh);
  }

  // ── Public: Store / Kiosk endpoints ───────────────────
  // (stubs for Phase 2)

  function fetchStoreToday(storeSlug, opts) {
    opts = opts || {};
    if (USE_FIXTURES) return fetchFixture('store-today-' + storeSlug);
    var extra = { store: storeSlug };
    if (opts.sinceTs) extra.sinceTs = opts.sinceTs;
    return gasCall('storetoday', extra);
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

  // onFresh(data) — optional callback fired when background network refresh lands.
  function fetchKioskAll(storeSlug, onFresh) {
    var cacheKey = 'kiosk_' + storeSlug;
    var TTL = 3 * 60 * 1000; // 3 minutes (kiosk data changes more frequently)
    if (USE_FIXTURES) {
      return Promise.all([
        fetchStoreToday(storeSlug),
        fetchStoreLeaderboard(storeSlug),
        fetchStoreBadges(storeSlug, 'week'),
      ]).then(function(results) {
        return { today: results[0], leaderboard: results[1], badges: results[2] };
      });
    }
    return _withCache(cacheKey, TTL, function() {
      return Promise.all([
        fetchStoreToday(storeSlug),
        fetchStoreLeaderboard(storeSlug),
        fetchStoreBadges(storeSlug, 'week'),
      ]).then(function(results) {
        return { today: results[0], leaderboard: results[1], badges: results[2] };
      });
    }, onFresh);
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
    fetchSettings:    fetchSettings,
    fetchAvatarData:  fetchAvatarData,
    saveSettings:     saveSettings,
    gasCall:          gasCall,
  };
})();
