# Recipe: token and cost budgets

A runaway agent loop is a runaway bill. Throughline enforces a per-run token budget
inside the engine, and the accounting is reconstructed from the journal, so it stays
correct across crashes and replays.

## Set a budget on the task

```ts
tf.task(
  "research",
  async (ctx, input) => {
    // ...
  },
  { budget: 5000 }, // tokens for the whole run
);
```

## Charge steps against it

```ts
// A-priori estimate gates BEFORE the call; actual usage is charged after.
const answer = await ctx.step("ask", () => callModel(prompt), {
  budget: { estimate: 300, cost: (result) => result.usage.totalTokens },
});
```

`modelStep` (adapters-llm) and `durableModel` / `experimental_durableStreamText`
(adapters-ai-sdk) do this wiring for you: pass `estimate`, and real usage is charged
from the model response.

## What happens at the limit

When the budget cannot afford the next step's estimate, the engine throws
`BudgetExceededError` **before** running the step - no partial call, no charge - and the
run lands `dead` with that error. The journal stays consistent: a redrive
(`throughline retry <id>`) after raising the budget replays completed steps and
continues from the halt point.

```ts
expect(run?.error?.type).toBe("BudgetExceededError");
```

## Bound iterations too

Budgets cap spend; `ctx.maxIterations(n)` documents and bounds loop lengths so a
control-flow bug cannot spin forever between model calls:

```ts
for (let i = 0; i < ctx.maxIterations(8); i++) { ... }
```
