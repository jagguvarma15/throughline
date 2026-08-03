// HTTP implementation of the Ops facade, mirroring the control-plane routes. Used by
// the CLI's --url mode so operators can point at a remote deployment instead of a DB.

import {
  type ListWorkflowsOptions,
  type Ops,
  type RunDetail,
  type StartRunInput,
  type StoreStats,
  WorkflowNotFoundError,
  type WorkflowRow,
} from "@through-line/core";

async function request<T>(
  url: string,
  headers: Record<string, string>,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { ...init, headers: { ...headers, ...init?.headers } });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok && res.status !== 404) {
    const detail = (body as { error?: string } | undefined)?.error ?? res.statusText;
    throw new Error(`control-plane request failed: ${res.status} ${detail}`);
  }
  return { status: res.status, body: body as T };
}

export function createHttpOps(baseUrl: string, token?: string): Ops {
  const base = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const post = (path: string, body?: unknown) =>
    request<unknown>(`${base}${path}`, headers, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const signal = async (id: string, name: string, payload?: unknown): Promise<void> => {
    const r = await post(`/runs/${encodeURIComponent(id)}/signal`, { name, payload });
    if (r.status === 404) throw new WorkflowNotFoundError(id);
  };

  return {
    async listRuns(opts?: ListWorkflowsOptions): Promise<WorkflowRow[]> {
      const url = new URL(`${base}/runs`);
      if (opts?.status) url.searchParams.set("status", opts.status);
      if (opts?.limit !== undefined) url.searchParams.set("limit", String(opts.limit));
      const r = await request<{ runs: WorkflowRow[] }>(url.toString(), headers);
      return r.body.runs;
    },

    async getRun(id: string): Promise<RunDetail | null> {
      const r = await request<RunDetail>(`${base}/runs/${encodeURIComponent(id)}`, headers);
      return r.status === 404 ? null : r.body;
    },

    async startRun(input: StartRunInput): Promise<{ id: string }> {
      const r = await post("/runs", input);
      return r.body as { id: string };
    },

    signal,

    approve(id: string, name: string, approved = true): Promise<void> {
      return signal(id, name, { approved });
    },

    async cancel(id: string): Promise<"cancelled" | "requested" | "noop"> {
      const r = await post(`/runs/${encodeURIComponent(id)}/cancel`);
      return (r.body as { result: "cancelled" | "requested" | "noop" }).result;
    },

    async stats(): Promise<StoreStats> {
      const r = await request<StoreStats>(`${base}/stats`, headers);
      return r.body;
    },
  };
}
