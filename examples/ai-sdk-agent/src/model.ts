import { MockLanguageModelV4 } from "ai/test";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

const NOTES = [
  "## Release Notes",
  "",
  "- Workers survive kill -9: runs resume from the journal",
  "- Idempotency-keyed steps make side effects exactly-once",
  "- Token budgets halt runaway loops cleanly",
].join("\n");

/**
 * A deterministic stand-in for a real AI SDK model. Swap it for a provider binding
 * (`openai("gpt-5")`, `anthropic("claude-sonnet-5")`, …) — Throughline never imports one.
 * It scripts a one-round tool loop: first call asks for `getCommits` (range parsed from
 * the prompt), and once a tool result is present it answers with fixed release notes.
 * Deciding from the request — not an instance counter — keeps a restarted worker's
 * replay identical, and deterministic output keeps golden traces stable.
 */
export function scriptedModel(latencyMs = 0): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      const hasToolResult = options.prompt.some((m) => m.role === "tool");
      if (hasToolResult) {
        return {
          content: [{ type: "text" as const, text: NOTES }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: usage(30, 40),
          warnings: [],
        };
      }
      const user = options.prompt.find((m) => m.role === "user");
      const text =
        user && Array.isArray(user.content)
          ? user.content.map((part) => (part.type === "text" ? part.text : "")).join(" ")
          : "";
      const range = /for (\S+)/.exec(text)?.[1] ?? "HEAD~10..HEAD";
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call-getCommits-0",
            toolName: "getCommits",
            input: JSON.stringify({ range }),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
        usage: usage(20, 10),
        warnings: [],
      };
    },
  });
}

/** Like scriptedModel but with latency, so a manual `kill -9` can land mid-step. */
export function slowScriptedModel(ms = 800): MockLanguageModelV4 {
  return scriptedModel(ms);
}
