#!/bin/sh
# ─── gx-preflight — refuse to ship dev leftovers ────────────────────────────────────────────────
# Source of truth: greencross-gx-theme/gx-preflight.sh. Synced into spokes by gx-sync.sh, which also
# installs it as .git/hooks/pre-push. Run it by hand any time:  ./gx-preflight.sh
#
# The local-live loop is fast because the working tree IS the app. Its one hazard is that a thing you
# flipped to iterate — fixtures on, writes armed, an A/B flag, a localhost URL — rides along to Pages
# and staff get it. This blocks the push instead of relying on you to remember.
#
# Tag any deliberately temporary block with  @devonly  and preflight will refuse to ship it:
#     if (params.get('chart') === 'cached') { ... }   // @devonly A/B — strip before shipping
set -eu
cd "$(dirname "$0")"

APP="performance"
FAIL=0

# ── SELF-HEAL: sweep this repo's orphaned preflight worktrees ────────────────────────────────────
# 20 of these were found across the suite on 2026-09-09 — ~80MB, oldest 2026-08-29 — left by this
# script and theme-preflight.sh. Both create a sibling worktree to test HEAD and remove it in a trap,
# but a run killed outright (a canceled push, a closed terminal) never reaches the trap. Left alone
# they accumulate in the parent folder, sync to every machine over Dropbox, and get picked up by any
# grep across the suite — one of them polluted a dependency audit before anyone noticed.
#
# Sweeping at START rather than only trusting cleanup at END is what makes this self-correcting. It
# is why the hub's run-tests.sh has had zero .gxruntests-* orphans since it adopted the same fix on
# 2026-08-30, while these two scripts kept accumulating them for eleven days.
#
# TWO GUARDS run-tests.sh DOES NOT NEED, AND THIS SCRIPT DOES. That one is hub-only, so its blind
# `../.gxruntests-*` glob can only ever match worktrees it made itself. This script is synced into
# SEVEN repos that push concurrently:
#   • SCOPE TO THIS REPO'S PREFIX. A bare ../.gxpreflight-* glob would let a sales push delete the
#     worktree a crew push is running its tests inside — turning the self-heal into the outage.
#   • SKIP A LIVE PID. The suffix is $$. If that process still exists, a concurrent preflight in
#     THIS repo owns the worktree. A recycled pid only means a dead one survives to the next run,
#     which is the safe direction to be wrong in.
_mine="../.gxpreflight-$(basename "$PWD")-"
git worktree prune >/dev/null 2>&1 || true
for _stale in "$_mine"*; do
  [ -d "$_stale" ] || continue
  if kill -0 "${_stale##*-}" 2>/dev/null; then continue; fi   # a concurrent preflight owns it
  git worktree remove --force "$_stale" >/dev/null 2>&1 || true
  if [ -d "$_stale" ]; then rm -rf "$_stale"; fi
done
git worktree prune >/dev/null 2>&1 || true
# Files we ship. Exclude the shared tooling, which legitimately contains these words.
# serve.js joins serve.py here for the same reason: both print a localhost URL on startup, which the
# hard 'localhost URL in shipped code' check below would otherwise fail. spiff shipped serve.js with
# the scheme deliberately OMITTED to avoid needing --no-verify (which switches off every other check
# with it) and left an instruction to restore it once exempted. Adding it here is that exemption.
#
# NOTE '*.gs'. Until 2026-08-29 this glob was html/js/css only, so Apps Script backends — where every
# spoke keeps its credentials and its POS plumbing — were invisible to EVERY check below.
FILES="$(git ls-files '*.html' '*.js' '*.css' '*.gs' 2>/dev/null | grep -vE '^(gx-dev\.js|gx-preflight\.sh|serve\.py|serve\.js)$' || true)"
[ -n "$FILES" ] || { echo "preflight: no shipped files found — skipping."; exit 0; }

