#!/usr/bin/env bash
# Phase 2: replay Franco's end-to-end scenarios against the deployed Vienna, one at a time.
# Scenario 13 (daily summary) is cron-only at 21:00 Edmonton and is not replayable here.
cd "$(dirname "$0")/.."
OUT=${1:-docs/patent/phase2/franco-scenarios-$(git rev-parse --short HEAD).log}
: > "$OUT"
echo "=== scenario 1 ===" | tee -a "$OUT"; node scripts/replay-scenario1-katherine.js >> "$OUT" 2>&1; echo "exit $?" >> "$OUT"
for id in 2 3 4 5 6 7 8 9 10 11 12 14 15; do
  echo "=== scenario $id ===" | tee -a "$OUT"
  node scripts/replay-scenarios-2to15.js "$id" >> "$OUT" 2>&1
  echo "exit $?" >> "$OUT"
done
echo "done → $OUT"
