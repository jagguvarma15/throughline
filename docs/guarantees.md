# Throughline — Durability Guarantees

This document is the **contract**. Every durability test in this repo asserts against
the semantics described here. If code and this document disagree, one of them is a bug —
fix the code, or change this document *and* the tests in the same commit. Do not weaken a
guarantee to make a test pass.

Throughline is a durable-execution engine: it wraps an agent loop (or any multi-step
function) so that progress is checkpointed to a journal, and a crashed run is resumed by
re-claiming it and **replaying the journal** instead of starting over.

---

## 1. The durability boundary

Only the body of a `ctx.step(name, fn)` call is **durable**.

- The **first** successful execution of a step's `fn` is journaled: its return value is
  written to the `steps` table keyed by a stable `step_key`.
- On **every later replay**, a completed journal entry for that `step_key` is returned
  **verbatim** and **`fn` is not run again**.
- Code **between** steps (the handler body outside any `ctx.step`) is *not* durable. It
  re-executes from the top on every replay. It must therefore be **pure** — no network,
  no disk, no DB writes, no nondeterministic branching (see §4).

> Rule of thumb: if it touches the outside world or is nondeterministic, it belongs inside
> a `ctx.step`.

## 2. The side-effect contract — stated honestly

**Delivery is at-least-once.** A step's `fn` may run **more than once** across retries and
crash-recovery.

A side effect is **exactly-once *if and only if*** it is performed inside a `ctx.step`
**and** keyed by a stable `idempotencyKey` (the `step_key`), so that a duplicate delivery
is deduplicated by the downstream system.

- The engine guarantees the `step_key` is **stable across replays**. Thread it into the
  external call (e.g. as a Stripe/idempotency header, or a unique row key) to make the
  effect idempotent.
- There is **no unconditional "exactly-once."** A side effect that runs *outside* a step,
  or inside a step *without* an idempotency-keyed external operation, is at-least-once and
  may be observed more than once.

The single irreducible window: if `fn` performs an external effect and the process dies
**after** the effect but **before** the journal commit, the step has no journal entry, so
on recovery `fn` runs again. Only the idempotency key makes that second run a no-op
downstream. This is why we never claim more than the contract above.

## 3. Side effects live only inside steps

Network calls, DB writes, LLM calls, file writes, time reads, and randomness are
**non-pure** and must be wrapped in a `ctx.step` (or the journaled helpers `ctx.sleep` /
`ctx.waitForEvent`, and the recommended `ctx.now()` / `ctx.random()` micro-steps). Anything
non-pure left between steps will re-run on replay and corrupt the run.

## 4. Determinism of the step sequence

Across replays, up to the point of progress, the **order** and **identity** (`step_key`)
of `ctx.step` calls must be reproducible.

- `step_key = opts.idempotencyKey ?? `${name}#${ordinal}`` where `ordinal` is a per-`name`
  counter incremented **synchronously at the call site, before any `await`**. This makes
  even `Promise.all([ctx.step('a'…), ctx.step('b'…)])` deterministic.
- Nondeterministic **values** (wall-clock, random, model output) are allowed **only inside
  a step**, so they are journaled and replayed.
- **Never branch control flow on un-journaled nondeterminism.** Loop bounds and conditionals
  must derive from journaled data, not from live external state.

A **determinism guard** enforces this with two checks that are safe under concurrent steps
(a strict seq-order check would false-positive on legitimate `Promise.all` pairs, so the
guard is key-addressed instead):

1. **Kind mismatch, checked at every journal hit.** If a replayed call computes a
   `step_key` whose journal row has a different kind (`step` vs `sleep` vs
   `event`/`timeout`), a renamed or reordered call is aliasing into the wrong row.
2. **Unconsumed rows, checked at completion.** When the handler returns, every *completed*
   journal row must have been replayed by this execution; a leftover row means steps were
   removed, renamed, or reordered. Checking only at completion means a crash mid-
   `Promise.all` (one branch journaled, the other not) cannot false-positive.

The mode is set by `throughline({ determinism })`: `strict` throws `NonDeterminismError`
(the run lands `dead`), `warn` logs and continues, `off` disables. The default is `strict`
unless `NODE_ENV` is `production`, where it is `warn` — a false positive in production
should not kill runs.

## 5. The journal is the source of truth

Workflow state is reconstructed by **folding the journal**, not from in-memory state. After
a crash, another worker re-claims the workflow (its lease expired) and replays the journal:
completed steps replay from their recorded output; the first incomplete step re-runs.

A worker holds a **time-bounded lease** with a **fencing epoch** (bumped on each claim).
Every write a worker makes (`appendStep`, `updateWorkflow`, `heartbeat`) is conditioned on
its epoch; a zombie worker whose lease expired cannot overwrite the state of the worker that
re-claimed the run (it gets `LeaseLostError` and abandons). The journal's
`UNIQUE(workflow_id, step_key)` is the backstop that prevents a duplicate step row.

**Poison-pill guard.** `recovery_attempts` counts crash re-claims (re-claims of a `running`
run whose lease expired; waking a `waiting` run does *not* count). A run re-claimed more
than `maxRecoveryAttempts` times (worker option, default 10) is marked `dead` with
`RecoveryExhaustedError` instead of being retried forever — a run that reliably kills its
worker can no longer starve the queue.

