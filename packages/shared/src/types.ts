export type PoolName = "STANDARD" | "MINI";
export type PoolNameLower = "standard" | "mini";
export type RequestState = "reserved" | "settled" | "uncertain" | "reconciled" | "released";
export type UncertaintyOrigin = "upstream_uncertain" | "reserve_unknown";

export interface PoolState {
  utcDay: string;
  limit: number;
  confirmedTokens: number;
  reservedTokens: number;
  uncertainTokens: number;
  requestCount: number;
  updatedAt: string;
}

export interface RequestEntry {
  idempotencyKey?: string;
  state: RequestState;
  tokens: number;
  upperBoundTokens: number;
  reservedTokens: number;
  requestedDisposition?: ReconcileDisposition;
  uncertaintyOrigin?: UncertaintyOrigin;
  actualTokens?: number;
  results: RequestRpcResults;
  createdAt: string;
  updatedAt: string;
}

export type ReserveResult =
  | { readonly ok: true; readonly remaining: number; readonly resetAt: string }
  | {
      readonly ok: false;
      readonly reason: "insufficient_quota";
      readonly remaining: number;
      readonly resetAt: string;
    }
  | {
      readonly ok: false;
      readonly reason: "duplicate_idempotency_key";
      readonly requestId: string;
      readonly resetAt: string;
    };

export type SettleResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unknown_request" };
export type MarkUncertainResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unknown_request" };
export type MarkReserveOutcomeUnknownResult =
  | { readonly ok: true; readonly applied: boolean }
  | { readonly ok: false; readonly reason: "unknown_request" };
export type ReleaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unknown_request" };
export interface InFlightLease {
  readonly requestId: string;
  readonly generation: string;
  readonly expiresAtMs: number;
}
export type AcquireInFlightResult =
  | { readonly ok: true; readonly lease: InFlightLease }
  | { readonly ok: false; readonly reason: "worker_concurrency_exceeded" };
export type RenewInFlightResult =
  | { readonly ok: true; readonly lease: InFlightLease }
  | { readonly ok: false; readonly reason: "lease_not_found" | "stale_generation" };
export type ReleaseInFlightResult = { readonly ok: true; readonly released: boolean };
export const DEFAULT_IN_FLIGHT_LEASE_TTL_MS = 120_000;
export const DEFAULT_IN_FLIGHT_LEASE_RENEWAL_MS = 30_000;

export type ReconcileDisposition = "consumed" | "unused";
export type ReconcileResult = { readonly ok: true; readonly applied: boolean };
export interface UncertainRequest {
  readonly requestId: string;
  readonly reservedTokens: number;
  readonly state: "reserved" | "uncertain";
  readonly uncertaintyOrigin?: UncertaintyOrigin;
}
export interface ReconcileSnapshot {
  readonly requests: readonly UncertainRequest[];
}

export interface RequestRpcResults {
  reserve?: ReserveResult;
  settle?: SettleResult;
  markUncertain?: MarkUncertainResult;
  markReserveOutcomeUnknown?: MarkReserveOutcomeUnknownResult;
  release?: ReleaseResult;
  reconcile?: ReconcileResult;
}

export type FinalizeResult =
  | { readonly ok: true; readonly deleted: true }
  | {
      readonly ok: false;
      readonly reason: "uncertain_remaining" | "reserved_remaining";
      readonly uncertainCount: number;
      readonly reservedCount: number;
    };

export interface QuotaView extends PoolState {
  readonly pool: PoolName;
  readonly remaining: number;
}
