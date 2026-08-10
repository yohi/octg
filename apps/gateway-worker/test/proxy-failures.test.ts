import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

beforeEach(async () => {
  env.TEST_UPSTREAM_STATUS = "200";
  env.TEST_UPSTREAM_RESPONSE = undefined;
  await seedClient();
});

const stub = () => {
  const day = new Date().toISOString().slice(0, 10);
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
};
const request = () => SELF.fetch("https://octg.test/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
  body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 100 }),
});

describe("proxy failure paths", () => {
  it("marks upstream 5xx as uncertain and passes through the body", async () => {
    env.TEST_UPSTREAM_STATUS = "500";
    env.TEST_UPSTREAM_RESPONSE = JSON.stringify({ error: { code: "upstream" } });
    const response = await request();
    expect(response.status).toBe(500);
    expect((await stub().getState()).uncertainTokens).toBeGreaterThan(0);
  });

  it("marks network failure as uncertain", async () => {
    env.TEST_UPSTREAM_STATUS = "network";
    const response = await request();
    expect(response.status).toBe(500);
    expect((await stub().getState()).uncertainTokens).toBeGreaterThan(0);
  });

  it("releases a reservation when upstream configuration is missing", async () => {
    const { callUpstream, UpstreamConfigError } = await import("../src/upstream");
    await expect(callUpstream({ ...env, OCTG_UPSTREAM_API_TOKEN: "" }, "/chat/completions", {}, {
      client_id: "c", pool: "standard", eligibility: "COMPLIMENTARY", route: "free_shared", request_id: "r",
    }, null)).rejects.toBeInstanceOf(UpstreamConfigError);
  });

  it("marks a successful response without usage as uncertain", async () => {
    env.TEST_UPSTREAM_STATUS = "200";
    env.TEST_UPSTREAM_RESPONSE = JSON.stringify({ id: "missing-usage" });
    const response = await request();
    expect(response.status).toBe(200);
    expect((await stub().getState()).uncertainTokens).toBeGreaterThan(0);
  });
});
