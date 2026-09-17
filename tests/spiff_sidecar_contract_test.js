#!/usr/bin/env node
/* THE SPIFF PROGRAM SIDECAR — SPIFF's real producer against Leaderboard's real consumer.
 *
 * WHY THIS FILE EXISTS, and it is not a style preference.
 *
 * The kiosk popup shows five things a per-employee row cannot say: the product in words, the
 * store's goal, what the program pays and how, Tawny's selling lines, and when it was measured.
 * Leaderboard's first reader looked for them as COLUMNS ON THE ROW. They are not there — they
 * arrive on `payload.programs[]`, one entry per program, joined by `program_id`. That reader
 * would have found nothing forever and failed in the quietest way available: no error, no empty
 * state, just a card with every block missing that looks exactly like a program nobody wrote
 * copy for. SPIFF caught it by reading the live payload back from Core and sent the spellings
 * (note "Exact spellings: the four fields are on payload.programs[]", 2026-09-12).
 *
 * A fixture of our own would not have caught it and would not catch the next one — we would have
 * invented the shape we already believed in, and every assertion would have passed. So this runs
 * SPIFF'S OWN `programsFor_` off SPIFF's shipped source to BUILD the sidecar, hands the result to
 * Leaderboard's shipped `spiffProgramsForStore_`, and renders it with the shipped `GC.spiffPanel`
 * out of index.html. Nothing here restates a key name that either side could quietly rename:
 * rename `store_goals`, change `tips` to a newline-joined cell, drop `payout_type`, and the join
 * stops finding things and these fail — loudly, here, instead of silently on six wall screens.
 *
 * Same bargain as tests/cross_app_contract_test.js, and the same escape hatch: SKIPS CLEANLY when
 * greencross-spiff is not a sibling checkout, because a gate that fails for people who cloned one
 * repo teaches people to bypass the gate.
 *
 * WHAT IT CANNOT CHECK. It proves the two code paths agree about the shape. It does not prove the
 * payload in GX Core today matches either, because Core stores what SPIFF published VERBATIM and
 * never recomputes it — a payload written before a producer change keeps its old shape until the
 * next hourly refresh. `spiff.gs` already treats an absent block as absent rather than an error,
 * which is what makes that survivable.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load, run, _eq_, _ok_ } = require('./_harness');

const SPIFF_SRC = path.join(__dirname, '..', '..', 'greencross-spiff', 'apps-script', 'Code.gs');
if (!fs.existsSync(SPIFF_SRC)) {
  console.log('SKIP spiff sidecar contract — greencross-spiff is not a sibling checkout.');
  process.exit(0);
}

/* ── THE PRODUCER, loaded from SPIFF's shipped source ─────────────────────────────────────────
 * programsFor_ reads its program records through listProgramsCached_, which reads CacheService
 * first. So the records go in through the CACHE rather than by redefining any function: every
 * helper that decides what the sidecar says — productLabelOf_, payoutRateOf_, payoutModelOf_,
 * normalizePitch_, textDate_ — runs exactly as it does in production.
 */
function loadProducer(programRecords) {
  const nope = (n) => () => { throw new Error('Apps Script stub: ' + n + ' is not available under node'); };
  const cached = { value: JSON.stringify(programRecords) };
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    Math, JSON, Date, String, Number, Object, Array, RegExp, Error,
    isFinite, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    Logger: { log() {} },
    Utilities: { formatDate: () => '', getUuid: () => 'x', sleep() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, getProperties: () => ({}) }) },
    CacheService: {
      getScriptCache: () => ({
        // Any key: the only cached read this test reaches is the programs list.
        get: () => cached.value, put() {}, remove() {},
      }),
    },
    SpreadsheetApp: { openById: nope('SpreadsheetApp.openById'), getActive: nope('SpreadsheetApp.getActive') },
    UrlFetchApp: { fetch: nope('UrlFetchApp.fetch') },
    ScriptApp: { getService: () => ({ getUrl: () => '' }), getProjectTriggers: () => [] },
    Session: { getActiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'America/Los_Angeles' },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    HtmlService: {}, DriveApp: {}, MailApp: {},
    ContentService: { createTextOutput: nope('ContentService.createTextOutput'), MimeType: {} },
    GXCore: new Proxy({}, { get: (_, k) => nope('GXCore.' + String(k)) }),
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SPIFF_SRC, 'utf8'), ctx);
  if (typeof ctx.programsFor_ !== 'function') {
    throw new Error('greencross-spiff no longer exports programsFor_ — the sidecar producer moved '
                  + 'or was renamed. Find where payload.programs[] is built before changing this.');
  }
  return ctx;
}

