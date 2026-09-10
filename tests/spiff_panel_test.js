#!/usr/bin/env node
/* The kiosk's SPIFF button and panel — GC.spiffButtonInner, GC.spiffPanel and renderHeader in
 * index.html (Sky's calls, 2026-09-10: the panel is built into Leaderboard, and Settings → Include
 * SPIFF is the ONE switch for the button and the card rows).
 *
 * What these lock down, each a way the most visible screen in the company could say something
 * untrue:
 *   • THE SWITCH DECIDES THE BUTTON. Off hides it; on shows it — even with nothing running, since
 *     the setting is what decides, not the day's programs. The old button followed SPIFF's store
 *     link instead, which no store had, so the setting and the button could never agree.
 *   • NO GUESSED BOUNTY. A program nobody has hit yet says "Sell N units" — never a dollar amount
 *     SPIFF did not publish.
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

  summaryCountsPeopleOnceAndSumsEarnings() {
    const h = panel([
      prog(),
      prog({ id: 'q', reward: 25, earned: 25, people: [ { name: 'Marcus Chen', units: 9, target: 9, hit: true, earned: 25 } ] }),
    ]);
    _ok_('two programs', /<b>2<\/b><span>programs running/.test(h));
    _ok_('Marcus hit two — counted once', /<b>1<\/b><span>person has hit a target/.test(h));
    _ok_('earnings summed', /<b>\$40<\/b><span>earned at Baseline so far/.test(h));
  },

  noEarningsNoGoldStat() {
    const h = panel([prog({ reward: null, earned: 0, people: [ { name: 'A', units: 1, target: 5, hit: false, earned: 0 } ] })]);
    _ok_('no "$0 earned"', h.indexOf('earned at') === -1);
  },

  rewardOnlyWhenPublished() {
    _ok_('known reward → "Pays $15 at 5 units"', panel([prog()]).indexOf('Pays $15 at 5 units') > -1);
    const h = panel([prog({ reward: null, earned: 0, people: [ { name: 'A', units: 1, target: 5, hit: false, earned: 0 } ] })]);
    _ok_('unknown reward → "Sell 5 units"', h.indexOf('Sell 5 units') > -1);
    _ok_('and no dollar amount anywhere', h.indexOf('$') === -1);
  },

  daysLeftIsCalendarArithmetic() {
    const t = (end) => panel([prog({ end })]);
    _ok_('today',    t('2026-09-09').indexOf('Ends today') > -1);
    _ok_('tomorrow', t('2026-09-10').indexOf('Ends tomorrow') > -1);
    _ok_('four',     t('2026-09-13').indexOf('4 days left') > -1);
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
