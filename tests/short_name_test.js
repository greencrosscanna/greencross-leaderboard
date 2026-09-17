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
  // Nate S covers shifts at Century, where the other Nate never works. The old ticker counted
  // first names per STORE, so his initial survived on the card here and vanished from the ticker.
  century: [
    { id: '903', name: 'Nathaniel Schneider', initials: 'NS' },
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
function app(rows, extraExports) {
  // spiff.gs is here for getStoreLeaderboard's spiffShowEnabled_ — the staff TILES come from that
  // function, and they are the surface the disambiguated name exists for.
  return H.load(['gx_roster.gs', 'dutchie_proxy.gs', 'endpoints.gs', 'dutchie_fetch.gs', 'goals.gs', 'auth.gs', 'discounts.gs', 'spiff.gs'], {
    extraExports: extraExports || '',
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

// ── The ticker and the staff card say the same thing ─────────────────────────────────────────────
// They did not. The ticker carried its own disambiguator, counting first names across one store's
// roster, and it rewrote a clash as "Zach R." — a period the card does not have — while on a day
// only one Zach worked it truncated to plain "Zach". Same person, two names, one screen.
function test_tickerSaysTheSameNameAsTheCard_() {
  const S = app(ROWS_BEFORE,
    '"setTxns": function (rows) { fetchStoreTransactions_ = function () { return rows; }; },' +
    '"resetCaches": function () { _propsCache_ = null; _ppStartCache_ = null; _gxRosterMemo_ = null; }');

  function txn(hour, total, id, name) {
    const hh = String(hour).padStart(2, '0');
    return {
      transactionType: 'Retail',
      transactionDateLocalTime: '2026-08-31T' + hh + ':30:00',
      transactionDate:          '2026-08-31T' + hh + ':30:00',
      total: total, totalBeforeTax: total, subtotal: total,
      employeeId: id, employeeName: name,
      itemsSold: [{ productName: 'Flower 1g', totalPrice: total, quantity: 1 }],
    };
  }

  try {
    H.setNow(Date.UTC(2026, 7, 31, 16 + 7, 0, 0));   // 4pm PDT
    S.resetCaches();

    // BOTH Zachs selling — the clash the old ticker code fired on.
    S.setTxns([txn(11, 120, '901', 'Zachary Babcock'), txn(12, 140, '902', 'Zachary Rodriguez')]);
    const both = S.getStoreToday({ slug: 'baseline', name: 'Baseline' }, {});
    const whoBoth = (both.ticker || []).map(function (t) { return t.who; }).sort();
    _eq_('no stray period, and both told apart', whoBoth, ['Zach B', 'Zach R']);

    // ONE Zach selling. The card still reads "Zach R", so the ticker must too — the old code
    // dropped the initial here, because nobody in THIS ticker clashed.
    H.setNow(Date.UTC(2026, 7, 31, 16 + 7, 0, 0));
    S.resetCaches();
    S.setTxns([txn(12, 140, '902', 'Zachary Rodriguez')]);
    const one = S.getStoreToday({ slug: 'baseline', name: 'Baseline' }, {});
    const card = (one.onShift || []).filter(function (e) { return /Zach/.test(e.name); })[0];
    _eq_('the ticker keeps the initial', (one.ticker || []).map(function (t) { return t.who; }), ['Zach R']);
    _eq_('and the card agrees with it',  card && card.name, 'Zach R');

    /* The other half, and SKY REVERSED IT ON 2026-09-17: "we only need to add the last initial if
       two people have the same name at the same store, so at Baseline we have two Zach's, we need
       it, at Century we only have one Nate, don't need it."
       Nathaniel Schneider covers a shift at Century; his twin works at Portland. He used to wear
       "Nate S" there because the collision was counted across all 42 live people — an initial
       telling him apart from somebody who cannot appear on that board. Now it is counted within
       the store, so Century reads the plain nickname.
       WHAT MUST STILL HOLD is that the card and the ticker AGREE. They disagreed once before, in
       the other direction, and that is the bug this test was written for — not the scope. */
    H.setNow(Date.UTC(2026, 7, 31, 16 + 7, 0, 0));
    S.resetCaches();
    S.setTxns([txn(13, 90, '903', 'Nathaniel Schneider')]);
    const away = S.getStoreToday({ slug: 'century', name: 'Century' }, {});
    const awayCard = (away.onShift || []).filter(function (e) { return /Nate/.test(e.name); })[0];
    _eq_('one Nate at this store, so no initial', (away.ticker || []).map(function (t) { return t.who; }), ['Nate']);
    _eq_('and the card still agrees with the ticker', awayCard && awayCard.name, 'Nate');

    // And at the store where BOTH Nates work, the initial is still required and still on both.
    H.setNow(Date.UTC(2026, 7, 31, 16 + 7, 0, 0));
    S.resetCaches();
    S.setTxns([txn(14, 90, '903', 'Nathaniel Schneider'), txn(15, 80, '904', 'Robert Wydick')]);
    const home = S.getStoreToday({ slug: 'portland', name: 'Portland' }, {});
    const homeWho = (home.ticker || []).map(function (t) { return t.who; }).sort();
    _eq_('two Nates at one store still get initials', homeWho, ['Nate S', 'Nate W']);

    /* THE STAFF CARDS, which are the surface Sky was actually looking at ("i'm in Century and
       looking at Nate W"). They come from getStoreLeaderboard, NOT getStoreToday — a different
       function with its own nickname map, and the first pass at guarding this scoping left it
       uncovered: removing the store argument there kept every assertion green. The ticker and the
       shift strip are not a proxy for the tile. */
    H.setNow(Date.UTC(2026, 7, 31, 16 + 7, 0, 0));
    S.resetCaches();
    S.setTxns([txn(16, 90, '903', 'Nathaniel Schneider')]);
    const cenLb = S.getStoreLeaderboard({ slug: 'century', name: 'Century' }, {});
    const cenTile = (cenLb.staff || []).filter(function (e) { return /Nate/.test(e.name); })[0];
    _eq_('the Century TILE reads the plain nickname', cenTile && cenTile.name, 'Nate');

    H.setNow(Date.UTC(2026, 7, 31, 16 + 7, 0, 0));
    S.resetCaches();
    S.setTxns([txn(17, 90, '903', 'Nathaniel Schneider'), txn(18, 80, '904', 'Robert Wydick')]);
    const porLb = S.getStoreLeaderboard({ slug: 'portland', name: 'Portland' }, {});
    const porTiles = (porLb.staff || []).filter(function (e) { return /Nate/.test(e.name); })
      .map(function (e) { return e.name; }).sort();
    _eq_('and the Portland tiles keep both initials', porTiles, ['Nate S', 'Nate W']);
  } finally {
    H.setNow(null);
  }
}

// ── The surname already told them apart ──────────────────────────────────────────────────────────
// The kiosk tile has no surname, so it needs the initial. The director's staff table HAS one, and
// pairing the initial with it reads "Zach B Babcock" — the disambiguator answering a question the
// surname beside it has already answered. Sky filed exactly that on 2026-09-16, the day after the
// tile fix shipped: "Zach B Babcock, should just be Zach Babcock".
//
// Driven through the REAL getDirectorStaff, with pre-aggregated sales standing in for Dutchie.
// Asserting the helper alone would not have caught it: gxCasualNameOf_ was already correct that
// day, and the bug was the caller reaching for the wrong one of the two maps.
function test_directorTableShowsTheCasualNameWithTheSurname_() {
  const S = app(ROWS_BEFORE);

  function emp(id, name, initials, sales) {
    return { id: id, name: name, initials: initials, sales: sales, transactions: 4, items: 8,
             discounts: 0, discountsBdt: 0, subtotal: sales };
  }
  const pre = { byStoreAgg: { baseline: { byEmployee: {
    zachary_babcock:   emp('901', 'Zachary Babcock',   'ZB', 900),
    zachary_rodriguez: emp('902', 'Zachary Rodriguez', 'ZR', 800),
    casey_nguyen:      emp('905', 'Casey Nguyen',      'CN', 700),
    christopher_carney:emp('906', 'Christopher Carney','CC', 600),
  } } } };

  try {
    H.setNow(Date.UTC(2026, 7, 31, 16 + 7, 0, 0));
    const byName = {};
    (S.getDirectorStaff({ period: 'mtd' }, pre).staff || []).forEach(function (s) {
      byName[s.nameKey] = s;
    });

    _eq_('NOT "Zach B Babcock" — the bug as reported',
         byName.zachary_babcock && byName.zachary_babcock.fullName, 'Zach Babcock');
    _eq_('the other Zach, same rule',
         byName.zachary_rodriguez && byName.zachary_rodriguez.fullName, 'Zach Rodriguez');
    _eq_('a nickname with nobody to be confused with was never touched',
         byName.christopher_carney && byName.christopher_carney.fullName, 'Chris Carney');
    _eq_('no nickname at all still means the full Dutchie name',
         byName.casey_nguyen && byName.casey_nguyen.fullName, 'Casey Nguyen');

    // The other half of the same row is unchanged: the SHORT name still carries the initial,
    // because that one is what the kiosk paints and it has no surname to lean on.
    _eq_('the tile keeps its disambiguator',
         byName.zachary_babcock && byName.zachary_babcock.name, 'Zach B');
    _eq_('and so does the other one',
         byName.zachary_rodriguez && byName.zachary_rodriguez.name, 'Zach R');
  } finally {
    H.setNow(null);
  }
}

// Same assertion on the other side of core-admin's data write, for the same reason the tile fix
// asserts both: the code change and the data change land at different times, and the screen has to
// read right in the gap either way.
//
// Read the records out of the REAL roster build rather than hand-rolling one. shortName on a record
// has already been through gxShortNameOf_, so a literal "Zach B B" here would be a state that never
// reaches this function — a test that fails on an input production cannot produce.
function test_directorNameReadsRight_onBothSidesOfCoresDataWrite_() {
  function displayOf(rows, key) {
    const S = app(rows);
    const recs = S.gxAllRecs_();
    const hit = Object.keys(recs).map(function (k) { return recs[k]; })
      .filter(function (r) { return r.employeeId === key; })[0];
    return hit && S.gxDisplayNameOf_(hit);
  }

  _eq_('today, with the initial still smuggled into preferred_name',
       displayOf(ROWS_BEFORE, 'zachary_babcock'), 'Zach Babcock');
  _eq_('after core-admin clears it back to plain "Zach"',
       displayOf(ROWS_AFTER,  'zachary_babcock'), 'Zach Babcock');
  _eq_('an older pinned library that derives no short_name at all',
       displayOf(ROWS_NO_SHORT, 'zachary_babcock'), 'Zach Babcock');
  _eq_('no nickname — the legal name, untouched',
       displayOf(ROWS_BEFORE, 'casey_nguyen'), 'Casey Nguyen');
}

H.run('short_name', {
  test_tickerSaysTheSameNameAsTheCard_,
  test_directorTableShowsTheCasualNameWithTheSurname_,
  test_directorNameReadsRight_onBothSidesOfCoresDataWrite_,
  test_doubledTrailingInitialCollapses_,
  test_casualNameStripsCoresTrailingInitial_,
  test_boardReadsRight_beforeCoreClearsPreferredName_,
  test_everyoneUnambiguousKeepsTheirFirstName_,
  test_someoneWhoLeftDoesNotCauseACollision_,
  test_boardReadsRight_afterCoreClearsPreferredName_,
  test_orderOfTheTwoChangesDoesNotMatter_,
  test_fallsBackToPreferredName_whenCoreDoesNotDeriveShortName_,
});
