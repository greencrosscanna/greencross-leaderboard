#!/usr/bin/env node
/* ─── every way an engine SAYS something must scrub credentials on the way out ────────────────────
 *   RUN:  node tests/exit_scrub_test.js          (synced from greencross-gx-theme/gx-exit-scrub-test.js)
 *
 * WHY THIS IS SHARED AND NOT PER-APP. On 2026-09-17 four apps were audited by hand, one session each,
 * and every one of them had an exit nobody had counted:
 *
 *   crew        7 MailApp.sendEmail sites, exactly ONE scrubbed — the unfiled-bug notice, the send
 *               somebody had actually looked at. Plus two Script Properties holding an un-scrubbed
 *               stringified result, one of which a health check folds into a reason that a weekly
 *               recap renders into an email.
 *   sales       1 mail site, 0 scrubbed, carrying GX Core's error text verbatim.
 *   spiff       1 mail site, 0 scrubbed, plus a stored error field with no reader TODAY.
 *   pricecards  3 mail sites; the two digest sends carry no error text at all, so their lack of a
 *               scrub is correct rather than missed — and the third rendered the browser's page
 *               address and captured JS errors raw while scrubbing the server's own line.
 *
 * NONE OF THAT WAS A MISSING SCRUB FUNCTION. Crew HAD a correct, derived, tested scrub and still had
 * six unscrubbed sends. The missing piece was never shared code — it was that a scrub at one exit
 * says nothing about a second exit. So this test does not check that a scrub EXISTS. It finds every
 * place an engine emits something and asks whether THAT ONE scrubs.
 *
 * The seventh app is the point. Each of those four was found by a person looking; whichever app
 * nobody looked at would still be leaking, and the next exit added to any of them would not be found
 * at all. A test is what makes it not depend on somebody looking.
 *
 * ── WHAT COUNTS AS AN EXIT ──────────────────────────────────────────────────────────────────────
 * ContentService.createTextOutput (what a route says back) and MailApp/GmailApp.sendEmail (what it
 * mails). Those are the two that carried real credentials this week.
 *
 * NOT stored values, deliberately, and this is the known gap: crew's Script Property held an
 * un-scrubbed error for weeks with no reader, until it turned out to have one. A store is only a
 * leak when something reads it back out, and that read is usually one of the exits above — so this
 * catches the escape and not the accumulation. Scrub at the write anyway; a test cannot see it.
 *
 * ── HOW A CALL SITE PASSES ──────────────────────────────────────────────────────────────────────
 * 1. The function containing it calls something named like a scrub (scrub/redact/sanitize), OR
 * 2. the call site carries an explicit marker saying why it needs none:
 *
 *        /* @gx-exit-ok: only renders queue card fields, no caught exception ever reaches this *​/
 *
 *    A marker REQUIRES a reason. "@gx-exit-ok" alone fails — a silent waiver is how the first
 *    unscrubbed send gets a second one. Price Cards' two digest sends are the case this exists for:
 *    genuinely nothing to scrub, and saying so in the source beats a test that cries wolf twice a day.
 *
 * ── WHAT IT CANNOT DO ───────────────────────────────────────────────────────────────────────────
 * It reads source text. It cannot prove the scrub is applied to the right argument, or that the
 * regex behind it is correct — crew's was anchored and missed connector_secret= for weeks while
 * passing any check of this kind. Each app still needs its own executing test for the scrub itself.
 * This one answers a different question: is there an exit nobody has looked at? That is the question
 * that had four different wrong answers this week.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
/* THE EXIT IS WHERE THE PAYLOAD GOES, NOT WHERE THE ENVELOPE IS MADE.
 *
 * `ContentService.createTextOutput()` with EMPTY parentheses emits nothing — it mints an empty
 * output that something fills later with `.setContent(...)`. Sales builds most of its replies that
 * way, and the first version of this test reported all fifteen of them as unscrubbed. They are not:
 * the content goes through setReply_, which scrubs. Fifteen false positives in the app that had just
 * shipped a real fix is precisely how a test gets switched off, so the pattern has to follow the
 * data rather than the constructor. */
