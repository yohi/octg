// allow: SIZE_OK — hosts the design-mandated single quota lifecycle seam
// (applyQuotaLifecycleTransition). The four legacy transition branches are
// behavior-frozen by the existing suite and this file already exceeded 250
// pure LOC before the relay change (313).
import { remainingOf } from "@octg/shared";
import type {
  FinalizeResult,
  MarkReserveOutcomeUnknownResult,
  MarkUncertainResult,
  ReconcileDisposition,
  ReconcileRequestView,
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
import type { QuotaEnvLike, QuotaIdentity, QuotaStorage } from "./store";
import { terminalizeGrantOnReconcile } from "./relay-grant";

export interface QuotaLifecycleContext {
  readonly storage: DurableObjectStorage;
  readonly env: QuotaEnvLike;
  readonly quotaId: string | undefined;
  identityOf(): QuotaIdentity;
}

/** Runtime inputs of one transaction-scoped lifecycle mutation. */
export interface QuotaLifecycleRuntime {
  readonly env: QuotaEnvLike;
  readonly quotaId: string | undefined;
  identityOf(): QuotaIdentity;
}

export type QuotaLifecycleTransition =
  | { readonly kind: "settle"; readonly actualTokens: number }
  | { readonly kind: "markUncertain" }
  | { readonly kind: "release" }
  | { readonly kind: "reconcile"; readonly disposition: ReconcileDisposition };

export type QuotaLifecycleTransitionResult =
  | SettleResult
  | MarkUncertainResult
  | ReleaseResult
  | ReconcileResult;

/**
 * The only terminal quota lifecycle mutation seam. It loads the request entry,
 * pool and unresolved counters, validates the legal source state, applies the
 * named mutation, and writes every affected record — including terminalizing a
 * matching relay grant on reconciliation. It consumes an already open
 * transaction-scoped storage handle and never opens a nested transaction.
 */
export function applyQuotaLifecycleTransition(
  runtime: QuotaLifecycleRuntime,
  storage: QuotaStorage,
  requestId: string,
  transition: { readonly kind: "settle"; readonly actualTokens: number },
): Promise<SettleResult>;
export function applyQuotaLifecycleTransition(
  runtime: QuotaLifecycleRuntime,
  storage: QuotaStorage,
  requestId: string,
  transition: { readonly kind: "markUncertain" },
): Promise<MarkUncertainResult>;
export function applyQuotaLifecycleTransition(
  runtime: QuotaLifecycleRuntime,
  storage: QuotaStorage,
  requestId: string,
  transition: { readonly kind: "release" },
): Promise<ReleaseResult>;
export function applyQuotaLifecycleTransition(
  runtime: QuotaLifecycleRuntime,
  storage: QuotaStorage,
  requestId: string,
  transition: { readonly kind: "reconcile"; readonly disposition: ReconcileDisposition },
): Promise<ReconcileResult>;
export async function applyQuotaLifecycleTransition(
  runtime: QuotaLifecycleRuntime,
  storage: QuotaStorage,
  requestId: string,
  transition: QuotaLifecycleTransition,
): Promise<QuotaLifecycleTransitionResult> {
  const entry = await getEntry(storage, requestId);
  switch (transition.kind) {
    case "settle": {
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
      const { pool, utcDay } = runtime.identityOf();
      const poolState = await loadPool(storage, runtime.env, { pool, utcDay });
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
        confirmedTokens: stateAfterRelease.confirmedTokens + transition.actualTokens,
      };
      const unresolvedState = await loadUnresolved(storage);
      const result: SettleResult = { ok: true };
      const nextEntry: RequestEntry = {
        ...entry,
        state: "settled",
        actualTokens: transition.actualTokens,
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
          quotaId: runtime.quotaId,
          confirmedTokens: nextState.confirmedTokens,
          reservedTokens: nextState.reservedTokens,
          uncertainTokens: nextState.uncertainTokens,
          limit: nextState.limit,
        });
      }
      return result;
    }
    case "markUncertain": {
      if (!entry) return { ok: false, reason: "unknown_request" };
      const priorResult = entry.results.markUncertain;
      if (priorResult) return priorResult;
      if (entry.state !== "reserved") {
        console.warn("quota mark uncertain conflict", {
          quotaId: runtime.quotaId,
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
      const { pool, utcDay } = runtime.identityOf();
      const poolState = await loadPool(storage, runtime.env, { pool, utcDay });
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
        uncertaintyOrigin: entry.uncertaintyOrigin ?? "upstream_uncertain",
        results: { ...entry.results, markUncertain: result },
      };
      await savePool(storage, nextState);
      await putEntry(storage, requestId, nextEntry);
      await saveUnresolved(storage, {
        uncertainCount: unresolved.uncertainCount + 1,
        reservedCount: Math.max(0, unresolved.reservedCount - 1),
      });
      return result;
    }
    case "release": {
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
      const { pool, utcDay } = runtime.identityOf();
      const poolState = await loadPool(storage, runtime.env, { pool, utcDay });
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
    }
    case "reconcile": {
      if (!entry) return { ok: true, applied: false };
      const priorResult = entry.results.reconcile;
      if (priorResult) {
        if (entry.requestedDisposition !== transition.disposition) {
          console.warn("quota reconcile disposition conflict", {
            quotaId: runtime.quotaId,
            requestId,
            requestedDisposition: entry.requestedDisposition,
            disposition: transition.disposition,
          });
        }
        return priorResult;
      }
      if (entry.state !== "reserved" && entry.state !== "uncertain") {
        return { ok: true, applied: false };
      }
      const { pool, utcDay } = runtime.identityOf();
      const poolState = await loadPool(storage, runtime.env, { pool, utcDay });
      const stateAfterUnresolved = entry.state === "reserved"
        ? {
            ...poolState,
            reservedTokens: Math.max(0, poolState.reservedTokens - entry.reservedTokens),
          }
        : {
            ...poolState,
            uncertainTokens: Math.max(0, poolState.uncertainTokens - entry.reservedTokens),
          };
      const unresolved = await loadUnresolved(storage);
      const nextState =
        transition.disposition === "consumed"
          ? {
              ...stateAfterUnresolved,
              confirmedTokens: stateAfterUnresolved.confirmedTokens + entry.reservedTokens,
            }
          : stateAfterUnresolved;
      const nextRequestState: RequestEntry["state"] =
        transition.disposition === "consumed" ? "reconciled" : "released";
      const result: ReconcileResult = { ok: true, applied: true };
      const nextEntry: RequestEntry = {
        ...entry,
        state: nextRequestState,
        requestedDisposition: transition.disposition,
        results: { ...entry.results, reconcile: result },
      };
      await savePool(storage, nextState);
      await putEntry(storage, requestId, nextEntry);
      await saveUnresolved(storage, {
        uncertainCount: Math.max(0, unresolved.uncertainCount - (entry.state === "uncertain" ? 1 : 0)),
        reservedCount: Math.max(0, unresolved.reservedCount - (entry.state === "reserved" ? 1 : 0)),
      });
      await terminalizeGrantOnReconcile(storage, requestId, transition.disposition);
      return result;
    }
  }
}

