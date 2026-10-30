#!/usr/bin/env bash
# Collect every $INTERVAL seconds for about $MINUTES minutes and push each change.
# Most checks use the small vote feed (--quick); every $FULL_EVERY checks it reads the
# full page again for names and new projects. If a push is rejected (someone else
# pushed), the runner resets to the remote branch and collects again on top of it.
#
# Removed projects and vote drops are batched and posted to the repository's
# "Vote alerts" issue (at most every $ALERT_EVERY seconds), so GitHub emails and
# pushes them to the owner even when nobody has the dashboard open.
set -uo pipefail

MINUTES=${MINUTES:-330}
INTERVAL=${INTERVAL:-30}
FULL_EVERY=${FULL_EVERY:-20}
ALERT_EVERY=${ALERT_EVERY:-300}
BRANCH=${BRANCH:-main}
STRICT=${STRICT:-}
ALERTS=${ALERTS_FILE:-${RUNNER_TEMP:-/tmp}/vote-alerts.md}
end=$(( $(date +%s) + MINUTES * 60 ))
changed=false
failed=0
n=0
last_alert=0
: > "$ALERTS"

post_alerts() {
  [[ -s "$ALERTS" && -n "${GH_TOKEN:-}" ]] || return 0
  local issue
  issue=$(gh issue list --state open --search "Vote alerts in:title" --json number,title \
          --jq '[.[] | select(.title == "Vote alerts")][0].number // empty' 2>/dev/null)
  if [[ -z "$issue" ]]; then
    { echo "Projects removed from the ballot and vote drops, posted by the collector."
      echo "Subscribe to this issue to get every alert by email or in the GitHub app."
      echo; cat "$ALERTS"; } > "$ALERTS.body"
    gh issue create --title "Vote alerts" --body-file "$ALERTS.body" >/dev/null && : > "$ALERTS"
  else
    gh issue comment "$issue" --body-file "$ALERTS" >/dev/null && : > "$ALERTS"
  fi
  last_alert=$(date +%s)
}

while :; do
  started=$(date +%s)
  mode=--quick
  (( n % FULL_EVERY == 0 )) && mode=
  for attempt in 1 2 3; do
    python collector/collect.py $mode $STRICT --alerts-file "$ALERTS" || failed=1
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
  if (( $(date +%s) - last_alert >= ALERT_EVERY )); then
    post_alerts
  fi
  if (( $(date +%s) + INTERVAL >= end )); then
    break
  fi
  # Keep a steady rhythm: subtract the time this check took.
  wait=$(( INTERVAL - ($(date +%s) - started) ))
  (( wait > 0 )) && sleep "$wait"
done
post_alerts

echo "changed=$changed" >> "${GITHUB_OUTPUT:-/dev/null}"
if [[ -n "$STRICT" && $failed -ne 0 ]]; then
  echo "::error::At least one collection failed. See the warnings above and data/status.json."
  exit 1
fi