/* DO NOT REQUIRE `ContentService` ON THE SAME LINE. The first version matched
 * /ContentService\s*\.\s*createTextOutput\s*\(/ and greencross-leaderboard wraps it:
 *
 *     return ContentService
 *       .createTextOutput(callback + '(' + json + ')')
 *
 * so its ONLY reply builder was never counted, and the test reported "0 unaccounted" for replies
 * while never having looked at one. Caught by the leaderboard session, which did not trust the pass
 * and went looking by hand — and found two unscrubbed reply exits returning a GX Core exception that
 * carries the deploy secret in its URL.
 *
 * That is the same failure as the anchored-scrub regex this file's header already describes, and the
 * same as the green gates the hub's CLAUDE.md warns about: a pattern that quietly excludes the
 * commonest case, reporting success while testing nothing. Twice in one file is the argument for
 * running a new test against every real engine and then disbelieving the passes. */
const EXITS = [
  { kind: 'reply', re: /\.\s*createTextOutput\s*\(\s*[^)\s]/ },
  { kind: 'reply', re: /\.\s*setContent\s*\(\s*[^)\s]/ },
  { kind: 'mail', re: /\b(?:MailApp|GmailApp)\s*\.\s*sendEmail\s*\(/ },
];
/* NOT ANCHORED BEFORE THE KEYWORD, and this file got it wrong first time round in the exact shape it
   was written to catch. The original was /\b[A-Za-z_$][\w$]*(?:scrub|redact|sanitiz)…/ — one
   character of prefix REQUIRED — so `scrubSecrets_(`, where the word starts the identifier, never
   matched, and the test reported crew's single scrubbing reply builder as unscrubbed. That is
   Crew's own connector_secret bug, reproduced by the test for it: an anchor that quietly excludes
   the commonest case. Both sides wildcarded now. */
const SCRUBBY = /\b[\w$]*(?:scrub|redact|sanitiz)[\w$]*\s*\(/i;
const MARKER = /@gx-exit-ok\s*:\s*\S/;
const MARKER_BARE = /@gx-exit-ok/;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };

function engineSources() {
  const out = [];
  for (const dir of [REPO, path.join(REPO, 'apps-script')]) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (e) { continue; }
    for (const name of entries) {
      if (name.endsWith('.gs')) out.push(path.join(dir, name));
    }
  }
  return out;
}

/* The enclosing top-level function, and its body text.
   Apps Script files are flat — top-level `function name(` at column 0 — so brace-matching from the
   declaration to the matching close is enough, and it is what the other suites in this repo do. */
function enclosing(lines, idx) {
  for (let i = idx; i >= 0; i--) {
    const m = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]);
    if (m) {
      let depth = 0, started = false, end = i;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') depth--;
        }
        end = j;
        if (started && depth <= 0) break;
      }
      if (end >= idx) return { name: m[1], body: lines.slice(i, end + 1).join('\n') };
      return null;                       // the call site is past this function's close: top-level code
    }
  }
  return null;
}

const sources = engineSources();
console.log('exit scrub — every reply and every mail leaves through a scrub\n');

if (!sources.length) {
  console.log('  no .gs engine in this repo — nothing to check');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

const findings = [];
const byKind = { reply: new Set(), mail: new Set() };

for (const file of sources) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;   // a mention in prose
    for (const exit of EXITS) {
      if (!exit.re.test(line)) continue;
      const where = `${path.relative(REPO, file)}:${i + 1}`;
      const context = lines.slice(Math.max(0, i - 3), i + 2).join('\n');
      const fn = enclosing(lines, i);
      if (fn) byKind[exit.kind].add(fn.name);
      if (MARKER.test(context)) return;                       // waived, with a reason
      if (MARKER_BARE.test(context)) {
        findings.push(`${where} — @gx-exit-ok with no reason after it; a silent waiver is not a waiver`);
        return;
      }
      if (fn && SCRUBBY.test(fn.body)) return;                // the enclosing function scrubs
      findings.push(`${where} — ${exit.kind} exit in ${fn ? fn.name + '()' : 'top-level code'} with no scrub and no @gx-exit-ok reason`);
    }
  });
}

ok(findings.length === 0, `every exit scrubs or says why it need not (${findings.length} unaccounted)`);
findings.forEach(f => console.log('        ' + f));

/* ONE MAIL EXIT, NOT SEVEN. Crew's fix was not a better scrub, it was routing every send through a
   single sendMail_ — the same argument as a single reply builder. Seven sends means six that nobody
   audited when the seventh was fixed. This is a WARNING rather than a failure: an app may have a
   defensible second one, and a test that fails on a judgement call gets switched off. */
if (byKind.mail.size > 1) {
  console.log(`\n  NOTE  ${byKind.mail.size} functions send mail (${[...byKind.mail].join(', ')}).`);
  console.log('        One exit per kind is the shape that survives the next edit — crew had seven and');
  console.log('        exactly one was scrubbed, because only one had ever been looked at.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
