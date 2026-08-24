import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { usagePercentOf } from "../src/quota-api";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

beforeEach(async () => seedClient());
const getQuota = (key?: string) => SELF.fetch("https://octg.test/quota", { headers: key ? { authorization: `Bearer ${key}` } : {} });

describe("usagePercentOf", () => {
  it("reports zero for a disabled pool", () => {
    expect(usagePercentOf(0, 0)).toBe(0);
  });
});

describe("GET /quota", () => {
  it("requires authentication and rejects disabled clients", async () => {
    expect((await getQuota()).status).toBe(401);
    await seedClient({ enabled: false });
    expect((await getQuota(TEST_CLIENT_KEY)).status).toBe(403);
  });

  it("returns aggregate independent pool views", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const standard = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await standard.reserve("q1", 250_000, 250_000);
    await standard.settle("q1", 200_000);
    await standard.reserve("q2", 100_000, 100_000);
    const mini = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:MINI:${day}`));
    await mini.reserve("m1", 5_000_000, 5_000_000);
    const response = await getQuota(TEST_CLIENT_KEY);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { pools: { standard: { confirmed: number; reserved: number; remaining: number; usage_percent: number }; mini: { remaining: number; usage_percent: number } } };
    expect(body.pools.standard).toMatchObject({ confirmed: 200_000, reserved: 100_000, remaining: 700_000, usage_percent: 30 });
    expect(body.pools.mini).toMatchObject({ remaining: 4_950_000, usage_percent: 50.25 });
    expect(JSON.stringify(body)).not.toContain("client");
  });
});
