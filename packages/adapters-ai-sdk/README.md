# @throughline/adapters-ai-sdk

Durable [Vercel AI SDK](https://ai-sdk.dev) adapter for Throughline: every raw model call
and tool execution becomes a journaled step, so a `generateText` tool loop survives
`kill -9`, replays completed calls for $0, and never re-fires a tool side effect.

Requires `ai@^7` as a peer dependency. The `ai` package is provider-neutral, so
Throughline stays bring-your-own-LLM — provider bindings (`@ai-sdk/openai`,
`@ai-sdk/anthropic`, ...) belong in your application, never in this package.

## Usage

```ts
import { durableModel, durableToolExecute } from "@throughline/adapters-ai-sdk";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

tf.task("draft-notes", async (ctx, input: { range: string }) => {
  const res = await generateText({
    // Journals each doGenerate as steps `model#0`, `model#1`, ... and charges
    // actual usage to ctx.tokens.
    model: durableModel(ctx, yourModel),
    tools: {
      getCommits: tool({
        description: "List commits in a range",
        inputSchema: z.object({ range: z.string() }),
        // Journals each invocation keyed by toolCallId — exactly-once across crashes.
        execute: durableToolExecute(ctx, "getCommits", ({ range }) => listCommits(range)),
      }),
    },
    stopWhen: stepCountIs(4),
    maxRetries: 0, // let Throughline own retries (see below)
    prompt: `draft release notes for ${input.range}`,
  });

  // Durable pauses go BETWEEN AI SDK calls, never inside a tool body (see rules).
  const approved = await ctx.waitForApproval("publish");
  if (approved) await ctx.step("publish", () => publish(res.text));
  return res.text;
});
```

## Why per-call journaling (not one step around `generateText`)

`generateText` runs a multi-step tool loop internally. Wrapping the whole call in a
single `ctx.step` would re-run **every** model call and re-fire **every** tool side
effect when a crash lands mid-loop. Journaling at the `doGenerate`/`execute` seam makes
each round durable on its own: the journaled model output contains the tool calls (same
`toolCallId`s), so a resumed run reproduces the loop byte-identically without touching
the network.

## Rules the adapter relies on

- **`maxRetries: 0`** — pass Throughline's `retry` option (on `DurableModelOptions`)
  instead. The AI SDK's own retry loop sits *outside* the durable step, and a crash
  between its attempts would bump step ordinals and break replay. (In practice the AI
  SDK only retries provider `APICallError`s, which Throughline's step already handles —
  but owning retries in one place keeps the journal deterministic.)
- **Concurrent `generateText` calls need distinct `name`s** — ordinals are assigned per
  step name in call order; two interleaved loops sharing the default `"model"` name
  replay nondeterministically. Give each loop `durableModel(ctx, m, { name: "plan" })` /
  `{ name: "draft" }`.
- **No durable waits inside tool bodies** — the AI SDK catches *all* tool `execute`
  errors and converts them into `tool-error` results, which would swallow the suspend
  signal from `ctx.sleep`/`ctx.waitForEvent`/`ctx.waitForApproval`. Pause between AI SDK
  calls instead. (A lost lease inside a tool is still safe: the next fenced write throws
  and the zombie worker abandons the run.)
- **Tool outputs must be JSON-serializable** — they are stored in the journal verbatim.

## What gets journaled

The `doGenerate` result is journaled after JSON sanitization: the raw HTTP `request`
body and `response.headers`/`response.body` are dropped (possibly sensitive, never
needed for replay); `response.timestamp` and URL-typed file data are re-hydrated to
`Date`/`URL` on replay; binary file parts are stored as base64 strings (a spec-valid
encoding — the `Uint8Array` form is not restored).

## Not supported (v1)

- **Streaming** — `streamText` throws: a journal entry is a single JSON value, not a
  replayable stream. Use `generateText`/`generateObject` inside tasks, or stream only in
  code that doesn't need durability.
- **`ai` v5/v6** — the middleware targets the v4 language-model spec (`ai@^7`). On older
  majors, wrap calls with `modelStep` from `@throughline/adapters-llm` instead.
