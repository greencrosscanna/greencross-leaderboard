#!/usr/bin/env node
// ============================================================
//  Avatar permit check — changing a face needs that person's own OLCC permit.
//
//  Run:  node tests/avatar_permit_test.js
//
//  Drives the shipped avatarWriteWithPermit_ with GXCore.verifyPermit stubbed to each answer Core can
//  give, and asserts the one thing that matters: setAvatar is called on state:'match' and on NOTHING
//  else (no_match, locked, no_permit, ok:false, a throw, a malformed reply). Also asserts the typed
//  value never reaches a log or a reply, the verified employee_id is the written one, and that the
//  old GET door (saveavatar/clearavatar) no longer writes.
// ============================================================

const fs = require('fs');
const path = require('path');
const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

const APP_ROSTER = {
  portland: [{ id: '101', name: 'Casey Nguyen', initials: 'CN' }],
  river:    [{ id: '505', name: 'Jamie Cruz',   initials: 'JC' }],
};
const SECRET = 'deploy-secret-value';
const props = {
  getProperty: function (k) {
    if (k === 'GC_STORE_EMPLOYEES_JSON') return JSON.stringify(APP_ROSTER);
    if (k === 'GX_DEPLOY_SECRET') return SECRET;
    return null;
  },
  setProperty: function () { return this; }, deleteProperty: function () { return this; },
  getProperties: function () { return {}; }, setProperties: function () { return this; },
};
const EMPLOYEES = [
  { employee_id: 'casey_nguyen', employee_number: '17', full_name: 'Casey Nguyen', preferred_name: 'Casey',
    home_store: 'portland-rd', dutchie_employee_id: '101', status: 'active', avatar_config: '' },
  { employee_id: 'jamie_cruz', employee_number: '', full_name: 'Jamie Cruz', preferred_name: '',
    home_store: 'river-rd', dutchie_employee_id: '505', status: 'active', avatar_config: '' },
];

let SET = [], VERIFY = [], LOGS = [];
let verifyReply;
const Core = {
  getEmployees: function () { return EMPLOYEES; },
  getStores: function () { return []; },
  verifyPermit: function (secret, id, typed, opts) {
    VERIFY.push({ secret: secret, id: id, typed: typed, opts: opts });
    if (typeof verifyReply === 'function') return verifyReply();
    return verifyReply;
  },
  setAvatar: function (ref, config, by) {
    SET.push({ ref: ref, config: config, by: by });
    return { ok: true, employee_id: ref, name: 'x', seed: '1', cleared: !config };
  },
};

const S = H.load(['gx_roster.gs', 'dutchie_proxy.gs', 'endpoints.gs', 'dutchie_fetch.gs', 'goals.gs', 'auth.gs'], {
  stubs: {
    PropertiesService: { getScriptProperties: function () { return props; },
                         getUserProperties: function () { return props; },
                         getDocumentProperties: function () { return props; } },
    GXCore: Core,
    Logger: { log: function (m) { LOGS.push(String(m)); } },
  },
  extraExports: '"resetRosterMemo": function () { _gxRosterMemo_ = null; _propsCache_ = null; }',
});

const TYPED = 'ZZ9Q77-SECRETTYPED';
const CFG = JSON.stringify({ top: 'shortFlat' });
function fresh(reply) { SET = []; VERIFY = []; LOGS = []; S.resetRosterMemo(); verifyReply = reply; }
function write(extra) {
  return S.avatarWriteWithPermit_(Object.assign({ nameKey: 'casey_nguyen', config: CFG, permit: TYPED }, extra || {}));
}

