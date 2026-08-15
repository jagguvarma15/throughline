import { describe, expect, it } from "vitest";
import { WakeController } from "../src/engine/wake";
import { Worker } from "../src/engine/worker";
import { DEFAULT_RETRY } from "../src/retry";
import type { Store, TaskRegistration, WorkflowRow } from "../src/types";

function makeRow(id: string): WorkflowRow {
  return {
    id,
    name: "t",
    status: "running",
    input: null,
    output: null,
    error: null,
    idempotencyKey: null,
    version: 1,
    seqCounter: 0,
    recoveryAttempts: 0,
    wakeAt: null,
    waitEvent: null,
    lockedBy: "w",
    leaseEpoch: 1,
    leaseExpiresAt: null,
    heartbeatAt: null,
    cancelRequested: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

interface StubHooks {
  /** Scripted claim results by call index: true yields a claimable row. */
  claims?: boolean[];
  /** When set, the stub advertises subscribeWake and hands the listener out here. */
  onSubscribe?: (listener: () => void) => void;
  onUnsubscribe?: () => void;
}

function stubStore(hooks: StubHooks = {}): { store: Store; claimCount: () => number } {
  let claimCalls = 0;
  const store: Store = {
    init: async () => {},
    createWorkflow: async () => {
      throw new Error("unused in worker tests");
    },
    getWorkflow: async () => null,
    claim: async () => {
      const hit = hooks.claims?.[claimCalls] ?? false;
      claimCalls++;
      return hit ? makeRow(`run-${claimCalls}`) : null;
    },
    heartbeat: async () => ({ cancelRequested: false }),
    loadJournal: async () => [],
    appendStep: async () => ({ seq: 0, replayed: false, cancelRequested: false }),
    updateWorkflow: async () => {},
    addEvent: async () => {},
    consumeEventIntoJournal: async () => ({ found: false }),
    requestCancel: async () => "noop",
    listWorkflows: async () => [],
    stats: async () => ({
      workflowsByStatus: {},
      stepCount: 0,
      failedStepCount: 0,
      tokenSum: 0,
      maxRecoveryAttempts: 0,
    }),
    pruneRuns: async () => 0,
    resetFailedSteps: async () => 0,
    close: () => {},
  };
  if (hooks.onSubscribe) {
    store.subscribeWake = async (listener) => {
      hooks.onSubscribe?.(listener);
      return async () => {
        hooks.onUnsubscribe?.();
      };
    };
  }
  return { store, claimCount: () => claimCalls };
}

/**
 * A recording sleeper: resolves instantly except at the 1-based sleep indices in
 * blockAt, where it hangs forever (the WakeController race is the only way out).
 */
function recordingSleeper(blockAt: number[] = []) {
  const recorded: number[] = [];
  const waiters: Array<{ at: number; resolve: () => void }> = [];
  const sleep = (ms: number): Promise<void> => {
    recorded.push(ms);
    const at = recorded.length;
    for (const w of waiters) {
      if (w.at <= at) w.resolve();
    }
    if (blockAt.includes(at)) return new Promise<void>(() => {});
    return Promise.resolve();
  };
  const whenSleepCount = (at: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (recorded.length >= at) resolve();
      else waiters.push({ at, resolve });
    });
  return { recorded, sleep, whenSleepCount };
}

const registry = new Map<string, TaskRegistration>([["t", { handler: async () => "ok" }]]);

function makeWorker(
  store: Store,
  sleep: (ms: number) => Promise<void>,
  opts: { pollIntervalMs?: number; maxPollIntervalMs?: number; concurrency?: number } = {},
): Worker {
  return new Worker({
    store,
    registry,
    defaultRetry: DEFAULT_RETRY,
    sleep,
    workerId: "w-test",
    ...opts,
  });
}

describe("WakeController", () => {
  it("a full sleep elapses and reports not-woken", async () => {
    const wc = new WakeController();
    const woken = await wc.sleep(5, (ms) => new Promise((r) => setTimeout(r, ms)));
    expect(woken).toBe(false);
  });

  it("wakeAll interrupts every concurrent sleeper", async () => {
    const wc = new WakeController();
    const never = (): Promise<void> => new Promise(() => {});
    const s1 = wc.sleep(1000, never);
    const s2 = wc.sleep(1000, never);
    wc.wakeAll();
    expect(await s1).toBe(true);
    expect(await s2).toBe(true);
  });

  it("a wake with no sleeper is remembered for the next sleep", async () => {
    const wc = new WakeController();
    wc.wakeAll();
    const woken = await wc.sleep(1000, () => new Promise(() => {}));
    expect(woken).toBe(true);
  });
});

describe("Worker idle backoff", () => {
  it("doubles the idle delay from the floor to the cap", async () => {
    const { store } = stubStore();
    const s = recordingSleeper([7]);
    const worker = makeWorker(store, s.sleep);
    worker.start();
    await s.whenSleepCount(7);
    expect(s.recorded.slice(0, 7)).toEqual([200, 400, 800, 1600, 3200, 5000, 5000]);
    await worker.stop();
  });

  it("resets the delay to the floor after a successful claim", async () => {
    const { store } = stubStore({ claims: [false, false, true, false, false] });
    const s = recordingSleeper([4]);
    const worker = makeWorker(store, s.sleep);
    worker.start();
    await s.whenSleepCount(4);
    expect(s.recorded.slice(0, 4)).toEqual([200, 400, 200, 400]);
    await worker.stop();
  });

  it("a store wake resets the delay and triggers an immediate claim", async () => {
    const wake: { fn: (() => void) | null } = { fn: null };
    const { store, claimCount } = stubStore({
      onSubscribe: (l) => {
        wake.fn = l;
      },
    });
    const s = recordingSleeper([3, 4]);
    const worker = makeWorker(store, s.sleep);
    worker.start();
    await s.whenSleepCount(3); // blocked at the 800ms sleep
    const claimsBefore = claimCount();
    wake.fn?.();
    await s.whenSleepCount(4);
    expect(claimCount()).toBe(claimsBefore + 1);
    expect(s.recorded.slice(0, 4)).toEqual([200, 400, 800, 200]);
    await worker.stop();
  });

  it("stop resolves promptly even while a loop is mid-sleep", async () => {
    const { store } = stubStore();
    const s = recordingSleeper([1]);
    const worker = makeWorker(store, s.sleep);
    worker.start();
    await s.whenSleepCount(1); // parked in a never-resolving sleep
    await worker.stop(); // must not wait out the idle delay
    expect(s.recorded).toEqual([200]);
  });

  it("a floor above the cap wins: delays never drop below pollIntervalMs", async () => {
    const { store } = stubStore();
    const s = recordingSleeper([2]);
    const worker = makeWorker(store, s.sleep, {
      pollIntervalMs: 10_000,
      maxPollIntervalMs: 5000,
    });
    worker.start();
    await s.whenSleepCount(2);
    expect(s.recorded.slice(0, 2)).toEqual([10_000, 10_000]);
    await worker.stop();
  });

  it("one wake reaches every idle loop and the unsubscribe runs on stop", async () => {
    const wake: { fn: (() => void) | null } = { fn: null };
    let unsubscribed = false;
    const { store, claimCount } = stubStore({
      onSubscribe: (l) => {
        wake.fn = l;
      },
      onUnsubscribe: () => {
        unsubscribed = true;
      },
    });
    const s = recordingSleeper([1, 2, 3, 4]);
    const worker = makeWorker(store, s.sleep, { concurrency: 2 });
    worker.start();
    await s.whenSleepCount(2); // both loops parked after one claim each
    expect(claimCount()).toBe(2);
    wake.fn?.();
    await s.whenSleepCount(4); // both woke, claimed again, and are parked again
    expect(claimCount()).toBe(4);
    await worker.stop();
    expect(unsubscribed).toBe(true);
  });
});
