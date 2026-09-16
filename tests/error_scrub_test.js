// ============================================================
//  A secret must never reach the screen inside an error
//  (dutchie_proxy.gs scrubSecrets_ + doGet/doPost catches ·
//   dutchie_fetch.gs gxDutchieKeyMap_ / gxCoreRoute_ ·
//   auth.gs lbFetchCoreRoster_)
//
//  THE SHAPE, reported by SPIFF via core-admin 2026-09-15.
//  Three of this app's URLs carry a secret in the query string:
//
//    dutchie_keys?connector_secret=…   GX_CONNECTOR_SECRET — the
//                                      key that unlocks Dutchie
//    app_roster?…&secret=…             GX_DEPLOY_SECRET
//    gxCoreRoute_?…&secret=…           GX_DEPLOY_SECRET
//
//  `muteHttpExceptions: true` silences a STATUS code, NOT a
//  transport failure. An unreachable host still THROWS, and
//  Google's own message is "Address unavailable: <the whole
//  url>". Unscrubbed, that lands in the kiosk's error banner in
//  front of the shop.
//
//  WHAT THIS SUITE DELIBERATELY DOES NOT DO, because it is how
//  SPIFF's own version of this test passed while proving
//  nothing: it does not grep the file for the scrub. A scrub
//  somewhere in the file is not a scrub in the catch that
//  answers. Every case below runs the real function and reads
//  what it actually returns or throws, and each one was proven
//  red by removing the scrub it names.
//
//  Run:  node tests/error_scrub_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

// Stand-ins shaped like the real thing: long, opaque, and unmistakable if one shows up.
const CONNECTOR = 'CONNECTORSECRET-7f3a91b0c4d2e5';
const DEPLOY    = 'DEPLOYSECRET-2b8e4d6a0c1f93';

/** Exactly what UrlFetchApp throws when it cannot reach a host. */
function addressUnavailable(url) {
  const e = new Error('Address unavailable: ' + url);
  return e;
}

