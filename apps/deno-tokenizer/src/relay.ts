/**
 * Deno relay ingress for `POST /relay/v1/responses`.
 *
 * Deno holds only the Gateway B credential and callback bearer secrets. It
 * never verifies or mints context/grant tokens (no HMAC key capability), never
 * selects a Decision or Quota DO, and forwards the opaque context unchanged to
 * the decision callback. Activation is single-shot; every ambiguous
 * post-activation outcome is terminal `uncertain`. See the normative relay
 * contract in docs/superpowers/specs/2026-09-23-free-worker-deno-relay-design.md.
 *
 * allow: SIZE_OK — one cohesive ingress flow (validate → decide → activate →
 * forward); the task contract fixes relay.ts as the only new source file, so
 * it cannot be split further without violating the assigned file list.
 */

import {
  isRecord,
  RELAY_MAX_CALLBACK_BODY_BYTES,
  RELAY_MAX_INGRESS_BODY_BYTES,
  RELAY_MAX_RESPONSE_META_HEADER_BYTES,
  RELAY_MAX_RESPONSE_META_JSON_BYTES,
  estimatedInputTokensOf,
  normalizeResponses,
  normalizeResponsesUpstreamBody,
  parseIdempotencyKey,
  parseRelayActivationResponse,
  parseRelayContext,
  parseRelayDecision,
  parseRelayJsonBody,
  parseRelayRenewalResponse,
  toPoolLower,
} from "@octg/shared";
import type {
  ActivationDenialCode,
  RelayContextV1,
  RelayDecisionV1,
  RelayErrorCode,
  RelayInternalErrorV1,
  RelayRequestMetaV1,
  RelayResponseMetaV1,
  RelayTerminalOutcome,
  RelayTerminalV1,
} from "@octg/shared";
import type { RelayServiceConfig } from "./config.ts";
import type { ExactEncoder } from "./encoder.ts";
import {
  acceptsPreparePayload,
  base64urlEncode,
  isAuthorized,
  parseContentType,
  readBoundedRawBody,
} from "./http.ts";
import {
  relayUpstreamResponse,
  RelayUpstreamDeliveryError,
  type RelayGrantSession,
} from "./relay-usage.ts";

export const RELAY_INGRESS_ROUTE = "/relay/v1/responses";

const contextHeader = "x-octg-relay-context";
const grantHeader = "x-octg-relay-grant";
const responseMetaHeader = "x-octg-relay-response-meta";
const decisionCallbackPath = "/internal/relay/v1/decision";
const activationCallbackPath = "/internal/relay/v1/activation";
const renewalCallbackPath = "/internal/relay/v1/renewal";
const terminalCallbackPath = "/internal/relay/v1/terminal";
const upstreamResponsesPath = "/responses";
const callbackTimeoutMs = 10_000;
const jsonContentType = "application/json";
const maxContextHeaderBytes = 4_096;
const maxGrantCredentialBytes = 4_096;
const compactTokenSegmentPattern = /^[A-Za-z0-9_-]+$/;
const upstreamRequestTimeoutMs = "25000"; // Gateway B single-attempt timeout; the 1 h lease cap is enforced by the DO grant TTL.
const textEncoder = new TextEncoder();

export interface RelayHandlerArgs {
  readonly config: RelayServiceConfig;
  readonly encoder: ExactEncoder;
  readonly fetchImpl: typeof fetch;
}

type AllowedDecision = Extract<RelayDecisionV1, { readonly kind: "allow" }>;

/** Grant reference plus the opaque credential used on activation/terminal callbacks. */
interface ActiveGrant {
  readonly grantId: string;
  readonly leaseGeneration: string;
  readonly credential: string;
}

/** Deno-local activation result; unknown covers every ambiguous outcome. */
type ActivationOutcome =
  | { readonly kind: "activated" }
  | { readonly kind: "denied"; readonly code: ActivationDenialCode }
  | { readonly kind: "unknown" };

