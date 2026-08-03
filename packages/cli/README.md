# @through-line/cli

The [Throughline](https://github.com/jagguvarma15/throughline) operator CLI: start,
inspect, signal, approve, and cancel durable runs from the terminal. Every command prints
JSON, so it is equally usable by humans, scripts, and AI agents.

Workers are deliberately not part of the CLI: executing a task requires your task
registry, which lives in your code. The CLI covers everything around the worker.

## Install

```bash
pnpm add -g @through-line/cli
# or one-off
npx @through-line/cli list
```

## Usage

```bash
throughline start deep-research --input '{"topic":"sea otters"}'
throughline list --status waiting
throughline status <run-id>
throughline approve <run-id> publish          # or --deny
throughline signal <run-id> user-reply --payload '{"text":"go ahead"}'
throughline cancel <run-id>
throughline stats
```

## Backends

The first match wins:

1. `--url <control-plane>` talks to a Throughline control-plane over HTTP.
   Pass `--token` or set `THROUGHLINE_API_TOKEN` for a token-protected deployment.
2. `DATABASE_URL` opens Postgres directly.
3. `--db <path>` (or `THROUGHLINE_DB`; default `throughline.db`) opens SQLite directly.

Note on `start`: the CLI has no task registry, so starting a task no worker registers
leaves a run that is claimed and marked `dead` with "no task registered" - visible in
`status` and the dashboard, and re-runnable once the worker deploys.
