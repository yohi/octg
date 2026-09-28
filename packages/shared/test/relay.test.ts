import { describe, expect, it } from "vitest";
import {
  parseRelayActivation,
  parseRelayActivationResponse,
  parseRelayContext,
  parseRelayDecision,
  parseRelayDecisionRequest,
  parseRelayGrantCredential,
  parseRelayInternalError,
  parseRelayJsonBody,
  parseRelayRenewal,
  parseRelayRenewalResponse,
  parseRelayRequestMeta,
  parseRelayResponseMeta,
  parseRelayTerminal,
  parseRelayTerminalResponse,
  parseRelayQuotaSnapshot,
  relayErrorCodeStatus,
  RelayProtocolError,
} from "../src/index";

const REQUEST_ID = "req_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const GRANT_ID = "0f0e5d1c-2b3a-4c5d-6e7f-8a9b0c1d2e3f";
const LEASE_GENERATION = "9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d";
const NONCE = "bQ".repeat(21) + "b";
const KEY_HASH = "a".repeat(64);
const RESET_AT = "2026-09-28T00:00:00Z";
const ISSUED_AT_MS = 1_000_000_000_000;

const VALID_META = {
  model: "openai/gpt-test",
  estimatedInputTokens: 100,
  maxOutputTokens: 64,
  inputBytes: 10,
  rawBodyBytes: 12,
  isToolUse: false,
  stream: false,
};

const VALID_CONTEXT = {
  version: 1,
  audience: "octg-deno-relay",
  environment: "preview",
  route: "responses",
  requestId: REQUEST_ID,
  clientId: "client-1",
  idempotencyKeyHash: null,
  nonce: NONCE,
  issuedAtMs: ISSUED_AT_MS,
  expiresAtMs: ISSUED_AT_MS + 60_000,
};

const VALID_GRANT = {
  version: 1,
  audience: "octg-worker-relay",
  environment: "preview",
  route: "responses",
  requestId: REQUEST_ID,
  grantId: GRANT_ID,
  nonce: NONCE,
  clientId: "client-1",
  idempotencyKeyHash: KEY_HASH,
  model: "openai/gpt-test",
  pool: "STANDARD",
  admissionUtcDay: "2026-09-27",
  leaseGeneration: LEASE_GENERATION,
  issuedAtMs: ISSUED_AT_MS,
  expiresAtMs: ISSUED_AT_MS + 3_900_000,
};

const VALID_QUOTA = {
  pool: "STANDARD",
  limit: 1000,
  used: 100,
  remaining: 900,
  resetAt: RESET_AT,
};

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("parseRelayJsonBody", () => {
  it("returns the decoded JSON value when within the byte limit", () => {
    expect(parseRelayJsonBody(encode('{"a":1}'), 8_192)).toEqual({ a: 1 });
  });

  it("accepts a body of exactly maxBytes", () => {
    expect(parseRelayJsonBody(encode('{"a":1}'), 7)).toEqual({ a: 1 });
  });

  it("throws RelayProtocolError when the body exceeds maxBytes", () => {
    expect(() => parseRelayJsonBody(encode('{"a":1}'), 6)).toThrow(RelayProtocolError);
  });

  it("throws RelayProtocolError on invalid UTF-8", () => {
    expect(() => parseRelayJsonBody(new Uint8Array([0x22, 0xc0, 0x22]), 8_192)).toThrow(
      RelayProtocolError,
    );
  });

  it("throws RelayProtocolError on duplicate object keys", () => {
    expect(() => parseRelayJsonBody(encode('{"a":1,"a":2}'), 8_192)).toThrow(RelayProtocolError);
  });

  it("throws RelayProtocolError on keys colliding after unicode unescaping", () => {
    expect(() => parseRelayJsonBody(encode('{"\\u0061":1,"a":2}'), 8_192)).toThrow(
      RelayProtocolError,
    );
  });

  it("throws RelayProtocolError on nested duplicate keys", () => {
    expect(() => parseRelayJsonBody(encode('{"a":{"b":1,"b":2}}'), 8_192)).toThrow(
      RelayProtocolError,
    );
  });

  it("throws RelayProtocolError on malformed JSON", () => {
    expect(() => parseRelayJsonBody(encode("{nope"), 8_192)).toThrow(RelayProtocolError);
  });
});

