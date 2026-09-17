// ============================================================
//  A part period is compared against the SAME PART of the one
//  before it  (endpoints.gs getPriorRange_ / getPriorFullRange_
//  / getDirectorSummary)
//
//  Sky, 2026-09-16: "Tranactions, should show vs the same time
//  in period, we are 3 days into the period, it should show if
//  we're +/- to the first 3 days of last period, not the whole
//  period."
//
//  He was reading a card that compared three days against
//  fourteen. getDateRange_('pp') runs to ppEndMs — the end of
//  the WHOLE period, including days that have not happened —
//  and the prior range was taken as that full width shifted
//  back. So Transactions and Total Discounts opened every pay
//  period deeply negative and climbed back to level by the end,
//  which is not a signal, it is the calendar.
//
//  Sales / Hour was wrong the other way and worse, because it
//  was arithmetic rather than a choice: fourteen days of prior
//  takings divided by THREE days of open hours.
//
//  RATES ARE DELIBERATELY DIFFERENT and that is asserted here
//  too. An average order value does not care how long you
//  measure it, and the whole prior period is the steadier
//  benchmark — Sky's own read in the same report. A test that
//  put everything on one basis would "pass" while removing the
//  thing he said already worked.
//
//  Run:  node tests/kpi_comparison_window_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

const CORE_STORES = [
  { store_id: 'bend',        display_name: 'Century',    dutchie_name: 'Bend',        color: '#fff', sort_order: '1' },
  { store_id: 'center',      display_name: 'Center',     dutchie_name: 'Center',      color: '#fff', sort_order: '2' },
  { store_id: 'commercial',  display_name: 'Commercial', dutchie_name: 'Commercial',  color: '#fff', sort_order: '3' },
  { store_id: 'hillsboro',   display_name: 'Baseline',   dutchie_name: 'Hillsboro',   color: '#fff', sort_order: '4' },
  { store_id: 'portland-rd', display_name: 'Portland',   dutchie_name: 'Portland Rd', color: '#fff', sort_order: '5' },
  { store_id: 'river-rd',    display_name: 'River',      dutchie_name: 'River Rd',    color: '#fff', sort_order: '6' },
];

const props = {
  getProperty: function () { return null; },
  setProperty: function () { return this; },
  deleteProperty: function () { return this; },
  getProperties: function () { return {}; },
  setProperties: function () { return this; },
};

const S = H.load(['gx_roster.gs', 'dutchie_proxy.gs', 'endpoints.gs', 'dutchie_fetch.gs', 'goals.gs', 'auth.gs', 'discounts.gs'], {
  stubs: {
    PropertiesService: {
      getScriptProperties:   function () { return props; },
      getUserProperties:     function () { return props; },
      getDocumentProperties: function () { return props; },
    },
    GXCore: { getEmployees: function () { return []; }, getStores: function () { return CORE_STORES; } },
  },
  extraExports: '"resetPPCache": function () { _ppStartCache_ = null; _propsCache_ = null; _ppCfgCache_ = null; _gxRosterMemo_ = null; }',
});

/* The live anchor default: 2026-05-11, a MONDAY, 14 days. Every pay period therefore starts on a
   Monday, which is the property the whole fix leans on — see the weekday test below. */
function at(y, m, d, h) { H.setNow(Date.UTC(y, m - 1, d, (h == null ? 19 : h), 0, 0)); S.resetPPCache(); }
function clear() { H.setNow(null); S.resetPPCache(); }

// ── The window itself ────────────────────────────────────────────────────────────────────────────
function test_payPeriod_threeDaysIn_comparesToFirstThreeDays_() {
  at(2026, 9, 16);   // day 3 of the pay period that started Monday 2026-09-14
  try {
    const range = S.getDateRange_('pp');
    _eq_('the period Sky was looking at', range.fromLocal, '2026-09-14');
    _eq_('three days in, as he said',     range.daysElapsed, 3);
    _eq_('and the range still spans the whole period', range.totalDays, 14);

    const prior = S.getPriorRange_(range);
    _eq_('prior window starts at the prior period, not 14 days before today', prior.fromLocal, '2026-08-31');
    _eq_('and ENDS after three days — the bug was that it ran to the 13th',   prior.toLocal,   '2026-09-02');
    _eq_('three days measured against three',                                 prior.days,      3);
    _eq_('while still knowing the period was fourteen long',                  prior.periodDays, 14);

    const full = S.getPriorFullRange_(range);
    _eq_('the rate benchmark is the WHOLE prior period', full.fromLocal, '2026-08-31');
    _eq_('all fourteen days of it',                      full.toLocal,   '2026-09-13');
    _eq_('which is what "vs. last period average" means', full.days,     14);
  } finally { clear(); }
}

