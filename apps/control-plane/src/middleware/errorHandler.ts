import type { NextFunction, Request, Response } from "express";

// Ported from the TaskFlow backend.
export function errorHandler(err: Error, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({
    error: process.env.NODE_ENV === "production" ? "Internal Server Error" : err.message,
  });
}
