/**
 * RelayDecisionController: the sharded Cloudflare-internal decision authority
 * (SPEC.md section 19.4). It verifies the signed ingress context, recomputes
 * its own 64-shard identity, strictly parses the bounded decision body, binds
 * the exact raw Idempotency-Key to the signed hash, resolves registry/policy,
 * classifies the model and tools, computes the token budget and admission UTC
 * day, and calls the single atomic QuotaController.admitRelay RPC. It holds no
 * quota or grant ledger; the grant credential is signed only after durable
 * authorization, and a signing failure releases the pre-activation grant.
 */

import { DurableObject } from "cloudflare:workers";
import {
  classifyModel,
  constantTimeHexEqual,
  parseIdempotencyKey,
  parseRelayDecisionRequest,
  parseRelayJsonBody,
  quotaIdOf,
  RELAY_GRANT_AUDIENCE,
  RELAY_MAX_CALLBACK_BODY_BYTES,
  relayErrorCodeStatus,
  signRelayGrantCredential,
  utcDayOf,
  verifyRelayContext,
} from "@octg/shared";
import type {
  RelayContextV1,
  RelayDecisionDispatchInput,
  RelayDecisionDispatchResult,
  RelayDecisionRequestV1,
  RelayDecisionV1,
  RelayErrorCode,
  RelayEnvironment,
  RelayGrantCredentialV1,
  RelayTerminalV1,
} from "@octg/shared";
import { RelayProtocolError } from "@octg/shared";
import type { RelayGrant } from "../../../durable-objects/quota-controller/src/relay-grant";
import type { Env } from "./index";
import { assertNever } from "./exhaustiveness";
import { loadPolicy, loadRegistry } from "./policy";
import { resolveRelayConfig } from "./relay-auth";
import { resolveTokenBudget } from "./token-budget";

const SHARD_MASK = 63;
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

function shardIndex(requestId: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < requestId.length; index += 1) {
    hash = Math.imul(hash ^ requestId.charCodeAt(index), FNV_PRIME) >>> 0;
  }
  return String(hash & SHARD_MASK).padStart(2, "0");
}

/** The exact DO name for a decision shard (design routing contract). */
export function relayDecisionShardName(environment: RelayEnvironment, requestId: string): string {
  return `relay-decision:v1:${environment}:${shardIndex(requestId)}`;
}

/** Stable terminal-report fingerprint shared by Worker-side terminal callbacks. */
export function relayTerminalFingerprint(report: RelayTerminalV1): string {
  return `${report.outcome}:${report.totalTokens === null ? "null" : report.totalTokens}`;
}

type ShardIdentityCheck = "ok" | "environment_mismatch" | "shard_mismatch" | "invalid_name";

function checkShardIdentity(
  ownName: string | undefined,
  environment: RelayEnvironment,
  requestId: string,
): ShardIdentityCheck {
  if (ownName === undefined) return "invalid_name";
  const parts = ownName.split(":");
  const prefix = parts[0];
  const version = parts[1];
  const environmentPart = parts[2];
  const shardPart = parts[3];
  if (parts.length !== 4 || prefix !== "relay-decision" || version !== "v1") return "invalid_name";
  if (prefix === undefined || version === undefined || environmentPart === undefined || shardPart === undefined) {
    return "invalid_name";
  }
  if (environmentPart !== environment) return "environment_mismatch";
  return shardPart === shardIndex(requestId) ? "ok" : "shard_mismatch";
}

/** SHA-256(clientId || NUL || rawKey) binding rule for the exact raw key. */
async function isRawKeyBindingConsistent(
  context: RelayContextV1,
  rawKey: string | undefined,
): Promise<boolean> {
  if (context.idempotencyKeyHash === null) return rawKey === undefined;
  if (rawKey === undefined) return false;
  const encoder = new TextEncoder();
  const prefix = encoder.encode(context.clientId);
  const key = encoder.encode(rawKey);
  const bytes = new Uint8Array(prefix.length + 1 + key.length);
  bytes.set(prefix, 0);
  bytes[prefix.length] = 0;
  bytes.set(key, prefix.length + 1);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return constantTimeHexEqual(hex, context.idempotencyKeyHash);
}

function rejectDecision(code: RelayErrorCode): Extract<RelayDecisionDispatchResult, { kind: "reject" }> {
  const decision: Extract<RelayDecisionV1, { kind: "reject" }> = {
    version: 1,
    kind: "reject",
    code,
    status: relayErrorCodeStatus(code),
  };
  return { kind: "reject", decision };
}

function grantClaimsOf(grant: RelayGrant): RelayGrantCredentialV1 {
  return {
    version: 1,
    audience: RELAY_GRANT_AUDIENCE,
    environment: grant.environment,
    route: "responses",
    requestId: grant.requestId,
    grantId: grant.grantId,
    nonce: grant.nonce,
    clientId: grant.clientId,
    idempotencyKeyHash: grant.idempotencyKeyHash,
    model: grant.model,
    pool: grant.pool,
    admissionUtcDay: grant.admissionUtcDay,
    leaseGeneration: grant.leaseGeneration,
    issuedAtMs: grant.issuedAtMs,
    expiresAtMs: grant.credentialExpiresAtMs,
  };
}

