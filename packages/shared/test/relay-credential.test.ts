import { describe, expect, it } from "vitest";
import {
  RELAY_CONTEXT_PURPOSE,
  RELAY_GRANT_PURPOSE,
  compareRelayBearerConstantTime,
  decodeRelayContextHmacKey,
  signRelayContext,
  signRelayGrantCredential,
  verifyRelayContext,
  verifyRelayGrantCredential,
} from "../src/index";
import type { RelayContextV1, RelayGrantCredentialV1 } from "../src/index";

const REQUEST_ID = "req_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FORGED_REQUEST_ID = "req_01ARZ3NDEKTSV4RRFFQ69G5FBV";
const GRANT_ID = "0f0e5d1c-2b3a-4c5d-6e7f-8a9b0c1d2e3f";
const LEASE_GENERATION = "9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d";
const NONCE = "bQ".repeat(21) + "b";
const KEY_HASH = "a".repeat(64);
const ISSUED_AT_MS = 1_000_000_000_000;
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const OTHER_KEY = new Uint8Array(32).fill(0x5a);

const CONTEXT: RelayContextV1 = {
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

const GRANT: RelayGrantCredentialV1 = {
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

const UTF8 = new TextEncoder();

function toBase64UrlNoPadding(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmacForTest(key: Uint8Array, purpose: string, payload: Uint8Array): Promise<Uint8Array> {
  const purposeBytes = UTF8.encode(purpose);
  const input = new Uint8Array(purposeBytes.byteLength + 1 + payload.byteLength);
  input.set(purposeBytes, 0);
  input.set(payload, purposeBytes.byteLength + 1);
  // Fresh ArrayBuffer-backed copy: BufferSource rejects ArrayBufferLike views.
  const keyBytes = new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, input));
}

/** Signs arbitrary claim text so tests can craft tokens the signer must reject. */
async function signRawClaims(text: string, key: Uint8Array, purpose: string): Promise<string> {
  const payload = UTF8.encode(text);
  return `${toBase64UrlNoPadding(payload)}.${toBase64UrlNoPadding(await hmacForTest(key, purpose, payload))}`;
}

/** Canonical JSON text for ASCII fixture claims (sorted keys, no escapes needed). */
function claimText(claims: object): string {
  const parts = Object.entries(claims)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`);
  return `{${parts.join(",")}}`;
}

describe("signRelayContext and verifyRelayContext", () => {
  it("round-trips context claims through sign and verify", async () => {
    // Given: a valid preview context and its environment key.
    const token = await signRelayContext(CONTEXT, KEY);

    // When: the token is verified with the same key, environment, and now.
    const verified = await verifyRelayContext(token, KEY, "preview", ISSUED_AT_MS);

    // Then: the verified claims equal the signed claims and the token is compact.
    expect(verified).toEqual(CONTEXT);
    expect(token.split(".")).toHaveLength(2);
    expect(token).not.toContain("=");
  });

  it("produces an identical token for identical claims and key", async () => {
    // Given: the same context signed twice.
    const first = await signRelayContext(CONTEXT, KEY);
    const second = await signRelayContext(CONTEXT, KEY);

    // When: the tokens are compared.
    // Then: signing is deterministic.
    expect(second).toBe(first);
  });

  it("round-trips a production context with a non-null idempotencyKeyHash", async () => {
    // Given: a production context carrying a key hash.
    const context: RelayContextV1 = { ...CONTEXT, environment: "production", idempotencyKeyHash: KEY_HASH };
    const token = await signRelayContext(context, KEY);

    // When: the token is verified against production.
    const verified = await verifyRelayContext(token, KEY, "production", ISSUED_AT_MS);

    // Then: the claims survive the round trip unchanged.
    expect(verified).toEqual(context);
  });

  it("rejects a tampered signature segment", async () => {
    // Given: a valid token with one MAC character replaced.
    const token = await signRelayContext(CONTEXT, KEY);
    const lastCharacter = token.slice(-1);
    const tampered = `${token.slice(0, -1)}${lastCharacter === "A" ? "B" : "A"}`;

    // When: the tampered token is verified.
    const verified = await verifyRelayContext(tampered, KEY, "preview", ISSUED_AT_MS);

    // Then: verification fails without leaking claims.
    expect(verified).toBeUndefined();
  });

  it("rejects a forged payload segment that reuses the original signature", async () => {
    // Given: a valid token and a canonical forged payload of identical byte
    // length (different requestId and clientId) carrying the original MAC.
    const token = await signRelayContext(CONTEXT, KEY);
    const [, macSegment] = token.split(".");
    if (macSegment === undefined) throw new Error("fixture token must contain a MAC segment");
    const forged = claimText({ ...CONTEXT, requestId: FORGED_REQUEST_ID, clientId: "client-2" });
    const forgedToken = `${toBase64UrlNoPadding(UTF8.encode(forged))}.${macSegment}`;

    // When: the forged token is verified.
    const verified = await verifyRelayContext(forgedToken, KEY, "preview", ISSUED_AT_MS);

    // Then: the transplanted signature does not authorize different claims.
    expect(verified).toBeUndefined();
  });

  it("rejects a token signed with a different key", async () => {
    // Given: a token signed with one 32-byte key.
    const token = await signRelayContext(CONTEXT, KEY);

    // When: it is verified with a different 32-byte key.
    const verified = await verifyRelayContext(token, OTHER_KEY, "preview", ISSUED_AT_MS);

    // Then: verification fails.
    expect(verified).toBeUndefined();
  });

  it("rejects a context token checked with the grant purpose", async () => {
    // Given: a validly signed context token.
    const token = await signRelayContext(CONTEXT, KEY);

    // When: it is submitted where a grant credential is expected.
    const verified = await verifyRelayGrantCredential(token, KEY, "preview", ISSUED_AT_MS);

    // Then: the purpose separation rejects it.
    expect(verified).toBeUndefined();
  });

  it.each([
    ["version", { version: 2 }],
    ["audience", { audience: "octg-other" }],
    ["environment", { environment: "production" }],
  ] as const)("rejects a wrong %s claim even with a valid signature", async (_name, override) => {
    // Given: a hand-signed token whose claims carry a wrong value.
    const token = await signRawClaims(claimText({ ...CONTEXT, ...override }), KEY, RELAY_CONTEXT_PURPOSE);

    // When: the token is verified as a preview context.
    const verified = await verifyRelayContext(token, KEY, "preview", ISSUED_AT_MS);

    // Then: verification fails.
    expect(verified).toBeUndefined();
  });

  it.each([
    ["with unsorted keys", JSON.stringify(CONTEXT)],
    ["with added whitespace", claimText(CONTEXT).replace(":", ": ")],
  ] as const)("rejects a non-canonical payload %s", async (_name, payloadText) => {
    // Given: a hand-signed token whose payload is valid JSON but not canonical.
    const token = await signRawClaims(payloadText, KEY, RELAY_CONTEXT_PURPOSE);

    // When: the token is verified.
    const verified = await verifyRelayContext(token, KEY, "preview", ISSUED_AT_MS);

    // Then: the non-canonical encoding is rejected.
    expect(verified).toBeUndefined();
  });

  it("rejects a payload with a duplicate JSON key", async () => {
    // Given: canonical claim text with the nonce key repeated.
    const duplicated = `${claimText(CONTEXT).replace(/}$/, `,"nonce":"${NONCE}"}`)}`;

    // When: the payload is signed and verified.
    const token = await signRawClaims(duplicated, KEY, RELAY_CONTEXT_PURPOSE);
    const verified = await verifyRelayContext(token, KEY, "preview", ISSUED_AT_MS);

    // Then: the duplicate key is rejected.
    expect(verified).toBeUndefined();
  });

  it("rejects a payload with an unknown claim", async () => {
    // Given: canonical claim text with one extra key.
    const token = await signRawClaims(claimText({ ...CONTEXT, extra: "x" }), KEY, RELAY_CONTEXT_PURPOSE);

    // When: the token is verified.
    const verified = await verifyRelayContext(token, KEY, "preview", ISSUED_AT_MS);

    // Then: the unknown claim is rejected.
    expect(verified).toBeUndefined();
  });

  it.each([
    ["no separator", (token: string) => token.replace(".", "")],
    ["an additional segment", (token: string) => `${token}.x`],
    ["an empty payload segment", (token: string) => token.replace(/^[^.]*/, "")],
    ["an empty MAC segment", (token: string) => `${token}.`],
    ["base64 padding", (token: string) => token.replace(".", "=.")],
    ["an invalid character", (token: string) => `${token.slice(0, 10)}#${token.slice(11)}`],
  ] as const)("rejects a token with %s", async (_name, malform) => {
    // Given: a valid token reshaped into a malformed variant.
    const token = await signRelayContext(CONTEXT, KEY);
    const malformed = malform(token);

    // When: the malformed token is verified.
    const verified = await verifyRelayContext(malformed, KEY, "preview", ISSUED_AT_MS);

    // Then: verification fails.
    expect(verified).toBeUndefined();
  });

  it("rejects a non-canonical base64url payload segment", async () => {
    // Given: a two-segment token whose payload decodes with non-zero leftover bits.
    const token = `SR.${"A".repeat(43)}`;

    // When: the token is verified.
    const verified = await verifyRelayContext(token, KEY, "preview", ISSUED_AT_MS);

    // Then: the non-canonical base64url is rejected.
    expect(verified).toBeUndefined();
  });

  it("rejects an oversized token", async () => {
    // Given: a valid token extended beyond the 4,096-byte header bound.
    const token = await signRelayContext(CONTEXT, KEY);
    const oversized = token + "A".repeat(4_100);

    // When: the oversized token is verified.
    const verified = await verifyRelayContext(oversized, KEY, "preview", ISSUED_AT_MS);

    // Then: verification fails.
    expect(verified).toBeUndefined();
  });

  it("accepts now equal to issuedAtMs and rejects a future issuedAtMs", async () => {
    // Given: a valid token.
    const token = await signRelayContext(CONTEXT, KEY);

    // When: now equals the issue time, then precedes it.
    const atIssue = await verifyRelayContext(token, KEY, "preview", ISSUED_AT_MS);
    const beforeIssue = await verifyRelayContext(token, KEY, "preview", ISSUED_AT_MS - 1);

    // Then: only the issue boundary is accepted.
    expect(atIssue).toEqual(CONTEXT);
    expect(beforeIssue).toBeUndefined();
  });

  it("rejects now at or after expiresAtMs", async () => {
    // Given: a valid token with a 60-second lifetime.
    const token = await signRelayContext(CONTEXT, KEY);

    // When: now reaches the final valid millisecond, the expiry, and beyond.
    const justBeforeExpiry = await verifyRelayContext(token, KEY, "preview", CONTEXT.expiresAtMs - 1);
    const atExpiry = await verifyRelayContext(token, KEY, "preview", CONTEXT.expiresAtMs);
    const afterExpiry = await verifyRelayContext(token, KEY, "preview", CONTEXT.expiresAtMs + 1);

    // Then: expiry is strictly exclusive.
    expect(justBeforeExpiry).toEqual(CONTEXT);
    expect(atExpiry).toBeUndefined();
    expect(afterExpiry).toBeUndefined();
  });
});

