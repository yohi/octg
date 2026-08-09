import type { PoolName, PoolNameLower, PoolState } from "./types";

export const POOL_LIMITS = {
  STANDARD: 1_000_000,
  MINI: 10_000_000
} as const satisfies Record<PoolName, number>;

export const CAUTION_THRESHOLD = 0.2;
export const STRICT_THRESHOLD = 0.05;

export type PolicyTier = "NORMAL" | "CAUTION" | "STRICT";

export function remainingOf(s: PoolState): number {
  return s.limit - s.confirmedTokens - s.reservedTokens - s.uncertainTokens;
}

export function tierOf(remaining: number, limit: number): PolicyTier {
  const ratio = remaining / limit;
  if (ratio <= STRICT_THRESHOLD) return "STRICT";
  if (ratio <= CAUTION_THRESHOLD) return "CAUTION";
  return "NORMAL";
}

export function utcDayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function nextUtcMidnight(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))
    .toISOString()
    .replace(".000Z", "Z");
}

export function quotaIdOf(pool: PoolName, day: string): string {
  return `quota:${pool}:${day}`;
}

export function toPoolLower(p: PoolName): PoolNameLower {
  return p === "STANDARD" ? "standard" : "mini";
}
