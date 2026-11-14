#!/usr/bin/env bash
# Deploy exactly the committed HEAD to Fly — never the working tree.
# `fly deploy` uploads the local directory, so an in-progress edit could ship; this exports
# HEAD with `git archive` into a temp dir and deploys that. Refuses to run on a dirty tree.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "deploy.sh: uncommitted changes — commit first (only HEAD is deployed)." >&2; exit 1
fi
SHA=$(git rev-parse --short HEAD)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git archive HEAD | tar -x -C "$TMP"
echo "deploying $SHA from a clean export"
(cd "$TMP" && fly deploy --app vienna-undrwrite --remote-only --ha=false --image-label "$SHA")
curl -s -m 30 https://vienna-undrwrite.fly.dev/health; echo
