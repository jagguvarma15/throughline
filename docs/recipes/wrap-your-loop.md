# Recipe: wrap your existing agent loop

You have a working agent loop. It loses everything when the process dies. This recipe
makes it durable without changing what it does.

## Before

```ts
async function research(topic: string) {
  const plan = await callModel(`plan research on ${topic}`);
  const findings: string[] = [];
  for (let i = 0; i < 4; i++) {
    findings.push(await callModel(`search iteration ${i}: ${plan}`));
  }
  const draft = await callModel(`draft a report from: ${findings.join("\n")}`);
  await publish(draft); // side effect - must never happen twice
  return draft;
}
```

Kill the process after iteration 3 and everything re-runs: four model calls re-billed,
and `publish` might fire twice.

## After

```ts
import { throughline } from "@through-line/core";
import { sqlite } from "@through-line/store-sqlite";
import { modelStep } from "@through-line/adapters-llm";

const tf = throughline({ store: sqlite("./throughline.db") });

tf.task("research", async (ctx, input: { topic: string }) => {
  const plan = await modelStep(ctx, "plan", callModel, `plan research on ${input.topic}`);
  const findings: string[] = [];
  for (let i = 0; i < ctx.maxIterations(4); i++) {
    findings.push(await modelStep(ctx, `search-${i}`, callModel, `search iteration ${i}: ${plan}`));
  }
  const draft = await modelStep(ctx, "draft", callModel, `draft: ${findings.join("\n")}`);
  await ctx.step("publish", () => publish(draft)); // journaled: runs exactly once
  return draft;
});

const id = await tf.start("research", { topic: "sea otters" });
const worker = tf.worker({ concurrency: 2 });
worker.start();
```

Now a `kill -9` after iteration 3 resumes from the journal: the plan and three findings
replay verbatim (no model calls), iteration 3 re-runs, and `publish` still happens once.

## The three rules

1. **Anything non-pure goes inside a step.** Model calls, HTTP, DB writes, file writes,
   time (`ctx.now()`), randomness (`ctx.random()`). Code between steps re-runs on every
   replay and must be pure.
2. **Branch only on journaled data.** Loop bounds and conditionals must derive from step
   results, not live external state. The determinism guard catches violations in dev.
3. **Key external side effects.** For exactly-once against the outside world, thread the
   stable step key (or `ctx.deriveKey(...)`) into the downstream call as an idempotency
   key. See guarantees section 2 for the honest contract.

Using the Vercel AI SDK? `@through-line/adapters-ai-sdk` journals whole `generateText`
tool loops - see its README.
