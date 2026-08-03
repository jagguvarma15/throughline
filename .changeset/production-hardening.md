---
"@through-line/core": minor
"@through-line/store-sqlite": minor
"@through-line/store-postgres": minor
"@through-line/testing": minor
"@through-line/adapters-ai-sdk": minor
"@through-line/cli": minor
"@through-line/mcp": minor
---

Production hardening and adoption. The claim query is rewritten as targeted, index-backed
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
