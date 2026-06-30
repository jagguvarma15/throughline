import { throughline } from "@throughline/core";
import { sqlite } from "@throughline/store-sqlite";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

async function setup() {
  const store = sqlite(":memory:");
  await store.init();
  const tf = throughline({ store, sleep: async () => {} });
  tf.task("t", async (ctx) => ctx.step("a", async () => 1));
  tf.task("appr", async (ctx) => ctx.waitForApproval("go"));
  return { store, tf, app: createApp(store) };
}

describe("control-plane", () => {
  it("serves /health and Prometheus /metrics", async () => {
    const { app } = await setup();
    await request(app).get("/health").expect(200);
    const m = await request(app).get("/metrics").expect(200);
    expect(m.headers["content-type"]).toContain("text/plain");
    expect(m.text).toContain("throughline_runs");
    expect(m.text).toContain("throughline_tokens_total");
  });

  it("lists runs and fetches one with its journal", async () => {
    const { tf, app } = await setup();
    const id = await tf.start("t", null);
    await tf.worker({ leaseMs: 1000 }).runOnce();

    const list = await request(app).get("/runs").expect(200);
    expect(list.body.runs).toHaveLength(1);

    const one = await request(app).get(`/runs/${id}`).expect(200);
    expect(one.body.run.status).toBe("completed");
    expect(one.body.steps).toHaveLength(1);

    await request(app).get("/runs/does-not-exist").expect(404);
  });

  it("signals a parked run and cancels a pending run", async () => {
    const { tf, app } = await setup();
    const id = await tf.start("appr", null);
    await tf.worker({ leaseMs: 1000, workerId: "w" }).runOnce(); // parks on waitForApproval
    expect((await tf.getRun(id))?.status).toBe("waiting");

    await request(app)
      .post(`/runs/${id}/signal`)
      .send({ name: "go", payload: { approved: true } })
      .expect(202);
    await tf.worker({ leaseMs: 1000, workerId: "w" }).runOnce(); // resumes
    expect((await tf.getRun(id))?.status).toBe("completed");

    const id2 = await tf.start("t", null);
    const cancel = await request(app).post(`/runs/${id2}/cancel`).expect(200);
    expect(cancel.body.result).toBe("cancelled");

    await request(app).post(`/runs/${id}/signal`).send({}).expect(400);
  });
});
