# @through-line/adapters-ai-sdk

## 0.3.0

### Minor Changes

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

## 0.2.179

### Minor Changes

- 074ffee: First adoptable release. New `@through-line/adapters-ai-sdk` package makes Vercel AI SDK
  (`ai@^7`) agent loops durable: `durableModel`/`durableMiddleware` journal every
  `generateText` model call as its own step, and `durableToolExecute` keys tool executions
  by `toolCallId` for exactly-once effects across crashes — proven by crash-resume and
  offline golden-replay tests, plus a runnable kill-and-resume example
  (`examples/ai-sdk-agent`). The dependency guard now also covers the adapter packages,
  forbidding provider SDKs (`@ai-sdk/openai`, ...) everywhere while allowing the
  provider-neutral `ai` package in the adapter.

### Patch Changes

- Updated dependencies [074ffee]
  - @through-line/core@0.2.0
