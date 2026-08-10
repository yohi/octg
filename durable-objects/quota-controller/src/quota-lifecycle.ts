import { remainingOf } from "@octg/shared";
import type {
  FinalizeResult,
  MarkUncertainResult,
  ReconcileDisposition,
  ReconcileResult,
  ReconcileSnapshot,
  ReleaseResult,
  RequestEntry,
  SettleResult,
} from "@octg/shared";
import {
  getEntry,
  FINALIZE_KEY,
  loadUnresolved,
  loadPool,
  putEntry,
  ENTRY_PREFIX,
  savePool,
  saveUnresolved,
} from "./store";
import type { QuotaEnvLike, QuotaIdentity } from "./store";

export interface QuotaLifecycleContext {
  readonly storage: DurableObjectStorage;
  readonly env: QuotaEnvLike;
  readonly quotaId: string | undefined;
  identityOf(): QuotaIdentity;
}

export class QuotaLifecycle {
  constructor(private readonly context: QuotaLifecycleContext) {}

  async getReconcileSnapshot(): Promise<ReconcileSnapshot> {
    const entries = await this.context.storage.list<RequestEntry>({ prefix: ENTRY_PREFIX });
    return {
      requests: [...entries.entries()]
        .filter(([, entry]) => entry.state === "uncertain")
        .map(([requestId, entry]) => ({
          requestId: String(requestId).slice(ENTRY_PREFIX.length),
          reservedTokens: entry.reservedTokens,
        })),
    };
  }

  async settle(requestId: string, actualTokens: number): Promise<SettleResult> {
    return this.context.storage.transaction(async (storage) => {
      const entry = await getEntry(storage, requestId);
      if (!entry) return { ok: false, reason: "unknown_request" };

      const priorResult = entry.results.settle;
      if (priorResult) return priorResult;

      if (entry.state !== "reserved" && entry.state !== "uncertain") {
        const result: SettleResult = { ok: true };
        await putEntry(storage, requestId, {
          ...entry,
          results: { ...entry.results, settle: result },
        });
        return result;
      }

      const { pool, utcDay } = this.context.identityOf();
      const poolState = await loadPool(storage, this.context.env, { pool, utcDay });
      const stateAfterRelease =
        entry.state === "reserved"
          ? {
              ...poolState,
              reservedTokens: Math.max(0, poolState.reservedTokens - entry.reservedTokens),
            }
          : {
              ...poolState,
              uncertainTokens: Math.max(0, poolState.uncertainTokens - entry.reservedTokens),
            };
      const nextState = {
        ...stateAfterRelease,
        confirmedTokens: stateAfterRelease.confirmedTokens + actualTokens,
      };
      const unresolvedState = await loadUnresolved(storage);
      const result: SettleResult = { ok: true };
      const nextEntry: RequestEntry = {
        ...entry,
        state: "settled",
        actualTokens,
        results: { ...entry.results, settle: result },
      };

      await savePool(storage, nextState);
      await putEntry(storage, requestId, nextEntry);
      await saveUnresolved(storage, {
        uncertainCount: Math.max(
          0,
          unresolvedState.uncertainCount - (entry.state === "uncertain" ? 1 : 0),
        ),
        reservedCount: Math.max(
          0,
          unresolvedState.reservedCount - (entry.state === "reserved" ? 1 : 0),
        ),
      });
      if (remainingOf(nextState) < 0) {
        console.warn("quota settlement overage", {
          quotaId: this.context.quotaId,
          confirmedTokens: nextState.confirmedTokens,
          reservedTokens: nextState.reservedTokens,
          uncertainTokens: nextState.uncertainTokens,
          limit: nextState.limit,
        });
      }
      return result;
    });
  }

  async markUncertain(requestId: string): Promise<MarkUncertainResult> {
    return this.context.storage.transaction(async (storage) => {
      const entry = await getEntry(storage, requestId);
      if (!entry) return { ok: false, reason: "unknown_request" };

      const priorResult = entry.results.markUncertain;
      if (priorResult) return priorResult;

      if (entry.state !== "reserved") {
        console.warn("quota mark uncertain conflict", {
          quotaId: this.context.quotaId,
          requestId,
          state: entry.state,
        });
        const result: MarkUncertainResult = { ok: true };
        await putEntry(storage, requestId, {
          ...entry,
          results: { ...entry.results, markUncertain: result },
        });
        return result;
      }

      const { pool, utcDay } = this.context.identityOf();
      const poolState = await loadPool(storage, this.context.env, { pool, utcDay });
      const nextState = {
        ...poolState,
        reservedTokens: Math.max(0, poolState.reservedTokens - entry.reservedTokens),
        uncertainTokens: poolState.uncertainTokens + entry.reservedTokens,
      };
      const unresolved = await loadUnresolved(storage);
      const result: MarkUncertainResult = { ok: true };
      const nextEntry: RequestEntry = {
        ...entry,
        state: "uncertain",
        results: { ...entry.results, markUncertain: result },
      };

      await savePool(storage, nextState);
      await putEntry(storage, requestId, nextEntry);
      await saveUnresolved(storage, {
        uncertainCount: unresolved.uncertainCount + 1,
        reservedCount: Math.max(0, unresolved.reservedCount - 1),
      });
      return result;
    });
  }

