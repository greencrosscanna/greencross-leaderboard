#!/usr/bin/env node
// ============================================================
//  Avatar write — the kiosk picker's save/clear path.
//
//  Run:  node tests/avatar_write_test.js
//
//  WHY THIS EXISTS
//  avatar_config lives on the GX Core `employees` row, and it used to be written from TWO apps —
//  Crew and this one — each wrapping gxUpsertEmployee in its own read-merge-write. They did not
//  agree: Crew's pinned the avatar seed, retried lock contention and verified that a clear actually
//  landed; this app's did none of those. As of Core v225 the write is ONE primitive,
//  GXCore.setAvatar, and gxWriteAvatarToCore_ is a thin caller around it.
//
//  So this suite asserts the two halves separately:
//
//  PART A — OUR SIDE, always runs. What we hand the primitive and what we do with what comes back:
//  the employee is resolved on the Dutchie-id join before the call, the config goes through
//  untouched, a clear is an EMPTY STRING (setAvatar owns the clear= mechanics), 'performance' is the
//  actor, the caches are busted only on success, and every failure keeps the { ok:false, error }
//  shape index.html renders into the picker's status line.
//
//  PART B — END TO END, skipped when the hub is not a sibling checkout. The REAL setAvatar, loaded
//  out of greencross-command-center/gx_core.gs, over an in-memory `employees` sheet. This is the one
//  that matters: it proves a save STILL WORKS after the migration, and that it does not blank the
//  rest of the employee record. That blanking is not hypothetical — on 2026-08-20 a partial avatar
//  write under an old library pin reduced a live employee to an id and a status, losing their name,
//  home store, role, Dutchie id and employee number. gxWriteAvatarToCore_ used to defend against it
//  by building a COMPLETE row; that defence now lives inside the library, so the assertion has to
//  follow it here or the migration silently drops the only check that ever caught it.
//
//  Part A cannot catch a blanking (its setAvatar is a spy) and Part B cannot run everywhere. Neither
//  half is sufficient; that is why there are two.
// ============================================================

const fs = require('fs');
const path = require('path');
const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

// ── The employees sheet, as a grid ───────────────────────────
// One representation for both halves: Part A reads it, and in Part B the real gx_core.gs reads AND
// writes it through a SpreadsheetApp stub. Sky is employee "00" — the leading zero is a string here
// and must stay one, per the suite convention.
const HEADERS = ['employee_id', 'employee_number', 'full_name', 'preferred_name', 'home_store',
                 'dutchie_employee_id', 'role_title', 'status', 'hire_date', 'user_id',
                 'avatar_config', 'updated_at'];

const SEED_ROWS = [
  ['casey_nguyen', '17', 'Casey Nguyen', 'Casey', 'portland-rd', '101', 'Budtender', 'active', '2023-04-01', 'casey', '', '2026-08-01'],
  ['jamie_cruz',   '',   'Jamie Cruz',   '',      'river-rd',    '505', 'Budtender', 'active', '2025-06-10', '',      '{"top":"hat","seed":"jamie_cruz"}', '2026-08-01'],
  ['sky',          '00', 'Skyler Pinnick', 'Sky', 'river-rd',    '999', 'Owner',     'active', '2019-01-02', 'sky',   '', '2026-08-01'],
];

let GRID, AUDIT;
function resetGrid() {
  GRID = [HEADERS.slice()].concat(SEED_ROWS.map(function (r) { return r.slice(); }));
  AUDIT = [];
}
resetGrid();

function rowOf(id) { return GRID.slice(1).find(function (r) { return r[0] === id; }); }
function cellOf(id, col) { const r = rowOf(id); return r ? r[HEADERS.indexOf(col)] : undefined; }
/** The whole row as an object, minus the columns an avatar save is allowed to move. */
function stableRowOf(id) {
  const r = rowOf(id) || [];
  const o = {};
  HEADERS.forEach(function (h, i) {
    if (h === 'avatar_config' || h === 'updated_at') return;
    o[h] = r[i];
  });
  return o;
}
/** GX Core's getEmployees() shape, derived from the same grid. */
function employeesFromGrid() {
  return GRID.slice(1).map(function (r) {
    const o = {};
    HEADERS.forEach(function (h, i) { o[h] = r[i] === undefined ? '' : r[i]; });
    return o;
  });
}

