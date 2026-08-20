import { toPoolLower } from "./pool";
import type { PoolName } from "./types";

export interface QuotaSnapshot {
  pool: PoolName;
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
}

export interface OctgHttpError {
  status: number;
  body: {
    error: {
      message: string;
      type: string;
      param: string | null;
      code: string;
      pool?: string;
      remaining_tokens?: number;
      reset_at?: string;
    };
    request_id: string;
  };
  requestId: string;
  quota?: QuotaSnapshot;
  route?: string;
}

function makeError(
  status: number,
  requestId: string,
  message: string,
  type: string,
  param: string | null,
  code: string,
  options: { quota?: QuotaSnapshot; route?: string } = {},
): OctgHttpError {
  const pool = options.quota ? toPoolLower(options.quota.pool) : undefined;
  return {
    status,
    requestId,
    ...options,
    body: {
      error: {
        message,
        type,
        param,
        code,
        ...(options.quota
          ? { pool, remaining_tokens: options.quota.remaining, reset_at: options.quota.resetAt }
          : {}),
      },
      request_id: requestId,
    },
  };
}

export function errQuotaExceeded(quota: QuotaSnapshot, requestId: string): OctgHttpError {
  const pool = toPoolLower(quota.pool);
  return makeError(
    429,
    requestId,
    `Complimentary quota exceeded for pool '${pool}'.`,
    "complimentary_quota_exceeded",
    null,
    "insufficient_quota",
    {
      quota,
      route: "reject:complimentary_quota",
    },
  );
}

export function errRequestTooLarge(quota: QuotaSnapshot, requestId: string): OctgHttpError {
  return makeError(
    413,
    requestId,
    `Request exceeds the complimentary quota limit for pool '${toPoolLower(quota.pool)}'.`,
    "invalid_request_error",
    null,
    "request_too_large",
    { quota, route: "reject:request_too_large" },
  );
}

export function errInputTooLarge(requestId: string): OctgHttpError {
  return makeError(
    413,
    requestId,
    "Request exceeds the configured input size limit.",
    "invalid_request_error",
    null,
    "request_too_large",
    { route: "reject:request_too_large" },
  );
}

export function errWorkerConcurrencyExceeded(quota: QuotaSnapshot, requestId: string): OctgHttpError {
  return makeError(
    429,
    requestId,
    "Worker concurrency limit reached for this quota pool.",
    "rate_limit_error",
    null,
    "worker_concurrency_exceeded",
    { quota, route: "reject:worker_concurrency" },
  );
}

export function errModelNotAllowed(requestId: string, quota?: QuotaSnapshot): OctgHttpError {
  return makeError(
    403,
    requestId,
    "The requested model is not allowed for this client.",
    "invalid_request_error",
    "model",
    "model_not_allowed",
    quota ? { quota, route: "reject:model_not_allowed" } : {},
  );
}

export function errModelRequiresPaid(requestId: string): OctgHttpError {
  return makeError(
    403,
    requestId,
    "The requested model requires paid mode, which is not enabled.",
    "invalid_request_error",
    "model",
    "model_requires_paid",
  );
}

export function errNonTextInput(requestId: string): OctgHttpError {
  return makeError(400, requestId, "Non-text input is not supported in the MVP.", "invalid_request_error", "input", "invalid_request");
}

export function errMaxTokensConflict(requestId: string): OctgHttpError {
  return makeError(400, requestId, "max_tokens and max_completion_tokens must match when both are provided.", "invalid_request_error", "max_tokens", "invalid_request");
}

export function errInvalidRequest(requestId: string, message = "Invalid request body."): OctgHttpError {
  return makeError(400, requestId, message, "invalid_request_error", null, "invalid_request");
}

export function errInvalidApiKey(requestId: string): OctgHttpError {
  return makeError(401, requestId, "Invalid API key provided.", "authentication_error", null, "invalid_api_key");
}

export function errClientDisabled(requestId: string): OctgHttpError {
  return makeError(403, requestId, "This client is disabled.", "permission_error", null, "client_disabled");
}

export function errInternal(
  requestId: string,
  options: { quota?: QuotaSnapshot; route?: "error:internal_error" } = {},
): OctgHttpError {
  return makeError(
    500,
    requestId,
    "An internal error occurred.",
    "api_error",
    null,
    "internal_error",
    options,
  );
}

export function buildOctgHeaders(args: {
  requestId: string;
  quota?: QuotaSnapshot;
  route?: string;
}): Record<string, string> {
  const headers: Record<string, string> = { "X-OCTG-Request-Id": args.requestId };
  if (args.route) headers["X-OCTG-Route"] = args.route;
  if (args.quota && args.route) {
    headers["X-OCTG-Pool"] = toPoolLower(args.quota.pool);
    headers["X-OCTG-Quota-Limit"] = String(args.quota.limit);
    headers["X-OCTG-Quota-Used"] = String(args.quota.used);
    headers["X-OCTG-Quota-Remaining"] = String(args.quota.remaining);
    headers["X-OCTG-Quota-Reset"] = args.quota.resetAt;
  }
  return headers;
}

export function errorResponse(err: OctgHttpError): Response {
  return new Response(JSON.stringify({ ...err.body, request_id: err.requestId }), {
    status: err.status,
    headers: {
      "content-type": "application/json",
      ...buildOctgHeaders({ requestId: err.requestId, quota: err.quota, route: err.route }),
    },
  });
}