// The reason elapsed-alignment is the RIGHT comparison and not just a fairer one.
function test_alignedDaysAreAlsoTheSameWeekdays_() {
  at(2026, 9, 16);
  try {
    const prior = S.getPriorRange_(S.getDateRange_('pp'));
    const dow = function (s) { return new Date(s + 'T12:00:00Z').getUTCDay(); };
    _eq_('this period opened on a Monday',      dow('2026-09-14'), 1);
    _eq_('and so did the one before it',        dow(prior.fromLocal), 1);
    _eq_('so day three lines up with day three', dow('2026-09-16'), dow(prior.toLocal));
    // The full-period benchmark does NOT have this property, which is exactly why the totals do not
    // use it: fourteen days contains two weekends and three days does not.
    _ok_('the full period is not weekday-comparable to three days',
         S.getPriorFullRange_(S.getDateRange_('pp')).days !== 3);
  } finally { clear(); }
}

// ── Month-to-date, where the prior period is a different length ──────────────────────────────────
function test_monthToDate_usesTheFirstDaysOfThePreviousMonth_() {
  at(2026, 9, 5);
  try {
    const range = S.getDateRange_('mtd');
    _eq_('five days into September', range.daysElapsed, 5);
    const prior = S.getPriorRange_(range);
    _eq_('the first of AUGUST, not the last days of it', prior.fromLocal, '2026-08-01');
    _eq_('five days of it',                              prior.toLocal,   '2026-08-05');
    _eq_('a whole August for the rate benchmark',        S.getPriorFullRange_(range).toLocal, '2026-08-31');
    _eq_('and August is 31 days long',                   prior.periodDays, 31);
  } finally { clear(); }
}

// February has no 30th. The window clamps rather than running past the end of the prior month.
//
// This is also the ONLY case where the prior window's length differs from this period's elapsed
// days, which makes it the only place the Sales/Hour divisor can be caught. Everywhere else the two
// numbers are equal and dividing by the wrong one gives the right answer by accident.
function test_monthToDate_clampsToAShorterPriorMonth_() {
  at(2026, 3, 30);
  try {
    const range = S.getDateRange_('mtd');
    _eq_('thirty days into March', range.daysElapsed, 30);
    const prior = S.getPriorRange_(range);
    _eq_('February started where February starts', prior.fromLocal, '2026-02-01');
    _eq_('and stops at its own last day',          prior.toLocal,   '2026-02-28');
    _eq_('so the window is 28, not 30',            prior.days,      28);

    // 28,000 over 28 days is $1,000/day; over 30 it would be $933. Each side divides by ITS OWN
    // days or the comparison silently flatters whichever period is shorter.
    const out = S.getDirectorSummary({ period: 'mtd' }, {
      byStoreAgg:     agg(30000, 1000, 2500, 0, 0, 30000),   // 30 days at $1,000/day
      prevByStoreAgg: agg(28000,  933, 2333, 0, 0, 28000),   // 28 days at $1,000/day
    });
    _eq_('this period: 30000 over 30 days of open hours', out.salesPerHour, 71);
    _eq_('the same daily rate reads as no change, not as a shortfall',
         out.deltas.salesPerHour, 0);
  } finally { clear(); }
}

// The pay period's length comes from the registry, never a literal 14. A shop that moved to weekly
// would otherwise compare against a window that does not exist.
function test_payPeriodLengthComesFromTheRegistry_() {
  const W = H.load(['gx_roster.gs', 'dutchie_proxy.gs', 'endpoints.gs', 'dutchie_fetch.gs', 'goals.gs', 'auth.gs', 'discounts.gs'], {
    stubs: {
      PropertiesService: {
        getScriptProperties:   function () { return props; },
        getUserProperties:     function () { return props; },
        getDocumentProperties: function () { return props; },
      },
      GXCore: {
        getEmployees: function () { return []; },
        getStores:    function () { return CORE_STORES; },
        getKv: function (k) {
          if (k === 'cfg.payPeriodAnchor') return '2026-05-11';
          if (k === 'cfg.payPeriodDays')   return 7;      // weekly, not fortnightly
          return null;
        },
      },
    },
    extraExports: '"resetPPCache": function () { _ppStartCache_ = null; _propsCache_ = null; _ppCfgCache_ = null; _gxRosterMemo_ = null; }',
  });
  H.setNow(Date.UTC(2026, 8, 16, 19, 0, 0));
  W.resetPPCache();
  try {
    const range = W.getDateRange_('pp');
    _eq_('a weekly period starts on the 14th', range.fromLocal, '2026-09-14');
    const prior = W.getPriorRange_(range);
    _eq_('so the prior period is SEVEN days back, not fourteen', prior.fromLocal, '2026-09-07');
    _eq_('and it is seven days long',                            prior.periodDays, 7);
    _eq_('three days into it for the comparison',                prior.toLocal, '2026-09-09');
  } finally { H.setNow(null); W.resetPPCache(); }
}

