// ============================================================
//  dutchie_proxy.gs — pay-period boundary math
//
//  Ported from tests.gs (2026-08-22). The live-clock invariant
//  is kept verbatim; the pinned cases are new (see below).
//  Run:  node tests/dutchie_proxy_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_, _approx_ } = H;

const S = H.load(['dutchie_proxy.gs'], {
  // currentPPStart_ memoizes into _ppStartCache_ for the life of one GAS
  // execution. Every case must clear it — runAllTests does this once at the
  // top, and a stale memo would make the second case assert nothing at all.
  extraExports: '"resetPPCache": function () { _ppStartCache_ = null; _propsCache_ = null; }',
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Freeze the clock at noon PT on a date, clear the memo, return the PP start
 *  as a Portland-local YYYY-MM-DD (formatted by the harness, not by the code
 *  under test). `anchor` overrides the GC_PAY_PERIOD_ANCHOR property. */
function ppStartOn(y, monthIdx, day, anchor) {
  H.setNow(Date.UTC(y, monthIdx, day, 19, 0, 0));   // 12:00 PT, either side of DST
  S.resetPPCache();
  const props = anchor ? { getProperty: function () { return anchor; } } : undefined;
  return H.fmtPT(S.currentPPStart_(props).ppStartMs);
}

// ── currentPPStart_ — live clock ─────────────────────────────
// Verbatim from tests.gs. This is an INVARIANT, not a fixed expectation: it
// asserts that whatever today is, it lands inside the current pay period. Its
// meaning therefore changes daily, which is exactly why the pinned cases below
// exist — so a real regression is distinguishable from "the calendar moved".
function test_currentPPStart_() {
  H.setNow(null);
  S.resetPPCache();
  var pp = S.currentPPStart_();
  _eq_('PP_MS = 14 days', pp.PP_MS, 14 * 24 * 60 * 60 * 1000);
  _ok_('ppStartMs positive', typeof pp.ppStartMs === 'number' && pp.ppStartMs > 0);

  // Today should fall within [ppStart, ppStart + 14 days)
  var todayMs = S.ptDateToUtcMs_(S.ptNow_().dateStr);
  var offset  = todayMs - pp.ppStartMs;
  _ok_('today within current PP', offset >= 0 && offset < pp.PP_MS);
}

// ── currentPPStart_ — pinned dates ───────────────────────────
// Default anchor is 2026-05-11, period length 14 days.
function test_currentPPStart_pinned_() {
  try {
    _eq_('on the anchor itself → the anchor', ppStartOn(2026, 4, 11), '2026-05-11');
    _eq_('last day of PP 1 → still the anchor', ppStartOn(2026, 4, 24), '2026-05-11');
    _eq_('first day of PP 2 → rolls forward', ppStartOn(2026, 4, 25), '2026-05-25');
    _eq_('mid PP 3 → anchor + 28d',           ppStartOn(2026, 5, 18), '2026-06-08');

    // Negative offset: a date BEFORE the anchor takes the ceil()-1 branch, which
    // a floor() would get wrong by a whole period.
    _eq_('one week before the anchor → prior PP', ppStartOn(2026, 4, 4), '2026-04-27');

    // Across the PST→PDT flip (2026-03-08): the elapsed-days division sees 28
    // days minus one hour, and only survives because the code rounds.
    _eq_('anchor in PST, today in PDT', ppStartOn(2026, 2, 22, '2026-02-22'), '2026-03-22');
  } finally {
    H.setNow(null);
    S.resetPPCache();
  }
}

// ── the memo itself ──────────────────────────────────────────
function test_ppStartCache_() {
  try {
    S.resetPPCache();
    H.setNow(Date.UTC(2026, 5, 18, 19, 0, 0));
    var first = S.currentPPStart_();
    _ok_('memo returns the same object within one execution', S.currentPPStart_() === first);

    // Same execution, clock moved into the NEXT period: the memo is expected to
    // win. That is the documented per-execution behavior, and it is why every
    // test has to reset it.
    H.setNow(Date.UTC(2026, 5, 25, 19, 0, 0));
    _eq_('memo survives a clock move', S.currentPPStart_().ppStartMs, first.ppStartMs);

    S.resetPPCache();
    _eq_('after reset it recomputes', H.fmtPT(S.currentPPStart_().ppStartMs), '2026-06-22');
    _approx_('PP length is exactly 14 days', S.currentPPStart_().PP_MS, 14 * DAY_MS, 0);
  } finally {
    H.setNow(null);
    S.resetPPCache();
  }
}

H.run('dutchie_proxy', { test_currentPPStart_, test_currentPPStart_pinned_, test_ppStartCache_ });