// ── This app's own 30-day Dutchie sales roster ───────────────
// gxWriteAvatarToCore_ resolves through gxRoster_().byKey, which is built by joining THIS on the
// Dutchie employee id. Sky is deliberately absent: corporate staff never ring a transaction, so they
// are reachable through byCoreKey for READS and not writable from the picker — pre-existing, and
// asserted below so a change to it is a decision rather than an accident.
const APP_ROSTER = {
  portland: [{ id: '101', name: 'Casey Nguyen', initials: 'CN' }],
  river:    [{ id: '505', name: 'Jamie Cruz',   initials: 'JC' }],
};
const rosterProps = {
  getProperty: function (k) { return k === 'GC_STORE_EMPLOYEES_JSON' ? JSON.stringify(APP_ROSTER) : null; },
  setProperty: function () { return this; },
  deleteProperty: function () { return this; },
  getProperties: function () { return {}; },
  setProperties: function () { return this; },
};

// ── The GXCore stub, swappable mid-suite ─────────────────────
// One object identity for the whole sandbox; `setAvatar` is reassigned between phases so Part A can
// spy on the call and Part B can put the real primitive behind exactly the same call site.
let CALLS = [];
const GXCoreStub = {
  getEmployees: function () { return employeesFromGrid(); },
  getStores: function () { return []; },
  setAvatar: function () { throw new Error('setAvatar not installed for this phase'); },
};
function spySetAvatar(reply) {
  GXCoreStub.setAvatar = function (ref, config, by) {
    CALLS.push({ ref: ref, config: config, by: by });
    if (typeof reply === 'function') return reply(ref, config, by);
    return reply;
  };
}

const S = H.load(['gx_roster.gs', 'dutchie_proxy.gs', 'endpoints.gs', 'dutchie_fetch.gs', 'goals.gs', 'auth.gs'], {
  stubs: {
    PropertiesService: {
      getScriptProperties: function () { return rosterProps; },
      getUserProperties:   function () { return rosterProps; },
      getDocumentProperties: function () { return rosterProps; },
    },
    GXCore: GXCoreStub,
  },
  extraExports: '"resetRosterMemo": function () { _gxRosterMemo_ = null; _propsCache_ = null; }',
});

function fresh() { CALLS = []; resetGrid(); S.resetRosterMemo(); }

const CFG = { top: 'shortFlat', hatColor: 'green' };
const CFG_STR = JSON.stringify(CFG);

// ============================================================
//  PART A — our side of the call
// ============================================================

function test_saveHandsCoreTheRightThings_() {
  fresh();
  spySetAvatar({ ok: true, employee_id: 'casey_nguyen', name: 'Casey Nguyen', seed: '17', cleared: false });

  const res = S.saveAvatarConfig_({ nameKey: 'casey_nguyen', config: CFG_STR });
  _ok_('save reports ok', res && res.ok === true);
  _eq_('exactly one write per save', CALLS.length, 1);
  // The ref is the employee_id our roster already resolved on the Dutchie id, NOT the nameKey.
  // setAvatar would accept either, but a name match is the join that a rename silently orphans.
  _eq_('ref is the resolved employee_id', CALLS[0].ref, 'casey_nguyen');
  _eq_('config passes through untouched', CALLS[0].config, CFG_STR);
  _eq_('actor is this app key', CALLS[0].by, 'performance');
  // Callers (index.html) only read .ok/.error, but the old contract carried these two.
  _eq_('nameKey echoed back', res.nameKey, 'casey_nguyen');
  _eq_('employee_id echoed back', res.employee_id, 'casey_nguyen');
  _eq_('the pinned seed is surfaced', res.seed, '17');
  _eq_('a save is not a clear', res.cleared, false);
}

function test_clearIsAnEmptyString_() {
  fresh();
  spySetAvatar({ ok: true, employee_id: 'jamie_cruz', name: 'Jamie Cruz', seed: '505', cleared: true });

  const res = S.clearAvatarConfig_({ nameKey: 'jamie_cruz' });
  _ok_('clear reports ok', res && res.ok === true);
  _eq_('one write', CALLS.length, 1);
  // '' is the whole request. setAvatar owns clear='avatar_config' and the read-back that verifies
  // it; re-deriving that here is how the two implementations drifted apart in the first place.
  _eq_('clear sends an empty config', CALLS[0].config, '');
  _eq_('clear still names the employee_id', CALLS[0].ref, 'jamie_cruz');
  _eq_('cleared is reported', res.cleared, true);
}

function test_unresolvedPersonNeverReachesCore_() {
  fresh();
  spySetAvatar({ ok: true });

  const res = S.saveAvatarConfig_({ nameKey: 'nobody_at_all', config: CFG_STR });
  _eq_('unknown nameKey fails', res.ok, false);
  _ok_('and says who to ask', /ask Crew/.test(res.error || ''));
  _eq_('GX Core is never called', CALLS.length, 0);

  // Corporate staff are in GX Core but not in the 30-day sales roster, so the picker cannot write
  // them. Pre-existing and unchanged by the setAvatar migration — asserted so it stays a decision.
  const sky = S.saveAvatarConfig_({ nameKey: 'skyler_pinnick', config: CFG_STR });
  _eq_('someone outside the sales roster is still not writable here', sky.ok, false);
  _eq_('still no call to GX Core', CALLS.length, 0);
}

