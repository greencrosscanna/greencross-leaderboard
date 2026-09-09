#!/usr/bin/env node
/* Where the kiosk's SPIFF numbers COME FROM (spiff.gs).
 *
 * On 2026-09-08 this stopped calling SPIFF's /exec and started reading the payload SPIFF
 * publishes to GX Core (`spiff_publications`, via GXCore.publishedSpiffProgress). The numbers
 * and the shape are identical — that was the point — so nothing downstream changed, and
 * spiff_progress_test.js still guards all of it unaltered.
 *
 * What DID change is how this can now be wrong, and every one of these failures is silent:
 *
 *   1. STALE INSTEAD OF DOWN. Core stores the payload verbatim and never recomputes it. If
 *      SPIFF's hourly publish dies, nothing throws anywhere — the payload just gets older, and
 *      a consumer that does not check age_minutes draws a fortnight-old bar looking perfectly
 *      healthy. A budtender reads "4 of 5, $25 to go" for a program that ended two weeks ago.
 *
 *   2. ONE SCOPE IS NOT ENOUGH. Core files each payload under the pay period the PROGRAM
 *      STARTED in, not the one we are in. A SPIFF that began last fortnight and is still
 *      running is filed under the PREVIOUS scope, so reading only the current one drops a live
 *      program off every card — and that is the ordinary case, not an edge one.
 *
 *   3. "NOTHING PUBLISHED" IS NOT AN OUTAGE. Most fortnights in the lookback had no program
 *      start, so Core answers ok:false for them. Routing that through the failure path would
 *      put a constantly-polled kiosk into the 2-minute failure-cache loop forever and log an
 *      error every time.
 *
 * Per tests/_harness.js's rule these never reimplement — spiff.gs and dutchie_proxy.gs are read
 * off disk and the real functions are called, including the real PT date arithmetic that builds
 * the scope list.
 */
'use strict';
const { load, run, setNow, _eq_, _ok_ } = require('./_harness');

// 2026-09-08 12:00 PT. Anchor 2026-05-11 + 14×8 = 2026-08-31, so the live period starts then.
setNow(Date.UTC(2026, 8, 8, 19, 0, 0));

const PP_NOW  = '2026-08-31';
const PP_PREV = '2026-08-17';
const PP_PREV2 = '2026-08-03';

/* What Core returns, keyed by scope. Envelope shape copied from gxReadPublished_ live on
   2026-09-08; row shape from the payload actually stored that day. */
let CORE = {};
let KV   = { 'cfg.payPeriodAnchor': '2026-05-11', 'cfg.payPeriodDays': '14' };
let CALLS = [];

function row(over) {
  return Object.assign({
    program_id: 'mule-202608', pay_period: '2026-08-31 - 2026-09-13',
    store_id: 'bend', employee_id: 44905, name: 'Nathan Wydick',
    units: 3, target: 5, hit: false, earned: 0,
    vendor: 'Mule Extracts', program_name: 'Mule Extracts 2g Dank Tank Spiff',
    start_date: '2026-08-31', end_date: '2026-09-13', status: 'active',
    refreshed_at: '2026-09-08 21:56:58',
  }, over || {});
}

function published(scope, rows, ageMin, over) {
  return Object.assign({
    ok: true, producer: 'spiff', scope: scope,
    published_at: '2026-09-09T04:58:09.460Z', age_minutes: ageMin,
    published_by: 'spiff',
    payload: { ok: true, pay_period: scope, rows: rows, by_employee: [],
               refreshed_at: (rows[0] || {}).refreshed_at || '',
               orphan_rows: 0, orphan_program_ids: [] },
  }, over || {});
}

const props = { GX_DEPLOY_SECRET: 's3cret' };

const M = load(['dutchie_proxy.gs', 'spiff.gs'], {
  stubs: {
    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
          setProperty: function (k, v) { props[k] = String(v); },
          deleteProperty: function (k) { delete props[k]; },
          getProperties: function () { return Object.assign({}, props); },
        };
      },
      getUserProperties: function () { return { getProperty: function () { return null; } }; },
    },
    GXCore: {
      getKv: function (k) { return Object.prototype.hasOwnProperty.call(KV, k) ? KV[k] : null; },
      publishedSpiffProgress: function (secret, scope) {
        CALLS.push({ secret: secret, scope: scope });
        return CORE[scope] || { ok: false, error: 'nothing published for scope ' + scope };
      },
    },
  },
});

/* spiff.gs memoizes nothing itself, but currentPPStart_/payPeriodCfg_ in dutchie_proxy.gs cache
   per execution — which under node is the whole test file. That is fine here: every case runs on
   the same frozen clock and the same anchor, so one resolution is the correct one. */

function reset() { CORE = {}; CALLS = []; }