export class QuotaLifecycle {
  constructor(private readonly context: QuotaLifecycleContext) {}

  async getReconcileSnapshot(): Promise<ReconcileSnapshot> {
    const entries = await this.context.storage.list<RequestEntry>({ prefix: ENTRY_PREFIX });
    return {
      requests: [...entries.entries()]
        .filter((pair): pair is [string, RequestEntry & { state: "reserved" | "uncertain" }] =>
          pair[1].state === "reserved" || pair[1].state === "uncertain")
        .map(([requestId, entry]) => ({
          requestId: String(requestId).slice(ENTRY_PREFIX.length),
          reservedTokens: entry.reservedTokens,
          state: entry.state,
          uncertaintyOrigin: entry.uncertaintyOrigin,
        })),
    };
  }

  async getReconcileRequest(requestId: string): Promise<ReconcileRequestView | undefined> {
    const entry = await getEntry(this.context.storage, requestId);
    if (!entry) return undefined;
    return {
      requestId,
      reservedTokens: entry.reservedTokens,
      state: entry.state,
      requestedDisposition: entry.requestedDisposition,
      uncertaintyOrigin: entry.uncertaintyOrigin,
    };
  }

  async settle(requestId: string, actualTokens: number): Promise<SettleResult> {
    return this.context.storage.transaction(async (storage) =>
      applyQuotaLifecycleTransition(this.context, storage, requestId, {
        kind: "settle",
        actualTokens,
      }),
    );
  }

  async markUncertain(requestId: string): Promise<MarkUncertainResult> {
    return this.context.storage.transaction(async (storage) =>
      applyQuotaLifecycleTransition(this.context, storage, requestId, { kind: "markUncertain" }),
    );
  }

  async markReserveOutcomeUnknown(requestId: string): Promise<MarkReserveOutcomeUnknownResult> {
    return this.context.storage.transaction(async (storage) => {
      const entry = await getEntry(storage, requestId);
      if (!entry) return { ok: false, reason: "unknown_request" };

      const priorResult = entry.results.markReserveOutcomeUnknown;
      if (priorResult) return priorResult;

      if (entry.state !== "reserved") {
        const result: MarkReserveOutcomeUnknownResult = { ok: true, applied: false };
        await putEntry(storage, requestId, {
          ...entry,
          results: { ...entry.results, markReserveOutcomeUnknown: result },
        });
        return result;
      }

      const { pool, utcDay } = this.context.identityOf();
      const poolState = await loadPool(storage, this.context.env, { pool, utcDay });
      const unresolved = await loadUnresolved(storage);
      const result: MarkReserveOutcomeUnknownResult = { ok: true, applied: true };
      const nextEntry: RequestEntry = {
        ...entry,
        state: "uncertain",
        uncertaintyOrigin: "reserve_unknown",
        results: { ...entry.results, markReserveOutcomeUnknown: result },
      };

      await savePool(storage, {
        ...poolState,
        reservedTokens: Math.max(0, poolState.reservedTokens - entry.reservedTokens),
        uncertainTokens: poolState.uncertainTokens + entry.reservedTokens,
      });
      await putEntry(storage, requestId, nextEntry);
      await saveUnresolved(storage, {
        uncertainCount: unresolved.uncertainCount + 1,
        reservedCount: Math.max(0, unresolved.reservedCount - 1),
      });
      return result;
    });
  }

  async release(requestId: string): Promise<ReleaseResult> {
    return this.context.storage.transaction(async (storage) =>
      applyQuotaLifecycleTransition(this.context, storage, requestId, { kind: "release" }),
    );
  }

  async reconcileRequest(
    requestId: string,
    disposition: ReconcileDisposition,
  ): Promise<ReconcileResult> {
    return this.context.storage.transaction(async (storage) =>
      applyQuotaLifecycleTransition(this.context, storage, requestId, {
        kind: "reconcile",
        disposition,
      }),
    );
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
