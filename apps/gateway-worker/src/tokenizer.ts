import {
  MAX_INPUT_TEXT_BYTES,
  MAX_REQUEST_ID_BYTES,
  type TokenizeRequest,
  type TokenizeRpcResult,
  type TokenizeResult,
} from "@octg/tokenizer-controller/contracts";

const RPC_LIMIT_BYTES = 32 * 1024 * 1024;

interface TokenizerRpcStub {
  tokenize(request: TokenizeRequest): Promise<unknown>;
}

export interface TokenizerNamespace<Id> {
  idFromName(name: string): Id;
  get(id: Id): TokenizerRpcStub;
}

export type TokenizerOutcome =
  | { readonly kind: "resolved"; readonly result: TokenizeResult }
  | { readonly kind: "request_too_large" }
  | { readonly kind: "unavailable" };

export function estimateRpcPayloadSize(request: TokenizeRequest): number {
  const inputTextUtf16Size = request.inputText.length * 2;
  const requestIdSize = request.requestId.length * 2;
  const framingOverhead = 200;
  return inputTextUtf16Size + requestIdSize + framingOverhead;
}

export async function tokenizeInput<Id>(
  namespace: TokenizerNamespace<Id>,
  request: TokenizeRequest,
): Promise<TokenizerOutcome> {
  try {
    if (estimateRpcPayloadSize(request) >= RPC_LIMIT_BYTES) {
      return { kind: "unavailable" };
    }
    if (!isWithinRequestLimits(request)) return { kind: "unavailable" };

    const stub = namespace.get(namespace.idFromName("tokenizer:primary"));
    const result = parseTokenizeResult(await stub.tokenize(request));
    if (result === undefined) return { kind: "unavailable" };
    return "kind" in result
      ? { kind: "request_too_large" }
      : { kind: "resolved", result };
  } catch {
    // no-excuse-ok: catch — the RPC boundary converts every failure to fail-closed.
    return { kind: "unavailable" };
  }
}

function isWithinRequestLimits(request: TokenizeRequest): boolean {
  if (request.requestId.length === 0) return false;
  const encoder = new TextEncoder();
  return (
    encoder.encode(request.inputText).byteLength <= MAX_INPUT_TEXT_BYTES &&
    encoder.encode(request.requestId).byteLength <= MAX_REQUEST_ID_BYTES
  );
}

function parseTokenizeResult(value: unknown): TokenizeRpcResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Reflect.get(value, "kind") === "work_limit") return { kind: "work_limit" };
  const estimatedInputTokens = Reflect.get(value, "estimatedInputTokens");
  const estimationPath = Reflect.get(value, "estimationPath");
  if (
    typeof estimatedInputTokens !== "number" ||
    !Number.isSafeInteger(estimatedInputTokens) ||
    estimatedInputTokens < 0
  ) {
    return undefined;
  }
  if (estimationPath !== "exact_bpe" && estimationPath !== "conservative_bytes") {
    return undefined;
  }
  return { estimatedInputTokens, estimationPath };
}
