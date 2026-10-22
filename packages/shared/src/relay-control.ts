import type {
  RelayActivationResponseV1,
  RelayRenewalResponseV1,
  RelayTerminalResponseV1,
} from "./relay.ts";
import type { PoolName, RequestState } from "./types.ts";
import type { RelayErrorCode } from "./relay-errors.ts";

export type RelayGrantLifecycleAction = "activation" | "renewal" | "terminal";

export interface RelayGrantLifecycleDispatchInput {
  readonly action: RelayGrantLifecycleAction;
  readonly grantToken: string;
  readonly callbackBody: Uint8Array;
}

export type RelayGrantLifecycleDispatchResult =
  | { readonly kind: "activation"; readonly response: RelayActivationResponseV1 }
  | { readonly kind: "renewal"; readonly response: RelayRenewalResponseV1 }
  | { readonly kind: "terminal"; readonly response: RelayTerminalResponseV1 }
  | { readonly kind: "protocol_error"; readonly code: "invalid_context" | "invalid_request" }
  | { readonly kind: "internal_error"; readonly code: "internal_error" };

export interface RelayGrantLifecycleControllerOperations {
  dispatch(input: RelayGrantLifecycleDispatchInput): Promise<RelayGrantLifecycleDispatchResult>;
}

export interface RelayCpuGateSetupRequestV1 {
  readonly version: 1;
  readonly pool: PoolName;
  readonly requestId: string;
}

export interface RelayCpuGateSetupResponseV1 {
  readonly version: 1;
  readonly requestId: string;
  readonly grantToken: string;
  readonly grantId: string;
  readonly leaseGeneration: string;
  readonly pool: PoolName;
  readonly admissionUtcDay: string;
}

export interface RelayCpuGateSetupCompensatedV1 {
  readonly version: 1;
  readonly kind: "setup_failed_compensated";
}

export interface RelayCpuGateSetupRejectionV1 {
  readonly version: 1;
  readonly error: RelayErrorCode;
}

export interface RelayCpuGateReconcileUnusedResponseV1 {
  readonly version: 1;
  readonly kind: "reconciled_unused";
}

export interface RelayCpuGateDecisionContextV1 {
  readonly version: 1;
  readonly requestId: string;
  readonly contextToken: string;
}

export interface RelayCpuGateOperationRequestV1 {
  readonly version: 1;
  readonly pool: PoolName;
  readonly requestId: string;
}

export type RelayCpuGateSetupFenceRequestV1 = RelayCpuGateOperationRequestV1;

export interface RelayCpuGateOperationAbsentV1 {
  readonly version: 1;
  readonly kind: "absent";
}

export interface RelayCpuGateOperationPendingV1 {
  readonly version: 1;
  readonly kind: "pending_ambiguous";
}

export interface RelayCpuGateOperationIncompatibleV1 {
  readonly version: 1;
  readonly error: "setup_state_incompatible";
}

export interface RelayCpuGateOperationInspectionV1 {
  readonly version: 1;
  readonly kind: "fixture";
  readonly inspection: Extract<RelayCpuGateGrantInspection, { readonly kind: "fixture" }>;
}

export interface RelayCpuGateSetupFenceResponseV1 {
  readonly version: 1;
  readonly requestId: string;
  readonly kind: "fenced" | "fixture" | "non_fixture";
  readonly inspection?:
    | Extract<RelayCpuGateGrantInspection, { readonly kind: "fixture" }>
    | Extract<RelayCpuGateGrantInspection, { readonly kind: "non_fixture" }>;
}

export type RelayCpuGateFenceResult =
  | { readonly kind: "fenced" }
  | {
      readonly kind: "fixture";
      readonly inspection: Extract<RelayCpuGateGrantInspection, { readonly kind: "fixture" }>;
    }
  | {
      readonly kind: "non_fixture";
      readonly inspection: Extract<RelayCpuGateGrantInspection, { readonly kind: "non_fixture" }>;
    };

export interface RelayCpuGateControllerOperations {
  getRelayCpuGateSnapshot(): Promise<RelayCpuGateSnapshot>;
  getRelayCpuGateGrantInspection(requestId: string): Promise<RelayCpuGateGrantInspection>;
  fenceRelayCpuGateSetup(requestId: string): Promise<RelayCpuGateFenceResult>;
}

export interface RelayCpuGateSlotOwner {
  readonly pool: PoolName;
  readonly requestId: string;
}

export type RelayCpuGateSlotState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "held" | "closing";
      readonly owner: RelayCpuGateSlotOwner;
      readonly generation: number;
    };

export type RelayCpuGateSlotClaimResult =
  | {
      readonly kind: "claimed";
      readonly slot: Exclude<RelayCpuGateSlotState, { readonly kind: "idle" }>;
    }
  | { readonly kind: "busy" };

export type RelayCpuGateSlotCloseResult = { readonly kind: "closed" } | { readonly kind: "blocked" };

export interface RelayCpuGateSlotOperations {
  getRelayCpuGateSlot(): Promise<RelayCpuGateSlotState>;
  claimRelayCpuGateSlot(owner: RelayCpuGateSlotOwner): Promise<RelayCpuGateSlotClaimResult>;
  closeRelayCpuGateSlot(
    owner: RelayCpuGateSlotOwner,
    generation: number,
  ): Promise<RelayCpuGateSlotCloseResult>;
}

export interface RelayCpuGateSnapshot {
  readonly version: 1;
  readonly pool: PoolName;
  readonly utcDay: string;
  readonly limit: number;
  readonly remaining: number;
  readonly confirmedTokens: number;
  readonly reservedTokens: number;
  readonly uncertainTokens: number;
  readonly requestCount: number;
  readonly unresolvedReservedCount: number;
  readonly unresolvedUncertainCount: number;
  readonly activeLeaseCount: number;
  readonly maxInFlight: number;
}

export type RelayCpuGateGrantState =
  | "authorized"
  | "attempted"
  | "uncertain"
  | "settled"
  | "released"
  | "reconciled_consumed"
  | "reconciled_unused";

export type RelayCpuGateGrantInspection =
  | { readonly kind: "absent"; readonly cpuGateFixture: false; readonly fenced: boolean }
  | { readonly kind: "non_fixture"; readonly cpuGateFixture: false }
  | {
      readonly kind: "fixture";
      readonly state: RelayCpuGateGrantState;
      readonly requestState: RequestState;
      readonly reservedTokens: number;
      readonly upperBoundTokens: number;
      readonly maxOutputTokens: number;
      readonly actualTokens: number | null;
      readonly activeLease: boolean;
      readonly cpuGateFixture: true;
    };