describe("parseRelayRequestMeta", () => {
  it("accepts a complete metadata object with the exact field set", () => {
    expect(parseRelayRequestMeta(VALID_META)).toEqual(VALID_META);
  });

  it("rejects an extra key", () => {
    expect(parseRelayRequestMeta({ ...VALID_META, extra: 1 })).toBeUndefined();
  });

  it("rejects a missing key", () => {
    const { stream: _stream, ...missing } = VALID_META;
    expect(parseRelayRequestMeta(missing)).toBeUndefined();
  });

  it("rejects negative estimatedInputTokens", () => {
    expect(parseRelayRequestMeta({ ...VALID_META, estimatedInputTokens: -1 })).toBeUndefined();
  });

  it("rejects non-integer usage", () => {
    expect(parseRelayRequestMeta({ ...VALID_META, estimatedInputTokens: 1.5 })).toBeUndefined();
  });

  it("rejects a model over 256 UTF-8 bytes", () => {
    expect(parseRelayRequestMeta({ ...VALID_META, model: "あ".repeat(100) })).toBeUndefined();
  });

  it("rejects an empty model", () => {
    expect(parseRelayRequestMeta({ ...VALID_META, model: "" })).toBeUndefined();
  });

  it("rejects inputBytes above 1048576", () => {
    expect(parseRelayRequestMeta({ ...VALID_META, inputBytes: 1_048_577 })).toBeUndefined();
  });

  it("rejects non-boolean isToolUse", () => {
    expect(parseRelayRequestMeta({ ...VALID_META, isToolUse: "no" })).toBeUndefined();
  });
});

describe("parseRelayQuotaSnapshot", () => {
  it("accepts a valid quota snapshot", () => {
    expect(parseRelayQuotaSnapshot(VALID_QUOTA)).toEqual(VALID_QUOTA);
  });

  it("rejects an unknown pool", () => {
    expect(parseRelayQuotaSnapshot({ ...VALID_QUOTA, pool: "GOLD" })).toBeUndefined();
  });

  it("rejects a non-integer counter", () => {
    expect(parseRelayQuotaSnapshot({ ...VALID_QUOTA, used: 1.5 })).toBeUndefined();
  });

  it("rejects a negative counter", () => {
    expect(parseRelayQuotaSnapshot({ ...VALID_QUOTA, remaining: -1 })).toBeUndefined();
  });

  it("rejects a non-RFC3339 UTC resetAt", () => {
    expect(parseRelayQuotaSnapshot({ ...VALID_QUOTA, resetAt: "2026-09-28" })).toBeUndefined();
  });
});

describe("parseRelayDecisionRequest", () => {
  it("accepts a decision request with version 1 and metadata", () => {
    expect(parseRelayDecisionRequest({ version: 1, metadata: VALID_META })).toEqual({
      version: 1,
      metadata: VALID_META,
    });
  });

  it("rejects a version mismatch", () => {
    expect(parseRelayDecisionRequest({ version: 2, metadata: VALID_META })).toBeUndefined();
  });

  it("rejects invalid metadata", () => {
    expect(parseRelayDecisionRequest({ version: 1, metadata: { model: "" } })).toBeUndefined();
  });

  it("rejects an extra top-level key", () => {
    expect(
      parseRelayDecisionRequest({ version: 1, metadata: VALID_META, pool: "STANDARD" }),
    ).toBeUndefined();
  });
});

describe("parseRelayDecision", () => {
  it("accepts a valid reject envelope with the mapped status", () => {
    expect(parseRelayDecision({ version: 1, kind: "reject", code: "insufficient_quota", status: 429 })).toEqual({
      version: 1,
      kind: "reject",
      code: "insufficient_quota",
      status: 429,
    });
  });

  it("rejects a reject envelope whose status does not match the code mapping", () => {
    expect(
      parseRelayDecision({ version: 1, kind: "reject", code: "insufficient_quota", status: 400 }),
    ).toBeUndefined();
  });

  it("rejects a reject envelope with an unknown code", () => {
    expect(
      parseRelayDecision({ version: 1, kind: "reject", code: "not_a_code", status: 500 }),
    ).toBeUndefined();
  });

  it("accepts a valid allow envelope with the quota snapshot", () => {
    expect(
      parseRelayDecision({
        version: 1,
        kind: "allow",
        grantId: GRANT_ID,
        leaseGeneration: LEASE_GENERATION,
        maxOutputTokens: 64,
        cacheEnabled: false,
        quota: VALID_QUOTA,
      }),
    ).toEqual({
      version: 1,
      kind: "allow",
      grantId: GRANT_ID,
      leaseGeneration: LEASE_GENERATION,
      maxOutputTokens: 64,
      cacheEnabled: false,
      quota: VALID_QUOTA,
    });
  });

  it("rejects an allow envelope with a malformed grant identifier", () => {
    expect(
      parseRelayDecision({
        version: 1,
        kind: "allow",
        grantId: "not-a-uuid",
        leaseGeneration: LEASE_GENERATION,
        maxOutputTokens: 64,
        cacheEnabled: false,
        quota: VALID_QUOTA,
      }),
    ).toBeUndefined();
  });

  it("rejects a reject envelope carrying the grant credential", () => {
    expect(
      parseRelayDecision({
        version: 1,
        kind: "reject",
        code: "insufficient_quota",
        status: 429,
        grant: "credential",
      }),
    ).toBeUndefined();
  });
});

