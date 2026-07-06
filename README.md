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

> **Project history:** Throughline began as **TaskFlow**, a containerized task-management
> demo, and was refactored into this durable-execution library — keeping TaskFlow's
> production-grade Docker, CI, and observability stack as the reference deployment.

## Install

> **Status:** not yet published to npm — the release pipeline is in place, but until the
> first publish lands, clone the repo and use the pnpm workspace (see Development).

```bash
pnpm add @through-line/core @through-line/store-sqlite
```

## Quickstart

```ts
import { throughline } from "@through-line/core";
import { sqlite } from "@through-line/store-sqlite";

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
await tf.worker({ concurrency: 4 }).start();

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
[Vercel AI SDK](https://ai-sdk.dev) tool-calling loop via `@through-line/adapters-ai-sdk`:
each `generateText` model call and tool execution is a journaled step, so the loop itself
crash-resumes with exactly-once tool effects.

## Packages

| Package | Purpose |
|---|---|
| `@through-line/core` | Durable engine: `throughline()`, `task()`, `ctx`, worker, replay, retries, budgets, OTel. |
| `@through-line/store-sqlite` | Default durable store (better-sqlite3). |
| `@through-line/store-postgres` | Production durable store (pg). |
| `@through-line/adapters-llm` | BYO-LLM helper: wrap a model call in a durable step. |
| `@through-line/adapters-ai-sdk` | Vercel AI SDK adapter: durable `generateText` model calls + exactly-once tools. |
| `@through-line/testing` | Fault-injection store, store/engine conformance, property + golden-trace harness. |
| `apps/control-plane` | Thin read/op HTTP API over the store (`/runs`, signal, cancel, `/health`, `/metrics`). |
| `apps/dashboard` | Durable-run UI (runs, timeline, approvals, replay). |

## Reference stack

`docker compose up` brings up Postgres, the control-plane, and the dashboard; the
`monitoring/` stack (Prometheus/Grafana/Loki) scrapes the control-plane's real `/metrics`.

## Development

```bash
pnpm install
pnpm -r typecheck && pnpm lint && pnpm -r build && pnpm -r test
```

Tests run against both SQLite and Postgres (set `THROUGHLINE_TEST_PG`, or `docker compose up
postgres`). CI additionally enforces that `core`/`store-*` never depend on an LLM SDK.

## License

[MIT](LICENSE).
