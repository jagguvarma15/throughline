const BASE = import.meta.env.VITE_CP_URL ?? "http://localhost:3001";

export interface Run {
  id: string;
  name: string;
  status: string;
  waitEvent: string | null;
  output: unknown;
  error: { message: string } | null;
  createdAt: number;
  updatedAt: number;
}

export interface Step {
  stepKey: string;
  seq: number;
  status: string;
  kind: string;
  output: unknown;
  attempts: number;
  completedAt: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export async function listRuns(status?: string): Promise<Run[]> {
  const url = new URL(`${BASE}/runs`);
  if (status) url.searchParams.set("status", status);
  return (await json<{ runs: Run[] }>(await fetch(url))).runs;
}

export async function getRun(id: string): Promise<{ run: Run; steps: Step[] }> {
  return json<{ run: Run; steps: Step[] }>(await fetch(`${BASE}/runs/${id}`));
}

export async function signalRun(id: string, name: string, payload: unknown): Promise<void> {
  await json(
    await fetch(`${BASE}/runs/${id}/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, payload }),
    }),
  );
}

export async function cancelRun(id: string): Promise<void> {
  await json(await fetch(`${BASE}/runs/${id}/cancel`, { method: "POST" }));
}
