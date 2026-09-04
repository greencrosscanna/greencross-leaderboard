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
# A spoke may legitimately need its own version of a shared file. Leaderboard's deploy.sh is a full
# pipeline -- clasp push, its own DEPLOY_ID, watch_deploy.sh -- while the shared deploy.sh is only a
# version RECORDER. Syncing it there does not update that app, it removes its ability to deploy at all,
# and it did exactly that twice on 2026-08-22 before anyone noticed.
#
# Opt out by putting this marker anywhere in the local file:
#     # gx-sync:keep-local  <why>
# The marker lives IN the file rather than in a side list, so it travels with it, is visible to whoever
# opens it, and cannot drift out of step with the thing it protects.
fetch() {
  if [ -f "$2" ] && grep -q 'gx-sync:keep-local' "$2" 2>/dev/null; then
    echo "  • $2 (kept local — marked gx-sync:keep-local)"; return 0
  fi
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
fetch gx-brain-notes.sh    .claude/gx-brain-notes.sh    || true
fetch gx-posttool-tests.sh .claude/gx-posttool-tests.sh || true
fetch deploy.sh          deploy.sh                 || true
fetch serve.py           serve.py                  || true
# serve.js is a SECOND DOOR, not a replacement — serve.py stays and still works from a terminal, from
# CI, from anywhere started by a shell. The managed dev-server launcher is the case it does not cover:
# it spawns as a child of Claude's disclaimer helper, and in that context every APPLE-SIGNED binary is
# denied the whole TCC-protected tree. Measured 2026-09-02 at the same instant on the same launcher:
# /bin/ls BLOCKED, /bin/cat BLOCKED, /usr/bin/python3 BLOCKED, /opt/homebrew/bin/node OK. Not a Dropbox
# problem (Documents and Desktop fail identically) and NOT fixable with Full Disk Access — Sky granted
# it at three levels and restarted, with no change. Do not send anyone round that loop again.
fetch serve.js           serve.js                  || true
fetch gx-preflight.sh    gx-preflight.sh           || true
fetch gxengine.sh        gxengine.sh               || true
# chmod each file individually with an explicit mode. "chmod +x a b c" is subject to umask and skips
# the whole list if it errors early, and mktemp+mv lands these at 0600 -- which silently left deploy.sh
# non-executable in some repos after a sync.
# VERIFY, do not assume. On 2026-08-22 gx-preflight.sh, deploy.sh and serve.py came out of a sync at
# 0600 across four repos. It has not reproduced since and the cause is unconfirmed (self-update path?
# Dropbox reverting modes asynchronously?) -- so this does not claim to prevent it, it refuses to let it
# pass silently.
#
# WHAT IT ACTUALLY COSTS, corrected 2026-08-22. The hook is `exec sh ./gx-preflight.sh` -- `sh` READS
# the script, so a 0600 preflight still runs and the guard is never weakened. The earlier claim here
# ("every push fails with Permission denied") described the older `exec ./gx-preflight.sh` form and was
# left behind when that changed; it overstated the danger, which is its own hazard -- it invites you to
# believe a failing push would announce the problem. Nothing announces it.
#
# So the real cost is quiet: `./deploy.sh` refuses by hand, and whoever hits it works around it with
# `bash deploy.sh` and moves on (sales did, 2026-08-22). Every guard that matters is invoked through
# `sh` for exactly this reason -- gx-preflight, theme-preflight and run-tests alike. Keep it that way:
# a hook that depends on a mode bit is a hook this filesystem can switch off without telling you.
_notexec=""
for f in .claude/gx-brain-notes.sh .claude/gx-posttool-tests.sh deploy.sh serve.py serve.js gx-preflight.sh gxengine.sh; do
  [ -f "$f" ] || continue
  chmod 755 "$f" 2>/dev/null || true
  [ -x "$f" ] || _notexec="$_notexec $f"
done
# A file can be 755 on disk and still recorded 100644 in git — the tree then reports it MODIFIED
# forever, with a zero-line diff no edit can resolve, because the wrong bit is in the INDEX.
#
# THE CAUSE IS `git add -A`, NOT A ONE-OFF BAD COMMIT. gx-sync writes these files through mktemp+mv,
# which lands them 0644, then chmods to 755. Commit with `git add -A` or `commit -a` in the window
# before the chmod and a zero-line mode change rides along inside an unrelated commit. Nobody sees it:
# it adds no lines to the diff and the commit is about something else entirely.
#
# Traced through inventory's serve.py, which was created 100755 and broken TWICE by ride-alongs:
#     47a8b12  created                                    -> 100755
#     3de02f8  "Adopt gxengine.sh ..."           100755    -> 100644   (ride-along)
#     4f01457  "Restore the executable bit ..."  100644    -> 100755   (deliberate fix)
#     6d0e56d  "gx-preflight now runs tests ..." 100755    -> 100644   (ride-along, one commit later)
# So `update-index` alone does NOT make it stick — 4f01457 proves that; the very next commit undid it.
# The habit is the fix, which is why the message below leads with the habit.
_badmode=""
for f in .claude/gx-brain-notes.sh .claude/gx-posttool-tests.sh deploy.sh serve.py serve.js gx-preflight.sh gxengine.sh; do
  [ -f "$f" ] || continue
  case "$(git ls-files -s "$f" 2>/dev/null | awk '{print $1}')" in
    100644) [ -x "$f" ] && _badmode="$_badmode $f" ;;
  esac
