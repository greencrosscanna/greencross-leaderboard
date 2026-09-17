// ============================================================
//  A number is never "+0%" or "−0%"  (index.html)
//
//  Sky, 2026-09-16, off the director screen: "how can a number
//  be +0% or -0%, shouldn't it just be 0%". He is right, and it
//  is not a rounding nit — a minus sign in front of a zero is a
//  quantity that does not exist. There is no amount of
//  below-zero that displays as zero.
//
//  HOW IT HAPPENED, which is the part worth keeping: every
//  readout decided the sign from the RAW value and then printed
//  a ROUNDED one. -0.004 survives `< 0` and then rounds away, so
//  the sign outlives the magnitude it belonged to. Each surface
//  rounded at its own precision -- whole percent on the gauges,
//  one decimal in the store table, whole dollars on standings --
//  so each had its own window of values that printed a signed
//  zero, and no single threshold would have closed them all.
//
//  There were SIX hand-rolled copies of
//    (p >= 0 ? '+' : '−') + Math.abs(...)
//  plus two dollar ones. Fixing the panel in the screenshot
//  would have left the other seven, which is why this suite
//  asserts every call site and not just GC.fmtSignedPct.
//
//  Per tests/_harness.js's rule nothing here is reimplemented:
//  the real functions are lifted out of the shipped index.html.
//
//  Run:  node tests/signed_zero_test.js
// ============================================================
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grabGC(name) {
  const m = src.match(new RegExp('\\nGC\\.' + name + ' = function\\([^)]*\\) \\{[\\s\\S]*?\\n\\};\\n'));
  if (!m) throw new Error('could not extract GC.' + name + ' from index.html');
  return m[0];
}
/* A 2-space-indented function inside a view IIFE, disambiguated by something in its body. */
function grabFn(name, marker) {
  const re = new RegExp('\\n  function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n', 'g');
  const all = (src.match(re) || []).filter((b) => !marker || b.indexOf(marker) > -1);
  if (all.length !== 1) throw new Error('expected exactly one ' + name + ' containing ' + marker + ', found ' + all.length);
  return all[0];
}

const ctx = {
  Math, String, Number, Object, Array, isNaN,
  e: (s) => String(s == null ? '' : s),
  GC: {},
};
vm.createContext(ctx);
[
  'fmtSignedPct', 'fmtCurrency', 'fmtCurrencyFull', 'fmtNum', 'fmtDecimal', 'fmtPct',
  'fmtDeltaPct', 'fmtDeltaCurrency', 'fmtDeltaNum', 'fmtDeltaDecimal', 'fmtDeltaPts',
  'sparklineCell', 'esc', 'renderKpiBlock',
].forEach((n) => vm.runInContext(grabGC(n), ctx));
vm.runInContext(src.match(/\nGC\.PACE_RANGE = [\s\S]*?\nGC\.paceView = function[\s\S]*?\n\};\n/)[0], ctx);
vm.runInContext(grabFn('vsPlanHtml', 'vs-plan'), ctx);
/* One-liners now that they delegate — grabFn's block form does not match them. */
function grabLine(name) {
  const m = src.match(new RegExp('\\n *function ' + name + '\\([^)]*\\) \\{[^\\n]*\\}\\n'));
  if (!m) throw new Error('could not extract function ' + name + ' from index.html');
  return m[0];
}
vm.runInContext(grabLine('fmtPace'), ctx);
vm.runInContext(grabLine('paceLabel'), ctx);
const GC = ctx.GC;
const vsPlanHtml = ctx.vsPlanHtml;
const fmtPace = ctx.fmtPace;
const paceLabel = ctx.paceLabel;

let pass = 0, fail = 0;
const ok = (msg, c) => { c ? (pass++, console.log('  ok  ' + msg)) : (fail++, console.log('  ✗  ' + msg)); };
const eq = (msg, got, want) => ok(msg + '   (' + JSON.stringify(got) + ')', got === want);

