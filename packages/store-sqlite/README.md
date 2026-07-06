# @through-line/store-sqlite

The default durable store for [Throughline](https://github.com/jagguvarma15/throughline)
— zero-infrastructure durability backed by [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
(WAL mode, synchronous transactions, fenced leases).

Perfect for local development, single-node deployments, and tests (`:memory:` supported).
For multi-node production use `@through-line/store-postgres` — both implement the same
`Store` interface and pass the same conformance suite.

## Install

```bash
pnpm add @through-line/core @through-line/store-sqlite
```

## Usage

```ts
import { throughline } from "@through-line/core";
import { sqlite } from "@through-line/store-sqlite";

const tf = throughline({ store: sqlite("./throughline.db") }); // or sqlite(":memory:")
```

The schema (workflows / steps / events) is created idempotently on first use. Journal
appends are UPSERTs keyed by `(workflow_id, step_key)`: completed steps are never
overwritten, which is what makes replay exactly-once. Every write is fenced by
`(worker_id, lease_epoch)` so a zombie worker whose lease expired cannot corrupt a run.

See the [contract of record](https://github.com/jagguvarma15/throughline/blob/main/docs/guarantees.md)
for the precise semantics this store is tested against.

MIT © Jagadesh Varma Nadimpalli
