#!/bin/sh
# ─── gxclaim — one session owns this checkout at a time ──────────────────────────────────────────
#
#   sh ./gxclaim.sh claim [label]   take (or refresh) this session's claim on the repo
#   sh ./gxclaim.sh check [context] enforcement — exit 1 if a DIFFERENT live session holds it
#   sh ./gxclaim.sh release [--force]
#   sh ./gxclaim.sh status          who holds it, and whether the gate is actually installed
#   sh ./gxclaim.sh install         (re)install the git hooks that enforce it
#
# WHY THIS EXISTS. The GX repos live in Dropbox, so two Claude sessions on this machine open the SAME
# working tree and the SAME HEAD. Neither can see the other. `git checkout -b` is not atomic against a
# second process, and the loser finds out afterwards by reading the log.
#
# It has cost something real. 2026-09-02: two sessions shared greencross-command-center. One made a
# correct, tested fix and put it on a branch for review, because GX Core cuts are PR-gated. The other
# switched the branch out from under it — a shared checkout has one HEAD — so that commit landed on
# main, and the second session pushed and shipped it as library v284. No PR, no review, on the
# highest-stakes repo in the suite. THE CODE WAS FINE. That is the point: nothing failed and nothing
# warned. It recurred three times in greencross-spiff on 2026-09-08/09; nothing collided that time.
#
# WHAT IT ACTUALLY STOPS, and where. Three gates, because the damage arrives three different ways:
#   pre-commit             — a foreign session committing onto the branch you are holding.
#   pre-push               — a foreign session publishing it.
#   reference-transaction  — a foreign session moving HEAD or a local branch AT ALL: checkout, switch,
#                            reset, branch -f, merge, rebase. This is the one that matters most and the
#                            only one that catches the v284 shape, because the branch switch happens
#                            BEFORE any commit exists to refuse. It is also the one `--no-verify`
#                            cannot skip — that flag turns off pre-commit and pre-push and has no
#                            effect here.
# Remote-tracking refs, tags and the stash are deliberately left alone: `git fetch` hurts nobody, and a
# gate that fires on harmless things is a gate people switch off.
#
# WHAT IT DOES NOT DO. It does not stop a foreign session EDITING files — no hook exists for that, and
# ship.sh publishes the working tree, not HEAD. That half is gxtreeguard.sh's job (hub only, for now).
# The two are complementary: this one keeps the history straight, that one keeps the release honest.
#
# IDENTITY IS THE CLAUDE PROCESS, NOT THE SHELL. Every Bash tool call is a fresh shell with a fresh
# pid, so a shell pid identifies nothing. CLAUDE_PID is the one long-lived process per session, and
# `kill -0` on it is how a claim from a session that has since been closed gets cleaned up instead of
# jamming the repo forever. Subagents share their parent's CLAUDE_PID, so a subagent inherits the
# claim rather than fighting it — which is correct: it is the same session, in the same checkout.
#
# A HUMAN AT A TERMINAL IS NEVER REFUSED. With no CLAUDE_PID in the environment this is Sky, not a
# second agent, and being locked out of his own repo by a robot is not an improvement. He gets a
# one-line notice that a session holds the tree, and git does what he told it to.
set -u

CMD="${1:-status}"
[ $# -gt 0 ] && shift

GITDIR="$(git rev-parse --git-dir 2>/dev/null)" || { echo "gxclaim: not a git repository" >&2; exit 2; }
CLAIM="$GITDIR/gx-claim"
REPO="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
HOST="$(hostname -s 2>/dev/null || echo unknown)"
ME="${CLAUDE_PID:-}"
MY_SESSION="${CLAUDE_CODE_SESSION_ID:-}"

# A claim from another machine cannot be liveness-probed — Dropbox syncs .git, so the file can arrive
# from a laptop that is now closed. Rather than jam the repo forever, such a claim ages out.
FOREIGN_HOST_STALE_HOURS=12

# ─── reading the claim ──────────────────────────────────────────────────────────────────────────
c_pid=""; c_session=""; c_host=""; c_started=""; c_label=""; c_branch=""; c_epoch=""
read_claim() {
  c_pid=""; c_session=""; c_host=""; c_started=""; c_label=""; c_branch=""; c_epoch=""
  [ -f "$CLAIM" ] || return 1
  while IFS='=' read -r k v; do
    case "$k" in
      pid)     c_pid="$v" ;;
      session) c_session="$v" ;;
      host)    c_host="$v" ;;
      started) c_started="$v" ;;
      epoch)   c_epoch="$v" ;;
      label)   c_label="$v" ;;
      branch)  c_branch="$v" ;;
    esac
  done < "$CLAIM"
  [ -n "$c_pid" ] || return 1
  return 0
}

