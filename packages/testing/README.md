# @through-line/testing

The test harness that keeps [Throughline](https://github.com/jagguvarma15/throughline)'s
durability claims honest — and lets you make the same claims about your own agents.

## Install

```bash
pnpm add -D @through-line/testing
```

Peer dependency: `vitest >= 2`.

## What's inside

- **`faultStore(store, plan)`** — wraps any store and injects crashes at step boundaries
  (`crashAfterStep`, `crashAfterCommits`, `crashAt`, `duplicateStep`). A "crash" is a
  committed write followed by a lost lease — exactly the state a real `kill -9` leaves
  behind — so you can assert your task resumes with zero duplicate effects.
- **`controlledClock(start)`** — a manually advanced clock; test lease expiry, durable
  timers, and timeouts without sleeps or flakes.
- **Golden traces** — `toGolden(run)` / `seedGolden(store, trace)` record a run's journal
  and replay it offline. Pair with "exploding" model/tool stubs that throw if called to
  prove a replay never touches the network (~$0 regression tests for multi-step agents).
- **Conformance suites** — `defineStoreSuite` (store contract: fenced leases, idempotent
  journal appends, atomic event consume) and `defineEngineSuite` (end-to-end semantics:
  crash-replay, exactly-once keyed effects, durable approvals, budget halts — including a
  property test across 120 randomized crash schedules). Building a custom store? Run both
  suites against it and you inherit Throughline's guarantees.

## Example: prove your task crash-resumes

```ts
import { throughline } from "@through-line/core";
import { sqlite } from "@through-line/store-sqlite";
import { faultStore, controlledClock, type FaultPlan } from "@through-line/testing";

const plan: FaultPlan = { crashAfterStep: "charge#0" };
const store = faultStore(sqlite(":memory:"), plan);
const tf = throughline({ store, clock: controlledClock(1000), sleep: async () => {} });

// ...register your task, start a run, worker.runOnce() -> crash after "charge#0"...
// clear the fault, advance the clock past the lease, runOnce() again:
// assert your charge side effect ran exactly once.
```

MIT © Jagadesh Varma Nadimpalli
