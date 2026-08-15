<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/jagguvarma15/throughline/main/docs/assets/logo-dark.svg">
    <img src="https://raw.githubusercontent.com/jagguvarma15/throughline/main/docs/assets/logo-light.svg" alt="Throughline" width="420">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/jagguvarma15/throughline/blob/main/docs/guarantees.md"><img src="https://img.shields.io/badge/durability-crash--safe-2b4fd8" alt="durability: crash-safe"></a>
  <a href="https://github.com/jagguvarma15/throughline/blob/main/docs/guarantees.md"><img src="https://img.shields.io/badge/effects-exactly--once-2b4fd8" alt="effects: exactly-once"></a>
  <a href="https://github.com/jagguvarma15/throughline/blob/main/docs/guarantees.md"><img src="https://img.shields.io/badge/replay-deterministic-2b4fd8" alt="replay: deterministic"></a>
  <a href="https://github.com/jagguvarma15/throughline/blob/main/docs/recipes/human-approval.md"><img src="https://img.shields.io/badge/human--in--the--loop-built--in-2b4fd8" alt="human-in-the-loop: built-in"></a>
  <a href="https://github.com/jagguvarma15/throughline/blob/main/docs/usage.md"><img src="https://img.shields.io/badge/stores-SQLite%20%7C%20Postgres-2b4fd8" alt="stores: SQLite and Postgres"></a>
</p>

Throughline is the durable thread for AI agents: wrap any agent loop and every step is
journaled, so a crashed run resumes exactly where it stopped, side effects happen exactly
once, and human approvals survive redeploys. Everything is in this one package: the
engine, the SQLite and Postgres stores, the AI SDK and BYO-LLM adapters, the testing
harness, the `throughline` CLI, and the `throughline-mcp` MCP server.

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
completed steps return their recorded results and never re-run. Postgres for production
is one import away: `import { postgres } from "@through-line/core/postgres"`.

## Subpaths

`@through-line/core` (engine), `/sqlite`, `/postgres`, `/llm`, `/ai-sdk` (needs the `ai`
peer), `/testing` (needs the `vitest` peer), `/mcp` - full table in the
[usage guide](https://github.com/jagguvarma15/throughline/blob/main/docs/usage.md).

## Learn more

- [Durability guarantees](https://github.com/jagguvarma15/throughline/blob/main/docs/guarantees.md) - the precise contract, proven by fault-injection and property tests
- [Usage guide](https://github.com/jagguvarma15/throughline/blob/main/docs/usage.md) - CLI, MCP, demos, performance, deployment
- [Recipes and examples](https://github.com/jagguvarma15/throughline) - including a `kill -9` resumable research agent

MIT (c) Jagadesh Varma Nadimpalli
