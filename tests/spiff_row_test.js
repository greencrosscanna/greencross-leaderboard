#!/usr/bin/env node
/* GC.spiffRow — the SPIFF sell-through row drawn on a kiosk staff card (index.html).
 *
 * The rendering decisions worth locking down, all of which look fine in the one case that
 * exists today and break on the next programme SPIFF creates:
 *
 *   • OVERSHOOT. The live programme on 2026-08-29 was 110 units against a target of 55.
 *     Unclamped that is a bar at 200% of its container. The printed count must still say
 *     110/55 — clamping the DRAWING must not clamp the TRUTH.
 *   • OVERSHOOT IS STILL VISIBLE (2026-08-30). Clamping alone made 110/55 and 55/55 draw
 *     the SAME picture, with only the printed count separating them. The target hash now
 *     slides left to 100/rawPct% so the bar itself carries "beaten, by this much" — the
 *     same over-target language .emp-bar uses on the sales bar directly above it.
 *   • ZERO. 0 of 5 has to draw an empty track; the empty bar is the prompt to sell.
 *     A row that renders nothing at zero would hide every SPIFF nobody has started.
 *   • THE PAYOUT. "$25" beside an unhit programme reads as money already banked.
 *
 * Per tests/_harness.js's rule this never reimplements: the real GC.spiffRow body is
 * extracted from the shipped index.html and run (same approach as pace_marker_test.js).
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { run, _eq_, _ok_ } = require('./_harness');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grabGC(name) {
  const re = new RegExp('\\nGC\\.' + name + ' = function\\([^)]*\\) \\{[\\s\\S]*?\\n\\};\\n');
  const m = src.match(re);
  if (!m) throw new Error('could not extract GC.' + name + ' from index.html');
  return m[0];
}

const ctx = { GC: {}, Math: Math, String: String, Number: Number };
vm.createContext(ctx);
['esc', 'spiffRow'].forEach((n) => vm.runInContext(grabGC(n), ctx));
const GC = ctx.GC;

/* The fill is ANIMATED now (inline width starts at 0%, animateBars sets it from
   data-final), so the drawn length lives in data-final — reading `width:` here would
   report 0 for every row and pass regardless of the maths. */
const barPct   = (h) => { const m = h.match(/data-final="(\d+)%"/); return m ? +m[1] : null; };
const markPct  = (h) => { const m = h.match(/emp-spiff-mark" style="left:(\d+)%/); return m ? +m[1] : null; };
const isOver   = (h) => h.indexOf('emp-spiff-bar-wrap bar-over') > -1;
/* Nothing should render ticks any more — this guards the removal, so a future revert
   that reintroduces them has to update this suite deliberately rather than by accident. */
const hasTicks = (h) => h.indexOf('emp-spiff-tick') > -1;

function sp(over) {
  return Object.assign({
    vendor: 'Green Cross', program: 'Green Cross - Test4',
    units: 110, target: 55, hit: true, earned: 25, totalEarned: 25, more: 0,
  }, over || {});
}

