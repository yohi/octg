import { estimatedInputTokensOf } from "@octg/shared";
import type { TokenizeRequest, TokenizeResult } from "@octg/tokenizer-controller/contracts";
import {
  tokenizeWithDeno,
  type DenoNetworkErrorName,
  type DenoTokenizationFailure,
} from "./deno-tokenizer-client";
import type { DenoTokenizerConfig } from "./deno-tokenizer-config";
import { assertNever } from "./exhaustiveness";
import { tokenizeInput, type TokenizerNamespace, type TokenizerOutcome } from "./tokenizer";

const textEncoder = new TextEncoder();

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
      readonly failureCategory?: "configuration" | "arithmetic" | DenoTokenizationFailure;
      readonly networkErrorName?: DenoNetworkErrorName;
    };

type RoutedTokenizeRequest = TokenizeRequest & {
  readonly inputTextBytes?: number;
};

export async function routeTokenization<Id>(args: {
  readonly config: DenoTokenizerConfig;
  readonly namespace: TokenizerNamespace<Id>;
  readonly request: RoutedTokenizeRequest;
  readonly fetchImpl?: typeof fetch;
}): Promise<RoutedTokenizationOutcome> {
  const tokenizerRequest: TokenizeRequest = {
    requestId: args.request.requestId,
    inputText: args.request.inputText,
    messageCount: args.request.messageCount,
    opaqueInputBytes: args.request.opaqueInputBytes,
  };

  switch (args.config.kind) {
    case "disabled":
      return withCloudflareProvider(await tokenizeInput(args.namespace, tokenizerRequest));
    case "invalid":
      return { kind: "unavailable", provider: "deno", failureCategory: "configuration" };
    case "enabled": {
      const inputTextBytes = args.request.inputTextBytes ?? textEncoder.encode(args.request.inputText).byteLength;
      if (inputTextBytes < args.config.thresholdBytes) {
        return withCloudflareProvider(await tokenizeInput(args.namespace, tokenizerRequest));
      }

      const outcome = await tokenizeWithDeno({
        endpoint: args.config.endpoint,
        authToken: args.config.authToken,
        timeoutMs: args.config.timeoutMs,
        inputText: args.request.inputText,
        fetchImpl: args.fetchImpl,
      });
      switch (outcome.kind) {
        case "unavailable":
          return {
            kind: "unavailable",
            provider: "deno",
            failureCategory: outcome.failureCategory,
            ...(outcome.networkErrorName === undefined
              ? {}
              : { networkErrorName: outcome.networkErrorName }),
          };
        case "resolved":
          try {
            return {
              kind: "resolved",
              provider: "deno",
              result: toTokenizeResult(outcome.baseTokenCount, args.request),
            };
          } catch {
            return { kind: "unavailable", provider: "deno", failureCategory: "arithmetic" };
          }
        default:
          return assertNever(outcome, "Deno tokenizer outcome");
      }
    }
    default:
      return assertNever(args.config, "Deno tokenizer config");
  }
}

function withCloudflareProvider(outcome: TokenizerOutcome): RoutedTokenizationOutcome {
  switch (outcome.kind) {
    case "resolved":
      return { kind: "resolved", provider: "cloudflare_do", result: outcome.result };
    case "request_too_large":
      return { kind: "request_too_large", provider: "cloudflare_do" };
    case "unavailable":
      return { kind: "unavailable", provider: "cloudflare_do" };
    default:
      return assertNever(outcome, "Cloudflare tokenizer outcome");
  }
}

function toTokenizeResult(baseTokenCount: number, request: TokenizeRequest): TokenizeResult {
  return {
    estimatedInputTokens: estimatedInputTokensOf({
      baseTokenCount,
      messageCount: request.messageCount,
      opaqueInputBytes: request.opaqueInputBytes,
    }),
    estimationPath: "exact_bpe",
  };
}