  async release(requestId: string): Promise<ReleaseResult> {
    return this.context.storage.transaction(async (storage) => {
      const entry = await getEntry(storage, requestId);
      if (!entry) return { ok: false, reason: "unknown_request" };

      const priorResult = entry.results.release;
      if (priorResult) return priorResult;

      if (entry.state !== "reserved") {
        const result: ReleaseResult = { ok: true };
        await putEntry(storage, requestId, {
          ...entry,
          results: { ...entry.results, release: result },
        });
        return result;
      }

      const { pool, utcDay } = this.context.identityOf();
      const poolState = await loadPool(storage, this.context.env, { pool, utcDay });
      const nextState = {
        ...poolState,
        reservedTokens: Math.max(0, poolState.reservedTokens - entry.reservedTokens),
      };
      const unresolved = await loadUnresolved(storage);
      const result: ReleaseResult = { ok: true };
      const nextEntry: RequestEntry = {
        ...entry,
        state: "released",
        results: { ...entry.results, release: result },
      };

      await savePool(storage, nextState);
      await putEntry(storage, requestId, nextEntry);
      await saveUnresolved(storage, {
        ...unresolved,
        reservedCount: Math.max(0, unresolved.reservedCount - 1),
      });
      return result;
    });
  }

  async reconcileRequest(
    requestId: string,
    disposition: ReconcileDisposition,
  ): Promise<ReconcileResult> {
    return this.context.storage.transaction(async (storage) => {
      const entry = await getEntry(storage, requestId);
      if (!entry) return { ok: true, applied: false };

      const priorResult = entry.results.reconcile;
      if (priorResult) {
        if (entry.requestedDisposition !== disposition) {
          console.warn("quota reconcile disposition conflict", {
            quotaId: this.context.quotaId,
            requestId,
            requestedDisposition: entry.requestedDisposition,
            disposition,
          });
        }
        return priorResult;
      }
      if (entry.state !== "uncertain") return { ok: true, applied: false };

      const { pool, utcDay } = this.context.identityOf();
      const poolState = await loadPool(storage, this.context.env, { pool, utcDay });
      const stateAfterUncertainty = {
        ...poolState,
        uncertainTokens: Math.max(0, poolState.uncertainTokens - entry.reservedTokens),
      };
      const unresolved = await loadUnresolved(storage);
      const nextState =
        disposition === "consumed"
          ? {
              ...stateAfterUncertainty,
              confirmedTokens: stateAfterUncertainty.confirmedTokens + entry.reservedTokens,
            }
          : stateAfterUncertainty;
      const nextRequestState: RequestEntry["state"] =
        disposition === "consumed" ? "reconciled" : "released";
      const result: ReconcileResult = { ok: true, applied: true };
      const nextEntry: RequestEntry = {
        ...entry,
        state: nextRequestState,
        requestedDisposition: disposition,
        results: { ...entry.results, reconcile: result },
      };

      await savePool(storage, nextState);
      await putEntry(storage, requestId, nextEntry);
      await saveUnresolved(storage, {
        uncertainCount: Math.max(0, unresolved.uncertainCount - 1),
        reservedCount: unresolved.reservedCount,
      });
      return result;
    });
  }

  async finalizeDay(): Promise<FinalizeResult> {
    const unresolved: FinalizeResult = await this.context.storage.transaction(async (storage) => {
      const { uncertainCount, reservedCount } = await loadUnresolved(storage);
      if (uncertainCount > 0 || reservedCount > 0) {
        return {
          ok: false,
          reason: uncertainCount > 0 ? "uncertain_remaining" : "reserved_remaining",
          uncertainCount,
          reservedCount,
        } as const;
      }
      await storage.put(FINALIZE_KEY, true);
      return { ok: true, deleted: true } as const;
    });
    if (!unresolved.ok) return unresolved;
    await this.context.storage.deleteAll();
    return unresolved;
  }
}
