import { describe, expect, it } from "vitest";
import { decideOutput, estimateInputTokens, safetyMargin, upperBoundOf } from "../src/index";

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
});

describe("safetyMargin", () => {
  it("uses the normal-tier 2 percent margin above 20 percent remaining", () => {
    // Given: remaining ratios above the caution threshold.
    // When: the safety margin is calculated.
    // Then: the normal-tier minimum and percentage are applied.
    expect(safetyMargin(1_000, 0.21)).toBe(256);
    expect(safetyMargin(100_000, 0.5)).toBe(2_000);
  });

  it("uses the caution-tier 5 percent margin at or below 20 percent remaining", () => {
    // Given: remaining ratios at and below the caution threshold.
    // When: the safety margin is calculated.
    // Then: the more conservative minimum and percentage are applied.
    expect(safetyMargin(1_000, 0.2)).toBe(512);
    expect(safetyMargin(100_000, 0.1)).toBe(5_000);
  });
});

describe("upperBoundOf", () => {
  it("uses the strict-tier margin for the durable-object upper bound", () => {
    // Given: input and requested output amounts.
    // When: the strict upper bound is calculated.
    // Then: it includes the always-conservative five percent margin.
    expect(upperBoundOf(10_000, 1_000)).toBe(11_512);
    expect(upperBoundOf(100_000, 1_000)).toBe(106_000);
  });
});

describe("decideOutput", () => {
  const base = { estimatedInput: 1_000, maxOutputTokens: 500, margin: 100 };

  it("proceeds unchanged when the reservation fits", () => {
    // Given: enough remaining quota for input, output, and margin.
    // When: output control is applied.
    // Then: the requested output is preserved.
    expect(
      decideOutput({ ...base, remaining: 2_000, outputLimitMode: "REJECT" }),
    ).toEqual({ action: "proceed", maxOutputTokens: 500 });
  });

  it("rejects a non-fitting reservation in REJECT mode", () => {
    // Given: insufficient remaining quota in the default mode.
    // When: output control is applied.
    // Then: the request is rejected instead of calling upstream.
    expect(
      decideOutput({ ...base, remaining: 1_599, outputLimitMode: "REJECT" }),
    ).toEqual({ action: "reject" });
  });

  it("clamps output to the positive candidate in CLAMP mode", () => {
    // Given: a CLAMP policy with positive remaining output capacity.
    // When: output control is applied.
    // Then: output is reduced to the exact candidate.
    expect(
      decideOutput({ ...base, remaining: 1_300, outputLimitMode: "CLAMP" }),
    ).toEqual({ action: "proceed", maxOutputTokens: 200 });
  });

  it("rejects instead of sending zero or negative output upstream in CLAMP mode", () => {
    // Given: CLAMP candidates at and below zero.
    // When: output control is applied.
    // Then: neither request proceeds upstream.
    expect(
      decideOutput({ ...base, remaining: 1_100, outputLimitMode: "CLAMP" }),
    ).toEqual({ action: "reject" });
    expect(
      decideOutput({ ...base, remaining: 1_050, outputLimitMode: "CLAMP" }),
    ).toEqual({ action: "reject" });
  });
});