describe("parseRelayActivation", () => {
  it("accepts the activation request envelope", () => {
    expect(parseRelayActivation({ version: 1, grantId: GRANT_ID, leaseGeneration: LEASE_GENERATION })).toEqual({
      version: 1,
      grantId: GRANT_ID,
      leaseGeneration: LEASE_GENERATION,
    });
  });

  it("rejects a malformed lease generation", () => {
    expect(parseRelayActivation({ version: 1, grantId: GRANT_ID, leaseGeneration: "gen-1" })).toBeUndefined();
  });
});

describe("parseRelayActivationResponse", () => {
  it("accepts an activated response with a null code", () => {
    expect(parseRelayActivationResponse({ version: 1, activated: true, code: null })).toEqual({
      version: 1,
      activated: true,
      code: null,
    });
  });

  it("accepts a denied response with a listed denial code", () => {
    expect(parseRelayActivationResponse({ version: 1, activated: false, code: "lease_lost" })).toEqual({
      version: 1,
      activated: false,
      code: "lease_lost",
    });
  });

  it("rejects activated true with a non-null code", () => {
    expect(parseRelayActivationResponse({ version: 1, activated: true, code: "lease_lost" })).toBeUndefined();
  });

  it("rejects activated false with an unlisted code", () => {
    expect(parseRelayActivationResponse({ version: 1, activated: false, code: "insufficient_quota" })).toBeUndefined();
  });
});

describe("parseRelayRenewal", () => {
  it("accepts the renewal request envelope", () => {
    expect(parseRelayRenewal({ version: 1, grantId: GRANT_ID, leaseGeneration: LEASE_GENERATION })).toEqual({
      version: 1,
      grantId: GRANT_ID,
      leaseGeneration: LEASE_GENERATION,
    });
  });

  it("rejects an extra field", () => {
    expect(
      parseRelayRenewal({ version: 1, grantId: GRANT_ID, leaseGeneration: LEASE_GENERATION, totalTokens: 1 }),
    ).toBeUndefined();
  });
});

describe("parseRelayRenewalResponse", () => {
  it("accepts the renewal response envelope", () => {
    expect(parseRelayRenewalResponse({ version: 1, renewed: true, code: null })).toEqual({
      version: 1,
      renewed: true,
      code: null,
    });
  });

  it("rejects an unknown code", () => {
    expect(parseRelayRenewalResponse({ version: 1, renewed: false, code: "nope" })).toBeUndefined();
  });
});

describe("parseRelayTerminal", () => {
  it("accepts a settle request with integer totalTokens", () => {
    expect(
      parseRelayTerminal({ version: 1, grantId: GRANT_ID, leaseGeneration: LEASE_GENERATION, outcome: "settle", totalTokens: 123 }),
    ).toEqual({
      version: 1,
      grantId: GRANT_ID,
      leaseGeneration: LEASE_GENERATION,
      outcome: "settle",
      totalTokens: 123,
    });
  });

  it("accepts a release request with null totalTokens", () => {
    expect(
      parseRelayTerminal({ version: 1, grantId: GRANT_ID, leaseGeneration: LEASE_GENERATION, outcome: "release", totalTokens: null }),
    ).toEqual({
      version: 1,
      grantId: GRANT_ID,
      leaseGeneration: LEASE_GENERATION,
      outcome: "release",
      totalTokens: null,
    });
  });

  it("rejects settle without integer totalTokens", () => {
    expect(
      parseRelayTerminal({ version: 1, grantId: GRANT_ID, leaseGeneration: LEASE_GENERATION, outcome: "settle", totalTokens: null }),
    ).toBeUndefined();
  });

  it("rejects a non-settle outcome with non-null totalTokens", () => {
    expect(
      parseRelayTerminal({ version: 1, grantId: GRANT_ID, leaseGeneration: LEASE_GENERATION, outcome: "uncertain", totalTokens: 5 }),
    ).toBeUndefined();
  });

  it("rejects an unknown outcome", () => {
    expect(
      parseRelayTerminal({ version: 1, grantId: GRANT_ID, leaseGeneration: LEASE_GENERATION, outcome: "retry", totalTokens: null }),
    ).toBeUndefined();
  });

  it("rejects negative totalTokens", () => {
    expect(
      parseRelayTerminal({ version: 1, grantId: GRANT_ID, leaseGeneration: LEASE_GENERATION, outcome: "settle", totalTokens: -1 }),
    ).toBeUndefined();
  });
});

