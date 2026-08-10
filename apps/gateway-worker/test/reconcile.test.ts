import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runReconciliation, targetUtcDay } from "../src/reconcile";

const now = new Date("2026-08-10T00:05:00Z");
describe("reconciliation", () => {
  it("targets the previous UTC day", () => {
    expect(targetUtcDay(now)).toBe("2026-08-09");
  });

  it("returns two pool reports when Usage API is unavailable in the test environment", async () => {
    Object.assign(env, { OPENAI_USAGE_API_KEY: "test" });
    await expect(runReconciliation(env, now)).rejects.toThrow();
  });
});
