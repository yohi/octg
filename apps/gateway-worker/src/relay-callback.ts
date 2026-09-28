/**
 * Thin stateless relay callback handler (SPEC.md sections 19.2–19.3).
 *
 * Decision: authenticate the Deno service bearer, enforce bounded
 * method/path/content-type/header/body checks, extract only the unsigned
 * request-ID routing hint, and dispatch exactly one RelayDecisionController
 * shard — no HMAC, policy, model, token-budget, grant, or quota work.
 * Activation, renewal, and terminal remain Worker-side: they verify the grant
 * credential and dispatch the QuotaController identity reconstructed from the
 * verified grant's pool and admission UTC day.
 */

import {
  isRecord,
  parseIdempotencyKey,
  parseRelayActivation,
  parseRelayJsonBody,
  parseRelayRenewal,
  parseRelayTerminal,
  quotaIdOf,
  RELAY_MAX_CALLBACK_BODY_BYTES,
  RELAY_MAX_CONTEXT_HEADER_BYTES,
  RELAY_REQUEST_ID_PATTERN,
} from "@octg/shared";
import type { RelayDecisionDispatchResult, RelayErrorCode, RelayTerminalV1 } from "@octg/shared";
import { RelayProtocolError } from "@octg/shared";
import { assertNever } from "./exhaustiveness";
import type { Env } from "./index";
import { resolveRelayConfig, verifyRelayGrantHeader, verifyRelayServiceAuth } from "./relay-auth";
import type { EnabledRelayConfig } from "./relay-auth";
import { relayDecisionShardName, relayTerminalFingerprint } from "./relay-decision-controller";

type CallbackAction = "decision" | "activation" | "renewal" | "terminal";

function callbackAction(pathname: string): CallbackAction | undefined {
  const prefix = "/internal/relay/v1/";
  if (!pathname.startsWith(prefix)) return undefined;
  const action = pathname.slice(prefix.length);
  if (action === "decision" || action === "activation" || action === "renewal" || action === "terminal") {
    return action;
  }
  return undefined;
}

