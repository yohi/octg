import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("internal relay invocation version attribution", () => {
  it.each([
    "/internal/relay/v1/decision",
    "/internal/relay/v1/activation",
    "/internal/relay/v1/renewal",
    "/internal/relay/v1/terminal",
    "/internal/relay/v1/cpu-gate/slot",
    "/internal/relay/v1/cpu-gate/setup",
  ])("includes the stateless Worker version even when %s rejects the request", async (path) => {
    // Given: no credentials and no fixture creation.
    const request = new Request(`https://worker.example${path}`);
    // When: the real Worker entry point routes the invocation.
    const response = await SELF.fetch(request);
    // Then: rejection still identifies the incoming Worker invocation.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("X-OCTG-Worker-Version")).toEqual(expect.any(String));
    expect(response.headers.get("X-OCTG-Worker-Version")).not.toBe("");
  });

  it("includes the Worker version on an internal returned 4xx response", async () => {
    const previous = env.OCTG_RELAY_CPU_GATE_AUTH_TOKEN;
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: "c".repeat(43) });
    try {
      const response = await SELF.fetch(new Request(
        "https://worker.example/internal/relay/v1/cpu-gate/quota?pool=STANDARD&utcDay=invalid",
        { headers: { Authorization: `Bearer ${"c".repeat(43)}` } },
      ));
      expect(response.status).toBe(400);
      expect(response.headers.get("X-OCTG-Worker-Version")).toEqual(expect.any(String));
      expect(response.headers.get("X-OCTG-Worker-Version")).not.toBe("");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(env, "OCTG_RELAY_CPU_GATE_AUTH_TOKEN");
      else Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: previous });
    }
  });
});