const tests = {
  test_matchSaves_() {
    fresh({ ok: true, state: 'match' });
    const res = write();
    _eq_('a match saves', res.ok, true);
    _eq_('exactly one write', SET.length, 1);
    _eq_('the id verified is the id written', VERIFY[0].id, SET[0].ref);
    _eq_('and it is the person asked about', SET[0].ref, 'casey_nguyen');
    _eq_('Core is asked with the deploy secret', VERIFY[0].secret, SECRET);
    _eq_('as performance', VERIFY[0].opts.by, 'performance');
  },

  test_matchClearsToo_() {
    fresh({ ok: true, state: 'match' });
    const res = write({ config: '' });
    _eq_('a clear with the right permit works', res.ok, true);
    _eq_('as an empty config', SET[0].config, '');
  },

  // THE ONE THAT MUST NEVER REGRESS: nothing but a match writes.
  test_nonMatchNeverSaves_() {
    const answers = [
      ['no_match',        { ok: true, state: 'no_match', attempts_left: 3 }],
      ['last wrong try',  { ok: true, state: 'no_match', attempts_left: 0, locked_until_ms: Date.now() + 900000 }],
      ['locked',          { ok: true, state: 'locked', locked_until_ms: Date.now() + 600000 }],
      ['no_permit',       { ok: true, state: 'no_permit' }],
      ['ok:false',        { ok: false, code: 'unreachable', error: 'x' }],
      ['ok:false busy',   { ok: false, code: 'busy' }],
      ['unknown state',   { ok: true, state: 'weird' }],
      ['no state',        { ok: true }],
      ['empty reply',     undefined],
      ['null reply',      null],
      ['a throw',         function () { throw new Error('boom ' + TYPED); }],
    ];
    answers.forEach(function (a) {
      fresh(a[1]);
      const res = write();
      _eq_(a[0] + ': refused', res.ok, false);
      _eq_(a[0] + ': setAvatar never called', SET.length, 0);
      _ok_(a[0] + ': the typed value is not in the reply', JSON.stringify(res).indexOf(TYPED) < 0);
    });
  },

  test_distinctMessages_() {
    fresh({ ok: true, state: 'no_match', attempts_left: 3 });
    let r = write();
    _eq_('no_match code', r.code, 'no_match');
    _eq_('attempts left is carried', r.attempts_left, 3);
    _ok_('and said in words', /3 tries left/.test(r.error));

    fresh({ ok: true, state: 'no_match', attempts_left: 1 });
    _ok_('singular', /1 try left/.test(write().error));

    fresh({ ok: true, state: 'locked', locked_until_ms: Date.now() + 10 * 60000 });
    r = write();
    _eq_('locked code', r.code, 'locked');
    _ok_('minutes shown', r.minutes >= 9 && r.minutes <= 10);

    fresh({ ok: true, state: 'no_match', attempts_left: 0, locked_until_ms: Date.now() + 900000 });
    _eq_('the miss that locks reads as locked', write().code, 'locked');

    fresh({ ok: true, state: 'no_permit' });
    r = write();
    _eq_('no_permit code', r.code, 'no_permit');
    _ok_('says a manager should check Crew, not "wrong"', /Crew/.test(r.error) && !/doesn't match/.test(r.error));

    fresh({ ok: false, code: 'unreachable' });
    r = write();
    _eq_('could not check', r.code, 'unavailable');
    _ok_('is never called a wrong number', /try again/.test(r.error) && !/match|wrong/i.test(r.error));
  },

  test_inputIsCheckedBeforeCore_() {
    fresh({ ok: true, state: 'match' });
    _eq_('nothing typed is refused', write({ permit: '   ' }).ok, false);
    _eq_('no nameKey is refused', write({ nameKey: '' }).ok, false);
    _eq_('bad config JSON is refused', write({ config: '{nope' }).ok, false);
    _eq_('unknown person is refused', write({ nameKey: 'nobody_here' }).ok, false);
    _eq_('Core was never asked for any of them', VERIFY.length, 0);
    _eq_('and nothing written', SET.length, 0);
  },

  test_noSecretMeansNoWrite_() {
    fresh({ ok: true, state: 'match' });
    const keep = props.getProperty;
    props.getProperty = function (k) { return k === 'GX_DEPLOY_SECRET' ? null : keep(k); };
    try {
      const res = write();
      _eq_('no deploy secret: refused', res.ok, false);
      _eq_('nothing written', SET.length, 0);
    } finally { props.getProperty = keep; }
  },

  test_typedValueIsNeverLogged_() {
    ['match', 'no_match', 'locked', 'no_permit'].forEach(function (st) {
      fresh({ ok: true, state: st, attempts_left: 2, locked_until_ms: Date.now() + 60000 });
      write();
      _ok_(st + ': not in any log line', LOGS.join('\n').indexOf(TYPED) < 0);
    });
    fresh(function () { throw new Error('boom ' + TYPED); });
    write();
    _ok_('a throw does not log it', LOGS.join('\n').indexOf(TYPED) < 0);
  },

  test_oldDoorsDoNotWrite_() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');
    const at = src.indexOf("params.action === 'saveavatar'");
    _ok_('the GET route for saveavatar exists as a refusal', at >= 0);
    const blk = src.slice(at, src.indexOf('getavatardata', at));
    _ok_('and does not call a writer', !/saveAvatarConfig_|clearAvatarConfig_|gxWriteAvatarToCore_|setAvatar/.test(blk));
    _ok_('and names clearavatar in the same refusal', /clearavatar/.test(blk));
    // Every caller of the unchecked writers, across all shipped .gs files, must be the permit function.
    const callers = [];
    fs.readdirSync(path.join(__dirname, '..')).filter(function (f) { return /\.gs$/.test(f); }).forEach(function (f) {
      const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      const re = /(saveAvatarConfig_|clearAvatarConfig_|gxWriteAvatarToCore_|GXCore\.setAvatar)\(/g;
      let m;
      while ((m = re.exec(t))) {
        const before = t.slice(0, m.index);
        const fn = before.lastIndexOf('\nfunction ');
        const name = (t.slice(fn + 10, t.indexOf('(', fn + 10)) || '').trim();
        if (name !== m[1].replace('GXCore.', '') + '') callers.push(f + ':' + name + '>' + m[1]);
      }
    });
    const allowed = ['endpoints.gs:avatarWriteWithPermit_>gxWriteAvatarToCore_',
                     'endpoints.gs:saveAvatarConfig_>gxWriteAvatarToCore_',
                     'endpoints.gs:clearAvatarConfig_>gxWriteAvatarToCore_',
                     'endpoints.gs:gxWriteAvatarToCore_>GXCore.setAvatar'];
    _eq_('only the permit path (and the unrouted inner writers) reach setAvatar', callers.sort(), allowed.sort());
  },

  test_postDoorChecksSessionThenPermit_() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');
    const at = src.indexOf('function doPost(e)');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    const authed = body.indexOf('requireAuth_(body)');
    const w = body.indexOf('avatarWriteWithPermit_(body)');
    _ok_('session is checked before the avatar write', authed >= 0 && w > authed);
    _ok_('the permit is never read from a GET', !/params\.permit|e\.parameter\.permit/.test(src));
  },
};

H.run('avatar_permit', tests);
