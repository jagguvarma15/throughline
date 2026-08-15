import type { NextFunction, Request, Response } from "express";
import { RateLimiterMemory } from "rate-limiter-flexible";

const limiter = new RateLimiterMemory({ keyPrefix: "control-plane", points: 100, duration: 60 });

export async function rateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await limiter.consume(req.ip || "unknown");
    next();
  } catch {
    res.status(429).json({ error: "Too Many Requests" });
  }
}
