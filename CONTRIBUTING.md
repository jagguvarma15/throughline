# Contributing to Throughline

Thanks for helping build a durable-execution library people can actually trust. The bar
for merging is simple: every durability claim must be *demonstrated by a test*, not
asserted in prose. [docs/guarantees.md](docs/guarantees.md) is the contract of record —
if your change alters execution semantics, update it in the same PR.

## Setup

```bash
# Node >= 20 and pnpm 10 (repo pins the version via packageManager)
pnpm install
```

## Everyday commands

```bash
pnpm -r typecheck        # TypeScript, no emit
pnpm lint                # Biome (CI fails on unformatted code — run `pnpm format` first)
pnpm -r build            # tsup, dual ESM/CJS + d.ts
pnpm -r test             # Vitest across all packages
pnpm check:deps          # forbidden-dependency guard (see below)
```

Postgres-backed tests skip cleanly when no database is reachable. To run them:

```bash
docker compose up -d postgres   # maps host port 5433
THROUGHLINE_TEST_PG=postgres://throughline:throughline@localhost:5433/throughline pnpm -r test
```

## The BYO-LLM rule

No published `@through-line/*` package may depend on an LLM **provider** SDK
(`openai`, `@anthropic-ai/*`, `@ai-sdk/openai`, ...). Provider bindings belong in the
application layer — `examples/` and `apps/`. The provider-neutral `ai` package is the
one allowed exception, in `@through-line/adapters-ai-sdk`. CI enforces this via
`scripts/check-forbidden-deps.mjs`.

## Testing conventions

- Engine/store semantics belong in the shared conformance suites
  (`@through-line/testing`'s `defineStoreSuite` / `defineEngineSuite`) so every store
  proves them, not just one.
- Crash behavior is tested with `faultStore` (injects a committed-write-then-lease-lost
  crash at step boundaries) and `controlledClock` — no sleeps, no flakes.
- Record/replay tests use golden traces (`toGolden`/`seedGolden`); refresh fixtures with
  `UPDATE_GOLDEN=1 pnpm -r test`.

## Versioning and releases

All `@through-line/*` packages version in lockstep. Version bumps are plain commits:
edit the `version` field in every `packages/*/package.json` to the same new value in
the release PR. The patch number is the count of commits on `main` since the previous
version commit. Publishing to npm is a separate, manually dispatched workflow
(`Release` in GitHub Actions), which builds, publishes with provenance, and creates
the unified `vX.Y.Z` tag and GitHub release.

## Pull requests

- Keep commits small and messages imperative ("Add X", "Fix Y").
- Match the surrounding code style; Biome settles formatting arguments.
- If tests fail on your PR, say so in the description rather than force-pushing around it.
