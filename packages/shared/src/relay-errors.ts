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
