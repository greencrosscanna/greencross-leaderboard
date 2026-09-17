#!/usr/bin/env node
/* The kiosk's SPIFF button and panel — GC.spiffButtonInner, GC.spiffPanel and renderHeader in
 * index.html. Settings → Include SPIFF is the ONE switch for the button and the card rows
 * (Sky, 2026-09-10), and since 2026-09-17 the panel draws SPIFF's REDESIGNED kiosk board — Sky's
 * decision of 2026-09-16 that Leaderboard adopts that design in its own panel rather than framing
 * SPIFF's page, so SPIFF's uptime is not the wall screen's uptime. The design is SPIFF's handoff
 * bundle (greencross-spiff/design_handoff_spiff_kiosk_board/README.md), which is the source of
 * truth for the look — not this file and not store.css.
 *
 * What these lock down, each a way the most visible screen in the company could say something
 * untrue:
 *   • THE SWITCH DECIDES THE BUTTON. Off hides it; on shows it — even with nothing running, since
 *     the setting is what decides, not the day's programs. The old button followed SPIFF's store
 *     link instead, which no store had, so the setting and the button could never agree.
 *   • NO GUESSED BOUNTY. A program with no stated payout and nobody hit yet shows no dollar amount
 *     at all — never one worked out from thin air.
 *   • NO EARNINGS PER PERSON. A kiosk is a shared screen a customer can read over the counter, so
 *     what somebody was paid never reaches it — even though it is sitting on the payload we hold.
 *   • THE BOARD IS RANKED AND KEEPS ITS ZEROS, and a bar is only drawn against a denominator that
 *     exists — a goal for a flat program, the leader for a per-unit one, nothing otherwise.
 *   • SPIFF'S COPY IS OPTIONAL. The product, the store goal and Tawny's tips only exist if SPIFF
 *     published them; every block is absent-safe, because absent is the normal state.
 *   • "UNAVAILABLE" IS NOT "NOTHING RUNNING". A failed read must not tell the floor there is no SPIFF.
 *   • Days left is calendar arithmetic on TEXT dates, so no timezone can move it a day.
 *
 * Per tests/_harness.js's rule this never reimplements: the real functions are extracted from the
 * shipped index.html and run.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { run, _eq_, _ok_ } = require('./_harness');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grabGC(name) {
  const m = src.match(new RegExp('\\nGC\\.' + name + ' = function\\([^)]*\\) \\{[\\s\\S]*?\\n\\};\\n'));
  if (!m) throw new Error('could not extract GC.' + name + ' from index.html');
  return m[0];
}
/* A 2-space-indented function inside a view IIFE. Several views each have their own renderHeader,
   so take the one whose body contains `marker` — here, the kiosk's, which draws the SPIFF button. */
function grabFn(name, marker) {
  const re = new RegExp('\\n  function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n', 'g');
  const all = src.match(re) || [];
  const m = all.filter((b) => !marker || b.indexOf(marker) > -1);
  if (m.length !== 1) throw new Error('expected exactly one ' + name + ' containing ' + marker + ', found ' + m.length);
  return m[0];
}

const ctx = {
  Math, String, Number, Object, Date,
  setTimeout: () => 0, clearTimeout: () => {},   // renderHeader schedules a paint; nothing to run here
  e: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  findAvatarCfg_: () => null,
  _avatarConfigs: {},
  GC: {
    auth: { load: () => ({ role: 'budtender', displayName: 'Baseline Kiosk', initials: 'BK' }) },
    LOGO_PNG: 'logo.png', VERSION: 'v1.test',
    nameToKey: (s) => String(s || '').toLowerCase(),
    ucAvatarHtml: () => '<i></i>',
  },
};
ctx.window = { GC: ctx.GC };   // the header's version badge reads window.GC
vm.createContext(ctx);
['esc', 'spiffButtonInner', 'spiffPanel'].forEach((n) => vm.runInContext(grabGC(n), ctx));
vm.runInContext(grabFn('renderHeader', 'kiosk-spiff-btn'), ctx);
const GC = ctx.GC;

