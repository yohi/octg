import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const stub = (pool = "STANDARD", day = "2026-08-09") =>
  env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:${pool}:${day}`));

describe("harness smoke", () => {
  it("unknown route returns 404", async () => {
    // Given: the Worker has no route for /nope.
    // When: the route is requested through the Worker surface.
    const res = await SELF.fetch("http://example.com/nope");

    // Then: the Worker returns the Not Found response.
    expect(res.status).toBe(404);
  });

  it("DO stub is reachable and reports default STANDARD limit", async () => {
    // Given: the STANDARD pool for a fixed UTC day.
    // When: its DO state is requested.
    const state = await stub().getState();

    // Then: the identity and default standard limit are exposed.
    expect(state.pool).toBe("STANDARD");
    expect(state.utcDay).toBe("2026-08-09");
    expect(state.limit).toBe(1_000_000);
  });

  it("D1 migrations are applied (registry seeded)", async () => {
    // Given: the Worker D1 binding after suite setup.
    // When: the first registry model is queried.
    const row = await env.DB
      .prepare("SELECT model FROM model_registry ORDER BY model LIMIT 1")
      .first<{ model: string }>();

    // Then: the registry's STANDARD seed model is present.
    expect(row?.model).toBe("gpt-5");
  });
});