// ── The rule itself ──────────────────────────────────────────────────────────────────────────────
console.log('\nGC.fmtSignedPct — the shared rule');
{
  eq('a real gain keeps its plus',            GC.fmtSignedPct(0.073), '+7%');
  eq('a real loss keeps its minus',           GC.fmtSignedPct(-0.073), '−7%');
  eq('exactly zero is bare',                  GC.fmtSignedPct(0), '0%');

  // THE BUG. Both of these used to print a sign, because the sign was decided before the rounding.
  eq('a hair above zero rounds to a bare 0%', GC.fmtSignedPct(0.004), '0%');
  eq('a hair below zero does NOT print −0%',  GC.fmtSignedPct(-0.004), '0%');

  // Precision is per-surface, so "rounds to zero" has to be asked at THAT precision, not a fixed
  // epsilon. 0.04% is zero on a whole-percent gauge and 0.0% at one decimal — and 0.4% is neither.
  eq('one decimal, still zero',               GC.fmtSignedPct(-0.0004, 1), '0.0%');
  eq('one decimal, no longer zero',           GC.fmtSignedPct(-0.004, 1), '−0.4%');
  eq('whole percent, the same value IS zero', GC.fmtSignedPct(-0.004), '0%');

  eq('nothing to show stays empty',           GC.fmtSignedPct(null), '');
  eq('and NaN does too',                      GC.fmtSignedPct(NaN), '');
  ok('negative zero is not a special case that slips through', GC.fmtSignedPct(-0) === '0%');
}

// ── Every surface that prints one ────────────────────────────────────────────────────────────────
// Each of these was its own copy of the formula and its own window of signed zeros. Asserted
// individually because that is the failure: one fix, seven survivors.
console.log('\nThe call sites');
{
  // Director + kiosk pace gauge. Empty payload → pace 0 → used to read "+0%".
  eq('pace gauge, no data at all',        GC.paceView().str, '0%');
  eq('pace gauge, rounds away below zero', GC.paceView({ pace: -0.004 }).str, '0%');
  eq('pace gauge, a real number is untouched', GC.paceView({ goal: 1000, projectedRevenue: 1180 }).str, '+18%');

  // Store table "vs. plan" column — one decimal, so its zero window is ten times narrower.
  ok('vs. plan, below zero but rounds away', vsPlanHtml(-0.0004).indexOf('0.0%') > -1);
  ok('and it carries no minus sign',         vsPlanHtml(-0.0004).indexOf('−') === -1);
  ok('vs. plan, a real loss keeps the sign',  vsPlanHtml(-0.061).indexOf('−6.1%') > -1);

  // Store view pace label.
  eq('store pace, rounds away below zero', fmtPace(-0.004), '0%');
  eq('store pace, a real loss',            fmtPace(-0.12), '−12%');

  // The Sky wall. It printed "+0%" for a tiny gain and "0%" for the equal-and-opposite loss, so the
  // same sized move read as two different things depending on direction — on the always-on screen.
  eq('sky wall, tiny gain',  paceLabel(0.004), '0%');
  eq('sky wall, tiny loss',  paceLabel(-0.004), '0%');
  eq('sky wall, a real gain', paceLabel(0.12), '+12%');

  // Sparkline trend badge. This one never printed "−0%" (Math.round(-0.3) is -0, which stringifies
  // to "0") but it did print "+0%", and the asymmetry is its own bug: the same sized move read
  // differently depending on which way it went.
  ok('sparkline, tiny gain prints no plus', GC.sparklineCell([1, 2], 0.004).indexOf('+0%') === -1);
  ok('sparkline, tiny loss prints no minus', GC.sparklineCell([1, 2], -0.004).indexOf('−0%') === -1);
  ok('sparkline, a real gain still does',    GC.sparklineCell([1, 2], 0.18).indexOf('+18%') > -1);
}

// ── The same defect in the other units ───────────────────────────────────────────────────────────
console.log('\nDollars and decimals — same rule, different unit');
{
  // Sales / Hour is fractional dollars, so a -$0.30 delta passed `n < 0` and printed "▼ −$0".
  eq('a delta that rounds to zero is a dash', GC.fmtDeltaNum(-0.3, '$'), '—');
  eq('and so does the positive side',         GC.fmtDeltaNum(0.3, '$'), '—');
  eq('a real decline still reads down',       GC.fmtDeltaNum(-14, '$'), '▼ −$14');
  eq('a real gain still reads up',            GC.fmtDeltaNum(14, '$'), '▲ +$14');

  eq('one decimal, rounds away',              GC.fmtDeltaDecimal(0.04), '—');
  eq('one decimal, a real decline',           GC.fmtDeltaDecimal(-0.3), '▼ −0.3');
  eq('percentage points, rounds away',        GC.fmtDeltaPts(0.0004), '—');
  eq('percentage points, a real rise',        GC.fmtDeltaPts(0.004), '▲ +0.4 pts');
}

