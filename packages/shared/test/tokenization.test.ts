import { describe, expect, it } from "vitest";
import {
  MAX_INPUT_TEXT_BYTES,
  estimatedInputTokensOf,
  resolveMaxInputBytes,
} from "../src/index";

describe("resolveMaxInputBytes", () => {
  it.each([undefined, "", "0", "-1", "1.5", "invalid",
    "9007199254740992"])("uses 1 MiB for invalid value %s", (value) => {
    expect(resolveMaxInputBytes(value)).toBe(1_048_576);
  });

  it("preserves valid values and clamps the tokenizer ceiling", () => {
    expect(resolveMaxInputBytes("2")).toBe(2);
    expect(resolveMaxInputBytes(String(MAX_INPUT_TEXT_BYTES))).toBe(
      MAX_INPUT_TEXT_BYTES,
    );
    expect(resolveMaxInputBytes(String(MAX_INPUT_TEXT_BYTES + 1))).toBe(
      MAX_INPUT_TEXT_BYTES,
    );
  });
});

describe("estimatedInputTokensOf", () => {
  it("adds base, opaque bytes, message overhead, and framing once", () => {
    expect(estimatedInputTokensOf({
      baseTokenCount: 2,
      messageCount: 2,
      opaqueInputBytes: 11,
    })).toBe(24);
  });

  it.each([
    { baseTokenCount: -1, messageCount: 0, opaqueInputBytes: 0 },
    { baseTokenCount: 1.5, messageCount: 0, opaqueInputBytes: 0 },
    {
      baseTokenCount: Number.MAX_SAFE_INTEGER,
      messageCount: 1,
      opaqueInputBytes: 0,
    },
  ])("rejects invalid or overflowing arithmetic %#", (args) => {
    expect(() => estimatedInputTokensOf(args)).toThrow(RangeError);
  });
});
