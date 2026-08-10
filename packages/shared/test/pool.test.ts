import { describe, expect, it } from "vitest";
import {
  POOL_LIMITS,
  nextUtcMidnight,
  quotaIdOf,
  remainingOf,
  tierOf,
  toPoolLower,
  utcDayOf,
  type PoolState,
  type RequestEntry
} from "../src/index";

const state = (over: Partial<PoolState>): PoolState => ({
  utcDay: "2026-08-09",
  limit: 1_000_000,
  confirmedTokens: 0,
  reservedTokens: 0,
  uncertainTokens: 0,
  requestCount: 0,
  updatedAt: "2026-08-09T00:00:00Z",
  ...over
});

describe("pool utils", () => {
  it("keeps idempotent results distinct for each request RPC", () => {
    // Given: one request that has produced several RPC outcomes.
    const entry = {
      state: "settled",
      tokens: 4_000,
      upperBoundTokens: 4_000,
      reservedTokens: 4_000,
      createdAt: "2026-08-09T00:00:00Z",
      updatedAt: "2026-08-09T00:00:01Z",
      results: {
        reserve: { ok: true, remaining: 996_000, resetAt: "2026-08-10T00:00:00Z" },
        settle: { ok: true },
        reconcile: { ok: true, applied: true }
      }
    } satisfies RequestEntry;

    // When: each operation reads its saved idempotency result.
    // Then: it receives only its own typed result.
    expect(entry.results.reserve.remaining).toBe(996_000);
    expect(entry.results.settle.ok).toBe(true);
    expect(entry.results.reconcile.applied).toBe(true);
  });

  it("POOL_LIMITS are the spec values", () => {
    // Given: the shared pool limits.
    // When: each free pool limit is read.
    // Then: it matches the design specification.
    expect(POOL_LIMITS.STANDARD).toBe(1_000_000);
    expect(POOL_LIMITS.MINI).toBe(10_000_000);
  });

  it("remainingOf subtracts confirmed + reserved + uncertain", () => {
    // Given: a pool with every consumption bucket populated.
    // When: remaining capacity is calculated.
    // Then: all three buckets are subtracted from the limit.
    expect(
      remainingOf(state({ confirmedTokens: 100, reservedTokens: 20, uncertainTokens: 5 }))
    ).toBe(999_875);
  });

  it("tierOf: >20% NORMAL, <=20% CAUTION, <=5% STRICT", () => {
    // Given: capacity values at both policy boundaries.
    // When: their policy tier is calculated.
    // Then: equality belongs to the lower, more restrictive tier.
    expect(tierOf(200_001, 1_000_000)).toBe("NORMAL");
    expect(tierOf(200_000, 1_000_000)).toBe("CAUTION");
    expect(tierOf(50_001, 1_000_000)).toBe("CAUTION");
    expect(tierOf(50_000, 1_000_000)).toBe("STRICT");
  });

  it("tierOf returns STRICT for invalid limits or remaining values", () => {
    expect(tierOf(0, 0)).toBe("STRICT");
    expect(tierOf(Number.POSITIVE_INFINITY, 1_000_000)).toBe("STRICT");
    expect(tierOf(1, Number.POSITIVE_INFINITY)).toBe("STRICT");
  });

  it("utcDayOf / nextUtcMidnight / quotaIdOf / toPoolLower", () => {
    // Given: an instant immediately before UTC midnight.
    // When: shared date, identity, and header utilities are called.
    const d = new Date("2026-08-09T23:59:59.500Z");

    // Then: they retain UTC semantics and canonical pool forms.
    expect(utcDayOf(d)).toBe("2026-08-09");
    expect(nextUtcMidnight(d)).toBe("2026-08-10T00:00:00Z");
    expect(quotaIdOf("STANDARD", "2026-08-09")).toBe("quota:STANDARD:2026-08-09");
    expect(toPoolLower("STANDARD")).toBe("standard");
    expect(toPoolLower("MINI")).toBe("mini");
  });
});
