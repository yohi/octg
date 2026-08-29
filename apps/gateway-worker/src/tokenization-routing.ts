import { estimatedInputTokensOf } from "@octg/shared";
import type { TokenizeRequest, TokenizeResult } from "@octg/tokenizer-controller/contracts";
import { tokenizeWithDeno } from "./deno-tokenizer-client";
import type { DenoTokenizerConfig } from "./deno-tokenizer-config";
import { assertNever } from "./exhaustiveness";
import { tokenizeInput, type TokenizerNamespace, type TokenizerOutcome } from "./tokenizer";

const textEncoder = new TextEncoder();

export async function routeTokenization<Id>(args: {
  readonly config: DenoTokenizerConfig;
  readonly namespace: TokenizerNamespace<Id>;
  readonly request: TokenizeRequest;
  readonly fetchImpl?: typeof fetch;
}): Promise<TokenizerOutcome> {
  switch (args.config.kind) {
    case "disabled":
      return tokenizeInput(args.namespace, args.request);
    case "invalid":
      return { kind: "unavailable" };
    case "enabled": {
      const inputTextBytes = textEncoder.encode(args.request.inputText).byteLength;
      if (inputTextBytes < args.config.thresholdBytes) {
        return tokenizeInput(args.namespace, args.request);
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
          return { kind: "unavailable" };
        case "resolved":
          return {
            kind: "resolved",
            result: toTokenizeResult(outcome.baseTokenCount, args.request),
          };
        default:
          return assertNever(outcome, "Deno tokenizer outcome");
      }
    }
    default:
      return assertNever(args.config, "Deno tokenizer config");
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
