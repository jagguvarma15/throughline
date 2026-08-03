# Working on Throughline

Guidance for AI coding agents (and new contributors) in this repository.

## Commands

```bash
pnpm install                       # workspace install (pnpm >= 10, node >= 20)
pnpm -r typecheck                  # tsc across every package
pnpm lint                          # biome check (CI fails on unformatted code)
pnpm exec biome check --write .    # format before committing
node scripts/check-forbidden-deps.mjs   # BYO-LLM dependency guard
pnpm -r test                       # vitest; Postgres suites need THROUGHLINE_TEST_PG
pnpm -r build                      # tsup dual ESM/CJS builds
```

Postgres tests: `THROUGHLINE_TEST_PG=postgres://throughline:throughline@localhost:5433/throughline`
after `docker compose up postgres` (or any Postgres 16).

## Repository map

- `packages/core` - the durable engine: `throughline()`, `ctx.step` replay, worker
  claim/heartbeat/finish loop, lease fencing, budgets, `createOps` facade.
- `packages/store-sqlite`, `packages/store-postgres` - sibling `Store` implementations;
  identical schema and semantics, proven by shared conformance suites.
- `packages/adapters-llm`, `packages/adapters-ai-sdk` - BYO-LLM seams.
- `packages/testing` - `defineStoreSuite` / `defineEngineSuite` conformance batteries,
  `faultStore` crash injection, golden traces. Every engine behavior change needs a
  case here so both stores prove it.
- `packages/cli` (`throughline`), `packages/mcp` (`throughline-mcp`) - ops surfaces.
- `apps/control-plane`, `apps/dashboard` - private reference deployment.
- `docs/guarantees.md` - THE CONTRACT. Code, tests, and this document must agree; fix
  the code or change the document and tests in the same commit. Never weaken a
  guarantee to make a test pass.

## Invariants you must not break

1. Only `ctx.step` bodies are durable; a completed journal row replays verbatim and its
   `fn` never re-runs. `UNIQUE(workflow_id, step_key)` is the backstop.
2. Delivery is at-least-once; exactly-once holds only for idempotency-keyed effects.
   Do not claim more.
3. Step ordinals are assigned synchronously at the call site, before any await.
4. Every worker write is fenced by `(worker_id, lease_epoch)`; on `LeaseLostError` the
   run is abandoned for re-claim, never marked dead, and a failed journal write after a
   successful `fn` must NOT retry `fn`.
5. `waitForEvent` is journal-first and consumes events atomically with journaling.
6. The determinism guard (kind mismatch at journal hits, unconsumed completed rows at
   completion) must stay concurrency-safe: no seq-order checks that would false-positive
   on `Promise.all`.
7. Published packages never depend on an LLM provider SDK (`scripts/check-forbidden-deps.mjs`).

## Conventions

- One commit per file, imperative messages, no emojis, no attribution trailers.
- Changesets: one minor changeset per behavior batch; all `@through-line/*` versions
  move in lockstep. npm publishing is a manual workflow dispatch.
- New engine behavior: add the test to `packages/testing` (not a single store's tests)
  so SQLite and Postgres both prove it.
