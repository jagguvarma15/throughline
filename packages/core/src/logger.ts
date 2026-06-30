import type { Logger } from "./types";

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Minimal console logger with a fixed prefix (e.g. the run id). */
export function consoleLogger(prefix?: string): Logger {
  const tag = prefix ? `[throughline ${prefix}]` : "[throughline]";
  return {
    debug: (m, meta) => console.debug(tag, m, meta ?? ""),
    info: (m, meta) => console.info(tag, m, meta ?? ""),
    warn: (m, meta) => console.warn(tag, m, meta ?? ""),
    error: (m, meta) => console.error(tag, m, meta ?? ""),
  };
}
