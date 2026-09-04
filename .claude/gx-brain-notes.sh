#!/bin/sh
# ─── SHARED SessionStart hook (source of truth) ──────────────────────────────────────────────────
# Surface pending brain-notes addressed to THIS app from GX Core's central inbox (brain_notes). Cross-app
# handoffs AND bugs — which now ride the notes rail (gxIngestBug emits a 🐞 note to the owning chat) — reach
# the acting chat here, whichever chat wrote them. Fails silent (no secret / offline).
#
# Every spoke uses THIS script; the ONLY per-repo edit is the APP= line. Copy it to
# <repo>/.claude/gx-brain-notes.sh and set APP to the app's GX key. To change the hook, edit it HERE and
# re-copy to the spokes (keep them identical apart from APP=).
#
# WHY THE RETRY: GX Core's /exec is a two-hop redirect that ~6% of the time serves a Drive HTML error page
# instead of JSON. A single fetch would silently drop the whole inbox on that miss (this is how the rec-price
# note was lost). gx_fetch RETRIES until it gets real JSON — normally one fast call; retries only fire on the flake.
APP="performance"
GXCORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"
[ -f ".gx_deploy_secret" ] || exit 0
SECRET=$(cat .gx_deploy_secret)

# Retry-aware GET → prints a JSON object, or nothing after 4 tries. $1=action  $2=status
gx_fetch() {
  _i=1
  while [ "$_i" -le 4 ]; do
    _r=$(curl -sL --max-time 6 -G "$GXCORE" \
      --data-urlencode "action=$1" --data-urlencode "secret=$SECRET" \
      --data-urlencode "app=$APP" --data-urlencode "status=$2" 2>/dev/null)
    case "$_r" in \{*) printf '%s' "$_r"; return 0 ;; esac   # accept only a JSON object; the flake is HTML
    _i=$((_i + 1)); [ "$_i" -le 4 ] && sleep 2
  done
}

# status=open means pending OR blocked — everything not yet CLOSED, in one call.
#
# REQUIRES GX Core to have shipped `open` (getNotes, 2026-08-25). Against an older Core, `open` matches
# no note and returns [] with no error, and this hook would print "nothing needs you" over a full inbox.
# That is why this file ships only AFTER the Core deploy, never alongside it.
gx_fetch notes open | python3 -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
notes = d.get("notes") or []
if not notes: sys.exit(0)
# ASKS FIRST, IN FULL. FYIs collapse to a list of subjects.
# The board grew faster than it drained because most notes were acknowledgments — they still had to be
# read and resolved while asking for nothing. A banner that prints a 2,500-character "done" note at the
# same weight as a real request teaches you to skim past both.
DONE_WORDS = ("closed", "resolved", "done", "shipped", "deployed", "retraction",
              "correction", "acknowledged", "answered", "stand down", "no action")
def is_fyi(n):
    # DISPLAY-ONLY heuristic, deliberately more generous than the one that decides EXPIRY.
    # Only kind=fyi ever auto-closes; this just decides what collapses in the banner. So a note
    # titled "RESOLVED: … but one question" gets tucked into the skim list and still waits for a
    # human — being wrong here costs a glance, whereas being wrong about expiry loses a request.
    # Needed because the ✅ convention is owned by core-admin, while the spokes write CLOSED / RESOLVED / DONE.
    k = str(n.get("kind", "")).strip().lower()
    if k == "fyi": return True
    if k == "ask": return False
    t = str(n.get("title", "")).strip()
    if t.startswith("\u2705"): return True
    low = t.lower()
    return any(low.startswith(w) for w in DONE_WORDS)
# BLOCKED is not fresh work and must not be rendered as if it were. It means a human — usually Sky —
# owes a decision or an action no agent can take. Printed at the same weight as an unread ask, it reads
# identically to "nobody has looked at this", which is exactly the confusion the status was added to end.
blocked = [n for n in notes if str(n.get("status", "")).strip().lower() == "blocked"]
rest = [n for n in notes if n not in blocked]
asks = [n for n in rest if not is_fyi(n)]
fyis = [n for n in rest if is_fyi(n)]
app = d.get("app", "this app")
if asks:
    print("\U0001F4CB Brain notes — %d NEEDING YOU for %s%s:" % (
        len(asks), app, (" (+%d done, below)" % len(fyis)) if fyis else ""))
    for n in asks:
        # SUBJECT FIRST, id last. A note id is a database key: it tells the reader nothing, and leading
        # with it makes them skip past the least useful token before they learn what this is about.
        print("  \u2022 %s  (from %s)  [%s]" % (n.get("title", ""), n.get("from_app") or "?", n.get("id", "")))
        body = (n.get("body") or "").strip()
        if body: print("      " + body.replace("\n", "\n      "))
elif blocked:
    print("\U0001F4CB Brain notes — nothing NEW for %s (%d blocked, below)." % (app, len(blocked)))
else:
    print("\U0001F4CB Brain notes — nothing needs you for %s." % app)
if blocked:
    # Subject + the reason, no body. The reason is the only new information: the note itself was read
    # when it was parked, and what a reader needs now is WHO is holding it and for WHAT.
    print("  \u23F8 %d BLOCKED on a human — parked, not forgotten:" % len(blocked))
    for n in blocked:
        print("      %s  (from %s)  [%s]" % (n.get("title", ""), n.get("from_app") or "?", n.get("id", "")))
        why = (n.get("blocked_on") or "").strip()
        if why: print("          waiting on: " + why)
    print("      \u2192 unblock_note when the answer lands; resolve_note when it is actually done.")
if fyis:
    # Subjects only. These are marked done by the sender; read one if it looks relevant, otherwise they
    # close themselves after 7 days. No body — that is the whole point.
    print("  %d marked done (\u2705) — skim or ignore; they auto-close after 7 days:" % len(fyis))
    for n in fyis:
        print("      %s  (from %s)  [%s]" % (n.get("title", "").lstrip("\u2705 ").strip(), n.get("from_app") or "?", n.get("id", "")))
if asks: print("  \u2192 run /gxbrain to act on these; resolve_note when done.")
' 2>/dev/null
exit 0
