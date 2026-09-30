import { POOL_LIMITS } from "@octg/shared";

import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  quotaIdOf,
  relayErrorCodeStatus,
  safetyMargin,
  signRelayContext,
  utcDayOf,
  verifyRelayGrantCredential,
} from "@octg/shared";
import type {
  QuotaView,
  RelayContextV1,
  RelayDecisionDispatchInput,
  RelayDecisionDispatchResult,
  RelayGrantCredentialV1,
  RelayRequestMetaV1,
  RelayTerminalV1,
} from "@octg/shared";
import type { QuotaController } from "@octg/quota-controller";
import type { FinishRelayInput, RelayGrant } from "../../../durable-objects/quota-controller/src/relay-grant";
import { invalidateConfigCaches } from "../src/policy";
import { relayDecisionShardName } from "../src/relay-decision-controller";
import type { RelayDecisionController } from "../src/relay-decision-controller";

function usedOf(view: QuotaView): number {
  return view.confirmedTokens + view.reservedTokens + view.uncertainTokens;
}

function hasDecideMethod<T extends object>(
  instance: T,
): instance is T & Pick<RelayDecisionController, "decide"> {
  return "decide" in instance;
}

const REQUEST_ID_A = "req_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REQUEST_ID_B = "req_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const REQUEST_ID_C = "req_01ARZ3NDEKTSV4RRFFQ69G5FCV";
const REQUEST_ID_D = "req_01ARZ3NDEKTSV4RRFFQ69G5FDV";
const REQUEST_ID_E = "req_01ARZ3NDEKTSV4RRFFQ69G5FEV";
const REQUEST_ID_F = "req_01ARZ3NDEKTSV4RRFFQ69G5FFV";
const REQUEST_ID_G = "req_01ARZ3NDEKTSV4RRFFQ69G5FGV";
const NONCE = "bQ".repeat(21) + "b";
const HMAC_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const HMAC_KEY_ENCODED = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const WRONG_KEY = Uint8Array.from({ length: 32 }, (_, index) => 31 - index);
const CLIENT_ID = "client-relay";

const decisionStub = (requestId: string) =>
  env.RELAY_DECISION_CONTROLLER.get(
    env.RELAY_DECISION_CONTROLLER.idFromName(relayDecisionShardName("preview", requestId)),
  );

const quotaStub = (pool: "STANDARD" | "MINI"): DurableObjectStub<QuotaController> =>
  env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, utcDayOf(new Date()))));

function relayContext(overrides: Partial<RelayContextV1> = {}): RelayContextV1 {
  const issuedAtMs = Date.now();
  return {
    version: 1,
    audience: "octg-deno-relay",
    environment: "preview",
    route: "responses",
    requestId: REQUEST_ID_A,
    clientId: CLIENT_ID,
    idempotencyKeyHash: null,
    nonce: NONCE,
    issuedAtMs,
    expiresAtMs: issuedAtMs + 30_000,
    ...overrides,
  };
}

function relayMetadata(overrides: Partial<RelayRequestMetaV1> = {}): RelayRequestMetaV1 {
  return {
    model: "gpt-5",
    estimatedInputTokens: 100,
    maxOutputTokens: 200,
    inputBytes: 512,
    rawBodyBytes: 600,
    isToolUse: false,
    stream: false,
    ...overrides,
  };
}

function decisionBody(overrides: Partial<RelayRequestMetaV1> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version: 1, metadata: relayMetadata(overrides) }));
}

interface DispatchOptions {
  readonly context?: RelayContextV1;
  readonly key?: Uint8Array;
  readonly body?: Uint8Array;
  readonly rawIdempotencyKey?: string;
}

async function dispatchInput(options: DispatchOptions = {}): Promise<RelayDecisionDispatchInput> {
  const token = await signRelayContext(options.context ?? relayContext(), options.key ?? HMAC_KEY);
  return {
    decisionBody: options.body ?? decisionBody(),
    contextToken: token,
    ...(options.rawIdempotencyKey === undefined ? {} : { rawIdempotencyKey: options.rawIdempotencyKey }),
  };
}