describe("signRelayGrantCredential and verifyRelayGrantCredential", () => {
  it("round-trips grant claims through sign and verify", async () => {
    // Given: a valid grant credential and its environment key.
    const token = await signRelayGrantCredential(GRANT, KEY);

    // When: the token is verified with the same key, environment, and now.
    const verified = await verifyRelayGrantCredential(token, KEY, "preview", ISSUED_AT_MS);

    // Then: the verified claims equal the signed claims.
    expect(verified).toEqual(GRANT);
  });

  it("rejects a grant token checked with the context purpose", async () => {
    // Given: a validly signed grant token.
    const token = await signRelayGrantCredential(GRANT, KEY);

    // When: it is submitted where a context is expected.
    const verified = await verifyRelayContext(token, KEY, "preview", ISSUED_AT_MS);

    // Then: the purpose separation rejects it.
    expect(verified).toBeUndefined();
  });

  it("rejects a preview grant against production with the production key", async () => {
    // Given: a preview-signed grant token and a distinct production key.
    const token = await signRelayGrantCredential(GRANT, KEY);

    // When: it is verified as a production credential with a production key.
    const verified = await verifyRelayGrantCredential(token, OTHER_KEY, "production", ISSUED_AT_MS);

    // Then: verification fails.
    expect(verified).toBeUndefined();
  });

  it("rejects an expired grant credential", async () => {
    // Given: a valid grant token.
    const token = await signRelayGrantCredential(GRANT, KEY);

    // When: now reaches the credential expiry and beyond.
    const atExpiry = await verifyRelayGrantCredential(token, KEY, "preview", GRANT.expiresAtMs);
    const afterExpiry = await verifyRelayGrantCredential(token, KEY, "preview", GRANT.expiresAtMs + 1);

    // Then: expiry is strictly exclusive.
    expect(atExpiry).toBeUndefined();
    expect(afterExpiry).toBeUndefined();
  });
});

