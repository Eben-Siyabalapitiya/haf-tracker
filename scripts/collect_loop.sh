#!/usr/bin/env bash
# Collect a snapshot every $INTERVAL seconds for about $MINUTES minutes and push each change.
# Used by .github/workflows/collect.yml. If a push is rejected (someone else pushed), the
# runner resets to the remote branch and collects again on top of it, so history is never lost.
set -uo pipefail

MINUTES=${MINUTES:-13}
INTERVAL=${INTERVAL:-180}
BRANCH=${BRANCH:-main}
STRICT=${STRICT:-}
end=$(( $(date +%s) + MINUTES * 60 ))
changed=false
failed=0

while :; do
  for attempt in 1 2 3; do
    python collector/collect.py $STRICT || failed=1
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
  if (( $(date +%s) + INTERVAL >= end )); then
    break
  fi
  sleep "$INTERVAL"
done

echo "changed=$changed" >> "${GITHUB_OUTPUT:-/dev/null}"
if [[ -n "$STRICT" && $failed -ne 0 ]]; then
  echo "::error::At least one collection failed. See the warnings above and data/status.json."
  exit 1
fi
