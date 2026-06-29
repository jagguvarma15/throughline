# Throughline

**A lightweight, embeddable, framework-agnostic durable-execution library for AI agents.**

Throughline wraps any agent loop — a hand-rolled `while` loop, LangGraph, the OpenAI Agents
SDK, Pydantic AI — and gives it crash-safe step checkpointing, automatic resume,
exactly-once side effects via idempotency keys, durable human-in-the-loop pauses,
deterministic record/replay for testing, and in-graph token/cost budgets. It runs on
**SQLite** locally and **Postgres** in production, and is **bring-your-own-LLM**.

It is a library you `import` — **not** an agent framework, an LLM-provider wrapper, a no-code
builder, or a hosted platform.

> **Project history:** Throughline began life as **TaskFlow**, a containerized
> task-management demo, and has been refactored into this durable-execution library — keeping
> TaskFlow's production-grade Docker, CI, and observability stack as the reference deployment.

## Durability guarantees

The honest contract — including the precise (non-overclaimed) statement of when side effects
are exactly-once — lives in **[docs/guarantees.md](docs/guarantees.md)**. Every durability
test in this repo asserts against that document.

## Packages

| Package | Purpose |
|---|---|
| `@throughline/core` | Durable engine: `throughline()`, `task()`, `ctx`, worker, replay. |
| `@throughline/store-sqlite` | Default durable store (better-sqlite3). |
| `@throughline/store-postgres` | Production durable store (pg). |
| `@throughline/testing` | Fault-injection store + property/conformance + record/replay harness. |
| `apps/control-plane` | Thin read/op HTTP API over the store. |
| `apps/dashboard` | Durable-run UI (runs, timeline, approvals, replay). |

## Status

**v0.1 in progress.** The full quickstart, the durability-guarantees walkthrough, and the
`examples/deep-research` killer demo land with the v0.1 release. Until then, see
[docs/guarantees.md](docs/guarantees.md) for the semantics this library commits to.

## License

[MIT](LICENSE).
