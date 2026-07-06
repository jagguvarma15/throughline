import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunState, StepRow, Store } from "@through-line/core";

/** A recorded run: input/output plus the journal, enough to replay offline. */
export interface GoldenTrace {
  name: string;
  input: unknown;
  output: unknown;
  status: string;
  steps: Array<
    Pick<StepRow, "stepKey" | "seq" | "status" | "kind" | "output" | "error" | "attempts" | "cost">
  >;
}

/** Snapshot a finished run into a portable golden trace. */
export function toGolden(run: RunState): GoldenTrace {
  return {
    name: run.name,
    input: run.input,
    output: run.output,
    status: run.status,
    steps: run.steps.map((s) => ({
      stepKey: s.stepKey,
      seq: s.seq,
      status: s.status,
      kind: s.kind,
      output: s.output,
      error: s.error,
      attempts: s.attempts,
      cost: s.cost,
    })),
  };
}

export function readGolden(path: string): GoldenTrace {
  return JSON.parse(readFileSync(path, "utf8")) as GoldenTrace;
}

export function writeGolden(path: string, trace: GoldenTrace): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(trace, null, 2)}\n`);
}

export function goldenExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Seed a store from a golden trace so a worker will REPLAY every step from the journal
 * (returning recorded outputs without executing any fn — no network). Returns the new
 * workflow id, left in `pending` so a worker can claim it.
 */
export async function seedGolden(store: Store, golden: GoldenTrace, now: number): Promise<string> {
  await store.init();
  const wf = await store.createWorkflow({ name: golden.name, input: golden.input, now });
  const claimed = await store.claim("golden-seed", 1_000_000_000, now);
  if (!claimed) throw new Error("golden seed: claim failed");
  const fence = { workerId: "golden-seed", leaseEpoch: claimed.leaseEpoch };
  for (const s of golden.steps) {
    await store.appendStep({
      workflowId: wf.id,
      stepKey: s.stepKey,
      status: s.status,
      kind: s.kind,
      output: s.output,
      error: s.error,
      attempts: s.attempts,
      cost: s.cost,
      now,
      fence,
    });
  }
  await store.updateWorkflow(
    wf.id,
    { status: "pending", lockedBy: null, leaseExpiresAt: null },
    fence,
  );
  return wf.id;
}