# 0 = a live claim exists (fills c_*), 1 = no claim / stale (and stale ones are removed)
live_claim() {
  read_claim || return 1
  if [ "$c_host" = "$HOST" ]; then
    if kill -0 "$c_pid" 2>/dev/null; then return 0; fi
    rm -f "$CLAIM"; return 1
  fi
  # different machine: age it out rather than probe a pid that means nothing here
  _now="$(date +%s)"
  _age=$(( ${_now:-0} - ${c_epoch:-0} ))
  if [ "$_age" -gt $(( FOREIGN_HOST_STALE_HOURS * 3600 )) ]; then rm -f "$CLAIM"; return 1; fi
  return 0
}

held_by_other() {                      # 0 = someone ELSE holds it
  live_claim || return 1
  [ -n "$ME" ] && [ "$c_pid" = "$ME" ] && return 1
  return 0
}

short_session() { printf '%s' "$1" | cut -c1-8; }

describe_holder() {
  _who="session ${c_session:+$(short_session "$c_session")}"
  [ -n "$c_label" ] && _who="$_who — \"$c_label\""
  printf '%s' "$_who"
}

# ─── commands ───────────────────────────────────────────────────────────────────────────────────
case "$CMD" in

  claim)
    LABEL="${1:-}"
    if [ -z "$ME" ]; then
      echo "gxclaim: no CLAUDE_PID in the environment — nothing to claim for (this is a plain shell)." >&2
      exit 0
    fi
    if held_by_other; then
      echo "⛔ $REPO is already claimed by another Claude session."
      echo "   held by: $(describe_holder)"
      echo "   since:   ${c_started:-unknown}${c_branch:+   on branch $c_branch}"
      echo "   Work in a different repo, or close that chat. If it is definitely gone:"
      echo "       sh ./gxclaim.sh release --force"
      exit 1
    fi
    umask 077
    {
      echo "pid=$ME"
      echo "session=$MY_SESSION"
      echo "host=$HOST"
      echo "started=$(date '+%Y-%m-%d %H:%M')"
      echo "epoch=$(date +%s)"
      echo "branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
      echo "label=$LABEL"
    } > "$CLAIM"
    exit 0
    ;;

  check)
    CONTEXT="${1:-git}"
    # A human at a terminal is not the problem this solves.
    if [ -z "$ME" ]; then
      if live_claim; then
        echo "note: a Claude session ($(describe_holder)) has this repo open. Proceeding — you are not it." >&2
      fi
      exit 0
    fi
    held_by_other || exit 0
    if [ "${GX_CLAIM_OK:-0}" = "1" ]; then
      echo "⚠️  GX_CLAIM_OK=1 — $CONTEXT allowed even though another session holds $REPO." >&2
      exit 0
    fi
    {
      echo
      echo "⛔ REFUSING $CONTEXT — another Claude session is working in this same folder."
      echo
      echo "   $REPO is one folder on disk, shared. Going ahead now writes on top of whatever"
      echo "   they are in the middle of, and neither chat is told. That is how an unreviewed"
      echo "   change went out as GX Core v284."
      echo
      echo "   held by: $(describe_holder)"
      echo "   since:   ${c_started:-unknown}${c_branch:+   on branch $c_branch}"
      echo
      echo "   What to do: finish in the other chat first, or work in a different repo."
      echo "   If that session is definitely closed:   sh ./gxclaim.sh release --force"
      echo "   To override this one command:           GX_CLAIM_OK=1 <your command>"
      echo
    } >&2
    exit 1
    ;;

  release)
    if [ "${1:-}" = "--force" ]; then
      read_claim && echo "released $REPO (was held by $(describe_holder))"
      rm -f "$CLAIM"; exit 0
    fi
    if read_claim && [ -n "$ME" ] && [ "$c_pid" != "$ME" ]; then
      echo "gxclaim: $REPO is held by another session — not releasing. Use --force if it is gone." >&2
      exit 1
    fi
    rm -f "$CLAIM"; exit 0
    ;;

  who)
    if live_claim; then echo "$REPO: held by $(describe_holder) since ${c_started:-?}"
    else echo "$REPO: free"; fi
    exit 0
    ;;

  install)
    HOOKS="$GITDIR/hooks"
    mkdir -p "$HOOKS"

    # pre-push already exists in every GX repo and runs that repo's test/preflight gate. Keep whatever
    # it runs; put the claim check in front of it. Re-running install must not stack duplicates, so the
    # existing claim line is stripped before the file is rebuilt.
    EXISTING=""
    if [ -f "$HOOKS/pre-push" ]; then
      EXISTING="$(grep -v '^#!' "$HOOKS/pre-push" | grep -v 'gxclaim.sh' | sed '/^[[:space:]]*$/d')"
    fi
    {
      echo '#!/bin/sh'
      echo 'sh ./gxclaim.sh check "this push" || exit 1'
      [ -n "$EXISTING" ] && printf '%s\n' "$EXISTING"
    } > "$HOOKS/pre-push"

    printf '#!/bin/sh\nsh ./gxclaim.sh check "this commit" || exit 1\n' > "$HOOKS/pre-commit"

    # reference-transaction fires on every ref update, including the HEAD move a checkout makes — which
    # is the only place the branch-switched-out-from-under-you case can be caught. It must stay cheap
    # and it must not brick the repo: if gxclaim.sh is missing it says so and gets out of the way.
    # Only HEAD and local branches are gated; fetch, tags and the stash pass straight through.
    cat > "$HOOKS/reference-transaction" <<'HOOK_EOF'
