import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_POLICY, invalidateConfigCaches, loadPolicy, loadRegistry } from "../src/policy";
import { seedClient, seedPolicy, TEST_CLIENT_ID } from "./seed";

describe("policy and registry", () => {
  beforeEach(async () => {
    invalidateConfigCaches();
    await seedClient();
  });

  it("loads the seeded registry", async () => {
    const registry = await loadRegistry(env);
    expect(registry.get("gpt-5")?.complimentary_pool).toBe("STANDARD");
    expect(registry.get("gpt-5-mini")?.complimentary_pool).toBe("MINI");
  });

  it("caches registry rows until invalidated", async () => {
    await loadRegistry(env);
    await env.DB.prepare(
      "INSERT INTO model_registry (model, provider, complimentary_pool, enabled, fallback_model, updated_at) VALUES ('gpt-5-nano', 'openai', 'MINI', 1, NULL, ?)",
    )
      .bind(new Date().toISOString())
      .run();
    expect((await loadRegistry(env)).has("gpt-5-nano")).toBe(false);
    invalidateConfigCaches();
    expect((await loadRegistry(env)).has("gpt-5-nano")).toBe(true);
  });

  it("returns the default policy and loads CLAMP policy", async () => {
    await expect(loadPolicy(env, TEST_CLIENT_ID)).resolves.toEqual(DEFAULT_CLIENT_POLICY);
    await seedPolicy(TEST_CLIENT_ID, { outputLimitMode: "CLAMP", maxPaidUsdDay: 12.5 });
    invalidateConfigCaches();
    await expect(loadPolicy(env, TEST_CLIENT_ID)).resolves.toMatchObject({
      outputLimitMode: "CLAMP",
      overflowMode: "REJECT",
      maxPaidUsdDay: 12.5,
      cacheEnabled: false,
      toolsMode: "REJECT",
    });
  });

  it("loads toolsMode ALLOW when seeded", async () => {
    await seedPolicy(TEST_CLIENT_ID, { toolsMode: "ALLOW" });
    invalidateConfigCaches();
    await expect(loadPolicy(env, TEST_CLIENT_ID)).resolves.toMatchObject({ toolsMode: "ALLOW" });
  });
});
