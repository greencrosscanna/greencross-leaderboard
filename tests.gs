// ============================================================
//  Green Cross — Editor-only diagnostics  (tests.gs)
//
//  THE UNIT TESTS NO LONGER LIVE HERE. They were ported to node
//  on 2026-08-22 and now live in  tests/  at the repo root:
//
//      tests/dutchie_fetch_test.js   rounding, tx field extraction,
//                                    aggregation, by-day/by-hour, trend
//      tests/endpoints_test.js       nameToKey_, getDateRange_
//      tests/dutchie_proxy_test.js   currentPPStart_ (pay-period math)
//      tests/goals_test.js           dowCountsThroughDay_
//      tests/_harness.js             loader + assertions
//
//  Run them with:  node tests/dutchie_fetch_test.js   (etc.)
//  gx-preflight.sh runs all four as a pre-push hook and REFUSES
//  the push on a failure — which is the whole reason they moved.
//  A suite that only runs when someone remembers to open the
//  editor is a suite that stops running; this one had 68 passing
//  assertions and gated nothing.
//
//  Each node test loads the shipped .gs file as TEXT and calls the
//  real function. Nothing is reimplemented, so the tests cannot
//  drift away from production.
//
//  WHAT IS STILL HERE, AND WHY. The two functions below hit the
//  Dutchie API, so they cannot run under node — and they are
//  diagnostics, not tests: they print live numbers for a human to
//  eyeball, and have no pass/fail. Run them from the Apps Script
//  editor (select the function, Run, then View → Logs).
// ============================================================

// ── Manual diagnostic (hits the Dutchie API — run from the editor) ───────────
// Prints, per store: actual MTD sales vs the new DOW-weighted "expected by now"
// bar, the resulting vs-plan %, and whether the behind-plan alert would fire.
// Use this to sanity-check the alert proration against live numbers.
function diagAlertProration() {
  var range   = getDateRange_('mtd');
  var byStore  = fetchAllStoresTransactions_(range);
  var pt       = ptNow_();
  var dim      = new Date(Date.UTC(pt.year, pt.month + 1, 0)).getUTCDate();
  var lines    = ['MTD ' + pt.dateStr + ' — ' + (pt.day - 1) +
                  ' completed day(s) of ' + dim + ' in month  (today excluded from "expected")'];
  STORES.forEach(function(store) {
    var agg      = aggregateTransactions_(byStore[store.slug] || []);
    var expected = getProratedMonthGoalToDate_(store.slug);
    var monthly  = getMonthlyGoal_(store.slug);
    var vsplan   = expected > 0 ? Math.round((agg.sales - expected) / expected * 100) : null;
    lines.push(
      store.name +
      ': actual $' + Math.round(agg.sales) +
      '  |  expected $' + expected +
      '  |  vs plan ' + (vsplan === null ? 'n/a' : (vsplan > 0 ? '+' : '') + vsplan + '%') +
      (vsplan !== null && vsplan < -5 ? '  ⚠ FLAG' : '  ✓ ok') +
      '  |  full-month goal $' + monthly
    );
  });
  Logger.log(lines.join('\n'));
  return lines;
}

// ── Manual diagnostic: per-store 30-day retail counts ────────────────────────
// Sanity-checks the single-fetch behavior. Counts well above DUTCHIE_TAKE prove
// Dutchie returns the full result set in one call (no hard cap). A count of
// EXACTLY DUTCHIE_TAKE would indicate a real cap that needs date-window splitting.
function diagPagination() {
  var r       = getDateRange_('30d');
  var byStore  = fetchAllStoresTransactions_(r);
  var lines    = ['30-day fetch ' + r.fromLocal + ' → ' + r.toLocal +
                  '  (Take=' + DUTCHIE_TAKE + ')'];
  STORES.forEach(function(store) {
    var n = (byStore[store.slug] || []).length;
    lines.push(store.name + ': ' + n + ' retail txns' +
      (n === DUTCHIE_TAKE ? '  ⚠ exactly at cap — possible truncation' :
       n > DUTCHIE_TAKE   ? '  ✓ full set returned in one call (no cap)' : ''));
  });
  Logger.log(lines.join('\n'));
  return lines;
}
