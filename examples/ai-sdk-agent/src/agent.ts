import {
  type WrappableModel,
  durableModel,
  durableToolExecute,
} from "@throughline/adapters-ai-sdk";
import type { Context, Throughline } from "@throughline/core";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";

export interface DraftInput {
  range: string;
}

export interface DraftOutput {
  notes: string;
  commits: number;
}

export interface DrafterDeps {
  model: WrappableModel;
  getCommits: (range: string) => Promise<string[]>;
  /** Per-run token budget; a runaway loop halts here with BudgetExceededError. */
  budget?: number;
  /** The side effect gated behind human approval. */
  publish?: (notes: string) => Promise<void>;
}

/**
 * A durable AI SDK tool-calling agent: `generateText` drives a model+tool loop to draft
 * release notes, then a human approves before publishing. The adapter journals every
 * model call (`model#0`, `model#1`, ...) and keys the tool step by toolCallId, so a
 * crash resumes with no duplicate provider calls or tool effects — and the whole
 * trajectory replays offline for tests.
 */
export function registerDrafter(tf: Throughline, deps: DrafterDeps): void {
  tf.task<DraftInput, DraftOutput>(
    "release-notes",
    async (ctx: Context, input: DraftInput): Promise<DraftOutput> => {
      const res = await generateText({
        model: durableModel(ctx, deps.model, { estimate: 50 }),
        tools: {
          getCommits: tool({
            description: "List commit subjects in a git revision range",
            inputSchema: jsonSchema<{ range: string }>({
              type: "object",
              properties: { range: { type: "string" } },
              required: ["range"],
            }),
            execute: durableToolExecute(ctx, "getCommits", ({ range }) => deps.getCommits(range)),
          }),
        },
        stopWhen: stepCountIs(4),
        // Throughline owns retries (DurableModelOptions.retry); the AI SDK's own retry
        // loop sits outside the durable step and would skew replay ordinals.
        maxRetries: 0,
        prompt: `draft release notes for ${input.range}`,
      });

      // Derive outputs from step RESULTS, never from closures inside tool bodies —
      // on replay the tool body doesn't run, but journaled results still flow here.
      const commits = res.steps
        .flatMap((s) => s.toolResults)
        .reduce((n, r) => n + (Array.isArray(r.output) ? r.output.length : 0), 0);

      // Durable human-in-the-loop: parks until a `publish` signal arrives (survives
      // restarts). Waits must sit between AI SDK calls, never inside a tool execute.
      const approved = await ctx.waitForApproval("publish");
      if (approved) {
        await ctx.step("publish-notes", async () => {
          await deps.publish?.(res.text);
          return "published";
        });
      }

      return { notes: res.text, commits };
    },
    { budget: deps.budget },
  );
}
