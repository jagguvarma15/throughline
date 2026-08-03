import {
  type Store,
  WorkflowNotFoundError,
  type WorkflowStatus,
  createOps,
} from "@through-line/core";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { renderMetrics } from "./metrics";
import { type AuthConfig, requireAuth, resolveAuthConfig } from "./middleware/auth";
import { errorHandler } from "./middleware/errorHandler";
import { rateLimiter } from "./middleware/rateLimiter";

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

// Express 4 doesn't await async handlers; forward rejections to the error handler.
const wrap =
  (fn: AsyncHandler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

export interface AppOptions {
  /** Resolved from THROUGHLINE_API_TOKEN / THROUGHLINE_ALLOW_ANON when omitted. */
  auth?: AuthConfig;
  /** Allowed browser origins. Default: CORS_ORIGIN (comma-separated), else none. */
  corsOrigins?: string[] | false;
  /** Proxy hops to trust so req.ip (rate limiting) is real behind nginx (TRUST_PROXY). */
  trustProxy?: number;
  /** Leave GET /metrics unauthenticated for a scraper (METRICS_PUBLIC=1). */
  metricsPublic?: boolean;
}

const STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "dead",
  "cancelled",
]);

const MAX_LIST_LIMIT = 500;

function parseCorsOrigins(env: string | undefined): string[] | false {
  const origins =
    env
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  return origins.length > 0 ? origins : false;
}

/** A thin read/op HTTP API over a durable store. Durability lives in the worker, not here. */
export function createApp(store: Store, opts: AppOptions = {}): Express {
  const auth = opts.auth ?? resolveAuthConfig();
  const guard = requireAuth(auth);
  const metricsPublic = opts.metricsPublic ?? process.env.METRICS_PUBLIC === "1";
  const ops = createOps(store);

  const app = express();
  app.set("trust proxy", opts.trustProxy ?? Number(process.env.TRUST_PROXY ?? 0));
  app.use(helmet());
  app.use(cors({ origin: opts.corsOrigins ?? parseCorsOrigins(process.env.CORS_ORIGIN) }));
  app.use(express.json());
  app.use(rateLimiter);

  app.get(
    "/health",
    wrap(async (_req, res) => {
      try {
        await ops.stats();
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
    ...(metricsPublic ? [] : [guard]),
    wrap(async (_req, res) => {
      res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(renderMetrics(await ops.stats()));
    }),
  );

  app.get(
    "/stats",
    guard,
    wrap(async (_req, res) => {
      res.json(await ops.stats());
    }),
  );

  app.get(
    "/runs",
    guard,
    wrap(async (req, res) => {
      const rawStatus = req.query.status;
      if (rawStatus !== undefined && (typeof rawStatus !== "string" || !STATUSES.has(rawStatus))) {
        res.status(400).json({ error: "invalid status" });
        return;
      }
      const status = rawStatus as WorkflowStatus | undefined;
      // Number("abc") is NaN, which is not nullish - clamp instead of passing it to SQL.
      const n = Number(req.query.limit);
      const limit = Number.isFinite(n)
        ? Math.min(Math.max(1, Math.trunc(n)), MAX_LIST_LIMIT)
        : undefined;
      res.json({ runs: await ops.listRuns({ status, limit }) });
    }),
  );

  app.get(
    "/runs/:id",
    guard,
    wrap(async (req, res) => {
      const detail = await ops.getRun(req.params.id ?? "");
      if (!detail) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      res.json(detail);
    }),
  );

  app.post(
    "/runs",
    guard,
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as {
        name?: unknown;
        input?: unknown;
        id?: unknown;
        idempotencyKey?: unknown;
      };
      if (typeof body.name !== "string" || body.name.length === 0) {
        res.status(400).json({ error: "name (non-empty string) is required" });
        return;
      }
      if (body.id !== undefined && typeof body.id !== "string") {
        res.status(400).json({ error: "id must be a string" });
        return;
      }
      if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string") {
        res.status(400).json({ error: "idempotencyKey must be a string" });
        return;
      }
      // No registry here: a task no worker registers is claimed and marked dead with
      // "no task registered" - visible in the dashboard, re-runnable after deploying it.
      const { id } = await ops.startRun({
        name: body.name,
        input: body.input,
        id: body.id,
        idempotencyKey: body.idempotencyKey,
      });
      res.status(201).json({ id });
    }),
  );

  app.post(
    "/runs/:id/signal",
    guard,
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { name?: unknown; payload?: unknown };
      if (typeof body.name !== "string") {
        res.status(400).json({ error: "name (string) is required" });
        return;
      }
      try {
        await ops.signal(req.params.id ?? "", body.name, body.payload);
      } catch (e) {
        if (e instanceof WorkflowNotFoundError) {
          res.status(404).json({ error: "run not found" });
          return;
        }
        throw e;
      }
      res.status(202).json({ ok: true });
    }),
  );

  app.post(
    "/runs/:id/cancel",
    guard,
    wrap(async (req, res) => {
      res.json({ result: await ops.cancel(req.params.id ?? "") });
    }),
  );

  app.use(errorHandler);
  return app;
}
