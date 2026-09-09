#!/usr/bin/env node
/* One bug report must produce ONE email (dutchie_proxy.gs → handleBugReport_ / bugMailOnce_).
 *
 * Sky, 2026-09-09, on a report Mike filed once: "i got 3 emails for this same bug, is that a bug in
 * itself, or did Mike hit the send button 3 times."  Neither — and that is the whole reason this
 * suite exists. It was ONE click and ONE row on the bug board; the pipeline ran three times.
 *
 * Apps Script's /exec has a second hop that sometimes refuses the content key it just issued and
 * 302s the caller back, re-executing doGet from the top. GX Core measured a five-redirect chain that
 * was three complete executions of a single request, and neither the browser nor the reporter can
 * see it happen. GX Core defends the bug ROW against exactly this (gxIngestBug's three-minute
 * dedupe), which is why the board showed the report once while Sky's inbox showed it three times:
 * the email was the one link in the chain with no guard on it.
 *
 * What these assertions protect, in the order they can regress:
 *
 *   1. A REPEAT EXECUTION MUST BE SILENT. gxIngestBug says so itself — it returns `deduped: true`
 *      when it merged into an existing row. Ignoring that return value is the original bug, and it
 *      is a one-character regression away at all times.
 *   2. THE FALLBACK PATH NEEDS ITS OWN GUARD. When GX Core is unreachable there is no `deduped` to
 *      read, and the redirect chain would send three copies of the very email that exists because
 *      the report did NOT reach the board. The script-cache mark covers that case, and it is the
 *      one a future edit is most likely to drop as redundant.
 *   3. NEITHER GUARD MAY EVER EAT A FIRST REPORT. A dead cache, a busy lock, a thrown digest — every
 *      one of those must fall through to SENDING. A duplicate email is an annoyance; a swallowed bug
 *      report is a person telling us something is broken and nobody hearing it. If this suite has to
 *      fail in one direction, it fails toward the inbox.
 *   4. A DIFFERENT REPORT IS NOT A DUPLICATE. Two people, or two problems, inside the same three
 *      minutes are two emails.
 *
 * Per tests/_harness.js's rule this never reimplements — dutchie_proxy.gs is read off disk.
 */
'use strict';
const { load, run, formatDate, _eq_, _ok_ } = require('./_harness');

// ── Fakes we can inspect ─────────────────────────────────────
let SENT = [];          // every MailApp.sendEmail payload
let INGESTED = [];      // every gxIngestBug call
let CACHE = {};         // a real (in-memory) script cache, so the guard has something to bite on
let CACHE_MODE = 'ok';  // 'ok' | 'dead'  — 'dead' models CacheService being unavailable
let LOCK_MODE  = 'ok';  // 'ok' | 'busy'
let CORE_MODE  = 'new'; // 'new' | 'dup' | 'down'

function M() {
  return load(['dutchie_proxy.gs'], {
    stubs: {
      MailApp: { sendEmail: function (msg) { SENT.push(msg); } },
      GXCore: {
        gxIngestBug: function (app, reporter, payload) {
          INGESTED.push({ app: app, reporter: reporter, payload: payload });
          if (CORE_MODE === 'down') throw new Error('central unavailable');
          if (CORE_MODE === 'dup')  return { ok: true, id: 'bug_existing', deduped: true };
          return { ok: true, id: 'bug_fresh' };
        },
      },
      CacheService: {
        getScriptCache: function () {
          if (CACHE_MODE === 'dead') throw new Error('cache unavailable');
          return {
            get: function (k) { return Object.prototype.hasOwnProperty.call(CACHE, k) ? CACHE[k] : null; },
            put: function (k, v) { CACHE[k] = v; },
            remove: function (k) { delete CACHE[k]; },
          };
        },
      },
      LockService: {
        getScriptLock: function () {
          return {
            waitLock: function () { if (LOCK_MODE === 'busy') throw new Error('could not obtain lock'); },
            releaseLock: function () {},
            tryLock: function () { return LOCK_MODE !== 'busy'; },
            hasLock: function () { return LOCK_MODE !== 'busy'; },
          };
        },
      },
      Utilities: {
        formatDate: formatDate,
        // A real-enough digest: the guard only needs "same input → same key".
        computeDigest: function (_alg, s) {
          return Array.from(Buffer.from(String(s), 'utf8'));
        },
        DigestAlgorithm: { MD5: 'MD5' },
        Charset: { UTF_8: 'UTF_8' },
        base64EncodeWebSafe: function (bytes) {
          return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
        },
      },
    },
  });
}

