import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { invalidateConfigCaches } from "../src/policy";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

beforeEach(async () => {
  invalidateConfigCaches();
  await seedClient();
});

describe("GET /v1/models", () => {
  it("returns enabled complimentary models when Deno tokenizer configuration is absent", async () => {
    const response = await SELF.fetch("https://octg.test/v1/models", { headers: { authorization: `Bearer ${TEST_CLIENT_KEY}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string; data: Array<{ id: string; object: string }> };
    expect(body.object).toBe("list");
    expect(body.data.map((model) => model.id).sort()).toEqual(["gpt-5", "gpt-5-mini", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
  });

  it("excludes NONE models and requires authentication", async () => {
    await env.DB.prepare(
      "INSERT INTO model_registry (model, provider, complimentary_pool, enabled, fallback_model, updated_at) VALUES ('gpt-4o', 'openai', 'NONE', 1, NULL, ?)",
    ).bind(new Date().toISOString()).run();
    invalidateConfigCaches();
    const response = await SELF.fetch("https://octg.test/v1/models", { headers: { authorization: `Bearer ${TEST_CLIENT_KEY}` } });
    expect((await response.json() as { data: Array<{ id: string }> }).data.some((model) => model.id === "gpt-4o")).toBe(false);
    expect((await SELF.fetch("https://octg.test/v1/models")).status).toBe(401);
  });

  it("checks partial Deno tokenizer configuration only after authentication", async () => {
    const original = Object.getOwnPropertyDescriptor(env, "DENO_TOKENIZER_ENDPOINT");
    Object.defineProperty(env, "DENO_TOKENIZER_ENDPOINT", {
      value: "https://tokenizer.example/v1/tokenize",
      configurable: true,
    });

    try {
      const unauthenticated = await SELF.fetch("https://octg.test/v1/models");
      expect(unauthenticated.status).toBe(401);

      const authenticated = await SELF.fetch("https://octg.test/v1/models", {
        headers: { authorization: `Bearer ${TEST_CLIENT_KEY}` },
      });
      expect(authenticated.status).toBe(500);
      expect(await authenticated.json()).toMatchObject({ error: { code: "internal_error" } });
    } finally {
      if (original) Object.defineProperty(env, "DENO_TOKENIZER_ENDPOINT", original);
      else Reflect.deleteProperty(env, "DENO_TOKENIZER_ENDPOINT");
    }
  });
});
