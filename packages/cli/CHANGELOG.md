# @through-line/cli

## 0.3.0

### Minor Changes

- f980bdf: Add the agent-facing operations layer. Core gains `createOps(store)`, a registryless
  facade (list, get, start, signal, approve, cancel, stats) shared by every ops surface.
  New package `@through-line/cli` (`throughline` binary) covers start / list / status /
  signal / approve / cancel / stats with JSON output, working directly on SQLite or
  Postgres or against a control-plane URL with `--url`/`--token`. New package
  `@through-line/mcp` (`throughline-mcp` binary) exposes the same operations as MCP tools
  (`start_run`, `wait_for_run`, `get_run` with truncated journals, `approve_run`,
  `signal_run`, `cancel_run`, `get_stats`) so AI agents can operate durable runs. The
  control-plane app adds `POST /runs`, `GET /stats`, bearer-token auth that fails closed
  (`THROUGHLINE_API_TOKEN`, or explicit `THROUGHLINE_ALLOW_ANON=1`), CORS restricted to
  configured origins, trust-proxy support, and query validation.
- 478bde3: Production hardening and adoption. The claim query is rewritten as targeted, index-backed
  probes per runnable predicate (with per-branch SKIP LOCKED on Postgres) plus a partial
  index for the unconsumed-event branch, so claim cost tracks live runs instead of table
  size. `store.init()` is now a real versioned migration runner that refuses databases
  newer than the code; the hand-maintained root migrations directory is gone (use
  `store.init()` or `throughline migrate`). New `Store.pruneRuns` terminal-run GC with a
  worker `retention` option, `throughline prune`, and `POST /admin/prune`. Dead runs can be
  redriven with the journal preserved and failed steps granted a fresh retry budget
  (`Store.resetFailedSteps`): `ops.retry`, `POST /runs/:id/retry`, `throughline retry`, MCP
  `retry_run`, and a dashboard Dead letter view with a Retry button; stats and `/metrics`
  expose the max live recovery count. The AI SDK adapter gains
  `experimental_durableStreamText`: live streaming on first execution, one journaled step
  charged from real usage, instant synthetic replay with no model call. Docs: recipes
  (wrap-your-loop, human-approval, record-replay-testing, budgets), llms.txt, AGENTS.md,
  and a typedoc API-reference script.

### Patch Changes

- Updated dependencies [f980bdf]
- Updated dependencies [88ca599]
- Updated dependencies [478bde3]
  - @through-line/core@0.3.0
  - @through-line/store-sqlite@0.3.0
  - @through-line/store-postgres@0.3.0