---

## 6. Replay algorithm (`ctx.step`)

1. Compute `step_key` (§4). The journal is loaded once at run start and held in memory.
2. Look up the journal entry for `(workflow_id, step_key)`:
   - **completed** → return its output. **Do not run `fn`.** *(replay)*
   - **failed**, attempts < maxAttempts → fall through and execute. *(retry)*
   - **failed**, attempts ≥ maxAttempts → throw `StepError`.
   - **absent** → execute.
3. To execute: if a budget is set, check affordability first; if it can't afford the call,
   throw `BudgetExceededError` **before** running `fn`. Run `fn()`.
   - **success** → assign `seq = seq_counter++`; UPSERT the journal row to `completed`
     (with output, seq, attempts, cost); return the output.
   - **throw** → UPSERT the row to `failed` with the cumulative attempt count, then apply
     the retry policy (exponential backoff + jitter). **Every** failed attempt is journaled,
     not just the terminal one, so the retry budget survives a crash mid-retry-loop: on
     resume the attempt counter seeds from the journal and total executions of `fn` stay
     within `maxAttempts` (modulo the irreducible in-flight window of §2). When attempts
     are exhausted, throw `StepError` (which fails the workflow → `dead`). A
     `NonRetryableError` fails immediately with no retries.

`appendStep` is an UPSERT: a `failed` row is updated to `completed` on a successful retry; a
`completed` row is never overwritten.

## 7. Suspend / resume (events & timers)

`SuspendSignal` is **control flow, not an error**: it is never journaled as a failed step
and never counts against retries.

- **`ctx.waitForEvent(name)`** is **journal-first**. On replay, if a journal entry exists
  for this wait, its payload is returned. Otherwise the engine atomically **consumes** a
  matching unconsumed event **and journals the payload in one transaction**
  (`consumeEventIntoJournal`); if no event is available, it throws
  `SuspendSignal{ waitEvent: name }`. The worker then sets `status='waiting'`, records
  `wait_event`, and releases the lease. A later `tf.signal(...)` makes the run claimable
  again. *(Journal-first is required: a naive "consume on every replay" would re-consume the
  event on a later full replay and deadlock the run.)*
- **`ctx.waitForApproval(name)`** is sugar over `waitForEvent` returning a boolean.
- **`ctx.sleep(name, ms)`** journals an **absolute deadline** `T = now + ms` and suspends
  with `SuspendSignal{ wakeAt: T }`. On replay it reads `T` from the journal: if `now ≥ T`
  it proceeds; if `now < T` (e.g. a reclaim before the timer fired) it **re-suspends with
  the same `T`** — the deadline is never recomputed.
- A wait **timeout** is journaled with **event-wins ordering**: once a replay has taken the
  timeout branch it stays taken, and a late event cannot flip it.

## 8. Token budgets

`ctx.tokens` accounting is **reconstructed from journaled step costs**, so it is identical
across replays. A replayed step does **not** re-evaluate the affordability gate (it already
ran), but its journaled cost is re-added to the running total. The pre-`fn` gate applies
only to **fresh** executions and uses an a-priori estimate from `opts.budget`; when the
budget cannot afford the next step, the engine throws `BudgetExceededError` **before**
running `fn`, leaving a consistent journal.

## 9. Cancellation

`tf.cancel(id)` moves a `pending`/`waiting` run to the terminal `cancelled` status with a
conditional update (a no-op if the run already reached a terminal state). A **running** run
is cancelled cooperatively: the heartbeat observes the cancel request and `ctx.step` throws
an internal `CancelledError` at the next step boundary. `cancelled` is distinct from
`failed`/`dead`.

## 10. Error taxonomy

| Error | Meaning |
|---|---|
| `StepError` | A step failed after exhausting retries → the workflow becomes `dead`. |
| `NonRetryableError` | Skip retries; fail the step immediately. |
| `BudgetExceededError` | A budget would be exceeded; thrown **before** a step's `fn` runs. |
| `SuspendSignal` | Internal control flow for durable waits/sleeps. Never journaled as a failure. |
| `CancelledError` | Internal control flow for cooperative cancellation of a running step. |
| `LeaseLostError` | A worker's fencing epoch is stale; it abandons the run (does not mark it dead). |
| `WorkflowNotFoundError` | No workflow exists for the given id. |
| `NonDeterminismError` | A replay diverged from the journal (§4). Thrown in `strict` mode → `dead`; logged in `warn` mode. |
| `RecoveryExhaustedError` | A run crashed its worker more than `maxRecoveryAttempts` times and is marked `dead` (§5). |

## 11. Storage & migrations

`store.init()` is **idempotent**: running it repeatedly is safe and never destroys data.
The same `Store` interface is implemented by `@through-line/store-sqlite` (default, local)
and `@through-line/store-postgres` (production); the entire core test suite runs unchanged
against both.

---

*Status: v0.1 in progress. These guarantees are proven by the fault-injection + property
suites (`@through-line/testing`) and the parameterized store/engine conformance batteries,
not asserted in prose alone.*
