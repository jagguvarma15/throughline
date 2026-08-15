# Throughline

**A lightweight, embeddable, framework-agnostic durable-execution library for AI agents.**

You can build an agent in an afternoon but can't ship it: when the process dies mid-run it
loses all progress, retries double-charge side effects and tokens, human-approval steps don't
survive a redeploy, and there's no cheap way to regression-test a multi-step agent.
Throughline is the durable thread that keeps an agent run alive through all of it.

Wrap any agent loop — a hand-rolled `while`, LangGraph, the OpenAI Agents SDK, Pydantic AI —
and get crash-safe step checkpointing, automatic resume, exactly-once side effects via
idempotency keys, durable human-in-the-loop pauses, deterministic record/replay for testing,
and in-graph token/cost budgets. It runs on **SQLite** locally and **Postgres** in
production, and is **bring-your-own-LLM**.

It is a library you `import` — **not** an agent framework, an LLM-provider wrapper, a no-code
builder, or a hosted platform.

## Install

```bash
pnpm add @through-line/core
```

## Quickstart

```ts
import { throughline } from "@through-line/core";
import { sqlite } from "@through-line/core/sqlite";

const tf = throughline({ store: sqlite("./throughline.db") });

const research = tf.task("research", async (ctx, input: { topic: string }) => {
  // Only ctx.step bodies are durable. The result is journaled on first success and
  // replayed verbatim on resume — the body never re-runs once journaled.
  const plan = await ctx.step("plan", () => callYourModel(`plan ${input.topic}`));

  // Durable timer + human-in-the-loop, both survive a full restart.
  await ctx.sleep("cool-off", 1000);
  const approved = await ctx.waitForApproval("publish");

  if (approved) {
    // Exactly-once: thread the stable step key into the external call to dedupe retries.
    await ctx.step("publish", () => publish(plan));
  }
  return { plan };
});

// Drive runs from outside; a worker claims, executes, heartbeats, and records them.
const id = await tf.start("research", { topic: "sea otters" });
const worker = tf.worker({ concurrency: 4 });
worker.start(); // begins the poll loops; call `await worker.stop()` to drain on shutdown

// Later, from your control-plane / UI:
await tf.signal(id, "publish", { approved: true });
```

Kill the worker at any point and start another: it re-claims the run and replays the journal
— completed steps return their recorded results, the first incomplete step runs. Side effects
wrapped in an idempotency-keyed `ctx.step` happen once.

## Durability guarantees

The honest contract — including the precise, **non-overclaimed** statement of when side
effects are exactly-once — is in **[docs/guarantees.md](docs/guarantees.md)**. It is
*demonstrated* by fault-injection + property tests (identical final state across ≥100
randomized crash schedules; zero duplicated idempotency-keyed effects), not asserted in prose.

## Killer demo

**[examples/deep-research](examples/deep-research)** is a durable research agent that resumes
after a `kill -9` with no duplicate model calls, pauses for human approval before publishing,
halts a runaway loop at a token budget, and replays its whole trajectory offline for ~$0.

**[examples/ai-sdk-agent](examples/ai-sdk-agent)** is the same durability applied to a
[Vercel AI SDK](https://ai-sdk.dev) tool-calling loop via `@through-line/core/ai-sdk`:
each `generateText` model call and tool execution is a journaled step, so the loop itself
crash-resumes with exactly-once tool effects.

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
`signal_run`, `cancel_run`, `retry_run`, and `get_stats` - see [docs/mcp.md](docs/mcp.md).
Runs can also be started over HTTP (`POST /runs` on the control-plane, bearer-token
auth). Workers take a `retention` option for opportunistic terminal-run GC, and dead
runs surface in the dashboard's Dead letter view with one-click redrive.

## Recipes

[Wrap your existing loop](docs/recipes/wrap-your-loop.md),
[human approval](docs/recipes/human-approval.md),
[record/replay testing](docs/recipes/record-replay-testing.md),
[budgets](docs/recipes/budgets.md). `pnpm docs:api` generates the API reference.

## Performance

Measured by the repo's own [bench suite](bench/README.md) (`pnpm bench`) on a laptop,
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
if you need tighter timers. The full latency contract is in
[docs/guarantees.md](docs/guarantees.md).

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
postgres`). CI additionally enforces that `core`/`store-*` never depend on an LLM SDK.

## License

[MIT](LICENSE).