describe("parseRelayTerminalResponse", () => {
  it("accepts the terminal response envelope", () => {
    expect(parseRelayTerminalResponse({ version: 1, accepted: true, state: "settled", code: null })).toEqual({
      version: 1,
      accepted: true,
      state: "settled",
      code: null,
    });
  });

  it("rejects an unknown grant state", () => {
    expect(parseRelayTerminalResponse({ version: 1, accepted: false, state: "opened", code: "grant_expired" })).toBeUndefined();
  });
});

describe("parseRelayResponseMeta", () => {
  it("accepts the response metadata envelope", () => {
    expect(
      parseRelayResponseMeta({
        version: 1,
        requestId: REQUEST_ID,
        pool: "MINI",
        limit: 1000,
        used: 100,
        remaining: 900,
        resetAt: RESET_AT,
        route: "responses",
      }),
    ).toEqual({
      version: 1,
      requestId: REQUEST_ID,
      pool: "MINI",
      limit: 1000,
      used: 100,
      remaining: 900,
      resetAt: RESET_AT,
      route: "responses",
    });
  });

  it("rejects a wrong route value", () => {
    expect(
      parseRelayResponseMeta({
        version: 1,
        requestId: REQUEST_ID,
        pool: "MINI",
        limit: 1000,
        used: 100,
        remaining: 900,
        resetAt: RESET_AT,
        route: "free_shared",
      }),
    ).toBeUndefined();
  });

  it("rejects non-safe-integer counters", () => {
    expect(
      parseRelayResponseMeta({
        version: 1,
        requestId: REQUEST_ID,
        pool: "MINI",
        limit: 1000.5,
        used: 100,
        remaining: 900,
        resetAt: RESET_AT,
        route: "responses",
      }),
    ).toBeUndefined();
  });

  it("rejects a malformed request identifier", () => {
    expect(
      parseRelayResponseMeta({
        version: 1,
        requestId: "req_short",
        pool: "MINI",
        limit: 1000,
        used: 100,
        remaining: 900,
        resetAt: RESET_AT,
        route: "responses",
      }),
    ).toBeUndefined();
  });
});

describe("parseRelayInternalError", () => {
  it("accepts the internal error envelope", () => {
    expect(parseRelayInternalError({ version: 1, error: { code: "internal_error" } })).toEqual({
      version: 1,
      error: { code: "internal_error" },
    });
  });

  it("rejects a free-form message inside the error object", () => {
    expect(
      parseRelayInternalError({ version: 1, error: { code: "internal_error", message: "boom" } }),
    ).toBeUndefined();
  });

  it("rejects an unknown code", () => {
    expect(parseRelayInternalError({ version: 1, error: { code: "boom" } })).toBeUndefined();
  });
});

describe("parseRelayContext", () => {
  it("accepts valid claims with the existing req_ ULID request identifier", () => {
    expect(parseRelayContext(VALID_CONTEXT)).toEqual(VALID_CONTEXT);
  });

  it("accepts a 64 lowercase hex idempotency key hash", () => {
    expect(parseRelayContext({ ...VALID_CONTEXT, idempotencyKeyHash: KEY_HASH })).toEqual({
      ...VALID_CONTEXT,
      idempotencyKeyHash: KEY_HASH,
    });
  });

  it("rejects a wrong environment", () => {
    expect(parseRelayContext({ ...VALID_CONTEXT, environment: "staging" })).toBeUndefined();
  });

  it("rejects a wrong audience", () => {
    expect(parseRelayContext({ ...VALID_CONTEXT, audience: "octg-worker-relay" })).toBeUndefined();
  });

  it("rejects a context lifetime above 60,000 ms", () => {
    expect(
      parseRelayContext({ ...VALID_CONTEXT, expiresAtMs: ISSUED_AT_MS + 60_001 }),
    ).toBeUndefined();
  });

  it("rejects a non-positive context lifetime", () => {
    expect(parseRelayContext({ ...VALID_CONTEXT, expiresAtMs: ISSUED_AT_MS })).toBeUndefined();
  });

  it("rejects a malformed request identifier", () => {
    expect(parseRelayContext({ ...VALID_CONTEXT, requestId: "req_0123456789ABCDEFGHIJKLMNOPQRSTUV" })).toBeUndefined();
  });

  it("rejects an invalid idempotency key hash", () => {
    expect(parseRelayContext({ ...VALID_CONTEXT, idempotencyKeyHash: "A".repeat(64) })).toBeUndefined();
  });

  it("rejects an invalid nonce", () => {
    expect(parseRelayContext({ ...VALID_CONTEXT, nonce: "bQ".repeat(21) })).toBeUndefined();
  });

  it("rejects non-integer timestamps", () => {
    expect(parseRelayContext({ ...VALID_CONTEXT, issuedAtMs: 1_000_000_000_000.5 })).toBeUndefined();
  });

  it("rejects an unknown claim", () => {
    expect(parseRelayContext({ ...VALID_CONTEXT, model: "openai/gpt-test" })).toBeUndefined();
  });
});

