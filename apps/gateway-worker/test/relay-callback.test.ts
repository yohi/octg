import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { isRecord, quotaIdOf, signRelayContext, signRelayGrantCredential, utcDayOf, verifyRelayGrantCredential } from "@octg/shared";
import type { RelayContextV1, RelayRequestMetaV1 } from "@octg/shared";
import type { QuotaController } from "@octg/quota-controller";
import type { RelayGrant } from "../../../durable-objects/quota-controller/src/relay-grant";

const REQUEST_ID_H = "req_01ARZ3NDEKTSV4RRFFQ69G5FHJ";
const REQUEST_ID_J = "req_01ARZ3NDEKTSV4RRFFQ69G5FJN";
const REQUEST_ID_K = "req_01ARZ3NDEKTSV4RRFFQ69G5FKP";
const REQUEST_ID_M = "req_01ARZ3NDEKTSV4RRFFQ69G5FMR";
const REQUEST_ID_N = "req_01ARZ3NDEKTSV4RRFFQ69G5FNR";
const REQUEST_ID_P = "req_01ARZ3NDEKTSV4RRFFQ69G5FPR";
const REQUEST_ID_R = "req_01ARZ3NDEKTSV4RRFFQ69G5FRR";
const REQUEST_ID_T = "req_01ARZ3NDEKTSV4RRFFQ69G5FTR";
const REQUEST_ID_Q = "req_01ARZ3NDEKTSV4RRFFQ69G5FQH";
const REQUEST_ID_S = "req_01ARZ3NDEKTSV4RRFFQ69G5FSJ";
const REQUEST_ID_V = "req_01ARZ3NDEKTSV4RRFFQ69G5FVH";
const NONCE = "bQ".repeat(21) + "b";
const HMAC_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const HMAC_KEY_ENCODED = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const WRONG_KEY = Uint8Array.from({ length: 32 }, (_, index) => 31 - index);
const CLIENT_ID = "client-relay";

const BASE = "https://worker.example/internal/relay/v1";

const quotaStub = (pool: "STANDARD" | "MINI"): DurableObjectStub<QuotaController> =>
  env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, utcDayOf(new Date()))));

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected a JSON object");
  return value;
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a JSON string");
  return value;
}

async function countRows(table: "requests" | "daily_usage"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  if (row === null) throw new Error(`expected a count row for ${table}`);
  return row.count;
}

