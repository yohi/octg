import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedClient, seedPolicy, TEST_CLIENT_ID, TEST_CLIENT_KEY } from "./seed";
import { invalidateConfigCaches } from "../src/policy";

beforeEach(async () => {
  env.TEST_UPSTREAM_STATUS = "200";
  env.TEST_UPSTREAM_RESPONSE = undefined;
  await seedClient();
});

const todayStub = () => {
  const day = new Date().toISOString().slice(0, 10);
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
};

const authed = (body: unknown, key = TEST_CLIENT_KEY) =>
  SELF.fetch("https://octg.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

describe("proxy pipeline", () => {
  it("settles actual usage and returns quota headers", async () => {
    env.TEST_UPSTREAM_RESPONSE = JSON.stringify({
      id: "chatcmpl-1",
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
    const response = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 100 });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-OCTG-Pool")).toBe("standard");
    expect(response.headers.get("X-OCTG-Route")).toBe("free_shared");
    const state = await todayStub().getState();
    expect(state.confirmedTokens).toBe(150);
    expect(state.reservedTokens).toBe(0);
  });

  it("normalizes upstream output and sends AI Gateway controls", async () => {
    env.TEST_UPSTREAM_RESPONSE = JSON.stringify({ usage: { total_tokens: 10 } });
    expect(await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_tokens: 200 })).toHaveProperty("status", 200);
    expect(TEST_CLIENT_ID).toBe("client_test");
  });

  it("rejects unknown models and tool requests before reservation", async () => {
    const unknown = await authed({ model: "gpt-99", messages: [{ role: "user", content: "hi" }] });
    expect(unknown.status).toBe(403);
    expect((await unknown.json()) as { error: { code: string } }).toMatchObject({ error: { code: "model_requires_paid" } });
    const tools = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(tools.status).toBe(403);
    expect((await tools.json()) as { error: { code: string } }).toMatchObject({ error: { code: "model_not_allowed" } });
  });

  it("rejects non-text and conflicting max token requests", async () => {
    const image = await authed({ model: "gpt-5", messages: [{ role: "user", content: [{ type: "image_url" }] }] });
    expect(image.status).toBe(400);
    const conflict = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_tokens: 1, max_completion_tokens: 2 });
    expect(conflict.status).toBe(400);
    expect((await conflict.json()) as { error: { param: string } }).toMatchObject({ error: { param: "max_tokens" } });
  });

  it("supports CLAMP policy", async () => {
    await seedPolicy(TEST_CLIENT_ID, { outputLimitMode: "CLAMP" });
    invalidateConfigCaches();
    const state = todayStub();
    await state.reserve("seed-clamp", 900_000, 900_000);
    env.TEST_UPSTREAM_RESPONSE = JSON.stringify({ usage: { total_tokens: 10 } });
    const response = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 500_000 });
    expect(response.status).toBe(200);
  });
});