#!/bin/sh
# installed by gxclaim.sh — refuses HEAD/branch moves while another Claude session holds this checkout
[ "$1" = "prepared" ] || exit 0
[ -f ./gxclaim.sh ] || { echo "warning: gxclaim.sh missing — checkout guard is OFF in $(pwd)" >&2; exit 0; }
_gate=0
while read -r _old _new _ref; do
  case "$_ref" in
    HEAD|refs/heads/*) _gate=1 ;;
  esac
done
[ "$_gate" = "1" ] || exit 0
sh ./gxclaim.sh check "this branch change" || exit 1
exit 0
HOOK_EOF

    for h in pre-push pre-commit reference-transaction; do chmod 755 "$HOOKS/$h" 2>/dev/null || true; done
    echo "✓ gxclaim gates installed in $REPO (pre-commit, pre-push, reference-transaction)"
    exit 0
    ;;

  status)
    HOOKS="$GITDIR/hooks"
    echo "gxclaim — $REPO"
    if live_claim; then
      _mine=""
      [ -n "$ME" ] && [ "$c_pid" = "$ME" ] && _mine="  ← this session"
      echo "  claimed by $(describe_holder)$_mine"
      echo "  since ${c_started:-?}${c_branch:+, on branch $c_branch}${c_host:+, on $c_host}"
    else
      echo "  not claimed"
    fi
    # A gate that stopped running is worse than no gate, and this filesystem can switch one off by
    # dropping a mode bit. Say plainly whether each hook is there AND executable.
    _bad=""
    for h in pre-commit pre-push reference-transaction; do
      if [ ! -f "$HOOKS/$h" ]; then _bad="$_bad\n  ✗ $h missing"
      elif ! grep -q gxclaim.sh "$HOOKS/$h" 2>/dev/null; then _bad="$_bad\n  ✗ $h does not call gxclaim"
      elif [ ! -x "$HOOKS/$h" ]; then _bad="$_bad\n  ✗ $h is not executable — git will silently skip it"
      fi
    done
    if [ -n "$_bad" ]; then
      printf 'GATE IS NOT FULLY ARMED:%b\n  fix:  sh ./gxclaim.sh install\n' "$_bad"
      exit 1
    fi
    echo "  ✓ all three gates armed"
    exit 0
    ;;

  *)
    echo "gxclaim: unknown command '$CMD' — use claim | check | release | who | status | install" >&2
    exit 2
    ;;
esac
