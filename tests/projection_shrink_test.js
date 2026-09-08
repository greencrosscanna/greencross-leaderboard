#!/usr/bin/env node
/* projectedEod_ — the end-of-day projection, shrunk toward goal while the day is young.
 * Loads the SHIPPED dutchie_fetch.gs as text and runs the real function (tests/_harness.js).
 *
 * THE BUG THIS EXISTS TO PREVENT. The raw projection is sales ÷ expected-fraction-so-far. At
 * 10am a store has banked ~14% of its day, so the divisor is ~0.14 and every real dollar moves
 * the projection by SEVEN. One $126 order swings a $4,155-goal store by 25 points of goal. The
 * kiosk drew that as a fact on a gauge.
 *
 * Replaying 84 store-days hour by hour (six stores, 14 days) against where each day actually
 * finished, the RAW projection's median error in points of goal was:
 *
 *     10am 23.2   11am 19.6   12pm 12.5   1pm 13.0   3pm 10.1   5pm 4.7   7pm 3.2
 *
 * i.e. the morning readout typically missed the finish by twenty-plus points while moving twelve
 * points an hour. The fix is shrinkage toward the goal — the right prior, because the goal is
 * itself built from this store's same-DOW history — with k = 0.40 fitted to minimize median
 * absolute error across all 84 days.
 *
 * SHRINKAGE IS A TRADE AND THIS TEST HOLDS BOTH ENDS OF IT. Pulling every day toward the middle
 * helps the days that belong near the middle and hurts the days that genuinely do not. Measured,
 * morning readings, median error in points of goal:
 *
 *                        n     raw    shrunk        jitter raw → shrunk
 *     ordinary days     55    19.8 →   9.3            12.5 →  5.8
 *     most extreme ⅓    29    11.0 →  11.8             9.7 →  4.8
 *     everything        84    16.7 →  10.7            11.1 →  5.4
 *
 * So ordinary days — two of every three — read better than twice as accurately, extreme days pay
 * under a point, and the hour-to-hour thrash halves everywhere. That is worth having, but the
 * cost is real, so BOTH fixtures below are real store-days and the assertions bound both: the
 * ordinary set must improve substantially, and the extreme set must not degrade by more than a
 * couple of points. A change to k that buys the middle by wrecking the tails fails here.
 *
 * The first version of this file used only the extreme days and failed — correctly. That
 * is why the split exists rather than a fixture chosen to agree with the fit.
 *
 * Fixtures: per store, the day nearest that store's median finished pace (ORDINARY), and its
 * worst and best day (EXTREME), out of the same 14 days. Hourly revenue is as the app recorded
 * it; the per-store curve is the average cumulative shape the analysis used, and the test
 * recomputes the projection from it exactly as the server does.
 * Sky's call, 2026-09-08 ("fix the morning jitter").
 */
'use strict';
const { load } = require('./_harness');
const ctx = load(['dutchie_fetch.gs']);
const projectedEod_ = ctx.projectedEod_;

let pass = 0, fail = 0;
const ok = (m, c) => { c ? (pass++, console.log('  ok  ' + m)) : (fail++, console.log('  FAIL ' + m)); };

