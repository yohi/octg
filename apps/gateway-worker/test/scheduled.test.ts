import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { runScheduled } from "../src/scheduled";

describe("scheduled lifecycle", () => {
  it("fails closed when reconciliation cannot reach the Usage API", async () => {
    Object.assign(env, { OPENAI_USAGE_API_KEY: "test" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Usage API unavailable"));
    await expect(runScheduled(env, new Date("2026-08-12T00:05:00Z"))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockRestore();
  });
});