// ── DST, because these are calendar days and not 24-hour spans ───────────────────────────────────
// A prior window that contains the fall-back has a 25-hour day in it. Fixed-ms arithmetic lands an
// hour off PT midnight and formats back to the previous date — the trap ptDateShift_ exists for.
function test_dstDoesNotShiftTheWindowByADay_() {
  at(2026, 11, 12);   // in the period starting 2026-11-09; the prior one spans Nov 1 (DST ends)
  try {
    const range = S.getDateRange_('pp');
    _eq_('the period we are in', range.fromLocal, '2026-11-09');
    const prior = S.getPriorRange_(range);
    _eq_('prior period starts exactly 14 calendar days earlier', prior.fromLocal, '2026-10-26');
    _eq_('and four elapsed days later is the 29th, not the 28th', prior.toLocal, '2026-10-29');

    const full = S.getPriorFullRange_(range);
    _eq_('the full prior period ends the day before this one starts', full.toLocal, '2026-11-08');
    _eq_('fourteen calendar days even across the change',             full.days,    14);
  } finally { clear(); }
}

// The window's END instant, on a window that CONTAINS the fall-back. The dates above survive naive
// ms arithmetic by luck — PT midnight is 07:00 or 08:00 UTC either way, so slicing a UTC string
// still reads the right day. The instant does not: `startMs + days * DAY_MS - 1` lands an hour
// early and closes the window at 23:00 PT, dropping the last hour of trade on the longest day of
// the year. Nothing on screen would say so; the day would just be quietly light.
function test_dstWindowClosesAtTheRightWallClockNotAnHourEarly_() {
  at(2026, 11, 15);   // 11:00 PT, 7 days into the period from 2026-11-09 → prior window 10-26..11-01
  try {
    const prior = S.getPriorRange_(S.getDateRange_('pp'));
    _eq_('seven elapsed days',              prior.days, 7);
    _eq_('the window contains the change',  prior.fromLocal, '2026-10-26');
    _eq_('and ends on the day it happened', prior.toLocal, '2026-11-01');
    _ok_('the last day is a part-day, aligned to the clock', prior.partialLastDay === true);

    /* THE CUT IS 11:00 PT ON NOV 1, AND NOV 1 IS A 25-HOUR DAY. It begins in PDT (UTC-7) and ends
       in PST (UTC-8), so 11:00 PT that morning — after the 02:00 fall-back — is 19:00Z, and the
       window ends 1ms before it. This used to assert PT midnight, which was right when the window
       was whole days; the day-of alignment moved the instant, not the rule. */
    _eq_('it closes at 11:00 PT on the DST day',
         prior.toUTC, '2026-11-01T18:59:59.999Z');

    /* NOTE WHAT THIS CASE DOES *NOT* PROVE, because the first version of this test claimed it did.
       At 11:00 the naive form — that day's midnight plus elapsed ms — gives the SAME instant, so
       this assertion cannot tell the two apart. The forms only diverge in the first three hours of
       a transition day, which is why the discriminating case lives in its own test below rather
       than being asserted here on a day where it passes by accident. */
    _eq_('the naive form happens to agree at this hour, so this is not the guard',
         new Date(S.ptDateToUtcMs_('2026-11-01') + 11 * 3600000 - 1).toISOString(), prior.toUTC);

    // And the whole-period benchmark is untouched by any of this: it keeps whole calendar days.
    const full = S.getPriorFullRange_(S.getDateRange_('pp'));
    _eq_('the rate benchmark still closes at PT midnight',
         full.toUTC, '2026-11-09T07:59:59.999Z');
    _ok_('and is not a part-day', !full.partialLastDay);
  } finally { clear(); }
}

