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

gx_fetch notes pending | python3 -c '
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
asks = [n for n in notes if not is_fyi(n)]
fyis = [n for n in notes if is_fyi(n)]
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
else:
    print("\U0001F4CB Brain notes — nothing needs you for %s." % app)
if fyis:
    # Subjects only. These are marked done by the sender; read one if it looks relevant, otherwise they
    # close themselves after 7 days. No body — that is the whole point.
    print("  %d marked done (\u2705) — skim or ignore; they auto-close after 7 days:" % len(fyis))
    for n in fyis:
        print("      %s  (from %s)  [%s]" % (n.get("title", "").lstrip("\u2705 ").strip(), n.get("from_app") or "?", n.get("id", "")))
if asks: print("  \u2192 run /gxbrain to act on these; resolve_note when done.")
' 2>/dev/null
exit 0
