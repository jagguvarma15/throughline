import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { ScenarioResult } from "./report";
import { printResults } from "./report";
import * as claimContention from "./scenarios/claim-contention";
import * as e2eLatency from "./scenarios/e2e-latency";
import * as idleQps from "./scenarios/idle-qps";
import * as resumeCost from "./scenarios/resume-cost";
import * as stepThroughput from "./scenarios/step-throughput";

const scenarios = [stepThroughput, claimContention, resumeCost, idleQps, e2eLatency];

const { values } = parseArgs({
  options: {
    filter: { type: "string" },
    json: { type: "string" },
    quick: { type: "boolean", default: false },
  },
});

const selected = scenarios.filter((s) => !values.filter || s.name.includes(values.filter));
if (selected.length === 0) {
  console.error(`no scenario matches "${values.filter}"`);
  process.exit(1);
}

const all: ScenarioResult[] = [];
for (const s of selected) {
  console.log(`running ${s.name}${values.quick ? " (quick)" : ""} ...`);
  all.push(...(await s.run(values.quick ?? false)));
}

console.log("");
printResults(all);

if (values.json) {
  writeFileSync(values.json, JSON.stringify({ node: process.version, results: all }, null, 2));
  console.log(`\nwrote ${values.json}`);
}
