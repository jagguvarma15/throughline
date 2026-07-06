# AI SDK agent — durable release-notes drafter

A [Vercel AI SDK](https://ai-sdk.dev) tool-calling agent made durable by
`@through-line/adapters-ai-sdk`: **model → `getCommits` tool → model → human approval →
publish**. The adapter journals each `doGenerate` as its own step and keys the tool step
by `toolCallId`, so the run gets all of Throughline's guarantees:

- **Crash-resume.** Kill the worker mid-loop; on restart the journaled model output
  reproduces the tool loop byte-identically — no duplicate provider calls, no duplicate
  tool effects.
- **Durable human-in-the-loop.** It parks on `waitForApproval("publish")` between AI SDK
  calls and survives a full restart until you signal approval.
- **Token budget.** The `estimate` gate halts the run with `BudgetExceededError` before
  an unaffordable model call is made.
- **Offline replay.** The whole trajectory — including the tool round-trip — replays
  from a recorded journal with zero model or tool calls.

The demo uses a deterministic scripted `MockLanguageModelV4` (`src/model.ts`), so it runs
offline with no API keys.

## Automated proof (runs in CI, offline)

```
pnpm --filter @through-line/example-ai-sdk-agent test
```

Covers crash-resume with zero duplicate model/tool calls, the approval pause, the budget
halt, and the offline replay.

## Manual kill-and-resume

```
pnpm --filter @through-line/example-ai-sdk-agent build
cd examples/ai-sdk-agent
node dist/run.js start            # prints a run id
node dist/run.js work             # kill -9 this mid-run...
node dist/run.js work             # ...then resume: replays the journal, parks at approval
node dist/run.js approve <id>
node dist/run.js status <id>      # → completed
```

## Using a real provider

Swap the scripted mock for any AI SDK provider binding — provider SDKs live in your app,
never in Throughline:

```bash
pnpm add @ai-sdk/openai   # or @ai-sdk/anthropic, @ai-sdk/google, ...
```

```ts
import { openai } from "@ai-sdk/openai";

registerDrafter(tf, {
  model: openai("gpt-5"),
  getCommits: async (range) => execSync(`git log --format=%s ${range}`).toString().split("\n"),
  budget: 50_000,
  publish: async (notes) => postToSlack(notes),
});
```

`zod` schemas also work for tool inputs (`inputSchema: z.object({ range: z.string() })`)
— this example uses `jsonSchema` only to stay dependency-free.
