export interface Metric {
  name: string;
  value: number;
  unit: string;
}

export interface ScenarioResult {
  scenario: string;
  store: string;
  config: string;
  metrics: Metric[];
}

export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

export function summarize(samples: number[]): { p50: number; p95: number; p99: number } {
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
  };
}

function fmt(value: number): string {
  if (Number.isNaN(value)) return "-";
  if (value >= 1000) return Math.round(value).toString();
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

/** Plain fixed-width table, one row per metric. */
export function printResults(results: ScenarioResult[]): void {
  const rows: string[][] = [["scenario", "store", "config", "metric", "value", "unit"]];
  for (const r of results) {
    for (const m of r.metrics) {
      rows.push([r.scenario, r.store, r.config, m.name, fmt(m.value), m.unit]);
    }
  }
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? "").length)));
  if (!widths) return;
  for (const [i, row] of rows.entries()) {
    const line = row.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join("  ");
    console.log(line);
    if (i === 0) console.log(widths.map((w) => "-".repeat(w)).join("  "));
  }
}

export function skippedResult(scenario: string, store: string, reason: string): ScenarioResult {
  return {
    scenario,
    store,
    config: reason,
    metrics: [{ name: "skipped", value: Number.NaN, unit: "" }],
  };
}
