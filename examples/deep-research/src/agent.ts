import type { CallModel } from "@through-line/adapters-llm";
import { modelStep } from "@through-line/adapters-llm";
import type { Context, Throughline } from "@through-line/core";

export interface ResearchInput {
  topic: string;
  maxIterations?: number;
}

export interface ResearchOutput {
  report: string;
  iterations: number;
  sources: string[];
}

export interface ResearchDeps {
  model: CallModel<{ prompt: string }>;
  /** Per-run token budget; a runaway loop halts here with BudgetExceededError. */
  budget?: number;
  /** The side effect gated behind human approval. */
  publish?: (report: string) => Promise<void>;
}

/**
 * A durable, resumable research agent: plan -> N search iterations -> draft ->
 * human approval -> publish. Every model call and the publish are `ctx.step`s, so a
 * crash resumes from the journal with no duplicate calls or effects; the token budget
 * halts a runaway loop; and the whole trajectory replays offline for tests.
 */
export function registerResearch(tf: Throughline, deps: ResearchDeps): void {
  tf.task<ResearchInput, ResearchOutput>(
    "deep-research",
    async (ctx: Context, input: ResearchInput): Promise<ResearchOutput> => {
      const iterations = ctx.maxIterations(input.maxIterations ?? 3);

      await modelStep(
        ctx,
        "plan",
        deps.model,
        { prompt: `Plan research on: ${input.topic}` },
        { estimate: 50 },
      );

      const sources: string[] = [];
      let notes = "";
      for (let i = 0; i < iterations; i++) {
        const res = await modelStep(
          ctx,
          `search-${i}`,
          deps.model,
          {
            prompt: `Search "${input.topic}" (iteration ${i}); ${notes.length} chars of notes so far`,
          },
          { estimate: 50 },
        );
        notes += `${res.text}\n`;
        sources.push(`source-${i}`);
      }

      const draft = await modelStep(
        ctx,
        "draft",
        deps.model,
        { prompt: `Write a report on ${input.topic} from ${notes.length} chars of notes` },
        { estimate: 50 },
      );

      // Durable human-in-the-loop: parks until a `publish` signal arrives (survives restarts).
      const approved = await ctx.waitForApproval("publish");
      if (approved) {
        await ctx.step("publish-report", async () => {
          await deps.publish?.(draft.text);
          return "published";
        });
      }

      return { report: draft.text, iterations, sources };
    },
    { budget: deps.budget },
  );
}
