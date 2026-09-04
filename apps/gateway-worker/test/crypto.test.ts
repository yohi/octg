import { afterEach, describe, expect, it, vi } from "vitest";
import { hashClientKey } from "../src/crypto";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hashClientKey", () => {
  it("shares an in-progress key import for concurrent calls with the same pepper", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("test-pepper"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const importKey = vi.spyOn(crypto.subtle, "importKey").mockResolvedValue(key);

    const hashes = await Promise.all([
      hashClientKey("raw-key", "test-pepper"),
      hashClientKey("raw-key", "test-pepper"),
    ]);

    expect(importKey).toHaveBeenCalledTimes(1);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("retries key import after the cached promise rejects", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("retry-pepper"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const importKey = vi.spyOn(crypto.subtle, "importKey")
      .mockRejectedValueOnce(new TypeError("key import failed"))
      .mockResolvedValueOnce(key);

    await expect(hashClientKey("raw-key", "retry-pepper")).rejects.toThrow("key import failed");
    await expect(hashClientKey("raw-key", "retry-pepper")).resolves.toMatch(/^[0-9a-f]{64}$/);

    expect(importKey).toHaveBeenCalledTimes(2);
  });

  it("keeps cached keys separated by pepper", async () => {
    const firstKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("first-pepper"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const secondKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("second-pepper"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const importKey = vi.spyOn(crypto.subtle, "importKey")
      .mockResolvedValueOnce(firstKey)
      .mockResolvedValueOnce(secondKey);

    const firstHash = await hashClientKey("raw-key", "first-pepper");
    const secondHash = await hashClientKey("raw-key", "second-pepper");

    expect(importKey).toHaveBeenCalledTimes(2);
    expect(firstHash).not.toBe(secondHash);
  });
});
