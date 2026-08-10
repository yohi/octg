import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedClient, seedPolicy, TEST_CLIENT_ID, TEST_CLIENT_KEY } from "./seed";
import { invalidateConfigCaches } from "../src/policy";

beforeEach(async () => {
  await seedClient();
  vi.restoreAllMocks();
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
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      id: "chatcmpl-1",
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const response = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 100 });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-OCTG-Pool")).toBe("standard");
    expect(response.headers.get("X-OCTG-Route")).toBe("free_shared");
    const state = await todayStub().getState();
    expect(state.confirmedTokens).toBe(150);
    expect(state.reservedTokens).toBe(0);
  });

  it("normalizes upstream output and sends AI Gateway controls", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    let upstreamHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      upstreamHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ usage: { total_tokens: 10 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const response = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_tokens: 200 });
    expect(response.status).toBe(200);
    expect(upstreamBody?.max_completion_tokens).toBeTypeOf("number");
    expect(upstreamBody?.max_tokens).toBeUndefined();
    expect(upstreamHeaders?.get("cf-aig-max-attempts")).toBe("2");
    expect(upstreamHeaders?.get("cf-aig-metadata")).toContain("client_test");
    expect(upstreamHeaders?.get("cf-aig-cache-key")).toBeNull();
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
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { max_completion_tokens: number };
      expect(body.max_completion_tokens).toBeLessThan(500_000);
      return new Response(JSON.stringify({ usage: { total_tokens: 10 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const response = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 500_000 });
    expect(response.status).toBe(200);
  });
});
