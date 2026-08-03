---
"@through-line/core": minor
"@through-line/store-sqlite": minor
"@through-line/store-postgres": minor
"@through-line/testing": minor
---

Harden the engine to match the guarantees contract. The determinism guard promised in
docs/guarantees.md now exists: a journaled step replayed with a different kind, or a
completed run that leaves journaled steps unconsumed, throws NonDeterminismError
(configurable via the new `determinism: "strict" | "warn" | "off"` option; strict by
default outside production). New `ctx.now()` and `ctx.random()` micro-steps journal
wall-clock and randomness so branching on them is replay-safe. Workers cap crash
recoveries with `maxRecoveryAttempts` (default 10) and mark exhausted runs `dead` with
RecoveryExhaustedError instead of re-claiming a poison-pill run forever. Every failed
step attempt is journaled, so a retry budget survives a crash mid-retry-loop. The
Postgres store sums token stats as bigint (the int4 cast overflowed past ~2.1B tokens),
both stores add a partial index for the claim query, and core drops its unused zod
dependency. `Store.takeEvent` and `Store.releaseLease` are deprecated (the engine uses
neither).
