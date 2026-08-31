// ============================================================
//  endpoints.gs — name keys + period → date-range math
//
//  Ported from tests.gs (2026-08-22). Assertions unchanged.
//  Run:  node tests/endpoints_test.js
//
//  dutchie_proxy.gs is loaded alongside for ptNow_/ptDateToUtcMs_/
//  currentPPStart_/STORE_TZ, which getDateRange_ calls.
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_, _approx_ } = H;

const S = H.load(['endpoints.gs', 'dutchie_proxy.gs'], {
  // currentPPStart_ memoizes into a file-level var; reach it the same way
  // runAllTests does, so a stale memo can't make a later case assert nothing.
  extraExports: '"resetPPCache": function () { _ppStartCache_ = null; _propsCache_ = null; }',
});

// ── nameToKey_ ───────────────────────────────────────────────
function test_nameToKey_() {
  _eq_('basic key',           S.nameToKey_('Jon Juslen'), 'jon_juslen');
  _eq_('strips apostrophe+dot', S.nameToKey_("D'Angelo St. James"), 'dangelo_st_james');
  _eq_('empty → empty',       S.nameToKey_(''), '');
  _eq_('null → empty',        S.nameToKey_(null), '');
}

// ── getDateRange_ ────────────────────────────────────────────
function test_getDateRange_() {
  S.resetPPCache();
  var pp = S.getDateRange_('pp');
  // The RANGE is correct: end-of-day-14 minus start-of-day-1 = 14 days − 1 ms.
  var spanMs = new Date(pp.toUTC).getTime() - new Date(pp.fromUTC).getTime();
  _approx_('pp UTC span = 14 days', spanMs, 14 * 24 * 60 * 60 * 1000 - 1, 2);
  _ok_('pp from <= to',     pp.fromLocal <= pp.toLocal);
  _eq_('pp period label',   pp.period, 'pp');
  _eq_('pp totalDays = 14', pp.totalDays, 14);   // off-by-one fixed (was 15)

  var today = S.getDateRange_('today');
  _eq_('today from === to', today.fromLocal, today.toLocal);

  var mtd = S.getDateRange_('mtd');
  _ok_('mtd starts on the 1st', /-01$/.test(mtd.fromLocal));
  _eq_('mtd period label', mtd.period, 'mtd');
}

// ── getDateRange_, pinned to an explicit date ────────────────
// Added on the port. The cases above read the real clock, so they can only
// ever assert relationships; these pin a known instant and assert the actual
// boundaries, including the PST/PDT offset flip that the UTC conversion has
// to get right. Wed 2026-06-17 12:00 PT (PDT, UTC-7) and a winter date.
function test_getDateRange_pinned_() {
  try {
    H.setNow(Date.UTC(2026, 5, 17, 19, 0, 0));   // 2026-06-17 12:00 PDT
    S.resetPPCache();

    var today = S.getDateRange_('today');
    _eq_('pinned today fromLocal', today.fromLocal, '2026-06-17');
    _eq_('pinned today fromUTC (PDT = UTC-7)', today.fromUTC, '2026-06-17T07:00:00.000Z');
    _eq_('pinned today totalDays', today.totalDays, 1);

    var mtd = S.getDateRange_('mtd');
    _eq_('pinned mtd fromLocal', mtd.fromLocal, '2026-06-01');
    _eq_('pinned mtd daysElapsed', mtd.daysElapsed, 17);

    var wtd = S.getDateRange_('wtd');                       // 6/17/2026 is a Wednesday
    _eq_('pinned wtd starts Monday', wtd.fromLocal, '2026-06-15');

    var qtd = S.getDateRange_('qtd');
    _eq_('pinned qtd starts Apr 1', qtd.fromLocal, '2026-04-01');

    var ytd = S.getDateRange_('ytd');
    _eq_('pinned ytd starts Jan 1', ytd.fromLocal, '2026-01-01');

    var d30 = S.getDateRange_('30d');
    _eq_('pinned 30d spans 30 days incl. today', d30.fromLocal, '2026-05-19');
    _eq_('pinned 30d totalDays', d30.totalDays, 30);

    // Winter: PST is UTC-8, so local midnight is 08:00Z, not 07:00Z.
    H.setNow(Date.UTC(2026, 0, 15, 20, 0, 0));   // 2026-01-15 12:00 PST
    S.resetPPCache();
    var win = S.getDateRange_('today');
    _eq_('pinned winter fromLocal', win.fromLocal, '2026-01-15');
    _eq_('pinned winter fromUTC (PST = UTC-8)', win.fromUTC, '2026-01-15T08:00:00.000Z');
  } finally {
    H.setNow(null);
    S.resetPPCache();
  }
}

H.run('endpoints', { test_nameToKey_, test_getDateRange_, test_getDateRange_pinned_ });
