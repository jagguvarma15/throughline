import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface AuthConfig {
  /** Bearer token every non-health route requires. null only when anon is allowed. */
  token: string | null;
  /** Explicit opt-out for trusted local networks (THROUGHLINE_ALLOW_ANON=1). */
  allowAnon: boolean;
}

/**
 * Fail closed: an unauthenticated signal/cancel endpoint would defeat approval gates,
 * so without a token the server refuses to start unless anon is explicitly allowed.
 */
export function resolveAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const token = env.THROUGHLINE_API_TOKEN?.trim() || null;
  const allowAnon = env.THROUGHLINE_ALLOW_ANON === "1";
  if (!token && !allowAnon) {
    throw new Error(
      "control-plane requires auth: set THROUGHLINE_API_TOKEN, " +
        "or THROUGHLINE_ALLOW_ANON=1 for a trusted local network",
    );
  }
  return { token, allowAnon };
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return presented.length === wanted.length && timingSafeEqual(presented, wanted);
}

/** 401 unless the request carries the configured bearer token (no-op under allowAnon). */
export function requireAuth(cfg: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (cfg.token === null || tokenMatches(cfg.token, req.headers.authorization)) {
      next();
      return;
    }
    res.status(401).json({ error: "unauthorized" });
  };
}
