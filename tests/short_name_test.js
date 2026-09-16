// ============================================================
//  Two Zachs, two Nates — the name the kiosk shows
//  (gx_roster.gs gxShortNameOf_ · goals.gs getNicknames_ ·
//   endpoints.gs applyNickname_)
//
//  The board shows one name per tile and has no room for a
//  surname, so for years the disambiguator was written into
//  preferred_name itself: "Zach B" for Zachary Babcock. That
//  read correctly here and wrong in every app that also shows a
//  surname ("Zach B Babcock"), and it left the two Nates —
//  Nathaniel Schneider and Robert Wydick, both "Nate" — with no
//  disambiguator at all.
//
//  GX Core derives short_name for exactly this surface, so the
//  kiosk reads that instead -- but ONLY for the people who would
//  otherwise be indistinguishable. Sky's call, 2026-09-15: the
//  board stays first names, four tiles gain an initial.
//
//  The other half is the transition: until preferred_name is
//  cleared back to plain "Zach", Core's short_name derives to
//  "Zach B B". Both data states are asserted below, because the
//  code fix and the data write land at different times and a
//  wall screen has to read correctly in the gap either way.
//
//  Run:  node tests/short_name_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

// TODAY's live GX Core rows, verbatim from ?action=employees on 2026-09-15 — including the
// short_name Core actually derives right now, doubled initial and all.
const ROWS_BEFORE = [
  { employee_id: 'zachary_babcock',     full_name: 'Zachary Babcock',     preferred_name: 'Zach B', short_name: 'Zach B B', dutchie_employee_id: '901', home_store: 'hillsboro',   status: 'active' },
  { employee_id: 'zachary_rodriguez',   full_name: 'Zachary Rodriguez',   preferred_name: 'Zach R', short_name: 'Zach R R', dutchie_employee_id: '902', home_store: 'hillsboro',   status: 'active' },
  { employee_id: 'nathaniel_schneider', full_name: 'Nathaniel Schneider', preferred_name: 'Nate',   short_name: 'Nate S',   dutchie_employee_id: '903', home_store: 'portland-rd', status: 'active' },
  { employee_id: 'robert_wydick',       full_name: 'Robert Wydick',       preferred_name: 'Nate',   short_name: 'Nate W',   dutchie_employee_id: '904', home_store: 'portland-rd', status: 'active' },
  { employee_id: 'casey_nguyen',        full_name: 'Casey Nguyen',        preferred_name: '',       short_name: 'Casey N',  dutchie_employee_id: '905', home_store: 'portland-rd', status: 'active' },
  { employee_id: 'christopher_carney',  full_name: 'Christopher Carney',  preferred_name: 'Chris',  short_name: 'Chris C',  dutchie_employee_id: '906', home_store: 'portland-rd', status: 'active' },
  // Left the company, and answered to Chris. A retired row must NOT be what puts an initial on
  // somebody who is still here -- so this one deliberately collides with Christopher Carney above.
  { employee_id: 'christina_vale',      full_name: 'Christina Vale',      preferred_name: 'Chris',  short_name: 'Chris V',  dutchie_employee_id: '907', home_store: 'portland-rd', status: 'retired' },
];

// AFTER core-admin clears preferred_name to the plain nickname. Core's own derivation then produces
// the short form with no help from us.
const ROWS_AFTER = ROWS_BEFORE.map(function (r) {
  const p = { zachary_babcock: ['Zach', 'Zach B'], zachary_rodriguez: ['Zach', 'Zach R'] }[r.employee_id];
  return p ? Object.assign({}, r, { preferred_name: p[0], short_name: p[1] }) : r;
});

// An older pinned GXCore that does not derive short_name at all. Not hypothetical: the decoration
// was added to getEmployees() on 2026-09-03, and a spoke runs the version IT pins.
const ROWS_NO_SHORT = ROWS_BEFORE.map(function (r) {
  const c = Object.assign({}, r); delete c.short_name; return c;
});

