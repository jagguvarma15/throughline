import type { StoreStats } from "@through-line/core";

/** Render store stats as Prometheus text exposition format (replaces the old Math.random metrics). */
export function renderMetrics(s: StoreStats): string {
  const lines = ["# HELP throughline_runs Workflows by status", "# TYPE throughline_runs gauge"];
  for (const [status, count] of Object.entries(s.workflowsByStatus)) {
    lines.push(`throughline_runs{status="${status}"} ${count}`);
  }
  lines.push(
    "# HELP throughline_steps_total Journaled steps",
    "# TYPE throughline_steps_total counter",
    `throughline_steps_total ${s.stepCount}`,
    "# HELP throughline_steps_failed_total Failed journaled steps",
    "# TYPE throughline_steps_failed_total counter",
    `throughline_steps_failed_total ${s.failedStepCount}`,
    "# HELP throughline_tokens_total Tokens consumed across steps",
    "# TYPE throughline_tokens_total counter",
    `throughline_tokens_total ${s.tokenSum}`,
    "# HELP throughline_recovery_attempts_max Highest crash-recovery count across live runs",
    "# TYPE throughline_recovery_attempts_max gauge",
    `throughline_recovery_attempts_max ${s.maxRecoveryAttempts}`,
  );
  return `${lines.join("\n")}\n`;
}
