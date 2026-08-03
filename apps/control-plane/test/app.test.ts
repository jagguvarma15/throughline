import { throughline } from "@through-line/core";
import { sqlite } from "@through-line/store-sqlite";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { type AppOptions, createApp } from "../src/app";
import { resolveAuthConfig } from "../src/middleware/auth";

const ANON: AppOptions = { auth: { token: null, allowAnon: true } };
const TOKEN = "test-token";
const TOKENED: AppOptions = { auth: { token: TOKEN, allowAnon: false } };
const BEARER = { Authorization: `Bearer ${TOKEN}` };

async function setup(opts: AppOptions = ANON) {
  const store = sqlite(":memory:");
  await store.init();
  const tf = throughline({ store, sleep: async () => {} });
  tf.task("t", async (ctx) => ctx.step("a", async () => 1));
  tf.task("appr", async (ctx) => ctx.waitForApproval("go"));
  return { store, tf, app: createApp(store, opts) };
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
    await request(app).post("/runs/does-not-exist/signal").send({ name: "go" }).expect(404);
  });

  it("starts a run over HTTP and honors the idempotency key", async () => {
    const { tf, app } = await setup();
    const created = await request(app)
      .post("/runs")
      .send({ name: "t", input: { n: 1 }, idempotencyKey: "k1" })
      .expect(201);
    expect(created.body.id).toBeTruthy();

    // Same key: the existing run is returned, not a duplicate.
    const again = await request(app)
      .post("/runs")
      .send({ name: "t", input: { n: 2 }, idempotencyKey: "k1" })
      .expect(201);
    expect(again.body.id).toBe(created.body.id);

    expect((await tf.getRun(created.body.id))?.status).toBe("pending");
    await tf.worker({ leaseMs: 1000 }).runOnce();
    expect((await tf.getRun(created.body.id))?.status).toBe("completed");

    await request(app).post("/runs").send({ input: 1 }).expect(400);
    await request(app).post("/runs").send({ name: "" }).expect(400);
    await request(app).post("/runs").send({ name: "t", id: 42 }).expect(400);
  });

  it("validates list query params instead of passing them to SQL", async () => {
    const { app } = await setup();
    await request(app).get("/runs?limit=abc").expect(200); // NaN -> default, not SQL
    await request(app).get("/runs?limit=9999").expect(200); // clamped to the max
    await request(app).get("/runs?status=bogus").expect(400);
    await request(app).get("/runs?status=completed").expect(200);
  });

  it("requires the bearer token on every route except /health when configured", async () => {
    const { tf, app } = await setup(TOKENED);
    const id = await tf.start("appr", null);

    await request(app).get("/health").expect(200); // always open
    await request(app).get("/metrics").expect(401);
    await request(app).get("/runs").expect(401);
    await request(app).get(`/runs/${id}`).expect(401);
    await request(app).get("/stats").expect(401);
    await request(app).post("/runs").send({ name: "t" }).expect(401);
    await request(app).post(`/runs/${id}/signal`).send({ name: "go" }).expect(401);
    await request(app).post(`/runs/${id}/cancel`).expect(401);
    await request(app).get("/runs").set("Authorization", "Bearer wrong").expect(401);

    await request(app).get("/runs").set(BEARER).expect(200);
    await request(app).get("/stats").set(BEARER).expect(200);
    await request(app).post(`/runs/${id}/cancel`).set(BEARER).expect(200);
  });

  it("leaves /metrics open only with metricsPublic", async () => {
    const { app } = await setup({ ...TOKENED, metricsPublic: true });
    await request(app).get("/metrics").expect(200);
    await request(app).get("/runs").expect(401);
  });

  it("fails closed: no token and no explicit anon opt-out refuses to configure", () => {
    expect(() => resolveAuthConfig({})).toThrow(/THROUGHLINE_API_TOKEN/);
    expect(resolveAuthConfig({ THROUGHLINE_ALLOW_ANON: "1" })).toEqual({
      token: null,
      allowAnon: true,
    });
    expect(resolveAuthConfig({ THROUGHLINE_API_TOKEN: "s" })).toEqual({
      token: "s",
      allowAnon: false,
    });
  });
});
