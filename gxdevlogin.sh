#!/bin/sh
# ─── gxdevlogin — get past the sign-in screen without a password ─────────────────────────────────
#
#   sh ./gxdevlogin.sh              this repo's app (from .gx_app)
#   sh ./gxdevlogin.sh inventory    a named app
#   sh ./gxdevlogin.sh --js         print ONLY the snippet, nothing else
#
# Mints a READ-ONLY viewer session from GX Core (?action=dev_session) using the deploy secret already
# on disk, and prints the one line of JavaScript that installs it in the page. Run that line in the
# browser on the app, reload, and the app is signed in as the dev viewer.
#
# WHY THIS EXISTS. Checking a change in the app as a signed-in user was the one thing that always came
# back to Sky: the login gate stands in front of every screen, and an agent must not type a password
# into a form — his, or a dev account's. So a dev ACCOUNT does not solve it; something has to hand out
# a SESSION. The deploy secret is a credential the tooling already holds and already uses for every
# housekeeping call, so nothing new is being trusted with anything new.
#
# WHY IT SHIPS NOTHING. There is deliberately no dev-mode branch, no bypass flag and no extra script
# in any app. Every app is unchanged; this only writes to the browser's own storage using the SAME key
# and the SAME shape a real sign-in writes. Production carries no code that exists to be bypassed —
# which is the failure mode a "skip the login on localhost" flag would have introduced, and the one
# that is dangerous precisely because it looks harmless until it ships.
#
# WHAT YOU CANNOT DO WITH IT. Write anything. The session is `viewer`, roleCanEdit says no, and every
# write gate in the suite already refuses it — so an approve, a save or an export will be blocked and
# SHOULD be. That is not a limitation to work around: a write-capable dev session is a separate
# decision with a much larger blast radius. If you need one, ask, do not widen this.
#
# ON LOCALHOST vs LIVE. Prefer localhost (`python3 serve.py`), where gx-dev.js blocks writes anyway
# and a mistake costs nothing. It works against the live app too, which is sometimes the only way to
# reproduce something — the session is read-only either way, but be deliberate about it.
#
# It expires in 2 hours. Re-run it; there is nothing to clean up.
set -u

GXCORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"

JS_ONLY=0
APP=""
for a in "$@"; do
  case "$a" in
    --js) JS_ONLY=1 ;;
    -*)   echo "gxdevlogin: unknown flag $a" >&2; exit 2 ;;
    *)    APP="$a" ;;
  esac
done

if [ -z "$APP" ]; then
  if [ -f .gx_app ]; then APP="$(tr -d ' \t\r\n' < .gx_app)"
  elif [ -f gx_core.gs ]; then APP="core-admin"          # the hub has no .gx_app
  else echo "gxdevlogin: which app? pass one, e.g. sh ./gxdevlogin.sh inventory" >&2; exit 2; fi
fi

[ -f .gx_deploy_secret ] || { echo "gxdevlogin: no .gx_deploy_secret in $(pwd)" >&2; exit 2; }
SECRET="$(cat .gx_deploy_secret)"

# ─── where each app keeps its session ───────────────────────────────────────────────────────────
# Read out of each app's own source, not invented here — inventory's LS.AUTH, leaderboard's
# SESSION_KEY, sales' GC_SALES_AUTH, Price Cards' PC_AUTH_KEY, spiff's session(), crew's TOKEN_KEY,
# Master Control's AUTH_KEY. They genuinely differ, including WHICH storage: spiff and crew use
# sessionStorage on purpose (a credentialed admin session on a machine that may not be the user's),
# and crew stores a bare token string plus a separate user string rather than one JSON object.
#
# If an app ever moves its key, this is the line to fix — and the symptom will be unmistakable: the
# snippet reports success and the app still shows its login screen.
case "$APP" in
  inventory)  STORE=localStorage;   KEY=gc_inv_auth ;;
  performance)STORE=localStorage;   KEY=GC_PERF_SESSION ;;
  sales)      STORE=localStorage;   KEY=gc_sales_token ;;
  pricecards) STORE=localStorage;   KEY=gx_pricecards_auth ;;
  spiff)      STORE=sessionStorage; KEY=spiff_session ;;
  crew)       STORE=sessionStorage; KEY=gx_crew_token ;;   # plus gx_crew_user — handled below
  core-admin) STORE=localStorage;   KEY=gx_mc_auth ;;
  *) echo "gxdevlogin: unknown app '$APP' (inventory performance sales pricecards spiff crew core-admin)" >&2; exit 2 ;;
esac

# ─── mint ───────────────────────────────────────────────────────────────────────────────────────
# GX Core's /exec is a two-hop redirect that sometimes serves a Drive HTML error page instead of JSON.
# Retry until it is a JSON object, the same way the SessionStart hook does — a single fetch would
# report "could not mint" for a flake that costs one more call.
i=1
while [ "$i" -le 4 ]; do
  RESP="$(curl -sL --http1.1 --max-time 20 -G "$GXCORE" \
    --data-urlencode action=dev_session --data-urlencode "secret=$SECRET" --data-urlencode "app=$APP" 2>/dev/null)"
  case "$RESP" in \{*) break ;; esac
  i=$((i + 1)); [ "$i" -le 4 ] && sleep 2
done

case "$RESP" in
  \{*) ;;
  *) echo "gxdevlogin: GX Core did not return JSON after 4 tries (offline, or the route is not deployed yet)." >&2; exit 1 ;;
esac

# The response is the session payload. Keep it in one place: python does the parsing AND builds the
# snippet, so the JSON is never reassembled by hand in shell.
printf '%s' "$RESP" | JS_ONLY="$JS_ONLY" APP="$APP" STORE="$STORE" KEY="$KEY" python3 -c '
import json, os, sys
r = json.load(sys.stdin)
app, store, key, js_only = os.environ["APP"], os.environ["STORE"], os.environ["KEY"], os.environ["JS_ONLY"] == "1"

if not r.get("ok"):
    sys.stderr.write("gxdevlogin: " + str(r.get("error", "refused")) + "\n")
    code = r.get("code", "")
    if code == "no_access":
        sys.stderr.write("  The dev viewer needs a grant on this app. Master Control -> app_access.\n")
    elif code == "not_viewer":
        sys.stderr.write("  Set its role back to viewer. This route only ever issues a read-only session.\n")
    sys.exit(1)

# The session object each app expects, in the shape its own sign-in writes.
sess = {
    "token": r["token"], "user": r["user"], "role": r["role"],
    "displayName": r.get("displayName", ""), "expiresAt": r.get("expiresAt", ""),
    "canEdit": False, "devSession": True,
}
# Leaderboard names the store fields differently; harmless elsewhere, so it is not special-cased.
sess["storeId"] = r.get("store", "")
sess["store"]   = r.get("store", "")

if app == "crew":
    # crew keeps a bare token string and a separate user string, not one JSON blob.
    snippet = "sessionStorage.setItem(%s,%s);sessionStorage.setItem(%s,%s);location.reload()" % (
        json.dumps(key), json.dumps(r["token"]), json.dumps("gx_crew_user"), json.dumps(r["user"]))
else:
    snippet = "%s.setItem(%s,%s);location.reload()" % (store, json.dumps(key), json.dumps(json.dumps(sess)))

if js_only:
    print(snippet)
else:
    print("Read-only dev session for %s — expires %s" % (app, r.get("expiresAt", "?")))
    print("Run this in the browser on the app, and it will reload signed in:")
    print()
    print(snippet)
    print()
    print("viewer / read-only: every write gate in the suite will refuse it, which is the point.")
'
