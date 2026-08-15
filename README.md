<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/jagguvarma15/throughline/main/docs/assets/logo-dark.svg">
    <img src="https://raw.githubusercontent.com/jagguvarma15/throughline/main/docs/assets/logo-light.svg" alt="Throughline" width="420">
  </picture>
</p>

<p align="center">
  <a href="docs/guarantees.md"><img src="https://img.shields.io/badge/durability-crash--safe-2b4fd8" alt="durability: crash-safe"></a>
  <a href="docs/guarantees.md"><img src="https://img.shields.io/badge/effects-exactly--once-2b4fd8" alt="effects: exactly-once"></a>
  <a href="docs/guarantees.md"><img src="https://img.shields.io/badge/replay-deterministic-2b4fd8" alt="replay: deterministic"></a>
  <a href="docs/recipes/human-approval.md"><img src="https://img.shields.io/badge/human--in--the--loop-built--in-2b4fd8" alt="human-in-the-loop: built-in"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/LLM-bring%20your%20own-2b4fd8" alt="LLM: bring your own"></a>
  <a href="docs/usage.md"><img src="https://img.shields.io/badge/stores-SQLite%20%7C%20Postgres-2b4fd8" alt="stores: SQLite and Postgres"></a>
</p>

Throughline is the durable thread for AI agents: wrap any agent loop and every step is
journaled, so a crashed run resumes exactly where it stopped, side effects happen exactly
once, and human approvals survive redeploys. It is a library you `import` - not a
framework, a provider wrapper, or a hosted platform.

## Install

```bash
pnpm add @through-line/core
```

## Quickstart

```ts
import { throughline } from "@through-line/core";
import { sqlite } from "@through-line/core/sqlite";

const tf = throughline({ store: sqlite("./throughline.db") });

tf.task("research", async (ctx, input: { topic: string }) => {
  const plan = await ctx.step("plan", () => callYourModel(input.topic)); // journaled once
  const approved = await ctx.waitForApproval("publish");                 // survives restarts
  if (approved) await ctx.step("publish", () => publish(plan));          // exactly-once
  return { plan };
});

const id = await tf.start("research", { topic: "sea otters" });
tf.worker({ concurrency: 4 }).start();
```

Kill the process at any point: a worker re-claims the run and replays the journal -
completed steps return their recorded results and never re-run.

## Learn more

| | |
|---|---|
| [Durability guarantees](docs/guarantees.md) | The precise contract, proven by fault-injection and property tests. |
| [Usage guide](docs/usage.md) | Subpath imports, CLI and MCP operation, demos, performance, deployment. |
| [Recipes](docs/recipes/wrap-your-loop.md) | [Wrap your loop](docs/recipes/wrap-your-loop.md), [human approval](docs/recipes/human-approval.md), [record/replay testing](docs/recipes/record-replay-testing.md), [budgets](docs/recipes/budgets.md). |
| [MCP guide](docs/mcp.md) | Let an AI agent operate your durable runs. |
| [Benchmarks](bench/README.md) | The numbers and how to reproduce them (`pnpm bench`). |
| [Examples](examples) | A `kill -9` resumable research agent and an AI SDK tool loop. |

[MIT](LICENSE).
