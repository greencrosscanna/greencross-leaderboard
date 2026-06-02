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

# 2. Push GAS backend (dutchie_proxy.gs + index.html.built as index.html)
echo "▶ Pushing to GAS..."
cp index.html index.html.dev        # save dev version before overwriting
cp index.html.built index.html
clasp push --force

# Try to create a new versioned deployment. GAS has a hard limit of 200 versions;
# if we hit it, fall back to redeploying the last known good version number so
# the deployment stays live. Run `clasp versions` to find the current max,
# then delete old versions at script.google.com → Project History to unblock.
LATEST_VER=$(clasp versions 2>/dev/null | grep -E '^[0-9]+' | tail -1 | awk '{print $1}' || echo "200")
if clasp deploy --deploymentId "$DEPLOY_ID" --description "$MSG" 2>/dev/null; then
  echo "Deployed ${DEPLOY_ID} @ new version"
else
  echo "⚠️  GAS version limit reached (200). Redeploying at version ${LATEST_VER}."
  echo "   → New backend code is in GAS HEAD but not yet live."
  echo "   → To fix: open script.google.com, open this project, go to"
  echo "     Project Settings → Manage versions and delete versions 1-180."
  echo "   → Then run: bash deploy.sh"
  clasp deploy --deploymentId "$DEPLOY_ID" --versionNumber "$LATEST_VER" --description "$MSG (pinned)" 2>/dev/null \
    || echo "   (Could not redeploy to ${LATEST_VER} either — deployment unchanged)"
fi

# 3. Restore the dev index.html from our saved copy (not git — preserves uncommitted edits)
echo "▶ Pushing to GitHub..."
cp index.html.dev index.html        # restore the dev version
git add -u                          # stage all modified tracked files
git commit -m "$MSG

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" || echo "  Nothing new to commit."
git push origin main

echo "✅ Done — GitHub Pages updated. GAS: see warnings above if version limit was hit."

# Launch background watcher — notifies (desktop + Claude) when Pages is actually live.
PUSHED_SHA=$(git rev-parse HEAD)
bash "$(dirname "$0")/watch_deploy.sh" "$PUSHED_SHA" "v1.${BUILD}" &
echo "👀 Watching Pages build for ${PUSHED_SHA:0:8} in background (PID $!)"