/* THE WINDOW ITSELF, AT AN HOUR WHERE THE NAIVE FORM IS WRONG.
 *
 * The DST test above cannot catch a wall-clock regression because at 11am both forms agree. This
 * one views the board at 01:00 PT, which puts the aligned last day's cut inside the fall-back hour
 * — the only window of the year where midnight-plus-elapsed-ms and a real wall clock differ. A
 * board is genuinely read at 1am: the kiosks run all night and the nightly reload is at 04:00.
 */
function test_theWindowUsesARealWallClockAtTheTransitionHour_() {
  at(2026, 11, 15, 9);   // 09:00 UTC = 01:00 PT (PST), 7 days into the period from 2026-11-09
  try {
    const range = S.getDateRange_('pp');
    const prior = S.getPriorRange_(range);
    _eq_('the aligned last day is the fall-back date', prior.toLocal, '2026-11-01');
    _ok_('and it is a part-day', prior.partialLastDay === true);

    // 01:00 on Nov 1 happens twice; the first (PDT) is 08:00Z, and the window ends 1ms before it.
    _eq_('the cut is the FIRST 01:00 of the doubled hour',
         prior.toUTC, '2026-11-01T07:59:59.999Z');

    /* THE CONTROL, which the 11am test could not provide: midnight-plus-elapsed-ms lands an hour
       LATE here, because ptDateToUtcMs_ already reads this day's midnight an hour late. An hour of
       a compared window, from a substitution that looks equivalent. */
    const naive = new Date(S.ptDateToUtcMs_('2026-11-01') + 1 * 3600000 - 1).toISOString();
    _eq_('the naive form would be an hour out', naive, '2026-11-01T08:59:59.999Z');
    _ok_('which is NOT what the window does', naive !== prior.toUTC);
  } finally { clear(); }
}

/* THE WALL-CLOCK HELPER, on the hours where the obvious implementation is actually wrong.
 *
 * ptDateTimeToUtcMs_ exists because the time-of-day window has to land on a wall clock, and the
 * form a future edit reaches for — that date's midnight plus elapsed ms — is wrong in the first
 * three hours of a transition day. It is not wrong at 11am, which is why the DST window test above
 * cannot be the guard for it: on the day the board actually uses, both forms agree.
 *
 * The worst of them is 00:00 on a spring-forward date, where the naive form answers with the
 * PREVIOUS DAY. A window edge a day out would compare a period against a period plus a day.
 */