describe("parseRelayGrantCredential", () => {
  it("accepts valid grant claims", () => {
    expect(parseRelayGrantCredential(VALID_GRANT)).toEqual(VALID_GRANT);
  });

  it("rejects a malformed grant identifier", () => {
    expect(parseRelayGrantCredential({ ...VALID_GRANT, grantId: "0f0e5d1c" })).toBeUndefined();
  });

  it("rejects a credential lifetime other than 3,900,000 ms", () => {
    expect(
      parseRelayGrantCredential({ ...VALID_GRANT, expiresAtMs: ISSUED_AT_MS + 3_600_000 }),
    ).toBeUndefined();
  });

  it("rejects an invalid pool", () => {
    expect(parseRelayGrantCredential({ ...VALID_GRANT, pool: "GOLD" })).toBeUndefined();
  });

  it("rejects a malformed admission UTC day", () => {
    expect(parseRelayGrantCredential({ ...VALID_GRANT, admissionUtcDay: "20260927" })).toBeUndefined();
  });

  it("rejects a wrong grant audience", () => {
    expect(parseRelayGrantCredential({ ...VALID_GRANT, audience: "octg-deno-relay" })).toBeUndefined();
  });

  it("rejects a model over 256 UTF-8 bytes", () => {
    expect(parseRelayGrantCredential({ ...VALID_GRANT, model: "あ".repeat(100) })).toBeUndefined();
  });

  it("rejects a client identifier over 128 UTF-8 bytes", () => {
    expect(parseRelayGrantCredential({ ...VALID_GRANT, clientId: "あ".repeat(50) })).toBeUndefined();
  });
});

describe("relayErrorCodeStatus", () => {
  it("maps business codes to their public statuses", () => {
    expect(relayErrorCodeStatus("invalid_request")).toBe(400);
    expect(relayErrorCodeStatus("client_disabled")).toBe(403);
    expect(relayErrorCodeStatus("model_requires_paid")).toBe(403);
    expect(relayErrorCodeStatus("model_not_allowed")).toBe(403);
    expect(relayErrorCodeStatus("duplicate_idempotency_key")).toBe(409);
    expect(relayErrorCodeStatus("request_too_large")).toBe(413);
    expect(relayErrorCodeStatus("insufficient_quota")).toBe(429);
    expect(relayErrorCodeStatus("worker_concurrency_exceeded")).toBe(429);
  });

  it("maps internal relay failures to 500", () => {
    expect(relayErrorCodeStatus("invalid_context")).toBe(500);
    expect(relayErrorCodeStatus("unauthorized_service")).toBe(500);
    expect(relayErrorCodeStatus("environment_mismatch")).toBe(500);
    expect(relayErrorCodeStatus("grant_not_found")).toBe(500);
    expect(relayErrorCodeStatus("grant_expired")).toBe(500);
    expect(relayErrorCodeStatus("grant_replayed")).toBe(500);
    expect(relayErrorCodeStatus("grant_terminalized")).toBe(500);
    expect(relayErrorCodeStatus("lease_lost")).toBe(500);
    expect(relayErrorCodeStatus("upstream_error")).toBe(500);
    expect(relayErrorCodeStatus("upstream_timeout")).toBe(500);
    expect(relayErrorCodeStatus("upstream_invalid_response")).toBe(500);
    expect(relayErrorCodeStatus("internal_error")).toBe(500);
  });
});
