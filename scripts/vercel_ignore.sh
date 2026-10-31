#!/usr/bin/env bash
# Vercel "Ignored Build Step": exit 0 skips this deployment, exit 1 builds it.
# Build when anything outside data/ changed since the last successful deployment, so the
# collector's frequent data-only commits don't use up deploys (the page reads live data
# from GitHub anyway). Always build the first deployment.
prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [[ -z "$prev" ]]; then
  echo "No previous deployment: building."
  exit 1
fi
# Vercel clones shallowly; fetch enough history to reach the last deployed commit.
if ! git cat-file -e "${prev}^{commit}" 2>/dev/null; then
  git fetch -q --deepen=5000 origin 2>/dev/null || true
fi
if git cat-file -e "${prev}^{commit}" 2>/dev/null; then
  if git diff --quiet "$prev" HEAD -- . ':(exclude)data'; then
    echo "Only vote data changed since ${prev:0:7}: skipping."
    exit 0
  fi
  echo "Site files changed since ${prev:0:7}: building."
  exit 1
fi
# Couldn't reach the last deployed commit: fall back to checking just this commit.
if git diff --quiet HEAD^ HEAD -- . ':(exclude)data' 2>/dev/null; then
  echo "Only vote data in this commit: skipping."
  exit 0
fi
echo "Building."
exit 1
