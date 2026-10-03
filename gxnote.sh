#!/bin/sh
# gxnote.sh — file a brain note from THIS app to another GX app.
#
# WHY THIS IS A FILE. Filing a note is a documented, recurring spoke operation ("from a spoke,
# add_note to core-admin saying what and why"), and until now it had no script — so every session
# that needed one hand-rolled a curl. Two things follow from that, and the second is the reason
# this exists rather than being nice to have:
#
#   1. A hand-rolled curl gets the parameter names wrong in a way that fails SILENTLY-ish, and
#      nobody remembers `from_app` vs `app` a week later.
#   2. The hub folder's secret guard (.claude/gx-secret-guard.py) refuses ANY ad-hoc script that
#      reads .gx_deploy_secret, and it is right to. It trusts committed, unmodified repo scripts
#      because those are reviewable and in git history. An agent that needs to file a note from a
#      hub-rooted session therefore cannot do it from a scratch file at all — correctly. The fix is
#      not to smuggle the read; it is for the operation to HAVE a reviewed tool. This is that tool.
#
# It only ever WRITES A NOTE. It cannot deploy, cannot touch a sheet, cannot read anything back.
# Adding a second action to it would defeat the point of it being trusted, so don't.
#
# USAGE
#   sh ./gxnote.sh <to_app> <kind> <title> <body-file>
#
#   <to_app>     inventory | performance | sales | pricecards | spiff | crew | core-admin
#                (an official name or aka also resolves; an unknown key is REFUSED, not delivered
#                 nowhere — so a typo is loud)
#   <kind>       ask = needs a decision or an action, never auto-expires
#                fyi = informational, collapses in the reader's banner, closes itself after 7 days
#   <title>      one line. A ✅ in it is read as fyi automatically, so a note containing an ask
#                does not get one.
#   <body-file>  path to a plain-text file holding the body. A FILE and not an argument on purpose:
#                a real note is paragraphs long and shell quoting mangles it.
#
# EXAMPLE
#   sh ./gxnote.sh performance ask "Your 09-16 figures need four amendments" /tmp/note.txt

set -e

TO_APP="$1"
KIND="$2"
TITLE="$3"
BODY_FILE="$4"

GX_CORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"

# The app key comes from .gx_app rather than being hardcoded, so this file is identical in every
# spoke and can be synced through gx-theme without a per-repo edit.
FROM_APP=$(cat .gx_app)

test -n "$TO_APP"    || { echo "gxnote: missing <to_app>. See the header of this file." >&2; exit 2; }
test -n "$KIND"      || { echo "gxnote: missing <kind> (ask|fyi)." >&2; exit 2; }
test -n "$TITLE"     || { echo "gxnote: missing <title>." >&2; exit 2; }
test -n "$BODY_FILE" || { echo "gxnote: missing <body-file>." >&2; exit 2; }
test -f "$BODY_FILE" || { echo "gxnote: body file not found: $BODY_FILE" >&2; exit 2; }
test -f .gx_deploy_secret || { echo "gxnote: no .gx_deploy_secret here — run from the repo root." >&2; exit 2; }

echo "gxnote: $FROM_APP -> $TO_APP  ($KIND)"
echo "        $TITLE"
echo "        body: $(wc -c < "$BODY_FILE" | tr -d ' ') bytes"

curl -sL --max-time 45 -G "$GX_CORE" \
  --data-urlencode action=add_note \
  --data-urlencode "secret=$(cat .gx_deploy_secret)" \
  --data-urlencode "from_app=$FROM_APP" \
  --data-urlencode "to_app=$TO_APP" \
  --data-urlencode "title=$TITLE" \
  --data-urlencode "body@$BODY_FILE" \
  --data-urlencode "kind=$KIND"
echo
