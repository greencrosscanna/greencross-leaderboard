#!/usr/bin/env node
/* ─── every call from this app says it is `performance` ──────────────────────────────────────────
 *   RUN:  node tests/app_attribution_test.js   (also run by ./gx-preflight.sh)
 *
 * WHY THIS EXISTS
 * GX Core's execution-load panel ranks apps by share of execution time against Google's 30-at-once
 * per-account ceiling. On 2026-09-16, its first day carrying real traffic, it read **80.6% of
 * execution time as "Not attributed"** — 653 of 870 calls arrived with no app name. The ranking
 * underneath was therefore sorting only the fifth that volunteered one, and could not answer the
 * question it was built for: whether this app should move to its own Google account.
 *
 * THIS APP IS THE LIKELIEST BULK OF THAT 653. Six wall screens rotate stores all day, and every
 * board is a fresh mount. gx-client.js now stamps calls from its `<script data-app>` — but the
 * kiosk does not route through gx-client. The board, ticker and badge calls all go through the
 * LOCAL jsonp() in index.html. So the shared fix reaches every app except the busiest caller.
 *
 * Tagging one path and not the other is the failure this file exists to prevent: the panel would
 * look fixed — unattributed falling as the other five apps reported in — while still being blind to
 * the one app the decision is about. That is worse than a visibly broken number, because a number
 * that looks repaired stops being questioned.
 *
 * THE KEY IS `performance`, NOT `leaderboard`. The repo is greencross-leaderboard; the app key is
 * performance. Nothing in the suite derives one from the other, and §3 pins that this file does not
 * start.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

function lift(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name + ' — renamed or removed');
  let depth = 0, seen = false, i = start;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') { depth++; seen = true; }
    else if (SRC[i] === '}') { depth--; if (seen && depth === 0) { i++; break; } }
  }
  return SRC.slice(start, i);
}
const APP_KEY = (SRC.match(/var\s+APP_KEY\s*=\s*'([^']+)'/) || [])[1];

console.log('\n1. THE INCIDENT: a kiosk call carries the app, without the call site saying so');
{
  /* Drives the REAL jsonp() with a fake <script> element, so what is asserted is the URL the browser
     would actually request. A stub of the query builder would assert the stub. */
  const built = [];
  const fakeDoc = {
    createElement: () => ({ set src(v) { built.push(v); }, get src() { return built[built.length - 1]; },
                            remove() {}, onerror: null, id: '' }),
    getElementById: () => null,
    head: { appendChild() {} }, body: { appendChild() {} },
  };
  const jsonp = new Function('document', 'window', 'setTimeout', 'clearTimeout', 'APP_KEY',
    'var _cbIndex = 0; var GC = { DISCOUNT_TARGET: null };\n' + lift('jsonp') + '\n; return jsonp;'
  )(fakeDoc, {}, () => 0, () => {}, APP_KEY);

  jsonp('https://exec.test/x', { store: 'river-rd', period: 'week' });
  const u = new URL(built[0]);
  ok(u.searchParams.get('app') === 'performance',
     'a board call is attributed to performance (got ' + u.searchParams.get('app') + ')');
  ok(u.searchParams.get('store') === 'river-rd', 'and the call still carries what it came for');
  ok(u.searchParams.get('callback') !== null, 'and its callback, so the JSONP contract is intact');

  built.length = 0;
  jsonp('https://exec.test/x', { store: 'river-rd', app: 'inventory' });
  ok(new URL(built[0]).searchParams.get('app') === 'inventory',
     'an explicit app still wins — a call on another app\'s behalf keeps saying so');
}

console.log('\n2. the SHARED client is tagged too — both paths, or the panel lies by looking fixed');
{
  const tag = SRC.match(/<script src="[^"]*gx-client\.js"[^>]*>/);
  ok(!!tag, 'the page loads gx-client.js');
  ok(/data-app="performance"/.test(tag[0]),
     'and declares itself to it (' + (tag ? tag[0].slice(-40) : '') + ')');
}

console.log('\n3. the key is `performance`, and it is never guessed from the repo name');
{
  ok(APP_KEY === 'performance', 'APP_KEY is performance, not leaderboard');
  const decl = SRC.slice(SRC.indexOf('THIS APP\'S KEY IN GX CORE'), SRC.indexOf('var APP_KEY'));
  // \s+ not a space: the phrase wraps across a comment line, and the assertion is about the wording
  // being there, not about where the line happens to break.
  ok(/not\s+derivable/i.test(decl), 'and the comment says why it cannot be derived');
  ok(!/location\.(pathname|href)[^\n]*APP_KEY|APP_KEY\s*=\s*[^']*location/.test(SRC),
     'nothing derives the key from the page URL');
}

console.log('\n4. attribution is a label, not a behavior — nothing else moved');
{
  const fn = lift('jsonp');
  ok(/65000/.test(fn), 'the 65s JSONP budget is untouched (a cold GAS cache build needs it)');
  ok(/_attempt < 1/.test(fn), 'and the single script-error retry is untouched');
  ok(/retryDelay_/.test(SRC) && /Math\.random\(\) \* 30000/.test(SRC),
     'the randomized 30-60s kiosk retry spread is still there — tightening it is a documented outage');
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' + (pass + fail) : '✅ app attribution ALL PASS (' + pass + '/' + pass + ')'));
process.exit(fail ? 1 : 0);
