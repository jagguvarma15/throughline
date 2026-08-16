# Using Throughline

Everything the minimal README leaves out: the package layout, integrating with an
existing agent, operating runs, the demos, performance numbers, the reference deployment,
and development commands.

## One package

Everything ships in `@through-line/core`: the engine at the root, and the rest as
subpath exports. The two executables (`throughline`, `throughline-mcp`) install with it.

| Import | Purpose |
|---|---|
| `@through-line/core` | Durable engine: `throughline()`, `task()`, `ctx`, worker, replay, retries, budgets, OTel. |
| `@through-line/core/sqlite` | Default durable store (better-sqlite3). |
| `@through-line/core/postgres` | Production durable store (pg). |
| `@through-line/core/llm` | BYO-LLM helper: wrap a model call in a durable step. |
| `@through-line/core/ai-sdk` | Vercel AI SDK adapter: durable `generateText` model calls + exactly-once tools (needs the `ai` peer). |
| `@through-line/core/testing` | Fault-injection store, store/engine conformance, property + golden-trace harness (needs the `vitest` peer). |
| `@through-line/core/mcp` | Transport-agnostic MCP server factory; the stdio wiring is the `throughline-mcp` bin. |

The repo additionally contains the private reference apps `apps/control-plane` (auth-gated
read/op HTTP API with `/metrics`) and `apps/dashboard` (durable-run UI), which are not
published to npm.

## Integrate with an existing agent

Throughline is a library you import, not a runtime you move your agent into: keep your
loop, wrap its side effects. Three depths of integration, all in the one package:

- **Any hand-rolled loop.** Register the function you already have as `tf.task(...)` and
  wrap each effectful line (model call, tool call, database write) in
  `ctx.step("name", fn)`. Control flow, prompts, and business logic stay yours; on resume
  the journal fast-forwards completed steps instead of re-executing them. A human gate is
  one line: `ctx.waitForApproval("publish")`.
- **A Vercel AI SDK loop.** `@through-line/core/ai-sdk` wraps the pieces the SDK
  controls: `durableModel(ctx, model)` journals every `generateText` call inside the
  SDK's multi-step tool loop, and `durableToolExecute(ctx, name, fn)` keys each tool
  execution by `toolCallId` for exactly-once effects.
  [examples/ai-sdk-agent](../examples/ai-sdk-agent) is the whole pattern in about 40
  lines.
- **Any other LLM client.** `@through-line/core/llm` gives `modelStep()`, which wraps
  whatever `callModel` function you already use (OpenAI or Anthropic SDK, LangChain, a
  local model). The engine never depends on a provider SDK, and CI enforces that.

What changes in your codebase: the agent-loop file (wrap effects in steps), a few
bootstrap lines (`throughline({ store })` plus `tf.worker().start()`, same process or a
separate one), one dependency, and a SQLite path or Postgres URL -
`throughline migrate` creates its own tables and touches nothing else.

What Throughline asks of a task in return: side effects live only inside steps, values
derive from step results rather than closures, and the step sequence stays
deterministic. Divergence on replay raises `NonDeterminismError` instead of silently
corrupting state - the full contract is in [guarantees.md](guarantees.md).

Prove it against your own agent: `@through-line/core/testing` ships the same tools this
repo is tested with - `faultStore` to crash execution at chosen storage operations,
golden traces to record a real trajectory and replay it offline in CI, and the
store/engine conformance suites if you bring a custom store.

## Operate runs from the terminal or an AI agent

```bash
# CLI: JSON in, JSON out - works directly on the store or against a control-plane URL.
npx -y -p @through-line/core throughline list --status waiting
npx -y -p @through-line/core throughline approve <run-id> publish
npx -y -p @through-line/core throughline retry <run-id>      # redrive a dead run
npx -y -p @through-line/core throughline prune --older-than 7d
npx -y -p @through-line/core throughline migrate             # apply schema migrations

# MCP: let Claude (or any MCP host) start, watch, and approve durable runs.
claude mcp add throughline --env THROUGHLINE_DB=./throughline.db -- npx -y -p @through-line/core throughline-mcp
```

The MCP server exposes `start_run`, `wait_for_run`, `get_run`, `approve_run`,
`signal_run`, `cancel_run`, `retry_run`, and `get_stats` - see [mcp.md](mcp.md).
Runs can also be started over HTTP (`POST /runs` on the control-plane, bearer-token
auth). Workers take a `retention` option for opportunistic terminal-run GC, and dead
runs surface in the dashboard's Dead letter view with one-click redrive.

## Demos

**[examples/deep-research](../examples/deep-research)** is a durable research agent that
resumes after a `kill -9` with no duplicate model calls, pauses for human approval before
publishing, halts a runaway loop at a token budget, and replays its whole trajectory
offline for ~$0.

**[examples/ai-sdk-agent](../examples/ai-sdk-agent)** is the same durability applied to a
[Vercel AI SDK](https://ai-sdk.dev) tool-calling loop via `@through-line/core/ai-sdk`:
each `generateText` model call and tool execution is a journaled step, so the loop itself
crash-resumes with exactly-once tool effects.

## Performance

Measured by the repo's own [bench suite](../bench/README.md) (`pnpm bench`) on a laptop,
Node 20, one process per store; run it yourself before trusting anyone's numbers:

| Metric | SQLite (file) | Postgres |
|---|---|---|
| Journaled steps per second, one worker | ~25,000 | ~950 |
| Resume a parked run, 1,000-step journal (p50) | 1.0 ms | 5.6 ms |
| Replay cost per journaled step | ~1 us | ~2.5 us |
| Start-to-completion p95 under a live worker | 1.0 ms | 5.7 ms with notify, 219 ms polling |

The scheduling model behind those numbers: idle workers back off exponentially from
`pollIntervalMs` (200 ms) to `maxPollIntervalMs` (5 s), cutting idle database load to one
probe per 5 s per loop; on Postgres, LISTEN/NOTIFY wakes idle workers in milliseconds when
a run is started, signalled, or redriven, and polling remains the correctness backstop.
Durable timers are observed within `maxPollIntervalMs` of their deadline - lower the cap
if you need tighter timers. The full latency contract is in [guarantees.md](guarantees.md).

## Reference stack

`docker compose up` brings up Postgres, the control-plane, and the dashboard; the
`monitoring/` stack (Prometheus/Grafana/Loki) scrapes the control-plane's real `/metrics`.
The control-plane requires `THROUGHLINE_API_TOKEN` (or an explicit
`THROUGHLINE_ALLOW_ANON=1` for trusted local networks, as the compose file sets).

## Development

```bash
pnpm install
pnpm -r typecheck && pnpm lint && pnpm -r build && pnpm -r test
```

Tests run against both SQLite and Postgres (set `THROUGHLINE_TEST_PG`, or `docker compose up
postgres`). CI additionally enforces that the published package never depends on an LLM
provider SDK. `pnpm docs:api` generates the API reference.
