/**
 * Compact signed-token primitives for the relay context and grant
 * credential (SPEC.md section 19; design "Credentials, authorization and
 * DO routing").
 *
 * Token = base64url-no-padding(UTF8(RFC 8785(claims))) + "." +
 *         base64url-no-padding(HMAC-SHA-256(key, purpose || 0x00 || payload)).
 *
 * Cloudflare-side only: the environment-unique 32-byte HMAC key is a Worker
 * deployment secret and is never configured in Deno. Deno neither signs nor
 * verifies tokens. Keys passed to these functions must come from
 * decodeRelayContextHmacKey, which enforces the exact 32-byte contract.
 */

import { parseRelayContext, parseRelayGrantCredential } from "./relay-claims.ts";
import { hasDuplicateJsonKeys } from "./relay-json.ts";
import { RELAY_MAX_CONTEXT_HEADER_BYTES } from "./relay.ts";
import type { RelayContextV1, RelayEnvironment, RelayGrantCredentialV1 } from "./relay.ts";

/** Purpose labels separating the two MAC input domains. */
export const RELAY_CONTEXT_PURPOSE = "octg-relay-context-v1";
export const RELAY_GRANT_PURPOSE = "octg-relay-grant-v1";

const UTF8_ENCODER = new TextEncoder();
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const CONTEXT_PURPOSE_BYTES = UTF8_ENCODER.encode(RELAY_CONTEXT_PURPOSE);
const GRANT_PURPOSE_BYTES = UTF8_ENCODER.encode(RELAY_GRANT_PURPOSE);

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const BASE64URL_REVERSE: ReadonlyMap<string, number> = new Map(
  [...BASE64URL_ALPHABET].map((character, index) => [character, index]),
);

/** Describes one token kind: its MAC purpose and its strict claims parser. */
interface RelayTokenKind<T> {
  readonly purposeBytes: Uint8Array;
  readonly parseClaims: (value: unknown) => T | undefined;
}

const CONTEXT_TOKEN: RelayTokenKind<RelayContextV1> = {
  purposeBytes: CONTEXT_PURPOSE_BYTES,
  parseClaims: parseRelayContext,
};

const GRANT_TOKEN: RelayTokenKind<RelayGrantCredentialV1> = {
  purposeBytes: GRANT_PURPOSE_BYTES,
  parseClaims: parseRelayGrantCredential,
};

function encodeBase64UrlNoPadding(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Strict canonical base64url-no-padding decode; rejects padding, invalid
 *  characters, impossible lengths, and non-zero trailing bits. */
function decodeBase64UrlNoPadding(text: string): Uint8Array | undefined {
  if (text.length % 4 === 1) return undefined;
  let accumulated = 0;
  let bitCount = 0;
  const bytes: number[] = [];
  for (const character of text) {
    const value = BASE64URL_REVERSE.get(character);
    if (value === undefined) return undefined;
    accumulated = (accumulated << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((accumulated >>> bitCount) & 0xff);
      accumulated &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0 && accumulated !== 0) return undefined;
  return Uint8Array.from(bytes);
}

function escapeCanonicalJsonString(value: string): string {
  let out = '"';
  for (const character of value) {
    switch (character) {
      case '"': out += '\\"'; break;
      case "\\": out += "\\\\"; break;
      case "\b": out += "\\b"; break;
      case "\t": out += "\\t"; break;
      case "\n": out += "\\n"; break;
      case "\f": out += "\\f"; break;
      case "\r": out += "\\r"; break;
      default:
        if (character.charCodeAt(0) < 0x20) {
          out += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
        } else {
          out += character;
        }
    }
  }
  return `${out}"`;
}

/** RFC 8785 canonical JSON for the claim domain: records, strings, booleans,
 *  null, and safe integers. Anything else is a claim-shape invariant failure. */
function serializeCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return escapeCanonicalJsonString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("relay claims must be safe integers");
    }
    return String(value);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return serializeCanonicalRecord(Object.entries(value));
  }
  throw new Error("relay claims support only JSON record, string, number, boolean, and null values");
}

function serializeCanonicalRecord(entries: [string, unknown][]): string {
  const sorted = entries.sort((left, right) => compareCodeUnits(left[0], right[0]));
  const members = sorted
    .map(([key, entryValue]) => `${escapeCanonicalJsonString(key)}:${serializeCanonicalJson(entryValue)}`)
    .join(",");
  return `{${members}}`;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

let cachedRelayHmacKey: {
  readonly keyBytes: Uint8Array;
  readonly promise: Promise<CryptoKey>;
} | undefined;

function relayHmacCryptoKey(key: Uint8Array): Promise<CryptoKey> {
  const cached = cachedRelayHmacKey;
  if (cached !== undefined && constantTimeBytesEqual(cached.keyBytes, key)) {
    return cached.promise;
  }

  // Fresh ArrayBuffer-backed copy: BufferSource rejects ArrayBufferLike views.
  const keyBytes = new Uint8Array(key);
  const promise = crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedRelayHmacKey = { keyBytes, promise };
  void promise.then(undefined, () => {
    if (cachedRelayHmacKey?.promise === promise) {
      cachedRelayHmacKey = undefined;
    }
  });
  return promise;
}

async function computeRelayMac(
  key: Uint8Array,
  purposeBytes: Uint8Array,
  payloadBytes: Uint8Array,
): Promise<Uint8Array> {
  const macInput = new Uint8Array(purposeBytes.byteLength + 1 + payloadBytes.byteLength);
  macInput.set(purposeBytes, 0);
  macInput.set(payloadBytes, purposeBytes.byteLength + 1);
  const cryptoKey = await relayHmacCryptoKey(key);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, macInput));
}

