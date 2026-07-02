import { throughline } from "@throughline/core";
import { sqlite } from "@throughline/store-sqlite";
import { registerResearch } from "./agent";
import { slowMockModel } from "./model";

// A tiny CLI for the manual kill-and-resume demo (see kill-and-resume.sh).
const DB = process.env.THROUGHLINE_DB ?? "deep-research.db";
// A shorter lease lets a killed worker's orphaned lease expire quickly so another worker
// reclaims the run without a long wait. Defaults to 5s; the demo script sets it lower.
const leaseMs = Number(process.env.THROUGHLINE_LEASE_MS ?? 5000);
const [cmd, arg] = process.argv.slice(2);

const store = sqlite(DB);
const tf = throughline({ store });
registerResearch(tf, {
  model: slowMockModel(),
  budget: 5000,
  publish: async (report) => console.log(`PUBLISHED: ${report.slice(0, 60)}`),
});

switch (cmd) {
  case "start": {
    const id = await tf.start("deep-research", { topic: arg ?? "sea otters", maxIterations: 4 });
    console.log(id);
    store.close();
    break;
  }
  case "work": {
    console.log("worker started — kill -9 mid-run, then run 'work' again to resume");
    tf.worker({ leaseMs, pollIntervalMs: 200 }).start();
    break; // stay alive
  }
  case "approve": {
    await tf.signal(arg ?? "", "publish", { approved: true });
    console.log(`approved ${arg}`);
    store.close();
    break;
  }
  case "status": {
    console.log(JSON.stringify(await tf.getRun(arg ?? ""), null, 2));
    store.close();
    break;
  }
  default:
    console.log("usage: run.js start [topic] | work | approve <id> | status <id>");
    store.close();
}
