import { DurableObject } from "cloudflare:workers";
import { nextUtcMidnight, remainingOf, tierOf } from "@octg/shared";
import type {
  FinalizeResult,
  MarkUncertainResult,
  QuotaView,
  ReconcileSnapshot,
  ReconcileDisposition,
  ReconcileResult,
  ReleaseResult,
  ReserveResult,
  SettleResult,
} from "@octg/shared";
import { QuotaLifecycle } from "./quota-lifecycle";
import {
  getEntry,
  getIdempotencyRequestId,
  FINALIZE_KEY,
  loadPool,
  loadUnresolved,
  putEntry,
  putIdempotencyRequestId,
  savePool,
  saveUnresolved,
} from "./store";
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
    idempotencyKey?: string,
    clientId?: string,
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
      const idempotencyRequestId = idempotencyKey !== undefined
        ? await getIdempotencyRequestId(storage, idempotencyKey, clientId)
        : undefined;
      const mappedEntry = idempotencyRequestId === undefined
        ? undefined
        : await getEntry(storage, idempotencyRequestId);
      const entryRequestId = mappedEntry?.state === "released"
        ? requestId
        : (idempotencyRequestId ?? requestId);
      const existing = await getEntry(storage, entryRequestId);
      if (existing) {
        if (idempotencyRequestId !== undefined && existing.state !== "released") {
          return {
            ok: false,
            reason: "duplicate_idempotency_key",
            requestId: entryRequestId,
            resetAt,
          };
        }
        if (
          existing.tokens !== tokens ||
          existing.upperBoundTokens !== upperBoundTokens
        ) {
          throw new TypeError(
            `Request ${entryRequestId} parameters do not match the saved request.`,
          );
        }
        const result = existing.results.reserve;
        if (result) return result;
        throw new TypeError(`Request ${entryRequestId} has no saved reserve result.`);
      }

      if (await storage.get<boolean>(FINALIZE_KEY)) {
        return { ok: false, reason: "insufficient_quota", remaining: 0, resetAt };
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
      const unresolved = await loadUnresolved(storage);
      await savePool(storage, {
        ...state,
        reservedTokens: state.reservedTokens + tokens,
        requestCount: state.requestCount + 1,
      });
      await putEntry(storage, requestId, {
        state: "reserved",
        tokens,
        upperBoundTokens,
        reservedTokens: tokens,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        results: { reserve: result },
        createdAt: now,
        updatedAt: now,
      });
      await saveUnresolved(storage, {
        ...unresolved,
        reservedCount: unresolved.reservedCount + 1,
      });
      if (idempotencyKey !== undefined) {
        await putIdempotencyRequestId(storage, idempotencyKey, requestId, clientId);
      }
      return result;
    });
  }

  async settle(requestId: string, actualTokens: number): Promise<SettleResult> {
    if (!Number.isSafeInteger(actualTokens) || actualTokens < 0) {
      throw new TypeError("Actual tokens must be a non-negative safe integer.");
    }
    return this.lifecycle.settle(requestId, actualTokens);
  }

  async markUncertain(requestId: string): Promise<MarkUncertainResult> {
    return this.lifecycle.markUncertain(requestId);
  }

  async release(requestId: string): Promise<ReleaseResult> {
    return this.lifecycle.release(requestId);
  }

  async reconcileRequest(
    requestId: string,
    disposition: ReconcileDisposition,
  ): Promise<ReconcileResult> {
    if (disposition !== "consumed" && disposition !== "unused") {
      throw new TypeError("Reconcile disposition must be consumed or unused.");
    }
    return this.lifecycle.reconcileRequest(requestId, disposition);
  }

  async getReconcileSnapshot(): Promise<ReconcileSnapshot> {
    return this.lifecycle.getReconcileSnapshot();
  }

  async finalizeDay(): Promise<FinalizeResult> {
    return this.lifecycle.finalizeDay();
  }

  private get lifecycle(): QuotaLifecycle {
    return new QuotaLifecycle({
      storage: this.ctx.storage,
      env: this.env,
      quotaId: this.ctx.id.name,
      identityOf: () => this.identity,
    });
  }

  async getState(): Promise<QuotaView> {
    const { pool, utcDay } = this.identity;
    const state = await loadPool(this.ctx.storage, this.env, { pool, utcDay });
    return { ...state, pool, remaining: remainingOf(state) };
  }
}
