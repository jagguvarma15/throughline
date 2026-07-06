# Deep Research — the killer demo

A durable, resumable research agent built on Throughline: **plan → search (N iterations) →
draft → human approval → publish**. Every model call and the publish are wrapped in
`ctx.step`, so the run gets all of Throughline's guarantees:

- **Crash-resume.** Kill the worker mid-run; on restart it replays the journal — no
  duplicate model calls, no duplicate publish.
- **Durable human-in-the-loop.** It parks on `waitForApproval("publish")` and survives a
  full restart until you signal approval.
- **Token budget.** A runaway loop halts cleanly at the budget with `BudgetExceededError`.
- **Offline replay.** The whole trajectory replays from a recorded journal with zero model
  calls, for ~$0 regression tests.

The demo uses a deterministic mock model (`src/model.ts`). Swap it for a thin wrapper around
your provider SDK (OpenAI, Anthropic, …) — Throughline itself never imports one.

## Automated proof (runs in CI, offline)

```
pnpm --filter @through-line/example-deep-research test
```

Covers crash-resume with zero duplicate effects, the approval pause, the budget halt, and the
offline replay.

## Manual kill-and-resume

```
pnpm --filter @through-line/example-deep-research build
cd examples/deep-research
bash kill-and-resume.sh
```

The script starts a run, launches a worker, `kill -9`s it mid-run, starts a fresh worker
(which resumes from the journal), approves the publish, and prints the final state.
