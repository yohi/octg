/**
 * Strict JSON input handling for relay envelopes (SPEC.md section 19.3).
 *
 * Shared value predicates used by every relay parser, plus
 * parseRelayJsonBody: bounded byte limit, fatal UTF-8 decoding, and
 * duplicate-object-key rejection before any envelope validator runs.
 */

import { RelayProtocolError } from "./relay.ts";

const UTF8_ENCODER = new TextEncoder();
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

export function isBoundedUtf8(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && UTF8_ENCODER.encode(value).byteLength <= maxBytes;
}

/** Exact key-set match: no missing keys, no extra keys. */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  if (Object.keys(value).length !== keys.length) return false;
  return keys.every((key) => Object.hasOwn(value, key));
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function isJsonWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** Decodes one JSON string token; returns undefined for malformed syntax. */
function decodeJsonString(text: string, start: number): { value: string; end: number } | undefined {
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch: string | undefined = text[i];
    if (ch === undefined) return undefined;
    if (ch === '"') return { value: out, end: i + 1 };
    if (ch === "\\") {
      const escape: string | undefined = text[i + 1];
      if (escape === undefined) return undefined;
      if (escape === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      const simple: string | undefined = SIMPLE_ESCAPES[escape];
      if (simple === undefined) return undefined;
      out += simple;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return undefined;
}

/**
 * Reports whether any object in the raw JSON text declares the same decoded
 * key twice. Sound for valid JSON: string tokens are consumed identically to
 * the JSON grammar, so no valid text is falsely flagged.
 */
export function hasDuplicateJsonKeys(text: string): boolean {
  const keyStack: Array<Set<string> | null> = [];
  let i = 0;
  while (i < text.length) {
    const ch: string | undefined = text[i];
    if (ch === undefined) return false;
    if (ch === '"') {
      const token = decodeJsonString(text, i);
      if (token === undefined) return false;
      i = token.end;
      let j = i;
      while (j < text.length && isJsonWhitespace(text[j])) j += 1;
      const scope: Set<string> | null | undefined = keyStack[keyStack.length - 1];
      if (text[j] === ":" && scope !== null && scope !== undefined) {
        if (scope.has(token.value)) return true;
        scope.add(token.value);
      }
      continue;
    }
    if (ch === "{") keyStack.push(new Set());
    else if (ch === "[") keyStack.push(null);
    else if (ch === "}" || ch === "]") keyStack.pop();
    i += 1;
  }
  return false;
}

/**
 * Decodes a bounded relay JSON body. Malformed input — oversize bytes, fatal
 * UTF-8 errors, duplicate object keys, or invalid JSON syntax — throws only
 * RelayProtocolError("invalid_request"), never a raw parser detail.
 */
export function parseRelayJsonBody(bytes: Uint8Array, maxBytes: number): unknown {
  if (bytes.byteLength > maxBytes) throw new RelayProtocolError();
  let text: string;
  try {
    text = FATAL_UTF8_DECODER.decode(bytes);
  } catch {
    // Decoding failure IS the invalid_request condition at this boundary.
    throw new RelayProtocolError();
  }
  if (hasDuplicateJsonKeys(text)) throw new RelayProtocolError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON syntax failure IS the invalid_request condition at this boundary.
    throw new RelayProtocolError();
  }
  return parsed;
}