function test_wallClockHelperIsRightWhereTheNaiveFormIsNot_() {
  at(2026, 6, 1);   // an ordinary day; the helper takes its date from the argument, not the clock
  try {
    const naive = (d, h) => new Date(S.ptDateToUtcMs_(d) + h * 3600000).toISOString();
    const real  = (d, h) => new Date(S.ptDateTimeToUtcMs_(d, h, 0)).toISOString();

    // Spring forward, 2026-03-08. Midnight PT that day is PST, 08:00Z.
    _eq_('00:00 on a spring-forward date is that date, in PST', real('2026-03-08', 0), '2026-03-08T08:00:00.000Z');
    _eq_('the naive form lands on the PREVIOUS DAY',            naive('2026-03-08', 0), '2026-03-08T07:00:00.000Z');
    _ok_('so they disagree, which is the whole reason the helper exists',
         real('2026-03-08', 0) !== naive('2026-03-08', 0));

    // The 02:00 hour does not exist that day; the edge resolves forward, never backwards or NaN.
    _eq_('the spring-forward gap resolves to the first real instant after it',
         real('2026-03-08', 2), '2026-03-08T10:00:00.000Z');

    // Fall back, 2026-11-01. 01:00 happens twice; the FIRST one (PDT) is what a reader means.
    _eq_('the ambiguous fall-back hour takes its first occurrence',
         real('2026-11-01', 1), '2026-11-01T08:00:00.000Z');

    // And on an ordinary day it is simply the offset, with no cleverness.
    _eq_('an ordinary PDT day', real('2026-06-15', 11), '2026-06-15T18:00:00.000Z');
    _eq_('an ordinary PST day', real('2026-01-15', 11), '2026-01-15T19:00:00.000Z');

    /* EVERY HOUR OF EVERY TRANSITION DATE MUST LAND INSIDE THAT PT DAY. Asserted as a range
       against the day's own boundaries rather than by comparing ISO date strings — a PT afternoon
       is the next date in UTC, so a string compare would be wrong for half of them and is how the
       first draft of this loop ended up asserting `|| true`. */
    ['2026-03-08', '2026-11-01', '2027-03-14', '2027-11-07'].forEach(function (d) {
      const dayStart  = S.ptDateTimeToUtcMs_(d, 0, 0);
      const nextStart = S.ptDateTimeToUtcMs_(S.ptDateShift_(d, 1), 0, 0);
      for (let h = 0; h < 24; h++) {
        const ms = S.ptDateTimeToUtcMs_(d, h, 0);
        _ok_(d + ' ' + h + ':00 is a real instant', !isNaN(ms));
        _ok_(d + ' ' + h + ':00 falls inside that PT day', ms >= dayStart && ms < nextStart);
        /* NON-DECREASING, not strictly increasing. On a spring-forward date 02:00 does not exist
           and resolves forward to the 03:00 instant, so those two wall-clock hours map to the same
           ms — the one place in the day where they must be allowed to. Asserting `>` here failed on
           exactly those two dates, which is the documented behavior working. */
        if (h > 0) _ok_(d + ' ' + h + ':00 is not before ' + (h - 1) + ':00',
                        ms >= S.ptDateTimeToUtcMs_(d, h - 1, 0));
      }
    });

    /* A DISCREPANCY WORTH RECORDING RATHER THAN PAPERING OVER, found by this test.
     *
     * ptDateToUtcMs_ probes the offset at NOON UTC, which on the November fall-back date is
     * already PST — so it reports that day's midnight as 08:00Z when the day actually begins at
     * 07:00Z, still PDT. One hour, once a year, and it is 00:00-01:00 PT: the stores open at 8am,
     * so there has never been a transaction in it and nothing on any screen has been wrong.
     *
     * NOT CHANGED HERE ON PURPOSE. ptDateToUtcMs_ sets the day boundary for the whole app,
     * including the per-day aggregate cache keys, and moving it to chase an hour with no trade in
     * it is a far larger blast radius than the window this task is fixing. Asserted so the gap is
     * a known quantity instead of a surprise to whoever next puts the two helpers side by side. */
    _ok_('the older helper reads the fall-back midnight an hour late — known, and harmless',
         S.ptDateToUtcMs_('2026-11-01') - S.ptDateTimeToUtcMs_('2026-11-01', 0, 0) === 3600000);
    _ok_('and the two agree on every ordinary day',
         S.ptDateToUtcMs_('2026-06-15') === S.ptDateTimeToUtcMs_('2026-06-15', 0, 0) &&
         S.ptDateToUtcMs_('2026-01-15') === S.ptDateTimeToUtcMs_('2026-01-15', 0, 0));
  } finally { clear(); }
}

// ── End to end, through the real getDirectorSummary ──────────────────────────────────────────────
// Numbers chosen so each basis gives a DIFFERENT answer. If totals and rates were ever put on the
// same window, half of these assertions break — which is the point of picking them this way.
function agg(sales, txns, items, disc, discBdt, sub) {
  return { river: { byEmployee: { '1': {
    id: '1', name: 'Test Seller', initials: 'TS',
    sales: sales, transactions: txns, items: items,
    discounts: disc, discountsBdt: discBdt, subtotal: sub,
  } } } };
}