/* ── THE CONSUMERS, loaded from Leaderboard's shipped source ───────────────────────────────── */
const M = load(['spiff.gs'], { stubs: { GC_SPIFF_SHOW_KEY: 'GC_SPIFF_SHOW' } });

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function grabGC(name) {
  const m = html.match(new RegExp('\\nGC\\.' + name + ' = function\\([^)]*\\) \\{[\\s\\S]*?\\n\\};\\n'));
  if (!m) throw new Error('could not extract GC.' + name + ' from index.html');
  return m[0];
}
const view = { Math, String, Number, Object, Date, GC: {} };
vm.createContext(view);
['esc', 'spiffPanel'].forEach((n) => vm.runInContext(grabGC(n), view));
const panel = (programs) => view.GC.spiffPanel(programs, { ok: true, today: '2026-09-11', storeName: 'Center' });

/* ── THE PROGRAM RECORDS ───────────────────────────────────────────────────────────────────────
 * SPIFF's own sheet shape (the schema at the top of its Code.gs). The figures are the live ones
 * SPIFF quoted from Core in the 2026-09-12 note — Mule Extracts, flat $25, six store goals, a
 * per-budtender goal of 3 at Center, four tips — so a value drifting apart from the live payload
 * is visible here rather than only on a wall screen.
 */
const MULE = {
  program_id: 'mule-dank-tank-202608',
  vendor: 'Mule Extracts',
  program_name: 'Live Resin Dank Tank',
  title: 'Live Resin Dank Tank',
  status: 'active',
  start_date: '2026-08-31', end_date: '2026-09-13',
  match_json: { brand: 'Mule Extracts', products: ['Live Resin Dank Tank | 2g'] },
  payout_type: 'flat',
  payout_json: { amount: 25 },
  target_json: {
    by_store: { bend: 42, center: 18, commercial: 36, hillsboro: 24, 'portland-rd': 18, 'river-rd': 30 },
    per_bt:   { bend: 7,  center: 3,  commercial: 6,  hillsboro: 4,  'portland-rd': 3,  'river-rd': 5 },
  },
  pitch_json: { tips: [
    'Lead with the live resin — it is the reason the jar costs what it does',
    'Two grams is the value play: same price as most one-gram carts',
    'Pair it with a pre-roll for anyone who asks what to smoke it in',
    'If they have tried Dank Tank before, ask which strain and match it',
  ] },
};

/* A brand-wide program with no named products — the case the note calls out, where the label has
   to read "All Mule Extracts products" because a product FILTER is not readable on a wall. */
const BRANDWIDE = Object.assign({}, MULE, {
  program_id: 'mule-brandwide-202608',
  match_json: { brand: 'Mule Extracts', products: [] },
  pitch_json: {},
});

/* PER-UNIT. Pays on volume with no threshold to clear, so the popup must say a rate and drop the
   target entirely. SPIFF still stamps a per-bt number on the row, which is exactly the trap: the
   figure exists, it is just not a bonus threshold. */
const PERUNIT = {
  program_id: 'ph-volume-202608',
  vendor: 'Portland Heights',
  program_name: 'Volume Play',
  status: 'active',
  start_date: '2026-08-31', end_date: '2026-09-13',
  match_json: { brand: 'Portland Heights' },
  payout_type: 'per_unit',
  payout_json: { per_unit: 0.75 },
  target_json: { by_store: { center: 60 }, per_bt: { center: 10 } },
  pitch_json: { tips: [] },
};

/* Rows in the published shape. Only program_id, store_id and the per-person numbers matter to the
   join; everything else is here because a real row carries it. */
function row(over) {
  return Object.assign({
    program_id: MULE.program_id, vendor: 'Mule Extracts', program_name: 'Live Resin Dank Tank',
    store_id: 'center', employee_id: 44905, name: 'Nathan Wydick', display_name: 'Nathan',
    units: 4, target: 3, hit: true, earned: 25, start_date: '2026-08-31', end_date: '2026-09-13',
    status: 'active', pay_period: '2026-08-31 - 2026-09-13', refreshed_at: '2026-09-11 22:56:08',
  }, over || {});
}

