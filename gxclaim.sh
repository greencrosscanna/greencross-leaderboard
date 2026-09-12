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

# ─── NO CLAIM IS NOT THE SAME AS NOBODY HERE ────────────────────────────────────────────────────
# `who` used to print "free" whenever the claim file was absent. On 2026-09-09 it said "greencross-spiff:
# free" while a live session was working there, and the next night five of six spoke chats were open
# with no claim file between them (only crew's survived; why the others vanished is still open). A
# session opened before the hook claimed, or in a checkout whose hook never claims (the hub's did not),
# holds nothing — and "free" told the next session to start editing underneath it.
#
# So the advisory commands also look at the processes: any OTHER Claude session whose working directory
# is this checkout. `pgrep -a` because macOS pgrep otherwise hides its own ancestors, which includes the
# session asking. This is ADVISORY ONLY: `check` still enforces on the claim file alone, because
# refusing a commit on a process-table guess is a much bigger decision than printing one.
others_here() {
  command -v lsof >/dev/null 2>&1 || return 0
  _top="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
  for _p in $(pgrep -a -x claude 2>/dev/null); do
    [ -n "$ME" ] && [ "$_p" = "$ME" ] && continue
    [ -n "$c_pid" ] && [ "$_p" = "$c_pid" ] && continue
    _cwd="$(lsof -a -p "$_p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    [ "$_cwd" = "$_top" ] && printf '%s ' "$_p"
  done
}

short_session() { printf '%s' "$1" | cut -c1-8; }

