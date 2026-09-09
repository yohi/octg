import type { PrepareErrorCode, PrepareMetadata } from "@octg/shared";

export type PrepareOutcome =
  | {
      readonly kind: "resolved";
      readonly metadata: PrepareMetadata;
      readonly body: ReadableStream<Uint8Array>;
      readonly cancel: () => Promise<void>;
    }
  | { readonly kind: "rejected"; readonly code: PrepareErrorCode }
  | {
      readonly kind: "unavailable";
      readonly failure: "timeout" | "network" | "upstream_status" | "malformed_response";
    };

const MARKER_PATTERN = /^octg_prepare_[0-9a-f]{32}$/;
const MAX_METADATA_HEADER_BYTES = 4096;

const EXPECTED_KEYS = [
  "version",
  "model",
  "rawBodyBytes",
  "inputBytes",
  "inputTextBytes",
  "opaqueInputBytes",
  "messageCount",
  "estimatedInputTokens",
  "estimationPath",
  "maxOutputTokens",
  "stream",
  "isToolUse",
  "outputMarker",
] as const;

/** Decode base64url to bytes, bounded by maxBytes. Returns undefined on decode failure or overflow. */
function decodeBase64urlBounded(value: string, maxBytes: number): Uint8Array | undefined {
  if (new TextEncoder().encode(value).byteLength > maxBytes) return undefined;

  // base64url → base64
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  // Pad to a multiple of 4
  const remainder = base64.length % 4;
  if (remainder) base64 += "=".repeat(4 - remainder);

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return undefined;
  }

  if (binary.length > maxBytes) return undefined;

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isSafeNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePosInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Decode a bounded base64url JSON header and validate the exact field set,
 * version, scalar types, safe-integer ranges, and semantic relationships.
 * Returns `undefined` for every malformed value.
 */
export function parsePrepareMetadata(
  value: string | null,
  maxInputBytes: number,
): PrepareMetadata | undefined {
  if (value === null || value === "") return undefined;

  const decoded = decodeBase64urlBounded(value, MAX_METADATA_HEADER_BYTES);
  if (decoded === undefined || decoded.byteLength > maxInputBytes) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;

  // Exact key set — no missing, no extra
  const keys = Object.keys(record);
  if (keys.length !== EXPECTED_KEYS.length) return undefined;
  for (const expected of EXPECTED_KEYS) {
    if (!(expected in record)) return undefined;
  }

  // version: exactly 1
  if (record.version !== 1) return undefined;

  // model: non-empty string
  if (typeof record.model !== "string" || record.model === "") return undefined;

  // Non-negative safe integers
  if (!isSafeNonNegInt(record.rawBodyBytes)) return undefined;
  if (!isSafeNonNegInt(record.inputBytes)) return undefined;
  if (!isSafeNonNegInt(record.inputTextBytes)) return undefined;
  if (!isSafeNonNegInt(record.opaqueInputBytes)) return undefined;
  if (!isSafeNonNegInt(record.messageCount)) return undefined;
  if (!isSafeNonNegInt(record.estimatedInputTokens)) return undefined;

  // maxOutputTokens: positive safe integer
  if (!isSafePosInt(record.maxOutputTokens)) return undefined;

  // estimationPath: exactly "exact_bpe"
  if (record.estimationPath !== "exact_bpe") return undefined;

  // stream, isToolUse: booleans
  if (typeof record.stream !== "boolean") return undefined;
  if (typeof record.isToolUse !== "boolean") return undefined;

  // outputMarker: matches octg_prepare_[0-9a-f]{32}
  if (typeof record.outputMarker !== "string" || !MARKER_PATTERN.test(record.outputMarker)) {
    return undefined;
  }

  // Semantic relationship: inputBytes = inputTextBytes + opaqueInputBytes
  if (record.inputBytes !== record.inputTextBytes + record.opaqueInputBytes) return undefined;

  return {
    version: 1,
    model: record.model,
    rawBodyBytes: record.rawBodyBytes,
    inputBytes: record.inputBytes,
    inputTextBytes: record.inputTextBytes,
    opaqueInputBytes: record.opaqueInputBytes,
    messageCount: record.messageCount,
    estimatedInputTokens: record.estimatedInputTokens,
    estimationPath: "exact_bpe",
    maxOutputTokens: record.maxOutputTokens,
    stream: record.stream,
    isToolUse: record.isToolUse,
    outputMarker: record.outputMarker,
  };
};
