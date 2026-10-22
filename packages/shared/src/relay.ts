/**
 * Bounded v1 wire contract for the free-worker Responses relay through Deno.
 *
 * Types, exact limits, the stable error union, and the Cloudflare-internal
 * RelayDecisionController RPC contract (SPEC.md section 19). Strict parsers
 * live in relay-json.ts, relay-parse.ts, and relay-claims.ts.
 */

import type { PoolName } from "./types.ts";
import type { ActivationDenialCode, RelayErrorCode, RelayGrantState } from "./relay-errors.ts";

export {
  isActivationDenialCode,
  isRelayErrorCode,
  isRelayGrantState,
  relayErrorCodeStatus,
} from "./relay-errors.ts";
export type { ActivationDenialCode, RelayErrorCode } from "./relay-errors.ts";

export type {
  RelayCpuGateControllerOperations,
  RelayCpuGateDecisionContextV1,
  RelayCpuGateFenceResult,
  RelayCpuGateGrantInspection,
  RelayCpuGateGrantState,
  RelayCpuGateOperationAbsentV1,
  RelayCpuGateOperationIncompatibleV1,
  RelayCpuGateOperationInspectionV1,
  RelayCpuGateOperationPendingV1,
  RelayCpuGateOperationRequestV1,
  RelayCpuGateSetupFenceRequestV1,
  RelayCpuGateSetupFenceResponseV1,
  RelayCpuGateSetupCompensatedV1,
  RelayCpuGateSetupRejectionV1,
  RelayCpuGateReconcileUnusedResponseV1,
  RelayCpuGateSetupRequestV1,
  RelayCpuGateSetupResponseV1,
  RelayCpuGateSlotClaimResult,
  RelayCpuGateSlotCloseResult,
  RelayCpuGateSlotOperations,
  RelayCpuGateSlotOwner,
  RelayCpuGateSlotState,
  RelayCpuGateSnapshot,
  RelayGrantLifecycleAction,
  RelayGrantLifecycleControllerOperations,
  RelayGrantLifecycleDispatchInput,
  RelayGrantLifecycleDispatchResult,
} from "./relay-control.ts";

export type RelayEnvironment = "preview" | "production";

export type { RelayGrantState } from "./relay-errors.ts";

export type RelayTerminalOutcome = "settle" | "uncertain" | "release";

/** Signed ingress context claims; carries no model, pool, or quota day. */
export interface RelayContextV1 {
  readonly version: 1;
  readonly audience: "octg-deno-relay";
  readonly environment: RelayEnvironment;
  readonly route: "responses";
  readonly requestId: string;
  readonly clientId: string;
  readonly idempotencyKeyHash: string | null;
  readonly nonce: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

/** Signed grant claims; minted only after durable authorization. */
export interface RelayGrantCredentialV1 {
  readonly version: 1;
  readonly audience: "octg-worker-relay";
  readonly environment: RelayEnvironment;
  readonly route: "responses";
  readonly requestId: string;
  readonly grantId: string;
  readonly nonce: string;
  readonly clientId: string;
  readonly idempotencyKeyHash: string | null;
  readonly model: string;
  readonly pool: PoolName;
  readonly admissionUtcDay: string;
  readonly leaseGeneration: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface RelayRequestMetaV1 {
  readonly model: string;
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
  readonly inputBytes: number;
  readonly rawBodyBytes: number;
  readonly isToolUse: boolean;
  readonly stream: boolean;
}

export interface RelayQuotaSnapshotV1 {
  readonly pool: PoolName;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly resetAt: string;
}

export interface RelayDecisionRequestV1 {
  readonly version: 1;
  readonly metadata: RelayRequestMetaV1;
}

export type RelayDecisionV1 =
  | {
      readonly version: 1;
      readonly kind: "reject";
      readonly code: RelayErrorCode;
      readonly status: number;
    }
  | {
      readonly version: 1;
      readonly kind: "allow";
      readonly grantId: string;
      readonly leaseGeneration: string;
      readonly maxOutputTokens: number;
      readonly cacheEnabled: boolean;
      readonly quota: RelayQuotaSnapshotV1;
    };

export interface RelayActivationV1 {
  readonly version: 1;
  readonly grantId: string;
  readonly leaseGeneration: string;
}

export interface RelayActivationResponseV1 {
  readonly version: 1;
  readonly activated: boolean;
  readonly code: ActivationDenialCode | null;
}

export interface RelayRenewalV1 {
  readonly version: 1;
  readonly grantId: string;
  readonly leaseGeneration: string;
}

export interface RelayRenewalResponseV1 {
  readonly version: 1;
  readonly renewed: boolean;
  readonly code: RelayErrorCode | null;
}

export interface RelayTerminalV1 {
  readonly version: 1;
  readonly grantId: string;
  readonly leaseGeneration: string;
  readonly outcome: RelayTerminalOutcome;
  readonly totalTokens: number | null;
}

export interface RelayTerminalResponseV1 {
  readonly version: 1;
  readonly accepted: boolean;
  readonly state: RelayGrantState | null;
  readonly code: RelayErrorCode | null;
}

/** Carries no credentials, secrets, request content, or upstream credential. */
export interface RelayResponseMetaV1 {
  readonly version: 1;
  readonly requestId: string;
  readonly pool: PoolName;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly resetAt: string;
  readonly route: "responses";
}

export interface RelayInternalErrorV1 {
  readonly version: 1;
  readonly error: { readonly code: RelayErrorCode };
}

/** Cloudflare-internal Worker -> RelayDecisionController RPC contract. */
export interface RelayDecisionDispatchInput {
  readonly decisionBody: Uint8Array;
  readonly contextToken: string;
  readonly rawIdempotencyKey?: string;
}

export type RelayDecisionDispatchResult =
  | {
      readonly kind: "allow";
      readonly decision: Extract<RelayDecisionV1, { readonly kind: "allow" }>;
      readonly grantCredential: string;
    }
  | {
      readonly kind: "reject";
      readonly decision: Extract<RelayDecisionV1, { readonly kind: "reject" }>;
    }
  | {
      readonly kind: "protocol_error";
      readonly code: "invalid_request" | "invalid_context" | "environment_mismatch";
    }
  | { readonly kind: "internal_error"; readonly code: "internal_error" };

export interface RelayDecisionControllerOperations {
  decide(input: RelayDecisionDispatchInput): Promise<RelayDecisionDispatchResult>;
}

/** Malformed relay input at the parse boundary; carries no parser detail. */
export class RelayProtocolError extends Error {
  readonly code = "invalid_request";

  constructor() {
    super("invalid_request");
    this.name = "RelayProtocolError";
  }
}

export const RELAY_CONTEXT_AUDIENCE = "octg-deno-relay";
export const RELAY_GRANT_AUDIENCE = "octg-worker-relay";
export const RELAY_MAX_INGRESS_BODY_BYTES = 1_048_576;
export const RELAY_MAX_CALLBACK_BODY_BYTES = 8_192;
export const RELAY_MAX_CONTEXT_HEADER_BYTES = 4_096;
export const RELAY_MAX_RESPONSE_META_JSON_BYTES = 2_048;
export const RELAY_MAX_RESPONSE_META_HEADER_BYTES = 2_800;
export const RELAY_MAX_AUTHORIZATION_HEADER_BYTES = 263;
export const RELAY_MAX_CONTEXT_LIFETIME_MS = 60_000;
export const RELAY_GRANT_CREDENTIAL_TTL_MS = 3_900_000;

export const RELAY_REQUEST_ID_PATTERN = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
export const RELAY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RELAY_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const RELAY_KEY_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const RELAY_UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const RELAY_RESET_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
