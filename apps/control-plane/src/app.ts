import type { Store, WorkflowStatus } from "@throughline/core";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { renderMetrics } from "./metrics";
import { errorHandler } from "./middleware/errorHandler";
import { rateLimiter } from "./middleware/rateLimiter";

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

// Express 4 doesn't await async handlers; forward rejections to the error handler.
const wrap =
  (fn: AsyncHandler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

/** A thin read/op HTTP API over a durable store. Durability lives in the worker, not here. */
export function createApp(store: Store): Express {
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(rateLimiter);

  app.get(
    "/health",
    wrap(async (_req, res) => {
      try {
        await store.stats();
        res.json({ status: "healthy", timestamp: new Date().toISOString() });
      } catch (e) {
        res
          .status(503)
          .json({ status: "unhealthy", error: e instanceof Error ? e.message : "unknown" });
      }
    }),
  );

  app.get(
    "/metrics",
    wrap(async (_req, res) => {
      res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(renderMetrics(await store.stats()));
    }),
  );

  app.get(
    "/runs",
    wrap(async (req, res) => {
      const status =
        typeof req.query.status === "string" ? (req.query.status as WorkflowStatus) : undefined;
      const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      res.json({ runs: await store.listWorkflows({ status, limit }) });
    }),
  );

  app.get(
    "/runs/:id",
    wrap(async (req, res) => {
      const wf = await store.getWorkflow(req.params.id ?? "");
      if (!wf) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      res.json({ run: wf, steps: await store.loadJournal(wf.id) });
    }),
  );

  app.post(
    "/runs/:id/signal",
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { name?: unknown; payload?: unknown };
      if (typeof body.name !== "string") {
        res.status(400).json({ error: "name (string) is required" });
        return;
      }
      const wf = await store.getWorkflow(req.params.id ?? "");
      if (!wf) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      await store.addEvent(wf.id, body.name, body.payload, Date.now());
      res.status(202).json({ ok: true });
    }),
  );

  app.post(
    "/runs/:id/cancel",
    wrap(async (req, res) => {
      res.json({ result: await store.requestCancel(req.params.id ?? "", Date.now()) });
    }),
  );

  app.use(errorHandler);
  return app;
}
