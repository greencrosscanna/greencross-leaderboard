// ============================================================
//  Publishing the goal ledger AHEAD of the open period
//  Run:  node tests/goal_lookahead_test.js
//
//  WHY THIS SUITE EXISTS
//  ---------------------
//  Until 2026-08-30 the ledger ended at the currently-open pay
//  period: 21 unbroken 14-day periods, nothing after 2026-08-30.
//  Sales now reads frozen period goals as authoritative for
//  week/month/YTD and its pgTotal() returns NULL — not a partial
//  sum — if any date in the window has no period. A calendar
//  month spans 2-4 of our periods, so the month view could only
//  resolve on the minority of days when the open period happened
//  to reach the month end; every other day fell back to a frozen
//  snapshot of a RETIRED budget workbook.
//
//  refreshGoalLedger_ now also publishes future periods. The
//  dangerous half of that is not the publishing, it is the
//  LOCKING: GX Core refuses to overwrite a locked row and there
//  is no unlock route, so a lock landing on a period that has not
//  happened would freeze a projected number onto it permanently,
//  and Sales would read that as the authoritative target for a
//  month nobody had worked yet.
//
//  So the assertions below are mostly about what must NOT happen:
//  a future period is never written locked, writeGoalLedger_
//  refuses to lock anything that has not closed, a backfill URL
//  cannot reach forward, and a projection is rewritable on every
//  run right up to the day the period opens.
//
//  Per tests/_harness.js's rule, nothing here reimplements the
//  functions under test — the shipped goals.gs is loaded as text.
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

// ── Sandbox: in-memory Script Properties + a recording GX Core ─────────────────
// The ledger is read-modify-write across BOTH stores (local property first, then
// the shared tab), so a stub that forgets what it was told cannot exercise the
// re-publish path this whole change depends on.
function mod(nowIso) {
  H.setNow(Date.parse(nowIso));

  const store = Object.create(null);
  const props = {
    getProperty: k => (k in store ? store[k] : null),
    setProperty(k, v) { store[k] = String(v); return this; },
    deleteProperty(k) { delete store[k]; return this; },
    getProperties: () => Object.assign({}, store),
    setProperties(o) { Object.assign(store, o); return this; },
  };

  // GX Core period_goals, keyed store|period_start, with the real "locked is
  // immutable" behaviour from gx_core.gs gxUpsertPeriodGoals.
  const central = Object.create(null);
  const skippedLocked = [];

  const GXCore = {
    // Six months of flat daily net per store, so the computed shape is non-zero
    // and a projection copying it is distinguishable from an empty one.
    getSalesDaily(_store, from, to) {
      const out = [];
      const DAY = 86400000;
      for (let t = Date.parse(from + 'T12:00:00Z'); t <= Date.parse(to + 'T12:00:00Z'); t += DAY) {
        const d = new Date(t).toISOString().slice(0, 10);
        for (const s of ['baseline', 'center', 'century', 'commercial', 'portland', 'river']) {
          out.push({ store: s, date: d, net: 1000 });
        }
      }
      return out;
    },
    gxUpsertPeriodGoals(rows) {
      (rows || []).forEach(r => {
        const key = r.store + '|' + String(r.period_start).slice(0, 10);
        if (central[key] && central[key].locked) { skippedLocked.push(key); return; }
        central[key] = Object.assign({}, r, { locked: !!r.locked });
      });
      return { ok: true, upserted: rows.length, skippedLocked: skippedLocked.slice() };
    },
    getPeriodGoals(s, d) {
      const date = String(d || '').slice(0, 10);
      const rows = Object.keys(central).map(k => central[k]).filter(r => {
        if (s && r.store !== s) return false;
        if (!date) return true;
        return r.period_start === date ||
               (r.period_start <= date && (!r.period_end || date <= r.period_end));
      });
      return { ok: true, rows: rows, picked: rows };
    },
    getStores() { return { ok: true, stores: [] }; },
  };

  const S = H.load(['goals.gs', 'dutchie_proxy.gs'], {
    stubs: {
      GXCore,
      PropertiesService: {
        getScriptProperties: () => props,
        getUserProperties: () => props,
        getDocumentProperties: () => props,
      },
    },
  });
  S._props = props;
  S._store = store;
  S._central = central;
  S._ledger = ps => { const raw = store['GC_GOAL_LEDGER_' + ps]; return raw ? JSON.parse(raw) : null; };
  return S;
}

// ── periodsAheadFor_ — the count is derived from the month, not fixed ──────────
function test_lookaheadCoversTheCalendarMonth() {
  const S = mod('2026-08-30T18:00:00Z');

  // 2026-08-01: the open period is 07-20..08-02 and August still has the periods
  // starting 08-03, 08-17 and 08-31 to cover. This is the worst case, and it is
  // the one a flat "one period ahead" gets wrong.
  _eq_('2026-08-01 needs three ahead', S.periodsAheadFor_('2026-07-20', '2026-08-01'), 3);
  _eq_('2026-08-02 needs three ahead', S.periodsAheadFor_('2026-07-20', '2026-08-02'), 3);

  // Mid-August: open period 08-17..08-30, only 08-31 left uncovered.
  _eq_('2026-08-30 needs one ahead', S.periodsAheadFor_('2026-08-17', '2026-08-30'), 1);
  // 2026-08-31 opens a period that already runs past the end of August.
  _eq_('2026-08-31 needs the floor',  S.periodsAheadFor_('2026-08-31', '2026-08-31'), 1);

  // Feb 2026 (28 days), open period 2026-02-02..02-15: 02-16 covers to 03-01.
  _eq_('short month needs one', S.periodsAheadFor_('2026-02-02', '2026-02-10'), 1);
}