# flag <severity> <label> <grep-pattern> [keep-comments]
# Comment-only lines are dropped unless the 4th arg is "comments" — otherwise prose ABOUT a hazard
# ("// USE_FIXTURES = true reads fixtures") trips the check, and a hook that cries wolf on a clean
# tree gets --no-verify'd within a day, which defeats the whole point. The @devonly check is the one
# that deliberately wants comments.
# -a KEEPS THE DIAGNOSTICS, and that is the whole of the claim. If a shipped file contains a NUL
# byte, grep may classify it as binary and collapse every match to the single line
# "Binary file <name> matches" — no path, no line number, no offending text.
#
# WHAT THAT DOES AND DOES NOT DO, measured 2026-09-09 rather than reasoned, because two sessions
# (mine included) got this wrong in both directions first:
#   • It does NOT disable the gate. `hits` is still non-empty, so a hard check still sets FAIL and
#     still blocks the push. A clean file still passes. Verified with a real `@devonly` leftover in a
#     NUL-bearing file at every position tried: CAUGHT every time.
#   • It DOES destroy the report. You are told the push is blocked and given a filename with no line
#     and no matching text, on a file grep has decided it cannot quote — which on a 240KB proxy is a
#     blocked push nobody can act on.
#
# POSITION MATTERS AND NOTHING CHOOSES IT. /usr/bin/grep (BSD, what this hook gets under /bin/sh)
# classifies from the FIRST BLOCK only. Minimal pair, identical size and token, NUL position the only
# difference:  byte 1 -> "Binary file early.gs matches" · byte 312000 -> "late.gs:6002:@devonly".
# greencross-sales carried two NULs at offset 196535 (a '\0' delimiter written as a literal byte,
# commit edc075d) and its hook read the file normally — purely because they landed late.
#
# The agent-facing `grep` is a shell function wrapping ugrep, which scans the WHOLE file and behaves
# differently again. So a measurement taken at an interactive prompt does not describe this hook.
# -a removes the whole question: never classify a shipped source file as binary.
flag() {
  hits="$(grep -aHnE "$3" $FILES 2>/dev/null || true)"  # -a: see above — a NUL must not cost the
                                                       #     file:line report a blocked push needs
                                                       # -H: grep omits the filename for a SINGLE
                                                       # file, which breaks the comment filter below
  if [ "${4:-}" != "comments" ]; then
    # drop  file:line:<whitespace>(// | * | #)  — i.e. the match sits in a comment, not in code
    hits="$(printf '%s\n' "$hits" | grep -avE '^[^:]*:[0-9]+:[[:space:]]*(//|\*|#)' || true)"
  fi
  [ -n "$hits" ] || return 0
  echo "  ✗ $2"
  printf '%s\n' "$hits" | sed 's/^/      /'
  [ "$1" = "hard" ] && FAIL=1
  return 0
}

echo "gx-preflight ($APP) — checking for dev leftovers…"

flag hard "fixtures left ON — the app would ship reading src/fixtures, not the live backend" \
     'USE_FIXTURES[[:space:]]*=[[:space:]]*true'
flag hard "writes armed in source — dev arming must never be committed" \
     'GXDev\.arm\(\)'
flag hard "@devonly block still present — strip it or make it permanent" \
     '@devonly' comments
flag hard "localhost URL in shipped code" \
     'https?://(localhost|127\.0\.0\.1)'
flag hard "debugger statement" \
     '(^|[^A-Za-z_])debugger[[:space:]]*;'

# ─── CREDENTIALS IN SOURCE ───────────────────────────────────────────────────────────────────────
# Scans EVERY TRACKED FILE, not only the ones we ship. That distinction is the entire point.
#
# On 2026-08-29 the same six LIVE Dutchie POS keys were found at HEAD in two PUBLIC repos
# (sales, leaderboard) and in history in a third (inventory). Preflight had never seen any of them:
# every exposure was in a .gs file and the glob above was html/js/css only. leaderboard/user_admin.gs
# was additionally .claspignore'd — never deployed, never tested, never scanned — and sat readable
# for 101 days. A 2026-06-02 "redact plaintext credentials" pass greped the one file it remembered
# and left the copy behind.
#
# GitHub secret scanning does not cover this shape either: a Dutchie key is a bare 32-hex string
# with no provider prefix, so it matches only under "non-provider patterns", which was off.
#
# Mark a genuine false positive with  @notasecret  on the same line.
_secrets="$(python3 - <<'PYEOF'
import re, subprocess, os
try:
    files = [f for f in subprocess.run(['git','ls-files'], capture_output=True, text=True).stdout.split(chr(10)) if f]