// ── The arrow has to agree with the sign ─────────────────────────────────────────────────────────
// Avg UPT, Total Discounts and Discount Rate hardcoded "▲ +" and then printed the raw number, so a
// period that discounted LESS than the one before read "▲ +-$412" — an up arrow, a plus and a minus
// on a decline, which is the same confusion Sky filed about the over/unders.
console.log('\nDirection');
{
  ok('a smaller discount total is not an increase', GC.fmtDeltaCurrency(-412).indexOf('▲') === -1);
  eq('it reads as the decline it is',               GC.fmtDeltaCurrency(-412), '▼ −$412.00');
  ok('a falling UPT is not an increase',            GC.fmtDeltaDecimal(-0.3).indexOf('▲') === -1);
  ok('a falling discount rate is not an increase',  GC.fmtDeltaPts(-0.004).indexOf('▲') === -1);
  ok('no double sign anywhere',                     GC.fmtDeltaCurrency(-412).indexOf('+-') === -1);

  // Through the REAL KPI strip, not just the helpers — the three hardcoded prefixes were in the
  // WIRING, so a helper-only assertion would have passed with them still there.
  const declining = GC.renderKpiBlock({
    totalSales: 412000, transactions: 8100, avgOrderValue: 50.9, avgUPT: 2.4,
    totalDiscounts: 19000, discountRate: 0.046, flaggedStaff: 0, activeStaff: 42,
    sellingStaff: 38, storeCount: 6, salesPerHour: 940,
    deltas: { totalSalesPct: -0.03, transactions: -260, avgOrderValue: -1.4,
              avgUPT: -0.3, totalDiscounts: -412, discountRatePts: -0.004, salesPerHour: -37 },
  }, 'PP');
  ok('a period where everything fell shows no up arrows', declining.indexOf('▲') === -1);
  ok('and no "+-" anywhere in it',                        declining.indexOf('+-') === -1);
  ok('the discount decline reads as a decline',           declining.indexOf('▼ −$412.00') > -1);
  ok('the UPT decline too',                               declining.indexOf('▼ −0.3') > -1);
  ok('and the discount-rate points',                      declining.indexOf('▼ −0.4 pts') > -1);

  const flat = GC.renderKpiBlock({
    totalSales: 412000, transactions: 8100, avgOrderValue: 50.9, avgUPT: 2.4,
    totalDiscounts: 19000, discountRate: 0.046, flaggedStaff: 0, activeStaff: 42,
    sellingStaff: 38, storeCount: 6, salesPerHour: 940,
    deltas: { totalSalesPct: 0, transactions: 0, avgOrderValue: 0,
              avgUPT: 0.02, totalDiscounts: 0.004, discountRatePts: 0.00002, salesPerHour: -0.3 },
  }, 'PP');
  ok('a flat period prints no signed zeros', !/[+−−]\s*\$?0(\.0+)?( pts)?(?![.\d])/.test(flat));
}

/* ── DISCOUNTING MORE IS NOT GOOD NEWS ───────────────────────────────────────────────────────────
 * The delta's class was picked purely off the arrow glyph, and .up is green — so a period that
 * discounted MORE than the one before rendered a green ▲ on Total Discounts and Discount Rate, on
 * the screen whose entire purpose is that discounting is the thing to watch. The ARROW still says
 * which way it moved; only the color is inverted for those two. Sky, 2026-09-17, asking for an
 * up/down on Discount Rate is what sent us looking at it.
 */
