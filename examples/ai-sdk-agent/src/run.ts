import { throughline } from "@throughline/core";
import { sqlite } from "@throughline/store-sqlite";
import { registerDrafter } from "./agent";
import { slowScriptedModel } from "./model";

// A tiny CLI for the manual kill-and-resume demo (mirrors examples/deep-research).
const DB = process.env.THROUGHLINE_DB ?? "ai-sdk-agent.db";
// A shorter lease lets a killed worker's orphaned lease expire quickly so another worker
// reclaims the run without a long wait.
const leaseMs = Number(process.env.THROUGHLINE_LEASE_MS ?? 5000);
const [cmd, arg] = process.argv.slice(2);

const store = sqlite(DB);
const tf = throughline({ store });
registerDrafter(tf, {
  model: slowScriptedModel(),
  getCommits: async (range) => [
    `Fix lease fencing off-by-one in ${range}`,
    "Make appendStep idempotent on replay",
    "Add token budget reconstruction",
  ],
  budget: 5000,
  publish: async (notes) => console.log(`PUBLISHED: ${notes.slice(0, 60)}`),
});

switch (cmd) {
  case "start": {
    const id = await tf.start("release-notes", { range: arg ?? "v0.1.0..HEAD" });
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
    console.log("usage: run.js start [range] | work | approve <id> | status <id>");
    store.close();
}
