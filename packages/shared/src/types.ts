export type PoolName = "STANDARD" | "MINI";
export type PoolNameLower = "standard" | "mini";
export type RequestState = "reserved" | "settled" | "uncertain" | "reconciled" | "released";

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
  state: RequestState;
  tokens: number;
  upperBoundTokens: number;
  reservedTokens: number;
  requestedDisposition?: ReconcileDisposition;
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
    };

export type SettleResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unknown_request" };
export type MarkUncertainResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unknown_request" };
export type ReleaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unknown_request" };

export type ReconcileDisposition = "consumed" | "unused";
export type ReconcileResult = { readonly ok: true; readonly applied: boolean };
export interface UncertainRequest {
  readonly requestId: string;
  readonly reservedTokens: number;
}
export interface ReconcileSnapshot {
  readonly requests: readonly UncertainRequest[];
}

export interface RequestRpcResults {
  reserve?: ReserveResult;
  settle?: SettleResult;
  markUncertain?: MarkUncertainResult;
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