console.log('\nDiscount direction reads as bad news, not good');
{
  const rising = GC.renderKpiBlock({
    totalSales: 412000, transactions: 8100, avgOrderValue: 50.9, avgUPT: 2.4,
    totalDiscounts: 19000, discountRate: 0.046, flaggedStaff: 0, activeStaff: 42,
    sellingStaff: 38, storeCount: 6, salesPerHour: 940,
    deltas: { totalSalesPct: 0.03, transactions: 260, avgOrderValue: 1.4,
              avgUPT: 0.3, totalDiscounts: 412, discountRatePts: 0.004, salesPerHour: 37 },
  }, 'PP');

  const cardOf = (label) => {
    const i = rising.indexOf('>' + label + '<');
    return i < 0 ? '' : rising.slice(i, rising.indexOf('</div></div>', i) + 12);
  };
  const discTotal = cardOf('Total Discounts');
  const discRate  = cardOf('Discount Rate');
  const sales     = cardOf('Total Sales · PP');

  ok('Total Discounts found',  !!discTotal);
  ok('Discount Rate found',    !!discRate);

  ok('discounts UP still shows an up arrow',   discTotal.indexOf('▲ +$412.00') > -1);
  ok('but is NOT coloured as good news',       discTotal.indexOf('kpi-delta up') === -1);
  ok('it is coloured as bad news',             discTotal.indexOf('kpi-delta down') > -1);

  ok('the discount RATE up shows an up arrow', discRate.indexOf('▲ +0.4 pts') > -1);
  ok('and is not green either',                discRate.indexOf('kpi-delta up') === -1);
  ok('it is red',                              discRate.indexOf('kpi-delta down') > -1);

  // And nothing else was inverted by accident — sales up is still good news.
  ok('sales up is still green', sales.indexOf('kpi-delta up') > -1);

  // The other direction: discounting LESS is the good outcome and must read that way.
  const falling = GC.renderKpiBlock({
    totalSales: 412000, transactions: 8100, avgOrderValue: 50.9, avgUPT: 2.4,
    totalDiscounts: 19000, discountRate: 0.046, flaggedStaff: 0, activeStaff: 42,
    sellingStaff: 38, storeCount: 6, salesPerHour: 940,
    deltas: { totalSalesPct: 0.03, transactions: 260, avgOrderValue: 1.4,
              avgUPT: 0.3, totalDiscounts: -412, discountRatePts: -0.004, salesPerHour: 37 },
  }, 'PP');
  const fellTotal = (() => { const i = falling.indexOf('>Total Discounts<');
    return falling.slice(i, falling.indexOf('</div></div>', i) + 12); })();
  ok('discounting LESS keeps its down arrow', fellTotal.indexOf('▼ −$412.00') > -1);
  ok('and is coloured as the good news it is', fellTotal.indexOf('kpi-delta up') > -1);
}

/* ── THE STAFF CARDS ARE THE LAST TWO ────────────────────────────────────────────────────────────
 * Sky, 2026-09-17: "move Sales / Hour left next to discount rate, so the 2 staff cards will be the
 * right two." Sales / Hour used to sit after them, splitting the money numbers around the people
 * numbers. Asserted as an ORDER rather than by eye, because a reorder is exactly the kind of edit a
 * later change undoes without noticing.
 */
/* ── THE CARD SAYS IT IS COMPARING TO THIS TIME OF DAY ───────────────────────────────────────────
 * Sky asked the question directly — "is that evaluating compared to day 4 of last period, or day 4
 * at the same time last period?" — which is the question a card that does not answer it produces.
 * It is the latter, and without the label a total that climbs through the day reads as a fault.
 */
