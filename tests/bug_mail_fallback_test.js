#!/usr/bin/env node
/* This app must email a filed bug ONLY when GX Core could not be reached
 * (dutchie_proxy.gs → handleBugReport_ / bugMailOnce_).
 *
 * Sky, 2026-09-09, on a report Mike filed once: "i got 3 emails for this same bug, is that a bug in
 * itself, or did Mike hit the send button 3 times."  Neither. It was ONE click and ONE row on the bug
 * board; the pipeline ran three times.
 *
 * Apps Script's /exec second hop sometimes refuses the content key it just issued and 302s the caller
 * back, re-running doGet from the top. GX Core measured a five-redirect chain that was three complete
 * executions of one request, and nothing on the client can see it. Core has always defended the bug
 * ROW against this (gxIngestBug's three-minute merge), which is precisely why the board showed the
 * report once while the inbox showed it three times: the email was the only step with no guard.
 *
 * v1.761 fixed that here by reading gxIngestBug's `deduped` answer. GX Core v310 then took the send
 * itself, below the de-dupe, so the guard lives once instead of once per spoke — and this app's send
 * narrowed to the one case Core cannot cover. THAT NARROWING IS WHAT THIS SUITE NOW PINS, and the
 * failure it exists to prevent has inverted: the danger is no longer three emails, it is TWO
 * (Core's plus ours) on every ordinary filing.
 *
 * What these assertions protect, in the order they can regress:
 *
 *   1. A SUCCESSFUL FILING MUST EMAIL NOTHING FROM HERE. Re-adding a send on the happy path — or
 *      re-pinning GXCore forward while leaving one in — is the two-emails-per-bug regression. This is
 *      the assertion that would have caught it, and the reason the suite was rewritten rather than
 *      deleted when Core took the job.
 *   2. THE FALLBACK MUST STILL FIRE. When Core is unreachable nothing is recorded anywhere, and this
 *      email becomes the only evidence a person reported a problem. Deleting it because "Core handles
 *      bug mail now" is the plausible-sounding change that loses reports silently.
 *   3. THE FALLBACK MUST NOT TRIPLICATE. There is no `deduped` answer on this path — the call threw —
 *      so the script-cache mark is the only thing standing between a redirect chain and three copies
 *      of the email that exists because the board got nothing.
 *   4. NEITHER GUARD MAY EVER EAT A REPORT. A dead cache, a busy lock, a thrown digest must all fall
 *      through to SENDING. A duplicate email is an annoyance; a swallowed bug report is a person
 *      saying something is broken and nobody hearing it. If this suite fails, it fails toward the inbox.
 *   5. THE FALLBACK MUST READ AS A FAILURE. An email that looks like an ordinary notification, for a
 *      report that was never filed, is worse than no email — it is a lost report wearing the costume
 *      of a handled one.
 *
 * Per tests/_harness.js's rule these never reimplement — dutchie_proxy.gs is read off disk.
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

  /* THE REGRESSION THIS SUITE NOW EXISTS FOR. Core v310 mails the filing itself; a send left here
     would make that two emails per bug. Ordinary path: row filed, nothing sent from this app. */
  'a successful filing sends no email from this app': function () {
    reset();
    const m = M();
    _eq_('ok', m.handleBugReport_(MIKE), { ok: true });
    _eq_('one ingest', INGESTED.length, 1);
    _eq_('filed under performance', INGESTED[0].app, 'performance');
    _eq_('and NOT mailed from here — Core owns that now', SENT.length, 0);
  },

  /* The original symptom, re-executed. Core dedupes the row AND owns the mail, so all three
     executions are silent here no matter what they return. */
  'a re-executed request still sends nothing': function () {
    reset();
    const m = M();
    m.handleBugReport_(MIKE);
    CORE_MODE = 'dup';
    m.handleBugReport_(MIKE);
    m.handleBugReport_(MIKE);
    _eq_('no email on any of the three', SENT.length, 0);
    _eq_('all three reached central', INGESTED.length, 3);
  },

  /* THE HALF THAT SURVIVES. Core unreachable: nothing was recorded, so this email is the only
     evidence the report happened. It must be sent — and sent once, because a redirect chain hits
     this path exactly as hard as it hit the old one. */
  'central down: the fallback is sent, and only once': function () {
    reset({ core: 'down' });
    const m = M();
    m.handleBugReport_(MIKE);
    m.handleBugReport_(MIKE);
    m.handleBugReport_(MIKE);
    _eq_('exactly one fallback email', SENT.length, 1);
  },

  /* A fallback that looks like a normal notification is a lost report in disguise. */
  'the fallback says plainly that nothing was filed': function () {
    reset({ core: 'down' });
    const m = M();
    m.handleBugReport_(MIKE);
    _ok_('subject flags it as unfiled', SENT[0].subject.indexOf('UNFILED') >= 0);
    _ok_('body says it is not on the board', SENT[0].body.indexOf('NOT ON THE BUG BOARD') >= 0);
    _ok_('and asks for it to be re-filed', SENT[0].body.indexOf('re-file') >= 0);
    _ok_('the report itself is still in there', SENT[0].body.indexOf(MIKE.desc) >= 0);
    _ok_('and it is attributed', SENT[0].body.indexOf('mike') >= 0);
  },

  /* Fail-open, both ways. Each must land on the side of the inbox. */
  'a dead cache still sends the fallback': function () {
    reset({ core: 'down', cache: 'dead' });
    const m = M();
    m.handleBugReport_(MIKE);
    _eq_('not swallowed by a broken cache', SENT.length, 1);
  },

  'a busy lock still sends the fallback': function () {
    reset({ core: 'down', lock: 'busy' });
    const m = M();
    m.handleBugReport_(MIKE);
    _eq_('not swallowed by lock contention', SENT.length, 1);
  },

  /* Two genuinely different reports lost in the same window are two lost reports. A guard that
     collapsed these would hide the second person's problem entirely — the worse failure. */
  'different reports are not duplicates': function () {
    reset({ core: 'down' });
    const m = M();
    m.handleBugReport_(MIKE);
    m.handleBugReport_(Object.assign({}, MIKE, { reporter: 'dean' }));
    m.handleBugReport_(Object.assign({}, MIKE, { title: 'Slideshow stuck on Century Drive' }));
    _eq_('three distinct reports, three emails', SENT.length, 3);
  },

  /* The route's answer to the client never changes. A reporter is told "filed" either way — which is
     exactly why the fallback has to be loud on Sky's side. */
  'the reporter is told it went through, in both worlds': function () {
    reset();
    const m = M();
    _eq_('ok when Core took it', m.handleBugReport_(MIKE), { ok: true });
    reset({ core: 'down' });
    _eq_('ok when Core did not', M().handleBugReport_(MIKE), { ok: true });
  },

};

run('bug mail fallback', tests);
