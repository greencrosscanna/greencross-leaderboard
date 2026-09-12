#!/usr/bin/env node
/* The kiosk's SPIFF button and panel — GC.spiffButtonInner, GC.spiffPanel and renderHeader in
 * index.html. Settings → Include SPIFF is the ONE switch for the button and the card rows
 * (Sky, 2026-09-10), and the panel now draws SPIFF's own store-page layout in Leaderboard's
 * progress-bar treatment (Sky, 2026-09-11: "i want the previously submitted screenshot data
 * inside. I do like this treatment of the progress bars").
 *
 * What these lock down, each a way the most visible screen in the company could say something
 * untrue:
 *   • THE SWITCH DECIDES THE BUTTON. Off hides it; on shows it — even with nothing running, since
 *     the setting is what decides, not the day's programs. The old button followed SPIFF's store
 *     link instead, which no store had, so the setting and the button could never agree.
 *   • NO GUESSED BOUNTY. A program with no stated payout and nobody hit yet shows no dollar amount
 *     at all — never one worked out from thin air.
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

  switchOnShowsTheButtonWithACount() {
    const b = btnOf(ctx.renderHeader({ name: 'Baseline' }, { on: true, programs: [prog(), prog({ id: 'q' })] }));
    _ok_('visible', !/\shidden>/.test(b));
    _ok_('says how many are live', b.indexOf('2 live') > -1);
    _ok_('not dimmed', b.indexOf('kiosk-spiff-btn none') === -1);
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

  emptyListSaysSoByStore() {
    _ok_('names the store', panel([]).indexOf('No SPIFF running at Baseline right now.') > -1);
  },

  headIsTheStoreAndTheCount() {
    const h = panel([
      prog(),
      prog({ id: 'q', reward: 25, earned: 25, people: [ { name: 'Marcus Chen', units: 9, target: 9, hit: true, earned: 25 } ] }),
    ]);
    _ok_('store named', /<b>Baseline<\/b>/.test(h));
    _ok_('and the count', /2 programs running/.test(h));
    _ok_('one program reads singular', /1 program running/.test(panel([prog()])));
  },

  /* NO GUESSED BOUNTY, and the rule got sharper when SPIFF started publishing the payout: a stated
     payout is right from the first morning, an inferred one is null until somebody has hit. */
  statedPayoutBeatsTheInferredOne() {
    _ok_('inferred reward shows', panel([prog()]).indexOf('<b>$15</b><span>when you hit it') > -1);
    _ok_('SPIFF\'s stated payout wins over it',
         panel([prog({ payout: 20 })]).indexOf('<b>$20</b><span>when you hit it') > -1);
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
    _ok_('no store target line without one', bare.indexOf('Store target') === -1);
    _ok_('no "HOW TO SELL IT" over nothing', bare.indexOf('HOW TO SELL IT') === -1);
    _ok_('and no "as of" stamped from our own clock', bare.indexOf('as of') === -1);

    const full = panel([prog({ product: 'Live Resin Dank Tank | 2g', storeGoal: 42,
                               measuredAt: '2026-09-09 21:56:08',
                               tips: ['Lead with the live resin', 'Pair it with a pre-roll'] })]);
    _ok_('product', full.indexOf('Live Resin Dank Tank | 2g') > -1);
    _ok_('store target', full.indexOf('Store target: <b>42</b> units') > -1);
    _ok_('tips as a list', /<ul class="ksp-tips"><li>Lead with the live resin<\/li><li>Pair it with a pre-roll<\/li><\/ul>/.test(full));
    _ok_('SPIFF\'s measurement time, converted to 12-hour', full.indexOf('as of 9:56pm') > -1);
    _ok_('a blank tip is dropped, not rendered as an empty bullet',
         panel([prog({ tips: ['Real one', '  ', ''] })]).indexOf('<li></li>') === -1);
  },

  /* TODAY COUNTS as a selling day (Sky, 2026-09-11: "use spiff's day count, today counts"). SPIFF's
     page counts inclusively and ours did not, so the same program read "3 days left" there and
     "2 days left" on the kiosk. The last two days keep the clearer wording. */
  daysLeftIsCalendarArithmetic() {
    const t = (end) => panel([prog({ end })]);   // TODAY is 2026-09-09
    _ok_('today',    t('2026-09-09').indexOf('Ends today') > -1);
    _ok_('tomorrow', t('2026-09-10').indexOf('Ends tomorrow') > -1);
    _ok_('two days out reads THREE — today is one of them', t('2026-09-11').indexOf('3 days left') > -1);
    _ok_('four days out reads five', t('2026-09-13').indexOf('5 days left') > -1);
    _ok_('and never the exclusive count again', t('2026-09-13').indexOf('4 days left') === -1);
    _ok_('across a month end', panel([prog({ end: '2026-10-01' })], { today: '2026-09-30' }).indexOf('Ends tomorrow') > -1);
    _ok_('ending soon is flagged', t('2026-09-10').indexOf('ksp-prog ending') > -1);
    _ok_('a later one is not',      t('2026-09-13').indexOf('ksp-prog ending') === -1);
    _ok_('date range printed',      t('2026-09-13').indexOf('Sep 1 – Sep 13') > -1);
  },

  peopleRowsCarryTheCardsBarLanguage() {
    const h = panel([prog({ people: [
      { name: 'Lina Park', units: 110, target: 55, hit: true, earned: 25 },
      { name: 'Avery Liu', units: 0,   target: 6,  hit: false, earned: 0 },
    ] })]);
    _ok_('over target → hash slides to 50%', h.indexOf('emp-spiff-mark" style="left:50%') > -1);
    _ok_('over target glows', h.indexOf('bar-over') > -1);
    _ok_('hit row is gold', h.indexOf('ksp-row hit') > -1 && h.indexOf('emp-spiff hit') > -1);
    _ok_('payout beside a hit', h.indexOf('110/55 · +$25') > -1);
    _ok_('zero draws an EMPTY track, not a floor', /0\/6<\/span>/.test(h) && !/has-progress[^]*0\/6/.test(h.slice(h.indexOf('Avery'))));
  },

  namesAreEscaped() {
    const h = panel([prog({ vendor: '<b>V</b>', people: [ { name: '<img src=x>', units: 1, target: 5, hit: false, earned: 0 } ] })]);
    _ok_('no raw tags from data', h.indexOf('<img') === -1 && h.indexOf('<b>V') === -1);
  },
};

run('spiff_panel', tests);