/** Post-activation terminal callback outcome union. */
type TerminalCallbackOutcome = Extract<RelayTerminalOutcome, "release" | "uncertain">;

function relayErrorResponse(status: number, code: RelayErrorCode): Response {
  const body: RelayInternalErrorV1 = { version: 1, error: { code } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": jsonContentType },
  });
}

function methodNotAllowedResponse(): Response {
  const body: RelayInternalErrorV1 = { version: 1, error: { code: "invalid_request" } };
  return new Response(JSON.stringify(body), {
    status: 405,
    headers: { "content-type": jsonContentType, "allow": "POST" },
  });
}

/** Transport-only context check: size, two segments, base64url-no-padding shape. */
function transportValidContextToken(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (textEncoder.encode(value).byteLength > maxContextHeaderBytes) return undefined;
  const segments = value.split(".");
  if (segments.length !== 2) return undefined;
  if (!segments.every((segment) => compactTokenSegmentPattern.test(segment))) return undefined;
  return value;
}

function isBoundedGrantCredential(value: string): boolean {
  return value.length > 0 && textEncoder.encode(value).byteLength <= maxGrantCredentialBytes;
}

/**
 * Decodes context claims as non-authoritative relay/upstream metadata. Called
 * only after an allow decision; performs no HMAC verification.
 */
function decodeContextClaims(token: string): RelayContextV1 | undefined {
  const payloadSegment = token.split(".")[0];
  if (payloadSegment === undefined) return undefined;
  const padded = payloadSegment.padEnd(
    payloadSegment.length + ((4 - (payloadSegment.length % 4)) % 4),
    "=",
  );
  let json: string;
  try {
    const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
    json = new TextDecoder("utf-8", { fatal: true })
      .decode(Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0));
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  return parseRelayContext(parsed);
}

/**
 * Reads a bounded callback JSON body. Any oversize, transport, UTF-8, or JSON
 * failure yields undefined; callers treat it as a malformed internal response.
 */
async function readBoundedCallbackJson(response: Response): Promise<unknown> {
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > RELAY_MAX_CALLBACK_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return parseRelayJsonBody(bytes, RELAY_MAX_CALLBACK_BODY_BYTES);
  } catch {
    return undefined;
  }
}

function callbackHeaders(
  config: RelayServiceConfig,
  credentialName: string,
  credentialValue: string,
): Record<string, string> {
  return {
    "authorization": `Bearer ${config.serviceAuthToken}`,
    "content-type": jsonContentType,
    [credentialName]: credentialValue,
  };
}

/** Single activation attempt; never retried. Any ambiguity is `unknown`. */
async function activateOnce(args: RelayHandlerArgs, grant: ActiveGrant): Promise<ActivationOutcome> {
  let response: Response;
  try {
    response = await args.fetchImpl(`${args.config.callbackOrigin}${activationCallbackPath}`, {
      method: "POST",
      headers: callbackHeaders(args.config, grantHeader, grant.credential),
      body: JSON.stringify({
        version: 1,
        grantId: grant.grantId,
        leaseGeneration: grant.leaseGeneration,
      }),
      signal: callbackSignal(args),
    });
  } catch {
    return { kind: "unknown" };
  }
  if (response.status !== 200) return { kind: "unknown" };
  const value = await readBoundedCallbackJson(response);
  const parsed = value === undefined ? undefined : parseRelayActivationResponse(value);
  if (parsed === undefined) return { kind: "unknown" };
  if (parsed.activated && parsed.code === null) return { kind: "activated" };
  if (!parsed.activated && parsed.code !== null) {
    return { kind: "denied", code: parsed.code };
  }
  return { kind: "unknown" };
}

/** Denial action mapping from the normative contract. */
function terminalOutcomeForDenial(code: ActivationDenialCode): TerminalCallbackOutcome | undefined {
  switch (code) {
    case "lease_lost":
      return "release";
    case "grant_replayed":
      return "uncertain";
    case "environment_mismatch":
    case "grant_not_found":
    case "grant_expired":
    case "grant_terminalized":
      return undefined;
  }
}

