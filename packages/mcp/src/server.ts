// MCP server over the Ops facade: every tool an AI agent needs to operate durable runs -
// start work, inspect journals, approve human-in-the-loop gates, cancel, and await
// completion. Transport-agnostic; the bin wires it to stdio.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type Ops,
  type StepRow,
  WorkflowNotFoundError,
  type WorkflowRow,
} from "@through-line/core";
import { z } from "zod";

export interface ThroughlineMcpOptions {
  /** wait_for_run poll interval. Injectable for tests. */
  pollIntervalMs?: number;
}

const STATUS = z.enum([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "dead",
  "cancelled",
]);

/** Cap per-step output JSON so a large journal cannot blow the agent's context. */
const OUTPUT_PREVIEW_CHARS = 2000;

function preview(value: unknown, max: number): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= max) return value;
  return { truncated: true, preview: text.slice(0, max) };
}

function runSummary(r: WorkflowRow) {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    waitEvent: r.waitEvent,
    recoveryAttempts: r.recoveryAttempts,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function stepSummary(s: StepRow, fullOutputs: boolean) {
  return {
    stepKey: s.stepKey,
    seq: s.seq,
    status: s.status,
    kind: s.kind,
    attempts: s.attempts,
    cost: s.cost,
    output: fullOutputs ? s.output : preview(s.output, OUTPUT_PREVIEW_CHARS),
    error: s.error,
    completedAt: s.completedAt,
  };
}

const jsonResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const errorResult = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

export function createThroughlineMcpServer(ops: Ops, opts: ThroughlineMcpOptions = {}): McpServer {
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  // Server-info version is independent of the npm package version.
  const server = new McpServer({ name: "throughline", version: "1.0.0" });

  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      description:
        "List durable runs, newest first. Filter by status (waiting runs are parked on an event or timer; dead runs failed terminally).",
      inputSchema: {
        status: STATUS.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ status, limit }) =>
      jsonResult((await ops.listRuns({ status, limit })).map(runSummary)),
  );

  server.registerTool(
    "get_run",
    {
      title: "Get run",
      description:
        "Fetch one run and its step journal. Step outputs are truncated to a preview unless full_outputs is set.",
      inputSchema: {
        id: z.string(),
        full_outputs: z.boolean().optional(),
      },
    },
    async ({ id, full_outputs }) => {
      const detail = await ops.getRun(id);
      if (!detail) return errorResult(`run not found: ${id}`);
      return jsonResult({
        run: {
          ...runSummary(detail.run),
          input: detail.run.input,
          output: detail.run.output,
          error: detail.run.error,
        },
        steps: detail.steps.map((s) => stepSummary(s, full_outputs ?? false)),
      });
    },
  );

  server.registerTool(
    "start_run",
    {
      title: "Start run",
      description:
        "Create a durable run of a task. A worker registered for that task executes it; starting an unregistered task leaves the run dead with 'no task registered'. Pass idempotency_key to make retries safe.",
      inputSchema: {
        task: z.string().min(1),
        input: z.unknown().optional(),
        idempotency_key: z.string().optional(),
      },
    },
    async ({ task, input, idempotency_key }) =>
      jsonResult(await ops.startRun({ name: task, input, idempotencyKey: idempotency_key })),
  );

  server.registerTool(
    "signal_run",
    {
      title: "Signal run",
      description:
        "Deliver a named event (with optional JSON payload) to a run parked on waitForEvent.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1),
        payload: z.unknown().optional(),
      },
    },
    async ({ id, name, payload }) => {
      try {
        await ops.signal(id, name, payload);
      } catch (e) {
        if (e instanceof WorkflowNotFoundError) return errorResult(`run not found: ${id}`);
        throw e;
      }
      return jsonResult({ ok: true });
    },
  );

  server.registerTool(
    "approve_run",
    {
      title: "Approve run",
      description:
        "Resolve a waitForApproval gate: approved true lets the run proceed, false rejects it. This is a mutating action - only approve when the user intends it.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1),
        approved: z.boolean().optional(),
      },
    },
    async ({ id, name, approved }) => {
      try {
        await ops.approve(id, name, approved ?? true);
      } catch (e) {
        if (e instanceof WorkflowNotFoundError) return errorResult(`run not found: ${id}`);
        throw e;
      }
      return jsonResult({ ok: true, approved: approved ?? true });
    },
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel run",
      description:
        "Cancel a run: pending and waiting runs cancel immediately; a running run is flagged and stops at its next step boundary.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => jsonResult({ result: await ops.cancel(id) }),
  );

  server.registerTool(
    "retry_run",
    {
      title: "Retry run",
      description:
        "Redrive a dead run: reset it to pending with the journal preserved, so completed steps replay instead of re-running. Only dead runs can be retried. This is a mutating action.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const result = await ops.retry(id);
        if (result === "not-dead") return errorResult(`run ${id} is not dead; cannot retry`);
        return jsonResult({ result });
      } catch (e) {
        if (e instanceof WorkflowNotFoundError) return errorResult(`run not found: ${id}`);
        throw e;
      }
    },
  );

  server.registerTool(
    "get_stats",
    {
      title: "Get stats",
      description: "Store-wide counts: runs by status, journaled steps, failures, tokens consumed.",
      inputSchema: {},
    },
    async () => jsonResult(await ops.stats()),
  );

  server.registerTool(
    "wait_for_run",
    {
      title: "Wait for run",
      description:
        "Poll a run until it needs attention or finishes: returns when the status leaves pending/running (completed, dead, cancelled, or waiting on an event/approval), or at timeout_ms (max 60000).",
      inputSchema: {
        id: z.string(),
        timeout_ms: z.number().int().min(1).max(60_000).optional(),
      },
    },
    async ({ id, timeout_ms }) => {
      const deadline = Date.now() + (timeout_ms ?? 30_000);
      for (;;) {
        const detail = await ops.getRun(id);
        if (!detail) return errorResult(`run not found: ${id}`);
        const { status, waitEvent, output, error } = detail.run;
        if (status !== "pending" && status !== "running") {
          return jsonResult({ status, waitingOn: waitEvent ?? undefined, output, error });
        }
        if (Date.now() >= deadline) return jsonResult({ status, timedOut: true });
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    },
  );

  return server;
}