function test_badInputIsRejectedLocally_() {
  fresh();
  spySetAvatar({ ok: true });

  _eq_('missing nameKey', S.saveAvatarConfig_({ config: CFG_STR }).ok, false);
  _eq_('missing config',  S.saveAvatarConfig_({ nameKey: 'casey_nguyen' }).ok, false);
  const bad = S.saveAvatarConfig_({ nameKey: 'casey_nguyen', config: '{not json' });
  _eq_('malformed config JSON', bad.ok, false);
  _ok_('and says so', /Invalid config JSON/.test(bad.error || ''));
  _eq_('clear needs a nameKey too', S.clearAvatarConfig_({}).ok, false);
  _eq_('none of that reached GX Core', CALLS.length, 0);
}

function test_failuresKeepTheShapeTheUiRenders_() {
  // index.html prints '✗ ' + res.error into the picker's status line and re-enables the button. A
  // failure that arrives as ok:true, or with no .error, shows the staff member a tick and no face.
  fresh();
  spySetAvatar({ ok: false, error: 'Lock timeout', retryable: true, employee_id: 'casey_nguyen' });
  let res = S.saveAvatarConfig_({ nameKey: 'casey_nguyen', config: CFG_STR });
  _eq_('a rejected write is not ok', res.ok, false);
  _eq_('the reason is passed through verbatim', res.error, 'Lock timeout');
  _eq_('retryable is surfaced', res.retryable, true);

  fresh();
  spySetAvatar({ ok: false });
  res = S.saveAvatarConfig_({ nameKey: 'casey_nguyen', config: CFG_STR });
  _eq_('a reasonless rejection still carries an error string', res.error, 'GX Core rejected the write');

  fresh();
  spySetAvatar(function () { throw new Error('Library not found'); });
  res = S.saveAvatarConfig_({ nameKey: 'casey_nguyen', config: CFG_STR });
  // The pin is the likely cause of a throw here: setAvatar does not exist before Core v225.
  _eq_('a throw is caught, not propagated', res.ok, false);
  _ok_('and is labelled as a Core failure', /GX Core write failed: Library not found/.test(res.error || ''));

  fresh();
  spySetAvatar(undefined);
  res = S.saveAvatarConfig_({ nameKey: 'casey_nguyen', config: CFG_STR });
  _eq_('an empty reply is a failure, never a silent success', res.ok, false);
}

// ============================================================
//  PART B — end to end against the REAL setAvatar
// ============================================================

const HUB = path.join(__dirname, '..', '..', 'greencross-command-center', 'gx_core.gs');

/** Load the hub's gx_core.gs over our GRID, or return null if the hub is not checked out here. */
function loadRealCore() {
  if (!fs.existsSync(HUB)) return null;
  const mkSheet = function (store) {
    return {
      getLastRow: function () { return store().length; },
      getLastColumn: function () { return HEADERS.length; },
      getMaxRows: function () { return store().length + 50; },
      getMaxColumns: function () { return HEADERS.length; },
      setFrozenRows: function () {},
      appendRow: function (r) { store().push(r.slice()); },
      deleteRow: function (r) { store().splice(r - 1, 1); },
      deleteRows: function (r, n) { store().splice(r - 1, n); },
      getRange: function (row, col, nr, nc) {
        return {
          getValues: function () {
            const g = store();
            const n = nr === undefined ? g.length - (row - 1) : nr;
            const c = nc === undefined ? HEADERS.length - (col - 1) : nc;
            const out = [];
            for (let i = 0; i < n; i++) {
              const src = g[(row - 1) + i] || [];
              out.push(Array.from({ length: c }, function (_, j) {
                return src[(col - 1) + j] === undefined ? '' : src[(col - 1) + j];
              }));
            }
            return out;
          },
          setValues: function (vals) {
            const g = store();
            for (let i = 0; i < vals.length; i++) {
              const t = (row - 1) + i;
              while (g.length <= t) g.push(Array(HEADERS.length).fill(''));
              for (let j = 0; j < vals[i].length; j++) g[t][(col - 1) + j] = vals[i][j];
            }
          },
          setNumberFormat: function () { return this; },
          setFontWeight: function () { return this; },
          setValue: function () { return this; },
        };
      },
    };
  };
  const employees = mkSheet(function () { return GRID; });
  const audit     = mkSheet(function () { return AUDIT; });

  const stubs = {
    SpreadsheetApp: {
      openById: function () {
        return {
          getSheetByName: function (n) {
            return n === 'employees' ? employees : n === 'audit_log' ? audit : null;
          },
          insertSheet: function () { return employees; },
        };
      },
    },
    DriveApp: {}, UrlFetchApp: {}, HtmlService: {}, ContentService: {},
    MailApp: {}, GmailApp: {}, ScriptApp: {}, Session: {},
    Logger: { log: function () {} },
    Utilities: { formatDate: H.formatDate, sleep: function () {}, getUuid: function () { return 'u'; } },
    CacheService: { getScriptCache: function () { return { get: function () { return null; }, put: function () {}, remove: function () {} }; } },
    LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
    PropertiesService: { getScriptProperties: function () { return { getProperty: function () { return 'ss'; }, setProperty: function () {} }; } },
  };
  const names = Object.keys(stubs);
  try {
    return new Function(...names, fs.readFileSync(HUB, 'utf8') + '\n; return { setAvatar: setAvatar };')
      (...names.map(function (n) { return stubs[n]; }));
  } catch (e) {
    console.log('  ! could not load the hub gx_core.gs: ' + e.message);
    return null;
  }
}