function relayContext(overrides: Partial<RelayContextV1> = {}): RelayContextV1 {
  const issuedAtMs = Date.now();
  return {
    version: 1,
    audience: "octg-deno-relay",
    environment: "preview",
    route: "responses",
    requestId: REQUEST_ID_H,
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

function serviceAuth(): Record<string, string> {
  return { Authorization: `Bearer ${env.OCTG_RELAY_SERVICE_AUTH_TOKEN}` };
}

function callbackRequest(
  action: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {},
): Request {
  return new Request(`${BASE}/${action}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...serviceAuth(), ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

async function decisionCallback(options: {
  token?: string;
  body?: BodyInit;
  idempotencyKey?: string;
}): Promise<Response> {
  const headers: Record<string, string> = {
    "X-OCTG-Relay-Context": options.token ?? "payload.sig",
  };
  if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = options.idempotencyKey;
  return SELF.fetch(callbackRequest("decision", { headers, body: options.body ?? "{}" }));
}

async function allowDecision(context: RelayContextV1, metadata: RelayRequestMetaV1): Promise<{
  grantCredential: string;
  grantId: string;
  leaseGeneration: string;
}> {
  const response = await SELF.fetch(
    callbackRequest("decision", {
      headers: { "X-OCTG-Relay-Context": await signRelayContext(context, HMAC_KEY) },
      body: JSON.stringify({ version: 1, metadata }),
    }),
  );
  expect(response.status).toBe(200);
  const body = asRecord(await response.json());
  expect(body.kind).toBe("allow");
  const grantCredential = response.headers.get("X-OCTG-Relay-Grant");
  if (grantCredential === null) throw new Error("expected the grant credential header");
  return {
    grantCredential,
    grantId: asString(body.grantId),
    leaseGeneration: asString(body.leaseGeneration),
  };
}

async function activateGrant(allow: {
  grantCredential: string;
  grantId: string;
  leaseGeneration: string;
}): Promise<Response> {
  return SELF.fetch(
    callbackRequest("activation", {
      headers: { "X-OCTG-Relay-Grant": allow.grantCredential },
      body: JSON.stringify({ version: 1, grantId: allow.grantId, leaseGeneration: allow.leaseGeneration }),
    }),
  );
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

describe("relay callback transport", () => {
  it.each(["GET", "PUT"])("rejects %s with 405 and Allow: POST", async (method) => {
    // Given: a relay callback route.
    // When: a non-POST method is used.
    const response = await SELF.fetch(callbackRequest("decision", { method }));
    // Then: the method is rejected with the Allow header.
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  it("returns 404 for unknown internal relay sub-paths", async () => {
    // Given: an authenticated request.
    // When: it targets an undefined callback action.
    const response = await SELF.fetch(callbackRequest("other", { body: "{}" }));
    // Then: the route does not exist.
    expect(response.status).toBe(404);
  });

  it("rejects an invalid service bearer with 401", async () => {
    // Given: a wrong service token.
    const response = await SELF.fetch(
      new Request(`${BASE}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${"x".repeat(32)}` },
        body: "{}",
      }),
    );
    // Then: authentication fails with the unauthorized_service envelope.
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ version: 1, error: { code: "unauthorized_service" } });
  });

  it("fails closed with 500 when the relay configuration is disabled", async () => {
    // Given: the relay enable flag is absent.
    const enabled = env.OCTG_RELAY_ENABLED;
    Reflect.deleteProperty(env, "OCTG_RELAY_ENABLED");
    try {
      // When: a decision callback arrives.
      const response = await SELF.fetch(callbackRequest("decision", { body: "{}" }));
      // Then: the callback fails closed as an internal error.
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ version: 1, error: { code: "internal_error" } });
    } finally {
      Object.assign(env, { OCTG_RELAY_ENABLED: enabled });
    }
  });

  it.each([
    ["a text content type", "text/plain"],
    ["a missing content type", null],
    ["a foreign charset", "application/json; charset=utf-16"],
  ] as const)("rejects $0 with 400", async (_name, contentType) => {
    // Given: a request whose content type is not application/json (utf-8 only).
    const headers: Record<string, string> = { ...serviceAuth() };
    if (contentType !== null) headers["content-type"] = contentType;
    // When: the decision callback arrives.
    const response = await SELF.fetch(new Request(`${BASE}/decision`, { method: "POST", headers, body: "{}" }));
    // Then: the content type is rejected.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ version: 1, error: { code: "invalid_request" } });
  });

  it("accepts case-insensitive application/json with optional utf-8 charset", async () => {
    // Given: a decision with an acceptable content type variant.
    // When: the callback arrives without a context header.
    const response = await SELF.fetch(
      new Request(`${BASE}/decision`, {
        method: "POST",
        headers: { ...serviceAuth(), "content-type": "Application/JSON; Charset=UTF-8" },
        body: "{}",
      }),
    );
    // Then: only the missing context rejects the callback.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ version: 1, error: { code: "invalid_context" } });
  });

  it("rejects missing and over-bound context headers with 400", async () => {
    // Given: callbacks whose context header is absent or beyond 4,096 bytes.
    // When: each callback arrives.
    const missing = await SELF.fetch(callbackRequest("decision", { body: "{}" }));
    const oversized = await SELF.fetch(
      callbackRequest("decision", {
        headers: { "X-OCTG-Relay-Context": "a".repeat(4_097) },
        body: "{}",
      }),
    );
    // Then: both fail as invalid context.
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ version: 1, error: { code: "invalid_context" } });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toEqual({ version: 1, error: { code: "invalid_context" } });
  });

  it("rejects an over-limit Idempotency-Key with 400", async () => {
    // Given: a key header beyond 255 UTF-8 bytes.
    // When: the decision callback arrives.
    const response = await decisionCallback({ idempotencyKey: "k".repeat(256) });
    // Then: the key bound is rejected at the transport boundary.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ version: 1, error: { code: "invalid_request" } });
  });

  it("rejects an over-limit body with 413", async () => {
    // Given: a decision body beyond 8,192 bytes.
    // When: the callback arrives.
    const response = await decisionCallback({ body: new Uint8Array(8_193).fill(0x61) });
    // Then: the body-size violation is reported with 413.
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ version: 1, error: { code: "request_too_large" } });
  });

  it.each([
    ["a single-segment token", "garbage"],
    ["a non-JSON payload", `${btoa("not-json").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}.sig`],
    [
      "a request id outside the identifier syntax",
      `${btoa(JSON.stringify({ requestId: "wrong" })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}.sig`,
    ],
  ] as const)("rejects $0 as a malformed routing hint", async (_name, token) => {
    // Given: a context token whose payload yields no valid request id hint.
    // When: the decision callback arrives.
    const response = await decisionCallback({ token });
    // Then: routing fails as invalid context without dispatching.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ version: 1, error: { code: "invalid_context" } });
  });
});

describe("decision callback dispatch", () => {
  it("returns an allow envelope with the grant credential only in the header", async () => {
    // Given: a valid signed context and decision body.
    const response = await SELF.fetch(
      callbackRequest("decision", {
        headers: { "X-OCTG-Relay-Context": await signRelayContext(relayContext({ requestId: REQUEST_ID_H }), HMAC_KEY) },
        body: JSON.stringify({ version: 1, metadata: relayMetadata() }),
      }),
    );
    // Then: HTTP 200 carries the allow envelope and the signed grant header.
    expect(response.status).toBe(200);
    const body = asRecord(await response.json());
    expect(Object.keys(body).sort()).toEqual([
      "cacheEnabled",
      "grantId",
      "kind",
      "leaseGeneration",
      "maxOutputTokens",
      "quota",
      "version",
    ]);
    expect(body.kind).toBe("allow");
    expect(body.maxOutputTokens).toBe(200);
    const grantCredential = response.headers.get("X-OCTG-Relay-Grant");
    expect(grantCredential).not.toBeNull();
    const claims = await verifyRelayGrantCredential(grantCredential ?? "", HMAC_KEY, "preview", Date.now());
    expect(claims?.requestId).toBe(REQUEST_ID_H);
    expect(claims?.model).toBe("gpt-5");
    expect(claims?.pool).toBe("STANDARD");
  });

  it("keeps policy and quota rejections at HTTP 200 with the reject envelope", async () => {
    // Given: a decision for an unregistered model.
    const response = await SELF.fetch(
      callbackRequest("decision", {
        headers: { "X-OCTG-Relay-Context": await signRelayContext(relayContext({ requestId: REQUEST_ID_J }), HMAC_KEY) },
        body: JSON.stringify({ version: 1, metadata: relayMetadata({ model: "gpt-relay-unknown" }) }),
      }),
    );
    // Then: the rejection stays a valid 200 envelope.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      kind: "reject",
      code: "model_requires_paid",
      status: 403,
    });
  });

  it("maps protocol errors to 400 without any quota movement", async () => {
    // Given: a decision whose key binding cannot match, and a token whose
    // signature the DO will reject.
    const mismatch = await decisionCallback({
      token: await signRelayContext(relayContext({ requestId: REQUEST_ID_K }), HMAC_KEY),
      body: JSON.stringify({ version: 1, metadata: relayMetadata() }),
      idempotencyKey: "raw-key-1",
    });
    const badSignature = await decisionCallback({
      token: await signRelayContext(relayContext({ requestId: REQUEST_ID_K }), WRONG_KEY),
    });
    // Then: protocol errors are 400 with the exact envelope codes.
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({ version: 1, error: { code: "invalid_request" } });
    expect(badSignature.status).toBe(400);
    expect(await badSignature.json()).toEqual({ version: 1, error: { code: "invalid_context" } });
  });

  it("treats an empty Idempotency-Key header as absent", async () => {
    // Given: a context with a null hash and an empty key header.
    const response = await decisionCallback({
      token: await signRelayContext(relayContext({ requestId: REQUEST_ID_M }), HMAC_KEY),
      body: JSON.stringify({ version: 1, metadata: relayMetadata() }),
      idempotencyKey: "",
    });
    // Then: the decision is allowed without a key binding.
    expect(response.status).toBe(200);
    expect(asRecord(await response.json()).kind).toBe("allow");
  });
});

describe("activation, renewal, and terminal callbacks", () => {
  it("activates through the QuotaController identity selected from the verified grant", async () => {
    // Given: an allowed MINI decision whose grant credential was delivered.
    const allow = await allowDecision(
      relayContext({ requestId: REQUEST_ID_N }),
      relayMetadata({ model: "gpt-5-mini" }),
    );
    // When: the activation callback presents the grant credential.
    const response = await activateGrant(allow);
    // Then: activation succeeds and the grant lives on the MINI quota object.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, activated: true, code: null });
    const grant = await runInDurableObject(quotaStub("MINI"), (_instance, state) =>
      state.storage.get<RelayGrant>(`relay-grant:${REQUEST_ID_N}`),
    );
    expect(grant?.state).toBe("attempted");
    expect(grant?.pool).toBe("MINI");
  });

  it("reports duplicate activation without transport failure", async () => {
    // Given: an allowed decision activated once.
    const allow = await allowDecision(relayContext({ requestId: REQUEST_ID_J }), relayMetadata());
    const first = await activateGrant(allow);
    expect(first.status).toBe(200);
    // When: the same activation is attempted again.
    const duplicate = await activateGrant(allow);
    // Then: the duplicate reports the definitive denial code.
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ version: 1, activated: false, code: "grant_replayed" });
  });

  it("rejects invalid and missing grant headers with 400", async () => {
    // Given: activation callbacks whose grant header is missing or foreign-signed.
    const missing = await SELF.fetch(
      callbackRequest("activation", { body: JSON.stringify({ version: 1, grantId: "x", leaseGeneration: "y" }) }),
    );
    const foreign = await SELF.fetch(
      callbackRequest("activation", {
        headers: { "X-OCTG-Relay-Grant": "not-a-grant" },
        body: JSON.stringify({ version: 1, grantId: "x", leaseGeneration: "y" }),
      }),
    );
    // Then: both fail as invalid context.
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ version: 1, error: { code: "invalid_context" } });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toEqual({ version: 1, error: { code: "invalid_context" } });
  });

  it("renews only after activation", async () => {
    // Given: an allowed decision and its grant credential.
    const allow = await allowDecision(relayContext({ requestId: REQUEST_ID_K }), relayMetadata());
    const renewalHeaders = { "X-OCTG-Relay-Grant": allow.grantCredential };
    const renewalBody = JSON.stringify({ version: 1, grantId: allow.grantId, leaseGeneration: allow.leaseGeneration });
    // When: renewal arrives before activation, then after activation.
    const before = await SELF.fetch(callbackRequest("renewal", { headers: renewalHeaders, body: renewalBody }));
    await activateGrant(allow);
    const after = await SELF.fetch(callbackRequest("renewal", { headers: renewalHeaders, body: renewalBody }));
    // Then: the pre-activation renewal is denied and the post-activation one renews.
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ version: 1, renewed: false, code: "invalid_request" });
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ version: 1, renewed: true, code: null });
  });

  it("releases a pre-activation grant, replays the saved result, and rejects conflicting reports", async () => {
    // Given: an allowed decision released before activation.
    const allow = await allowDecision(relayContext({ requestId: REQUEST_ID_P }), relayMetadata());
    const headers = { "X-OCTG-Relay-Grant": allow.grantCredential };
    const releaseBody = JSON.stringify({
      version: 1,
      grantId: allow.grantId,
      leaseGeneration: allow.leaseGeneration,
      outcome: "release",
      totalTokens: null,
    });
    const release = await SELF.fetch(callbackRequest("terminal", { headers, body: releaseBody }));
    expect(release.status).toBe(200);
    expect(await release.json()).toEqual({ version: 1, accepted: true, state: "released", code: null });
    // When: the exact report replays and then a conflicting report arrives.
    const replay = await SELF.fetch(callbackRequest("terminal", { headers, body: releaseBody }));
    const conflict = await SELF.fetch(
      callbackRequest("terminal", {
        headers,
        body: JSON.stringify({
          version: 1,
          grantId: allow.grantId,
          leaseGeneration: allow.leaseGeneration,
          outcome: "uncertain",
          totalTokens: null,
        }),
      }),
    );
    // Then: the replay returns the saved result; the conflict is terminalized.
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ version: 1, accepted: true, state: "released", code: null });
    expect(conflict.status).toBe(200);
    expect(await conflict.json()).toEqual({
      version: 1,
      accepted: false,
      state: "uncertain",
      code: "grant_terminalized",
    });
  });

  it("settles an activated grant and reports terminal conflicts on the settled state", async () => {
    // Given: an activated grant.
    const allow = await allowDecision(relayContext({ requestId: REQUEST_ID_R }), relayMetadata());
    await activateGrant(allow);
    const headers = { "X-OCTG-Relay-Grant": allow.grantCredential };
    // When: the terminal settle report arrives, then a conflicting release.
    const settle = await SELF.fetch(
      callbackRequest("terminal", {
        headers,
        body: JSON.stringify({
          version: 1,
          grantId: allow.grantId,
          leaseGeneration: allow.leaseGeneration,
          outcome: "settle",
          totalTokens: 42,
        }),
      }),
    );
    const conflict = await SELF.fetch(
      callbackRequest("terminal", {
        headers,
        body: JSON.stringify({
          version: 1,
          grantId: allow.grantId,
          leaseGeneration: allow.leaseGeneration,
          outcome: "release",
          totalTokens: null,
        }),
      }),
    );
    // Then: the settle is accepted and the post-settlement report is terminalized.
    expect(settle.status).toBe(200);
    expect(await settle.json()).toEqual({ version: 1, accepted: true, state: "settled", code: null });
    expect(conflict.status).toBe(200);
    expect(await conflict.json()).toEqual({
      version: 1,
      accepted: false,
      state: "uncertain",
      code: "grant_terminalized",
    });
  });

  it("rejects malformed activation bodies with 400 and over-limit bodies with 413", async () => {
    // Given: an allowed decision providing a valid grant credential.
    const allow = await allowDecision(relayContext({ requestId: REQUEST_ID_T }), relayMetadata());
    const headers = { "X-OCTG-Relay-Grant": allow.grantCredential };
    // When: the activation body is malformed, then over limit.
    const malformed = await SELF.fetch(
      callbackRequest("activation", { headers, body: JSON.stringify({ version: 1, grantId: allow.grantId }) }),
    );
    const oversized = await SELF.fetch(
      callbackRequest("activation", { headers, body: new Uint8Array(8_193).fill(0x61) }),
    );
    // Then: envelope failures and size violations map to their transport statuses.
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ version: 1, error: { code: "invalid_request" } });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ version: 1, error: { code: "request_too_large" } });
  });

  it("retries a lost decision acknowledgement with the identical input through HTTP", async () => {
    // Given: a first decision that admitted atomically.
    const context = relayContext({ requestId: REQUEST_ID_Q });
    const headers = { "X-OCTG-Relay-Context": await signRelayContext(context, HMAC_KEY) };
    const body = JSON.stringify({ version: 1, metadata: relayMetadata() });
    const first = await SELF.fetch(callbackRequest("decision", { headers, body }));
    expect(first.status).toBe(200);
    const firstBody = asRecord(await first.json());
    expect(firstBody.kind).toBe("allow");

    // When: the identical decision replays after the first allow was lost.
    const retry = await SELF.fetch(callbackRequest("decision", { headers, body }));

    // Then: the same grant returns without a second reservation.
    expect(retry.status).toBe(200);
    const retryBody = asRecord(await retry.json());
    expect(retryBody.kind).toBe("allow");
    expect(retryBody.grantId).toBe(firstBody.grantId);
    expect(retryBody.leaseGeneration).toBe(firstBody.leaseGeneration);
    expect(retryBody.quota).toEqual(firstBody.quota);
  });

  it("moves the relay quota lifecycle without any D1 write", async () => {
    // Given: current audit and usage projection row counts.
    const requestsBefore = await countRows("requests");
    const usageBefore = await countRows("daily_usage");

    // When: a full relay lifecycle runs through the callbacks.
    const allow = await allowDecision(relayContext({ requestId: REQUEST_ID_S }), relayMetadata());
    const activation = await activateGrant(allow);
    expect(activation.status).toBe(200);
    const settle = await SELF.fetch(
      callbackRequest("terminal", {
        headers: { "X-OCTG-Relay-Grant": allow.grantCredential },
        body: JSON.stringify({
          version: 1,
          grantId: allow.grantId,
          leaseGeneration: allow.leaseGeneration,
          outcome: "settle",
          totalTokens: 7,
        }),
      }),
    );
    expect(settle.status).toBe(200);

    // Then: D1 projections are untouched; quota authority stayed in the DO.
    expect(await countRows("requests")).toBe(requestsBefore);
    expect(await countRows("daily_usage")).toBe(usageBefore);
  });

  it("routes a late callback across UTC midnight to the admission-day QuotaController", async () => {
    // Given: a grant admitted on a past UTC day.
    const pastDay = "2026-01-01";
    const pastStub = env.QUOTA_CONTROLLER.get(
      env.QUOTA_CONTROLLER.idFromName(quotaIdOf("STANDARD", pastDay)),
    );
    const admitted = await pastStub.admitRelay({
      context: relayContext({ requestId: REQUEST_ID_V }),
      metadata: relayMetadata({ model: "gpt-5" }),
      reservedTokens: 300,
      upperBoundTokens: 300,
      maxOutputTokens: 200,
      cacheEnabled: false,
    });
    if (admitted.kind !== "admitted") throw new Error(`expected admitted, got ${admitted.kind}`);
    const grant = admitted.grant;
    expect(grant.admissionUtcDay).toBe(pastDay);
    const credential = await signRelayGrantCredential({
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
    }, HMAC_KEY);

    // When: the activation callback arrives on a later UTC day.
    const response = await SELF.fetch(
      callbackRequest("activation", {
        headers: { "X-OCTG-Relay-Grant": credential },
        body: JSON.stringify({ version: 1, grantId: grant.grantId, leaseGeneration: grant.leaseGeneration }),
      }),
    );

    // Then: the Worker reconstructs the admission-day identity and activates there.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, activated: true, code: null });
    const lateGrant = await runInDurableObject(pastStub, (_instance, state) =>
      state.storage.get<RelayGrant>(`relay-grant:${grant.requestId}`));
    expect(lateGrant?.state).toBe("attempted");
    const todayGrant = await runInDurableObject(quotaStub("STANDARD"), (_instance, state) =>
      state.storage.get<RelayGrant>(`relay-grant:${grant.requestId}`));
    expect(todayGrant).toBeUndefined();
  });
});
