/**
 * Strict validators for the v1 relay body envelopes (SPEC.md section 19.3).
 *
 * Every parser accepts an already-decoded JSON value and returns the typed
 * envelope, or undefined when the value does not match the contract exactly:
 * unknown fields, missing fields, invalid ranges, and over-limit UTF-8
 * lengths are all rejected.
 */

import {
  RELAY_MAX_INGRESS_BODY_BYTES,
  RELAY_REQUEST_ID_PATTERN,
  RELAY_RESET_AT_PATTERN,
  RELAY_UUID_PATTERN,
  isActivationDenialCode,
  isRelayErrorCode,
  isRelayGrantState,
  relayErrorCodeStatus,
} from "./relay.ts";
import type {
  RelayActivationResponseV1,
  RelayActivationV1,
  RelayDecisionRequestV1,
  RelayDecisionV1,
  RelayInternalErrorV1,
  RelayRenewalResponseV1,
  RelayRenewalV1,
  RelayRequestMetaV1,
  RelayQuotaSnapshotV1,
  RelayResponseMetaV1,
  RelayTerminalResponseV1,
  RelayTerminalV1,
} from "./relay.ts";
import {
  hasExactKeys,
  isBoundedUtf8,
  isRecord,
  isSafeInteger,
  isSafeNonNegativeInteger,
} from "./relay-json.ts";

const RELAY_REQUEST_META_KEYS = [
  "model",
  "estimatedInputTokens",
  "maxOutputTokens",
  "inputBytes",
  "rawBodyBytes",
  "isToolUse",
  "stream",
] as const;

const RELAY_GRANT_REFERENCE_KEYS = ["version", "grantId", "leaseGeneration"] as const;

const RELAY_TERMINAL_KEYS = [
  "version",
  "grantId",
  "leaseGeneration",
  "outcome",
  "totalTokens",
] as const;

const RELAY_RESPONSE_META_KEYS = [
  "version",
  "requestId",
  "pool",
  "limit",
  "used",
  "remaining",
  "resetAt",
  "route",
] as const;

function isGrantId(value: unknown): value is string {
  return typeof value === "string" && RELAY_UUID_PATTERN.test(value);
}

function parseGrantReferenceEnvelope(
  value: unknown,
  keys: readonly string[],
): { readonly version: 1; readonly grantId: string; readonly leaseGeneration: string } | undefined {
  if (!isRecord(value) || !hasExactKeys(value, keys)) return undefined;
  if (value.version !== 1) return undefined;
  if (!isGrantId(value.grantId) || !isGrantId(value.leaseGeneration)) return undefined;
  return { version: 1, grantId: value.grantId, leaseGeneration: value.leaseGeneration };
}

export function parseRelayRequestMeta(value: unknown): RelayRequestMetaV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, RELAY_REQUEST_META_KEYS)) return undefined;
  if (!isBoundedUtf8(value.model, 256) || value.model.length === 0) return undefined;
  if (!isSafeNonNegativeInteger(value.estimatedInputTokens)) return undefined;
  if (!isSafeNonNegativeInteger(value.maxOutputTokens)) return undefined;
  if (!isSafeNonNegativeInteger(value.inputBytes) || value.inputBytes > RELAY_MAX_INGRESS_BODY_BYTES) {
    return undefined;
  }
  if (!isSafeNonNegativeInteger(value.rawBodyBytes) || value.rawBodyBytes > RELAY_MAX_INGRESS_BODY_BYTES) {
    return undefined;
  }
  if (typeof value.isToolUse !== "boolean" || typeof value.stream !== "boolean") return undefined;
  return {
    model: value.model,
    estimatedInputTokens: value.estimatedInputTokens,
    maxOutputTokens: value.maxOutputTokens,
    inputBytes: value.inputBytes,
    rawBodyBytes: value.rawBodyBytes,
    isToolUse: value.isToolUse,
    stream: value.stream,
  };
}

export function parseRelayQuotaSnapshot(value: unknown): RelayQuotaSnapshotV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["pool", "limit", "used", "remaining", "resetAt"])) {
    return undefined;
  }
  if (value.pool !== "STANDARD" && value.pool !== "MINI") return undefined;
  if (!isSafeNonNegativeInteger(value.limit)) return undefined;
  if (!isSafeNonNegativeInteger(value.used)) return undefined;
  if (!isSafeNonNegativeInteger(value.remaining)) return undefined;
  if (typeof value.resetAt !== "string" || !RELAY_RESET_AT_PATTERN.test(value.resetAt)) return undefined;
  return {
    pool: value.pool,
    limit: value.limit,
    used: value.used,
    remaining: value.remaining,
    resetAt: value.resetAt,
  };
}

export function parseRelayDecisionRequest(value: unknown): RelayDecisionRequestV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "metadata"])) return undefined;
  if (value.version !== 1) return undefined;
  const metadata = parseRelayRequestMeta(value.metadata);
  if (metadata === undefined) return undefined;
  return { version: 1, metadata };
}

