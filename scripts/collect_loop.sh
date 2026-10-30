#!/usr/bin/env bash
# Collect every $INTERVAL seconds for about $MINUTES minutes and push each change.
# Most checks use the small vote feed (--quick); every $FULL_EVERY checks it reads the
# full page again for names and new projects. If a push is rejected (someone else
# pushed), the runner resets to the remote branch and collects again on top of it.
set -uo pipefail

MINUTES=${MINUTES:-330}
INTERVAL=${INTERVAL:-30}
FULL_EVERY=${FULL_EVERY:-20}
BRANCH=${BRANCH:-main}
STRICT=${STRICT:-}
end=$(( $(date +%s) + MINUTES * 60 ))
changed=false
failed=0
n=0

while :; do
  started=$(date +%s)
  mode=--quick
  (( n % FULL_EVERY == 0 )) && mode=
  for attempt in 1 2 3; do
    python collector/collect.py $mode $STRICT || failed=1
    git add data
    if git diff --cached --quiet; then
      break
    fi
    git commit -q -m "Update vote data"
    if git push -q origin "HEAD:$BRANCH"; then
      changed=true
      break
    fi
    echo "Push rejected (attempt $attempt); syncing with origin/$BRANCH and collecting again"
    git fetch -q origin "$BRANCH" && git reset -q --hard "origin/$BRANCH"
  done
  n=$(( n + 1 ))
  if (( $(date +%s) + INTERVAL >= end )); then
    break
  fi
  # Keep a steady rhythm: subtract the time this check took.
  wait=$(( INTERVAL - ($(date +%s) - started) ))
  (( wait > 0 )) && sleep "$wait"
done

echo "changed=$changed" >> "${GITHUB_OUTPUT:-/dev/null}"
if [[ -n "$STRICT" && $failed -ne 0 ]]; then
  echo "::error::At least one collection failed. See the warnings above and data/status.json."
  exit 1
fi
