# @through-line/store-postgres

The production durable store for [Throughline](https://github.com/jagguvarma15/throughline)
— Postgres-backed journaling with `FOR UPDATE SKIP LOCKED` claims, JSONB payloads, and
fenced leases for safe multi-worker deployments.

It implements the same `Store` interface as `@through-line/store-sqlite` and passes the
identical conformance suite, so switching backends is a one-line change.

## Install

```bash
pnpm add @through-line/core @through-line/store-postgres pg
```

## Usage

```ts
import { throughline } from "@through-line/core";
import { postgres } from "@through-line/store-postgres";

// A connection string or an existing pg.Pool:
const tf = throughline({ store: postgres(process.env.DATABASE_URL!) });
```

Run claims use `SELECT ... FOR UPDATE SKIP LOCKED`, so many workers can poll the same
database without contention. Every write is fenced by `(worker_id, lease_epoch)`: a
worker whose lease expired gets `LeaseLostError` and abandons the run instead of
corrupting it. Schema init is idempotent; the v1 SQL also ships in the repo under
`migrations/`.

See the [contract of record](https://github.com/jagguvarma15/throughline/blob/main/docs/guarantees.md)
for the precise semantics this store is tested against.

MIT © Jagadesh Varma Nadimpalli
