import { type Context, NonRetryableError, type RetryPolicy } from "@through-line/core";
import { type LanguageModelMiddleware, streamText, wrapLanguageModel } from "ai";

/**
 * Durable Vercel AI SDK adapter. The middleware journals every raw model call
 * (`doGenerate`) as its own Throughline step, so a `generateText` tool loop that crashes
 * mid-run replays completed calls from the journal instead of re-calling the provider.
 * The `ai` package is provider-neutral, so bring-your-own-LLM still holds — provider
 * SDKs (@ai-sdk/openai, ...) stay in the application layer.
 *
 * Not supported in v1: streaming (`streamText` / `doStream`) — a journal entry is a
 * single JSON value, not a replayable stream.
 */

type WrapGenerate = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;
type GenerateResult = Awaited<ReturnType<WrapGenerate>>;
/** Any model `wrapLanguageModel` accepts — useful for app-layer dependency interfaces. */
export type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];
type WrappedModel = ReturnType<typeof wrapLanguageModel>;

export interface DurableModelOptions {
  /**
   * Step-name prefix for journaled model calls; keys become `name#0`, `name#1`, ...
   * Concurrent `generateText` calls sharing a ctx MUST each use a distinct name, or
   * their interleaving makes replay ordinals nondeterministic. Default "model".
   */
  name?: string;
  retry?: Partial<RetryPolicy>;
  /** A-priori token estimate used to gate the budget BEFORE each model call runs. */
  estimate?: number;
}

/**
 * Middleware that runs every `doGenerate` inside `ctx.step`: the (JSON-sanitized)
 * result is journaled — a replay returns it without calling the model — and its actual
 * usage is charged to `ctx.tokens`.
 *
 * Pass `maxRetries: 0` to `generateText` so Throughline owns retries: the AI SDK's own
 * retry loop sits outside the step and would bump ordinals on a crash between attempts.
 */
export function durableMiddleware(
  ctx: Context,
  opts: DurableModelOptions = {},
): LanguageModelMiddleware {
  const name = opts.name ?? "model";
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      const journaled = await ctx.step<GenerateResult>(
        name,
        async () => sanitize(await doGenerate()),
        {
          retry: opts.retry,
          budget: { estimate: opts.estimate, cost: usageTokens },
        },
      );
      return revive(journaled);
    },
    wrapStream: () => {
      throw new NonRetryableError(
        "@through-line/adapters-ai-sdk does not support streaming: a journal entry is a single JSON value. Use generateText/generateObject, or stream only outside durable steps.",
      );
    },
  };
}

/** Sugar: `wrapLanguageModel({ model, middleware: durableMiddleware(ctx, opts) })`. */
export function durableModel(
  ctx: Context,
  model: WrappableModel,
  opts: DurableModelOptions = {},
): WrappedModel {
  return wrapLanguageModel({ model, middleware: durableMiddleware(ctx, opts) });
}

export interface DurableToolOptions {
  retry?: Partial<RetryPolicy>;
}

/** The slice of the AI SDK's tool-execution options the wrapper needs. */
export interface ToolCallInfo {
  toolCallId: string;
}

/**
 * Wrap a tool `execute` so each invocation is a durable step. The AI SDK runs parallel
 * tool calls concurrently, so ordinal keys would be nondeterministic — the step is keyed
 * by `toolCallId` instead, which comes from the journaled model output and is therefore
 * stable across replays. Tool outputs must be JSON-serializable.
 */
export function durableToolExecute<In, Out, O extends ToolCallInfo>(
  ctx: Context,
  name: string,
  execute: (input: In, options: O) => PromiseLike<Out> | Out,
  opts: DurableToolOptions = {},
): (input: In, options: O) => Promise<Out> {
  return (input, options) =>
    ctx.step(`tool:${name}`, async () => execute(input, options), {
      idempotencyKey: ctx.deriveKey("tool", name, options.toolCallId),
      retry: opts.retry,
    });
}

export interface DurableStreamTextOptions {
  /** Step name for the journaled stream; ordinals key repeated calls. Default "stream". */
  name?: string;
  /** A-priori token estimate used to gate the budget BEFORE the stream starts. */
  estimate?: number;
}

export interface DurableStreamTextOutcome {
  text: string;
  totalTokens: number;
  finishReason: string;
}

export interface DurableStreamTextResult {
  /**
   * Text chunks. Live from the provider on the first execution; on replay, the
   * journaled text arrives as a single instant chunk with no model call.
   */
  textStream: ReadableStream<string>;
  /** Resolves once the outcome is journaled (or replayed) - the durable result. */
  result: Promise<DurableStreamTextOutcome>;
}

