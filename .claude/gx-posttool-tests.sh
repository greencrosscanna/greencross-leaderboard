#!/bin/sh
# ─── gx-posttool-tests — run this repo's suites the moment a source file changes ─────────────────
# Source of truth: greencross-gx-theme/.claude/gx-posttool-tests.sh. Synced into spokes by gx-sync.sh.
#
# WHY. Until now the only gates were at PUSH time. That answers "did I break something?" long after
# the edit, when the answer is a bisect across twenty changes. This answers it while there is exactly
# one suspect: the file just written.
#
# EXITS 2 ON FAILURE, NOT 1. For a PostToolUse hook, exit 2 feeds stderr back to the agent, which can
# then fix it immediately — the entire point. Exit 1 is a silent non-blocking error nobody reads.
# It never blocks the edit: the write has already happened, and refusing after the fact helps nobody.
#
# GX_SKIP_NETWORK=1 is deliberate. One suite makes a live freshness probe costing ~3 seconds; every
# other suite in the suite finishes in under 130ms. A three-second pause on every save is how a hook
# gets disabled, and the contract assertions — the valuable part — still run. The probe belongs at
# push time, where it already is.
set -u

# The hook payload arrives as JSON on stdin. No jq on a stock macOS, so use python3, and fail OPEN:
# if the payload cannot be parsed we simply do nothing rather than spamming an unreadable error.
payload="$(cat 2>/dev/null || true)"
file="$(printf '%s' "$payload" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    print((d.get('tool_input') or {}).get('file_path') or '')
except Exception:
    print('')
" 2>/dev/null)"
[ -n "$file" ] || exit 0

# Only source changes can break a suite. Editing a doc, a workflow or a JSON fixture should not cost
# anyone a test run — a hook that fires on everything becomes noise, and noise gets turned off.
case "$file" in
  *.gs|*.js|*.html) ;;
  *) exit 0 ;;
esac

# Locate the repo the edited file belongs to, not the shell's cwd — an agent may be anywhere.
dir="$(CDPATH= cd -- "$(dirname -- "$file")" 2>/dev/null && pwd)" || exit 0
repo=""
# `-e`, not `-d`: in a linked worktree `.git` is a FILE. With `-d` an edit inside
# greencross-command-center/.claude/worktrees/<name> walked past its own worktree and ran the MAIN
# checkout's suites — testing code the session had not written, and on 2026-09-17 running an old hub
# test that locked every spoke as a side effect. Measured, not assumed: this session's own edit did it.
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if [ -e "$dir/.git" ]; then repo="$dir"; break; fi
  dir="$(dirname "$dir")"
done
[ -n "$repo" ] || exit 0
cd "$repo" || exit 0

# Tests must never inherit a caller's GIT_DIR — a test building a throwaway repo would otherwise write
# into the real one. Full reasoning in gx-preflight.sh, where the same strip sits; this hook runs the
# same suites, so it needs the same defense.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE 2>/dev/null || true

ls tests/*_test.js >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || exit 0

failed=""
out=""
for t in tests/*_test.js; do
  if ! o="$(GX_SKIP_NETWORK=1 node "$t" 2>&1)"; then
    failed="$failed $t"
    out="$out
── $t
$(printf '%s' "$o" | grep -E 'FAIL|✗|Error|error:' | head -8)"
  fi
done

[ -n "$failed" ] || exit 0

# stderr + exit 2 → the agent sees this and can fix it now, with one suspect instead of twenty.
{
  echo "Tests broke in $(basename "$repo") after editing $(basename "$file"):"
  echo "$out"
  echo ""
  echo "Fix before continuing. Run the full suite with:  cd $repo && ls tests/*_test.js | xargs -n1 node"
} >&2
exit 2
