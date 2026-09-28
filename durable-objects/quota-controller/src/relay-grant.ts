import {
  DEFAULT_IN_FLIGHT_LEASE_TTL_MS,
  RELAY_GRANT_CREDENTIAL_TTL_MS,
  constantTimeHexEqual,
  nextUtcMidnight,
} from "@octg/shared";
import type {
  ActivationDenialCode,
  PoolName,
  ReconcileDisposition,
  RelayContextV1,
  RelayEnvironment,
  RelayErrorCode,
  RelayGrantCredentialV1,
  RelayGrantState,
  RelayRequestMetaV1,
  RelayTerminalV1,
  RequestEntry,
} from "@octg/shared";
import { releaseInFlightLease } from "./store";
import type { QuotaIdentity, QuotaStorage } from "./store";

/**
 * Durable relay grant state owned by QuotaController (SPEC.md section 19.5).
 * This module owns the grant record: shape, storage key, immutable binding
 * validation, and the reconciliation terminalization hook. Transaction-scoped
 * grant operations live in relay-admission.ts and relay-grant-lifecycle.ts,
 * which are the only modules allowed to mutate records.
 */

export const RELAY_GRANT_PREFIX = "relay-grant:";
export const RELAY_GRANT_AUTHORIZATION_TTL_MS = 3_600_000;
export const RELAY_GRANT_RETENTION_DAYS = 45;

const RELAY_GRANT_RETENTION_MS = RELAY_GRANT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Immutable admission facts replayed against exact same-request retries. */
export interface RelayGrantAdmission {
  readonly contextIssuedAtMs: number;
  readonly contextExpiresAtMs: number;
  readonly metadata: RelayRequestMetaV1;
  readonly reservedTokens: number;
  readonly upperBoundTokens: number;
  readonly maxOutputTokens: number;
  readonly cacheEnabled: boolean;
}

export interface RelayGrant {
  readonly version: 1;
  readonly requestId: string;
  readonly grantId: string;
  readonly leaseGeneration: string;
  readonly environment: RelayEnvironment;
  readonly clientId: string;
  readonly idempotencyKeyHash: string | null;
  readonly nonce: string;
  readonly model: string;
  readonly pool: PoolName;
  readonly admissionUtcDay: string;
  readonly state: RelayGrantState;
  readonly issuedAtMs: number;
  readonly authorizationExpiresAtMs: number;
  readonly credentialExpiresAtMs: number;
  readonly retentionDeadlineMs: number;
  readonly admission: RelayGrantAdmission;
  readonly terminalReport: RelayTerminalV1 | null;
  readonly terminalFingerprint: string | null;
}

export type RelayGrantBinding = {
  readonly requestId: string;
  readonly grantId: string;
  readonly leaseGeneration: string;
  readonly claims: RelayGrantCredentialV1;
};

export type ActivateRelayResult =
  | { readonly kind: "activated"; readonly grant: RelayGrant }
  | { readonly kind: "denied"; readonly code: ActivationDenialCode };

export type RenewRelayResult =
  | { readonly kind: "renewed"; readonly grant: RelayGrant; readonly leaseExpiresAtMs: number }
  | { readonly kind: "denied"; readonly code: RelayErrorCode };

export type FinishRelayInput = RelayGrantBinding & {
  readonly report: RelayTerminalV1;
  readonly reportFingerprint: string;
};

export type FinishRelayResult =
  | { readonly kind: "accepted"; readonly grant: RelayGrant; readonly quota: RequestEntry }
  | { readonly kind: "denied"; readonly code: RelayErrorCode };

const TERMINAL_GRANT_STATES: ReadonlySet<RelayGrantState> = new Set([
  "settled",
  "released",
  "reconciled_consumed",
  "reconciled_unused",
] as const);

export function isTerminalGrantState(state: RelayGrantState): boolean {
  return TERMINAL_GRANT_STATES.has(state);
}

export function relayGrantRetentionDeadlineMs(utcDay: string): number {
  const dayEndMs = Date.parse(nextUtcMidnight(new Date(`${utcDay}T00:00:00Z`)));
  return dayEndMs + RELAY_GRANT_RETENTION_MS;
}

export async function getRelayGrant(
  storage: QuotaStorage,
  requestId: string,
): Promise<RelayGrant | undefined> {
  return storage.get<RelayGrant>(`${RELAY_GRANT_PREFIX}${requestId}`);
}

export async function putRelayGrant(storage: QuotaStorage, grant: RelayGrant): Promise<void> {
  await storage.put(`${RELAY_GRANT_PREFIX}${grant.requestId}`, grant);
}

/**
 * Validates every immutable credential claim against the stored grant and the
 * owning QuotaController identity. Any disagreement means the credential does
 * not belong to this grant.
 */
