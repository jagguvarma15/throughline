import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { throughline } from "@through-line/core";
import { sqlite } from "@through-line/store-sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { createHttpOps, runCli } from "../src/index";

const dir = mkdtempSync(join(tmpdir(), "throughline-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Ignore the host environment (DATABASE_URL etc) so tests always hit the temp SQLite.
const ENV = {} as NodeJS.ProcessEnv;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    out,
    err,
    json: () => JSON.parse(out.join("\n")),
  };
}

describe("cli", () => {
  it("start, approve, status, list, stats, cancel over a shared SQLite file", async () => {
    const db = join(dir, "lifecycle.db");

    const started = capture();
    expect(await runCli(["start", "appr", "--input", '{"q":1}', "--db", db], started.io, ENV)).toBe(
      0,
    );
    const id = started.json().id as string;
    expect(id).toBeTruthy();

    // The worker lives in user code: register the task over the same file and drive it.
    const store = sqlite(db);
    const tf = throughline({ store, sleep: async () => {} });
    tf.task("appr", async (ctx) => ctx.waitForApproval("go"));
    await tf.worker({ leaseMs: 1000, workerId: "w" }).runOnce();
    expect((await tf.getRun(id))?.status).toBe("waiting");

    const approved = capture();
    expect(await runCli(["approve", id, "go", "--db", db], approved.io, ENV)).toBe(0);
    expect(approved.json()).toEqual({ ok: true, approved: true });

    await tf.worker({ leaseMs: 1000, workerId: "w" }).runOnce();

    const status = capture();
    expect(await runCli(["status", id, "--db", db], status.io, ENV)).toBe(0);
    expect(status.json().run.status).toBe("completed");
    expect(status.json().run.output).toBe(true);
    expect(status.json().steps.length).toBeGreaterThan(0);

    const list = capture();
    expect(await runCli(["list", "--db", db, "--status", "completed"], list.io, ENV)).toBe(0);
    expect(list.json()).toHaveLength(1);

    const cancelStarted = capture();
    await runCli(["start", "ghost", "--db", db], cancelStarted.io, ENV);
    const cancelled = capture();
    expect(await runCli(["cancel", cancelStarted.json().id, "--db", db], cancelled.io, ENV)).toBe(
      0,
    );
    expect(cancelled.json()).toEqual({ result: "cancelled" });

    const stats = capture();
    expect(await runCli(["stats", "--db", db], stats.io, ENV)).toBe(0);
    expect(stats.json().workflowsByStatus.completed).toBe(1);
    expect(stats.json().workflowsByStatus.cancelled).toBe(1);

    await store.close();
  });

  it("returns exit code 1 with usage or errors for bad invocations", async () => {
    const db = join(dir, "errors.db");
    const cases: string[][] = [
      [],
      ["unknown-command"],
      ["start"],
      ["start", "t", "--input", "not-json", "--db", db],
      ["status", "--db", db],
      ["status", "does-not-exist", "--db", db],
      ["signal", "only-id", "--db", db],
      ["approve", "only-id", "--db", db],
      ["cancel", "--db", db],
    ];
    for (const argv of cases) {
      const c = capture();
      expect(await runCli(argv, c.io, ENV), argv.join(" ")).toBe(1);
      expect(c.err.length, argv.join(" ")).toBeGreaterThan(0);
    }
    const help = capture();
    expect(await runCli(["help"], help.io, ENV)).toBe(0);
    expect(help.out.join("\n")).toContain("usage: throughline");
  });

  it("http mode sends the bearer token and maps 404s", async () => {
    const srv: Server = createServer((req, res) => {
      const send = (code: number, body: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== "Bearer tok") {
        send(401, { error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && req.url === "/runs/missing") {
        send(404, { error: "run not found" });
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/runs")) {
        send(200, { runs: [{ id: "r1", name: "t", status: "pending" }] });
        return;
      }
      if (req.method === "POST" && req.url === "/runs") {
        send(201, { id: "r9" });
        return;
      }
      send(500, { error: "unexpected route" });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const addr = srv.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    const url = `http://127.0.0.1:${addr.port}`;

    const ops = createHttpOps(url, "tok");
    expect((await ops.listRuns()).map((r) => r.id)).toEqual(["r1"]);
    expect(await ops.getRun("missing")).toBeNull();
    expect(await ops.startRun({ name: "t" })).toEqual({ id: "r9" });
    await expect(createHttpOps(url).listRuns()).rejects.toThrow(/401/);

    const viaCli = capture();
    expect(await runCli(["list", "--url", url, "--token", "tok"], viaCli.io, ENV)).toBe(0);
    expect(viaCli.json()[0].id).toBe("r1");

    await new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
  });
});