function jsonEnvelope(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorEnvelope(code: RelayErrorCode, status: number): Response {
  return jsonEnvelope({ version: 1, error: { code } }, status);
}

/** application/json, case-insensitive, with optional charset=utf-8 only. */
function isRelayJsonContentType(headerValue: string | null): boolean {
  if (headerValue === null) return false;
  const segments = headerValue.split(";").map((segment) => segment.trim().toLowerCase());
  const mediaType = segments[0];
  if (mediaType === undefined || mediaType !== "application/json") return false;
  return segments.slice(1).every((parameter) => parameter === "charset=utf-8");
}

type BoundedBody = { readonly kind: "ok"; readonly bytes: Uint8Array } | { readonly kind: "too_large" };

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedBody> {
  if (stream === null) return { kind: "ok", bytes: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { kind: "too_large" };
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}

/**
 * Extracts the unsigned request-ID routing hint from the compact context
 * payload. It never validates the HMAC and is never used for authorization;
 * the Decision DO re-verifies everything from the full token.
 */
function extractRequestIdHint(token: string): string | undefined {
  const parts = token.split(".");
  const payloadPart = parts[0];
  if (parts.length !== 2 || payloadPart === undefined || payloadPart.length === 0) return undefined;
  let payloadText: string;
  try {
    const normalized = payloadPart.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    payloadText = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    // Base64url or UTF-8 failure IS the invalid-hint condition at this boundary.
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    // JSON syntax failure IS the invalid-hint condition at this boundary.
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  const requestId = payload.requestId;
  return typeof requestId === "string" && RELAY_REQUEST_ID_PATTERN.test(requestId) ? requestId : undefined;
}

async function handleDecision(request: Request, env: Env, config: EnabledRelayConfig): Promise<Response> {
  const contextToken = request.headers.get("X-OCTG-Relay-Context");
  if (contextToken === null || contextToken.length > RELAY_MAX_CONTEXT_HEADER_BYTES) {
    return errorEnvelope("invalid_context", 400);
  }

  const keyHeader = request.headers.get("Idempotency-Key");
  let rawKey: string | undefined;
  if (keyHeader !== null) {
    const parsed = parseIdempotencyKey(keyHeader);
    if (parsed.kind === "invalid") return errorEnvelope("invalid_request", 400);
    rawKey = parsed.kind === "valid" ? parsed.value : undefined;
  }

  const body = await readBoundedBytes(request.body, RELAY_MAX_CALLBACK_BODY_BYTES);
  if (body.kind === "too_large") return errorEnvelope("request_too_large", 413);

  const requestIdHint = extractRequestIdHint(contextToken);
  if (requestIdHint === undefined) return errorEnvelope("invalid_context", 400);

  const namespace = env.RELAY_DECISION_CONTROLLER;
  const shardName = relayDecisionShardName(config.environment, requestIdHint);
  const result: RelayDecisionDispatchResult = await namespace
    .get(namespace.idFromName(shardName))
    .decide({
      decisionBody: body.bytes,
      contextToken,
      ...(rawKey === undefined ? {} : { rawIdempotencyKey: rawKey }),
    });

  switch (result.kind) {
    case "allow":
      return jsonEnvelope(result.decision, 200, { "X-OCTG-Relay-Grant": result.grantCredential });
    case "reject":
      return jsonEnvelope(result.decision, 200);
    case "protocol_error":
      return errorEnvelope(result.code, 400);
    case "internal_error":
      return errorEnvelope("internal_error", 500);
    default:
      return assertNever(result, "decision dispatch result");
  }
}

async function handleGrantCallback(
  action: "activation" | "renewal" | "terminal",
  request: Request,
  env: Env,
  config: EnabledRelayConfig,
): Promise<Response> {
  const body = await readBoundedBytes(request.body, RELAY_MAX_CALLBACK_BODY_BYTES);
  if (body.kind === "too_large") return errorEnvelope("request_too_large", 413);

  const grant = await verifyRelayGrantHeader(request.headers.get("X-OCTG-Relay-Grant"), config, Date.now());
  if (grant === undefined) return errorEnvelope("invalid_context", 400);

  let parsedBody: unknown;
  try {
    parsedBody = parseRelayJsonBody(body.bytes, RELAY_MAX_CALLBACK_BODY_BYTES);
  } catch (error) {
    if (!(error instanceof RelayProtocolError)) throw error;
    return errorEnvelope("invalid_request", 400);
  }

  const namespace = env.QUOTA_CONTROLLER;
  const stub = namespace.get(namespace.idFromName(quotaIdOf(grant.pool, grant.admissionUtcDay)));
  const binding = {
    requestId: grant.requestId,
    grantId: grant.grantId,
    leaseGeneration: grant.leaseGeneration,
    claims: grant,
  };

  switch (action) {
    case "activation": {
      const reference = parseRelayActivation(parsedBody);
      if (reference === undefined) return errorEnvelope("invalid_request", 400);
      if (reference.grantId !== grant.grantId || reference.leaseGeneration !== grant.leaseGeneration) {
        return errorEnvelope("invalid_request", 400);
      }
      const result = await stub.activateRelay(binding);
      return jsonEnvelope(
        {
          version: 1,
          activated: result.kind === "activated",
          code: result.kind === "activated" ? null : result.code,
        },
        200,
      );
    }
    case "renewal": {
      const reference = parseRelayRenewal(parsedBody);
      if (reference === undefined) return errorEnvelope("invalid_request", 400);
      if (reference.grantId !== grant.grantId || reference.leaseGeneration !== grant.leaseGeneration) {
        return errorEnvelope("invalid_request", 400);
      }
      const result = await stub.renewRelay(binding);
      return jsonEnvelope(
        {
          version: 1,
          renewed: result.kind === "renewed",
          code: result.kind === "renewed" ? null : result.code,
        },
        200,
      );
    }
    case "terminal": {
      const report: RelayTerminalV1 | undefined = parseRelayTerminal(parsedBody);
      if (report === undefined) return errorEnvelope("invalid_request", 400);
      const result = await stub.finishRelay({
        ...binding,
        report,
        reportFingerprint: relayTerminalFingerprint(report),
      });
      return jsonEnvelope(
        {
          version: 1,
          accepted: result.kind === "accepted",
          state: result.kind === "accepted" ? result.grant.state : result.state,
          code: result.kind === "accepted" ? null : result.code,
        },
        200,
      );
    }
    default:
      return assertNever(action, "callback action");
  }
}

export async function handleRelayCallback(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const action = callbackAction(new URL(request.url).pathname);
  if (action === undefined) return new Response("Not Found", { status: 404 });
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  const config = resolveRelayConfig(env);
  if (config.kind !== "enabled") return errorEnvelope("internal_error", 500);
  if (!verifyRelayServiceAuth(request.headers.get("Authorization"), config)) {
    return errorEnvelope("unauthorized_service", 401);
  }
  if (!isRelayJsonContentType(request.headers.get("Content-Type"))) {
    return errorEnvelope("invalid_request", 400);
  }
  try {
    return action === "decision"
      ? await handleDecision(request, env, config)
      : await handleGrantCallback(action, request, env, config);
  } catch (error) {
    // DO RPC or dispatch failure: fail closed as an internal callback error.
    if (!(error instanceof Error)) throw error;
    return errorEnvelope("internal_error", 500);
  }
}