const tests = {

  nothingWithoutASpiff() {
    _eq_('null renders nothing',      GC.spiffRow(null), '');
    _eq_('undefined renders nothing', GC.spiffRow(undefined), '');
  },

  /* ONE SHAPE AT EVERY SIZE. Sky chose the bar over the ticks on 2026-08-29 after seeing
     both on the real board, so a target of 5 and a target of 55 must render identically. */
  everyTargetSizeUsesABar() {
    [5, 12, 13, 55, 400].forEach(function (t) {
      const h = GC.spiffRow(sp({ units: 1, target: t, hit: false, earned: 0, totalEarned: 0 }));
      _ok_('target ' + t + ' uses a bar', h.indexOf('emp-spiff-bar') > -1);
      _ok_('target ' + t + ' draws no ticks', !hasTicks(h));
    });
  },

  barFillMatchesProgress() {
    _eq_('2 of 5 is 40%',   barPct(GC.spiffRow(sp({ units: 2,  target: 5,  hit: false }))), 40);
    _eq_('20 of 55 is 36%', barPct(GC.spiffRow(sp({ units: 20, target: 55, hit: false }))), 36);
  },

  /* ZERO IS DRAWN — the empty track is the prompt. */
  zeroDrawsAnEmptyRow() {
    const h = GC.spiffRow(sp({ units: 0, target: 5, hit: false, earned: 0, totalEarned: 0 }));
    _ok_('renders',         h.length > 0);
    _ok_('has a bar',       h.indexOf('emp-spiff-bar') > -1);
    _eq_('fill is 0%',      barPct(h), 0);
    _ok_('count says 0/5',  h.indexOf('0/5') > -1);
    _ok_('no payout shown', h.indexOf('emp-spiff-paid') === -1);
  },

  /* THE LIVE CASE. Drawing clamps; the printed count does not. */
  overshootClampsTheDrawingNotTheCount() {
    const h = GC.spiffRow(sp());              // 110 of 55, hit
    _eq_('bar caps at 100%', barPct(h), 100);
    _ok_('true count still printed', h.indexOf('110/55') > -1);

    const t = GC.spiffRow(sp({ units: 9, target: 5, hit: true }));
    _eq_('small overshoot also caps', barPct(t), 100);
    _ok_('true count still printed',  t.indexOf('9/5') > -1);
  },

  /* THE HASH IS WHAT MAKES THE OVERSHOOT VISIBLE. Without it 110/55 and 55/55 are the
     same full bar; with it the hash sits at the fraction of the run the target was. */
  overTargetSlidesTheHash() {
    const h = GC.spiffRow(sp());              // 110 of 55 = 200% -> hash at 50%
    _ok_('flagged over',   isOver(h));
    _eq_('hash at 50%',    markPct(h), 50);
    _ok_('glow start set', h.indexOf('--mark-pct:50%') > -1);

    const q = GC.spiffRow(sp({ units: 20, target: 5, hit: true }));  // 400% -> 25%
    _eq_('4x over puts the hash at 25%', markPct(q), 25);
  },

  /* At or under target the hash would sit on the bar's own end and say nothing. */
  atOrUnderTargetDrawsNoHash() {
    const exact = GC.spiffRow(sp({ units: 55, target: 55, hit: true }));
    _eq_('exactly on target fills the bar', barPct(exact), 100);
    _ok_('and draws no hash',   markPct(exact) === null);
    _ok_('and is not bar-over', !isOver(exact));

    const under = GC.spiffRow(sp({ units: 2, target: 5, hit: false }));
    _ok_('under draws no hash',   markPct(under) === null);
    _ok_('under is not bar-over', !isOver(under));

    const zero = GC.spiffRow(sp({ units: 0, target: 0, hit: false }));
    _ok_('degenerate target draws no hash', markPct(zero) === null);
  },

  /* STARTED MUST NOT LOOK LIKE NOT-STARTED. A SPIFF target is a unit count over a
     fortnight, so real cards sit in single-digit percent for days — live on 2026-08-30
     had 2/127, which drew a ~4px fill that was indistinguishable from an empty track.
     `has-progress` carries the CSS floor; it must key off UNITS, not the rounded pct,
     or 2/127 rounding toward zero would take the floor away with it. */
  startedIsDistinguishableFromNotStarted() {
    const started = GC.spiffRow(sp({ units: 2, target: 127, hit: false, earned: 0, totalEarned: 0 }));
    _ok_('tiny progress is flagged', started.indexOf('has-progress') > -1);
    _eq_('and still draws its true 2%', barPct(started), 2);

    const none = GC.spiffRow(sp({ units: 0, target: 127, hit: false, earned: 0, totalEarned: 0 }));
    _ok_('zero is NOT flagged — the empty track is the prompt', none.indexOf('has-progress') === -1);
    _eq_('and stays at 0%', barPct(none), 0);

    /* Rounds to 0% but a unit HAS been sold: the flag must survive the rounding. */
    const sliver = GC.spiffRow(sp({ units: 1, target: 400, hit: false, earned: 0, totalEarned: 0 }));
    _eq_('rounds to 0%',           barPct(sliver), 0);
    _ok_('but is still flagged',   sliver.indexOf('has-progress') > -1);
  },

  /* The whole point of the change: the SPIFF bar speaks the sales bar's language. */
  sharesTheSalesBarTreatment() {
    const h = GC.spiffRow(sp({ units: 2, target: 5, hit: false }));
    _ok_('fill is animated from data-final', h.indexOf('data-final="40%"') > -1);
    _ok_('starts collapsed so it can animate', h.indexOf('width:0%') > -1);
    _ok_('bar sits in a positioned wrap',      h.indexOf('emp-spiff-bar-wrap') > -1);
  },

  payoutOnlyOnceEarned() {
    const miss = GC.spiffRow(sp({ units: 2, target: 5, hit: false, earned: 0, totalEarned: 0 }));
    _ok_('unhit shows no money', miss.indexOf('emp-spiff-paid') === -1);

    const hit = GC.spiffRow(sp());
    _ok_('hit shows the payout', hit.indexOf('+$25') > -1);
    _ok_('and is styled as hit', hit.indexOf('emp-spiff hit') > -1);
  },

  /* A card leads with one programme; the rest are counted, never silently dropped. */
  extraProgrammesAreCounted() {
    const h = GC.spiffRow(sp({ more: 2, totalEarned: 60 }));
    _ok_('says how many more', h.indexOf('+2 more') > -1);
    _ok_('payout is the total across all of them', h.indexOf('+$60') > -1);
    _ok_('one more is singular-safe', GC.spiffRow(sp({ more: 1 })).indexOf('+1 more') > -1);
    _ok_('zero more says nothing', GC.spiffRow(sp({ more: 0 })).indexOf('more') === -1);
  },

  /* A vendor name is third-party text landing in innerHTML on the all-staff screen. */
  vendorNameIsEscaped() {
    const h = GC.spiffRow(sp({ vendor: '<img src=x onerror=alert(1)>' }));
    _ok_('no raw tag survives', h.indexOf('<img') === -1);
    _ok_('escaped instead',     h.indexOf('&lt;img') > -1);
  },

  /* Degenerate data from a misconfigured programme must not throw on the kiosk. */
  zeroTargetDoesNotDivideByZero() {
    const h = GC.spiffRow(sp({ units: 3, target: 0, hit: false, earned: 0, totalEarned: 0 }));
    _ok_('renders something', h.length > 0);
    _eq_('bar sits at 0%',    barPct(h), 0);
    _ok_('count is bare units, no "/0"', h.indexOf('/0') === -1);
  },

  missingFieldsFallBack() {
    const h = GC.spiffRow({ units: 1, target: 4 });
    _ok_('renders with no vendor', h.length > 0);
    _ok_('labelled SPIFF',         h.indexOf('SPIFF') > -1);
    _eq_('bar still drawn at 25%', barPct(h), 25);
  },
};

run('spiff_row', tests);
