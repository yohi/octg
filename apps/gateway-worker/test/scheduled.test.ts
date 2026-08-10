import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runScheduled } from "../src/scheduled";

describe("scheduled lifecycle", () => {
  it("fails closed when reconciliation cannot reach the Usage API", async () => {
    Object.assign(env, { OPENAI_USAGE_API_KEY: "test" });
    await expect(runScheduled(env, new Date("2026-08-12T00:05:00Z"))).rejects.toThrow();
  });
});
