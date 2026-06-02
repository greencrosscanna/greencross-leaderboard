#!/usr/bin/env bash
# watch_deploy.sh — polls GitHub Pages until the pushed commit is live, then notifies.
# Usage: bash watch_deploy.sh <full-commit-sha> [version-label]
# Spawned automatically by deploy.sh; exits 0 on success, 1 on timeout.

SHA="$1"
LABEL="${2:-deployed}"
SHORT="${SHA:0:8}"
REPO="greencrosscanna/greencross-leaderboard"
MAX_TRIES=24   # 24 × 15 s = 6 min max wait

echo "[watch] waiting for Pages build of $SHORT …"

for i in $(seq 1 $MAX_TRIES); do
  sleep 15

  RESULT=$(gh api "repos/$REPO/pages/builds?per_page=1" 2>/dev/null | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  b = d[0] if d else {}
  print(b.get('status',''), b.get('commit','')[:8])
except:
  print('error unknown')
")
  BUILD_STATUS=$(echo "$RESULT" | awk '{print $1}')
  BUILD_SHA=$(echo "$RESULT"   | awk '{print $2}')

  echo "[watch] attempt $i: status=$BUILD_STATUS sha=$BUILD_SHA"

  if [ "$BUILD_STATUS" = "built" ] && [ "$BUILD_SHA" = "$SHORT" ]; then
    # macOS desktop notification (audible)
    osascript -e "display notification \"Cmd+Shift+R to see $LABEL\" with title \"✅ Pages live\" sound name \"Glass\"" 2>/dev/null || true
    # Signal to Claude monitor (stdout line picked up by Monitor tool)
    echo "PAGES_LIVE:$SHORT:$LABEL"
    exit 0
  fi

  if [ "$BUILD_STATUS" = "errored" ]; then
    osascript -e "display notification \"Check GitHub for details\" with title \"❌ Pages build failed\" sound name \"Basso\"" 2>/dev/null || true
    echo "PAGES_ERROR:$SHORT:$LABEL"
    exit 1
  fi
done

osascript -e "display notification \"Did not finish in 6 min — check GitHub\" with title \"⚠️ Pages timeout\" sound name \"Basso\"" 2>/dev/null || true
echo "PAGES_TIMEOUT:$SHORT:$LABEL"
exit 1
