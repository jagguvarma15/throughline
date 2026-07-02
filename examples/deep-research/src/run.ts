import { throughline } from "@throughline/core";
import { sqlite } from "@throughline/store-sqlite";
import { registerResearch } from "./agent";
import { slowMockModel } from "./model";

// A tiny CLI for the manual kill-and-resume demo (see kill-and-resume.sh).
const DB = process.env.THROUGHLINE_DB ?? "deep-research.db";
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
    tf.worker({ leaseMs: 5000, pollIntervalMs: 200 }).start();
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
