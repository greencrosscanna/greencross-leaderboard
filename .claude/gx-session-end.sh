#!/bin/sh
# ─── gx-session-end — a chat that ends lets go of the repos it holds ────────────────────────────
#
# Wired as the SessionEnd hook in every GX repo's .claude/settings.json (gx-sync.sh merges it in),
# synced to .claude/gx-session-end.sh. Runs when a Claude chat closes, is archived, or is /clear'ed.
#
# WHY. gxclaim.sh frees a claim only when the holder's process dies (kill -0 on CLAUDE_PID) or after
# CLAIM_IDLE_TTL_MIN of no gated action. Nothing released it when a chat simply ENDED. On 2026-11-24 a
# SPIFF chat ran /wrapup, the archive was interrupted, the process stayed alive, and greencross-spiff
# stayed claimed until Sky typed `sh ./gxclaim.sh release` by hand. This closes that gap; the pid
# check and the TTL stay as the backstop for a chat that dies without its hooks running.
#
# WHY IT IS SAFE TO RUN IN EVERY CHAT. `gxclaim.sh release` without --force is holder-only: with
# CLAUDE_PID set and a claim held by a DIFFERENT pid it refuses and changes nothing. That protection
# depends entirely on CLAUDE_PID being present — with it unset, gxclaim treats the caller as a human
# and `release` removes ANYONE's claim. So this script does nothing at all without CLAUDE_PID.
# Measured 2026-11-24 (Claude Code 2.1.330): a SessionEnd hook receives the session's own CLAUDE_PID,
# CLAUDE_PROJECT_DIR, and runs with the project root as its cwd.
#
# IT ALSO RELEASES SIBLING GX REPOS THIS CHAT HOLDS. A hub chat that committed into spokes holds their
# claims too (2026-09-17: one hub session held four repos for up to 24 hours). Each sibling's own
# gxclaim.sh decides, holder-only, so a sibling another chat holds is left exactly as it was.
#
# It never fails the hook: every outcome exits 0, and output goes nowhere a closing chat would show.
[ -n "${CLAUDE_PID:-}" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

# This repo first — it is the one that matters, and the hook may be cut short.
[ -f ./gxclaim.sh ] && sh ./gxclaim.sh release >/dev/null 2>&1

# Then the siblings. Resolve the suite folder from the COMMON git dir, so a session in a linked
# worktree (.claude/worktrees/<name>) still finds the repos beside the main checkout.
_common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
case "$_common" in */.git) ;; *) exit 0 ;; esac
_self="$(dirname "$_common")"
_suite="$(dirname "$_self")"
for _s in "$_suite"/*/gxclaim.sh; do
  [ -f "$_s" ] || continue
  [ "$(dirname "$_s")" = "$_self" ] && continue
  [ -f "$(dirname "$_s")/.git/gx-claim" ] || continue   # nothing claimed there: skip the work
  sh "$_s" release >/dev/null 2>&1
done
exit 0