except Exception:
    raise SystemExit(0)
SKIP = {'gx-preflight.sh'}
# Vendored third-party bundles. A minified library is full of 32-hex runs that are not secrets --
# vendor/xlsx@0.18.5/xlsx.full.min.js in gx-theme produces three -- and a scan that cries wolf on
# code nobody wrote gets switched off, which is worse than not having it. Narrow on purpose: it skips
# vendor/ and .min.js, NOT whole file types, so a real key in real source is still caught.
#
# NO LONE APOSTROPHES ANYWHERE IN THIS HEREDOC. It sits inside a command substitution, and the shell
# scans that for the matching paren while tracking quotes -- so a single unbalanced quote character
# in a PYTHON COMMENT desyncs it and the whole gate dies with "unexpected EOF while looking for
# matching )". Cost twenty minutes on 2026-08-29, twice: once in a comment about the vendor skip, and
# again in the comment warning about it. Write "does not", never the contraction or the possessive.
def vendored(p):
    parts = p.split('/')
    return 'vendor' in parts or 'vendors' in parts or 'third_party' in parts or p.endswith('.min.js')
HEX32 = re.compile(r'\b[0-9a-f]{32}\b')
Q = chr(39) + chr(34)
ASSIGN = re.compile(r'(?i)(api[_-]?key|secret|token|password|passwd|credential)\s*[:=]\s*[' + Q + r']([A-Za-z0-9_\-]{20,})[' + Q + r']')
def randomish(v):
    return any(c.isdigit() for c in v) and any(c.islower() for c in v)
out = []
for f in files:
    if f in SKIP or vendored(f) or not os.path.isfile(f):
        continue
    try:
        txt = open(f, encoding='utf-8', errors='ignore').read()
    except Exception:
        continue
    if chr(0) in txt[:4096]:
        continue
    for n, line in enumerate(txt.split(chr(10)), 1):
        if '@notasecret' in line:
            continue
        if HEX32.search(line):
            out.append(f + ':' + str(n) + ': 32-hex literal (Dutchie POS key shape)')
            continue
        m = ASSIGN.search(line)
        if m and randomish(m.group(2)):
            out.append(f + ':' + str(n) + ': ' + m.group(1) + ' assigned a literal secret')
print(chr(10).join(out[:40]))
PYEOF
)"
if [ -n "$_secrets" ]; then
  echo "  ✗ credential literal in a tracked file — rotate it, then move it to Script Properties:"
  printf '%s\n' "$_secrets" | sed 's/^/      /'
  FAIL=1
else
  echo "  ✓ no credential literals in tracked files"
fi

# AMERICAN ENGLISH, on the lines this push ADDS. Sky's standing rule, and it was broken on 2026-09-07
# by a session that had the rule loaded in front of it the whole time — so it gets a gate like every
# other property here that has to stay true. Added lines only: existing text is a NAME as often as it
# is prose, and renaming names for a spelling breaks things. See gx-usenglish.sh for the word list and
# why it is deliberately short.
if [ -x ./gx-usenglish.sh ]; then
  if ./gx-usenglish.sh; then
    echo "  ✓ American English on added lines"
  else
    FAIL=1
  fi
fi

