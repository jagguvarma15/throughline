import { LeaseLostError, type Store, WorkflowNotFoundError } from "@through-line/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

export type StoreFactory = () => Store | Promise<Store>;

/** Poll until `cond` holds; wake delivery (NOTIFY) is asynchronous by nature. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for a wake");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Store-level conformance battery. Both store-sqlite and store-postgres run this
 * unchanged to prove they implement the same contract (incl. the deviations:
 * lease fencing, UPSERT appendStep, atomic consumeEventIntoJournal).
 */
export function defineStoreSuite(makeStore: StoreFactory): void {
  describe("Store conformance", () => {
    let store: Store;

    beforeEach(async () => {
      store = await makeStore();
      await store.init();
    });

    afterEach(async () => {
      await store.close();
    });

    it("init is idempotent", async () => {
      await store.init();
      await store.init();
      const wf = await store.createWorkflow({ name: "t", input: 1, now: 1 });
      expect(wf.id).toBeTruthy();
    });

    it("createWorkflow + getWorkflow round-trips JSON", async () => {
      const wf = await store.createWorkflow({ name: "task", input: { a: 1, b: [2] }, now: 1000 });
      expect(wf.status).toBe("pending");
      expect(wf.input).toEqual({ a: 1, b: [2] });
      expect(wf.leaseEpoch).toBe(0);
      const got = await store.getWorkflow(wf.id);
      expect(got?.id).toBe(wf.id);
      expect(got?.input).toEqual({ a: 1, b: [2] });
    });

    it("getWorkflow returns null for a missing id", async () => {
      expect(await store.getWorkflow("nope")).toBeNull();
    });

    it("createWorkflow honors idempotencyKey (returns existing, ignores new input)", async () => {
      const a = await store.createWorkflow({ name: "t", input: 1, idempotencyKey: "k", now: 1 });
      const b = await store.createWorkflow({ name: "t", input: 2, idempotencyKey: "k", now: 2 });
      expect(b.id).toBe(a.id);
      expect(b.input).toBe(1);
    });

    it("claim takes a fenced lease on a pending workflow", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 1000, 100);
      if (!c) throw new Error("expected a claim");
      expect(c.id).toBe(wf.id);
      expect(c.status).toBe("running");
      expect(c.lockedBy).toBe("w1");
      expect(c.leaseEpoch).toBe(1);
      expect(c.leaseExpiresAt).toBe(1100);
    });

    it("claim returns null when nothing is runnable", async () => {
      expect(await store.claim("w1", 1000, 1)).toBeNull();
    });

    it("a second claim never returns an already-claimed (validly leased) workflow", async () => {
      await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const a = await store.claim("w1", 1000, 100);
      const b = await store.claim("w2", 1000, 200);
      expect(a).not.toBeNull();
      expect(b).toBeNull();
    });

    it("claim re-claims a running workflow whose lease expired (bumps epoch + recovery)", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      await store.claim("w1", 1000, 100); // lease -> 1100
      expect(await store.claim("w2", 1000, 500)).toBeNull(); // still leased
      const b = await store.claim("w2", 1000, 2000); // expired
      if (!b) throw new Error("expected re-claim");
      expect(b.id).toBe(wf.id);
      expect(b.lockedBy).toBe("w2");
      expect(b.leaseEpoch).toBe(2);
      expect(b.recoveryAttempts).toBe(1);
    });

    it("heartbeat extends the lease and enforces the fence", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 1000, 100);
      if (!c) throw new Error("expected a claim");
      const hb = await store.heartbeat(wf.id, { workerId: "w1", leaseEpoch: c.leaseEpoch }, 1000, 300);
      expect(hb.cancelRequested).toBe(false);
      expect((await store.getWorkflow(wf.id))?.leaseExpiresAt).toBe(1300);
      await expect(
        store.heartbeat(wf.id, { workerId: "w1", leaseEpoch: 999 }, 1000, 400),
      ).rejects.toBeInstanceOf(LeaseLostError);
    });

    it("heartbeat reports a requested cancel in the same write", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 1000, 100);
      if (!c) throw new Error("expected a claim");
      expect(await store.requestCancel(wf.id, 200)).toBe("requested");
      const hb = await store.heartbeat(wf.id, { workerId: "w1", leaseEpoch: c.leaseEpoch }, 1000, 300);
      expect(hb.cancelRequested).toBe(true);
    });

    it("appendStep allocates seq; loadJournal is ordered by seq", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 10_000, 1);
      if (!c) throw new Error("expected a claim");
      const fence = { workerId: "w1", leaseEpoch: c.leaseEpoch };
      const r0 = await store.appendStep({
        workflowId: wf.id,
        stepKey: "a#0",
        status: "completed",
        output: 10,
        attempts: 1,
        now: 2,
        fence,
      });
      const r1 = await store.appendStep({
        workflowId: wf.id,
        stepKey: "b#0",
        status: "completed",
        output: 20,
        attempts: 1,
        now: 3,
        fence,
      });
      expect(r0.seq).toBe(0);
      expect(r0.cancelRequested).toBe(false);
      expect(r1.seq).toBe(1);
      const j = await store.loadJournal(wf.id);
      expect(j.map((s) => s.stepKey)).toEqual(["a#0", "b#0"]);
      expect(j.find((s) => s.stepKey === "a#0")?.output).toBe(10);
    });

    it("appendStep reports a requested cancel in the same transaction", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 10_000, 1);
      if (!c) throw new Error("expected a claim");
      expect(await store.requestCancel(wf.id, 2)).toBe("requested");
      const r = await store.appendStep({
        workflowId: wf.id,
        stepKey: "a#0",
        status: "completed",
        output: 1,
        attempts: 1,
        now: 3,
        fence: { workerId: "w1", leaseEpoch: c.leaseEpoch },
      });
      expect(r.cancelRequested).toBe(true);
      // Replays report it too: the flag is a row read, not tied to the insert.
      const again = await store.appendStep({
        workflowId: wf.id,
        stepKey: "a#0",
        status: "completed",
        output: 1,
        attempts: 1,
        now: 4,
        fence: { workerId: "w1", leaseEpoch: c.leaseEpoch },
      });
      expect(again.replayed).toBe(true);
      expect(again.cancelRequested).toBe(true);
    });

    it("claim carries the cancel flag of a re-claimed run", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      await store.claim("w1", 1000, 100); // lease -> 1100
      expect(await store.requestCancel(wf.id, 200)).toBe("requested");
      const re = await store.claim("w2", 1000, 5000); // expired -> crash re-claim
      expect(re?.id).toBe(wf.id);
      expect(re?.cancelRequested).toBe(true);
    });

    it("appendStep is an idempotent no-op on a completed key (replay)", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 10_000, 1);
      if (!c) throw new Error("expected a claim");
      const fence = { workerId: "w1", leaseEpoch: c.leaseEpoch };
      const r0 = await store.appendStep({
        workflowId: wf.id,
        stepKey: "a#0",
        status: "completed",
        output: "first",
        attempts: 1,
        now: 2,
        fence,
      });
      const r1 = await store.appendStep({
        workflowId: wf.id,
        stepKey: "a#0",
        status: "completed",
        output: "second",
        attempts: 1,
        now: 3,
        fence,
      });
      expect(r1.replayed).toBe(true);
      expect(r1.seq).toBe(r0.seq);
      const j = await store.loadJournal(wf.id);
      expect(j).toHaveLength(1);
      expect(j[0]?.output).toBe("first");
    });

    it("appendStep UPSERTs a failed row to completed, preserving seq", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 10_000, 1);
      if (!c) throw new Error("expected a claim");
      const fence = { workerId: "w1", leaseEpoch: c.leaseEpoch };
      const f = await store.appendStep({
        workflowId: wf.id,
        stepKey: "a#0",
        status: "failed",
        error: { message: "x", type: "E" },
        attempts: 3,
        now: 2,
        fence,
      });
      const ok = await store.appendStep({
        workflowId: wf.id,
        stepKey: "a#0",
        status: "completed",
        output: 42,
        attempts: 4,
        now: 3,
        fence,
      });
      expect(ok.seq).toBe(f.seq);
      const j = await store.loadJournal(wf.id);
      expect(j).toHaveLength(1);
      expect(j[0]?.status).toBe("completed");
      expect(j[0]?.output).toBe(42);
      expect(j[0]?.attempts).toBe(4);
    });

    it("appendStep rejects a stale fence with LeaseLostError", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      await store.claim("w1", 10_000, 1);
      await expect(
        store.appendStep({
          workflowId: wf.id,
          stepKey: "a#0",
          status: "completed",
          output: 1,
          attempts: 1,
          now: 2,
          fence: { workerId: "w1", leaseEpoch: 999 },
        }),
      ).rejects.toBeInstanceOf(LeaseLostError);
    });

    it("appendStep on a missing workflow throws WorkflowNotFoundError", async () => {
      await expect(
        store.appendStep({
          workflowId: "nope",
          stepKey: "a#0",
          status: "completed",
          attempts: 1,
          now: 1,
        }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    });

    it("consumeEventIntoJournal atomically consumes an event and journals it", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 10_000, 1);
      if (!c) throw new Error("expected a claim");
      const fence = { workerId: "w1", leaseEpoch: c.leaseEpoch };
      await store.addEvent(wf.id, "approve", "yes", 5);
      const r = await store.consumeEventIntoJournal({
        workflowId: wf.id,
        stepKey: "approve#0",
        name: "approve",
        now: 6,
        fence,
      });
      expect(r).toEqual({ found: true, payload: "yes", seq: 0 });
      const j = await store.loadJournal(wf.id);
      expect(j).toHaveLength(1);
      expect(j[0]?.kind).toBe("event");
      expect(j[0]?.output).toBe("yes");
      // journal-first: a replay returns the journaled payload without re-consuming
      const again = await store.consumeEventIntoJournal({
        workflowId: wf.id,
        stepKey: "approve#0",
        name: "approve",
        now: 7,
        fence,
      });
      expect(again).toEqual({ found: true, payload: "yes", seq: 0 });
    });

    it("consumeEventIntoJournal returns found:false when no event is available", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 10_000, 1);
      if (!c) throw new Error("expected a claim");
      const r = await store.consumeEventIntoJournal({
        workflowId: wf.id,
        stepKey: "approve#0",
        name: "approve",
        now: 6,
        fence: { workerId: "w1", leaseEpoch: c.leaseEpoch },
      });
      expect(r).toEqual({ found: false });
    });

    it("claim makes a waiting+event workflow runnable once a matching event arrives", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 1000, 10);
      if (!c) throw new Error("expected a claim");
      // Park and release in one patch - the exact release path the worker uses.
      await store.updateWorkflow(
        wf.id,
        { status: "waiting", waitEvent: "go", lockedBy: null, leaseExpiresAt: null },
        { workerId: "w1", leaseEpoch: c.leaseEpoch },
      );
      expect(await store.claim("w2", 1000, 20)).toBeNull(); // no event yet
      await store.addEvent(wf.id, "go", null, 30);
      const re = await store.claim("w2", 1000, 40);
      expect(re?.id).toBe(wf.id);
    });

    it("claim makes a waiting+timer workflow runnable at wake_at", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 1000, 10);
      if (!c) throw new Error("expected a claim");
      // Park and release in one patch - the exact release path the worker uses.
      await store.updateWorkflow(
        wf.id,
        { status: "waiting", wakeAt: 5000, lockedBy: null, leaseExpiresAt: null },
        { workerId: "w1", leaseEpoch: c.leaseEpoch },
      );
      expect(await store.claim("w2", 1000, 4999)).toBeNull();
      expect((await store.claim("w2", 1000, 5000))?.id).toBe(wf.id);
    });

    it("updateWorkflow patches fields and supports the cancelled terminal status", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      await store.updateWorkflow(wf.id, { status: "cancelled", output: { done: true } });
      const got = await store.getWorkflow(wf.id);
      expect(got?.status).toBe("cancelled");
      expect(got?.output).toEqual({ done: true });
    });

    it("requestCancel cancels pending and waiting runs", async () => {
      const a = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      expect(await store.requestCancel(a.id, 2)).toBe("cancelled");
      expect((await store.getWorkflow(a.id))?.status).toBe("cancelled");

      const b = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 1000, 10);
      if (!c) throw new Error("expected a claim");
      await store.updateWorkflow(
        b.id,
        { status: "waiting", waitEvent: "go" },
        { workerId: "w1", leaseEpoch: c.leaseEpoch },
      );
      expect(await store.requestCancel(b.id, 20)).toBe("cancelled");
      const got = await store.getWorkflow(b.id);
      expect(got?.status).toBe("cancelled");
      expect(got?.waitEvent).toBeNull();
    });

    it("requestCancel only flags a running run for cooperative cancel", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      await store.claim("w1", 10_000, 1);
      expect(await store.requestCancel(wf.id, 2)).toBe("requested");
      const got = await store.getWorkflow(wf.id);
      expect(got?.status).toBe("running");
      expect(got?.cancelRequested).toBe(true);
    });

    it("listWorkflows returns newest-first and filters by status", async () => {
      const a = await store.createWorkflow({ name: "a", input: 0, now: 1 });
      const b = await store.createWorkflow({ name: "b", input: 0, now: 2 });
      expect((await store.listWorkflows()).map((w) => w.id)).toEqual([b.id, a.id]);
      await store.updateWorkflow(a.id, { status: "completed" });
      expect((await store.listWorkflows({ status: "completed" })).map((w) => w.id)).toEqual([a.id]);
      expect((await store.listWorkflows({ limit: 1 })).length).toBe(1);
    });

    it("stats aggregates workflow statuses and step tokens", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 10_000, 1);
      if (!c) throw new Error("expected a claim");
      const fence = { workerId: "w1", leaseEpoch: c.leaseEpoch };
      await store.appendStep({
        workflowId: wf.id,
        stepKey: "a#0",
        status: "completed",
        output: 1,
        attempts: 1,
        cost: 5,
        now: 2,
        fence,
      });
      await store.appendStep({
        workflowId: wf.id,
        stepKey: "b#0",
        status: "failed",
        error: { message: "x", type: "E" },
        attempts: 3,
        cost: 2,
        now: 3,
        fence,
      });
      const s = await store.stats();
      expect(s.workflowsByStatus.running).toBe(1);
      expect(s.stepCount).toBe(2);
      expect(s.failedStepCount).toBe(1);
      expect(s.tokenSum).toBe(7);
    });

    it("stats reports the highest recovery count across live runs", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      await store.claim("w1", 1000, 100); // lease -> 1100
      const re = await store.claim("w2", 1000, 5000); // expired -> crash re-claim
      expect(re?.id).toBe(wf.id);
      const s = await store.stats();
      expect(s.maxRecoveryAttempts).toBe(1);
    });

    it("pruneRuns deletes only old terminal runs, with their steps and events", async () => {
      // Fences are optional on writes, so terminal fixtures can be built without
      // claiming (claiming would race with other pending rows in this test).
      const mk = async (status: string, at: number) => {
        const wf = await store.createWorkflow({ name: "t", input: 0, now: at });
        await store.appendStep({
          workflowId: wf.id,
          stepKey: "a#0",
          status: "completed",
          output: 1,
          attempts: 1,
          now: at,
        });
        await store.addEvent(wf.id, "e", null, at);
        await store.updateWorkflow(wf.id, { status: status as never });
        return wf.id;
      };
      // updated_at is bumped by updateWorkflow's clock, so distinguish via prune cutoff
      // by pruning "now" far in the future for old rows and asserting per-status effects.
      const oldCompleted = await mk("completed", 1000);
      const oldDead = await mk("dead", 1000);
      const keptPending = await store.createWorkflow({ name: "t", input: 0, now: 1000 });

      const farFuture = Date.now() + 10 * 86_400_000;
      const pruned = await store.pruneRuns({ olderThanMs: 1000, now: farFuture });
      expect(pruned).toBe(2);
      expect(await store.getWorkflow(oldCompleted)).toBeNull();
      expect(await store.getWorkflow(oldDead)).toBeNull();
      expect(await store.loadJournal(oldCompleted)).toHaveLength(0);
      expect((await store.getWorkflow(keptPending.id))?.status).toBe("pending");

      // A terminal run inside the TTL survives (its updated_at is the store clock's
      // real now; a 20-day TTL from farFuture puts the cutoff safely before it).
      const freshCompleted = await mk("completed", farFuture);
      expect(await store.pruneRuns({ olderThanMs: 20 * 86_400_000, now: farFuture })).toBe(0);
      expect((await store.getWorkflow(freshCompleted))?.status).toBe("completed");

      await expect(
        store.pruneRuns({ olderThanMs: 0, now: farFuture, statuses: ["running"] }),
      ).rejects.toThrow(/terminal/);
    });

    it("stats tokenSum survives sums past the 32-bit integer range", async () => {
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      const c = await store.claim("w1", 10_000, 1);
      if (!c) throw new Error("expected a claim");
      const fence = { workerId: "w1", leaseEpoch: c.leaseEpoch };
      await store.appendStep({
        workflowId: wf.id,
        stepKey: "a#0",
        status: "completed",
        output: 1,
        attempts: 1,
        cost: 2_000_000_000,
        now: 2,
        fence,
      });
      await store.appendStep({
        workflowId: wf.id,
        stepKey: "b#0",
        status: "completed",
        output: 1,
        attempts: 1,
        cost: 2_000_000_000,
        now: 3,
        fence,
      });
      const s = await store.stats();
      expect(s.tokenSum).toBe(4_000_000_000);
    });

    // Optional capability: exercised only when the store implements subscribeWake
    // (postgres); stores without it (sqlite) pass these trivially by returning early.
    it("subscribeWake fires when a new workflow is created", async () => {
      if (!store.subscribeWake) return;
      let wakes = 0;
      const unsubscribe = await store.subscribeWake(() => {
        wakes++;
      });
      await store.createWorkflow({ name: "t", input: 0, now: 1 });
      await waitFor(() => wakes > 0);
      await unsubscribe();
    });

    it("subscribeWake fires when an event is added", async () => {
      if (!store.subscribeWake) return;
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      let wakes = 0;
      const unsubscribe = await store.subscribeWake(() => {
        wakes++;
      });
      await store.addEvent(wf.id, "go", null, 5);
      await waitFor(() => wakes > 0);
      await unsubscribe();
    });

    it("subscribeWake fires when a run is patched back to pending (redrive)", async () => {
      if (!store.subscribeWake) return;
      const wf = await store.createWorkflow({ name: "t", input: 0, now: 1 });
      await store.updateWorkflow(wf.id, { status: "dead" });
      let wakes = 0;
      const unsubscribe = await store.subscribeWake(() => {
        wakes++;
      });
      await store.updateWorkflow(wf.id, { status: "pending" });
      await waitFor(() => wakes > 0);
      await unsubscribe();
    });

    it("subscribeWake stops firing after unsubscribe", async () => {
      if (!store.subscribeWake) return;
      let wakes = 0;
      const unsubscribe = await store.subscribeWake(() => {
        wakes++;
      });
      await store.createWorkflow({ name: "t", input: 0, now: 1 });
      await waitFor(() => wakes > 0);
      await unsubscribe();
      const seen = wakes;
      await store.createWorkflow({ name: "t2", input: 0, now: 2 });
      // Give a straggler a moment to (wrongly) arrive before asserting silence.
      await new Promise((r) => setTimeout(r, 250));
      expect(wakes).toBe(seen);
    });
  });
}
