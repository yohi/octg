import { describe, expect, it } from "vitest";
import { resolveLimit } from "../src/store";

describe("resolveLimit", () => {
  it("preserves an explicit zero limit while falling back for an empty value", () => {
    expect(resolveLimit({ QUOTA_LIMIT_STANDARD: "0" }, "STANDARD")).toBe(0);
    expect(resolveLimit({ QUOTA_LIMIT_STANDARD: "" }, "STANDARD")).toBe(1_000_000);
  });
});