// Average cumulative share of the day's revenue banked by the END of each hour, 8a..9p.
const SHAPE = {
  baseline:   [0.0493,0.1016,0.1729,0.2332,0.3067,0.3896,0.4741,0.5689,0.6575,0.7492,0.8089,0.8891,0.9671,1.0001],
  center:     [0.0272,0.0832,0.1412,0.1956,0.2733,0.3493,0.4243,0.5322,0.6043,0.6857,0.7866,0.8843,0.9393,1],
  century:    [0.0312,0.0666,0.1237,0.1794,0.2481,0.3407,0.4209,0.5189,0.6116,0.7140,0.7899,0.8676,0.9332,1.0001],
  commercial: [0.0445,0.0908,0.1512,0.2274,0.3119,0.3817,0.4658,0.5408,0.6437,0.7386,0.8177,0.8906,0.9537,1],
  portland:   [0.0326,0.0653,0.1129,0.1655,0.2292,0.2917,0.3696,0.4645,0.5535,0.6445,0.7248,0.8314,0.9310,1.0001],
  river:      [0.0404,0.0888,0.1408,0.2118,0.2931,0.3752,0.4451,0.5533,0.6374,0.7283,0.8068,0.8754,0.9473,1.0001],
};
// [store, goal, finished revenue, hourly revenue 8a..9p]
// Each store's day nearest its OWN median finished pace — what most days look like.
const ORDINARY_DAYS = [
  ['baseline',3203,2998,[0,78,234,289,420,244,251,83,284,375,113,175,381,70]],
  ['center',1851,1670,[17,208,68,115,52,140,86,276,95,147,100,260,35,72]],
  ['century',5039,4655,[5,110,324,204,341,620,381,449,688,354,262,433,65,421]],
  ['commercial',6915,6711,[211,186,340,610,562,428,779,494,353,759,957,412,346,273]],
  ['portland',2748,2801,[33,46,232,88,123,235,568,193,292,51,153,292,349,148]],
  ['river',4506,4177,[96,122,302,265,567,207,357,443,360,429,421,210,251,147]],
];
// Each store's WORST and BEST finished day — where shrinkage costs rather than helps.
const EXTREME_DAYS = [
  ['baseline',2485,1951,[94,112,48,18,175,204,138,155,141,175,114,301,205,72]],
  ['baseline',3743,5143,[322,186,310,102,304,284,263,991,639,387,223,433,571,127]],
  ['center',1861,1467,[71,40,81,101,201,121,134,140,127,25,151,157,0,118]],
  ['center',1532,1913,[34,126,259,38,88,102,13,207,157,183,411,189,43,63]],
  ['century',4582,3863,[65,102,160,150,447,199,386,211,258,408,366,316,334,463]],
  ['century',4481,5155,[184,460,396,241,479,476,290,497,598,162,569,391,261,151]],
  ['commercial',5995,4501,[97,73,305,442,399,252,497,252,773,244,240,472,205,250]],
  ['commercial',6442,8233,[270,444,538,495,950,567,687,500,922,1048,636,531,253,393]],
  ['portland',2793,1823,[41,46,102,130,105,156,153,195,232,102,43,118,224,175]],
  ['portland',2610,3355,[103,58,227,171,161,155,313,249,445,198,186,621,240,229]],
  ['river',6002,4480,[161,296,193,401,305,617,130,236,571,419,313,288,324,227]],
  ['river',4755,6213,[189,325,257,278,975,477,778,848,481,312,352,347,371,224]],
];
const HOURS = ['8a','9a','10a','11a','12p','1p','2p','3p','4p','5p','6p','7p','8p','9p'];
const MIN_PROJ_IDX = 2;   // MIN_PROJ_HOURS = 2 → first projection at 10a
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** Replay one day: displayed pace, in points of goal, at the end of each hour. */
function replay(day, shrunk) {
  const [slug, goal, , hourly] = day;
  const sh = SHAPE[slug];
  let cum = 0;
  return hourly.map((v, i) => {
    cum += v;
    if (i < MIN_PROJ_IDX) return null;
    const proj = shrunk ? projectedEod_(cum, sh[i], goal) : Math.round(cum / sh[i]);
    return ((proj - goal) / goal) * 100;
  });
}

/** Morning (10a–12p) median |error vs. the finished day| and median hour-to-hour move. */
function morning(days) {
  const err = [], jit = [];
  days.forEach(d => {
    const finalPace = ((d[2] - d[1]) / d[1]) * 100;
    const raw = replay(d, false), shr = replay(d, true);
    for (let i = MIN_PROJ_IDX; i <= 4; i++) {
      if (raw[i] == null) continue;
      err.push([Math.abs(raw[i] - finalPace), Math.abs(shr[i] - finalPace)]);
      if (raw[i - 1] != null) jit.push([Math.abs(raw[i] - raw[i - 1]), Math.abs(shr[i] - shr[i - 1])]);
    }
  });
  return {
    errRaw: median(err.map(x => x[0])), errNew: median(err.map(x => x[1])),
    jitRaw: median(jit.map(x => x[0])), jitNew: median(jit.map(x => x[1])),
  };
}
const show = (l, m) => console.log('      ' + l.padEnd(10)
  + ' error ' + m.errRaw.toFixed(1) + ' → ' + m.errNew.toFixed(1)
  + '   jitter ' + m.jitRaw.toFixed(1) + ' → ' + m.jitNew.toFixed(1));

