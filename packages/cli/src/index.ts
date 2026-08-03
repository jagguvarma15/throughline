// The Throughline CLI: start, inspect, signal, approve, and cancel durable runs.
// Workers are deliberately NOT here - running a task needs the user's task registry,
// which lives in their code (see examples/*/src/run.ts for the worker shape).

import { parseArgs } from "node:util";
import { type Ops, type Store, type WorkflowStatus, createOps } from "@through-line/core";
import { postgres } from "@through-line/store-postgres";
import { sqlite } from "@through-line/store-sqlite";
import { createHttpOps } from "./http";

export { createHttpOps } from "./http";

export const USAGE = `usage: throughline <command> [args] [flags]

commands:
  start <task>            create a run (--input <json>, --id <id>, --key <idempotency-key>)
  list                    list runs (--status <status>, --limit <n>)
  status <id>             show a run and its journal
  signal <id> <event>     deliver an event to a run (--payload <json>)
  approve <id> <event>    approve a waitForApproval gate (--deny to reject)
  cancel <id>             cancel a run
  retry <id>              redrive a dead run (journal preserved; completed steps replay)
  prune                   delete terminal runs (--older-than <duration>, --limit <n>)
  migrate                 apply store schema migrations (direct store access only)
  stats                   store-wide counts

backend (first match wins):
  --url <control-plane>   talk to a control-plane over HTTP (--token or THROUGHLINE_API_TOKEN)
  DATABASE_URL            open Postgres directly
  --db <path>             open SQLite directly (or THROUGHLINE_DB; default throughline.db)`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface Backend {
  ops: Ops;
  /** Present in direct-store modes; absent over HTTP (migrate needs it). */
  store?: Store;
  close(): void | Promise<void>;
}

/** Resolve the ops backend: --url wins, then DATABASE_URL, then a local SQLite file. */
export function resolveBackend(
  flags: { url?: string; token?: string; db?: string },
  env: NodeJS.ProcessEnv = process.env,
): Backend {
  if (flags.url) {
    return {
      ops: createHttpOps(flags.url, flags.token ?? env.THROUGHLINE_API_TOKEN),
      close: () => {},
    };
  }
  if (env.DATABASE_URL) {
    const store = postgres(env.DATABASE_URL);
    return { ops: createOps(store), store, close: () => store.close() };
  }
  const store = sqlite(flags.db ?? env.THROUGHLINE_DB ?? "throughline.db");
  return { ops: createOps(store), store, close: () => store.close() };
}

function parseJson(
  flag: string,
  raw: string | undefined,
  io: CliIo,
): { ok: boolean; value?: unknown } {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    io.err(`error: ${flag} is not valid JSON: ${raw}`);
    return { ok: false };
  }
}

const defaultIo: CliIo = { out: console.log, err: console.error };

/** Run one CLI invocation; returns the process exit code. Exported for tests. */
export async function runCli(
  argv: string[],
  io: CliIo = defaultIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        db: { type: "string" },
        url: { type: "string" },
        token: { type: "string" },
        input: { type: "string" },
        id: { type: "string" },
        key: { type: "string" },
        status: { type: "string" },
        limit: { type: "string" },
        payload: { type: "string" },
        deny: { type: "boolean" },
        "older-than": { type: "string" },
        help: { type: "boolean" },
      },
    });
  } catch (e) {
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    io.err(USAGE);
    return 1;
  }
  const { values: flags, positionals } = parsed;
  const [command, ...args] = positionals;

  if (flags.help || command === "help") {
    io.out(USAGE);
    return 0;
  }
  if (command === undefined) {
    io.err(USAGE);
    return 1;
  }

  const backend = resolveBackend(
    {
      url: flags.url as string | undefined,
      token: flags.token as string | undefined,
      db: flags.db as string | undefined,
    },
    env,
  );
  const ops = backend.ops;
  const print = (value: unknown): void => io.out(JSON.stringify(value, null, 2));

  try {
    switch (command) {
      case "start": {
        const name = args[0];
        if (!name) {
          io.err("error: start requires a task name");
          return 1;
        }
        const input = parseJson("--input", flags.input as string | undefined, io);
        if (!input.ok) return 1;
        const { id } = await ops.startRun({
          name,
          input: input.value,
          id: flags.id as string | undefined,
          idempotencyKey: flags.key as string | undefined,
        });
        print({ id });
        return 0;
      }
      case "list": {
        const n = Number(flags.limit);
        const runs = await ops.listRuns({
          status: flags.status as WorkflowStatus | undefined,
          limit: Number.isFinite(n) ? n : undefined,
        });
        print(
          runs.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            waitEvent: r.waitEvent,
            recoveryAttempts: r.recoveryAttempts,
            updatedAt: r.updatedAt,
          })),
        );
        return 0;
      }
      case "status": {
        const id = args[0];
        if (!id) {
          io.err("error: status requires a run id");
          return 1;
        }
        const detail = await ops.getRun(id);
        if (!detail) {
          io.err(`error: run not found: ${id}`);
          return 1;
        }
        print(detail);
        return 0;
      }
      case "signal": {
        const [id, event] = args;
        if (!id || !event) {
          io.err("error: signal requires a run id and an event name");
          return 1;
        }
        const payload = parseJson("--payload", flags.payload as string | undefined, io);
        if (!payload.ok) return 1;
        await ops.signal(id, event, payload.value);
        print({ ok: true });
        return 0;
      }
      case "approve": {
        const [id, event] = args;
        if (!id || !event) {
          io.err("error: approve requires a run id and an event name");
          return 1;
        }
        const approved = !(flags.deny as boolean | undefined);
        await ops.approve(id, event, approved);
        print({ ok: true, approved });
        return 0;
      }
      case "cancel": {
        const id = args[0];
        if (!id) {
          io.err("error: cancel requires a run id");
          return 1;
        }
        print({ result: await ops.cancel(id) });
        return 0;
      }
      case "retry": {
        const id = args[0];
        if (!id) {
          io.err("error: retry requires a run id");
          return 1;
        }
        const result = await ops.retry(id);
        if (result === "not-dead") {
          io.err(`error: run ${id} is not dead; only dead runs can be retried`);
          return 1;
        }
        print({ result });
        return 0;
      }
      case "prune": {
        const olderThan = flags["older-than"] as string | undefined;
        if (!olderThan) {
          io.err("error: prune requires --older-than (e.g. --older-than 7d)");
          return 1;
        }
        const n = Number(flags.limit);
        print(await ops.prune({ olderThan, limit: Number.isFinite(n) ? n : undefined }));
        return 0;
      }
      case "migrate": {
        if (!backend.store) {
          io.err(
            "error: migrate needs direct store access (a --db path or DATABASE_URL, not --url)",
          );
          return 1;
        }
        await backend.store.init();
        print({ ok: true });
        return 0;
      }
      case "stats": {
        print(await ops.stats());
        return 0;
      }
      default: {
        io.err(`error: unknown command: ${command}`);
        io.err(USAGE);
        return 1;
      }
    }
  } catch (e) {
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await backend.close();
  }
}