const CORE_STORES = [
  { store_id: 'bend',        display_name: 'Century',    dutchie_name: 'Bend',        color: '#fff', sort_order: '1' },
  { store_id: 'center',      display_name: 'Center',     dutchie_name: 'Center',      color: '#fff', sort_order: '2' },
  { store_id: 'commercial',  display_name: 'Commercial', dutchie_name: 'Commercial',  color: '#fff', sort_order: '3' },
  { store_id: 'hillsboro',   display_name: 'Baseline',   dutchie_name: 'Hillsboro',   color: '#fff', sort_order: '4' },
  { store_id: 'portland-rd', display_name: 'Portland',   dutchie_name: 'Portland Rd', color: '#fff', sort_order: '5' },
  { store_id: 'river-rd',    display_name: 'River',      dutchie_name: 'River Rd',    color: '#fff', sort_order: '6' },
];

const APP_ROSTER = {
  baseline: [
    { id: '901', name: 'Zachary Babcock',   initials: 'ZB' },
    { id: '902', name: 'Zachary Rodriguez', initials: 'ZR' },
  ],
  portland: [
    { id: '903', name: 'Nathaniel Schneider', initials: 'NS' },
    { id: '904', name: 'Robert Wydick',       initials: 'RW' },
    { id: '905', name: 'Casey Nguyen',        initials: 'CN' },
    { id: '906', name: 'Christopher Carney',  initials: 'CC' },
    { id: '907', name: 'Christina Vale',      initials: 'CV' },
  ],
};

const rosterProps = {
  getProperty: function (k) {
    return k === 'GC_STORE_EMPLOYEES_JSON' ? JSON.stringify(APP_ROSTER) : null;
  },
  setProperty: function () { return this; },
  deleteProperty: function () { return this; },
  getProperties: function () { return {}; },
  setProperties: function () { return this; },
};

/** Load the shipped source with GX Core answering `rows`. */
function app(rows) {
  return H.load(['gx_roster.gs', 'dutchie_proxy.gs', 'endpoints.gs', 'dutchie_fetch.gs', 'goals.gs', 'auth.gs', 'discounts.gs'], {
    stubs: {
      PropertiesService: {
        getScriptProperties:   function () { return rosterProps; },
        getUserProperties:     function () { return rosterProps; },
        getDocumentProperties: function () { return rosterProps; },
      },
      GXCore: {
        getEmployees: function () { return rows; },
        getStores:    function () { return CORE_STORES; },
      },
    },
  });
}

/** What the kiosk, ticker and shift views actually render for a Dutchie name. */
function onScreen(S, dutchieName) {
  return S.applyNickname_(dutchieName, S.getNicknames_());
}

// ── The doubled initial, on its own ──────────────────────────────────────────────────────────────
function test_doubledTrailingInitialCollapses_() {
  const S = app(ROWS_BEFORE);
  _eq_('the shape this exists for',   S.gxShortNameOf_('Zach B B'), 'Zach B');
  _eq_('periods do not hide it',      S.gxShortNameOf_('Zach B. B.'), 'Zach B');
  _eq_('whitespace does not hide it', S.gxShortNameOf_('  Zach   B   B '), 'Zach B');

  // Fires on ONE shape. Everything else is somebody's real name and passes straight through.
  _eq_('a single initial is the normal case',    S.gxShortNameOf_('Nate S'),    'Nate S');
  _eq_('two DIFFERENT initials are not a repeat', S.gxShortNameOf_('Zach B R'),  'Zach B R');
  _eq_('a two-word nickname is not a repeat',     S.gxShortNameOf_('Mary Jo B'), 'Mary Jo B');
  _eq_('nothing would survive — leave it alone',  S.gxShortNameOf_('B B'),       'B B');
  _eq_('absent stays absent',                     S.gxShortNameOf_(''),          '');
  _eq_('null stays absent',                       S.gxShortNameOf_(null),        '');
}

// ── The board, in the data state we are in TODAY ─────────────────────────────────────────────────
function test_boardReadsRight_beforeCoreClearsPreferredName_() {
  const S = app(ROWS_BEFORE);
  _eq_('NOT "Zach B B" — the whole point of being able to ship first', onScreen(S, 'Zachary Babcock'), 'Zach B');
  _eq_('NOT "Zach R R"',                                              onScreen(S, 'Zachary Rodriguez'), 'Zach R');
  _eq_('the two Nates were ambiguous and nobody filed it',            onScreen(S, 'Nathaniel Schneider'), 'Nate S');
  _eq_('the other Nate, told apart at last',                          onScreen(S, 'Robert Wydick'), 'Nate W');
}

