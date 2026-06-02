#!/usr/bin/env bash
# deploy.sh — build, push GAS backend, commit & push frontend to GitHub Pages
# Usage: ./deploy.sh "optional commit message"
set -e

DEPLOY_ID="AKfycbxXqtL-rKjuzFQkyADWnHGEoM2ZSYp9g4t1J6vhyDTgHcfkEuQocYrN9DXV7_84Masuqg"
MSG="${1:-deploy}"

cd "$(dirname "$0")"

# 0. Stamp version (git commit count) directly into index.html so the value is
#    baked into the committed source — identical on GitHub Pages and GAS.
#    (A standalone src/version.js was never loaded by index.html, so the badge
#    was frozen at its hardcoded fallback. We now rewrite that line in place.)
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

# 1. Inline all src/ CSS + JS into index.html.built (what GAS serves)
echo "▶ Building index.html.built..."
python3 - << 'PYEOF'
import re, os
base = os.path.dirname(os.path.abspath(__file__))

with open(f'{base}/index.html', 'r') as f:
    html = f.read()

def inline_css(m):
    href = re.search(r'href="([^"?]+)', m.group(0))
    if not href: return m.group(0)
    path = os.path.join(base, href.group(1))
    if not os.path.exists(path): return m.group(0)
    with open(path, 'r') as f: css = f.read()
    return f'<style>\n{css}\n</style>'

def inline_js(m):
    src = re.search(r'src="([^"?]+)', m.group(0))
    if not src: return m.group(0)
    path = os.path.join(base, src.group(1))
    if not os.path.exists(path): return m.group(0)
    with open(path, 'r') as f: js = f.read()
    return f'<script>\n{js}\n</script>'

html = re.sub(r'<link rel="stylesheet"[^>]+>', inline_css, html)
html = re.sub(r'<script src="[^"]+"></script>', inline_js, html)

with open(f'{base}/index.html.built', 'w') as f:
    f.write(html)
print(f"  Built {html.count(chr(10))} lines → index.html.built")
PYEOF

# 2. Push GAS backend. The web app also serves index.html (doGet with no action),
#    so GAS needs index.html = the built output during push. We swap it in, then
#    ALWAYS restore the dev version via an EXIT trap — even if clasp fails or the
#    script is interrupted (Ctrl-C) — so the working tree can never be left holding
#    the built file in place of the source.
echo "▶ Pushing to GAS..."
cp index.html index.html.dev        # canonical source (this is what gets committed)

# Bulletproof restore: fires on ANY exit path (success, set -e error, signal).
restore_index() { [ -f index.html.dev ] && cp index.html.dev index.html; }
trap restore_index EXIT INT TERM

cp index.html.built index.html      # swap built output in for the clasp push
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

# 3. Restore dev index.html, then disarm the trap (restoration confirmed done).
echo "▶ Pushing to GitHub..."
restore_index
trap - EXIT INT TERM

# Safety guard: never commit a corrupted/empty index.html. The version marker is
# present in every valid source file; its absence means the restore failed.
if ! grep -q "GC.VERSION = 'v1\." index.html; then
  echo "❌ index.html is missing its version marker — restore failed."
  echo "   Aborting commit to protect the source. Recover with: git checkout index.html"
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