/** Build the sidecar the way SPIFF builds it, then join it the way Leaderboard joins it. */
function pipeline(records, rows, storeId) {
  const spiff = loadProducer(records);
  const programs = spiff.programsFor_(rows);
  return { programs: programs, joined: M.spiffProgramsForStore_(rows, programs, storeId || 'center') };
}

const tests = {

  /* THE SIDECAR IS A SIDECAR. If these keys ever move back onto the row, or the array of entries
     becomes something else, the join has nothing to key on and the popup goes blank in silence. */
  theProducerStillPublishesAPerProgramSidecar() {
    const { programs } = pipeline([MULE], [row()]);
    _eq_('one entry per program, not per row', programs.length, 1);
    const p = programs[0];
    _ok_('joined on program_id', String(p.program_id) === MULE.program_id);
    ['product', 'payout', 'payout_type', 'store_goals', 'bt_goals', 'tips'].forEach(function (k) {
      _ok_('sidecar still carries ' + k, Object.prototype.hasOwnProperty.call(p, k));
    });
    _ok_('the goals are MAPS keyed on store_id, not numbers',
         p.store_goals && typeof p.store_goals === 'object' && !Array.isArray(p.store_goals));
    _ok_('tips is a real array — no newline or pipe splitting anywhere', Array.isArray(p.tips));
    _ok_('and none of it is on the row', ['product', 'payout', 'store_goal', 'tips', 'measured_at']
      .every(function (k) { return row()[k] === undefined; }));
  },

  /* THE FIVE FIELDS, end to end: SPIFF's record in, the kiosk's rendered card out. */
  everyBlockTheProducerPublishesReachesTheCard() {
    const { joined } = pipeline([MULE], [row()]);
    const p = joined[0];
    _eq_('product, in words', p.product, 'Live Resin Dank Tank | 2g');
    _eq_('THIS store\'s goal, from the map', p.storeGoal, 18);
    _eq_('the stated payout', p.payout, 25);
    _eq_('and how it is earned', p.payoutType, 'flat');
    _eq_('all four tips', p.tips.length, 4);
    _eq_('measured when SPIFF measured it', p.measuredAt, '2026-09-11 22:56:08');

    const h = panel(joined);
    _ok_('the product is on the card', h.indexOf('Live Resin Dank Tank | 2g') > -1);
    _ok_('the store target too, now as the board\'s own track', h.indexOf('of 18 units</span>') > -1);
    _ok_('the payout, as a threshold', h.indexOf('<b>$25</b><span>when you hit your goal') > -1);
    _ok_('the personal target', h.indexOf('<b>3</b><span>units to hit your bonus') > -1);
    _ok_('the tips as a list', h.indexOf('<ul class="ksp-tips">') > -1);
    /* The "as of" stamp is deliberately GONE from this screen (SPIFF's kiosk-board handoff,
       2026-09-16): the popup's own bar carries the chrome, and a timestamp under a board nobody is
       standing at answers a question nobody asked. measuredAt still reaches the consumer intact —
       asserted above — it simply is not drawn. */
    _ok_('and no measurement stamp on the board', h.indexOf('as of') === -1);
    _ok_('nothing rendered blank', h.indexOf('undefined') === -1 && h.indexOf('NaN') === -1);
  },

  /* THE GOALS FOLLOW THE STORE. One program runs at six stores with six different numbers, and
     the wrong key here puts a target on a kiosk that nobody at that store was given. */
  eachStoreGetsItsOwnNumbers() {
    const want = { bend: 42, center: 18, commercial: 36, hillsboro: 24, 'portland-rd': 18, 'river-rd': 30 };
    const perBt = { bend: 7, center: 3, commercial: 6, hillsboro: 4, 'portland-rd': 3, 'river-rd': 5 };
    Object.keys(want).forEach(function (store) {
      const { joined } = pipeline([MULE], [row({ store_id: store, target: perBt[store] })], store);
      _eq_(store + ' store goal', joined[0].storeGoal, want[store]);
      _eq_(store + ' personal goal matches the row', joined[0].target, perBt[store]);
    });
    // And a store the program does not run at gets no number rather than somebody else's.
    const { joined } = pipeline([MULE], [row({ store_id: 'nowhere' })], 'nowhere');
    _eq_('no goal borrowed', joined[0].storeGoal, 0);
  },

  /* SPIFF SAYS bt_goals IS THE NUMBER THE BAR IS DRAWN AGAINST, and that it is also row.target.
     Those are two sources for one figure, so assert they agree — if they ever stop, the popup and
     SPIFF's own page would show different targets for the same person on the same day. */
  thePerBudtenderGoalAgreesWithTheRow() {
    const { programs, joined } = pipeline([MULE], [row()]);
    _eq_('the sidecar\'s per-bt goal for this store', programs[0].bt_goals.center, 3);
    _eq_('is the target the rows carry', joined[0].people[0].target, programs[0].bt_goals.center);
    _ok_('and it is NOT the store goal', programs[0].bt_goals.center !== programs[0].store_goals.center);
  },

  /* PER-UNIT PAYS ON VOLUME. Getting this wrong puts a wrong dollar figure on a wall screen all
     day: $0.75 announced as the bonus for hitting a target that pays nothing extra. */
  perUnitIsARateAndHasNoThreshold() {
    const rows = [
      row({ program_id: PERUNIT.program_id, vendor: 'Portland Heights', program_name: 'Volume Play',
            units: 9, target: 10, hit: true, earned: 6.75 }),
    ];
    const { programs, joined } = pipeline([PERUNIT], rows);
    _eq_('the producer says per_unit', programs[0].payout_type, 'per_unit');
    _eq_('and the rate, not a bounty', programs[0].payout, 0.75);
    _eq_('which reaches the consumer intact', joined[0].payoutType, 'per_unit');
    _eq_('the rate too', joined[0].payout, 0.75);
    _eq_('nothing inferred as a bounty', joined[0].reward, null);

    const h = panel(joined);
    _ok_('rendered as a rate', h.indexOf('<b>$0.75</b><span>for every unit you sell') > -1);
    _ok_('never as a threshold', h.indexOf('when you hit it') === -1);
    _ok_('and no target tile, though the row still carries a number',
         h.indexOf('units to hit your bonus') === -1);
    _ok_('counted in units, with no goal suffix to be a fraction of',
         h.indexOf('<span class="ksp-count">9</span>') > -1);
    /* NO EARNINGS ON A SHARED SCREEN. The old panel printed "· +$6.75" beside anyone who had hit.
       A customer can read a kiosk over the counter, which is why SPIFF's own storeView returns no
       earnings at all — the figure is in our payload and must not reach this card. */
    _ok_('and what this person was paid is nowhere on it', h.indexOf('6.75') === -1);
  },

  /* A BRAND-WIDE PROGRAM HAS NO NAMED PRODUCT, and "All Mule Extracts products" is the label
     SPIFF builds for it. A filter expression on a wall screen is not something anyone can sell. */
  brandWideReadsAsWords() {
    const { joined } = pipeline([BRANDWIDE], [row({ program_id: BRANDWIDE.program_id })]);
    _eq_('the brand-wide label', joined[0].product, 'All Mule Extracts products');
    _eq_('no tips written is an empty array', joined[0].tips.length, 0);
    _ok_('and no heading over nothing', panel(joined).indexOf('How to sell it') === -1);
  },

  /* A PROGRAM WITH NO SIDECAR ENTRY MUST NOT BORROW ANOTHER ONE'S. programsFor_ only emits the
     programs the rows reference, so this is the reverse case: rows for a program the producer no
     longer knows about (an orphan). Absent must stay absent. */
  anOrphanProgramGetsNothingRatherThanSomebodyElsesCopy() {
    const rows = [row(), row({ program_id: 'vanished', employee_id: 1, name: 'B', earned: 0, hit: false, units: 1 })];
    const { programs, joined } = pipeline([MULE], rows);
    _eq_('the producer emits only what it knows', programs.length, 1);
    const orphan = joined.filter(function (p) { return p.id === 'vanished'; })[0];
    _eq_('no product borrowed', orphan.product, '');
    _eq_('no goal borrowed', orphan.storeGoal, 0);
    _eq_('no payout borrowed', orphan.payout, null);
    _eq_('no tips borrowed', orphan.tips.length, 0);
  },
};

run('spiff_sidecar_contract', tests);