async function decide(options: DispatchOptions = {}): Promise<RelayDecisionDispatchResult> {
  const context = options.context ?? relayContext();
  return decisionStub(context.requestId).decide(await dispatchInput({ ...options, context }));
}

async function keyHash(clientId: string, rawKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = new Uint8Array([...encoder.encode(clientId), 0, ...encoder.encode(rawKey)]);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function storedGrant(pool: "STANDARD" | "MINI", requestId: string): Promise<RelayGrant> {
  const grant = await runInDurableObject(quotaStub(pool), (_instance, state) =>
    state.storage.get<RelayGrant>(`relay-grant:${requestId}`),
  );
  if (grant === undefined) throw new Error(`fixture grant ${requestId} must exist`);
  return grant;
}

function claimsOfGrant(grant: RelayGrant): RelayGrantCredentialV1 {
  return {
    version: 1,
    audience: "octg-worker-relay",
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

function expectAllow(result: RelayDecisionDispatchResult): Extract<RelayDecisionDispatchResult, { kind: "allow" }> {
  expect(result.kind).toBe("allow");
  if (result.kind !== "allow") throw new Error("expected allow result");
  return result;
}

function expectReject(result: RelayDecisionDispatchResult, code: string): void {
  expect(result.kind).toBe("reject");
  if (result.kind !== "reject") throw new Error("expected reject result");
  expect(result.decision.code).toBe(code);
  expect(result.decision.status).toBe(relayErrorCodeStatus(result.decision.code));
}

beforeAll(() => {
  Object.assign(env, {
    OCTG_RELAY_ENABLED: "true",
    OCTG_RELAY_ENVIRONMENT: "preview",
    OCTG_RELAY_INGRESS_ENDPOINT: "https://relay.example/",
    OCTG_RELAY_INGRESS_AUTH_TOKEN: "i".repeat(32),
    OCTG_RELAY_SERVICE_AUTH_TOKEN: "s".repeat(32),
    OCTG_RELAY_CONTEXT_HMAC_KEY: HMAC_KEY_ENCODED,
    MAX_IN_FLIGHT_REQUESTS: "64",
  });
});

beforeEach(() => {
  invalidateConfigCaches();
});

describe("relayDecisionShardName", () => {
  it("maps a request id to its zero-padded FNV shard and environment", () => {
    // Given: the design's fixed 64-shard FNV-1a contract.
    // When: shard names are computed for pinned request ids.
    // Then: the golden shard indexes and environment segments match.
    expect(relayDecisionShardName("preview", REQUEST_ID_A)).toBe("relay-decision:v1:preview:37");
    expect(relayDecisionShardName("preview", REQUEST_ID_B)).toBe("relay-decision:v1:preview:18");
    expect(relayDecisionShardName("production", REQUEST_ID_A)).toBe("relay-decision:v1:production:37");
  });
});

describe("RelayDecisionController.decide", () => {
  it("allows a valid decision, admits once, and signs the returned grant", async () => {
    // Given: a valid signed context and decision body against the seeded registry.
    const before = await quotaStub("STANDARD").getState();
    const margin = safetyMargin(100, before.remaining / before.limit);
    // When: the decision is taken.
    const result = await decide();
    // Then: the allow decision, quota reservation, and signed grant all agree.
    const allow = expectAllow(result);
    expect(allow.decision.version).toBe(1);
    expect(allow.decision.kind).toBe("allow");
    expect(allow.decision.maxOutputTokens).toBe(200);
    expect(allow.decision.cacheEnabled).toBe(false);
    expect(allow.decision.quota.pool).toBe("STANDARD");
    const reservation = 100 + 200 + margin;
    const after = await quotaStub("STANDARD").getState();
    expect(usedOf(after) - usedOf(before)).toBe(reservation);
    const grant = await storedGrant("STANDARD", REQUEST_ID_A);
    expect(grant.state).toBe("authorized");
    expect(grant.pool).toBe("STANDARD");
    expect(grant.admissionUtcDay).toBe(utcDayOf(new Date()));
    expect(grant.admission.reservedTokens).toBe(reservation);
    expect(allow.decision.grantId).toBe(grant.grantId);
    expect(allow.decision.leaseGeneration).toBe(grant.leaseGeneration);
    const claims = await verifyRelayGrantCredential(allow.grantCredential, HMAC_KEY, "preview", Date.now());
    expect(claims).toEqual(claimsOfGrant(grant));
    expect(Object.hasOwn(allow.decision, "grantCredential")).toBe(false);
  });

  it("returns the same stored admission for an identical retry after a lost acknowledgement", async () => {
    // Given: a first decide() that admitted and reserved, with a reused context.
    const context = relayContext({ requestId: REQUEST_ID_F });
    const first = expectAllow(await decide({ context, body: decisionBody({ maxOutputTokens: 210 }) }));
    const usedAfterFirst = usedOf(await quotaStub("STANDARD").getState());
    // When: the identical decision input is retried.
    const second = await decide({ context, body: decisionBody({ maxOutputTokens: 210 }) });
    // Then: the saved admission is returned without a second reservation.
    const allow = expectAllow(second);
    expect(allow.decision.grantId).toBe(first.decision.grantId);
    expect(allow.decision.leaseGeneration).toBe(first.decision.leaseGeneration);
    expect(allow.decision.quota.used).toBe(first.decision.quota.used);
    expect(usedOf(await quotaStub("STANDARD").getState())).toBe(usedAfterFirst);
  });

  it("rejects an exact replay after activation", async () => {
    // Given: an allowed decision whose grant was activated.
    const context = relayContext({ requestId: REQUEST_ID_B });
    const body = decisionBody({ maxOutputTokens: 220 });
    expectAllow(await decisionStub(REQUEST_ID_B).decide(await dispatchInput({ context, body })));
    const grant = await storedGrant("STANDARD", REQUEST_ID_B);
    const activated = await quotaStub("STANDARD").activateRelay({
      requestId: grant.requestId,
      grantId: grant.grantId,
      leaseGeneration: grant.leaseGeneration,
      claims: claimsOfGrant(grant),
    });
    expect(activated.kind).toBe("activated");
    // When: the identical decision is replayed.
    const second = await decisionStub(REQUEST_ID_B).decide(await dispatchInput({ context, body }));
    // Then: the replay is rejected; no second allow is possible.
    expectReject(second, "grant_replayed");
  });

  it("rejects a shard mismatch before any quota movement", async () => {
    // Given: a valid context for request A delivered to another shard's DO.
    const before = usedOf(await quotaStub("STANDARD").getState());
    const wrongShardStub = env.RELAY_DECISION_CONTROLLER.get(
      env.RELAY_DECISION_CONTROLLER.idFromName("relay-decision:v1:preview:18"),
    );
    // When: the wrong shard receives the decision.
    const result = await wrongShardStub.decide(await dispatchInput());
    // Then: the DO rejects the routing violation and reserves nothing.
    expect(result).toEqual({ kind: "protocol_error", code: "invalid_request" });
    expect(usedOf(await quotaStub("STANDARD").getState())).toBe(before);
  });

  it("rejects an invalid context signature with zero quota movement", async () => {
    // Given: a context signed with the wrong key.
    const before = usedOf(await quotaStub("STANDARD").getState());
    // When: the decision is taken.
    const result = await decide({ key: WRONG_KEY });
    // Then: verification fails closed before registry or quota work.
    expect(result).toEqual({ kind: "protocol_error", code: "invalid_context" });
    expect(usedOf(await quotaStub("STANDARD").getState())).toBe(before);
  });

  it.each([
    ["a foreign environment", (): Partial<RelayContextV1> => ({ environment: "production" })],
    ["an expired context", (): Partial<RelayContextV1> => ({ issuedAtMs: Date.now() - 60_000, expiresAtMs: Date.now() - 30_000 })],
    ["a malformed nonce", (): Partial<RelayContextV1> => ({ nonce: "short" })],
  ] as const)("rejects $0", async (_name, overrides) => {
    // Given: a signed context with an unusable claim set.
    // When: the decision is taken.
    const result = await decide({ context: relayContext(overrides()) });
    // Then: the context is rejected as invalid.
    expect(result).toEqual({ kind: "protocol_error", code: "invalid_context" });
  });

  it.each([
    ["a non-JSON body", (): Uint8Array => new TextEncoder().encode("not-json")],
    ["an unknown metadata field", (): Uint8Array => new TextEncoder().encode(
      JSON.stringify({ version: 1, metadata: { ...relayMetadata(), extra: 1 } }),
    )],
    ["an over-limit body", (): Uint8Array => new Uint8Array(8_193).fill(0x61)],
  ] as const)("rejects $0", async (_name, body) => {
    // Given: a decision body that fails the strict envelope parse.
    // When: the decision is taken.
    const result = await decide({ body: body() });
    // Then: the body is rejected as a protocol error.
    expect(result).toEqual({ kind: "protocol_error", code: "invalid_request" });
  });

  it("rejects raw key and hash binding disagreements", async () => {
    // Given: a context whose signed hash binds a specific raw key.
    const hash = await keyHash(CLIENT_ID, "raw-key-1");
    const bound = relayContext({ requestId: REQUEST_ID_E, idempotencyKeyHash: hash });
    // When: the raw key is absent, wrong, or over limit.
    const absent = await decide({ context: bound });
    const wrong = await decide({ context: bound, rawIdempotencyKey: "raw-key-2" });
    const oversized = await decide({ context: bound, rawIdempotencyKey: "k".repeat(256) });
    // Then: every binding disagreement is rejected before admission.
    expect(absent).toEqual({ kind: "protocol_error", code: "invalid_request" });
    expect(wrong).toEqual({ kind: "protocol_error", code: "invalid_request" });
    expect(oversized).toEqual({ kind: "protocol_error", code: "invalid_request" });
  });

  it("rejects a raw key when the signed hash is null", async () => {
    // Given: a fresh context with a null idempotency hash and a present key header.
    // When: the decision is taken.
    const result = await decide({
      context: relayContext({ requestId: REQUEST_ID_G }),
      rawIdempotencyKey: "raw-key-1",
    });
    // Then: presence disagreement is rejected.
    expect(result).toEqual({ kind: "protocol_error", code: "invalid_request" });
  });

  it("admits a matching raw key binding", async () => {
    // Given: a context signed with the hash of a specific raw key.
    const hash = await keyHash(CLIENT_ID, "raw-key-1");
    // When: the exact raw key is presented.
    const result = await decide({
      context: relayContext({ requestId: REQUEST_ID_C, idempotencyKeyHash: hash }),
      rawIdempotencyKey: "raw-key-1",
    });
    // Then: the decision is allowed with the key bound into the grant.
    expectAllow(result);
    const grant = await storedGrant("STANDARD", REQUEST_ID_C);
    expect(grant.idempotencyKeyHash).toBe(hash);
  });

  it.each([
    ["an unregistered model", "gpt-relay-unknown", false],
    ["a disabled model", "gpt-relay-off", true],
  ] as const)("rejects $0 with model_requires_paid", async (_name, model, insertRow) => {
    // Given: a model outside the enabled complimentary registry.
    if (insertRow) {
      await env.DB.prepare(
        "INSERT INTO model_registry (model, provider, complimentary_pool, enabled, fallback_model, updated_at) VALUES (?, 'openai', 'STANDARD', 0, NULL, ?)",
      )
        .bind(model, new Date().toISOString())
        .run();
    }
    // When: the decision is taken for that model.
    const result = await decide({ body: decisionBody({ model }) });
    // Then: the v1 reject envelope carries the policy code and mapped status.
    expectReject(result, "model_requires_paid");
  });

  it("rejects tool use when the client policy disallows tools", async () => {
    // Given: the default client policy with toolsMode REJECT.
    // When: the decision metadata declares tool use.
    const result = await decide({ body: decisionBody({ isToolUse: true }) });
    // Then: the tool rejection uses the policy envelope.
    expectReject(result, "model_not_allowed");
  });

  it("rejects request_too_large when the upper bound exceeds the pool limit", async () => {
    // Given: metadata whose upper bound exceeds the STANDARD limit.
    // When: the decision is taken.
    const result = await decide({
      body: decisionBody({ estimatedInputTokens: 1_100_000, maxOutputTokens: 200_000 }),
    });
    // Then: the size rejection uses the mapped status.
    expectReject(result, "request_too_large");
  });

  it("rejects insufficient_quota when the reservation exceeds remaining", async () => {
    // Given: a nearly exhausted STANDARD pool.
    const state = await quotaStub("STANDARD").getState();
    const drained = await quotaStub("STANDARD").admitRelay({
      context: relayContext({ requestId: REQUEST_ID_E, clientId: "client-drain" }),
      metadata: relayMetadata({ model: "gpt-5" }),
      reservedTokens: state.remaining - 5_000,
      upperBoundTokens: state.remaining - 5_000,
      maxOutputTokens: 0,
      cacheEnabled: false,
    });
    expect(drained.kind).toBe("admitted");
    // When: a decision needs more than the 5,000 remaining tokens.
    const result = await decide({
      context: relayContext({ requestId: REQUEST_ID_G }),
      body: decisionBody({ estimatedInputTokens: 4_000, maxOutputTokens: 4_000 }),
    });
    // Then: the quota rejection uses the mapped status.
    expectReject(result, "insufficient_quota");
  });

  it("derives the pool and admission day from classification and the DO clock", async () => {
    // Given: a decision for a MINI-pool model.
    const result = await decide({
      context: relayContext({ requestId: REQUEST_ID_D }),
      body: decisionBody({ model: "gpt-5-mini" }),
    });
    // Then: the grant and quota snapshot bind the MINI pool and today's UTC day.
    const allow = expectAllow(result);
    expect(allow.decision.quota.pool).toBe("MINI");
    const grant = await storedGrant("MINI", REQUEST_ID_D);
    expect(grant.pool).toBe("MINI");
    expect(grant.admissionUtcDay).toBe(utcDayOf(new Date()));
  });

  it("clamps output when the client policy is CLAMP", async () => {
    // Given: a MINI pool drained to 2,500,000 remaining under a CLAMP policy.
    await env.DB.prepare(
      "INSERT INTO clients (id, name, key_hash, enabled, created_at) VALUES ('client-clamp', 'clamp', ?, 1, ?)",
    )
      .bind("k".repeat(64), new Date().toISOString())
      .run();
    await env.DB.prepare(
      "INSERT INTO client_policies (client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode) VALUES ('client-clamp', 'REJECT', 'CLAMP', 0, 0, 'REJECT')",
    ).run();
    const state = await quotaStub("MINI").getState();
    const drained = await quotaStub("MINI").admitRelay({
      context: relayContext({ requestId: REQUEST_ID_E, clientId: "client-drain" }),
      metadata: relayMetadata({ model: "gpt-5-mini" }),
      reservedTokens: state.remaining - 2_500_000,
      upperBoundTokens: state.remaining - 2_500_000,
      maxOutputTokens: 0,
      cacheEnabled: false,
    });
    expect(drained.kind).toBe("admitted");
    // When: the decision requests more output than remaining allows.
    const result = await decide({
      context: relayContext({ requestId: REQUEST_ID_F, clientId: "client-clamp" }),
      body: decisionBody({ model: "gpt-5-mini", estimatedInputTokens: 500_000, maxOutputTokens: 2_000_000 }),
    });
    // Then: the allow decision clamps output to remaining minus input and margin.
    const allow = expectAllow(result);
    expect(allow.decision.maxOutputTokens).toBe(1_990_000);
    expect(allow.decision.quota.pool).toBe("MINI");
    expect(allow.decision.cacheEnabled).toBe(false);
  });

  it("releases the pre-activation grant and emits no allow when signing fails after admission", async () => {
    // Given: a QuotaController stub whose admitted grant has a non-safe-integer
    // claim, forcing grant signing to fail after atomic admission.
    const poisonedGrant: RelayGrant = {
      version: 1,
      requestId: REQUEST_ID_A,
      grantId: "1f0e5d1c-2b3a-4c5d-6e7f-8a9b0c1d2e3f",
      leaseGeneration: "2a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d",
      environment: "preview",
      clientId: CLIENT_ID,
      idempotencyKeyHash: null,
      nonce: NONCE,
      model: "gpt-5",
      pool: "STANDARD",
      admissionUtcDay: utcDayOf(new Date()),
      state: "authorized",
      issuedAtMs: 0.5,
      authorizationExpiresAtMs: 3_600_000.5,
      credentialExpiresAtMs: 3_900_000.5,
      retentionDeadlineMs: 0,
      admission: {
        contextIssuedAtMs: 1,
        contextExpiresAtMs: 2,
        metadata: relayMetadata(),
        reservedTokens: 300,
        upperBoundTokens: 300,
        maxOutputTokens: 200,
        cacheEnabled: false,
      },
      terminalReport: null,
      terminalFingerprint: null,
    };
    const finishCalls: FinishRelayInput[] = [];
    const fakeStub = {
      getState: async () => ({
        utcDay: utcDayOf(new Date()),
        limit: POOL_LIMITS.STANDARD,
        confirmedTokens: 0,
        reservedTokens: 0,
        uncertainTokens: 0,
        requestCount: 0,
        updatedAt: new Date().toISOString(),
        pool: "STANDARD" as const,
        remaining: POOL_LIMITS.STANDARD,
      }),
      admitRelay: async () => ({
        kind: "admitted" as const,
        grant: poisonedGrant,
        quota: { pool: "STANDARD", limit: POOL_LIMITS.STANDARD, used: 300, remaining: POOL_LIMITS.STANDARD - 300, resetAt: "2026-09-28T00:00:00Z" },
      }),
      finishRelay: async (input: FinishRelayInput) => {
        finishCalls.push(input);
        return { kind: "accepted" as const, grant: poisonedGrant, quota: {} };
      },
    };
    const fakeNamespace = { idFromName: (name: string) => name, get: (_id: string) => fakeStub };
    // When: the decision runs with the failing signing dependency.
    const result = await runInDurableObject(decisionStub(REQUEST_ID_A), async (instance) => {
      if (!hasDecideMethod(instance)) throw new TypeError("Expected a RelayDecisionController instance.");
      Object.assign(instance, { env: Object.assign({}, env, { QUOTA_CONTROLLER: fakeNamespace }) });
      return instance.decide(await dispatchInput());
    });
    // Then: no allow is emitted and the grant is released pre-activation.
    expect(result).toEqual({ kind: "internal_error", code: "internal_error" });
    expect(finishCalls.length).toBe(1);
    const release: FinishRelayInput | undefined = finishCalls[0];
    expect(release?.requestId).toBe(REQUEST_ID_A);
    expect(release?.grantId).toBe(poisonedGrant.grantId);
    expect(release?.leaseGeneration).toBe(poisonedGrant.leaseGeneration);
    const report: RelayTerminalV1 | undefined = release?.report;
    expect(report).toEqual({
      version: 1,
      grantId: poisonedGrant.grantId,
      leaseGeneration: poisonedGrant.leaseGeneration,
      outcome: "release",
      totalTokens: null,
    });
    expect(release?.reportFingerprint).toBe("release:null");
  });
});