write_claim() {                        # $1 = label
  umask 077
  {
    echo "pid=$ME"
    echo "session=$MY_SESSION"
    echo "host=$HOST"
    echo "started=$(date '+%Y-%m-%d %H:%M')"
    echo "epoch=$(date +%s)"
    echo "branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    echo "label=${1:-}"
  } > "$CLAIM"
}

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
    write_claim "$LABEL"
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
    if ! held_by_other; then
      # CLAIM ON FIRST ACTION, not only at session start. The hook claims once, when a chat opens, and
      # a chat refused then was never offered it again. On 2026-09-10 six new spoke chats were each
      # refused at start by a claim taken IN THE SAME MINUTE by a different session id — one that left
      # no transcript anywhere and was gone within minutes (its claim went stale and was swept). There
      # were no older spoke chats open; the holders look like a short-lived companion process started
      # alongside each chat, which is inference from those two facts, not something observed. Five
      # repos then sat unclaimed with live chats in them, the gates protecting nobody. All five chats
      # reported the same refused-then-"free" sequence. So the first gated action (commit, push,
      # branch change) by a session in an unclaimed checkout takes the claim, whatever held it before.
      # (An earlier version of this comment blamed old chats still open. There were none.)
      live_claim || write_claim ""
      exit 0
    fi
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
    else
      _others="$(others_here)"
      if [ -n "$_others" ]; then
        echo "$REPO: NOT CLAIMED — but another Claude session is working in this folder (pid ${_others% })."
        echo "   No claim is not the same as nobody here. Ask that session, or check ListAgents, before editing."
      else echo "$REPO: free"; fi
    fi
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

    # ── RESTORE THE EXECUTABLE BIT ON THE SHARED SCRIPTS, TOO ───────────────────────────────────
    # The hooks above are chmod'd here because this filesystem drops executable bits and a disarmed
    # hook is silent. The same thing happens to the shared scripts beside them, and it is NOT fully
    # explained: one cause was found and fixed (gx-sync.sh used to chmod in a sweep at the end, so an
    # interrupted run froze mktemp's 0600 — gx-theme 647fc45), but files have been observed 755 right
    # after a COMPLETED sync and 0600 minutes later with nothing run in between, twice, in different
    # repos. A controlled A/B would not reproduce it in either arm. That remains open; see gx-sync.sh.
    #
    # This does not explain it. It makes it stop mattering, which is the half worth having: every
    # guard in the suite already invokes these through `sh` (which reads the file and ignores the
    # mode), so the ONLY path that needs the bit is a human typing `./deploy.sh`. Repairing it
    # wherever we happen to be running is cheaper than the alternative — rewriting 153 occurrences of
    # `./deploy.sh` across eight repos' docs, most of them in per-repo CLAUDE.md files that are
    # deliberately not synced and would drift straight back.
    #
    # The list matches gx-sync.sh's. Keep them together: a script that syncs 755 and a script that
    # repairs 755 disagreeing about WHICH files is how one of them silently stops covering something.
    for _f in .claude/gx-brain-notes.sh .claude/gx-posttool-tests.sh deploy.sh serve.py serve.js \
              gx-preflight.sh gxengine.sh gx-usenglish.sh gxclaim.sh gxdevlogin.sh; do
      [ -f "$_f" ] && [ ! -x "$_f" ] && chmod 755 "$_f" 2>/dev/null || true
    done
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
    _others="$(others_here)"
    if [ -n "$_others" ]; then
      echo "  ⚠ another Claude session is working in this folder without a claim here (pid ${_others% })"
      echo "    — the gates cannot protect either of you until one of you claims."
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

  expect)
    # ── REFUSE A COMMIT ONTO A BRANCH THE CALLER NEVER LOOKED AT ────────────────────────────────
    # `check` answers "does someone ELSE hold this checkout". It says nothing about what is checked
    # out RIGHT NOW, and that is the other half of the same hazard: on 2026-09-09 a gxdevlogin.sh
    # rollout ran `git add && git commit && git push` across six spokes and committed into
    # greencross-leaderboard while that repo had a feature branch out. Nothing was lost — the content
    # shipped inside leaderboard's squash-merge, under its title — but the authorship is buried and
    # the originating session never knew. Leaderboard found it, not us. Half an hour later the same
    # rollout WAS refused on leaderboard and spiff, but only because those sessions happened to hold
    # their claims; in an unclaimed repo it would have gone through again.
    #
    # So this is deliberately EXPLICIT rather than a hook. A hook cannot know which branch you meant
    # to be on — only the caller does. A rollout loop states its expectation once per repo and gets a
    # refusal instead of a surprise:
    #
    #     for r in ../greencross-*/; do (cd "$r" && sh ./gxclaim.sh expect main "the gxdevlogin rollout" \
    #                                     && git add … && git commit … ) || echo "skipped $r"; done
    #
    # Detached HEAD refuses too: it is never what a rollout means, and it is what a preflight
    # worktree leaves behind.
    _want="${1:-}"
    [ -n "$_want" ] || { echo "gxclaim expect: name the branch you expect, e.g. 'expect main'" >&2; exit 2; }
    [ $# -gt 0 ] && shift
    _ctx="${1:-this command}"
    _on="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    [ "$_on" = "$_want" ] && exit 0
    if [ "${GX_EXPECT_OK:-0}" = "1" ]; then
      echo "⚠️  GX_EXPECT_OK=1 — $_ctx allowed on '${_on:-detached HEAD}' though it expected '$_want'." >&2
      exit 0
    fi
    {
      echo
      echo "⛔ REFUSING $_ctx — $REPO is not on the branch you expected."
      echo
      echo "   expected: $_want"
      echo "   actually: ${_on:-detached HEAD}"
      echo
      if [ -z "$_on" ]; then
        echo "   A detached HEAD is never what a rollout means. If this is a leftover preflight"
        echo "   worktree, you are in the wrong directory."
      else
        echo "   Committing here would bury your change inside '$_on' — it ships under that"
        echo "   branch's title when it merges, and the session that made it never finds out."
        echo "   That happened to greencross-leaderboard on 2026-09-09."
      fi
      echo
      echo "   What to do: skip this repo, or check out $_want first."
      echo "   To override this one command:   GX_EXPECT_OK=1 <your command>"
      echo
    } >&2
    exit 1
    ;;

  *)
    echo "gxclaim: unknown command '$CMD' — use claim | check | expect | release | who | status | install" >&2
    exit 2
    ;;
esac
