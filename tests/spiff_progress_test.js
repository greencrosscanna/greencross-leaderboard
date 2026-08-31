#!/usr/bin/env node
/* SPIFF progress -> kiosk staff cards (spiff.gs).
 *
 * These guard the three ways this join has already gone wrong somewhere in the suite, all of
 * which fail SILENTLY — no error, just money missing from a screen:
 *
 *   1. FILTERING ON pay_period AS A STRING. SPIFF stores it as a human-readable RANGE
 *      ("2026-08-17 - 2026-08-30"), not a start date. Crew asked for "2026-08-17", matched
 *      nothing, and every person's column read $0 — indistinguishable from a fortnight where
 *      nobody sold anything. We filter on the WINDOW instead, so these assert overlap.
 *
 *   2. JOINING ON THE WRONG ID. SPIFF's employee_id is DUTCHIE'S numeric id (44905), not a GX
 *      Core slug. Matching raw against slugs found nobody and fell through to name matching,
 *      which reassigns money on a rename.
 *
 *   3. TREATING ZERO AS ABSENT. Somebody at 2 of 5 has earned 0 and must still get a card row;
 *      that half-filled row is the entire point of the feature. Only "no programme at all"
 *      is absent.
 *
 * Per tests/_harness.js's rule these never reimplement — spiff.gs is read off disk and the real
 * functions are called.
 */
'use strict';
const { load, run, _eq_, _ok_ } = require('./_harness');

/* A settable Properties stub, so the "Include SPIFF" switch can be tested at the value level.
   GC_SPIFF_SHOW_KEY lives in dutchie_proxy.gs, which we do not load here — spiff.gs reads it as a
   free variable, so the sandbox supplies it under the same name the shipped constant uses. */
const store = {};
const M = load(['spiff.gs'], {
  stubs: {
    GC_SPIFF_SHOW_KEY: 'GC_SPIFF_SHOW',
    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
          setProperty: function (k, v) { store[k] = String(v); },
        };
      },
    },
  },
});
const setShow = (v) => { if (v === undefined) delete store.GC_SPIFF_SHOW; else store.GC_SPIFF_SHOW = v; };

const PP_START = '2026-08-17', PP_END = '2026-08-30';

/* Shaped exactly like the live payload, captured from SPIFF 2026-08-29. */
function row(over) {
  return Object.assign({
    program_id: 'green-cross-test-202608',
    pay_period: '2026-08-17 - 2026-08-30',
    store_id:   'bend',
    employee_id: 44905,
    name:       'Nathan Wydick',
    units:      110,
    target:     55,
    hit:        true,
    earned:     25,
    vendor:     'Green Cross',
    program_name: 'Green Cross - Test4',
    start_date: '2026-08-17',
    end_date:   '2026-08-30',
    status:     'active',
  }, over || {});
}