export class RelayDecisionController extends DurableObject<Env> {
  async decide(input: RelayDecisionDispatchInput): Promise<RelayDecisionDispatchResult> {
    const config = resolveRelayConfig(this.env);
    if (config.kind !== "enabled") return { kind: "internal_error", code: "internal_error" };

    const context = await verifyRelayContext(
      input.contextToken,
      config.contextHmacKey,
      config.environment,
      Date.now(),
    );
    if (context === undefined) return { kind: "protocol_error", code: "invalid_context" };

    const shardCheck = checkShardIdentity(this.ctx.id.name, config.environment, context.requestId);
    switch (shardCheck) {
      case "ok":
        break;
      case "environment_mismatch":
        return { kind: "protocol_error", code: "environment_mismatch" };
      case "shard_mismatch":
        return { kind: "protocol_error", code: "invalid_request" };
      case "invalid_name":
        return { kind: "internal_error", code: "internal_error" };
      default:
        return assertNever(shardCheck, "shard identity");
    }

    const parsedKey = parseIdempotencyKey(input.rawIdempotencyKey);
    if (parsedKey.kind === "invalid") return { kind: "protocol_error", code: "invalid_request" };
    const rawKey = parsedKey.kind === "valid" ? parsedKey.value : undefined;
    if (!(await isRawKeyBindingConsistent(context, rawKey))) {
      return { kind: "protocol_error", code: "invalid_request" };
    }

    let decision: RelayDecisionRequestV1 | undefined;
    try {
      decision = parseRelayDecisionRequest(
        parseRelayJsonBody(input.decisionBody, RELAY_MAX_CALLBACK_BODY_BYTES),
      );
    } catch (error) {
      if (!(error instanceof RelayProtocolError)) throw error;
      return { kind: "protocol_error", code: "invalid_request" };
    }
    if (decision === undefined) return { kind: "protocol_error", code: "invalid_request" };

    const registry = await loadRegistry(this.env);
    const pool = classifyModel(decision.metadata.model, registry);
    if (pool === "NONE") return rejectDecision("model_requires_paid");

    const policy = await loadPolicy(this.env, context.clientId);
    if (decision.metadata.isToolUse && policy.toolsMode !== "ALLOW") {
      return rejectDecision("model_not_allowed");
    }

    const admissionDay = utcDayOf(new Date());
    const quotaNamespace = this.env.QUOTA_CONTROLLER;
    const quotaStub = quotaNamespace.get(quotaNamespace.idFromName(quotaIdOf(pool, admissionDay)));
    const state = await quotaStub.getState();
    const budget = resolveTokenBudget({
      estimatedInput: decision.metadata.estimatedInputTokens,
      maxOutputTokens: decision.metadata.maxOutputTokens,
      remaining: state.remaining,
      limit: state.limit,
      outputLimitMode: policy.outputLimitMode,
    });
    switch (budget.kind) {
      case "resolved":
        break;
      case "request_too_large":
        return rejectDecision("request_too_large");
      case "quota_exceeded":
        return rejectDecision("insufficient_quota");
      case "arithmetic_error":
        return { kind: "internal_error", code: "internal_error" };
      default:
        return assertNever(budget, "token budget outcome");
    }

    // Lost or ambiguous acknowledgement throws and maps to HTTP 500 at the
    // callback; an identical retry reaches the same shard and QuotaController
    // returns the saved admission instead of reserving twice.
    const admission = await quotaStub.admitRelay({
      context,
      metadata: decision.metadata,
      rawIdempotencyKey: rawKey,
      reservedTokens: budget.reservation,
      upperBoundTokens: budget.upperBound,
      maxOutputTokens: budget.maxOutputTokens,
      cacheEnabled: policy.cacheEnabled,
    });
    if (admission.kind === "denied") return rejectDecision(admission.code);

    const claims = grantClaimsOf(admission.grant);
    let grantCredential: string;
    try {
      grantCredential = await signRelayGrantCredential(claims, config.contextHmacKey);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // Signing failure is definitively pre-activation: Deno has received no
      // credential, so a pre-activation release is legal and no allow is emitted.
      const releaseReport: RelayTerminalV1 = {
        version: 1,
        grantId: admission.grant.grantId,
        leaseGeneration: admission.grant.leaseGeneration,
        outcome: "release",
        totalTokens: null,
      };
      await quotaStub.finishRelay({
        requestId: admission.grant.requestId,
        grantId: admission.grant.grantId,
        leaseGeneration: admission.grant.leaseGeneration,
        claims,
        report: releaseReport,
        reportFingerprint: relayTerminalFingerprint(releaseReport),
      });
      return { kind: "internal_error", code: "internal_error" };
    }

    const allowDecision: Extract<RelayDecisionV1, { kind: "allow" }> = {
      version: 1,
      kind: "allow",
      grantId: admission.grant.grantId,
      leaseGeneration: admission.grant.leaseGeneration,
      maxOutputTokens: budget.maxOutputTokens,
      cacheEnabled: policy.cacheEnabled,
      quota: admission.quota,
    };
    return { kind: "allow", decision: allowDecision, grantCredential };
  }
}
