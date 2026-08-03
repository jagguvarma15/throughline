# Recipe: record/replay regression testing

A multi-step agent is expensive to regression-test if every run bills real model calls.
Throughline journals every step, so a recorded trajectory can be replayed offline - with
models that throw if anything reaches the network - to prove a refactor did not change
behavior.

## Record a golden trace

```ts
import { seedGolden, toGolden, writeGolden, goldenExists, readGolden } from "@through-line/testing";
import { sqlite } from "@through-line/store-sqlite";

// Run the task once against a real (or scripted) model, then snapshot it.
const store = sqlite(":memory:");
// ... register the task, start it, drive worker.runOnce() to completion ...
const trace = await toGolden(store, runId);
writeGolden("test/fixtures/research.golden.json", trace);
```

Refresh fixtures intentionally with an env flag (this repo uses `UPDATE_GOLDEN=1`).

## Replay it offline

```ts
const golden = readGolden("test/fixtures/research.golden.json");
const store = sqlite(":memory:");
await seedGolden(store, golden); // loads the journal as if the run had just crashed

const tf = throughline({ store, sleep: async () => {} });
registerResearch(tf, {
  model: async () => {
    throw new Error("network reached during replay"); // exploding model
  },
});
await tf.worker({ leaseMs: 1000 }).runOnce();

const run = await tf.getRun(golden.runId);
expect(run?.status).toBe("completed");
expect(run?.output).toEqual(golden.output); // byte-identical outcome, $0 spent
```

If a code change reorders, renames, or drops steps, the determinism guard fails the
replay with `NonDeterminismError` instead of silently producing a different answer -
that is the regression signal.

## Crash-schedule property tests

For the reliability claims themselves, `@through-line/testing` also ships `faultStore`
(inject a crash after any journal commit) and `defineEngineSuite`, which drives the same
task through randomized crash schedules and asserts identical final state and zero
duplicate keyed effects. See `examples/deep-research/test/demo.test.ts` for both styles
in one file.