# Cache-buster: if the app JS changed but ?v=NN did not, staff keep the cached old file.
# Same MAJOR.MINOR-aware pattern as deploy.sh — keep the two in step. Not a live bug here (only the
# filename is used, via ${JS%%\?*}, so a truncated version was never read), but two copies of one
# pattern drifting apart is how the deploy.sh version bug survived unnoticed in the first place.
JS="$(grep -ohE '[A-Za-z0-9_.-]+\.js\?v=[0-9]+(\.[0-9]+)?' index.html 2>/dev/null | head -1 || true)"
if [ -n "$JS" ]; then
  NAME="${JS%%\?*}"
  if git diff --quiet HEAD -- index.html 2>/dev/null; then :; else
    if git diff HEAD -- index.html 2>/dev/null | grep -q '\?v='; then :; else
      if ! git diff --quiet HEAD -- "$NAME" 2>/dev/null; then
        echo "  ⚠ $NAME changed but the ?v= cache-buster in index.html did not — staff may keep the stale file."
      fi
    fi
  fi
fi

# 6. REFERENCED-BUT-UNTRACKED LOCAL ASSETS. Proposed by the Leaderboard chat after my GXDev wiring
#    shipped in their v1.506: index.html carried <script src="gx-dev.js"> while gx-dev.js itself was
#    still untracked, so every kiosk load 404ed. Inert, because the call site was guarded -- but a
#    failed request on every page view, and preflight passed clean because it looked for none of this.
#    The general rule: any same-origin relative src=/href= must be a file git actually tracks.
_missing="$(python3 - <<'PY'
import re, subprocess, os, sys
try:
    tracked = set(subprocess.run(['git','ls-files'], capture_output=True, text=True).stdout.split('\n'))
except Exception:
    sys.exit(0)
missing = []
for page in [f for f in os.listdir('.') if f.endswith('.html')]:
    if page not in tracked:            # only judge pages we actually ship
        continue
    # Read the COMMITTED page, not the working tree. A pre-push hook must judge what is being PUSHED:
    # the working tree was correct the whole time this rule passed while a half-landed change shipped
    # -- index.html fixed on disk, the fix never committed, and the file it referenced already deleted.
    # Every app 404ed in production with a green preflight.
    try:
        html = subprocess.run(['git','show','HEAD:'+page], capture_output=True, text=True).stdout
    except Exception:
        html = open(page, encoding='utf-8', errors='ignore').read()
    if not html:
        continue
    # Strip HTML comments first. A comment that documents markup is not a shipped reference, and
    # counting it produced a false positive on this very rule -- the bootstrap comment names the tag
    # it replaces, and the scanner read that as a live reference.
    html = re.sub(r'<!--.*?-->', '', html, flags=re.S)
    # Then strip <script> BODIES, keeping each opening tag. A src=/href= written INSIDE JavaScript
    # is a string the browser never resolves as a path. The Leaderboard tests.html asserts on the
    # literal <a href="x"> to test HTML-escaping, and this scanner read that as a shipped reference
    # to a file named 'x' -- blocking every push in that repo for a test fixture.
    # The OPENING TAG survives the strip, so <script src="gx-dev.js"> -- the real v1.506 incident
    # this whole rule exists to catch -- is still caught.
    html = re.sub(r'(<script\b[^>]*>).*?</script>', r'\1', html, flags=re.S|re.I)
    for ref in re.findall(r'(?:src|href)="([^"]+)"', html):
        if re.match(r'(https?:)?//|data:|mailto:|#|/', ref):   # remote, data, anchor, absolute
            continue
        # Skip anything built at RUNTIME by JS rather than written as a static path. These pages
        # embed scripts that concatenate HTML, so a src= inside a template literal or a string
        # join is not a reference the browser ever resolves as written. Built with chr() so no
        # quote character appears in this heredoc -- one inside the enclosing $() breaks the
        # shell parse of the whole script.
        BAD = set(chr(36) + chr(123) + chr(125) + chr(43) + chr(96) + chr(60) + chr(62) + chr(32))
        BAD.add(chr(39)); BAD.add(chr(34))
        if any(c in ref for c in BAD):
            continue
        path = ref.split('?')[0].split('#')[0]
        # A __PLACEHOLDER__ is a scaffold slot, not a filename. gx-app-template.html ships
        # <script src="__APP_JS__?v=1"> and gx-sync.sh substitutes the real JS filename for each
        # repo out of .gx_app -- so no browser ever requests the literal. NO APOSTROPHES IN HERE:
        # this heredoc sits inside an enclosing $(), where a lone quote breaks the shell parse of
        # the entire script, which is why the block below spells its quotes with chr(). Left unhandled
        # this blocked EVERY push in this repo, on a line that was correct, which is the one way a
        # gate reliably gets bypassed with --no-verify. Found 2026-09-08 while fixing the same
        # defect shape in gx-usenglish.sh: a pattern matched more than the thing it named.
        if re.fullmatch(r'__[A-Z0-9_]+__', path):
            continue
        if not path or path in tracked or os.path.isdir(path):
            continue
        missing.append(page + ' -> ' + path)