done
if [ -n "$_badmode" ]; then
  echo "  ! executable on disk but recorded 100644 in git:$_badmode"
  echo "    Your tree shows these modified forever with an empty diff. Fix the index:"
  echo "      git update-index --chmod=+x$_badmode && git commit -m 'track the executable bit'"
  echo "    Then keep it fixed: DO NOT 'git add -A' or 'commit -a' in a repo gx-sync touches."
  echo "    That is what broke it — a zero-line mode change riding along in an unrelated commit."
  echo "    Name your files explicitly and it cannot happen."
fi

if [ -n "$_notexec" ]; then
  echo "  ✗ NOT EXECUTABLE after chmod:$_notexec"
  echo "    The pre-push hook execs gx-preflight.sh, so this breaks every push until fixed:"
  echo "      chmod 755$_notexec && git update-index --chmod=+x$_notexec"
fi

# ── WILL clasp PUSH serve.js INTO THE APPS SCRIPT PROJECT? ─────────────────────────────────
# serve.js is the FIRST ROOT-LEVEL .js FILE THIS SCRIPT HAS EVER PLACED, and that single fact is the
# whole story. clasp pushes .js/.gs/.ts/.html/.json and ignores every other extension, so deploy.sh,
# gx-preflight.sh, gxengine.sh (.sh) and serve.py (.py) were never candidates no matter what a repo's
# .claspignore said. Eight months of syncing proved nothing about this case; it just never arose.
#
# When it does arise the failure is maximally confusing: clasp ships serve.js as serve.gs, where
# `#!/usr/bin/env node` on line 1 is a parse error that fails the ENTIRE push — backend fix and all —
# pointing at a file the deployer never touched and did not know existed. Sales hit exactly that on
# 2026-09-03 on an unrelated fix. It is armed by the file LANDING, not by the change being deployed.
#
# .claspignore is deliberately NOT a synced file (it is per-project truth: rootDir, which .gs files
# are real, which are separate bound projects). So this script CANNOT fix it for a spoke. What it can
# do is speak at the only moment anyone is looking — when the file lands — rather than leaving it to
# be discovered one broken deploy at a time. This is the fourth instance of the identical mechanism:
# tests/ (2026-08-22), design_handoff_*/ (2026-08-25), then sales and inventory today.
#
# RESOLVE rootDir, DO NOT STRING-COMPARE IT. "." and "./" and an absolute path all mean the repo root;
# "apps-script" means serve.js is outside the push scope entirely and there is nothing to warn about.
# Comparing literally against "." reports apps-script repos as armed, which is a false alarm in a
# warning nobody can act on — and a false alarm here teaches people to ignore the true one.
if [ -f .clasp.json ] && [ -f serve.js ]; then
  _rootdir=$(sed -n 's/.*"rootDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' .clasp.json | head -1)
  [ -n "$_rootdir" ] || _rootdir="."
  _rootabs=$(cd "$_rootdir" 2>/dev/null && pwd -P) || _rootabs=""
  if [ -n "$_rootabs" ] && [ "$_rootabs" = "$(pwd -P)" ]; then
    # In scope. Two shapes of .claspignore keep it out, and BOTH are in use across the suite:
    #   a denylist naming the file      (inventory, sales)
    #   an allowlist of `**` + !include (performance) — excludes serve.js without ever mentioning it
    _safe=""
    if [ -f .claspignore ]; then
      _ci=$(sed 's/#.*//' .claspignore | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$')
      printf '%s\n' "$_ci" | grep -qx 'serve\.js' && _safe="named"
      if [ -z "$_safe" ] && printf '%s\n' "$_ci" | grep -qx '\*\*' \
         && ! printf '%s\n' "$_ci" | grep -qx '!serve\.js'; then _safe="allowlist"; fi
    fi
    if [ -z "$_safe" ]; then
      echo "  ! serve.js is inside clasp's push scope here and .claspignore does not exclude it."
      echo "    Your NEXT backend deploy will fail with a parse error naming serve.gs, whatever that"
      echo "    deploy is carrying. One line fixes it, before you forget this warning:"
      echo "      printf '\n# Node dev server, synced from gx-theme. rootDir is the repo root and\n# nothing here excludes JS by extension, so clasp would push this as serve.gs,\n# where the node shebang is a parse error that fails the WHOLE push.\nserve.js\n' >> .claspignore"
    fi
  fi
fi

# Install preflight as a pre-push hook so dev leftovers (fixtures on, writes armed, @devonly blocks,
# localhost URLs) can't reach Pages. Never clobber a hook that already does something else.
if [ -d .git ]; then
  if [ ! -f .git/hooks/pre-push ] || grep -q gx-preflight .git/hooks/pre-push 2>/dev/null; then
    # `exec sh ./gx-preflight.sh`, NOT `exec ./gx-preflight.sh`. Invoking it directly requires the
    # executable bit, and that bit does not survive reliably here: these repos live in Dropbox
    # CloudStorage, which reverts modes asynchronously AFTER a sync finishes — so chmod appears to
    # work, an immediate -x check passes, and the file is 0600 again a moment later. On 2026-08-22
    # that took the bit off gx-preflight.sh in four repos and every push died with
    # "Permission denied": the guard did not weaken, it stopped running.
    # Running it through sh makes the guard independent of a mode we cannot keep.
    printf '#!/bin/sh\nexec sh ./gx-preflight.sh\n' > .git/hooks/pre-push
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
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write",
        "hooks": [ { "type": "command", "command": "sh .claude/gx-posttool-tests.sh" } ] }
    ]
  }
}
JSON
  echo "  ✓ .claude/settings.json (created)"
else
  echo "  • .claude/settings.json exists — leave it; ensure SessionStart runs 'sh .claude/gx-brain-notes.sh'"
  echo "    and PostToolUse (matcher Edit|Write) runs 'sh .claude/gx-posttool-tests.sh'"
fi
echo "Done. (gx-sync.sh keeps itself up to date from here on.)"