/** Constant-time byte equality; length differences are folded into the diff. */
function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/** Constant-time comparison of two lowercase-hex strings (e.g. SHA-256 digests). */
export function constantTimeHexEqual(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  }
return difference === 0;
}

/** Constant-time comparison of bearer secrets as UTF-8 bytes. */
export function compareRelayBearerConstantTime(expected: string, presented: string): boolean {
  return constantTimeBytesEqual(UTF8_ENCODER.encode(expected), UTF8_ENCODER.encode(presented));
}

/** Decodes the base64url-no-padding encoding of exactly 32 HMAC key bytes. */
export function decodeRelayContextHmacKey(encoded: string): Uint8Array | undefined {
  const decoded = decodeBase64UrlNoPadding(encoded);
  if (decoded === undefined || decoded.byteLength !== 32) return undefined;
  return decoded;
}

async function signRelayToken(
  claims: RelayContextV1 | RelayGrantCredentialV1,
  key: Uint8Array,
  purposeBytes: Uint8Array,
): Promise<string> {
  const payloadBytes = UTF8_ENCODER.encode(serializeCanonicalJson(claims));
  const macBytes = await computeRelayMac(key, purposeBytes, payloadBytes);
  return `${encodeBase64UrlNoPadding(payloadBytes)}.${encodeBase64UrlNoPadding(macBytes)}`;
}

async function verifyRelayToken<T>(
  token: string,
  key: Uint8Array,
  kind: RelayTokenKind<T>,
): Promise<T | undefined> {
  if (token.length > RELAY_MAX_CONTEXT_HEADER_BYTES) return undefined;
  const parts = token.split(".");
  const payloadPart = parts[0];
  const macPart = parts[1];
  if (parts.length !== 2) return undefined;
  if (payloadPart === undefined || macPart === undefined) return undefined;
  if (payloadPart.length === 0 || macPart.length === 0) return undefined;
  const payloadBytes = decodeBase64UrlNoPadding(payloadPart);
  const macBytes = decodeBase64UrlNoPadding(macPart);
  if (payloadBytes === undefined || macBytes === undefined) return undefined;

  const expectedMac = await computeRelayMac(key, kind.purposeBytes, payloadBytes);
  if (!constantTimeBytesEqual(expectedMac, macBytes)) return undefined;

  let payloadText: string;
  try {
    payloadText = FATAL_UTF8_DECODER.decode(payloadBytes);
  } catch {
    // Invalid UTF-8 payload bytes ARE the invalid-token condition here.
    return undefined;
  }
  if (hasDuplicateJsonKeys(payloadText)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    // JSON syntax failure IS the invalid-token condition here.
    return undefined;
  }
  const claims = kind.parseClaims(parsed);
  if (claims === undefined) return undefined;
  const canonicalBytes = UTF8_ENCODER.encode(serializeCanonicalJson(claims));
  if (!constantTimeBytesEqual(canonicalBytes, payloadBytes)) return undefined;
  return claims;
}

export function signRelayContext(context: RelayContextV1, key: Uint8Array): Promise<string> {
  return signRelayToken(context, key, CONTEXT_PURPOSE_BYTES);
}

export async function verifyRelayContext(
  token: string,
  key: Uint8Array,
  expectedEnvironment: RelayEnvironment,
  nowMs: number,
): Promise<RelayContextV1 | undefined> {
  const claims = await verifyRelayToken(token, key, CONTEXT_TOKEN);
  if (claims === undefined) return undefined;
  if (claims.environment !== expectedEnvironment) return undefined;
  if (claims.issuedAtMs > nowMs || claims.expiresAtMs <= nowMs) return undefined;
  return claims;
}

export function signRelayGrantCredential(
  claims: RelayGrantCredentialV1,
  key: Uint8Array,
): Promise<string> {
  return signRelayToken(claims, key, GRANT_PURPOSE_BYTES);
}

export async function verifyRelayGrantCredential(
  token: string,
  key: Uint8Array,
  expectedEnvironment: RelayEnvironment,
  nowMs: number,
): Promise<RelayGrantCredentialV1 | undefined> {
  const claims = await verifyRelayToken(token, key, GRANT_TOKEN);
  if (claims === undefined) return undefined;
  if (claims.environment !== expectedEnvironment) return undefined;
  if (claims.issuedAtMs > nowMs || claims.expiresAtMs <= nowMs) return undefined;
  return claims;
}