const tests = {

  /* ── 1. The scope list ────────────────────────────────────────────────────────────── */

  'scopes are this pay period and the two before it, in order': function () {
    _eq_('scopes', M.spiffScopes_(), [PP_NOW, PP_PREV, PP_PREV2]);
  },

  'the lookback is a named constant, not a literal buried in the fetch': function () {
    _eq_('SPIFF_LOOKBACK_PERIODS', M.SPIFF_LOOKBACK_PERIODS, 3);
    _eq_('scope count matches it', M.spiffScopes_().length, M.SPIFF_LOOKBACK_PERIODS);
  },

  'scopes step by the CONFIGURED period length, not a hardcoded 14': function () {
    // Every scope must be a whole number of periods back from the current start, using the
    // length GX Core supplies. A literal here is how a cadence change half-applies.
    const days = M.ppDays_();
    _eq_('days from Core', days, 14);
    _eq_('one period back', M.spiffScopes_()[1], M.ptDateShift_(PP_NOW, -days));
    _eq_('two periods back', M.spiffScopes_()[2], M.ptDateShift_(PP_NOW, -2 * days));
  },

  /* ── 2. Reading a scope ───────────────────────────────────────────────────────────── */

  'a fresh scope is used and its rows come back': function () {
    reset();
    CORE[PP_NOW] = published(PP_NOW, [row()], 14);
    const r = M.spiffReadScope_('s3cret', PP_NOW, 360);
    _ok_('used', r.used === true);
    _eq_('rows', r.rows.length, 1);
    _eq_('age', r.age_minutes, 14);
    _eq_('refreshed_at carried', r.refreshed_at, '2026-09-08 21:56:58');
    _eq_('no reason when nothing is wrong', r.reason, '');
  },

  'the deploy secret is what gets sent — this read is per-employee money': function () {
    reset();
    CORE[PP_NOW] = published(PP_NOW, [row()], 14);
    M.spiffFetchRaw_();
    _ok_('at least one call', CALLS.length > 0);
    _ok_('every call carried the secret', CALLS.every(function (c) { return c.secret === 's3cret'; }));
  },

  'a STALE scope contributes no rows and says why': function () {
    reset();
    // 9 hours old against a 6-hour limit: SPIFF has stopped publishing.
    const r = M.spiffReadScope_('s3cret', PP_NOW, 360);
    CORE[PP_NOW] = published(PP_NOW, [row()], 540);
    const r2 = M.spiffReadScope_('s3cret', PP_NOW, 360);
    _ok_('missing scope unused', r.used === false);
    _ok_('stale scope unused', r2.used === false);
    _eq_('stale rows dropped', r2.rows.length, 0);
    _ok_('reason names staleness', /^stale/.test(r2.reason));
    _ok_('reason carries the numbers', /540/.test(r2.reason) && /360/.test(r2.reason));
  },

  'an envelope with NO age is refused, not assumed fresh': function () {
    reset();
    CORE[PP_NOW] = published(PP_NOW, [row()], null, { published_at: '' });
    const r = M.spiffReadScope_('s3cret', PP_NOW, 360);
    _ok_('unused', r.used === false);
    _eq_('no rows', r.rows.length, 0);
    _ok_('reason names the unreadable timestamp', /freshness/.test(r.reason));
  },

  'a scope Core has nothing for is recorded, not thrown': function () {
    reset();
    const r = M.spiffReadScope_('s3cret', PP_PREV, 360);
    _ok_('unused', r.used === false);
    _eq_('rows', r.rows.length, 0);
    _ok_('reason is Core\'s own words', /nothing published/.test(r.reason));
    _eq_('age is null, not 0', r.age_minutes, null);
  },

  'a THROW from the library is caught and reported as a reason': function () {
    reset();
    const boom = load(['dutchie_proxy.gs', 'spiff.gs'], {
      stubs: {
        PropertiesService: { getScriptProperties: function () { return { getProperty: function () { return 's3cret'; } }; },
                             getUserProperties: function () { return { getProperty: function () { return null; } }; } },
        GXCore: { getKv: function (k) { return KV[k] || null; },
                  publishedSpiffProgress: function () { throw new Error('library not bound'); } },
      },
    });
    const r = boom.spiffReadScope_('s3cret', PP_NOW, 360);
    _ok_('unused', r.used === false);
    _ok_('reason carries the message', /library not bound/.test(r.reason));
    _ok_('the whole fetch survives it', boom.spiffFetchRaw_().ok === true);
  },

  /* ── 3. Merging the lookback ──────────────────────────────────────────────────────── */

  'a program that STARTED last fortnight and is still running is not dropped': function () {
    reset();
    // The failure this lookback exists for: filed under the previous scope, live today.
    CORE[PP_PREV] = published(PP_PREV, [row({
      program_id: 'longrun', start_date: '2026-08-24', end_date: '2026-09-06', status: 'active',
    })], 14);
    const raw = M.spiffFetchRaw_();
    _ok_('ok', raw.ok === true);
    _eq_('the row survived', raw.rows.length, 1);
    _eq_('and it is the long-running one', raw.rows[0].program_id, 'longrun');
    // …and the kiosk's own window filter still keeps it, because it overlaps this period.
    const kept = M.spiffFilterRows_(M.spiffActiveRows_(raw.rows), 'bend', PP_NOW, '2026-09-13');
    _eq_('kept by the overlap filter', kept.length, 1);
  },

  'rows from several scopes are concatenated, not overwritten': function () {
    reset();
    CORE[PP_NOW]  = published(PP_NOW,  [row({ program_id: 'now' })], 14);
    CORE[PP_PREV] = published(PP_PREV, [row({ program_id: 'prev', employee_id: 111 })], 14);
    const raw = M.spiffFetchRaw_();
    _eq_('both', raw.rows.length, 2);
    _eq_('ids', raw.rows.map(function (r) { return r.program_id; }).sort(), ['now', 'prev']);
  },

  'refreshed_at is the NEWEST across the scopes used': function () {
    reset();
    CORE[PP_NOW]  = published(PP_NOW,  [row({ refreshed_at: '2026-09-08 21:56:58' })], 14);
    CORE[PP_PREV] = published(PP_PREV, [row({ refreshed_at: '2026-09-02 15:32:00' })], 14);
    _eq_('newest wins', M.spiffFetchRaw_().refreshed_at, '2026-09-08 21:56:58');
  },

  'a stale scope does not poison the fresh ones beside it': function () {
    reset();
    CORE[PP_NOW]  = published(PP_NOW,  [row({ program_id: 'fresh' })], 14);
    CORE[PP_PREV] = published(PP_PREV, [row({ program_id: 'old' })], 5000);
    const raw = M.spiffFetchRaw_();
    _ok_('still ok', raw.ok === true);
    _eq_('only the fresh row', raw.rows.map(function (r) { return r.program_id; }), ['fresh']);
  },

  /* ── 4. What counts as a failure ──────────────────────────────────────────────────── */

  'NOTHING published anywhere is ok:true with no rows — a quiet fortnight, not an outage': function () {
    reset();
    const raw = M.spiffFetchRaw_();
    _ok_('ok', raw.ok === true);
    _eq_('no rows', raw.rows.length, 0);
    // The kiosk renders cards with no SPIFF row. It must NOT take the 2-minute failure cache.
    _ok_('no error', !raw.error);
  },

  'a missing deploy secret IS a failure — no read can recover from it': function () {
    reset();
    const saved = props.GX_DEPLOY_SECRET;
    delete props.GX_DEPLOY_SECRET;
    const raw = M.spiffFetchRaw_();
    props.GX_DEPLOY_SECRET = saved;
    _ok_('not ok', raw.ok === false);
    _ok_('names the property', /GX_DEPLOY_SECRET/.test(raw.error));
    _eq_('nothing was even asked for', CALLS.length, 0);
  },

  'every scope read is reported, used or not, for the diagnostic': function () {
    reset();
    CORE[PP_NOW] = published(PP_NOW, [row()], 14);
    const raw = M.spiffFetchRaw_();
    _eq_('one entry per scope', raw.scopes.length, 3);
    _eq_('scopes in order', raw.scopes.map(function (s) { return s.scope; }), [PP_NOW, PP_PREV, PP_PREV2]);
    _eq_('used flags', raw.scopes.map(function (s) { return s.used; }), [true, false, false]);
    _ok_('the unused ones carry a reason', raw.scopes.slice(1).every(function (s) { return !!s.reason; }));
    _eq_('the limit is reported too', raw.maxAgeMinutes, 360);
  },

  /* ── 5. The staleness threshold ───────────────────────────────────────────────────── */

  'the threshold comes from GX Core, so the watchdog and the screen agree': function () {
    KV['cfg.spiffStaleHours'] = '2';
    _eq_('2 hours', M.spiffStaleMinutes_(), 120);
    delete KV['cfg.spiffStaleHours'];
    _eq_('falls back to Core\'s own default', M.spiffStaleMinutes_(), 6 * 60);
    _eq_('and that default is stated once', M.SPIFF_STALE_HOURS_DEFAULT, 6);
  },

  'a nonsense threshold falls back rather than disabling the check': function () {
    KV['cfg.spiffStaleHours'] = 'soon';
    _eq_('garbage ignored', M.spiffStaleMinutes_(), 360);
    KV['cfg.spiffStaleHours'] = '0';
    _eq_('zero ignored — it would blank the row forever', M.spiffStaleMinutes_(), 360);
    delete KV['cfg.spiffStaleHours'];
  },

  /* ── 6. The old path is gone ──────────────────────────────────────────────────────── */

  'nothing calls SPIFF /exec any more': function () {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'spiff.gs'), 'utf8');
    _ok_('no UrlFetchApp', !/UrlFetchApp/.test(src));
    // The prose above still NAMES ?action=progress — the payload is deliberately that shape.
    // What must be gone is a call BUILDING that query string.
    _ok_('no action=progress query built', !/['"]\?action=progress/.test(src));
    _ok_('no spiffProgress kv key', !/getKv\(\s*'spiffProgress'/.test(src));
    _ok_('it reads Core instead', /publishedSpiffProgress/.test(src));
  },
};

run('spiff_published_source', tests);
