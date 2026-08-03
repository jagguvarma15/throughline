---
"@through-line/core": minor
"@through-line/cli": minor
"@through-line/mcp": minor
---

Add the agent-facing operations layer. Core gains `createOps(store)`, a registryless
facade (list, get, start, signal, approve, cancel, stats) shared by every ops surface.
New package `@through-line/cli` (`throughline` binary) covers start / list / status /
signal / approve / cancel / stats with JSON output, working directly on SQLite or
Postgres or against a control-plane URL with `--url`/`--token`. New package
`@through-line/mcp` (`throughline-mcp` binary) exposes the same operations as MCP tools
(`start_run`, `wait_for_run`, `get_run` with truncated journals, `approve_run`,
`signal_run`, `cancel_run`, `get_stats`) so AI agents can operate durable runs. The
control-plane app adds `POST /runs`, `GET /stats`, bearer-token auth that fails closed
(`THROUGHLINE_API_TOKEN`, or explicit `THROUGHLINE_ALLOW_ANON=1`), CORS restricted to
configured origins, trust-proxy support, and query validation.
