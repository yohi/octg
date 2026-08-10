import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

beforeEach(async () => {
  await seedClient();
  vi.restoreAllMocks();
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
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "upstream" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }));
    const response = await request();
    expect(response.status).toBe(500);
    expect((await stub().getState()).uncertainTokens).toBeGreaterThan(0);
  });

  it("releases a reservation for upstream 4xx other than timeout and rate limit", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "invalid_request" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    const before = await stub().getState();
    const response = await request();
    const after = await stub().getState();
    expect(response.status).toBe(400);
    expect(after.reservedTokens).toBe(before.reservedTokens);
    expect(after.uncertainTokens).toBe(before.uncertainTokens);
  });

  it("marks network failure as uncertain", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    const response = await request();
    expect(response.status).toBe(500);
    expect((await stub().getState()).uncertainTokens).toBeGreaterThan(0);
  });

  it("releases a reservation when upstream configuration is missing", async () => {
    const original = env.OCTG_UPSTREAM_API_TOKEN;
    Object.defineProperty(env, "OCTG_UPSTREAM_API_TOKEN", { value: "", configurable: true });
    const before = await stub().getState();
    const response = await request();
    Object.defineProperty(env, "OCTG_UPSTREAM_API_TOKEN", { value: original, configurable: true });
    expect(response.status).toBe(500);
    const after = await stub().getState();
    expect(after.reservedTokens).toBe(before.reservedTokens);
  });

  it("marks a successful response without usage as uncertain", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "missing-usage" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const response = await request();
    expect(response.status).toBe(200);
    expect((await stub().getState()).uncertainTokens).toBeGreaterThan(0);
  });

  it("persists the reservation amount for reconciliation", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "missing-usage" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await request();
    const row = await env.DB.prepare("SELECT reserved_tokens, status FROM requests ORDER BY started_at DESC LIMIT 1").first<{ reserved_tokens: number; status: string }>();
    expect(row?.reserved_tokens).toBeGreaterThan(0);
    expect(row?.status).toBe("uncertain");
  });
});
