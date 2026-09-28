/**
 * Worker-side Deno relay ingress client and public response mapping for
 * `POST /v1/responses` (SPEC.md section 19; design "Public Responses relay
 * selection order").
 *
 * The Worker signs the bounded ingress context, forwards the original client
 * body exactly once as a raw stream, and maps the Deno ingress response to the
 * existing public OCTG contract. It never parses the request body, usage, or
 * upstream payloads, and never touches QuotaController: relay quota state is
 * owned by the Deno-side grant lifecycle, so an ingress failure here releases
 * nothing.
 *
 * allow: SIZE_OK — one cohesive ingress flow (context signing → exact-once
 * forwarding → public response mapping); the task contract fixes this file as
 * the only new source file, so it cannot be split without violating the
 * assigned file list.
 */

import {
  buildOctgHeaders,
  errClientDisabled,
  errInputTooLarge,
  errInternal,
  errInvalidRequest,
  errModelNotAllowed,
  errModelRequiresPaid,
  parseRelayInternalError,
  parseRelayResponseMeta,
  RELAY_CONTEXT_AUDIENCE,
  RELAY_MAX_CONTEXT_LIFETIME_MS,
  RELAY_MAX_RESPONSE_META_HEADER_BYTES,
  RELAY_MAX_RESPONSE_META_JSON_BYTES,
  relayErrorCodeStatus,
} from "@octg/shared";
import type { OctgHttpError, RelayContextV1, RelayEnvironment, RelayErrorCode, RelayInternalErrorV1, RelayResponseMetaV1 } from "@octg/shared";
import type { EnabledRelayConfig } from "./relay-auth";

const RESPONSE_META_HEADER = "X-OCTG-Relay-Response-Meta";
const CONTEXT_HEADER = "X-OCTG-Relay-Context";
const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
/** Design: relay error-envelope bodies are at most 8,192 bytes; anything
 *  longer cannot be an internal envelope and is passed through unchanged. */
const INGRESS_ERROR_ENVELOPE_MAX_BYTES = 8_192;
const NONCE_BYTES = 32;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Signs one bounded ingress context (SPEC.md section 19.2). */
export async function buildRelayIngressContext(args: {
  readonly environment: RelayEnvironment;
  readonly requestId: string;
  readonly clientId: string;
  readonly idempotencyKeyHash: string | null;
}): Promise<RelayContextV1> {
  const issuedAtMs = Date.now();
  return {
    version: 1,
    audience: RELAY_CONTEXT_AUDIENCE,
    environment: args.environment,
    route: "responses",
    requestId: args.requestId,
    clientId: args.clientId,
    idempotencyKeyHash: args.idempotencyKeyHash,
    nonce: encodeBase64UrlNoPadding(crypto.getRandomValues(new Uint8Array(NONCE_BYTES))),
    issuedAtMs,
    expiresAtMs: issuedAtMs + RELAY_MAX_CONTEXT_LIFETIME_MS,
  };
}

/**
 * Lowercase hex SHA-256(clientId || NUL || exact raw key); null when the key
 * is absent. The same binding rule RelayDecisionController re-computes.
 */
