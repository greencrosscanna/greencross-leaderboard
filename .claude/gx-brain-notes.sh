#!/bin/sh
# SessionStart hook: surface any Pending notes the GX Command Center (brain) left for this app's chat.
# Prints the "## Pending" section of BRAIN_NOTES.md (up to the next "## " heading) if it has content.
f="BRAIN_NOTES.md"
[ -f "$f" ] || exit 0
body=$(awk '/^## Pending/{p=1;next} /^## /{p=0} p' "$f")
if printf '%s' "$body" | grep -q '[^[:space:]]'; then
  printf '📋 Notes from the GX Command Center — see BRAIN_NOTES.md (Pending):\n%s\n' "$body"
fi
exit 0
