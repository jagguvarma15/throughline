# Throughline benchmarks

Macro-benchmarks for the engine and stores. This package is private and never
published; it exists to keep the performance claims in the main README honest.

## Running

```bash
pnpm install
pnpm bench                 # all scenarios
pnpm bench --filter idle   # scenarios whose name contains "idle"
pnpm bench --quick         # reduced iteration counts for a fast sanity pass
pnpm bench --json out.json # also write structured results
```

Postgres scenarios read `THROUGHLINE_BENCH_PG` (falling back to
`THROUGHLINE_TEST_PG`, then the compose default on port 5444) and print a
skipped row when no database is reachable.

## Scenarios

- `step-throughput`: sequential no-op steps per second, single worker.
- `claim-contention`: claim latency percentiles while 1, 4, and 8 workers drain
  a seeded backlog (Postgres exercises FOR UPDATE SKIP LOCKED).
- `resume-cost`: time to resume a parked run as journal length grows; the
  per-step slope is the cost of the full-journal reload.
- `idle-qps`: claim queries per second while idle, fixed polling versus
  exponential backoff; on Postgres, also the wake-to-completion latency with
  LISTEN/NOTIFY active.
- `e2e-latency`: start-to-completion latency for one-step runs under a live
  worker, comparing polling with push wakeups.

Results are wall-clock measurements of real store I/O; run them on quiet
hardware and prefer comparing before/after on the same machine.
