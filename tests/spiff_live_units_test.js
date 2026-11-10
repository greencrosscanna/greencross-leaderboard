#!/usr/bin/env node
/* Live SPIFF units between SPIFF's hourly counts (spiff.gs: spiffFetchLive_, spiffLiveUnits_,
 * spiffApplyLive_, and spiffForStore_ end to end).
 *
 * TJ (River Rd, 2026-11-07) asked for SPIFF numbers that move sooner than hourly. Sky's design
 * (2026-11-09): the kiosk already pulls every sale with its line items, and SPIFF publishes the
 * exact product ids each running program counts at each store — so add matching sales on top of
 * SPIFF's last count, and let SPIFF's next count replace ours.
 *
 * What must hold, because each failure is silent on a wall screen:
 *   - we count ONLY what SPIFF's list says, and only sales AFTER SPIFF's cut-off: a sale on both
 *     sides of the cut-off is a unit counted twice in front of the person it was credited to
 *   - returns, returned lines and voids add nothing (the same rule SPIFF pays on)
 *   - a list older than the official count is refused, not half-applied
 *   - no dollar figure moves: hit and earned stay SPIFF's
 *
 * Real functions, read off disk (tests/_harness.js). The fixture is the running Freshy program,
 * Commercial, 2026-11-09, with SPIFF's 12:56 PT count.
 */
'use strict';
const { load, run, setNow, _eq_, _ok_ } = require('./_harness');

// 2026-11-09 14:00 PT (PST, UTC-8).
setNow(Date.UTC(2026, 10, 9, 22, 0, 0));

let LIVE = null, MAIN = null, LIVE_SCOPES = [], GX = null;
const KV = { 'cfg.payPeriodAnchor': '2026-05-11', 'cfg.payPeriodDays': '14' };
const props = { GX_DEPLOY_SECRET: 's3cret', GC_SPIFF_SHOW: 'true' };

