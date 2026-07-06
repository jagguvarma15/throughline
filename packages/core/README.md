# @through-line/core

**A lightweight, embeddable, framework-agnostic durable-execution engine for AI agents.**

Wrap the steps of any agent loop in `ctx.step(...)` and Throughline journals every result
to SQLite or Postgres. Kill the process mid-run — a worker re-claims the run and replays
the journal: completed steps return their recorded results, the first incomplete step
runs. Side effects wrapped in an idempotency-keyed step happen exactly once.

- **Crash-resume** with zero duplicate model calls or effects
- **Durable human-in-the-loop** — `waitForApproval` parks in the DB for hours or days
- **Token/cost budgets** — runaway loops halt with `BudgetExceededError`
- **Deterministic record/replay** — regression-test multi-step agents offline for ~$0

## Install

```bash
pnpm add @through-line/core @through-line/store-sqlite
```

## Quickstart

```ts
import { throughline } from "@through-line/core";
import { sqlite } from "@through-line/store-sqlite";

const tf = throughline({ store: sqlite("./throughline.db") });

const research = tf.task("research", async (ctx, input: { topic: string }) => {
  // Only ctx.step bodies are durable: journaled on first success, replayed verbatim.
  const plan = await ctx.step("plan", () => callYourModel(`plan ${input.topic}`));

  await ctx.sleep("cool-off", 1000);                    // durable timer
  const approved = await ctx.waitForApproval("publish"); // survives restarts

  if (approved) {
    await ctx.step("publish", () => publish(plan)); // exactly-once via stable step key
  }
  return { plan };
});

const id = await tf.start("research", { topic: "sea otters" });
await tf.worker({ concurrency: 4 }).start();

// Later, from your control plane / UI:
await tf.signal(id, "publish", { approved: true });
```

## Guarantees

The precise, non-overclaimed contract — durability boundary, at-least-once vs
exactly-once side effects, replay algorithm, lease fencing, budgets — lives in
[docs/guarantees.md](https://github.com/jagguvarma15/throughline/blob/main/docs/guarantees.md),
and is demonstrated by fault-injection + property tests (identical final state across
100+ randomized crash schedules), not asserted in prose.

## Ecosystem

| Package | Purpose |
|---|---|
| `@through-line/store-sqlite` | Default durable store (better-sqlite3) |
| `@through-line/store-postgres` | Production durable store (pg) |
| `@through-line/adapters-ai-sdk` | Durable Vercel AI SDK model calls + exactly-once tools |
| `@through-line/adapters-llm` | BYO-LLM helper: wrap any model call in a durable step |
| `@through-line/testing` | Fault-injection store, conformance suites, golden traces |

Full docs, runnable demos (including a `kill -9` resume script), and a reference
deployment with dashboard + Prometheus metrics:
[github.com/jagguvarma15/throughline](https://github.com/jagguvarma15/throughline).

MIT © Jagadesh Varma Nadimpalli