export function grantBindingMismatch(
  grant: RelayGrant,
  binding: RelayGrantBinding,
  identity: QuotaIdentity,
): boolean {
  if (binding.requestId !== grant.requestId) return true;
  if (binding.grantId !== grant.grantId) return true;
  if (binding.leaseGeneration !== grant.leaseGeneration) return true;
  const claims = binding.claims;
  if (claims.requestId !== grant.requestId) return true;
  if (claims.grantId !== grant.grantId) return true;
  if (claims.leaseGeneration !== grant.leaseGeneration) return true;
  if (claims.environment !== grant.environment) return true;
  if (claims.clientId !== grant.clientId) return true;
  if (claims.idempotencyKeyHash !== grant.idempotencyKeyHash) return true;
  if (claims.nonce !== grant.nonce) return true;
  if (claims.model !== grant.model) return true;
  if (claims.pool !== grant.pool) return true;
  if (claims.admissionUtcDay !== grant.admissionUtcDay) return true;
  if (claims.issuedAtMs !== grant.issuedAtMs) return true;
  if (claims.expiresAtMs !== grant.credentialExpiresAtMs) return true;
  if (grant.pool !== identity.pool || grant.admissionUtcDay !== identity.utcDay) return true;
  return false;
}

/** Whether a replayed admission matches the facts recorded on the grant. */
export function matchesRelayAdmission(
  grant: RelayGrant,
  context: RelayContextV1,
  metadata: RelayRequestMetaV1,
  budget: Pick<RelayGrantAdmission, "reservedTokens" | "upperBoundTokens" | "maxOutputTokens" | "cacheEnabled">,
): boolean {
  const admission = grant.admission;
  return (
    grant.clientId === context.clientId &&
    grant.idempotencyKeyHash === context.idempotencyKeyHash &&
    grant.nonce === context.nonce &&
    admission.contextIssuedAtMs === context.issuedAtMs &&
    admission.contextExpiresAtMs === context.expiresAtMs &&
    admission.metadata.model === metadata.model &&
    admission.metadata.estimatedInputTokens === metadata.estimatedInputTokens &&
    admission.metadata.maxOutputTokens === metadata.maxOutputTokens &&
    admission.metadata.inputBytes === metadata.inputBytes &&
    admission.metadata.rawBodyBytes === metadata.rawBodyBytes &&
    admission.metadata.isToolUse === metadata.isToolUse &&
    admission.metadata.stream === metadata.stream &&
    admission.reservedTokens === budget.reservedTokens &&
    admission.upperBoundTokens === budget.upperBoundTokens &&
    admission.maxOutputTokens === budget.maxOutputTokens &&
    admission.cacheEnabled === budget.cacheEnabled
  );
}

/** Fixed relay lease expiry from the transaction time; shared by admission and renewal. */
export function relayLeaseExpiry(nowMs: number): number {
  const expiresAt = nowMs + DEFAULT_IN_FLIGHT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new TypeError("Relay lease expiry must be a safe integer.");
  }
  return expiresAt;
}

/** SHA-256(clientId || NUL || rawKey) as lowercase hex, per the signed hash rule. */
async function idempotencyKeyHashOf(clientId: string, rawKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(clientId);
  const key = encoder.encode(rawKey);
  const bytes = new Uint8Array(prefix.length + 1 + key.length);
  bytes.set(prefix, 0);
  bytes[prefix.length] = 0;
  bytes.set(key, prefix.length + 1);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Validates the exact optional raw key against the signed context hash:
 * presence must agree, and a present key must hash to the signed value.
 */
export async function isKeyBindingConsistent(
  context: RelayContextV1,
  rawIdempotencyKey: string | undefined,
): Promise<boolean> {
  if (context.idempotencyKeyHash === null) return rawIdempotencyKey === undefined;
  if (rawIdempotencyKey === undefined) return false;
  return constantTimeHexEqual(await idempotencyKeyHashOf(context.clientId, rawIdempotencyKey), context.idempotencyKeyHash);
}
/** Reconciliation terminalizes any live relay grant; runs inside the reconcile transaction. */
export async function terminalizeGrantOnReconcile(
  storage: QuotaStorage,
  requestId: string,
  disposition: ReconcileDisposition,
): Promise<void> {
  const grant = await getRelayGrant(storage, requestId);
  if (!grant || isTerminalGrantState(grant.state)) return;
  await releaseInFlightLease(storage, { requestId, generation: grant.leaseGeneration });
  await putRelayGrant(storage, {
    ...grant,
    state: disposition === "consumed" ? "reconciled_consumed" : "reconciled_unused",
    terminalReport: null,
    terminalFingerprint: disposition,
  });
}