const M = load(['dutchie_proxy.gs', 'dutchie_fetch.gs', 'spiff.gs'], {
  stubs: {
    PropertiesService: {
      getScriptProperties: function () {
        return { getProperty: function (k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
                 setProperty: function () {}, deleteProperty: function () {},
                 getProperties: function () { return Object.assign({}, props); } };
      },
      getUserProperties: function () { return { getProperty: function () { return null; } }; },
    },
    GXCore: GX = {
      getKv: function (k) { return Object.prototype.hasOwnProperty.call(KV, k) ? KV[k] : null; },
      publishedSpiffProgress: function (secret, scope) {
        if (scope === '2026-11-09' && MAIN) return MAIN;
        return { ok: false, error: 'nothing published for scope ' + scope };
      },
      publishedSpiffLive: function (secret, scope) {
        LIVE_SCOPES.push(scope);
        return LIVE || { ok: false, error: 'nothing published for scope ' + scope };
      },
      getAppRoster: function () { return { ok: true, people: [] }; },
      appRoster: function () { return { ok: true, people: [] }; },
    },
  },
});

const PID = 'carts-aio-s-202611';
const CUT = '2026-11-09T20:56:00Z';          // 12:56 PT
const FRESHY = ['111', '222', '333'];

function liveEnvelope(over, payloadOver) {
  return Object.assign({
    ok: true, producer: 'spiff', scope: '2026-11-09:live', age_minutes: 4,
    published_at: '2026-11-09T20:58:00.000Z',
    payload: Object.assign({
      pay_period: '2026-11-09',
      programs: [{ program_id: PID, from: '2026-11-09', to: '2026-11-22', rules_hash: 'h1',
                   stores: { commercial: { counted_through: CUT, product_ids: FRESHY },
                             bend:       { counted_through: CUT, product_ids: ['999'] } } }],
      unit_rule: 'retail only; skip isVoid, isReturn txns and isReturned lines; units = quantity (default 1)',
    }, payloadOver || {}),
  }, over || {});
}
const liveList = (over, payloadOver) => {
  const e = liveEnvelope(over, payloadOver);
  return { ok: true, published_at: e.published_at, programs: e.payload.programs };
};

function tx(time, emp, lines, over) {
  return Object.assign({
    transactionType: 'Retail', isVoid: false, isReturn: false,
    transactionDateLocalTime: '2026-11-09T' + time,
    employeeId: emp, completedByUser: 'Someone',
    items: lines.map(function (l) { return Object.assign({ productId: l[0], quantity: l[1] }, l[2] || {}); }),
  }, over || {});
}

const PAM = 42803, SHANE = 45555;

const SIDECAR = [{
  program_id: PID, vendor: 'Freshy', program_name: "Carts & Aio's", status: 'active',
  start_date: '2026-11-09', end_date: '2026-11-22', product: 'All Freshy products',
  payout: 25, payout_type: 'flat',
  store_goals: { commercial: 270 }, bt_goals: { commercial: 45 }, tips: [],
}];
function row(over) {
  return Object.assign({
    program_id: PID, pay_period: '2026-11-09', store_id: 'commercial', employee_id: PAM, name: 'Pam Johnson',
    units: 5, target: 45, hit: false, earned: 0, vendor: 'Freshy', program_name: "Carts & Aio's",
    start_date: '2026-11-09', end_date: '2026-11-22', refreshed_at: '2026-11-09 12:56:18', status: 'active',
  }, over || {});
}

run('spiff_live_units', {

  /* ── what counts ─────────────────────────────────────────────────────────────────── */

  onlySalesAfterTheCutOffAndOnTheList() {
    const r = M.spiffLiveUnits_([
      tx('12:40:00', PAM, [['111', 1]]),               // before the cut: already in SPIFF's 5
      tx('12:56:00', PAM, [['111', 1]]),               // AT the cut: already counted
      tx('13:08:00', SHANE, [['222', 1]]),             // after: ours
      tx('13:19:00', SHANE, [['333', 2], ['777', 1]]), // 2 Freshy + 1 not on the list
      tx('13:39:00', PAM, [['555', 1]]),               // not a Freshy product
    ], liveList(), 'commercial', '2026-11-09T20:57:36.361Z');
    _ok_('applied', r.ok);
    _eq_('Shane: 1 + 2 after the cut', r.byKey[PID + '|' + SHANE], 3);
    _eq_('Pam: nothing after the cut on the list', r.byKey[PID + '|' + PAM], undefined);
    _eq_('total', r.total, 3);
  },

  returnsVoidsAndReturnedLinesAddNothing() {
    const r = M.spiffLiveUnits_([
      tx('13:00:00', SHANE, [['111', 1]], { isVoid: true }),
      tx('13:01:00', SHANE, [['111', 1]], { isReturn: true }),
      tx('13:02:00', SHANE, [['111', 1, { isReturned: true }], ['222', 1]]),
      tx('13:03:00', SHANE, [['111', 1]], { transactionType: 'Transfer' }),
    ], liveList(), 'commercial', '');
    _eq_('only the kept line of the partly returned sale', r.total, 1);
  },

  quantityIsTheUnitCountAndDefaultsToOne() {
    const r = M.spiffLiveUnits_([
      tx('13:00:00', SHANE, [['111', 3]]),
      tx('13:01:00', SHANE, [['222', null]]),
    ], liveList(), 'commercial', '');
    _eq_('3 + 1', r.total, 4);
  },

  eachStoreUsesItsOwnList() {
    // Bend's list holds only product 999: a Freshy id from Commercial's list must not count at Bend.
    const r = M.spiffLiveUnits_([tx('13:00:00', SHANE, [['111', 1], ['999', 1]])], liveList(), 'bend', '');
    _eq_('only Bend\'s own id', r.total, 1);
    const none = M.spiffLiveUnits_([tx('13:00:00', SHANE, [['111', 1]])], liveList(), 'hillsboro', '');
    _eq_('a store not in the program adds nothing', none.total, 0);
  },

  outsideTheProgramWindowAddsNothing() {
    const list = liveList(null, { programs: [{ program_id: PID, from: '2026-11-10', to: '2026-11-22',
      stores: { commercial: { counted_through: '2026-11-08T20:00:00Z', product_ids: FRESHY } } }] });
    const r = M.spiffLiveUnits_([tx('13:00:00', SHANE, [['111', 1]])], list, 'commercial', '');
    _eq_('the program starts tomorrow', r.total, 0);
  },

  noCutOffMeansNothingIsAdded() {
    const list = liveList(null, { programs: [{ program_id: PID, from: '2026-11-09', to: '2026-11-22',
      stores: { commercial: { counted_through: '', product_ids: FRESHY } } }] });
    const r = M.spiffLiveUnits_([tx('13:00:00', SHANE, [['111', 1]])], list, 'commercial', '');
    _eq_('cannot tell new from counted: add nothing', r.total, 0);
  },

  /* ── when the list must be refused ───────────────────────────────────────────────── */

  aListOlderThanTheOfficialCountIsRefused() {
    // SPIFF published a newer official count but this list is from the hour before: its cut-off
    // sits before sales the official number already has, so every one of them would double.
    const r = M.spiffLiveUnits_([tx('13:00:00', SHANE, [['111', 1]])],
      liveList({ published_at: '2026-11-09T19:58:00.000Z' }), 'commercial', '2026-11-09T20:57:36.361Z');
    _ok_('refused', !r.ok);
    _eq_('nothing added', r.total, 0);
    _ok_('and says why', /older than the official/.test(r.reason));
  },

  aStaleOrMissingListIsNotUsed() {
    LIVE = liveEnvelope({ age_minutes: 900 });
    _ok_('15 hours old: refused', !M.spiffFetchLive_().ok);
    LIVE = null;
    const none = M.spiffFetchLive_();
    _ok_('nothing published: refused', !none.ok);
    _eq_('and adds nothing', M.spiffLiveUnits_([tx('13:00:00', SHANE, [['111', 1]])], none, 'commercial', '').total, 0);
    LIVE = liveEnvelope();
    LIVE_SCOPES = [];
    const ok = M.spiffFetchLive_();
    _ok_('a fresh list is used', ok.ok);
    _eq_('its programs come through', ok.programs.length, 1);
    _eq_('asked for under the plain pay-period date', LIVE_SCOPES, ['2026-11-09']);
  },

  theListIsNeverReadAsASpiffScope() {
    // A second scope under producer 'spiff' would be what Crew's pay screen reads when it asks for
    // SPIFF's newest publication without a scope. The live list has its own producer and function.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'spiff.gs'), 'utf8');
    const fn = src.slice(src.indexOf('function spiffFetchLive_('), src.indexOf('function spiffPtLocal_('));
    _ok_('reads publishedSpiffLive', /GXCore\.publishedSpiffLive\(/.test(fn));
    _ok_('never publishedSpiffProgress', !/publishedSpiffProgress/.test(fn));
    _ok_('no ":live" scope string in code', !/['"]:live['"]/.test(src));
  },

  anOlderGXCorePinAddsNothingAndDoesNotThrow() {
    const saved = GX.publishedSpiffLive;
    delete GX.publishedSpiffLive;
    try {
      const r = M.spiffFetchLive_();
      _ok_('refused, not thrown', !r.ok);
      _ok_('and says the pin is too old', /no publishedSpiffLive/.test(r.reason));
    } finally { GX.publishedSpiffLive = saved; }
  },

  /* ── folding into SPIFF's rows ───────────────────────────────────────────────────── */

  addsToTheOfficialRowAndNeverMovesMoney() {
    const k = {}; k[PID + '|' + PAM] = 42;
    const out = M.spiffApplyLive_([row({ units: 5 })], k, SIDECAR, 'commercial');
    _eq_('5 official + 42 live', out[0].units, 47);
    _eq_('the live part is labeled', out[0].live_units, 42);
    _eq_('hit stays SPIFF\'s even past target', out[0].hit, false);
    _eq_('earned stays SPIFF\'s', out[0].earned, 0);
  },

  aFirstSaleSinceTheCountGetsARow() {
    const k = {}; k[PID + '|' + SHANE] = 3;
    const out = M.spiffApplyLive_([row()], k, SIDECAR, 'commercial');
    const shane = out.filter(function (r) { return String(r.employee_id) === String(SHANE); })[0];
    _ok_('Shane is on the board', !!shane);
    _eq_('with his live units', shane.units, 3);
    _eq_('against this store\'s per-budtender goal', shane.target, 45);
    _eq_('keyed by the numeric Dutchie id, like SPIFF\'s rows', shane.employee_id, SHANE);
    _eq_('Pam untouched', out[0].units, 5);
  },

  noRowIsInventedForAProgramThatIsNotActive() {
    const k = {}; k[PID + '|' + SHANE] = 3;
    const closed = [Object.assign({}, SIDECAR[0], { status: 'closed' })];
    _eq_('closed program: no new row', M.spiffApplyLive_([], k, closed, 'commercial').length, 0);
    _eq_('unknown program: no new row', M.spiffApplyLive_([], k, [], 'commercial').length, 0);
  },

  /* ── end to end: what the kiosk receives ─────────────────────────────────────────── */

  theCardAndThePanelBothShowTheLiveCount() {
    MAIN = { ok: true, producer: 'spiff', scope: '2026-11-09', age_minutes: 63,
             published_at: '2026-11-09T20:57:36.361Z',
             payload: { ok: true, pay_period: '2026-11-09', rows: [row()], programs: SIDECAR,
                        refreshed_at: '2026-11-09 12:56:18' } };
    LIVE = liveEnvelope();
    const sales = [tx('13:30:00', PAM, [['111', 2]]), tx('13:40:00', SHANE, [['222', 1]])];
    const s = M.spiffForStore_({ slug: 'commercial', storeId: 'commercial' }, sales);
    _ok_('live applied', s.live && s.live.applied);
    _eq_('Pam\'s card: 5 + 2', s.byId[String(PAM)].units, 7);
    _eq_('Shane gets a card row', s.byId[String(SHANE)] && s.byId[String(SHANE)].units, 1);
    const people = s.programs[0].people;
    const pam = people.filter(function (p) { return p.employee_id === String(PAM); })[0];
    _eq_('the panel agrees with the card', pam.units, 7);

    const off = M.spiffForStore_({ slug: 'commercial', storeId: 'commercial' });
    _eq_('without today\'s sales: SPIFF\'s official number, unchanged', off.byId[String(PAM)].units, 5);
    _ok_('and says why nothing was added', off.live && !off.live.applied);
    MAIN = null; LIVE = null;
  },

  aBrokenListNeverCostsTheOfficialNumbers() {
    MAIN = { ok: true, producer: 'spiff', scope: '2026-11-09', age_minutes: 63,
             published_at: '2026-11-09T20:57:36.361Z',
             payload: { ok: true, pay_period: '2026-11-09', rows: [row()], programs: SIDECAR,
                        refreshed_at: '2026-11-09 12:56:18' } };
    LIVE = liveEnvelope(null, { programs: 'not an array' });
    const s = M.spiffForStore_({ slug: 'commercial', storeId: 'commercial' }, [tx('13:30:00', PAM, [['111', 2]])]);
    _eq_('official count still drawn', s.byId[String(PAM)].units, 5);
    MAIN = null; LIVE = null;
  },
});
