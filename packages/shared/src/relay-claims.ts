/**
 * Strict validators for the signed relay context and grant credential claims
 * (SPEC.md section 19.2).
 *
 * Shape-level contract only: identifier formats, claim sets, and structural
 * lifetimes. Clock-bound checks (issuedAt <= now, expiry > now) belong to the
 * Cloudflare-side verify functions; Deno never verifies these claims.
 */

import {
  RELAY_CONTEXT_AUDIENCE,
  RELAY_GRANT_AUDIENCE,
  RELAY_GRANT_CREDENTIAL_TTL_MS,
  RELAY_KEY_HASH_PATTERN,
  RELAY_MAX_CONTEXT_LIFETIME_MS,
  RELAY_NONCE_PATTERN,
  RELAY_REQUEST_ID_PATTERN,
  RELAY_UTC_DAY_PATTERN,
  RELAY_UUID_PATTERN,
} from "./relay.ts";
import type { RelayContextV1, RelayGrantCredentialV1 } from "./relay.ts";
import {
  hasExactKeys,
  isBoundedUtf8,
  isRecord,
  isSafeNonNegativeInteger,
} from "./relay-json.ts";

const RELAY_CONTEXT_CLAIM_KEYS = [
  "version",
  "audience",
  "environment",
  "route",
  "requestId",
  "clientId",
  "idempotencyKeyHash",
  "nonce",
  "issuedAtMs",
  "expiresAtMs",
] as const;

const RELAY_GRANT_CLAIM_KEYS = [
  "version",
  "audience",
  "environment",
  "route",
  "requestId",
  "grantId",
  "nonce",
  "clientId",
  "idempotencyKeyHash",
  "model",
  "pool",
  "admissionUtcDay",
  "leaseGeneration",
  "issuedAtMs",
  "expiresAtMs",
] as const;

function isIdempotencyKeyHash(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === "string" && RELAY_KEY_HASH_PATTERN.test(value);
}

function isRelayEnvironment(value: unknown): value is "preview" | "production" {
  return value === "preview" || value === "production";
}

function isBoundedNonEmptyUtf8(value: unknown, maxBytes: number): value is string {
  return isBoundedUtf8(value, maxBytes) && value.length > 0;
}

export function parseRelayContext(value: unknown): RelayContextV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, RELAY_CONTEXT_CLAIM_KEYS)) return undefined;
  if (value.version !== 1) return undefined;
  if (value.audience !== RELAY_CONTEXT_AUDIENCE || value.route !== "responses") return undefined;
  if (!isRelayEnvironment(value.environment)) return undefined;
  if (typeof value.requestId !== "string" || !RELAY_REQUEST_ID_PATTERN.test(value.requestId)) {
    return undefined;
  }
  if (!isBoundedNonEmptyUtf8(value.clientId, 128)) return undefined;
  if (!isIdempotencyKeyHash(value.idempotencyKeyHash)) return undefined;
  if (typeof value.nonce !== "string" || !RELAY_NONCE_PATTERN.test(value.nonce)) return undefined;
  if (!isSafeNonNegativeInteger(value.issuedAtMs)) return undefined;
  if (!isSafeNonNegativeInteger(value.expiresAtMs)) return undefined;
  const lifetimeMs: number = value.expiresAtMs - value.issuedAtMs;
  if (lifetimeMs <= 0 || lifetimeMs > RELAY_MAX_CONTEXT_LIFETIME_MS) return undefined;
  return {
    version: 1,
    audience: RELAY_CONTEXT_AUDIENCE,
    environment: value.environment,
    route: "responses",
    requestId: value.requestId,
    clientId: value.clientId,
    idempotencyKeyHash: value.idempotencyKeyHash,
    nonce: value.nonce,
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
  };
}

export function parseRelayGrantCredential(value: unknown): RelayGrantCredentialV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, RELAY_GRANT_CLAIM_KEYS)) return undefined;
  if (value.version !== 1) return undefined;
  if (value.audience !== RELAY_GRANT_AUDIENCE || value.route !== "responses") return undefined;
  if (!isRelayEnvironment(value.environment)) return undefined;
  if (typeof value.requestId !== "string" || !RELAY_REQUEST_ID_PATTERN.test(value.requestId)) {
    return undefined;
  }
  if (typeof value.grantId !== "string" || !RELAY_UUID_PATTERN.test(value.grantId)) return undefined;
  if (typeof value.nonce !== "string" || !RELAY_NONCE_PATTERN.test(value.nonce)) return undefined;
  if (!isBoundedNonEmptyUtf8(value.clientId, 128)) return undefined;
  if (!isIdempotencyKeyHash(value.idempotencyKeyHash)) return undefined;
  if (!isBoundedNonEmptyUtf8(value.model, 256)) return undefined;
  if (value.pool !== "STANDARD" && value.pool !== "MINI") return undefined;
  if (typeof value.admissionUtcDay !== "string" || !RELAY_UTC_DAY_PATTERN.test(value.admissionUtcDay)) {
    return undefined;
  }
  if (typeof value.leaseGeneration !== "string" || !RELAY_UUID_PATTERN.test(value.leaseGeneration)) {
    return undefined;
  }
  if (!isSafeNonNegativeInteger(value.issuedAtMs)) return undefined;
  if (!isSafeNonNegativeInteger(value.expiresAtMs)) return undefined;
  if (value.expiresAtMs - value.issuedAtMs !== RELAY_GRANT_CREDENTIAL_TTL_MS) return undefined;
  return {
    version: 1,
    audience: RELAY_GRANT_AUDIENCE,
    environment: value.environment,
    route: "responses",
    requestId: value.requestId,
    grantId: value.grantId,
    nonce: value.nonce,
    clientId: value.clientId,
    idempotencyKeyHash: value.idempotencyKeyHash,
    model: value.model,
    pool: value.pool,
    admissionUtcDay: value.admissionUtcDay,
    leaseGeneration: value.leaseGeneration,
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
  };
}
