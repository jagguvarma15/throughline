#!/usr/bin/env bash
# Proves a run survives `kill -9` mid-execution and resumes from the journal with no
# duplicate model calls or side effects, then pauses for human approval before publishing.
# Requires a prior build:  pnpm --filter @throughline/example-deep-research build
set -euo pipefail

export THROUGHLINE_DB="$(mktemp -d)/deep-research.db"
# Short lease so a killed worker's orphaned lease expires quickly and another worker reclaims.
export THROUGHLINE_LEASE_MS=1500
echo "store: $THROUGHLINE_DB  (lease ${THROUGHLINE_LEASE_MS}ms)"

W1="" W2=""
cleanup() { kill "$W1" "$W2" 2>/dev/null || true; }
trap cleanup EXIT

# Poll a run until its top-level status equals $1 (2-space indent = the workflow, not a step).
wait_for_status() {
  local want="$1" id="$2" i out
  for ((i = 0; i < 150; i++)); do
    out=$(node dist/run.js status "$id" 2>/dev/null || true)
    if printf '%s' "$out" | grep -qE "^  \"status\": \"$want\""; then return 0; fi
    sleep 0.2
  done
  echo "TIMED OUT waiting for status=$want"; printf '%s\n' "$out"; exit 1
}

ID=$(node dist/run.js start "quantum error correction")
echo "started run: $ID"

# First worker: let it commit a couple of steps, then hard-kill it mid-run.
node dist/run.js work & W1=$!
sleep 2
kill -9 "$W1" 2>/dev/null || true
echo "kill -9'd worker 1 mid-run"

# Second worker resumes from the journal and replays completed steps without re-running them.
node dist/run.js work & W2=$!
echo "worker 2 resuming; waiting for it to reach the approval gate..."
wait_for_status waiting "$ID"

echo "run parked for human approval; approving publish"
node dist/run.js approve "$ID"
wait_for_status completed "$ID"

echo
echo "--- final state ---"
FINAL=$(node dist/run.js status "$ID")
printf '%s\n' "$FINAL"

# Self-check: completed, no step key ran twice, the report published exactly once.
dupes=$(printf '%s' "$FINAL" | grep -oE '"stepKey": "[^"]+"' | sort | uniq -d || true)
publishes=$(printf '%s' "$FINAL" | grep -c '"stepKey": "publish-report' || true)
echo
if printf '%s' "$FINAL" | grep -qE '^  "status": "completed"' && [ -z "$dupes" ] && [ "$publishes" = "1" ]; then
  echo "PASS: killed mid-run, resumed from the journal, and completed."
  echo "      Every step ran exactly once; the report published exactly once."
else
  echo "FAIL: durability check did not hold"
  echo "  duplicate step keys: ${dupes:-none}"
  echo "  publish-report steps: $publishes"
  exit 1
fi