function test_summaryPutsTotalsAndRatesOnTheRightWindows_() {
  at(2026, 9, 16);
  try {
    const out = S.getDirectorSummary({ period: 'pp' }, {
      byStoreAgg:         agg(9000,  300,  750, 500,  475, 9500),    // 3 days,  AOV 30,   UPT 2.5, rate .05
      prevByStoreAgg:     agg(7500,  250,  625, 400,  395, 7900),    // 3 days,  AOV 30,   UPT 2.5, rate .05
      prevFullByStoreAgg: agg(35000, 1000, 2200, 1900, 1080, 36000), // 14 days, AOV 35,   UPT 2.2, rate .03
    });

    // TOTALS — against the first three days of the prior period.
    _eq_('transactions compare 300 against 250, not against 1000', out.deltas.transactions, 50);
    _eq_('total discounts likewise',  out.deltas.totalDiscounts, 100);
    _ok_('and total sales is a real percentage, not a period-length artifact',
         out.deltas.totalSalesPct > 0.19 && out.deltas.totalSalesPct < 0.21);

    // RATES — against the whole prior period. Each of these is ZERO on the aligned window, so a
    // regression that moved them would read as "no change" rather than as a failure.
    _eq_('AOV benchmarks against the full prior period', out.deltas.avgOrderValue, -5);
    _eq_('so does UPT',                                   out.deltas.avgUPT, 0.3);
    _eq_('and the discount rate',                         out.deltas.discountRatePts, 0.02);

    /* SALES PER HOUR — over the open hours that have actually HAPPENED, not three whole days.
       `at()` sets 19:00 UTC, which in September is PDT, so the clock is 12:00 PT and four of
       today's fourteen hours have gone: the window is 2 × 14 + 4 = 32, not 42. Dividing by 42 is
       the bug Sky saw as the chain reading light all morning and recovering by evening. Both sides
       use 32 because the windows are clock-aligned.
       (Note 19:00 UTC is 12:00 PT here but 11:00 PT in the November DST test above — the fixture
       clock is UTC, so the PT hour it lands on moves with the season.) */
    _eq_('this period: 9000 over 32 elapsed open hours', out.salesPerHour, 281);
    _eq_('the prior side uses the SAME 32 hours, so 7500 reads as 234',
         out.deltas.salesPerHour, 281 - 234);
    _ok_('and it is not the whole-day divisor, which would have said 214',
         out.salesPerHour !== 214);

    // And the card is told what it is comparing, so it can say so.
    _eq_('how far into the period we are', out.comparison.currentDays, 3);
    _eq_('the window the totals used',     out.comparison.totalsDays, 3);
    _eq_('the window the rates used',      out.comparison.rateDays, 14);
    _eq_('and how long the period is',     out.comparison.periodDays, 14);
  } finally { clear(); }
}

// THE REGRESSION, stated as the thing that must never come back.
function test_totalsAreNeverComparedAgainstAWholePeriod_() {
  at(2026, 9, 16);
  try {
    const out = S.getDirectorSummary({ period: 'pp' }, {
      byStoreAgg:         agg(9000,  300,  750, 500,  475, 9500),
      prevByStoreAgg:     agg(7500,  250,  625, 400,  395, 7900),
      prevFullByStoreAgg: agg(35000, 1000, 2200, 1900, 1080, 36000),
    });
    _ok_('a period three days old does not open 700 transactions down',
         out.deltas.transactions > 0);
    _ok_('nor $1,400 down on discounts',
         out.deltas.totalDiscounts > 0);
    _ok_('nor $600/hour down on sales per hour',
         out.deltas.salesPerHour > -100);
  } finally { clear(); }
}

// A caller that pre-fetched the aligned window and NOT the full one gets the aligned window for the
// rates as well — and `rateDays` says so, so the card labels a narrower benchmark instead of
// claiming one it did not use. Silently going and fetching would put a live Dutchie call inside a
// path whose whole contract is "I already have the data".
function test_missingRateBenchmarkIsReportedNotFetched_() {
  at(2026, 9, 16);
  try {
    const out = S.getDirectorSummary({ period: 'pp' }, {
      byStoreAgg:     agg(9000, 300, 750, 500, 475, 9500),
      prevByStoreAgg: agg(7500, 250, 625, 400, 395, 7900),
    });
    _eq_('rates fell back to the aligned window', out.comparison.rateDays, 3);
    _eq_('and the totals are unaffected',         out.deltas.transactions, 50);
    _eq_('AOV against the same 3 days is level',  out.deltas.avgOrderValue, 0);
  } finally { clear(); }
}

H.run('kpi_comparison_window', {
  test_payPeriod_threeDaysIn_comparesToFirstThreeDays_,
  test_alignedDaysAreAlsoTheSameWeekdays_,
  test_monthToDate_usesTheFirstDaysOfThePreviousMonth_,
  test_monthToDate_clampsToAShorterPriorMonth_,
  test_payPeriodLengthComesFromTheRegistry_,
  test_dstDoesNotShiftTheWindowByADay_,
  test_dstWindowClosesAtTheRightWallClockNotAnHourEarly_,
  test_theWindowUsesARealWallClockAtTheTransitionHour_,
  test_wallClockHelperIsRightWhereTheNaiveFormIsNot_,
  test_summaryPutsTotalsAndRatesOnTheRightWindows_,
  test_totalsAreNeverComparedAgainstAWholePeriod_,
  test_missingRateBenchmarkIsReportedNotFetched_,
});