console.log('\nThe basis line answers "compared to when?"');
{
  const base = {
    totalSales: 412000, transactions: 8100, avgOrderValue: 50.9, avgUPT: 2.4,
    totalDiscounts: 19000, discountRate: 0.046, flaggedStaff: 0, activeStaff: 42,
    sellingStaff: 38, storeCount: 6, salesPerHour: 940,
    deltas: { totalSalesPct: 0.03, transactions: 260, avgOrderValue: 1.4,
              avgUPT: 0.3, totalDiscounts: 412, discountRatePts: 0.004, salesPerHour: 37 },
  };
  const midPeriod = GC.renderKpiBlock(Object.assign({}, base, {
    comparison: { currentDays: 4, totalsDays: 4, rateDays: 14, periodDays: 14, totalsToTime: true },
  }), 'PP');
  ok('it names the part of the period',  midPeriod.indexOf('vs. first 4 days of last period') > -1);
  ok('AND that it stops at this time',   midPeriod.indexOf('vs. first 4 days of last period, to this time') > -1);

  // An evening or closed-period read is whole days, and must not claim a time cut it did not make.
  const wholeDays = GC.renderKpiBlock(Object.assign({}, base, {
    comparison: { currentDays: 4, totalsDays: 4, rateDays: 14, periodDays: 14, totalsToTime: false },
  }), 'PP');
  ok('whole-day comparison still names the days', wholeDays.indexOf('vs. first 4 days of last period') > -1);
  ok('and does NOT claim a time cut',             wholeDays.indexOf('to this time') === -1);

  // A completed period compares whole to whole and says so plainly.
  const complete = GC.renderKpiBlock(Object.assign({}, base, {
    comparison: { currentDays: 14, totalsDays: 14, rateDays: 14, periodDays: 14, totalsToTime: false },
  }), 'PP');
  ok('a finished period is just "vs. last period"', complete.indexOf('vs. last period') > -1);
  ok('with no day count',                            complete.indexOf('vs. first 14 days') === -1);

  // The rates keep their own basis — the whole prior period — and never borrow the time cut.
  ok('rates still benchmark on the full period', midPeriod.indexOf('vs. last period avg') > -1);
}

console.log('\nSmall-row order');
{
  const html = GC.renderKpiBlock({
    totalSales: 412000, transactions: 8100, avgOrderValue: 50.9, avgUPT: 2.4,
    totalDiscounts: 19000, discountRate: 0.046, flaggedStaff: 2, activeStaff: 42,
    sellingStaff: 38, storeCount: 6, salesPerHour: 940,
    deltas: { totalSalesPct: 0.03, transactions: 260, avgOrderValue: 1.4,
              avgUPT: 0.3, totalDiscounts: 412, discountRatePts: 0.004, salesPerHour: 37 },
  }, 'PP');
  const at = (label) => html.indexOf('>' + label + '<');
  ok('Sales / Hour sits after Discount Rate', at('Sales / Hour') > at('Discount Rate'));
  ok('and BEFORE Flagged Staff',              at('Sales / Hour') < at('Flagged Staff'));
  ok('Flagged then Active are the last two',
     at('Flagged Staff') < at('Active Staff') &&
     at('Active Staff') > at('Sales / Hour') && at('Active Staff') > at('Avg UPT'));
}

// ── Nothing hand-rolls it any more ───────────────────────────────────────────────────────────────
// A grep, deliberately: the six copies are gone and a seventh must not appear. This is the ONLY
// assertion here that reads the file rather than running it, and it is the one that stops the fix
// being undone by somebody writing the formula out again next to a new gauge.
console.log('\nNo seventh copy');
{
  // GC.fmtSignedPct is of course allowed to contain the formula — it IS the formula. Cut it out
  // (doc block and body) and nothing else may write one.
  const helper = /\/\*\* ══ ONE definition of "a signed percentage"[\s\S]*?\nGC\.fmtSignedPct = function[\s\S]*?\n\};\n/;
  if (!helper.test(src)) throw new Error('GC.fmtSignedPct block not found — this grep would pass vacuously');
  const rest = src.replace(helper, '');
  // What is banned is a TWO-WAY sign split — plus or minus, with no third branch for zero. That is
  // the shape that cannot print a bare "0%", whatever value it is fed. A three-way split that
  // tests a rounded value (the standings rows do) is the fix, not the bug, and is left alone.
  const handRolled = rest.match(/\? *'\+' *: *'[−−]'/g) || [];
  ok('no surface splits sign two ways, with no branch for zero  (' + handRolled.length + ' found)',
     handRolled.length === 0);
}

console.log('');
if (fail) { console.log('❌ signed_zero ' + fail + ' FAILED (' + pass + '/' + (pass + fail) + ')'); process.exit(1); }
console.log('✅ signed_zero ALL PASS (' + pass + '/' + pass + ')');
