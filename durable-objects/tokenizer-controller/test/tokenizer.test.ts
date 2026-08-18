import { describe, expect, it, vi } from "vitest";
import { estimateInputTokens } from "../src/tokenizer";

describe("estimateInputTokens", () => {
  it("counts o200k_base tokens and chat message overhead", () => {
    // Given: one message containing two o200k_base tokens.
    // When: input tokens are estimated.
    // Then: token count includes the documented chat overhead.
    expect(estimateInputTokens("Hello world", 1)).toBe(9);
  });

  it("adds overhead for every message", () => {
    // Given: comparable text split across different message counts.
    // When: each input is estimated.
    // Then: the multi-message request has a larger reservation.
    expect(estimateInputTokens("abcabcabc", 3)).toBeGreaterThan(estimateInputTokens("abc", 1));
  });

  it("adds opaque reasoning bytes to the visible token estimate", () => {
    const withoutOpaqueState = estimateInputTokens("visible", 1, 0);
    const withOpaqueState = estimateInputTokens("visible", 1, 28);

    expect(estimateInputTokens("visible", 1, 0)).toBe(withoutOpaqueState);
    expect(withOpaqueState).toBe(withoutOpaqueState + 28);
  });

  it("reproduces a printable 20 KB counterexample to byte-halving", async () => {
    // Given: a deterministic printable fixture generated with an LCG seed.
    const alphabet = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join("");
    let state = 0x12345678;
    let input = "";
    while (input.length < 20_000) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      input += alphabet[state % alphabet.length];
    }
    input = input.slice(0, 20_000);

    // When: the fixture is measured with the current o200k_base encoding.
    const { getEncoding } = await import("js-tiktoken");
    const tokens = getEncoding("o200k_base").encode(input).length;

    // Then: UTF-8 bytes / 2 underestimates the actual tokenizer count.
    expect(new TextEncoder().encode(input).byteLength).toBe(20_000);
    expect(tokens).toBe(14_812);
    expect(Math.ceil(20_000 / 2)).toBeLessThan(tokens);
  });

  it("uses the full UTF-8 byte length when encoding lookup fails", async () => {
    vi.resetModules();
    vi.doMock("js-tiktoken", () => ({
      getEncoding: () => {
        throw new Error("encoding unavailable");
      },
    }));

    const { estimateInputTokens: estimateWithFallback } = await import("../src/tokenizer");
    expect(estimateWithFallback("あ", 0)).toBe(new TextEncoder().encode("あ").length + 3);
  });
});
