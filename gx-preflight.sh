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
  hits="$(grep -HnE "$3" $FILES 2>/dev/null || true)"   # -H: grep omits the filename for a SINGLE
                                                       # file, which breaks the comment filter below
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

if [ "$FAIL" = "1" ]; then
  echo ""
  echo "PUSH BLOCKED. Fix the ✗ items above, or bypass deliberately with:  git push --no-verify"
  exit 1
fi
echo "  ✓ clean — safe to ship."
