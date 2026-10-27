import { SELF } from "cloudflare:test";
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
});