const TODAY = '2026-09-09';
function prog(over) {
  return Object.assign({
    id: 'p', vendor: 'Dutchie Farms', name: 'Pre-roll Blitz', start: '2026-09-01', end: '2026-09-10',
    target: 5, reward: 15, earned: 15, hitCount: 1,
    people: [ { name: 'Marcus Chen', units: 5, target: 5, hit: true, earned: 15 },
              { name: 'Lina Park',   units: 2, target: 5, hit: false, earned: 0 } ],
  }, over || {});
}
const panel = (list, o) => GC.spiffPanel(list, Object.assign({ ok: true, today: TODAY, storeName: 'Baseline' }, o || {}));
const btnOf = (html) => (html.match(/<button class="kiosk-spiff-btn[^>]*>[\s\S]*?<\/button>/) || [''])[0];

const tests = {

  /* ── THE BUTTON ── */
  switchOffHidesTheButton() {
    const b = btnOf(ctx.renderHeader({ name: 'Baseline' }, { on: false, programs: [prog()] }));
    _ok_('button is in the markup (so a refresh can reveal it)', !!b);
    _ok_('but hidden', /\shidden>/.test(b));
  },

  switchOnShowsTheButton() {
    const h = ctx.renderHeader({ name: 'Baseline' }, { on: true, programs: [prog(), prog({ id: 'q' })] });
    const b = btnOf(h);
    _ok_('visible', !/\shidden>/.test(b));
    // Sky, 2026-09-14: no "N live" count on the button.
    _ok_('no "live" count', !/live/i.test(b.replace(/kiosk-spiff-btn/g, '')));
    _ok_('not dimmed', b.indexOf('kiosk-spiff-btn none') === -1);
    _ok_('sits immediately left of the clock', /kiosk-hd-right">\s*<button class="kiosk-spiff-btn[\s\S]*?<\/button><div class="kiosk-clock"/.test(h));
    _ok_('and no longer before the logo', h.indexOf('kiosk-spiff-btn') > h.indexOf('gc-logo-img'));
  },

  switchOnWithNothingRunningStillShowsIt() {
    const b = btnOf(ctx.renderHeader({ name: 'Baseline' }, { on: true, programs: [] }));
    _ok_('visible — the setting decides, not the day', !/\shidden>/.test(b));
    _ok_('dimmed', b.indexOf('kiosk-spiff-btn none') > -1);
    _ok_('no count', b.indexOf('live') === -1);
  },

  missingStateIsOff() {
    _ok_('no spiff object → hidden', /\shidden>/.test(btnOf(ctx.renderHeader({ name: 'B' }, undefined))));
    _ok_('"true" as text is not on', /\shidden>/.test(btnOf(ctx.renderHeader({ name: 'B' }, { on: 'true' }))));
  },

  /* ── THE PANEL ── */
  unavailableIsNotNothingRunning() {
    const h = panel([prog()], { ok: false });
    _ok_('says the numbers are unavailable', /aren’t available/.test(h));
    _ok_('does NOT say nothing is running', h.indexOf('No SPIFF running') === -1);
  },

  /* NOTHING RUNNING IS A REAL SCREEN, not a dead one — the handoff's own point. It still must not
     be reachable from a failed read, which unavailableIsNotNothingRunning covers from the other side. */
  emptyListSaysSoByStore() {
    const h = panel([]);
    _ok_('the headline', h.indexOf('Nothing running right now') > -1);
    _ok_('names the store in the body', h.indexOf('The next SPIFF at Baseline shows up here') > -1);
    /* NO "LAST ONE" CHIP — Sky's call on 2026-09-17 ("no, we don't need the last one option"), not
       a missing field. SPIFF publishes `last_programs` on every scope now, so this guard is the
       only thing standing between a future session and building a screen he declined. The headline
       and two lines are the whole state: there is nothing to chase today. */
    _ok_('and shows no last program', h.indexOf('Last one') === -1 && h.indexOf('LAST') === -1);
  },

  /* NO PAGE-LEVEL STORE NAME AND NO PROGRAM COUNT. The popup's own bar already says SPIFF and
     names the store; repeating it above nothing else is what Sky filed on 2026-09-16 ("we can
     remove the top header text Century 1 program running since this is embedded in Century's
     kiosk"), and the handoff had removed it for the same reason. This is the guard that keeps it
     removed — the old header is exactly the thing a future "let's label the panel" would restore. */
  noHeaderChromeTheModalAlreadySupplies() {
    const h = panel([
      prog(),
      prog({ id: 'q', reward: 25, earned: 25, people: [ { name: 'Marcus Chen', units: 9, target: 9, hit: true, earned: 25 } ] }),
    ]);
    _ok_('no store name heading', h.indexOf('ksp-head') === -1);
    _ok_('no "N programs running" count', !/programs? running/.test(h));
    _ok_('but both programs are still drawn', (h.match(/ksp-prog-set/g) || []).length === 2);
  },

  /* NO GUESSED BOUNTY, and the rule got sharper when SPIFF started publishing the payout: a stated
     payout is right from the first morning, an inferred one is null until somebody has hit. */
  statedPayoutBeatsTheInferredOne() {
    _ok_('inferred reward shows', panel([prog()]).indexOf('<b>$15</b><span>when you hit your goal') > -1);
    _ok_('SPIFF\'s stated payout wins over it',
         panel([prog({ payout: 20 })]).indexOf('<b>$20</b><span>when you hit your goal') > -1);
    _ok_('and it shows before anyone has hit',
         panel([prog({ payout: 20, reward: null, earned: 0,
                       people: [ { name: 'A', units: 1, target: 5, hit: false, earned: 0 } ] })])
           .indexOf('<b>$20</b>') > -1);
  },

  noBountyIsNoTileAtAll() {
    const h = panel([prog({ reward: null, earned: 0, people: [ { name: 'A', units: 1, target: 5, hit: false, earned: 0 } ] })]);
    _ok_('the target still shows', h.indexOf('<b>5</b><span>units to hit your bonus') > -1);
    _ok_('no dollar amount anywhere', h.indexOf('$') === -1);
    _ok_('and no empty "when you hit it" label', h.indexOf('when you hit it') === -1);
  },

  /* SPIFF'S OWN COPY IS OPTIONAL. product, storeGoal and tips reach us only if SPIFF publishes them
     on the row; a card missing them must still be a complete card, never a heading over a gap. */
  spiffCopyRendersWhenPublishedAndVanishesWhenNot() {
    const bare = panel([prog()]);
    _ok_('no SELL block without a product', bare.indexOf('ksp-sell') === -1);
    _ok_('no store track without a store goal', bare.indexOf('ksp-store') === -1);
    _ok_('no tips card over nothing — absent, not empty', bare.indexOf('How to sell it') === -1);
    /* The "as of" stamp is gone from this surface by design: the popup's own bar carries the
       chrome. measuredAt still arrives on the payload, it is simply never drawn — so this asserts
       absence even when SPIFF published one, which the `full` case below feeds in. */
    _ok_('and no "as of" stamp at all', bare.indexOf('as of') === -1);

    const full = panel([prog({ product: 'Live Resin Dank Tank | 2g', storeGoal: 42,
                               measuredAt: '2026-09-09 21:56:08',
                               tips: ['Lead with the live resin', 'Pair it with a pre-roll'] })]);
    _ok_('product', full.indexOf('Live Resin Dank Tank | 2g') > -1);
    /* SELL SHARES A LINE WITH THE PROGRAM NAME (Sky, 2026-09-17). It had its own full-width row,
       and on a real kiosk that row cost exactly the height Tawny's tips needed — on a wall screen
       nobody scrolls, so below the fold is gone, not merely further down. Asserting the STRUCTURE
       rather than the pixels: the well is inside .ksp-top with the name, above the status row. */
    _ok_('the well is beside the name, not under it',
         /<div class="ksp-top"><div class="ksp-name">[^<]*<\/div><div class="ksp-sell">/.test(full));
    _ok_('and the status row comes after both', full.indexOf('ksp-top') < full.indexOf('ksp-tags'));
    _ok_('store goal, as the board\'s own track', full.indexOf('7 of 42 units') > -1);
    _ok_('tips as a list', /<ul class="ksp-tips"><li><span>Lead with the live resin<\/span><\/li><li><span>Pair it with a pre-roll<\/span><\/li><\/ul>/.test(full));
    _ok_('and still no stamp even when SPIFF published one', full.indexOf('as of') === -1);
    _ok_('a blank tip is dropped, not rendered as an empty bullet',
         panel([prog({ tips: ['Real one', '  ', ''] })]).indexOf('<li><span></span></li>') === -1);
  },

  /* TODAY COUNTS as a selling day (Sky, 2026-09-11: "use spiff's day count, today counts"). SPIFF's
     page counts inclusively and ours did not, so the same program read "3 days left" there and
     "2 days left" on the kiosk. The last two days keep the clearer wording. */
  daysLeftIsCalendarArithmetic() {
    const t = (end) => panel([prog({ end })]);   // TODAY is 2026-09-09
    /* It is a FIGURE now, not a phrase in the date line — the handoff's third headline number,
       beside what it pays and what you have to sell. The arithmetic is unchanged and still
       inclusive, so a program ending today has one day left on it, not none. */
    _ok_('today is one day left, singular', t('2026-09-09').indexOf('<b>1</b><span>day left, ends Sep 9') > -1);
    _ok_('tomorrow is two',  t('2026-09-10').indexOf('<b>2</b><span>days left') > -1);
    _ok_('two days out reads THREE — today is one of them', t('2026-09-11').indexOf('<b>3</b><span>days left') > -1);
    _ok_('four days out reads five', t('2026-09-13').indexOf('<b>5</b><span>days left') > -1);
    _ok_('and never the exclusive count again', t('2026-09-13').indexOf('<b>4</b><span>days') === -1);
    _ok_('across a month end', panel([prog({ end: '2026-10-01' })], { today: '2026-09-30' }).indexOf('<b>2</b><span>days left, ends Oct 1') > -1);
    /* Gold at three or fewer, which is the handoff's threshold — not the two-day "ending" border
       the old card used. The one thing on this panel that is running out gets the attention color. */
    _ok_('three days out is gold',  t('2026-09-11').indexOf('ksp-fig soon') > -1);
    _ok_('four days out is not',    t('2026-09-12').indexOf('ksp-fig soon') === -1);
    _ok_('date range printed',      t('2026-09-13').indexOf('Sep 1 – Sep 13') > -1);
  },

  /* IT IS A BOARD, NOT A ROSTER. Ranked by units descending with a rank number, everyone at the
     store on it including everyone at zero — a board that lists only sellers cannot tell you
     whether you are behind or simply not in this one. */
  theBoardIsRankedAndKeepsItsZeros() {
    const h = panel([prog({ people: [
      { name: 'Avery Liu',  units: 0,   target: 6,  hit: false, earned: 0 },
      { name: 'Lina Park',  units: 110, target: 55, hit: true,  earned: 25 },
      { name: 'Marcus Chen', units: 7,  target: 55, hit: false, earned: 0 },
    ] })]);
    _ok_('the leader is rank 1', h.indexOf('<span class="ksp-rank">1</span><span class="ksp-who">Lina Park') > -1);
    _ok_('second by units',      h.indexOf('<span class="ksp-rank">2</span><span class="ksp-who">Marcus Chen') > -1);
    _ok_('the zero is still on the board, last', h.indexOf('<span class="ksp-rank">3</span><span class="ksp-who">Avery Liu') > -1);
    _ok_('the payload order is not what was drawn', h.indexOf('Lina Park') < h.indexOf('Avery Liu'));
    _ok_('board title',  h.indexOf('Where everyone stands') > -1);
    _ok_('and the hit count', h.indexOf('>1 of 3 hit<') > -1);

    /* THE BAR IS CLAMPED AT THE GOAL. 110 of 55 is twice the target and draws a full bar, not a
       double-width one — the overshoot is already stated in words one column to the right. */
    _ok_('a hit row is flagged', h.indexOf('class="ksp-row hit"') > -1);
    _ok_('over target clamps to 100%', h.indexOf('<span style="width:100%"></span>') > -1);
    _ok_('a partial bar is its own fraction', h.indexOf('<span style="width:13%"></span>') > -1);
    _ok_('zero draws a genuinely empty track', h.indexOf('<span style="width:0%"></span>') > -1);
    _ok_('and is marked as a zero row', h.indexOf('class="ksp-row zero"') > -1);
    _ok_('counts carry the goal as a suffix', h.indexOf('>110<i>/55</i>') > -1);

    /* NO EARNINGS ON A SHARED SCREEN — a customer can read a kiosk over the counter, which is why
       SPIFF's own storeView returns none. The figure is on our payload and must not reach here. */
    _ok_('nobody\'s pay is on the board', h.indexOf('$25') === -1 && h.indexOf('+$') === -1);
  },

  /* PER-UNIT HAS NO THRESHOLD (SPIFF, 2026-09-12). It pays for every unit sold, so "when you hit
     it" is a wrong dollar figure and a target tile promises a bonus at a number that buys nothing.
     Portland Heights runs one at $0.75. This is the assertion that keeps a wall screen honest. */
  perUnitDropsTheThresholdAndSaysPerUnit() {
    const h = panel([prog({ payoutType: 'per_unit', payout: 0.75, reward: null, target: 0,
      people: [ { name: 'Marcus Chen', units: 9, target: 0, hit: true,  earned: 6.75 },
                { name: 'Lina Park',   units: 1, target: 0, hit: true,  earned: 0.75 },
                { name: 'Avery Liu',   units: 0, target: 0, hit: false, earned: 0 } ] })]);
    _ok_('the rate, with its cents', h.indexOf('<b>$0.75</b>') > -1);
    _ok_('said as a rate', h.indexOf('for every unit you sell') > -1);
    _ok_('and never as a threshold', h.indexOf('when you hit your goal') === -1);
    _ok_('no target figure at all', h.indexOf('units to hit your bonus') === -1);
    /* "Any" rather than a 0, which would read as "you are not in this one" — the handoff's call,
       and the same distinction the payout wording draws. */
    _ok_('the goal figure says every unit pays', h.indexOf('<b>Any</b><span>unit pays — no personal goal') > -1);
    _ok_('counts read as units, not a fraction of nothing', h.indexOf('<span class="ksp-count">9</span>') > -1);
    _ok_('nobody is shown as x/0', h.indexOf('/0') === -1);
    /* A per_unit board still gets bars — scaled against the LEADER, not a goal. That makes the bar
       a comparison rather than a promise, which is the only honest thing it can be when there is
       no threshold to be a fraction of. */
    _ok_('the leader fills the bar', h.indexOf('<span style="width:100%"></span>') > -1);
    _ok_('one of nine is a ninth', h.indexOf('<span style="width:11%"></span>') > -1);
    _ok_('and a zero seller draws nothing', h.indexOf('<span style="width:0%"></span>') > -1);
    _ok_('the board is titled for volume', h.indexOf('Sold so far') > -1);
    _ok_('and counts units rather than hits', h.indexOf('>10 units sold<') > -1);
    _ok_('a zero seller still gets a row', h.indexOf('Avery Liu') > -1);
    _ok_('and nobody\'s earnings are on it', h.indexOf('6.75') === -1);
  },

  /* NOTHING HONEST TO DRAW MEANS NO BAR — but the column still has to exist, or the names and the
     counts close up against each other and the rows stop lining up with the ones above. */
  noDenominatorHoldsTheColumnOpenInsteadOfFaking() {
    const h = panel([prog({ payoutType: 'per_unit', payout: 0.5, reward: null, target: 0,
      people: [ { name: 'A', units: 0, target: 0, hit: false, earned: 0 },
                { name: 'B', units: 0, target: 0, hit: false, earned: 0 } ] })]);
    _ok_('no bar anywhere — there is no leader to scale against', h.indexOf('ksp-bar') === -1);
    _ok_('the column is held open for both rows', (h.match(/ksp-nobar/g) || []).length === 2);
    _ok_('and the board says nothing has sold', h.indexOf('>0 units sold<') > -1);
  },

  /* A per_unit program must not borrow the flat wording even when the type arrives with a target
     still stamped on the rows — SPIFF fills row.target from the per-bt map whatever the model. */
  perUnitIgnoresATargetLeftOnTheRows() {
    const h = panel([prog({ payoutType: 'per_unit', payout: 0.5, reward: null, target: 6,
      people: [ { name: 'A', units: 3, target: 6, hit: true, earned: 1.5 } ] })]);
    _ok_('still no threshold tile', h.indexOf('units to hit your bonus') === -1);
    _ok_('still a rate', h.indexOf('<b>$0.50</b><span>for every unit you sell') > -1);
    _ok_('still counted in units, with no borrowed goal suffix',
         h.indexOf('<span class="ksp-count">3</span>') > -1);
  },

  /* An older payload states no type at all. That is every program SPIFF published before the
     sidecar, and all of them were flat — so absent must read as flat, not as a missing tile. */
  noPayoutTypeReadsAsFlat() {
    const h = panel([prog()]);
    _ok_('the threshold wording', h.indexOf('when you hit your goal') > -1);
    _ok_('and the target figure', h.indexOf('<b>5</b><span>units to hit your bonus') > -1);
  },

  /* THE STORE TRACK TAKES THE STORE'S REGISTRY COLOR, and it gets there through a CSS var that
     GC.loadStoreColors() has already overlaid with live GX Core values — so a Command Center edit
     reaches the wall without a deploy, and a seventh store inherits its own color rather than
     nothing. The slug arrives off the URL hash and is going inside a style attribute, so it is
     whitelisted to the shape a slug can have rather than escaped: --store-<anything> is a var name,
     and an escaper that is right for text is not the right tool for one. */
  theStoreTrackUsesTheLiveRegistryColor() {
    const p = prog({ storeGoal: 40 });
    _ok_('the store\'s own var', panel([p], { storeSlug: 'century' })
      .indexOf('background:var(--store-century, var(--green))') > -1);
    _ok_('a store we have no color for falls back to green, not to nothing',
      panel([p], { storeSlug: '' }).indexOf('background:var(--green)') > -1);
    const bad = panel([p], { storeSlug: 'x);}</style><script>' });
    _ok_('a slug that is not a slug is refused outright', bad.indexOf('</style>') === -1);
    _ok_('and falls back rather than composing a broken var',
      bad.indexOf('background:var(--green)') > -1);
  },

  /* THE POPUP MUST NOT GO BACK TO A FIXED HEIGHT. This one is a grep, and a grep is weak evidence
     on its own — node has no layout, so there is no way here to assert what actually fits. It is
     narrow on purpose: it catches the exact regression that produced the bug, which is `.kso-win`
     being given a `height` that ignores its content. That fixed 880px was wrong in both directions
     at once — Tawny's tips fell off a six-person board, and a short program left a slab of empty
     card under them. The real check is the measurement in the commit; this stops the CSS silently
     reverting under it. */
  theWindowSizesToItsContent() {
    const found = src.match(/\.kso-win \{[\s\S]*?\n\}/);
    _ok_('found the popup window rule', !!found);
    /* Comments out first, or the guard reads the prose ABOVE the rule as the rule — the paragraph
       there quotes the old `height:min(880px,88vh)` by name to explain why it went, and the first
       version of this test failed on its own documentation. */
    const win = found[0].replace(/\/\*[\s\S]*?\*\//g, '');
    _ok_('height is auto, not a fixed slab', /height:\s*auto/.test(win));
    _ok_('with a ceiling so it cannot outgrow the screen', /max-height:\s*min\(/.test(win));
    // The boundary matters: "max-height: min(...)" contains "height: min(...)" as a substring, so
    // an unanchored form would flag the ceiling we deliberately want.
    _ok_('and no leftover fixed height', !/(^|[^-])height:\s*min\(/m.test(win));
    /* THE POPUP HAS ONE VIEW. This assertion used to read "the iframe fallback still forces a tall
       card" — a min-height propping up a branch I had called unreachable. It was reachable, it put
       SPIFF's page on a kiosk mid-read, and the prop existed because I was keeping a fallback I had
       argued was dead. The guard is inverted now: there must be no frame to prop. */
    _ok_('no iframe in the popup at all', src.indexOf('kioskSpiffFrame') === -1);
    _ok_('and no CSS left styling one', src.indexOf('.kso-frame {') === -1);
  },

  namesAreEscaped() {
    const h = panel([prog({ vendor: '<b>V</b>', people: [ { name: '<img src=x>', units: 1, target: 5, hit: false, earned: 0 } ] })]);
    _ok_('no raw tags from data', h.indexOf('<img') === -1 && h.indexOf('<b>V') === -1);
  },
};

run('spiff_panel', tests);