describe("decodeRelayContextHmacKey", () => {
  it("decodes the canonical base64url encoding of 32 bytes", () => {
    // Given: the canonical base64url encoding of bytes 0..31.
    const encoded = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    // When: the key is decoded.
    const decoded = decodeRelayContextHmacKey(encoded);

    // Then: the exact 32 bytes are restored.
    expect(decoded).toEqual(KEY);
  });

  it.each([
    ["a truncated key", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh"],
    ["a padded key", `${"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}=`],
    ["a non-canonical trailing character", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9"],
    ["an empty value", ""],
    ["an invalid character", `${"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".slice(0, 10)}+${"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".slice(11)}`],
  ] as const)("rejects %s", (_name, encoded) => {
    // Given: a malformed key encoding.
    // When: the key is decoded.
    const decoded = decodeRelayContextHmacKey(encoded);
    // Then: decoding fails.
    expect(decoded).toBeUndefined();
  });
});

describe("compareRelayBearerConstantTime", () => {
  it("accepts equal bearer secrets", () => {
    // Given: two identical 32-byte printable secrets.
    const secret = "a".repeat(32);
    // When: they are compared.
    // Then: they are equal.
    expect(compareRelayBearerConstantTime(secret, secret)).toBe(true);
  });

  it.each([
    ["a different secret of the same length", "a".repeat(32), "b".repeat(32)],
    ["a shorter secret", "a".repeat(32), "a".repeat(31)],
    ["a longer secret", "a".repeat(32), `${"a".repeat(32)}x`],
    ["a prefix of the expected secret", "a".repeat(32), "a".repeat(16)],
  ] as const)("rejects %s", (_name, expected, presented) => {
    // Given: two differing secrets.
    // When: they are compared.
    // Then: they are not equal.
    expect(compareRelayBearerConstantTime(expected, presented)).toBe(false);
  });
});
