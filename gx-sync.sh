#!/bin/sh
# ─── gx-sync — pull shared GX spoke files from the gx-theme source of truth ───────────────────────
# Source of truth:  https://github.com/greencrosscanna/greencross-gx-theme  (served via Pages)
# One-time setup per repo:
#     echo <gxkey> > .gx_app      # this app's GX Core key, e.g.  pricecards
#     curl -fsSL https://greencrosscanna.github.io/greencross-gx-theme/gx-sync.sh > gx-sync.sh
#     chmod +x gx-sync.sh
# Then, any time the shared files change upstream:   ./gx-sync.sh
# It updates ITSELF first, so a stale copy can no longer silently skip newly-added shared files.
# It fetches each canonical file and fills __APP__ from .gx_app, so the shared files stay identical
# across every spoke and the app key lives in exactly one place per repo.
set -eu

BASE="https://greencrosscanna.github.io/greencross-gx-theme"
[ -f .gx_app ] || { echo "✗ create .gx_app first (one line = this app's GX key, e.g. pricecards)"; exit 1; }
APP="$(tr -d ' \t\r\n' < .gx_app)"
[ -n "$APP" ] || { echo "✗ .gx_app is empty"; exit 1; }

# fetch <path-under-gx-theme> <local-dest> — copy + substitute __APP__, only on a good fetch
fetch() {
  tmp="$(mktemp)"
  if curl -fsSL "$BASE/$1" | sed "s/__APP__/$APP/g" > "$tmp" && [ -s "$tmp" ]; then
    mkdir -p "$(dirname "$2")"; mv "$tmp" "$2"; echo "  ✓ $2"
  else
    rm -f "$tmp"; echo "  ✗ $1 (skipped — fetch failed, left existing file untouched)"; return 1
  fi
}

# ─── Self-update ────────────────────────────────────────────────────────────────────────────────
# This script used to be the one file that did NOT update itself, so a spoke would happily sync using
# a stale copy and silently skip newly-added shared files. It now fetches itself first.
# The new copy is RUN FROM A TEMP PATH and only then written over this file -- overwriting a shell
# script while sh is still reading it makes the shell execute whatever bytes now sit at its current
# offset, which is a genuinely nasty way to fail.
if [ "${GX_SYNC_SELFUPDATED:-}" != "1" ]; then
  _new="$(mktemp)"
  if curl -fsSL "$BASE/gx-sync.sh" > "$_new" 2>/dev/null && [ -s "$_new" ] && ! cmp -s "$_new" "$0"; then
    echo "  gx-sync.sh is out of date — updating itself and re-running"
    GX_SYNC_SELFUPDATED=1 sh "$_new" "$@"; _status=$?
    cat "$_new" > "$0" && chmod 755 "$0"
    rm -f "$_new"
    exit $_status
  fi
  rm -f "$_new"
fi

# gx-dev.js is deliberately NOT synced any more: apps load it at runtime from Pages, on localhost
# only (see gx-dev-boot.html). Nothing to commit per repo, so production never requests it and the
# 'referenced a file I never tracked' failure cannot recur.
echo "Syncing shared GX spoke files for app=$APP …"
fetch gx-brain-notes.sh .claude/gx-brain-notes.sh || true
fetch deploy.sh          deploy.sh                 || true
fetch serve.py           serve.py                  || true
fetch gx-preflight.sh    gx-preflight.sh           || true
fetch gxengine.sh        gxengine.sh               || true
# chmod each file individually with an explicit mode. "chmod +x a b c" is subject to umask and skips
# the whole list if it errors early, and mktemp+mv lands these at 0600 -- which silently left deploy.sh
# non-executable in some repos after a sync.
for f in .claude/gx-brain-notes.sh deploy.sh serve.py gx-preflight.sh gxengine.sh; do
  [ -f "$f" ] && chmod 755 "$f" 2>/dev/null || true
done

# Install preflight as a pre-push hook so dev leftovers (fixtures on, writes armed, @devonly blocks,
# localhost URLs) can't reach Pages. Never clobber a hook that already does something else.
if [ -d .git ]; then
  if [ ! -f .git/hooks/pre-push ] || grep -q gx-preflight .git/hooks/pre-push 2>/dev/null; then
    printf '#!/bin/sh\nexec ./gx-preflight.sh\n' > .git/hooks/pre-push
    chmod +x .git/hooks/pre-push
    echo "  + .git/hooks/pre-push -> gx-preflight.sh"
  else
    echo "  . .git/hooks/pre-push is custom - add './gx-preflight.sh' to it yourself"
  fi
fi

# Ensure the SessionStart hook is wired — create a minimal settings.json, never clobber an existing one.
if [ ! -f .claude/settings.json ]; then
  mkdir -p .claude
  cat > .claude/settings.json <<'JSON'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "sh .claude/gx-brain-notes.sh" } ] }
    ]
  }
}
JSON
  echo "  ✓ .claude/settings.json (created)"
else
  echo "  • .claude/settings.json exists — leave it; ensure it runs 'sh .claude/gx-brain-notes.sh' on SessionStart"
fi
echo "Done. (gx-sync.sh keeps itself up to date from here on.)"