/** Renewal failed or is unconfirmed; upstream work must stop. */
class RelayLeaseRenewalError extends Error {
  constructor() {
    super("relay lease renewal failed");
    this.name = "RelayLeaseRenewalError";
  }
}

function terminalReport(grant: ActiveGrant, outcome: TerminalCallbackOutcome): RelayTerminalV1 {
  return {
    version: 1,
    grantId: grant.grantId,
    leaseGeneration: grant.leaseGeneration,
    outcome,
    totalTokens: null,
  };
}

function callbackSignal(args: RelayHandlerArgs, renewal = false): AbortSignal {
  const timeoutMs = renewal
    ? Math.min(
      callbackTimeoutMs,
      Math.max(1, args.config.leaseTtlMs - args.config.leaseRenewalIntervalMs - 1),
    )
    : callbackTimeoutMs;
  return AbortSignal.timeout(timeoutMs);
}

/** Best-effort terminal callback; delivery failure never fails the ingress response. */
async function sendTerminalReport(
  args: RelayHandlerArgs,
  grant: ActiveGrant,
  report: RelayTerminalV1,
): Promise<void> {
  try {
    await args.fetchImpl(`${args.config.callbackOrigin}${terminalCallbackPath}`, {
      method: "POST",
      headers: callbackHeaders(args.config, grantHeader, grant.credential),
      body: JSON.stringify(report),
      signal: callbackSignal(args),
    });
  } catch {
    // Best-effort reporting: the reservation stays for reconciliation.
  }
}

/** Single renewal attempt; any failure rejects and aborts upstream work. */
async function renewLeaseOnce(args: RelayHandlerArgs, grant: ActiveGrant): Promise<void> {
  const response = await args.fetchImpl(`${args.config.callbackOrigin}${renewalCallbackPath}`, {
    method: "POST",
    headers: callbackHeaders(args.config, grantHeader, grant.credential),
    body: JSON.stringify({
      version: 1,
      grantId: grant.grantId,
      leaseGeneration: grant.leaseGeneration,
    }),
    signal: callbackSignal(args, true),
  });
  if (response.status !== 200) throw new RelayLeaseRenewalError();
  const value = await readBoundedCallbackJson(response);
  const parsed = value === undefined ? undefined : parseRelayRenewalResponse(value);
  if (parsed === undefined || !parsed.renewed) throw new RelayLeaseRenewalError();
}

function buildUpstreamRequest(input: {
  readonly config: RelayServiceConfig;
  readonly claims: RelayContextV1;
  readonly decision: AllowedDecision;
  readonly idempotencyKey: string | undefined;
  readonly body: Record<string, unknown>;
}): RequestInit {
  const metadata = {
    client_id: input.claims.clientId,
    pool: toPoolLower(input.decision.quota.pool),
    eligibility: "COMPLIMENTARY",
    route: "free_shared",
    request_id: input.claims.requestId,
  };
  const headers: Record<string, string> = {
    "content-type": jsonContentType,
    "cf-aig-authorization": `Bearer ${input.config.gatewayBToken}`,
    "cf-aig-request-timeout": upstreamRequestTimeoutMs,
    "cf-aig-max-attempts": "1",
    "cf-aig-metadata": JSON.stringify(metadata),
    "cf-aig-collect-log-payload": "false",
  };
  if (input.idempotencyKey !== undefined) headers["Idempotency-Key"] = input.idempotencyKey;
  if (input.decision.cacheEnabled) headers["cf-aig-cache-key"] = `octg:${input.claims.clientId}`;
  else headers["cf-aig-skip-cache"] = "true";
  return {
    method: "POST",
    headers,
    body: JSON.stringify(input.body),
  };
}

function allowedUpstreamResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();
  const contentType = upstreamHeaders.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  return headers;
}

