#!/usr/bin/env bash
# ─── gxengine — deploy this app's Apps Script engine, and RECORD what was deployed ───────────────
# Source of truth: greencross-gx-theme/gxengine.sh. Synced into spokes by gx-sync.sh.
#
#   ./gxengine.sh                 show what would ship, change nothing
#   ./gxengine.sh --deploy        push, redeploy the EXISTING id, record the sha
#
# WHY THIS EXISTS
# Deploying an engine was three commands held in someone's head: clasp push, clasp update-deployment,
# and then nothing at all recorded which commit went out. On 2026-08-22 five spokes were redeployed
# and answering "what is actually running" meant reading deployment descriptions and guessing which
# commit they matched -- the guess was wrong twice.
#
# The recording is INSIDE the deploy, not beside it. A separate "remember to record" step fails the
# same way the redeploy itself fails: it is the second command, and the second command is the one
# that gets skipped. That is exactly why core_pins was empty before it existed.
#
# NEVER creates a deployment. `clasp deploy` without an id mints a NEW /exec URL and orphans every
# caller -- config keys, hardcoded proxies, the lot. This only ever updates the id already serving.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"   # before any cd; $0 is usually relative
cd "$SCRIPT_DIR"

GXCORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"
APP="performance"
DEPLOY=0; for a in "$@"; do [ "$a" = "--deploy" ] && DEPLOY=1; done

command -v clasp >/dev/null 2>&1 || { echo "✗ clasp not on PATH"; exit 1; }
[ -f .clasp.json ] || { echo "✗ no .clasp.json here — is this an engine repo?"; exit 1; }

# ── Which deployment is live? ────────────────────────────────────────────────────────────────────
# @HEAD is a dev deployment and must never be the target.
#
# THIS USED TO GUESS, AND THE GUESS WAS WRONG. The old rule was "among the non-HEAD deployments take
# the highest @version". That is not what "live" means — it is just the most recently CUT deployment,
# which may be a stray nobody calls. Caught in greencross-sales on 2026-08-23: the id every caller
# uses (hardcoded as DEFAULT_PROXY in index.html) sat at @158 while an orphaned deployment sat at
# @159, so --deploy would have pushed HEAD, redeployed the STRAY, recorded a sha to core_pins, and
# printed success — while the live /exec kept serving the old library pin. A silent no-op that
# reports a deploy is worse than a failed one, and re-running does not recover it.
#
# The header above already promised "if there is more than one plausible candidate, SAY SO and stop
# rather than pick". The code did the opposite. Now it does what the comment says.
#
# THE FIX: ask who is actually called, do not rank. An id that appears BOTH in this repo's own source
# and in this project's deployment list is, by definition, the one this app talks to. That
# intersection is self-correcting — GX Core's /exec id appears in every spoke's source but is never
# in the spoke's OWN deployment list, so it drops out for free, no exclusion list to rot.
DEPLOYS="$(clasp deployments 2>/dev/null | grep -oE '^- AKfycb[A-Za-z0-9_-]+ @[0-9]+' || true)"
[ -n "$DEPLOYS" ] || { echo "✗ no versioned deployment found (only @HEAD?). Refusing to create one."; exit 1; }

# Ids this repo's own frontend/engine source actually points at.
REPO_IDS="$(grep -rhoE 'AKfycb[A-Za-z0-9_-]{20,}' . \
              --include='*.html' --include='*.gs' --include='*.js' --include='*.json' 2>/dev/null | sort -u)"
# Intersect with this project's real deployments.
MATCHED=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  id="$(printf '%s' "$line" | awk '{print $2}')"
  printf '%s\n' "$REPO_IDS" | grep -qx "$id" && MATCHED="${MATCHED}${line}
"
done <<EOF
$DEPLOYS
EOF
MATCHED="$(printf '%s' "$MATCHED" | grep -v '^$' || true)"
NMATCH="$(printf '%s\n' "$MATCHED" | grep -c 'AKfycb' || true)"
NDEPLOY="$(printf '%s\n' "$DEPLOYS" | grep -c 'AKfycb' || true)"

if [ "${NMATCH:-0}" = "1" ]; then
  TARGET="$(printf '%s\n' "$MATCHED" | awk '{print $2}')"
  CURVER="$(printf '%s\n' "$MATCHED" | grep -oE '@[0-9]+' | tr -d '@')"
  HOW="referenced by this repo's source"
elif [ "${NMATCH:-0}" -gt 1 ]; then
  echo "✗ this repo references ${NMATCH} of its own deployments — cannot tell which one is live:"
  printf '%s\n' "$MATCHED" | sed 's/^- /    /'
  echo "  Refusing to guess. Deploying over the wrong id is not recoverable by re-running."
  echo "  Pass the right one explicitly:  GX_DEPLOY_ID=AKfycb... ./gxengine.sh --deploy"
  exit 1
