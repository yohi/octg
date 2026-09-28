/**
 * Bounded v1 wire contract for the free-worker Responses relay through Deno.
 *
 * Types, exact limits, the stable error union, and the Cloudflare-internal
 * RelayDecisionController RPC contract (SPEC.md section 19). Strict parsers
 * live in relay-json.ts, relay-parse.ts, and relay-claims.ts.
 */

import type { PoolName } from "./types.ts";

export type RelayEnvironment = "preview" | "production";

/** Single source of truth for the stable v1 error code union. */
const RELAY_ERROR_CODES = [
  "invalid_request",
  "invalid_context",
  "unauthorized_service",
  "environment_mismatch",
  "client_disabled",
  "model_requires_paid",
  "model_not_allowed",
  "request_too_large",
  "insufficient_quota",
  "worker_concurrency_exceeded",
  "duplicate_idempotency_key",
  "grant_not_found",
  "grant_expired",
  "grant_replayed",
  "grant_terminalized",
  "lease_lost",
  "upstream_error",
  "upstream_timeout",
  "upstream_invalid_response",
  "internal_error",
] as const;

export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];

const ACTIVATION_DENIAL_CODES = [
  "environment_mismatch",
  "grant_not_found",
  "grant_expired",
  "grant_replayed",
  "grant_terminalized",
  "lease_lost",
] as const;

export type ActivationDenialCode = (typeof ACTIVATION_DENIAL_CODES)[number];

const RELAY_GRANT_STATES = [
  "authorized",
  "attempted",
  "settled",
  "released",
  "uncertain",
  "reconciled_consumed",
  "reconciled_unused",
] as const;

export type RelayGrantState = (typeof RELAY_GRANT_STATES)[number];

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

const RELAY_ERROR_CODE_SET: ReadonlySet<string> = new Set(RELAY_ERROR_CODES);

const ACTIVATION_DENIAL_CODE_SET: ReadonlySet<string> = new Set(ACTIVATION_DENIAL_CODES);

const RELAY_GRANT_STATE_SET: ReadonlySet<string> = new Set(RELAY_GRANT_STATES);

export function isRelayErrorCode(value: unknown): value is RelayErrorCode {
  return typeof value === "string" && RELAY_ERROR_CODE_SET.has(value);
}

export function isActivationDenialCode(value: unknown): value is ActivationDenialCode {
  return typeof value === "string" && ACTIVATION_DENIAL_CODE_SET.has(value);
}

export function isRelayGrantState(value: unknown): value is RelayGrantState {
  return typeof value === "string" && RELAY_GRANT_STATE_SET.has(value);
}

/** Public OCTG status for a relay error code; unmapped codes fail closed at 500. */
const RELAY_ERROR_CODE_STATUS: Partial<Record<RelayErrorCode, number>> = {
  invalid_request: 400,
  client_disabled: 403,
  model_requires_paid: 403,
  model_not_allowed: 403,
  duplicate_idempotency_key: 409,
  request_too_large: 413,
  insufficient_quota: 429,
  worker_concurrency_exceeded: 429,
};

export function relayErrorCodeStatus(code: RelayErrorCode): number {
  return RELAY_ERROR_CODE_STATUS[code] ?? 500;
}