function reset(opts) {
  opts = opts || {};
  SENT = []; INGESTED = []; CACHE = {};
  CACHE_MODE = opts.cache || 'ok';
  LOCK_MODE  = opts.lock  || 'ok';
  CORE_MODE  = opts.core  || 'new';
}

const MIKE = {
  reporter: 'mike', title: 'Page states - Offline, showing data from 1642 min ago',
  desc: 'Switch profiles and look at the warning bar at the top of the page',
  priority: 'medium', appStore: '', appRole: 'director', appVer: 'v1.759', appRoute: '#/director',
};

const tests = {

  /* The ordinary case, and the floor everything else stands on. */
  'one filing sends one email and files one bug': function () {
    reset();
    const m = M();
    _eq_('ok', m.handleBugReport_(MIKE), { ok: true });
    _eq_('one email', SENT.length, 1);
    _eq_('one ingest', INGESTED.length, 1);
    _eq_('filed under performance', INGESTED[0].app, 'performance');
    _ok_('subject carries the title', SENT[0].subject.indexOf(MIKE.title) >= 0);
    _ok_('body names the bug id so it can be triaged', SENT[0].body.indexOf('bug_fresh') >= 0);
  },

  /* THE REPORTED BUG. Three executions of one request — what a redirect chain actually does.
     GX Core merges runs 2 and 3 into the first row and says so; the email must respect that. */
  'a re-executed request emails once, not three times': function () {
    reset();
    const m = M();
    m.handleBugReport_(MIKE);          // first hop: a real filing
    CORE_MODE = 'dup';                 // Core now recognizes the repeat
    m.handleBugReport_(MIKE);          // redirect re-execution
    m.handleBugReport_(MIKE);          // and again
    _eq_('still one email', SENT.length, 1);
    _eq_('all three reached central', INGESTED.length, 3);
  },

  /* Belt: even if the FIRST execution is the one Core dedupes (a retry after the client gave up
     waiting, where the original landed and its answer was lost), nothing is emailed. */
  'a filing Core already holds emails nobody': function () {
    reset({ core: 'dup' });
    const m = M();
    m.handleBugReport_(MIKE);
    _eq_('no email for a report already on the board', SENT.length, 0);
  },

  /* Braces: central is unreachable, so there is no `deduped` answer to read. The email is now the
     ONLY record of the report — it must be sent, and it must be sent once. */
  'central down: the fallback email is sent, and only once': function () {
    reset({ core: 'down' });
    const m = M();
    m.handleBugReport_(MIKE);
    m.handleBugReport_(MIKE);
    m.handleBugReport_(MIKE);
    _eq_('exactly one fallback email', SENT.length, 1);
    _ok_('and it says the board never got it', SENT[0].body.indexOf('NOT ON THE BUG BOARD') >= 0);
  },

  /* Fail-open, three ways. Each of these must land on the side of the inbox. */
  'a dead cache still sends': function () {
    reset({ cache: 'dead' });
    const m = M();
    m.handleBugReport_(MIKE);
    _ok_('report is not swallowed by a broken cache', SENT.length === 1);
  },

  'a busy lock still sends': function () {
    reset({ lock: 'busy' });
    const m = M();
    m.handleBugReport_(MIKE);
    _ok_('report is not swallowed by lock contention', SENT.length === 1);
  },

  /* Two genuinely different reports in the same window are two reports. A guard that collapsed
     these would hide the second person's problem entirely — the opposite failure, and a worse one. */
  'different reports are not duplicates': function () {
    reset();
    const m = M();
    m.handleBugReport_(MIKE);
    CORE_MODE = 'new';
    m.handleBugReport_(Object.assign({}, MIKE, { reporter: 'dean' }));
    m.handleBugReport_(Object.assign({}, MIKE, { title: 'Slideshow stuck on Century Drive' }));
    _eq_('three distinct reports, three emails', SENT.length, 3);
  },

};

run('bug mail dedupe', tests);
