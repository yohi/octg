export interface TokenizeRequest {
  readonly requestId: string;
  readonly inputText: string;
  readonly messageCount: number;
  readonly opaqueInputBytes: number;
}

export type EstimationPath = "exact_bpe" | "conservative_bytes";

export interface TokenizeResult {
  readonly estimatedInputTokens: number;
  readonly estimationPath: EstimationPath;
}

export type TokenizeRpcResult = TokenizeResult | { readonly kind: "work_limit" };

export const MAX_INPUT_TEXT_BYTES = 16 * 1024 * 1024 - 65_536;
export const MAX_REQUEST_ID_BYTES = 256;
export const MAX_BPE_WORK_UNITS = 64 * 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

export function parseTokenizeRequest(value: unknown): TokenizeRequest {
  if (!isRecord(value)) {
    throw new TypeError("Invalid tokenizer request.");
  }

  const { requestId, inputText, messageCount, opaqueInputBytes } = value;
  if (
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    typeof inputText !== "string" ||
    typeof messageCount !== "number" ||
    !Number.isSafeInteger(messageCount) ||
    messageCount < 0 ||
    typeof opaqueInputBytes !== "number" ||
    !Number.isSafeInteger(opaqueInputBytes) ||
    opaqueInputBytes < 0
  ) {
    throw new TypeError("Invalid tokenizer request.");
  }

  if (
    utf8ByteLength(inputText) > MAX_INPUT_TEXT_BYTES ||
    utf8ByteLength(requestId) > MAX_REQUEST_ID_BYTES
  ) {
    throw new TypeError("Invalid tokenizer request.");
  }

  return { requestId, inputText, messageCount, opaqueInputBytes };
}
