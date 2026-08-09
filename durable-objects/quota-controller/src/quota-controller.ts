import { DurableObject } from "cloudflare:workers";
import { nextUtcMidnight, remainingOf, tierOf } from "@octg/shared";
import type { QuotaView, ReserveResult } from "@octg/shared";
import { getEntry, loadPool, putEntry, savePool } from "./store";
import type { QuotaIdentity } from "./store";

export interface QuotaControllerEnv {
  readonly QUOTA_LIMIT_STANDARD?: string;
  readonly QUOTA_LIMIT_MINI?: string;
}

export class QuotaController extends DurableObject<QuotaControllerEnv> {
  private get identity(): QuotaIdentity {
    const parts = this.ctx.id.name?.split(":") ?? [];
    const [prefix, pool, utcDay] = parts;
    if (
      parts.length !== 3 ||
      prefix !== "quota" ||
      (pool !== "STANDARD" && pool !== "MINI") ||
      utcDay === undefined ||
      utcDay.length === 0
    ) {
      throw new TypeError("QuotaController requires a quota:{POOL}:{UTC_DAY} name.");
    }

    const hasAsciiUtcDayFormat =
      utcDay.length === 10 && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(utcDay);
    if (!hasAsciiUtcDayFormat) {
      throw new TypeError("QuotaController requires a quota:{POOL}:{UTC_DAY} name.");
    }

    const date = new Date(`${utcDay}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== utcDay) {
      throw new TypeError("QuotaController requires a quota:{POOL}:{UTC_DAY} name.");
    }

    return { pool, utcDay };
  }

  async reserve(
    requestId: string,
    tokens: number,
    upperBoundTokens: number,
  ): Promise<ReserveResult> {
    if (
      !Number.isSafeInteger(tokens) ||
      tokens < 0 ||
      !Number.isSafeInteger(upperBoundTokens) ||
      upperBoundTokens < 0 ||
      upperBoundTokens < tokens
    ) {
      throw new TypeError("Reservation tokens and upper bound must be non-negative integers.");
    }

    const { pool, utcDay } = this.identity;
    const resetAt = nextUtcMidnight(new Date(`${utcDay}T00:00:00Z`));

    return this.ctx.storage.transaction(async (storage) => {
      const existing = await getEntry(storage, requestId);
      if (existing) {
        const result = existing.results.reserve;
        if (result) return result;
        throw new TypeError(`Request ${requestId} has no saved reserve result.`);
      }

      const state = await loadPool(storage, this.env, { pool, utcDay });
      const remaining = remainingOf(state);
      const hasCapacity = tokens <= remaining;
      const isStrict = tierOf(remaining, state.limit) === "STRICT";
      const fitsStrictBound = upperBoundTokens <= remaining;
      if (!hasCapacity || (isStrict && !fitsStrictBound)) {
        return { ok: false, reason: "insufficient_quota", remaining, resetAt };
      }

      const result: ReserveResult = {
        ok: true,
        remaining: remaining - tokens,
        resetAt,
      };
      const now = new Date().toISOString();
      await savePool(storage, {
        ...state,
        reservedTokens: state.reservedTokens + tokens,
        requestCount: state.requestCount + 1,
      });
      await putEntry(storage, requestId, {
        state: "reserved",
        reservedTokens: tokens,
        results: { reserve: result },
        createdAt: now,
        updatedAt: now,
      });
      return result;
    });
  }

  async getState(): Promise<QuotaView> {
    const { pool, utcDay } = this.identity;
    const state = await loadPool(this.ctx.storage, this.env, { pool, utcDay });
    return { ...state, pool, remaining: remainingOf(state) };
  }
}