/** Bounded internal decision envelope for the Worker's public header mapping. */
function buildResponseMetaHeader(
  claims: RelayContextV1,
  decision: AllowedDecision,
): string | undefined {
  const meta: RelayResponseMetaV1 = {
    version: 1,
    requestId: claims.requestId,
    pool: decision.quota.pool,
    limit: decision.quota.limit,
    used: decision.quota.used,
    remaining: decision.quota.remaining,
    resetAt: decision.quota.resetAt,
    route: "responses",
  };
  const json = JSON.stringify(meta);
  if (textEncoder.encode(json).byteLength > RELAY_MAX_RESPONSE_META_JSON_BYTES) return undefined;
  const header = base64urlEncode(textEncoder.encode(json));
  if (header.length > RELAY_MAX_RESPONSE_META_HEADER_BYTES) return undefined;
  return header;
}

export async function handleRelay(request: Request, args: RelayHandlerArgs): Promise<Response> {
  if (new URL(request.url).pathname !== RELAY_INGRESS_ROUTE) {
    return relayErrorResponse(404, "invalid_request");
  }
  if (request.method !== "POST") {
    return methodNotAllowedResponse();
  }
  if (!await isAuthorized(request.headers.get("authorization"), args.config.ingressAuthToken)) {
    return relayErrorResponse(401, "unauthorized_service");
  }
  if (!acceptsPreparePayload(parseContentType(request))) {
    return relayErrorResponse(400, "invalid_request");
  }

  const contextToken = transportValidContextToken(request.headers.get(contextHeader));
  if (contextToken === undefined) {
    return relayErrorResponse(500, "invalid_context");
  }

  const parsedKey = parseIdempotencyKey(request.headers.get("idempotency-key"));
  if (parsedKey.kind === "invalid") {
    return relayErrorResponse(400, "invalid_request");
  }
  const idempotencyKey = parsedKey.kind === "valid" ? parsedKey.value : undefined;

  const rawBody = await readBoundedRawBody(request, RELAY_MAX_INGRESS_BODY_BYTES);
  if (!rawBody.ok) {
    return rawBody.reason === "read_failure"
      ? relayErrorResponse(500, "internal_error")
      : relayErrorResponse(413, "request_too_large");
  }

  let parsedBody: unknown;
  try {
    parsedBody = parseRelayJsonBody(rawBody.bytes, RELAY_MAX_INGRESS_BODY_BYTES);
  } catch {
    return relayErrorResponse(400, "invalid_request");
  }
  if (!isRecord(parsedBody)) {
    return relayErrorResponse(400, "invalid_request");
  }
  const requestBody = parsedBody;

  const normalized = normalizeResponses(requestBody, args.config.maxInputBytes);
  if (!normalized.ok) {
    return normalized.error === "input_too_large"
      ? relayErrorResponse(413, "request_too_large")
      : relayErrorResponse(400, "invalid_request");
  }

  let estimatedInputTokens: number;
  try {
    estimatedInputTokens = estimatedInputTokensOf({
      baseTokenCount: args.encoder.count(normalized.value.inputText),
      messageCount: normalized.value.messageCount,
      opaqueInputBytes: normalized.value.opaqueInputBytes,
    });
  } catch {
    return relayErrorResponse(500, "internal_error");
  }

  const metadata: RelayRequestMetaV1 = {
    model: normalized.value.model,
    estimatedInputTokens,
    maxOutputTokens: normalized.value.maxOutputTokens,
    inputBytes: normalized.value.inputBytes,
    rawBodyBytes: rawBody.bytes.byteLength,
    isToolUse: normalized.value.isToolUse,
    stream: normalized.value.stream,
  };

  let decisionResponse: Response;
  try {
    const headers = callbackHeaders(args.config, contextHeader, contextToken);
    if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
    decisionResponse = await args.fetchImpl(
      `${args.config.callbackOrigin}${decisionCallbackPath}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ version: 1, metadata }),
        signal: callbackSignal(args),
      },
    );
  } catch {
    return relayErrorResponse(500, "internal_error");
  }
  if (decisionResponse.status !== 200) {
    return relayErrorResponse(500, "internal_error");
  }
  const decisionValue = await readBoundedCallbackJson(decisionResponse);
  const decision = decisionValue === undefined ? undefined : parseRelayDecision(decisionValue);
  if (decision === undefined) {
    return relayErrorResponse(500, "internal_error");
  }
  if (decision.kind === "reject") {
    return relayErrorResponse(decision.status, decision.code);
  }

  const grantCredential = decisionResponse.headers.get(grantHeader);
  if (grantCredential === null || !isBoundedGrantCredential(grantCredential)) {
    return relayErrorResponse(500, "internal_error");
  }
  const grant: ActiveGrant = {
    grantId: decision.grantId,
    leaseGeneration: decision.leaseGeneration,
    credential: grantCredential,
  };

  const contextClaims = decodeContextClaims(contextToken);
  if (contextClaims === undefined) {
    await sendTerminalReport(args, grant, terminalReport(grant, "release"));
    return relayErrorResponse(500, "internal_error");
  }

  const upstreamBody = normalizeResponsesUpstreamBody(requestBody);
  delete upstreamBody.max_output_tokens;
  upstreamBody.max_output_tokens = decision.maxOutputTokens;

  const activation = await activateOnce(args, grant);
  switch (activation.kind) {
    case "activated":
      break;
    case "denied": {
      const outcome = terminalOutcomeForDenial(activation.code);
      if (outcome !== undefined) {
        await sendTerminalReport(args, grant, terminalReport(grant, outcome));
      }
      return relayErrorResponse(500, activation.code);
    }
    case "unknown":
      await sendTerminalReport(args, grant, terminalReport(grant, "uncertain"));
      return relayErrorResponse(500, "internal_error");
  }

  let upstream: Response;
  try {
    upstream = await args.fetchImpl(
      `${args.config.gatewayBBaseUrl}${upstreamResponsesPath}`,
      buildUpstreamRequest({
        config: args.config,
        claims: contextClaims,
        decision,
        idempotencyKey,
        body: upstreamBody,
      }),
    );
  } catch {
    await sendTerminalReport(args, grant, terminalReport(grant, "uncertain"));
    return relayErrorResponse(500, "internal_error");
  }

  if (upstream.status < 200 || upstream.status >= 300) {
    await sendTerminalReport(args, grant, terminalReport(grant, "uncertain"));
    return new Response(upstream.body, {
      status: upstream.status,
      headers: allowedUpstreamResponseHeaders(upstream.headers),
    });
  }

  const metaHeaderValue = buildResponseMetaHeader(contextClaims, decision);
  if (metaHeaderValue === undefined) {
    await sendTerminalReport(args, grant, terminalReport(grant, "uncertain"));
    return relayErrorResponse(500, "internal_error");
  }

  const session: RelayGrantSession = {
    grantId: grant.grantId,
    leaseGeneration: grant.leaseGeneration,
    renewLease: () => renewLeaseOnce(args, grant),
    renewalIntervalMs: args.config.leaseRenewalIntervalMs,
  };
  let forwarded: Response;
  try {
    forwarded = await relayUpstreamResponse(
      upstream,
      (report) => sendTerminalReport(args, grant, report),
      session,
    );
  } catch (error) {
    if (error instanceof RelayUpstreamDeliveryError) {
      return relayErrorResponse(500, "upstream_invalid_response");
    }
    throw error;
  }
  if (forwarded.status >= 200 && forwarded.status < 300) {
    forwarded.headers.set(responseMetaHeader, metaHeaderValue);
  }
  return forwarded;
}

export function createRelayHandler(
  args: RelayHandlerArgs,
): (request: Request) => Promise<Response> {
  return (request) => handleRelay(request, args);
}
