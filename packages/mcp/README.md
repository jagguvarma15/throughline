# @through-line/mcp

An [MCP](https://modelcontextprotocol.io) server for
[Throughline](https://github.com/jagguvarma15/throughline): it lets an AI agent (Claude
Code, Claude Desktop, or any MCP host) operate durable runs - start work, inspect step
journals, resolve human-in-the-loop approval gates, cancel, and await completion.

The worker still lives in your code (it needs your task registry); the MCP server covers
everything around it, straight over the durable store.

## Setup

```bash
claude mcp add throughline --env THROUGHLINE_DB=./throughline.db -- npx @through-line/mcp
```

Or in an MCP host config:

```json
{
  "mcpServers": {
    "throughline": {
      "command": "npx",
      "args": ["@through-line/mcp"],
      "env": { "THROUGHLINE_DB": "./throughline.db" }
    }
  }
}
```

`DATABASE_URL` (Postgres) wins over `THROUGHLINE_DB` (SQLite; default `throughline.db`),
mirroring the CLI and control-plane.

## Tools

| Tool | Purpose |
|---|---|
| `list_runs` | List runs, newest first, optionally by status. |
| `get_run` | One run + its step journal (outputs truncated to a preview unless `full_outputs`). |
| `start_run` | Create a run; `idempotency_key` makes retries safe. |
| `signal_run` | Deliver an event to a run parked on `waitForEvent`. |
| `approve_run` | Resolve a `waitForApproval` gate (approve or reject). |
| `cancel_run` | Cancel a run. |
| `get_stats` | Store-wide counts (runs by status, steps, tokens). |
| `wait_for_run` | Poll until the run finishes or parks on a gate (bounded by `timeout_ms`). |

## Embedding

```ts
import { createThroughlineMcpServer } from "@through-line/mcp";
import { createOps } from "@through-line/core";
import { sqlite } from "@through-line/store-sqlite";

const server = createThroughlineMcpServer(createOps(sqlite("./throughline.db")));
// connect it to any MCP transport
```
