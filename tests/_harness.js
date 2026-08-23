// ============================================================
//  Green Cross — Node test harness  (tests/_harness.js)
//
//  Two jobs:
//    1. load()  — evaluate SHIPPED .gs source as text inside a
//       sandbox with the Apps Script globals stubbed, and hand
//       back its top-level functions.
//    2. A tiny assertion harness (_eq_/_ok_/_approx_) that
//       mirrors the one in tests.gs, so a ported test reads
//       line-for-line like the original.
//
//  THE RULE: a test NEVER reimplements the function it tests.
//  We read the real file off disk. If the shipped function
//  drifts, the test drifts with it — which is the entire point.
//  A test that carries its own copy of the logic passes forever
//  while production rots.
// ============================================================

const fs   = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

// ── Frozen clock ─────────────────────────────────────────────
// ptNow_() calls `new Date()`. To pin a date we shadow the Date
// global inside the sandbox with a subclass whose no-arg form
// returns the frozen instant. Everything else (Date.UTC, parse,
// new Date(ms)) behaves exactly as the real one.
const RealDate = Date;
const clock = { now: null };

class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0 && clock.now !== null) super(clock.now);
    else super(...args);
  }
  static now() { return clock.now !== null ? clock.now : RealDate.now(); }
}

/** Freeze `new Date()` at a UTC-ms instant (or null to run on the real clock). */
function setNow(ms) { clock.now = ms; }

// ── Utilities.formatDate — real, not faked ───────────────────
// Implemented over Intl/ICU so it is genuinely DST- and
// timezone-correct, the property every PT date helper depends
// on. A stub that returned a fixed string would make the
// timezone tests assert nothing.
const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function formatDate(date, tz, pattern) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});

  const H  = parseInt(p.hour, 10);
  const h12 = H % 12 === 0 ? 12 : H % 12;

  return String(pattern).replace(
    /yyyy|yy|MM|M|dd|d|HH|H|hh|h|mm|ss|u|a|EEE/g,
    function (tok) {
      switch (tok) {
        case 'yyyy': return p.year;
        case 'yy':   return p.year.slice(-2);
        case 'MM':   return p.month;
        case 'M':    return String(parseInt(p.month, 10));
        case 'dd':   return p.day;
        case 'd':    return String(parseInt(p.day, 10));
        case 'HH':   return p.hour;
        case 'H':    return String(H);
        case 'hh':   return String(h12).padStart(2, '0');
        case 'h':    return String(h12);
        case 'mm':   return p.minute;
        case 'ss':   return p.second;
        case 'u':    return String(WD[p.weekday]);
        case 'a':    return H < 12 ? 'AM' : 'PM';
        case 'EEE':  return p.weekday;
        default:     return tok;
      }
    }
  );
}

/** Format a UTC-ms instant as a Portland-local YYYY-MM-DD. Used by tests to
 *  assert on dates without going back through the code under test. */
function fmtPT(ms) { return formatDate(new RealDate(ms), 'America/Los_Angeles', 'yyyy-MM-dd'); }