elif [ "${NDEPLOY:-0}" = "1" ]; then
  # No source reference, but only one candidate exists — no ambiguity to resolve.
  TARGET="$(printf '%s\n' "$DEPLOYS" | awk '{print $2}')"
  CURVER="$(printf '%s\n' "$DEPLOYS" | grep -oE '@[0-9]+' | tr -d '@')"
  HOW="the only versioned deployment"
else
  echo "✗ ${NDEPLOY} versioned deployments exist and NONE is referenced by this repo's source."
  echo "  The old 'highest @version wins' rule would pick one here, and in greencross-sales on"
  echo "  2026-08-23 that rule would have picked a stray while the real /exec kept serving stale code."
  printf '%s\n' "$DEPLOYS" | sort -t@ -k2 -n | sed 's/^- /    /'
  echo "  Refusing to guess. Pass it explicitly:  GX_DEPLOY_ID=AKfycb... ./gxengine.sh --deploy"
  exit 1
fi

# Explicit override always wins, and must still be a real deployment of THIS project.
if [ -n "${GX_DEPLOY_ID:-}" ]; then
  if ! printf '%s\n' "$DEPLOYS" | grep -q "$GX_DEPLOY_ID"; then
    echo "✗ GX_DEPLOY_ID=$GX_DEPLOY_ID is not a deployment of this project. Refusing."; exit 1
  fi
  TARGET="$GX_DEPLOY_ID"
  CURVER="$(printf '%s\n' "$DEPLOYS" | grep "$GX_DEPLOY_ID" | grep -oE '@[0-9]+' | tr -d '@')"
  HOW="GX_DEPLOY_ID override"
fi
echo "app        : $APP"
echo "deployment : $TARGET @$CURVER  ($HOW)"

# ── What is about to ship? ───────────────────────────────────────────────────────────────────────
# The sha last recorded to core_pins is the only reliable answer to "what is running", because it was
# written BY the deploy rather than inferred from a deployment description afterwards.
LAST_SHA="$(curl -sL --max-time 15 "$GXCORE?action=core_pins" 2>/dev/null | python3 -c "
import json,sys
try: pins=json.load(sys.stdin).get('pins',[])
except Exception: pins=[]
print(next((p.get('deployed_sha','') for p in pins if p.get('app')=='$APP'), ''))" 2>/dev/null)"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
BRANCH="$(git branch --show-current 2>/dev/null || echo '?')"
echo "branch     : $BRANCH"
echo "HEAD       : ${HEAD_SHA:0:9}"

if [ -n "$LAST_SHA" ]; then
  echo "last deploy: ${LAST_SHA:0:9}"
  if [ "$LAST_SHA" = "$HEAD_SHA" ]; then
    echo
    echo "Nothing new since the last recorded deploy."
  else
    echo
    echo "Commits since the last recorded deploy:"
    git log --oneline "$LAST_SHA..HEAD" 2>/dev/null | sed 's/^/  /' || echo "  (that sha is not in this repo — history rewritten?)"
  fi
else
  echo "last deploy: (never recorded — this is the first gxengine deploy for $APP)"
fi

[ "$DEPLOY" = "1" ] || { echo; echo "Dry run. Re-run with --deploy to push and redeploy."; exit 0; }

# ── Deploy ───────────────────────────────────────────────────────────────────────────────────────
[ -n "$(git status --porcelain 2>/dev/null | grep -v '^??')" ] && {
  echo; echo "✗ uncommitted tracked changes — commit first, or the recorded sha will be a lie."; exit 1; }

echo; echo "Pushing…"
clasp push --force || { echo "✗ clasp push failed"; exit 1; }
clasp update-deployment "$TARGET" --description "${GX_NOTES:-deploy ${HEAD_SHA:0:9}}" || { echo "✗ redeploy failed"; exit 1; }

# ── Record — same command, so it cannot be skipped ───────────────────────────────────────────────
SECRET_FILE="$SCRIPT_DIR/.gx_deploy_secret"
if [ ! -f "$SECRET_FILE" ]; then
  echo "! no .gx_deploy_secret — deployed, but NOT recorded to core_pins."
  exit 0
fi
# Ask the app what it now runs. Warm instances can serve the old snapshot briefly, so poll rather than
# trust the first answer -- sales took ~2 minutes on 2026-08-22.
# Try BOTH conventions. Crew already published cfg.crewEngineUrl long before this script invented
# cfg.<app>ExecUrl, and inventing a second name for a key that exists is how pricecards/pricetags
# broke the auth gate and the dev-server port on the same day. Check the established name first.
for _k in "cfg.${APP}EngineUrl" "cfg.${APP}ExecUrl"; do
EXEC_URL="$(curl -sL --max-time 12 "$GXCORE?action=config&key=$_k" 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); v=d.get('value') or ''
    print(v if d.get('ok') and str(v).startswith('https://') else '')
except Exception: print('')" 2>/dev/null)"
  [ -n "$EXEC_URL" ] && break