const props = {
  _v: { GX_CONNECTOR_SECRET: CONNECTOR, GX_DEPLOY_SECRET: DEPLOY },
  getProperty:    function (k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
  setProperty:    function (k, v) { this._v[k] = String(v); return this; },
  deleteProperty: function (k) { delete this._v[k]; return this; },
  getProperties:  function () { return Object.assign({}, this._v); },
  setProperties:  function (o) { Object.assign(this._v, o); return this; },
};

const CORE_STORES = [
  { store_id: 'hillsboro', display_name: 'Baseline', dutchie_name: 'Hillsboro', color: '#fff', sort_order: '1' },
];

/** `thrower` receives the URL and decides what UrlFetchApp does. */
function app(thrower, extraExports) {
  return H.load(['dutchie_proxy.gs', 'dutchie_fetch.gs', 'endpoints.gs', 'goals.gs', 'gx_roster.gs', 'auth.gs', 'discounts.gs'], {
    extraExports: extraExports || '',
    stubs: {
      PropertiesService: {
        getScriptProperties:   function () { return props; },
        getUserProperties:     function () { return props; },
        getDocumentProperties: function () { return props; },
      },
      UrlFetchApp: {
        fetch:    function (url) { return thrower(url); },
        fetchAll: function (reqs) { return (reqs || []).map(function (r) { return thrower(r && r.url); }); },
      },
      GXCore: {
        getStores:    function () { return CORE_STORES; },
        getEmployees: function () { return []; },
      },
      // The harness stub refuses this on purpose, so that a test cannot accidentally depend on it.
      // Here the SERVED BODY is the whole point — it is the string the browser gets — so stand up
      // the smallest thing that records it.
      ContentService: {
        createTextOutput: function (text) {
          return { _t: String(text), setMimeType: function () { return this; }, getContent: function () { return this._t; } };
        },
        MimeType: { JAVASCRIPT: 'application/javascript', JSON: 'application/json' },
      },
    },
  });
}

/** Every fetch dies the way an unreachable host dies. */
function unreachable(url) { throw addressUnavailable(url); }

/** Assert a string carries neither secret, and say which one leaked if it does. */
function noSecretIn(label, text) {
  const s = String(text == null ? '' : text);
  _ok_(label + ' — no connector secret', s.indexOf(CONNECTOR) === -1);
  _ok_(label + ' — no deploy secret',    s.indexOf(DEPLOY) === -1);
}

// ── 1. The helper, on the exact strings that reach it ────────────────────────────────────────────
function test_scrubSecrets_() {
  const S = app(unreachable);

  const connectorUrl = 'https://script.google.com/macros/s/AKfy.../exec?action=dutchie_keys&connector_secret=' + CONNECTOR;
  const out = S.scrubSecrets_('Address unavailable: ' + connectorUrl);
  noSecretIn('connector_secret', out);
  _ok_('the parameter is still named, so the message stays useful', /connector_secret=\[redacted\]/.test(out));
  _ok_('and the action survives', out.indexOf('action=dutchie_keys') !== -1);

  const deployUrl = 'https://script.google.com/macros/s/AKfy.../exec?action=app_roster&app=performance&secret=' + DEPLOY;
  noSecretIn('secret=', S.scrubSecrets_('Address unavailable: ' + deployUrl));

  // THE ANCHORED FORM MISSES THE ONE THAT MATTERS. An anchor-only helper requires the parameter to
  // follow a `?` or `&`; this app's highest-value secret travels as `connector_secret=`, where
  // `secret=` is preceded by an underscore. Asserted here so nobody "tidies" ours into that one.
  // Named as a SHAPE, not as an app: every shipped version in the suite has had a hole of its own,
  // so the rule is to derive the names from requireAuth_ rather than to copy anybody.
  const anchored = String('Address unavailable: ' + connectorUrl)
    .replace(/([?&](?:secret|token|key|pass|password)=)[^&\s]*/gi, '$1[redacted]');
  _ok_('the anchored form would have leaked it', anchored.indexOf(CONNECTOR) !== -1);

  // EVERY NAME THE SESSION TOKEN ARRIVES UNDER. requireAuth_ reads params.token || params.session
  // || params.auth, so a scrub that only knows `token=` leaves two of the three open.
  ['token', 'session', 'auth'].forEach(function (p) {
    noSecretIn('the session token as ' + p + '=', S.scrubSecrets_('boom at ?action=setplan&' + p + '=gx-dev:1:' + DEPLOY));
  });
  noSecretIn('a prefixed spelling', S.scrubSecrets_('?deploy_secret=' + DEPLOY + '&api_key=' + CONNECTOR));
  _eq_('nothing to scrub is left alone', S.scrubSecrets_('Dutchie 502: upstream'), 'Dutchie 502: upstream');
  _eq_('an absent message is a string',  S.scrubSecrets_(null), '');
  _eq_('an Error is accepted directly',  S.scrubSecrets_(new Error('secret=' + DEPLOY)), 'secret=[redacted]');
}

// ── 2. The Dutchie key fetch — the worst one, and unguarded until now ────────────────────────────
function test_dutchieKeyFetch_() {
  const S = app(unreachable);
  let msg = '';
  try { S.gxDutchieKeyMap_(); msg = '(it did not throw)'; }
  catch (e) { msg = (e && e.message) || String(e); }
  _ok_('it still fails loudly', msg.indexOf('Address unavailable') !== -1);
  noSecretIn('gxDutchieKeyMap_', msg);
}

// ── 3. gxCoreRoute_ — GX_DEPLOY_SECRET in the query string ───────────────────────────────────────
function test_gxCoreRoute_() {
  const S = app(unreachable);
  let msg = '';
  try { S.gxCoreRoute_('hourcurve', { store: 'baseline' }); msg = '(it did not throw)'; }
  catch (e) { msg = (e && e.message) || String(e); }
  noSecretIn('gxCoreRoute_', msg);
}

// ── 4. The sign-in roster read ───────────────────────────────────────────────────────────────────
// Its own catch folds the exception into `lastErr`, which is then re-thrown inside a longer
// sentence — so scrubbing only at the router would still have logged the secret here.
function test_coreRosterFetch_() {
  const S = app(unreachable);
  let msg = '';
  try { S.lbFetchCoreRoster_(props); msg = '(it did not throw)'; }
  catch (e) { msg = (e && e.message) || String(e); }
  _ok_('it still says what failed', /app_roster unreachable/.test(msg));
  noSecretIn('lbFetchCoreRoster_', msg);
}

// ── 5. THE ROUTER'S OWN CATCH, which is the one that answers the browser ─────────────────────────
// Driven through the real doGet. The thrower is reassigned rather than mocked around, so the catch
// under test is the shipped one and the reply is the real JSONP body the kiosk would render.
function test_doGetCatch_() {
  const S = app(unreachable,
    '"breakLogin": function (fn) { loginUser = fn; },' +
    '"breakRegistry": function () { refreshStoreRegistry_ = function () {}; }');
  S.breakRegistry();
  S.breakLogin(function () {
    throw addressUnavailable('https://script.google.com/macros/s/AKfy.../exec?action=app_roster&secret=' + DEPLOY);
  });

  const out = S.doGet({ parameter: { action: 'login', user: 'sky', pass: 'x' } }).getContent();
  noSecretIn('the doGet reply', out);
  _ok_('and it is still an error the client can read', /"ok":false/.test(out) && /Address unavailable/.test(out));
}

// The POST door is a separate catch and was leaking separately.
function test_doPostCatch_() {
  const S = app(unreachable,
    '"breakBugReport": function (fn) { handleBugReport_ = fn; },' +
    '"breakAuth": function () { requireAuth_ = function () { return { ok: true, user: "sky", role: "director" }; }; },' +
    '"breakRegistry": function () { refreshStoreRegistry_ = function () {}; }');
  S.breakRegistry();
  S.breakAuth();
  S.breakBugReport(function () {
    throw addressUnavailable('https://script.google.com/macros/s/AKfy.../exec?action=ingest_bug&secret=' + DEPLOY);
  });

  const out = S.doPost({ postData: { contents: JSON.stringify({ action: 'bugreport', token: 'x' }) } }).getContent();
  noSecretIn('the doPost reply', out);
  _ok_('still an error', /"ok":false/.test(out));
}

H.run('error_scrub', {
  test_scrubSecrets_,
  test_dutchieKeyFetch_,
  test_gxCoreRoute_,
  test_coreRosterFetch_,
  test_doGetCatch_,
  test_doPostCatch_,
});