// ── Apps Script global stubs ─────────────────────────────────
// Deliberately inert. Anything that reaches out (network, Sheets,
// Properties) is not a pure function and does not belong in this
// suite; if a stub is ever actually hit, it returns the same
// "nothing stored" shape a fresh script project would.
function baseStubs() {
  const noProps = {
    getProperty: function () { return null; },
    setProperty: function () { return this; },
    deleteProperty: function () { return this; },
    getProperties: function () { return {}; },
    setProperties: function () { return this; },
  };
  const noCache = {
    get: function () { return null; },
    put: function () {},
    remove: function () {},
    getAll: function () { return {}; },
    removeAll: function () {},
  };
  const nope = function (name) {
    return function () { throw new Error('Apps Script stub: ' + name + ' is not available under node'); };
  };

  return {
    Date: FrozenDate,
    Logger: { log: function () {} },
    console: { log: function () {}, warn: function () {}, error: function () {}, info: function () {} },
    Utilities: {
      formatDate: formatDate,
      sleep: function () {},
      getUuid: function () { return '00000000-0000-0000-0000-000000000000'; },
      base64Encode: function (s) { return Buffer.from(String(s), 'utf8').toString('base64'); },
      base64Decode: function (s) { return Array.from(Buffer.from(String(s), 'base64')); },
      base64EncodeWebSafe: function (s) {
        return Buffer.from(String(s), 'utf8').toString('base64')
          .replace(/\+/g, '-').replace(/\//g, '_');
      },
      computeHmacSha256Signature: nope('Utilities.computeHmacSha256Signature'),
      computeDigest: nope('Utilities.computeDigest'),
      DigestAlgorithm: {},
    },
    PropertiesService: {
      getScriptProperties: function () { return noProps; },
      getUserProperties:   function () { return noProps; },
      getDocumentProperties: function () { return noProps; },
    },
    CacheService: {
      getScriptCache:   function () { return noCache; },
      getUserCache:     function () { return noCache; },
      getDocumentCache: function () { return noCache; },
    },
    SpreadsheetApp: { openById: nope('SpreadsheetApp.openById'), getActive: nope('SpreadsheetApp.getActive'),
                      getActiveSpreadsheet: nope('SpreadsheetApp.getActiveSpreadsheet') },
    UrlFetchApp:    { fetch: nope('UrlFetchApp.fetch'), fetchAll: nope('UrlFetchApp.fetchAll') },
    ScriptApp:      { getService: function () { return { getUrl: function () { return ''; } }; },
                      newTrigger: nope('ScriptApp.newTrigger'),
                      getProjectTriggers: function () { return []; },
                      deleteTrigger: function () {} },
    Session:        { getActiveUser: function () { return { getEmail: function () { return ''; } }; },
                      getEffectiveUser: function () { return { getEmail: function () { return ''; } }; },
                      getScriptTimeZone: function () { return 'America/Los_Angeles'; } },
    LockService:    { getScriptLock: function () {
                        return { tryLock: function () { return true; }, waitLock: function () {},
                                 releaseLock: function () {}, hasLock: function () { return true; } };
                      } },
    HtmlService:    { createHtmlOutputFromFile: nope('HtmlService.createHtmlOutputFromFile'),
                      createHtmlOutput: nope('HtmlService.createHtmlOutput'),
                      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' } },
    ContentService: { createTextOutput: nope('ContentService.createTextOutput'),
                      MimeType: { JSON: 'JSON', JAVASCRIPT: 'JAVASCRIPT', TEXT: 'TEXT' } },
    DriveApp:       { getFileById: nope('DriveApp.getFileById') },
    MailApp:        { sendEmail: nope('MailApp.sendEmail') },
    GXCore:         new Proxy({}, { get: function (_, k) { return nope('GXCore.' + String(k)); } }),
  };
}

/** Every top-level `function foo(` / `var|const|let foo` in the source. */
function topLevelNames(src) {
  const out = [];
  const seen = Object.create(null);
  const add = function (n) { if (!seen[n]) { seen[n] = 1; out.push(n); } };
  let m;
  const fn  = /^function\s+([A-Za-z0-9_$]+)/gm;
  const dec = /^(?:var|const|let)\s+([A-Za-z0-9_$]+)/gm;
  while ((m = fn.exec(src)))  add(m[1]);
  while ((m = dec.exec(src))) add(m[1]);
  return out;
}

/**
 * Load shipped .gs files as text into one sandbox and return their top-level
 * functions/constants.
 *
 * @param {string[]} files          repo-relative .gs filenames, loaded in order
 * @param {Object=}  opts.stubs     extra/overriding Apps Script globals
 * @param {string=}  opts.extraExports  extra object properties for the returned
 *                                  bag, e.g. a setter that can reach a file-level
 *                                  memo the tests need to reset
 */
function load(files, opts) {
  opts = opts || {};
  const src = files.map(function (f) {
    return '\n/* ==== ' + f + ' ==== */\n' + fs.readFileSync(path.join(REPO, f), 'utf8');
  }).join('\n');

  const stubs = Object.assign(baseStubs(), opts.stubs || {});
  const names = Object.keys(stubs);
  const exports_ = topLevelNames(src)
    .map(function (n) { return JSON.stringify(n) + ':' + n; })
    .concat(opts.extraExports ? [opts.extraExports] : []);

  const body = src + '\n;return {' + exports_.join(',') + '};';
  return new Function(...names, body)(...names.map(function (n) { return stubs[n]; }));
}

// ── Assertion harness (mirrors tests.gs) ─────────────────────
let _T_PASS = 0, _T_FAIL = 0;
const _T_LOG = [];

function _eq_(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { _T_PASS++; }
  else { _T_FAIL++; _T_LOG.push('  ✗ ' + name + '\n      expected: ' + e + '\n      actual:   ' + a); }
}

function _ok_(name, cond) {
  if (cond) { _T_PASS++; }
  else { _T_FAIL++; _T_LOG.push('  ✗ ' + name + ' (expected truthy)'); }
}

function _approx_(name, actual, expected, eps) {
  if (Math.abs(actual - expected) <= (eps || 1e-9)) { _T_PASS++; }
  else { _T_FAIL++; _T_LOG.push('  ✗ ' + name + '\n      expected ≈ ' + expected + '\n      actual:    ' + actual); }
}

/**
 * Run the named test functions, print the summary, and exit non-zero on any
 * failure — that exit code is what makes gx-preflight refuse the push.
 * The summary is the LAST line printed: preflight tails it.
 */
function run(suiteName, tests) {
  Object.keys(tests).forEach(function (k) {
    try {
      tests[k]();
    } catch (err) {
      _T_FAIL++;
      _T_LOG.push('  ✗ ' + k + ' THREW: ' + (err && err.stack ? err.stack : err));
    }
  });
  if (_T_LOG.length) console.log(_T_LOG.join('\n'));
  const total = _T_PASS + _T_FAIL;
  const head  = _T_FAIL === 0
    ? '✅ ' + suiteName + ' ALL PASS (' + _T_PASS + '/' + total + ')'
    : '❌ ' + suiteName + ' ' + _T_FAIL + ' FAILED (' + _T_PASS + '/' + total + ')';
  console.log(head);
  if (_T_FAIL > 0) process.exit(1);
}

module.exports = { load, run, setNow, fmtPT, formatDate, _eq_, _ok_, _approx_ };
