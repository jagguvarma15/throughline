import type { Context, RetryPolicy } from "@throughline/core";

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number;
}

export interface ModelResponse {
  text: string;
  usage: ModelUsage;
}

/**
 * The BYO-LLM seam: a user-provided async function that calls their model. Wrapping the
 * provider SDK in this shape keeps all provider dependencies in the application layer —
 * @throughline/core never imports an LLM SDK.
 */
export type CallModel<Req = unknown, Res extends ModelResponse = ModelResponse> = (
  req: Req,
) => Promise<Res>;

export interface ModelStepOptions {
  retry?: Partial<RetryPolicy>;
  idempotencyKey?: string;
  /** A-priori token estimate used to gate the budget BEFORE the call runs. */
  estimate?: number;
}

/**
 * Wrap a model call in a durable step: the response is journaled (a replay returns it
 * without calling the model again) and its actual token usage is charged to `ctx.tokens`.
 */
export function modelStep<Req, Res extends ModelResponse>(
  ctx: Context,
  name: string,
  call: CallModel<Req, Res>,
  req: Req,
  opts: ModelStepOptions = {},
): Promise<Res> {
  return ctx.step<Res>(name, () => call(req), {
    retry: opts.retry,
    idempotencyKey: opts.idempotencyKey,
    budget: { estimate: opts.estimate, cost: (res) => res.usage.totalTokens },
  });
}