const tests = {

  /* store_id is GX Core's id ('bend'), NOT our slug ('century'). Filtering by the slug would
     silently return nothing for every store whose two names differ. */
  filtersToTheRequestedStore() {
    const rows = [row(), row({ store_id: 'river-rd', employee_id: 1 })];
    _eq_('only bend rows', M.spiffFilterRows_(rows, 'bend', PP_START, PP_END).length, 1);
    _eq_('slug does not match a core id',
         M.spiffFilterRows_(rows, 'century', PP_START, PP_END).length, 0);
    _eq_('store id is case/space insensitive',
         M.spiffFilterRows_([row({ store_id: ' Bend ' })], 'bend', PP_START, PP_END).length, 1);
  },

  /* THE CREW BUG. A programme counts when its window OVERLAPS the pay period — it is not
     required to line up with it, and its pay_period STRING is never consulted. */
  windowOverlapNotStringMatch() {
    const f = (o) => M.spiffFilterRows_([row(o)], 'bend', PP_START, PP_END).length;
    _eq_('exactly the period',        f({}), 1);
    _eq_('starts mid-period',         f({ start_date: '2026-08-24', end_date: '2026-09-06' }), 1);
    _eq_('ends mid-period',           f({ start_date: '2026-08-04', end_date: '2026-08-20' }), 1);
    _eq_('spans the whole period',    f({ start_date: '2026-01-01', end_date: '2026-12-31' }), 1);
    _eq_('one day of overlap counts', f({ start_date: '2026-08-30', end_date: '2026-09-12' }), 1);
    _eq_('entirely before',           f({ start_date: '2026-08-01', end_date: '2026-08-16' }), 0);
    _eq_('entirely after',            f({ start_date: '2026-08-31', end_date: '2026-09-13' }), 0);
    /* A mismatched pay_period string must NOT exclude a row whose dates overlap — that
       string is SPIFF's formatting, not the fact. */
    _eq_('bogus pay_period string is ignored',
         f({ pay_period: 'whatever SPIFF prints next' }), 1);
  },

  /* A row we cannot place in time is dropped rather than guessed at: showing a tick for a
     programme that may have ended last month is worse than showing none. */
  undatedRowsAreDropped() {
    const f = (o) => M.spiffFilterRows_([row(o)], 'bend', PP_START, PP_END).length;
    _eq_('no start_date', f({ start_date: '' }), 0);
    _eq_('no end_date',   f({ end_date: null }), 0);
    _eq_('junk date',     f({ start_date: 'Aug 17' }), 0);
    _eq_('null row',      M.spiffFilterRows_([null], 'bend', PP_START, PP_END).length, 0);
  },

  /* Dates arrive as TEXT and are compared as text. Constructing a Date here is what shifted
     SPIFF's own window a day (fixed their side 2026-08-29); an ISO timestamp must still
     place correctly on its date. */
  datesAreComparedAsText() {
    const rows = [row({ start_date: '2026-08-17T00:00:00.000Z', end_date: '2026-08-30T00:00:00.000Z' })];
    _eq_('ISO timestamps truncate to their date',
         M.spiffFilterRows_(rows, 'bend', PP_START, PP_END).length, 1);
  },

  /* Keyed by the Dutchie id as a STRING — comparing 44905 to '44905' is exactly the silent
     miss this join exists to avoid. */
  indexesByDutchieIdAsString() {
    const idx = M.spiffIndexByEmployee_([row()]);
    _ok_('numeric id is indexed under its string form', !!idx['44905']);
    _eq_('earned carried', idx['44905'].earned, 25);
    _eq_('one programme',  idx['44905'].programs.length, 1);
    _eq_('no rows -> empty index', Object.keys(M.spiffIndexByEmployee_([])).length, 0);
    _eq_('row with no employee_id is skipped',
         Object.keys(M.spiffIndexByEmployee_([row({ employee_id: '' })])).length, 0);
  },

  /* ZERO IS NOT ABSENT — the assertion this whole feature rests on. */
  zeroEarnedStillGetsARow() {
    const idx = M.spiffIndexByEmployee_([row({ units: 2, target: 5, hit: false, earned: 0 })]);
    _ok_('somebody short of target is present', !!idx['44905']);
    _eq_('their earned is zero, not missing', idx['44905'].earned, 0);
    const lead = M.spiffLeadProgram_(idx['44905']);
    _eq_('and they still get a lead programme', lead.lead.units, 2);
    _eq_('with the target to fill toward',      lead.lead.target, 5);
  },

  /* Several programmes: lead with the one still in reach, not an arbitrary first row. */
  leadProgramPrefersTheOneStillInReach() {
    const idx = M.spiffIndexByEmployee_([
      row({ program_id: 'a', units: 110, target: 55, hit: true,  earned: 25 }),
      row({ program_id: 'b', units: 1,   target: 10, hit: false, earned: 0  }),
      row({ program_id: 'c', units: 8,   target: 10, hit: false, earned: 0  }),
    ]);
    const pick = M.spiffLeadProgram_(idx['44905']);
    _eq_('closest unhit programme leads', pick.lead.program_id, 'c');
    _eq_('the other two are counted, not hidden', pick.more, 2);
    _eq_('total earned sums every programme', pick.totalEarned, 25);
  },

  /* Nothing left to chase — show the win rather than an arbitrary row. */
  leadProgramFallsBackToBiggestPayout() {
    const idx = M.spiffIndexByEmployee_([
      row({ program_id: 'a', hit: true, earned: 10 }),
      row({ program_id: 'b', hit: true, earned: 40 }),
    ]);
    const pick = M.spiffLeadProgram_(idx['44905']);
    _eq_('biggest payout leads when all are hit', pick.lead.program_id, 'b');
    _eq_('total is the sum, not the lead', pick.totalEarned, 50);
  },

  emptyEntryHasNoLead() {
    _eq_('no programmes -> null', M.spiffLeadProgram_({ programs: [] }), null);
    _eq_('undefined entry -> null', M.spiffLeadProgram_(undefined), null);
  },

  /* A target of 0 would divide by zero in the ranking. It must not throw, and must not be
     treated as "still in reach". */
  zeroTargetDoesNotBreakRanking() {
    const idx = M.spiffIndexByEmployee_([
      row({ program_id: 'z', units: 0, target: 0, hit: false, earned: 0 }),
      row({ program_id: 'y', units: 3, target: 6, hit: false, earned: 0 }),
    ]);
    const pick = M.spiffLeadProgram_(idx['44905']);
    _eq_('the real programme leads', pick.lead.program_id, 'y');
  },
  /* THE SWITCH. Default OFF: a SPIFF programme is a vendor arrangement that is not always
     running — there was exactly one live on 2026-08-29 — so defaulting on would put an empty
     bar on most cards at most stores. */
  spiffRowIsOffUntilSwitchedOn() {
    setShow(undefined);
    _eq_('unset property means off', M.spiffShowEnabled_(), false);
    setShow('true');
    _eq_('on when set to true',      M.spiffShowEnabled_(), true);
    setShow('false');
    _eq_('off when set to false',    M.spiffShowEnabled_(), false);
    setShow(undefined);
  },

  /* THE TEXT-BOOLEAN TRAP. The value round-trips through Properties as a STRING, and
     Boolean('false') is true — the suite has a rule about this precisely because it has bitten
     before. Only the exact string 'true' may enable the row. */
  onlyTheStringTrueCountsAsOn() {
    ['false', 'FALSE', 'False', '0', '', 'no', 'off', 'null', 'undefined'].forEach(function (v) {
      setShow(v);
      _eq_('"' + v + '" is not on', M.spiffShowEnabled_(), false);
    });
    /* Not even a near-miss of the real value: a stray 'True' is a config typo, and silently
       honouring it would hide the typo until somebody wondered why the kiosk changed. */
    setShow('True');
    _eq_('"True" is not on (case matters)', M.spiffShowEnabled_(), false);
    setShow(undefined);
  },

  /* CLOSED PROGRAMMES. spiffFilterRows_ keeps anything whose window overlaps, and a closed
     programme keeps its dates — so on 2026-08-30 the closed "BeGoat Energy Drinks" (Aug 1 →
     Aug 31) drew on 23 of 40 live cards while SPIFF showed exactly one programme running.
     SPIFF added `status` (draft|active|closed) that day; this is the field, not a proxy. */
  closedProgrammesAreDropped() {
    const running = row();
    const closed  = row({ program_id: 'begoat-0826', status: 'closed',
                          program_name: 'BeGoat Energy Drinks', vendor: 'BeGOAT',
                          start_date: '2026-08-01', end_date: '2026-08-31',
                          units: 7, target: 3 });
    const kept = M.spiffActiveRows_([running, closed]);
    _eq_('one row survives', kept.length, 1);
    _eq_('and it is the running one', kept[0].program_name, 'Green Cross - Test4');

    /* The closed row DOES pass the window filter — proving spiffActiveRows_ is what drops it
       and not a date accident, so this fails if the call is ever quietly removed. */
    _eq_('closed row overlaps the pay period',
         M.spiffFilterRows_([closed], 'bend', PP_START, PP_END).length, 1);
  },

  /* draft is not active either — a programme being written must not reach the kiosk. */
  onlyActiveSurvives() {
    ['closed', 'draft', 'ACTIVEX', 'inactive'].forEach(function (st) {
      _eq_(st + ' is dropped', M.spiffActiveRows_([row(), row({ status: st })]).length, 1);
    });
    _eq_('case and padding are tolerated on the real value',
         M.spiffActiveRows_([row({ status: ' Active ' })]).length, 1);
  },

  /* UNKNOWN IS NOT ACTIVE. A cached row whose programme vanished from the programs tab comes
     back with status '' and its id in orphan_program_ids. Showing a programme nobody can look
     up is worse than showing none — but only once OTHER rows prove the field is populated. */
  orphanRowsAreDroppedWhenTheFieldIsPresent() {
    const orphan = row({ program_id: 'gone-0001', status: '' });
    _eq_('orphan dropped alongside a real active row',
         M.spiffActiveRows_([row(), orphan]).length, 1);
    _eq_('missing field dropped too',
         M.spiffActiveRows_([row(), row({ status: undefined })]).length, 1);
    _eq_('null dropped too',
         M.spiffActiveRows_([row(), row({ status: null })]).length, 1);
  },

  /* FAILS SAFE, and note the ASYMMETRY with the orphan rule: a missing status only means
     "not active" when something else proves SPIFF is still sending the field. If NOTHING
     carries it, the field regressed — blanking the SPIFF row on every card at every store
     would be far worse than showing a stale programme, so the filter stands down. */
  losingTheFieldEntirelyDegradesRatherThanBlanks() {
    const none = [row({ status: '' }), row({ status: undefined }), row({ status: null })];
    _eq_('no statuses anywhere → nothing is dropped', M.spiffActiveRows_(none).length, 3);
    _eq_('empty input is safe', M.spiffActiveRows_([]).length, 0);
    _eq_('null input is safe',  M.spiffActiveRows_(null).length, 0);
  },

  /* pay_period must NOT be consulted. It was the original stopgap signal and SPIFF still
     sends it; a closed programme carrying a stamp, or an active one missing it, must now
     follow `status` alone. This is what stops the inference creeping back in. */
  payPeriodIsNoLongerTheSignal() {
    const activeNoStamp = row({ status: 'active', pay_period: '' });
    _eq_('active with no stamp is KEPT', M.spiffActiveRows_([activeNoStamp]).length, 1);
    const closedStamped = row({ status: 'closed', pay_period: '2026-08-17 - 2026-08-30' });
    _eq_('closed with a stamp is DROPPED',
         M.spiffActiveRows_([row(), closedStamped]).length, 1);
  },

  /* THE DIAGNOSTIC MUST AGREE WITH THE KIOSK. diagSpiff_ deliberately does not call
     spiffForStore_ (that short-circuits when the row is off), so it rebuilds the chain by
     hand — and for one deploy it rebuilt the OLD one, reporting closed programmes the kiosk
     had already stopped drawing. It is read exactly when somebody is deciding whether to
     switch the row on, so a stale answer there is the most expensive kind. */
  diagUsesTheSameFilterChainAsTheKiosk() {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'spiff.gs'), 'utf8');
    const body = src.slice(src.indexOf('function diagSpiff_'));
    const end  = body.indexOf('\n}');
    const diag = body.slice(0, end);
    _ok_('diagSpiff_ filters to active rows', /spiffActiveRows_\s*\(/.test(diag));
    _ok_('and does NOT filter raw.rows by store directly',
         !/spiffFilterRows_\s*\(\s*raw\.rows/.test(diag));
    _ok_('reports what it dropped', /rowsNotActive/.test(diag));
  },

  /* Off means no fetch at all — the switch is also the kill switch if SPIFF misbehaves.
     UrlFetchApp.fetch throws in the harness, so reaching the network here would fail loudly. */
  offSkipsTheFetchEntirely() {
    setShow('false');
    const res = M.spiffForStore_({ slug: 'century' });
    _eq_('returns not-ok', res.ok, false);
    _eq_('no cards',       Object.keys(res.byId).length, 0);
    _ok_('says why',       /disabled/i.test(res.error || ''));
    setShow(undefined);
  },
};

run('spiff_progress', tests);
