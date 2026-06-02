#!/usr/bin/env bash
# deploy.sh — stamp version, push to GAS, commit & push to GitHub Pages.
# Usage: ./deploy.sh "optional commit message"
#
# index.html is a self-contained monolith (all CSS/JS inline). GAS serves it
# verbatim via doGet → createHtmlOutputFromFile('index'); GitHub Pages serves the
# same file. There is NO build step — clasp pushes index.html directly, so there
# is no dev/built swap and nothing that can corrupt the working tree on failure.
# (src/fixtures/*.json remain for USE_FIXTURES demo mode; the old src/*.js|css
#  module files were stale duplicates of the inline code and have been removed.)
set -e

DEPLOY_ID="AKfycbxXqtL-rKjuzFQkyADWnHGEoM2ZSYp9g4t1J6vhyDTgHcfkEuQocYrN9DXV7_84Masuqg"
MSG="${1:-deploy}"

cd "$(dirname "$0")"

# 0. Stamp version (git commit count) directly into index.html so the value is
#    baked into the committed source — identical on GitHub Pages and GAS.
BUILD=$(git rev-list --count HEAD)
python3 - "$BUILD" << 'PYEOF'
import re, sys, os
base = os.path.dirname(os.path.abspath(__file__))
ver  = 'v1.' + sys.argv[1]
path = os.path.join(base, 'index.html')
with open(path) as f: html = f.read()
new = re.sub(
    r"(window\.GC = window\.GC \|\| \{\}; GC\.VERSION = ')v1\.\d+(';)",
    lambda m: m.group(1) + ver + m.group(2),
    html, count=1)
with open(path, 'w') as f: f.write(new)
print('  Stamped ' + ver + ' into index.html')
PYEOF
echo "▶ Version: v1.${BUILD}"

# 1. Push to GAS. .claspignore selects index.html + the *.gs backend files.
echo "▶ Pushing to GAS..."
clasp push --force

# Proactive version-limit warning. GAS retains at most 200 versions; prune old
# ones before hitting it. (Count of retained versions, not the max version number.)
VER_COUNT=$(clasp versions 2>/dev/null | grep -cE '^[0-9]+' || echo 0)
if [ "$VER_COUNT" -ge 180 ]; then
  echo "⚠️  GAS versions: ${VER_COUNT}/200 — prune soon at script.google.com →"
  echo "    Project Settings → Manage versions (delete the oldest) to avoid deploy failures."
fi

LATEST_VER=$(clasp versions 2>/dev/null | grep -E '^[0-9]+' | tail -1 | awk '{print $1}' || echo "200")
if clasp deploy --deploymentId "$DEPLOY_ID" --description "$MSG" 2>/dev/null; then
  echo "Deployed ${DEPLOY_ID} @ new version"
else
  echo "⚠️  Could not create a new GAS version (likely the 200-version limit)."
  echo "   → New backend code is in GAS HEAD but not yet live at the web-app URL."
  echo "   → Fix: script.google.com → Project Settings → Manage versions → delete oldest,"
  echo "     then re-run: bash deploy.sh"
  clasp deploy --deploymentId "$DEPLOY_ID" --versionNumber "$LATEST_VER" --description "$MSG (pinned)" 2>/dev/null \
    || echo "   (Could not redeploy to ${LATEST_VER} either — deployment unchanged)"
fi

# 2. Commit & push to GitHub Pages.
echo "▶ Pushing to GitHub..."
# Safety guard: never commit a corrupted/empty index.html. The version marker is
# present in every valid source file; its absence means something clobbered it.
if ! grep -q "GC.VERSION = 'v1\." index.html; then
  echo "❌ index.html is missing its version marker — aborting commit to protect the source."
  echo "   Recover with: git checkout index.html"
  exit 1
fi

git add -u                          # stage all modified tracked files
git commit -m "$MSG

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" || echo "  Nothing new to commit."
git push origin main

echo "✅ Done — GitHub Pages updated. GAS: see warnings above if version limit was hit."

# Launch background watcher — notifies (desktop + Claude) when Pages is actually live.
PUSHED_SHA=$(git rev-parse HEAD)
bash "$(dirname "$0")/watch_deploy.sh" "$PUSHED_SHA" "v1.${BUILD}" &
echo "👀 Watching Pages build for ${PUSHED_SHA:0:8} in background (PID $!)"
