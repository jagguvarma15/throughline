import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOps, throughline } from "@through-line/core";
import { sqlite } from "@through-line/store-sqlite";
import { describe, expect, it } from "vitest";
import { createThroughlineMcpServer } from "../src/server";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

async function setup() {
  const store = sqlite(":memory:");
  await store.init();
  const tf = throughline({ store, sleep: async () => {} });
  tf.task("appr", async (ctx) => {
    await ctx.step("draft", async () => "x".repeat(5000));
    return ctx.waitForApproval("publish");
  });

  const server = createThroughlineMcpServer(createOps(store), { pollIntervalMs: 5 });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  const callJson = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await call(name, args);
    expect(res.isError ?? false, res.content[0]?.text).toBe(false);
    return JSON.parse(res.content[0]?.text ?? "null");
  };

  return { store, tf, client, call, callJson };
}

describe("mcp server", () => {
  it("drives the full agent loop: start, inspect, approve, await completion", async () => {
    const { store, tf, call, callJson } = await setup();

    // An agent starts a run over MCP.
    const { id } = await callJson("start_run", {
      task: "appr",
      input: { topic: "otters" },
      idempotency_key: "k1",
    });
    expect(id).toBeTruthy();
    // Idempotent restart returns the same run.
    expect((await callJson("start_run", { task: "appr", idempotency_key: "k1" })).id).toBe(id);

    // The user's worker executes it up to the approval gate.
    await tf.worker({ leaseMs: 1000, workerId: "w" }).runOnce();

    // wait_for_run surfaces the parked gate instead of blocking forever.
    const waiting = await callJson("wait_for_run", { id, timeout_ms: 1000 });
    expect(waiting).toMatchObject({ status: "waiting", waitingOn: "publish" });

    const listed = await callJson("list_runs", { status: "waiting" });
    expect(listed).toHaveLength(1);
    expect(listed[0].waitEvent).toBe("publish");

    // Step outputs are truncated by default so journals cannot blow the context...
    const detail = await callJson("get_run", { id });
    const draft = detail.steps.find((s: { stepKey: string }) => s.stepKey === "draft#0");
    expect(draft.output.truncated).toBe(true);
    expect(draft.output.preview.length).toBeLessThanOrEqual(2000);
    // ...unless the agent asks for everything.
    const full = await callJson("get_run", { id, full_outputs: true });
    expect(
      full.steps.find((s: { stepKey: string }) => s.stepKey === "draft#0").output,
    ).toHaveLength(5000);

    // The agent approves the gate; the worker resumes and completes.
    expect(await callJson("approve_run", { id, name: "publish" })).toEqual({
      ok: true,
      approved: true,
    });
    await tf.worker({ leaseMs: 1000, workerId: "w" }).runOnce();
    const done = await callJson("wait_for_run", { id, timeout_ms: 1000 });
    expect(done).toMatchObject({ status: "completed", output: true });

    const stats = await callJson("get_stats");
    expect(stats.workflowsByStatus.completed).toBe(1);

    // Unknown ids are tool errors, not crashes.
    const missing = await call("get_run", { id: "nope" });
    expect(missing.isError).toBe(true);
    expect((await call("signal_run", { id: "nope", name: "x" })).isError).toBe(true);
    expect((await call("wait_for_run", { id: "nope" })).isError).toBe(true);

    await store.close();
  });

  it("cancels runs and times out waits without leaving the loop stuck", async () => {
    const { store, callJson } = await setup();
    const { id } = await callJson("start_run", { task: "appr" });

    // No worker is running: wait_for_run times out on the pending run.
    const pending = await callJson("wait_for_run", { id, timeout_ms: 30 });
    expect(pending).toMatchObject({ status: "pending", timedOut: true });

    expect(await callJson("cancel_run", { id })).toEqual({ result: "cancelled" });
    const after = await callJson("wait_for_run", { id, timeout_ms: 30 });
    expect(after.status).toBe("cancelled");

    await store.close();
  });
});