// ── AND NOBODY ELSE. The board stays first names; four tiles gained an initial, not forty. ───────
function test_everyoneUnambiguousKeepsTheirFirstName_() {
  const S = app(ROWS_BEFORE);
  _eq_('a nickname with nobody to be confused with stays bare', onScreen(S, 'Christopher Carney'), 'Chris');
  _eq_('no nickname either — first name, as before',            onScreen(S, 'Casey Nguyen'), 'Casey');
}

// Somebody who left is not a reason to put an initial on somebody who is still here.
function test_someoneWhoLeftDoesNotCauseACollision_() {
  const S = app(ROWS_BEFORE);
  _eq_('the other Chris is retired, so this one stays bare', onScreen(S, 'Christopher Carney'), 'Chris');
}

// ── The board, after core-admin's write ──────────────────────────────────────────────────────────
function test_boardReadsRight_afterCoreClearsPreferredName_() {
  const S = app(ROWS_AFTER);
  _eq_('same on screen — the data moved, the board did not', onScreen(S, 'Zachary Babcock'), 'Zach B');
  _eq_('same on screen — the data moved, the board did not', onScreen(S, 'Zachary Rodriguez'), 'Zach R');
  _eq_('untouched by the write',                             onScreen(S, 'Nathaniel Schneider'), 'Nate S');
  _eq_('untouched by the write',                             onScreen(S, 'Robert Wydick'), 'Nate W');
}

// Neither order leaves a wall screen wrong — which is the reason the collapse is worth carrying.
function test_orderOfTheTwoChangesDoesNotMatter_() {
  _eq_('before and after the data write agree',
       onScreen(app(ROWS_BEFORE), 'Zachary Babcock'),
       onScreen(app(ROWS_AFTER),  'Zachary Babcock'));
}

// ── An older pinned library that does not derive short_name ──────────────────────────────────────
function test_fallsBackToPreferredName_whenCoreDoesNotDeriveShortName_() {
  const S = app(ROWS_NO_SHORT);
  _ok_('a roster without short_name still produces a nickname map', Object.keys(S.getNicknames_()).length > 0);
  _eq_('the behavior we had before this change, not a blank', onScreen(S, 'Zachary Babcock'), 'Zach B');
  _eq_('ambiguous again, but no worse than it was',           onScreen(S, 'Nathaniel Schneider'), 'Nate');
  _eq_('no nickname, no short name — first name only',        onScreen(S, 'Casey Nguyen'), 'Casey');
}

// ── The casual name is taken off the SHORT name, not off preferred_name ──────────────────────────
// Group the two Zachs on preferred_name and they read "Zach B" and "Zach R" — two different names,
// no collision found, and the fix quietly does nothing the day Core clears the data.
function test_casualNameStripsCoresTrailingInitial_() {
  const S = app(ROWS_BEFORE);
  _eq_('the disambiguator comes back off', S.gxCasualNameOf_({ shortName: 'Zach B' }), 'Zach');
  _eq_('and off the doubled form too',     S.gxCasualNameOf_({ shortName: 'Zach B B' }), 'Zach B');
  _eq_('a two-word nickname survives',     S.gxCasualNameOf_({ shortName: 'Mary Jo B' }), 'Mary Jo');
  _eq_('no surname, nothing to strip',     S.gxCasualNameOf_({ shortName: 'Cher' }), 'Cher');
  _eq_('no short name — the nickname',     S.gxCasualNameOf_({ preferredName: 'Tre', fullName: 'Treshawn Jones' }), 'Tre');
  _eq_('neither — the legal first name',   S.gxCasualNameOf_({ fullName: 'Casey Nguyen' }), 'Casey');
}

H.run('short_name', {
  test_doubledTrailingInitialCollapses_,
  test_casualNameStripsCoresTrailingInitial_,
  test_boardReadsRight_beforeCoreClearsPreferredName_,
  test_everyoneUnambiguousKeepsTheirFirstName_,
  test_someoneWhoLeftDoesNotCauseACollision_,
  test_boardReadsRight_afterCoreClearsPreferredName_,
  test_orderOfTheTwoChangesDoesNotMatter_,
  test_fallsBackToPreferredName_whenCoreDoesNotDeriveShortName_,
});
