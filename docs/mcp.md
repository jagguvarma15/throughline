# Operating Throughline from an AI agent (MCP)

The `throughline-mcp` bin (shipped with `@through-line/core`, with a transport-agnostic
factory at `@through-line/core/mcp`) exposes durable-run operations as MCP tools, so an agent can be the
operator of your agent runs: kick off work, watch it, approve gates, and clean up - while
the durability engine keeps everything crash-safe underneath.

## The loop it enables

1. `start_run { task: "deep-research", input: {...}, idempotency_key: "..." }`
2. Your worker (in your code, with your task registry) claims and executes the run.
3. `wait_for_run { id }` returns as soon as the run finishes or parks:
   `{ status: "waiting", waitingOn: "publish" }` means a `waitForApproval` gate.
4. `get_run { id }` shows the step journal (outputs truncated to previews by default).
5. `approve_run { id, name: "publish", approved: true }` resolves the gate; the worker
   resumes from the journal.
6. `wait_for_run { id }` again: `{ status: "completed", output: ... }`.

Because every step is journaled, the operating agent can crash, the worker can crash, or
the host can redeploy at any point in that loop - the run resumes where it left off and
no side effect repeats (see `docs/guarantees.md`).

## Setup

```bash
claude mcp add throughline --env THROUGHLINE_DB=./throughline.db -- npx -y -p @through-line/core throughline-mcp
```

`DATABASE_URL` (Postgres) wins over `THROUGHLINE_DB` (SQLite), mirroring the CLI and
control-plane. The server speaks stdio and holds no state of its own - all state is the
durable store.

## Safety notes

- `approve_run`, `signal_run`, `cancel_run`, and `start_run` are mutating operations;
  their tool descriptions say so, and an MCP host will ask the user before running them
  under default permission settings.
- The server talks to the store directly and inherits whatever access the process has.
  Point it at a local SQLite file or a Postgres role scoped to the Throughline schema.
- For remote deployments, front the control-plane HTTP API (bearer-token auth) instead
  of exposing a database, and run the MCP server next to the database it operates on.