done
# WHAT THE ANSWER SHOULD BE: the GXCore version this repo pins, read from the manifest clasp just
# pushed. Located via .clasp.json's rootDir because the spokes disagree — crew and spiff keep theirs
# in apps-script/, the rest at the repo root.
ROOT_DIR="$(python3 -c "
import json
try: print(json.load(open('.clasp.json')).get('rootDir') or '.')
except Exception: print('.')" 2>/dev/null)"
WANT_LV="$(python3 -c "
import json, os
try:
    d = json.load(open(os.path.join('''$ROOT_DIR''', 'appsscript.json')))
    for l in (d.get('dependencies') or {}).get('libraries') or []:
        if l.get('userSymbol') == 'GXCore': print(int(l.get('version'))); break
except Exception: pass" 2>/dev/null)"

# POLL UNTIL THE ANSWER IS THE VERSION WE JUST PINNED — not until the app answers at all.
#
# This used to break on the first SUCCESSFUL read, and a warm Apps Script instance serving the
# pre-deploy snapshot is a successful read. It answers with the OLD version, both loops break, and
# that number is recorded as what the app is running. The 12 attempts only ever protected against no
# answer; the stale-but-present case is the one that actually fires, and it is worse, because an
# empty read prints a warning while a stale read records a wrong number and looks like a clean deploy.
#
# Measured 2026-09-04 (crew): gxengine recorded lib_version 299 at 03:07:16 with the correct sha;
# health calls at 03:07:31, :33 and :35 answered 299, 300, 300. The instance flipped seconds later.
# core_pins is documented here and in the hub CLAUDE.md as the only reliable answer to what an app is
# running — a systematically stale value defeats the whole point, and it is intermittent (inventory
# recorded 300 correctly minutes earlier), which is how it gets explained away as "it'll catch up".
#
# There is now a real wait between attempts. The old loop retried instantly, so 12 attempts elapsed in
# about as long as one; the warm window is a minute or two, so a retry that does not wait cannot span it.
LV=""; LV_SEEN=""
if [ -n "$EXEC_URL" ]; then
  for _ in $(seq 1 12); do
    READ=""
    for route in libversion health; do
      READ="$(curl -sL --max-time 12 "$EXEC_URL?action=$route" 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
for k in ('gxcore','lib','lib_version'):
    if isinstance(d.get(k),(int,float)): print(int(d[k])); break" 2>/dev/null)"
      [ -n "$READ" ] && break
    done
    if [ -n "$READ" ]; then
      LV_SEEN="$READ"
      # No manifest pin to compare against (an unbound engine): the first answer is all there is.
      { [ -z "$WANT_LV" ] || [ "$READ" = "$WANT_LV" ]; } && { LV="$READ"; break; }
    fi
    sleep 5
  done
fi
ROWS="[{\"app\":\"$APP\",\"deployed_sha\":\"$HEAD_SHA\"$([ -n "$LV" ] && echo ",\"lib_version\":$LV")}]"
if [ -z "$LV" ]; then
  # Name BOTH keys. This message used to blame only cfg.<app>ExecUrl even though the loop above tries
  # cfg.<app>EngineUrl FIRST — so a sales deploy whose EngineUrl was present and correct produced
  # "no cfg.salesExecUrl", and the session reading it concluded a config key was missing and asked
  # core-admin to add one. Nothing was missing. The likely cause is the one documented above: a warm
  # Apps Script instance serves the old snapshot for a minute or two after a redeploy, so the poll
  # right after deploying can come back empty. An error that names the wrong cause costs somebody a
  # real investigation.
  if [ -n "$LV_SEEN" ]; then
    # The app ANSWERED, just never with the version we pinned. Recording LV_SEEN here is precisely
    # the bug this loop was rewritten for, so the version is deliberately left unrecorded: a gap you
    # can see beats a number you cannot trust.
    echo "! this app answered, but never with the version this repo pins."
    echo "  pinned in appsscript.json: v${WANT_LV:-?}   last live answer: v$LV_SEEN"
    echo "  Almost always a warm instance still serving the pre-deploy snapshot — it usually flips"
    echo "  within a minute. The sha is recorded; the VERSION is not, on purpose."
    echo "  Re-run ./gxpins.sh --record shortly, and check it reads v${WANT_LV:-?} before believing it."
  else
    echo "! could not read this app's live GXCore version."
    echo "  Tried cfg.${APP}EngineUrl then cfg.${APP}ExecUrl. Either neither key is set, or the route"
    echo "  did not answer — most often a warm instance still serving the pre-deploy snapshot."
    echo "  Recording the sha without it; run ./gxpins.sh --record in a minute or two."
  fi
fi
RESP="$(curl -sL --max-time 20 -G "$GXCORE" \
  --data-urlencode action=record_pins \
  --data-urlencode "secret=$(tr -d '\r\n' < "$SECRET_FILE")" \
  --data-urlencode "by=gxengine@$(hostname -s 2>/dev/null || echo local)" \
  --data-urlencode "rows=$ROWS" 2>/dev/null)"
echo "recorded   : $RESP"
echo "✓ $APP deployed at ${HEAD_SHA:0:9}${LV:+, running GXCore v$LV}"
