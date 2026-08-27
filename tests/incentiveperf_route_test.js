// ============================================================
//  dutchie_proxy.gs — the incentiveperf route (GX Crew's read)
//
//  Run:  node tests/incentiveperf_route_test.js
//
//  WHY THIS EXISTS
//  `incentiveperf` hands GX Crew the per-employee performance slice behind the Incentive
//  dashboard, which Crew is taking over as the payout app (2026-08-26). Everything asserted
//  here failed silently the first time it was written, or would pay somebody wrongly if it
//  regressed — and none of it shows up as an error at the call site.
//
//  These are SOURCE assertions rather than behavioural ones. The route's body is three lines
//  of property lookup around getIncentiveData_, which is covered by endpoints_test; what is
//  worth pinning is its PLACEMENT and its SHAPE, and both are structural facts about the file.
// ============================================================

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../dutchie_proxy.gs', 'utf8');

let fail = 0;
function ok(label, cond) {
  if (cond) console.log('  ✓ ' + label);
  else { fail++; console.log('  ✗ ' + label); }
}

const routeAt = src.indexOf("params.action === 'incentiveperf'");
const authAt  = src.indexOf('const auth = requireAuth_(params);');

ok('the route exists', routeAt > -1);
ok('requireAuth_ chokepoint still exists (this test is meaningless without it)', authAt > -1);

/* THE BUG THIS TEST WAS WRITTEN FOR. Everything below `const auth = requireAuth_(params)` is
   rejected as "not signed in" before it is reached. A machine caller carrying a deploy secret
   and no session therefore gets an auth error from a route that authorises itself perfectly
   well — and the error names the wrong problem, so the hunt starts in the wrong repo.
   publishgoals sits above the line for exactly this reason. */
ok('sits ABOVE the requireAuth_ chokepoint — a secret-only caller has no session',
   routeAt > -1 && authAt > -1 && routeAt < authAt);

const body = src.slice(routeAt, src.indexOf('\n    }', routeAt));

ok('gated on GX_DEPLOY_SECRET', /GX_DEPLOY_SECRET/.test(body));
ok('refuses when the secret is unset rather than defaulting open',
   /if \(!_ipSecret\) return jsonOut\(\{ ok: false/.test(body));
ok('compares the supplied secret and refuses a mismatch',
   /params\.secret \|\| ''\) !== _ipSecret/.test(body));

/* A COMPLETED PAY PERIOD IS FROZEN — computed once, cached forever, because those numbers paid
   people. getIncentiveData_ ignores forceRefresh for closed periods today, but the guarantee
   should not rest on a caller's good manners plus a check in another file: the parameter is
   simply never forwarded, so Crew CANNOT ask for a recompute even by accident. */
ok('never forwards a refresh — Crew cannot trigger a recompute of frozen history',
   /getIncentiveData_\(params\.ppStart, false\)/.test(body));
ok('does not read params.refresh at all', !/params\.refresh/.test(body));

/* Crew owns the payout state (attendance, SPIFF, thresholds, the Capstone export). If this
   route ever grew a save twin, one pay period would have two writers and no way to tell which
   copy paid people — the exact drift the roster move was undertaken to end. */
ok('is read-only — no save twin on this route',
   !/saveIncentiveInputs_|saveincentive/i.test(body));

/* The write chokepoint is an allowlist of WRITES, maintained because misclassifying a read as a
   write blanks a board at open. A read must stay off it. */
const writeList = src.match(/var GX_WRITE_ACTIONS = \[[\s\S]*?\];/);
ok('not on the write allowlist (it is a read)',
   !writeList || !/incentiveperf/.test(writeList[0]));

/* Says where the numbers came from. A Crew payload that cannot name its source is one nobody
   can trace back when a figure is disputed — and disputes about these figures are about pay. */
ok('stamps the payload with its source', /_ipData\.source = 'leaderboard'/.test(body));

/* This route is app-to-app, which the shared brain forbids; it exists because promoting the
   slice into GX Core needs a library cut Crew cannot wait for. The comment saying so is the
   only thing standing between "temporary" and "permanent", so it is pinned too. */
const preamble = src.slice(Math.max(0, routeAt - 2000), routeAt);
ok('carries the note that it is temporary and names its removal condition',
   /TEMPORARY/.test(preamble) && /DELETE THIS ROUTE/.test(preamble));

console.log(fail ? '\n' + fail + ' FAILED' : '\nincentiveperf route: all passed');
process.exit(fail ? 1 : 0);
