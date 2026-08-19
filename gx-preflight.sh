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
# Files we ship. Exclude the shared tooling, which legitimately contains these words.
FILES="$(git ls-files '*.html' '*.js' '*.css' 2>/dev/null | grep -vE '^(gx-dev\.js|gx-preflight\.sh|serve\.py)$' || true)"
[ -n "$FILES" ] || { echo "preflight: no shipped files found — skipping."; exit 0; }

# flag <severity> <label> <grep-pattern> [keep-comments]
# Comment-only lines are dropped unless the 4th arg is "comments" — otherwise prose ABOUT a hazard
# ("// USE_FIXTURES = true reads fixtures") trips the check, and a hook that cries wolf on a clean
# tree gets --no-verify'd within a day, which defeats the whole point. The @devonly check is the one
# that deliberately wants comments.
flag() {
  hits="$(grep -nE "$3" $FILES 2>/dev/null || true)"
  if [ "${4:-}" != "comments" ]; then
    # drop  file:line:<whitespace>(// | * | #)  — i.e. the match sits in a comment, not in code
    hits="$(printf '%s\n' "$hits" | grep -vE '^[^:]*:[0-9]+:[[:space:]]*(//|\*|#)' || true)"
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

# Cache-buster: if the app JS changed but ?v=NN did not, staff keep the cached old file.
JS="$(grep -ohE '[A-Za-z0-9_.-]+\.js\?v=[0-9]+' index.html 2>/dev/null | head -1 || true)"
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

if [ "$FAIL" = "1" ]; then
  echo ""
  echo "PUSH BLOCKED. Fix the ✗ items above, or bypass deliberately with:  git push --no-verify"
  exit 1
fi
echo "  ✓ clean — safe to ship."