export async function relayIdempotencyKeyHash(
  clientId: string,
  rawKey: string | undefined,
): Promise<string | null> {
  if (rawKey === undefined) return null;
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
 * Forwards the original client request to the Deno ingress exactly once:
 * the same body stream instance, the exact bearer/context/content-type
 * headers, and the exact Idempotency-Key when one is effectively present.
 * No other client header is forwarded.
 */
export async function callDenoRelay(
  request: Request,
  contextToken: string,
  config: EnabledRelayConfig,
): Promise<Response> {
  const headers: Record<string, string> = {
    "authorization": `Bearer ${config.ingressAuthToken}`,
    "content-type": "application/json",
    [CONTEXT_HEADER]: contextToken,
  };
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (idempotencyKey !== null && idempotencyKey.length > 0) {
    headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey;
  }
  return fetch(config.ingressEndpoint, {
    method: "POST",
    headers,
    body: request.body,
  });
}

/**
 * Maps the Deno ingress response to the public OCTG response. A 2xx response
 * is validated against `RelayResponseMetaV1` (request identity, internal
 * route, pool/quota numeric invariants) before any public header is built
 * with route `free_shared`; a non-2xx response is either a bounded internal
 * error envelope (mapped through the SPEC.md public table) or the existing
 * upstream passthrough contract.
 */
export async function relayPublicResponse(
  relayed: Response,
  requestId: string,
  versionHeaders: Record<string, string>,
): Promise<Response> {
  if (relayed.status >= 200 && relayed.status < 300) {
    const meta = decodeResponseMeta(relayed.headers.get(RESPONSE_META_HEADER));
    if (meta === undefined || !isPublicMetaValid(meta, requestId)) {
      await relayed.body?.cancel().catch(() => undefined);
      return publicErrorResponse(errInternal(requestId), versionHeaders);
    }
    return new Response(relayed.body, {
      status: relayed.status,
      headers: {
        "content-type": relayed.headers.get("content-type") ?? "application/json",
        ...buildOctgHeaders({
          requestId,
          quota: {
            pool: meta.pool,
            limit: meta.limit,
            used: meta.used,
            remaining: meta.remaining,
            resetAt: meta.resetAt,
          },
          route: "free_shared",
        }),
        ...versionHeaders,
      },
    });
  }
  return await relayFailureResponse(relayed, requestId, versionHeaders);
}

function encodeBase64UrlNoPadding(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeResponseMeta(headerValue: string | null): RelayResponseMetaV1 | undefined {
  if (headerValue === null || headerValue.length === 0) return undefined;
  if (headerValue.length > RELAY_MAX_RESPONSE_META_HEADER_BYTES) return undefined;
  let json: string;
  try {
    const padded = headerValue.padEnd(headerValue.length + ((4 - (headerValue.length % 4)) % 4), "=");
    const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength > RELAY_MAX_RESPONSE_META_JSON_BYTES) return undefined;
    json = FATAL_UTF8_DECODER.decode(bytes);
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  return parseRelayResponseMeta(parsed);
}

/** Pool counters satisfy used = limit - remaining with no negative part. */
function isPublicMetaValid(meta: RelayResponseMetaV1, requestId: string): boolean {
  if (meta.requestId !== requestId) return false;
  if (meta.limit < 0 || meta.used < 0 || meta.remaining < 0) return false;
  return meta.used + meta.remaining === meta.limit;
}

async function relayFailureResponse(
  relayed: Response,
  requestId: string,
  versionHeaders: Record<string, string>,
): Promise<Response> {
  const reader = relayed.body?.getReader() ?? null;
  const prefix: Uint8Array[] = [];
  let bytes = 0;
  while (reader !== null && bytes <= INGRESS_ERROR_ENVELOPE_MAX_BYTES) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      await reader.cancel().catch(() => undefined);
      return publicErrorResponse(errInternal(requestId), versionHeaders);
    }
    if (chunk.done) {
      const envelope = parseBoundedEnvelope(prefix);
      if (envelope !== undefined) {
        if (relayErrorCodeStatus(envelope.error.code) !== relayed.status) {
          return publicErrorResponse(errInternal(requestId), versionHeaders);
        }
        return publicErrorResponse(relayRejectError(envelope.error.code, requestId), versionHeaders);
      }
      return passthroughResponse(prefix, null, relayed, requestId, versionHeaders);
    }
    prefix.push(chunk.value);
    bytes += chunk.value.byteLength;
  }
  return passthroughResponse(prefix, reader, relayed, requestId, versionHeaders);
}

function parseBoundedEnvelope(chunks: readonly Uint8Array[]): RelayInternalErrorV1 | undefined {
  let length = 0;
  for (const chunk of chunks) length += chunk.byteLength;
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(FATAL_UTF8_DECODER.decode(merged));
  } catch {
    return undefined;
  }
  return parseRelayInternalError(parsed);
}

function passthroughResponse(
  prefix: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array> | null,
  relayed: Response,
  requestId: string,
  versionHeaders: Record<string, string>,
): Response {
  const pending = [...prefix];
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = pending.shift();
      if (next !== undefined) {
        controller.enqueue(next);
        return;
      }
      if (reader === null) {
        controller.close();
        return;
      }
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error instanceof Error ? error : new Error("Relay upstream body failed."));
      }
    },
    cancel() {
      void reader?.cancel().catch(() => undefined);
    },
  });
  return new Response(body, {
    status: relayed.status,
    headers: {
      "content-type": relayed.headers.get("content-type") ?? "application/json",
      "X-OCTG-Request-Id": requestId,
      ...versionHeaders,
    },
  });
}

/** SPEC.md 19.6 public mapping; unmapped codes fail closed at 500. */
const RELAY_REJECT_ERRORS: Partial<Record<RelayErrorCode, (requestId: string) => OctgHttpError>> = {
  invalid_request: errInvalidRequest,
  client_disabled: errClientDisabled,
  model_requires_paid: errModelRequiresPaid,
  model_not_allowed: errModelNotAllowed,
  request_too_large: errInputTooLarge,
};

function makeRelayError(
  status: number,
  requestId: string,
  message: string,
  type: string,
  route: string,
  code: RelayErrorCode,
): OctgHttpError {
  return {
    status,
    requestId,
    route,
    body: { error: { message, type, param: null, code }, request_id: requestId },
  };
}

function relayRejectError(code: RelayErrorCode, requestId: string): OctgHttpError {
  const mapped = RELAY_REJECT_ERRORS[code];
  if (mapped !== undefined) return mapped(requestId);
  switch (code) {
    case "duplicate_idempotency_key":
      return makeRelayError(409, requestId, "Duplicate Idempotency-Key.", "invalid_request_error", "reject:duplicate_idempotency_key", code);
    case "insufficient_quota":
      return makeRelayError(429, requestId, "Complimentary quota exceeded.", "complimentary_quota_exceeded", "reject:complimentary_quota", code);
    case "worker_concurrency_exceeded":
      return makeRelayError(429, requestId, "Worker concurrency limit reached for this quota pool.", "rate_limit_error", "reject:worker_concurrency", code);
    default:
      return errInternal(requestId);
  }
}

function publicErrorResponse(err: OctgHttpError, versionHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify({ ...err.body, request_id: err.requestId }), {
    status: err.status,
    headers: {
      "content-type": "application/json",
      ...buildOctgHeaders({ requestId: err.requestId, quota: err.quota, route: err.route }),
      ...versionHeaders,
    },
  });
}