function test_lookaheadIsClampedBothWays() {
  const S = mod('2026-08-30T18:00:00Z');
  // Floor: even when the open period alone already covers the month, publish one —
  // that is Sky's number, and it is also what keeps a week straddling into the next
  // month covered.
  _ok_('never returns zero', [
    '2026-01-05', '2026-02-16', '2026-03-30', '2026-06-08', '2026-09-14',
  ].every(ps => S.periodsAheadFor_(ps, ps) >= 1));

  // Ceiling: three is the arithmetic worst case for 14-day periods vs a 31-day
  // month, so nothing should ever ask for more.
  const anchor = Date.UTC(2026, 4, 11), DAY = 86400000;
  let max = 0, everUncovered = 0;
  for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2027, 11, 31); t += DAY) {
    const days = Math.round((t - anchor) / DAY);
    const off = days >= 0 ? Math.floor(days / 14) : Math.ceil(days / 14) - 1;
    const curStart = new Date(anchor + off * 14 * DAY).toISOString().slice(0, 10);
    const today = new Date(t).toISOString().slice(0, 10);
    const k = S.periodsAheadFor_(curStart, today);
    if (k > max) max = k;
    // The point of the whole exercise: with k published ahead, is every day of
    // today's month covered?
    const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
    const monthEnd = today.slice(0, 7) + '-' +
      String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');
    const coverEnd = new Date(Date.parse(curStart + 'T12:00:00Z') + (14 * (k + 1) - 1) * DAY)
      .toISOString().slice(0, 10);
    if (coverEnd < monthEnd) everUncovered++;
  }
  _eq_('never exceeds the ceiling of 3', max, 3);
  _eq_('every day of 2026-2027 gets a fully covered month', everUncovered, 0);
}

// ── The forward pass ──────────────────────────────────────────────────────────
function test_refreshPublishesFuturePeriodsUnlocked() {
  const S = mod('2026-08-30T18:00:00Z');            // 11:00 PT, last day of 2026-08-17..08-30
  const r = S.refreshGoalLedger_();

  _eq_('current period', r.current, '2026-08-17');
  _eq_('one period ahead published', r.ahead, ['2026-08-31']);

  const nxt = S._ledger('2026-08-31');
  _ok_('future entry exists', !!nxt);
  _eq_('future period end', nxt.periodEnd, '2026-09-13');
  _eq_('future entry is NOT locked', nxt.locked, false);
  _ok_('future entry is flagged projected', nxt.projected === true);
  _eq_('central row is not locked', S._central['river|2026-08-31'].locked, false);
  _ok_('central row carries real targets', S._central['river|2026-08-31'].period_total > 0);
}

function test_projectionCarriesTheStandingShapeNotZeroes() {
  const S = mod('2026-08-30T18:00:00Z');
  S.refreshGoalLedger_();
  const cur = S._ledger('2026-08-17'), nxt = S._ledger('2026-08-31');
  _eq_('projected stores match the standing shape', nxt.stores, cur.stores);
  _ok_('and are not the same object', nxt.stores !== cur.stores);
}

function test_projectedRowsKeepTheSharedColumnContract() {
  const S = mod('2026-08-30T18:00:00Z');
  S.refreshGoalLedger_();
  const row = S._central['river|2026-08-31'];
  _eq_('period_goals columns unchanged', Object.keys(row).sort(), [
    'computed_at', 'dow_targets', 'locked', 'period_end', 'period_start',
    'period_total', 'source', 'store', 'stretch',
  ]);
  _ok_('the local-only projected flag never reaches GX Core', !('projected' in row));
}

// ── Recomputation: a future period is rewritable until it opens ───────────────
function test_aFuturePeriodIsRepublishedNotWriteOnce() {
  const S = mod('2026-08-30T18:00:00Z');
  S.refreshGoalLedger_();
  const first = S._central['river|2026-08-31'].period_total;

  // A manual override lands before the period opens — the standing goal changed,
  // so the already-published future period must change with it.
  S._props.setProperty('GC_MANUAL_PP_KEY_PLACEHOLDER', '');   // no-op; keeps the shape explicit
  S._props.setProperty(S.GC_MANUAL_PP_KEY, JSON.stringify({ river: first + 50000 }));
  const S2 = mod('2026-08-30T18:00:00Z');                     // fresh execution, same stores
  S2._props.setProperties(S._store);
  S2.refreshGoalLedger_();

  const after = S2._central['river|2026-08-31'];
  _ok_('the future period was rewritten, not skipped', after.period_total !== first);
  _eq_('and is still unlocked', after.locked, false);
}

