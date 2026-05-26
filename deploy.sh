#!/usr/bin/env bash
# deploy.sh — build, push GAS backend, commit & push frontend to GitHub Pages
# Usage: ./deploy.sh "optional commit message"
set -e

DEPLOY_ID="AKfycbxXqtL-rKjuzFQkyADWnHGEoM2ZSYp9g4t1J6vhyDTgHcfkEuQocYrN9DXV7_84Masuqg"
MSG="${1:-deploy}"

cd "$(dirname "$0")"

# 0. Generate version.js from git commit count (auto-increments every deploy)
BUILD=$(git rev-list --count HEAD)
echo "window.GC = window.GC || {}; GC.VERSION = 'v1.${BUILD}';" > src/version.js
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
clasp deploy --deploymentId "$DEPLOY_ID" --description "$MSG"

# 3. Restore the dev index.html from our saved copy (not git — preserves uncommitted edits)
echo "▶ Pushing to GitHub..."
cp index.html.dev index.html        # restore the dev version
git add -u                          # stage all modified tracked files
git commit -m "$MSG

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" || echo "  Nothing new to commit."
git push origin main

echo "✅ Done — GitHub Pages + GAS both updated."