/**
 * EXPERIMENTAL. Durable `streamText`: the first execution streams live to the caller
 * while accumulating, then journals `{ text, totalTokens, finishReason }` as ONE step
 * charged to the budget from real usage. A replay re-emits the journaled text instantly
 * without calling the model. A crash mid-stream leaves the step un-journaled, so
 * recovery re-runs it from scratch - the same at-least-once window as guarantees §2,
 * no new promises.
 *
 * The step runs with a single attempt (in-process retries would re-emit chunks the
 * live consumer already saw); recovery happens via crash-resume instead. Tool calls
 * and multi-step loops are not journaled by this helper - use `durableModel` +
 * `generateText` for tool loops.
 */
export function experimental_durableStreamText(
  ctx: Context,
  args: Parameters<typeof streamText>[0],
  opts: DurableStreamTextOptions = {},
): DurableStreamTextResult {
  const name = opts.name ?? "stream";
  let controller!: ReadableStreamDefaultController<string>;
  const textStream = new ReadableStream<string>({
    start(c) {
      controller = c;
    },
  });
  let live = false;

  const journaled = ctx.step<DurableStreamTextOutcome>(
    name,
    async () => {
      live = true;
      const r = streamText({ ...args, maxRetries: 0 });
      let text = "";
      for await (const delta of r.textStream) {
        text += delta;
        controller.enqueue(delta);
      }
      const usage = await r.totalUsage;
      const finishReason = await r.finishReason;
      return { text, totalTokens: usage.totalTokens ?? 0, finishReason: String(finishReason) };
    },
    {
      retry: { maxAttempts: 1 },
      budget: { estimate: opts.estimate, cost: (out) => out.totalTokens },
    },
  );

  const result = journaled.then(
    (out) => {
      // Replay path: nothing streamed live, so emit the journaled text at once.
      if (!live && out.text.length > 0) controller.enqueue(out.text);
      controller.close();
      return out;
    },
    (e) => {
      controller.error(e);
      throw e;
    },
  );
  // A caller consuming only the (errored) stream never awaits `result`; keep its
  // rejection observable to awaiters without tripping unhandled-rejection detection.
  result.catch(() => {});

  return { textStream, result };
}

/** Spec-v4 usage is nested; fall back to the flat spec-v2/v3 `totalTokens` if present. */
function usageTokens(result: GenerateResult): number {
  const usage = result.usage as unknown as Record<string, unknown> | undefined;
  if (typeof usage?.totalTokens === "number") return usage.totalTokens;
  const input = usage?.inputTokens as Record<string, unknown> | undefined;
  const output = usage?.outputTokens as Record<string, unknown> | undefined;
  return (
    (typeof input?.total === "number" ? input.total : 0) +
    (typeof output?.total === "number" ? output.total : 0)
  );
}

/**
 * Make a doGenerate result JSON-safe for the journal: drop the raw HTTP `request` and
 * `response.headers`/`response.body` (possibly sensitive, never needed for replay),
 * ISO-encode `response.timestamp`, and base64/href-encode binary/URL file data.
 */
function sanitize(result: GenerateResult): GenerateResult {
  const { request: _request, response, content, ...rest } = result;
  const out: Record<string, unknown> = {
    ...rest,
    content: content.map((part) => sanitizePart(part as unknown as Record<string, unknown>)),
  };
  if (response) {
    const { headers: _headers, body: _body, ...meta } = response;
    out.response =
      meta.timestamp instanceof Date ? { ...meta, timestamp: meta.timestamp.toISOString() } : meta;
  }
  return out as unknown as GenerateResult;
}

function sanitizePart(part: Record<string, unknown>): Record<string, unknown> {
  const data = part.data as Record<string, unknown> | undefined;
  if (data && typeof data === "object") {
    if (data.type === "data" && data.data instanceof Uint8Array) {
      // A base64 string is a spec-valid encoding of file bytes, so the revived value
      // stays consumable; the Uint8Array form is not restored.
      return { ...part, data: { ...data, data: Buffer.from(data.data).toString("base64") } };
    }
    if (data.type === "url" && data.url instanceof URL) {
      return { ...part, data: { ...data, url: data.url.href } };
    }
  }
  return part;
}

/** Restore the non-JSON values `sanitize` encoded: `Date` timestamps and `URL` file data. */
function revive(journaled: GenerateResult): GenerateResult {
  const r = journaled as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...r };
  const response = r.response as Record<string, unknown> | undefined;
  if (response && typeof response.timestamp === "string") {
    out.response = { ...response, timestamp: new Date(response.timestamp) };
  }
  const content = r.content as Record<string, unknown>[] | undefined;
  if (Array.isArray(content)) {
    out.content = content.map((part) => {
      const data = part.data as Record<string, unknown> | undefined;
      if (data && typeof data === "object" && data.type === "url" && typeof data.url === "string") {
        return { ...part, data: { ...data, url: new URL(data.url) } };
      }
      return part;
    });
  }
  return out as unknown as GenerateResult;
}