print('\n'.join(sorted(set(missing))))
PY
)"
if [ -n "$_missing" ]; then
  echo "  ✗ shipped HTML references local files git does not track — these 404 for every user:"
  printf '%s\n' "$_missing" | sed 's/^/      /'
  FAIL=1
else
  echo "  ✓ every local asset referenced by shipped HTML is tracked"
fi

# ─── Run this repo's tests ───────────────────────────────────────────────────────────────────────
# Everything above catches dev leftovers — things that should not SHIP. This catches things that
# should not WORK. Both belong on the push, for the same reason: a check that only runs when someone
# remembers is a check that stops running.
#
# That is not hypothetical here. On 2026-08-22 a GX Core sales-cache branch was found to have never
# executed once in its life — a TypeError swallowed by a bare catch, with a fallback producing
# identical numbers. Nothing failed, nothing logged, and it was found by accident. The suite had 152
# passing assertions at that moment and not one of them ran on a push.
#
# Convention over configuration: any tests/*_test.js in the repo, run with node. No test dir, no node,
# or no matching files -> silently fine, so this is safe in every spoke including the ones with no
# tests yet. A test that FAILS blocks the push exactly like a hard flag does.
# ── JUDGE THE COMMIT, NOT THE DESK ───────────────────────────────────────────────────────────────
# These tests used to run against the working tree. A pre-push hook that does that is answering the
# wrong question: it tells you your DESK is healthy, when what is about to reach everyone else is
# HEAD. The two differ constantly here, because every repo sits dirty for long stretches.
#
# It cost something on 2026-08-29. In greencross-crew, a session staged a test file while its
# implementation was still unstaged, and a second session's `git commit` swept the shared index.
# Commit 69b4150 carried the test and not the code: checked out clean it failed two of its own
# tests, while the working tree passed all twelve. The hook would have waved it straight through.
#
# The rule already existed twenty lines up — the missing-asset check reads `git show HEAD:page`
# precisely because a half-landed change once 404ed every app with a green preflight. The test run
# just never followed it.
#
# So: if the tree is dirty, run the suites inside a throwaway worktree checked out at HEAD.
#   • A CLEAN tree needs no worktree — HEAD and the tree are the same bytes. Most pushes skip this.
#   • The worktree is a SIBLING, not /tmp. The cross-app suites reach ../greencross-<app>, and a
#     worktree under /tmp resolves that to nothing and turns a real contract test into a silent skip.
#   • If the worktree cannot be made, tests still run — against the tree — and SAY SO. Degrading
#     quietly to the weaker check is how this hole stayed open in the first place.
if [ -d tests ]; then
  if command -v node >/dev/null 2>&1; then
    _rundir="."
    _wt=""
    _scope="working tree"
    if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
      _sha="$(git rev-parse HEAD 2>/dev/null || true)"
      _wt="../.gxpreflight-$(basename "$PWD")-$$"
      if [ -n "$_sha" ] && git worktree add --detach "$_wt" "$_sha" >/dev/null 2>&1; then
        _rundir="$_wt"
        _scope="HEAD $(printf '%s' "$_sha" | cut -c1-8) — your tree is dirty, so this is what a push actually sends"
        # Remove it however we leave, including the exit 1 below.
        trap 'git worktree remove --force "$_wt" >/dev/null 2>&1 || true' EXIT INT TERM
      else
        _wt=""
        echo "  ! could not create a worktree at HEAD — tests ran against the WORKING TREE, which is"
        echo "    NOT what is being pushed. Treat a pass here as unproven."
      fi
    fi
    # List from wherever we are actually running: the commit may add or remove test files.
    _tests="$(cd "$_rundir" && ls tests/*_test.js 2>/dev/null || true)"
    if [ -n "$_tests" ]; then
      echo "  tests run against: $_scope"
      _tfail=""
      for t in $_tests; do
        if _out="$(cd "$_rundir" && node "$t" 2>&1)"; then
          # ── A SUITE THAT SAID NOTHING DID NOT PASS ──────────────────────────────────────────────
          # Exit 0 was the only thing checked here, and a suite can reach it having run nothing at
          # all. Measured in greencross-sales on 2026-09-11: background_refresh_test.js is an async
          # IIFE whose fake timer only fired delays >= 1000ms, while the code under test backs off
          # 700 + random*500. Under 1000 the promise never resolved, the suite hung on its own await,
          # Node exited clean with EMPTY stdout — and this line printed "✓ ... —" with nothing after
          # the dash. Six silent runs in twelve. So roughly half of that repo's pushes were gated on
          # 43 assertions that never ran, and the gate said they had.
          #
          # Deliberately the narrowest rule that closes it: EMPTY output is a failure. Every suite in
          # this suite-of-suites prints something, so this cannot fire on a healthy one — and a
          # stricter rule (demand a recognizable summary line) would block pushes across seven repos
          # over a wording difference, which is how a gate gets --no-verify'd into uselessness.
          if [ -z "$(printf '%s' "$_out" | tr -d '[:space:]')" ]; then
            _tfail="$_tfail $t"
            echo "  ✗ $t PRODUCED NO OUTPUT — exit 0 but nothing ran."
            echo "      A suite that prints nothing has not passed. The usual cause is an async"
            echo "      IIFE that never resolves: node then exits clean and this gate sees success."
          else
            echo "  ✓ $t — $(printf '%s' "$_out" | tail -1)"
            # NO SECOND, SOFTER CHECK HERE. The first cut also warned when the output mentioned no
            # pass/ok — and on its very first run across the suite it fired on
            # greencross-spiff/tests/undefined_calls_test.js, which is entirely healthy and reports
            # "213 call sites checked against 657 bindings — all resolve". A warning that cries on a
            # good suite every push is one people learn to scroll past, and it sat directly above the
            # hard rule that matters. Whether a suite asserts anything is not a question its wording
            # can answer.
          fi
        else
          _tfail="$_tfail $t"
          echo "  ✗ $t FAILED:"
          # Show the failing assertions, not the whole run -- a wall of PASS lines buries the one
          # line that matters and trains people to skim past this block.
          printf '%s\n' "$_out" | grep -E "FAIL|Error|error:|✗" | head -12 | sed 's/^/      /'
          printf '%s\n' "$_out" | tail -1 | sed 's/^/      /'
        fi
      done
      if [ -n "$_tfail" ]; then
        FAIL=1
        [ -n "$_wt" ] && echo "      ^ these ran against HEAD. If they pass on your desk, the fix is"
        [ -n "$_wt" ] && echo "        almost certainly uncommitted — commit it rather than re-running."
      fi
    fi
    if [ -n "$_wt" ]; then
      git worktree remove --force "$_wt" >/dev/null 2>&1 || true
      trap - EXIT INT TERM
    fi
  else
    echo "  ! tests/ exists but node is not on PATH — tests NOT run"
  fi
fi

if [ "$FAIL" = "1" ]; then
  echo ""
  echo "PUSH BLOCKED. Fix the ✗ items above, or bypass deliberately with:  git push --no-verify"
  exit 1
fi
echo "  ✓ clean — safe to ship."