console.log('\nOrdinary days — most days — read far closer to where they finish');
{
  const m = morning(ORDINARY_DAYS);
  ok('morning readings land closer to the finished day', m.errNew < m.errRaw);
  ok('and the gain is large, not noise — at least a third better', m.errNew < m.errRaw * 0.67);
  show('ordinary', m);
}

console.log('\nExtreme days pay for it — but the bill stays small');
{
  // A genuine blowout or collapse IS visible from the morning, so pulling it toward the goal
  // costs accuracy. That is the trade, and it must stay a rounding error rather than a reversal.
  const m = morning(EXTREME_DAYS);
  ok('degradation on the worst/best days stays under 3 points of goal',
     m.errNew - m.errRaw < 3);
  ok('and it is a cost, not a collapse — still within half the raw error',
     m.errNew < m.errRaw * 1.5);
  show('extreme', m);
}

console.log('\nThe needle stops thrashing before lunch — on BOTH kinds of day');
{
  const o = morning(ORDINARY_DAYS), x = morning(EXTREME_DAYS);
  ok('hour-to-hour movement is cut on ordinary days', o.jitNew < o.jitRaw * 0.75);
  ok('hour-to-hour movement is cut on extreme days too', x.jitNew < x.jitRaw * 0.75);
}

console.log('\nIt converges on the truth — no residual shrink at close');
{
  // The whole point of the (1+k) numerator. Plain f/(f+k) tops out at 0.71 and would leave the
  // 9pm board permanently 29% short of the real gap.
  EXTREME_DAYS.concat(ORDINARY_DAYS).forEach(d => {
    const [slug, goal, , hourly] = d;
    const total = hourly.reduce((a, b) => a + b, 0);
    const atClose = projectedEod_(total, SHAPE[slug][13], goal);
    ok(slug + ' @ 9pm projects its own takings, unshrunk',
       Math.abs(atClose - Math.round(total / SHAPE[slug][13])) <= 1);
  });
}

console.log('\nDirection is never inverted, and edges hold');
{
  ok('a store running hot still reads ahead of goal',
     projectedEod_(900, 0.15, 4000) > 4000);
  ok('a store running cold still reads behind goal',
     projectedEod_(200, 0.15, 4000) < 4000);
  ok('shrunk toward goal, so it reads less extreme than the raw number early',
     projectedEod_(900, 0.15, 4000) < Math.round(900 / 0.15));
  ok('a near-zero denominator returns no projection at all',
     projectedEod_(500, 0.01, 4000) === 0);
  ok('no goal to shrink toward → the raw extrapolation',
     projectedEod_(600, 0.30, 0) === 2000);
  ok('zero sales projects zero, not a negative',
     projectedEod_(0, 0.50, 4000) >= 0);
  // A day exactly on plan must read exactly on plan at every hour — shrinkage toward the goal
  // cannot move a number that is already the goal.
  let onPlan = true;
  for (let f = 0.05; f <= 1; f += 0.05) if (projectedEod_(4000 * f, f, 4000) !== 4000) onPlan = false;
  ok('a day tracking plan exactly reads the goal all day', onPlan);
}

console.log('\nThe constant is fitted — changing it means re-fitting');
{
  ok('k is the fitted 0.40', ctx.PROJ_SHRINK_K === 0.40);
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' : '✅ projection shrink ALL PASS ') + (pass + fail));
process.exit(fail ? 1 : 0);