function test_endToEnd_() {
  const Core = loadRealCore();
  if (!Core) {
    console.log('  SKIP end-to-end — greencross-command-center is not a sibling checkout.');
    return;
  }
  fresh();
  GXCoreStub.setAvatar = function (ref, config, by) { return Core.setAvatar(ref, config, by); };

  const before = stableRowOf('casey_nguyen');
  const others = { jamie: stableRowOf('jamie_cruz'), sky: stableRowOf('sky') };

  // ── The save actually lands ──
  const res = S.saveAvatarConfig_({ nameKey: 'casey_nguyen', config: CFG_STR });
  _ok_('end-to-end save succeeds', res && res.ok === true);
  const stored = JSON.parse(cellOf('casey_nguyen', 'avatar_config') || '{}');
  _eq_('the config is on the employee row', stored.top, 'shortFlat');
  _eq_('and the rest of it', stored.hatColor, 'green');
  // The seed is the whole reason this moved into the library: pinned to employee_number, which is
  // issued once and never reused, so a rename can never hand somebody a different face.
  _eq_('the seed is pinned to employee_number', stored.seed, '17');
  _eq_('and is reported back to the picker', res.seed, '17');

  // ── THE ONE THAT MUST NEVER REGRESS ──
  _eq_('an avatar save blanks NOTHING else on the row', stableRowOf('casey_nguyen'), before);
  _eq_('and touches no other employee (jamie)', stableRowOf('jamie_cruz'), others.jamie);
  _eq_('and touches no other employee (sky)',   stableRowOf('sky'),        others.sky);
  _eq_('nobody else\'s avatar moved', cellOf('sky', 'avatar_config'), '');
  _eq_('the roster still has three people', GRID.length - 1, 3);

  // ── The cache bust is real: the next read sees the new face ──
  const configs = S.getAvatarConfigs_();
  _eq_('the saved avatar is readable immediately after the write',
       (configs['casey_nguyen'] || {}).top, 'shortFlat');

  // ── Clearing ──
  const jamieBefore = stableRowOf('jamie_cruz');
  const cleared = S.clearAvatarConfig_({ nameKey: 'jamie_cruz' });
  _ok_('end-to-end clear succeeds', cleared && cleared.ok === true);
  _eq_('setAvatar confirms it cleared', cleared.cleared, true);
  _eq_('avatar_config really is empty', String(cellOf('jamie_cruz', 'avatar_config') || ''), '');
  _eq_('a clear blanks nothing else either', stableRowOf('jamie_cruz'), jamieBefore);
  _eq_('and leaves the other faces alone',
       JSON.parse(cellOf('casey_nguyen', 'avatar_config') || '{}').top, 'shortFlat');

  const after = S.getAvatarConfigs_();
  _ok_('the cleared avatar is gone from the read path', !after['jamie_cruz']);

  // ── Round trip: set it again, on a person with no employee_number ──
  const re = S.saveAvatarConfig_({ nameKey: 'jamie_cruz', config: JSON.stringify({ top: 'bigHair' }) });
  _ok_('re-saving after a clear works', re && re.ok === true);
  _eq_('no employee_number falls back to employee_id for the seed', re.seed, 'jamie_cruz');
  _eq_('and jamie\'s record is still whole', stableRowOf('jamie_cruz'), jamieBefore);
}

H.run('avatar_write', {
  test_saveHandsCoreTheRightThings_: test_saveHandsCoreTheRightThings_,
  test_clearIsAnEmptyString_: test_clearIsAnEmptyString_,
  test_unresolvedPersonNeverReachesCore_: test_unresolvedPersonNeverReachesCore_,
  test_badInputIsRejectedLocally_: test_badInputIsRejectedLocally_,
  test_failuresKeepTheShapeTheUiRenders_: test_failuresKeepTheShapeTheUiRenders_,
  test_endToEnd_: test_endToEnd_,
});