export function parseRelayDecision(value: unknown): RelayDecisionV1 | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (value.kind === "reject") {
    if (!hasExactKeys(value, ["version", "kind", "code", "status"])) return undefined;
    if (!isRelayErrorCode(value.code)) return undefined;
    const status: unknown = value.status;
    if (typeof status !== "number" || status !== relayErrorCodeStatus(value.code)) return undefined;
    return { version: 1, kind: "reject", code: value.code, status };
  }
  if (value.kind === "allow") {
    if (
      !hasExactKeys(value, [
        "version",
        "kind",
        "grantId",
        "leaseGeneration",
        "maxOutputTokens",
        "cacheEnabled",
        "quota",
      ])
    ) {
      return undefined;
    }
    if (!isGrantId(value.grantId) || !isGrantId(value.leaseGeneration)) return undefined;
    if (!isSafeNonNegativeInteger(value.maxOutputTokens)) return undefined;
    if (typeof value.cacheEnabled !== "boolean") return undefined;
    const quota = parseRelayQuotaSnapshot(value.quota);
    if (quota === undefined) return undefined;
    return {
      version: 1,
      kind: "allow",
      grantId: value.grantId,
      leaseGeneration: value.leaseGeneration,
      maxOutputTokens: value.maxOutputTokens,
      cacheEnabled: value.cacheEnabled,
      quota,
    };
  }
  return undefined;
}

export function parseRelayActivation(value: unknown): RelayActivationV1 | undefined {
  return parseGrantReferenceEnvelope(value, RELAY_GRANT_REFERENCE_KEYS);
}

export function parseRelayRenewal(value: unknown): RelayRenewalV1 | undefined {
  return parseGrantReferenceEnvelope(value, RELAY_GRANT_REFERENCE_KEYS);
}

export function parseRelayActivationResponse(value: unknown): RelayActivationResponseV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "activated", "code"])) return undefined;
  if (value.version !== 1 || typeof value.activated !== "boolean") return undefined;
  if (value.activated) {
    if (value.code !== null) return undefined;
    return { version: 1, activated: true, code: null };
  }
  if (!isActivationDenialCode(value.code)) return undefined;
  return { version: 1, activated: false, code: value.code };
}

export function parseRelayRenewalResponse(value: unknown): RelayRenewalResponseV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "renewed", "code"])) return undefined;
  if (value.version !== 1 || typeof value.renewed !== "boolean") return undefined;
  if (value.code === null) return { version: 1, renewed: value.renewed, code: null };
  if (!isRelayErrorCode(value.code)) return undefined;
  return { version: 1, renewed: value.renewed, code: value.code };
}

export function parseRelayTerminal(value: unknown): RelayTerminalV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, RELAY_TERMINAL_KEYS)) return undefined;
  if (value.version !== 1) return undefined;
  if (!isGrantId(value.grantId) || !isGrantId(value.leaseGeneration)) return undefined;
  if (
    value.outcome !== "settle" && value.outcome !== "uncertain" && value.outcome !== "release"
  ) {
    return undefined;
  }
  if (value.outcome === "settle") {
    if (!isSafeNonNegativeInteger(value.totalTokens)) return undefined;
    return {
      version: 1,
      grantId: value.grantId,
      leaseGeneration: value.leaseGeneration,
      outcome: "settle",
      totalTokens: value.totalTokens,
    };
  }
  if (value.totalTokens !== null) return undefined;
  return {
    version: 1,
    grantId: value.grantId,
    leaseGeneration: value.leaseGeneration,
    outcome: value.outcome,
    totalTokens: null,
  };
}

export function parseRelayTerminalResponse(value: unknown): RelayTerminalResponseV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "accepted", "state", "code"])) {
    return undefined;
  }
  if (value.version !== 1 || typeof value.accepted !== "boolean") return undefined;
  if (!isRelayGrantState(value.state)) return undefined;
  if (value.code === null) return { version: 1, accepted: value.accepted, state: value.state, code: null };
  if (!isRelayErrorCode(value.code)) return undefined;
  return { version: 1, accepted: value.accepted, state: value.state, code: value.code };
}

export function parseRelayResponseMeta(value: unknown): RelayResponseMetaV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, RELAY_RESPONSE_META_KEYS)) return undefined;
  if (value.version !== 1 || value.route !== "responses") return undefined;
  if (typeof value.requestId !== "string" || !RELAY_REQUEST_ID_PATTERN.test(value.requestId)) {
    return undefined;
  }
  if (value.pool !== "STANDARD" && value.pool !== "MINI") return undefined;
  if (!isSafeInteger(value.limit) || !isSafeInteger(value.used) || !isSafeInteger(value.remaining)) {
    return undefined;
  }
  if (typeof value.resetAt !== "string" || !RELAY_RESET_AT_PATTERN.test(value.resetAt)) return undefined;
  return {
    version: 1,
    requestId: value.requestId,
    pool: value.pool,
    limit: value.limit,
    used: value.used,
    remaining: value.remaining,
    resetAt: value.resetAt,
    route: "responses",
  };
}

export function parseRelayInternalError(value: unknown): RelayInternalErrorV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "error"])) return undefined;
  if (value.version !== 1) return undefined;
  const error: unknown = value.error;
  if (!isRecord(error) || !hasExactKeys(error, ["code"])) return undefined;
  if (!isRelayErrorCode(error.code)) return undefined;
  return { version: 1, error: { code: error.code } };
}
