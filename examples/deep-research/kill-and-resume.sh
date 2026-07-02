#!/usr/bin/env bash
# Manual demo: prove a run survives `kill -9` mid-execution and resumes with no duplicate
# model calls or side effects. Requires `pnpm --filter @throughline/example-deep-research build`.
set -euo pipefail

export THROUGHLINE_DB="$(mktemp -d)/deep-research.db"
echo "store: $THROUGHLINE_DB"

ID=$(node dist/run.js start "quantum error correction")
echo "started run: $ID"

node dist/run.js work & W1=$!
sleep 2
kill -9 "$W1" 2>/dev/null || true
echo "kill -9'd the worker mid-run"

node dist/run.js work & W2=$!
sleep 3
node dist/run.js approve "$ID"
sleep 2
kill "$W2" 2>/dev/null || true

echo "--- final state (resumed and completed, each step once) ---"
node dist/run.js status "$ID"
