#!/usr/bin/env node
/* NO SOURCE FILE MAY CONTAIN A NUL BYTE — because a NUL can make the PUSH GATE go blind.
 *
 * gx-preflight.sh is the pre-push hook, and its whole job is to refuse a push carrying dev
 * leftovers: fixtures on, writes armed, localhost URLs, and any block carrying the dev-only tag. It
 * finds them with `grep -HnE "$pattern" $FILES` over `git ls-files '*.html' '*.js' '*.css' '*.gs'`.
 *
 * (The dev-only tag is spelled out nowhere in this file on purpose: that rule is declared with
 * `comments` — keep-comments — because the tag lives in comments by design, so even NAMING it here
 * in prose trips the gate. Found by this suite's own first push being blocked, which is the rule
 * working exactly as intended.)
 *
 * grep does not scan a file it decides is BINARY. It prints "Binary file X matches" and moves on, so
 * a leftover in that file is never reported and the gate passes a push it should have blocked. On the
 * all-staff kiosk that means fixture data or armed writes reaching every screen in the company, with
 * the one check designed to stop it reporting success.
 *
 * WHAT MAKES IT INSIDIOUS — the failure is POSITIONAL, and nothing chooses the position.
 * /usr/bin/grep (BSD, which is what /bin/sh finds when the hook runs) classifies from the FIRST BLOCK
 * ONLY. A NUL early in a file blinds grep to the entire file; the identical NUL late in the same file
 * leaves it fully readable. Measured by the Sales session 2026-09-09 on a minimal pair — same file,
 * same size, same byte:
 *
 *     NUL at byte 22      -> "Binary file early.gs matches"    (blind — gate cannot see leftovers)
 *     NUL at byte 260022  -> "late.gs:1:<token>"               (sees it — gate works normally)
 *
 * Sales shipped two raw NULs into its dutchie_proxy.gs (an escape written literally) at byte 196535
 * and got LUCKY: late enough that the gate still worked. Both Sales and core-admin initially reported
 * that the gate HAD been disarmed, and both were wrong — they tested with the grep a Claude Code
 * session runs, which wraps ugrep and refuses a binary file wherever the NUL sits, then reported that
 * as the hook's behavior. The real gate was verified afterwards by running it against the real file
 * with a genuine leftover appended: caught, with line numbers, PUSH BLOCKED.
 *
 * SO THE GENERALIZABLE RULE IS NOT ABOUT NULs: MEASURE A TOOLING CLAIM WITH THE TOOL THAT ACTUALLY
 * RUNS. Same class of error as reading appsscript.json to learn what a deployed app executes.
 *
 * This suite pins the invariant (no NULs) rather than the luck (they were late enough). Lifted from
 * greencross-sales/tests/binary_source_test.js, which found it.
 */
'use strict';
const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0; const fails = [];
function ok(label, cond) { if (cond) pass++; else fails.push(label); }

/* THE SAME FILE SET THE GATE SCANS, derived the same way rather than hardcoded — a list that drifts
   from gx-preflight.sh's would pass while the files it actually greps went unchecked. */
const FILES = execFileSync('git', ['ls-files', '*.html', '*.js', '*.css', '*.gs'], { cwd: ROOT })
  .toString().split('\n').map(s => s.trim()).filter(Boolean);

ok('the gate has files to scan at all', FILES.length > 0);

/* 1. THE INVARIANT. */
const offenders = [];
for (const rel of FILES) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  const at = buf.indexOf(0);
  if (at >= 0) {
    const total = buf.filter(b => b === 0).length;
    offenders.push(`${rel}: ${total} NUL byte(s), first at ${at}` +
      (at < 512 ? '  ← INSIDE THE FIRST BLOCK: the push gate is BLIND to this file' : ''));
  }
}
ok(`no NUL bytes in any of the ${FILES.length} files the push gate greps`, offenders.length === 0);

/* 2. THE MECHANISM, measured with the grep the HOOK runs — not the one this session runs, which is
      the mistake that produced two wrong diagnoses. Skipped rather than guessed if BSD grep is not
      where the hook would find it, because a test that silently substitutes a different tool is the
      exact failure being guarded against. */
const REAL_GREP = '/usr/bin/grep';
if (fs.existsSync(REAL_GREP)) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nulgrep-'));
  /* A NEUTRAL PROBE TOKEN, deliberately not resembling any real leftover marker. It only has to be
     a string grep can find. It used to echo the fixture flag's name, which slipped past that rule
     only because the rule also requires the assignment — but a file that DESCRIBES the gate is a
     file the gate reads, and planting something leftover-shaped inside the suite that protects the
     gate is how you block your own pushes forever once a pattern is broadened.
     NONE OF THE GATE'S PATTERNS ARE QUOTED ANYWHERE IN THIS FILE, for the same reason and the hard
     way: the first version of THIS comment quoted the fixture rule verbatim to explain the rename,
     and the push was blocked by the rule it was quoting. That was the third block in one evening —
     this suite's first push named the dev-only tag in prose, Sales' probe fixture tripped the
     debugger rule, and then this. Describe the rules; never spell them. */
  const token = 'PREFLIGHT_PROBE_ZZQ';
  const body = Buffer.concat([Buffer.from(token + '\n'), Buffer.alloc(300000, 0x61)]);   // 'a' padding
  const early = Buffer.from(body); early[22] = 0;                 // inside the first block
  const late  = Buffer.from(body); late[260022] = 0;              // far past it
  const p = n => path.join(tmp, n);
  fs.writeFileSync(p('early.gs'), early);
  fs.writeFileSync(p('late.gs'), late);
  const grep = f => {
    try { return execFileSync(REAL_GREP, ['-HnE', token, p(f)], { cwd: tmp }).toString(); }
    catch (e) { return String((e.stdout || '') + (e.stderr || '')); }
  };
  const eOut = grep('early.gs'), lOut = grep('late.gs');
  ok('an EARLY NUL makes the real grep refuse the file (gate goes blind)',
     /Binary file/.test(eOut) && !/:1:/.test(eOut));
  ok('a LATE NUL does not — same byte, same size, only the position differs',
     /early|late/.test(lOut) && /:1:/.test(lOut));
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('  (skipped the mechanism check — ' + REAL_GREP + ' not present; the invariant above still holds)');
}

if (fails.length) {
  console.error('❌ binary source ' + fails.length + ' FAILED (' + pass + ' passed)');
  fails.forEach(f => console.error('  ✗ ' + f));
  offenders.forEach(o => console.error('    ' + o));
  console.error('  Fix: remove the NUL bytes. Until you do, the pre-push gate may not be reading');
  console.error('  that file at all — it will report success while leftovers ship.');
  process.exit(1);
}
console.log('✅ binary source ALL PASS (' + pass + '/' + pass + ')');
