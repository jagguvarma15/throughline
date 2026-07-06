# @through-line/adapters-llm

The bring-your-own-LLM seam for [Throughline](https://github.com/jagguvarma15/throughline):
wrap **any** model call in a durable step — the response is journaled (replays return it
without re-calling the model) and its actual token usage is charged to the run's budget.

Throughline never imports a provider SDK; you pass a plain async function. If you use the
Vercel AI SDK, prefer `@through-line/adapters-ai-sdk`, which journals whole
`generateText` tool loops.

## Install

```bash
pnpm add @through-line/core @through-line/adapters-llm
```

## Usage

```ts
import { modelStep, type CallModel } from "@through-line/adapters-llm";

// Your provider call, in your app layer — OpenAI, Anthropic, Ollama, anything:
const callModel: CallModel<{ prompt: string }> = async (req) => {
  const res = await openai.responses.create({ model: "gpt-5", input: req.prompt });
  return { text: res.output_text, usage: { totalTokens: res.usage.total_tokens } };
};

tf.task("summarize", async (ctx, input: { doc: string }) => {
  const res = await modelStep(
    ctx,
    "summarize",              // step name -> journal key summarize#0
    callModel,
    { prompt: `Summarize: ${input.doc}` },
    { estimate: 500 },        // gates the token budget BEFORE the call runs
  );
  return res.text;            // on replay: returned from the journal, model not called
});
```

`modelStep` supports Throughline retry policies and idempotency keys, and charges
`usage.totalTokens` to `ctx.tokens` so runaway loops halt at the task budget.

MIT © Jagadesh Varma Nadimpalli