function test_rollDayReplacesTheProjectionWithTheRealShape() {
  // Night 1: 2026-08-30, the period 08-31..09-13 is published as a projection.
  const S1 = mod('2026-08-30T18:00:00Z');
  S1.refreshGoalLedger_();
  _ok_('projected on the eve', S1._ledger('2026-08-31').projected === true);

  // Night 2: 2026-08-31, that period is now the OPEN one. Same properties, same
  // central tab, new execution.
  const S2 = mod('2026-08-31T10:30:00Z');       // 03:30 PT, when the trigger fires
  S2._props.setProperties(S1._store);
  Object.assign(S2._central, S1._central);
  const r = S2.refreshGoalLedger_();

  _eq_('the projection is now the current period', r.current, '2026-08-31');
  const nowCur = S2._ledger('2026-08-31');
  _ok_('the projected flag is gone — this is the authoritative shape', !nowCur.projected);
  _eq_('and it is still unlocked while open', nowCur.locked, false);
  _eq_('the period that just closed is locked', r.lockedNow.indexOf('2026-08-17') >= 0, true);
  _eq_('the ledger has run on ahead', r.ahead, ['2026-09-14']);
}

// ── Locking: the part most likely to go wrong ─────────────────────────────────
function test_writeGoalLedgerRefusesToLockAFuturePeriod() {
  const S = mod('2026-08-30T18:00:00Z');
  const entry = { periodStart: '2026-08-31', periodEnd: '2026-09-13', stores: {}, computedAt: 'x' };
  let threw = '';
  try { S.writeGoalLedger_(S._props, entry, true); } catch (e) { threw = e.message; }
  _ok_('locking a future period throws', /refusing to LOCK/.test(threw));
  _eq_('and nothing was written', S._ledger('2026-08-31'), null);
}

function test_writeGoalLedgerRefusesToLockTheOpenPeriod() {
  const S = mod('2026-08-30T18:00:00Z');
  const entry = { periodStart: '2026-08-17', periodEnd: '2026-08-30', stores: {}, computedAt: 'x' };
  let threw = '';
  try { S.writeGoalLedger_(S._props, entry, true); } catch (e) { threw = e.message; }
  _ok_('locking the OPEN period throws too', /refusing to LOCK/.test(threw));
}

function test_writeGoalLedgerStillLocksAClosedPeriod() {
  const S = mod('2026-08-30T18:00:00Z');
  const entry = { periodStart: '2026-08-03', periodEnd: '2026-08-16', stores: {}, computedAt: 'x' };
  S.writeGoalLedger_(S._props, entry, true);
  _eq_('a closed period locks as before', S._ledger('2026-08-03').locked, true);
}

function test_backfillCannotReachForward() {
  const S = mod('2026-08-30T18:00:00Z');
  S.refreshGoalLedger_();
  const before = JSON.stringify(S._ledger('2026-08-31'));

  const r = S.backfillPeriodGoal_('2026-08-31');
  _eq_('refused', r.ok, false);
  _ok_('and says why', /has not closed/.test(r.error));
  _eq_('the projection is untouched', JSON.stringify(S._ledger('2026-08-31')), before);

  _eq_('the open period is refused as well', S.backfillPeriodGoal_('2026-08-17').ok, false);
  _eq_('a garbled date is refused', S.backfillPeriodGoal_('next tuesday').ok, false);
}

function test_aClosedButNeverRefreshedProjectionIsNotFrozen() {
  // The trigger fails for the whole fourteen days a period is open, so the only
  // shape held for it is the one projected before it started. Locking that would
  // freeze a guess as the as-of truth.
  const S = mod('2026-08-30T18:00:00Z');
  S.writeGoalLedger_(S._props, {
    periodStart: '2026-08-03', periodEnd: '2026-08-16', stores: {}, computedAt: 'x', projected: true,
  }, false);

  const r = S.refreshGoalLedger_();
  _eq_('left unlocked', r.leftUnlocked, ['2026-08-03']);
  _ok_('not in lockedNow', r.lockedNow.indexOf('2026-08-03') === -1);
  _eq_('still editable', S._ledger('2026-08-03').locked, false);
}

H.run('goal lookahead', {
  test_lookaheadCoversTheCalendarMonth,
  test_lookaheadIsClampedBothWays,
  test_refreshPublishesFuturePeriodsUnlocked,
  test_projectionCarriesTheStandingShapeNotZeroes,
  test_projectedRowsKeepTheSharedColumnContract,
  test_aFuturePeriodIsRepublishedNotWriteOnce,
  test_rollDayReplacesTheProjectionWithTheRealShape,
  test_writeGoalLedgerRefusesToLockAFuturePeriod,
  test_writeGoalLedgerRefusesToLockTheOpenPeriod,
  test_writeGoalLedgerStillLocksAClosedPeriod,
  test_backfillCannotReachForward,
  test_aClosedButNeverRefreshedProjectionIsNotFrozen,
});
