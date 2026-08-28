import { estimatedInputTokensOf } from "@octg/shared";
import type { TokenizeResult } from "@octg/tokenizer-controller/contracts";
import type { DenoTokenizerConfig } from "./deno-tokenizer-config";
import { tokenizeWithDeno, type DenoTokenizationFailure } from "./deno-tokenizer-client";
import { tokenizeInput, type TokenizerNamespace } from "./tokenizer";

export type TokenizationProvider = "cloudflare_do" | "deno";

export type RoutedTokenizationOutcome =
  | {
      readonly kind: "resolved";
      readonly provider: TokenizationProvider;
      readonly result: TokenizeResult;
    }
  | {
      readonly kind: "request_too_large";
      readonly provider: "cloudflare_do";
    }
  | {
      readonly kind: "unavailable";
      readonly provider: TokenizationProvider;
      readonly failureCategory?: DenoTokenizationFailure | "arithmetic";
    };

export type TokenizeRequest = {
  readonly requestId: string;
  readonly inputText: string;
  readonly inputTextBytes: number;
  readonly messageCount: number;
  readonly opaqueInputBytes: number;
};

export async function routeTokenization<Id>(
  denoConfig: DenoTokenizerConfig,
  tokenizerNamespace: TokenizerNamespace<Id>,
  request: TokenizeRequest,
): Promise<RoutedTokenizationOutcome> {
  if (denoConfig.kind !== "enabled" || request.inputTextBytes < denoConfig.thresholdBytes) {
    const doOutcome = await tokenizeInput(tokenizerNamespace, {
      requestId: request.requestId,
      inputText: request.inputText,
      messageCount: request.messageCount,
      opaqueInputBytes: request.opaqueInputBytes,
    });

    switch (doOutcome.kind) {
      case "resolved":
        return { kind: "resolved", provider: "cloudflare_do", result: doOutcome.result };
      case "request_too_large":
        return { kind: "request_too_large", provider: "cloudflare_do" };
      case "unavailable":
        return { kind: "unavailable", provider: "cloudflare_do" };
      default:
        return doOutcome;
    }
  }

  const denoOutcome = await tokenizeWithDeno({
    endpoint: denoConfig.endpoint,
    authToken: denoConfig.authToken,
    timeoutMs: denoConfig.timeoutMs,
    inputText: request.inputText,
  });

  if (denoOutcome.kind === "unavailable") {
    return { kind: "unavailable", provider: "deno", failureCategory: denoOutcome.failureCategory };
  }

  try {
    const estimatedInputTokens = estimatedInputTokensOf({
      baseTokenCount: denoOutcome.baseTokenCount,
      messageCount: request.messageCount,
      opaqueInputBytes: request.opaqueInputBytes,
    });
    return {
      kind: "resolved",
      provider: "deno",
      result: { estimatedInputTokens, estimationPath: "exact_bpe" },
    };
  } catch {
    return { kind: "unavailable", provider: "deno", failureCategory: "arithmetic" };
  }
}
