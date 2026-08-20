import { describe, expect, it } from "vitest";
import { resolveTokenBudget, type TokenBudgetArguments } from "../src/token-budget";

const base: TokenBudgetArguments = {
  estimatedInput: 1_000,
  maxOutputTokens: 500,
  remaining: 2_100,
  limit: 100_000,
  outputLimitMode: "REJECT",
};

describe("resolveTokenBudget", () => {
  it("resolves a fitting REJECT decision", () => {
    expect(resolveTokenBudget(base)).toEqual({
      kind: "resolved",
      margin: 512,
      upperBound: 2_012,
      maxOutputTokens: 500,
      reservation: 2_012,
    });
  });

  it("resolves a fitting CLAMP decision with the reduced output", () => {
    expect(resolveTokenBudget({
      ...base,
      remaining: 1_700,
      outputLimitMode: "CLAMP",
    })).toEqual({
      kind: "resolved",
      margin: 512,
      upperBound: 2_012,
      maxOutputTokens: 188,
      reservation: 1_700,
    });
  });

  it("returns request_too_large for a valid upper bound over the pool limit", () => {
    expect(resolveTokenBudget({ ...base, limit: 1_000, remaining: 1_000 })).toEqual({ kind: "request_too_large" });
  });

  it("returns quota_exceeded for a valid reject decision", () => {
    expect(resolveTokenBudget({ ...base, remaining: 1_200 })).toEqual({ kind: "quota_exceeded" });
  });

  it.each([
    { ...base, estimatedInput: -1 },
    { ...base, estimatedInput: Number.NaN },
    { ...base, estimatedInput: Number.POSITIVE_INFINITY },
    { ...base, estimatedInput: Number.MAX_SAFE_INTEGER },
    { ...base, maxOutputTokens: -1 },
    { ...base, remaining: -1 },
    { ...base, limit: 0 },
    { ...base, limit: -1 },
  ])("returns arithmetic_error for invalid arithmetic input %#", (args) => {
    expect(resolveTokenBudget(args)).toEqual({ kind: "arithmetic_error" });
  });
});
