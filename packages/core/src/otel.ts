import type { Span, Tracer } from "@opentelemetry/api";

export interface Tracing {
  tracer: Tracer;
  ok: number;
  error: number;
}

let apiPromise: Promise<typeof import("@opentelemetry/api") | null> | undefined;

function loadApi(): Promise<typeof import("@opentelemetry/api") | null> {
  if (apiPromise === undefined) {
    apiPromise = import("@opentelemetry/api").then(
      (m) => m,
      () => null,
    );
  }
  return apiPromise;
}

/**
 * Resolve a tracing facade backed by @opentelemetry/api, or null when that optional peer
 * is not installed. When installed but no provider is registered, the API's no-op tracer
 * is used, so spans are free — telemetry is strictly opt-in.
 */
export async function loadTracing(): Promise<Tracing | null> {
  const api = await loadApi();
  if (!api) return null;
  return {
    tracer: api.trace.getTracer("@throughline/core", "0.1.0"),
    ok: api.SpanStatusCode.OK,
    error: api.SpanStatusCode.ERROR,
  };
}

export type { Span, Tracer };
