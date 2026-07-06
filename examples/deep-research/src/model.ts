import type { CallModel } from "@through-line/adapters-llm";

/**
 * A deterministic stand-in for a real model call. Swap this for a wrapper around your
 * provider SDK (OpenAI, Anthropic, …) — Throughline never imports one. Deterministic
 * output keeps golden-trace replay stable.
 */
export function mockModel(tokensPerCall = 40): CallModel<{ prompt: string }> {
  return async (req) => ({ text: `[model] ${req.prompt}`, usage: { totalTokens: tokensPerCall } });
}

/** Like mockModel but with latency, so a manual `kill -9` can land mid-step. */
export function slowMockModel(ms = 800): CallModel<{ prompt: string }> {
  return async (req) => {
    await new Promise((r) => setTimeout(r, ms));
    return { text: `[model] ${req.prompt}`, usage: { totalTokens: 40 } };
  };
}
