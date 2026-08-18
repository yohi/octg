import type { TokenizerController, TokenizeResult } from "@octg/tokenizer-controller";
import type { Env } from "./index";

export interface TokenizeClientRequest {
  readonly requestId: string;
  readonly inputText: string;
  readonly messageCount: number;
  readonly opaqueInputBytes: number;
}

export type TokenizeOutcome =
  | { readonly kind: "resolved"; readonly result: TokenizeResult }
  | { readonly kind: "unavailable" };

export async function tokenize(
  env: Env,
  request: TokenizeClientRequest,
): Promise<TokenizeOutcome> {
  try {
    const stub = env.TOKENIZER_CONTROLLER.get(
      env.TOKENIZER_CONTROLLER.idFromName("tokenizer:primary"),
    );
    const outcome = await stub.estimate(request);
    if (
      typeof outcome !== "object" ||
      outcome === null ||
      !("kind" in outcome) ||
      outcome.kind !== "resolved" ||
      !("result" in outcome) ||
      !isValidTokenizeResult(outcome.result)
    ) {
      return { kind: "unavailable" };
    }
    return { kind: "resolved", result: outcome.result };
  } catch {
    return { kind: "unavailable" };
  }
}

function isValidTokenizeResult(value: unknown): value is TokenizeResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { estimatedInputTokens?: unknown; estimationPath?: unknown };
  if (
    typeof candidate.estimatedInputTokens !== "number" ||
    !Number.isSafeInteger(candidate.estimatedInputTokens) ||
    candidate.estimatedInputTokens < 0
  ) {
    return false;
  }
  if (
    candidate.estimationPath !== "exact_bpe" &&
    candidate.estimationPath !== "conservative_bytes"
  ) {
    return false;
  }
  return true;
}
