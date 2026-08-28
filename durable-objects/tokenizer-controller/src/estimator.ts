import { estimatedInputTokensOf } from "@octg/shared";
import { init, Tiktoken } from "tiktoken/lite/init";
import wasm from "tiktoken/lite/tiktoken_bg.wasm";
import o200kBase from "tiktoken/encoders/o200k_base";
import { MAX_BPE_WORK_UNITS, type TokenizeRequest, type TokenizeResult } from "./contracts";
import {
  type TokenizerStage,
  type TokenizerStageEvent,
} from "./observation";

type Encoding = {
  readonly encode: (text: string) => { readonly length: number };
};
export type EncodingFactory = () => Encoding;

const BPE_WORK_CHUNK_PATTERN = /[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL]{2}|'[dD])?|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL]{2}|'[dD])?|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const UTF8_ENCODER = new TextEncoder();

await init((imports) => WebAssembly.instantiate(wasm, imports));

export class TokenizerWorkLimitError extends Error {
  public constructor() {
    super("Tokenizer BPE work limit exceeded.");
    this.name = "TokenizerWorkLimitError";
  }
}

export interface TokenizerEstimatorContext {
  readonly requestId: string;
  readonly revisionId: string;
  readonly emit: (event: TokenizerStageEvent) => void;
}

type EncodingFailureCategory = "encoding_init" | "encoding_encode";

type ConservativeFallbackContext = {
  readonly context: TokenizerEstimatorContext;
  readonly startedAt: number;
  readonly stage: TokenizerStage;
  readonly failureCategory: EncodingFailureCategory;
};

export class TokenizerEstimator {
  private encoding: Encoding | undefined;

  public constructor(
    private readonly encodingFactory: EncodingFactory = () => new Tiktoken(
      o200kBase.bpe_ranks,
      o200kBase.special_tokens,
      o200kBase.pat_str,
    ),
  ) {}

  public estimate(
    request: TokenizeRequest,
    context: TokenizerEstimatorContext,
  ): TokenizeResult {
    return this.encoding === undefined
      ? this.initializeAndEstimate(request, context)
      : this.encodeWithFallback(this.encoding, request, context);
  }

  private initializeAndEstimate(
    request: TokenizeRequest,
    context: TokenizerEstimatorContext,
  ): TokenizeResult {
    const startedAt = performance.now();
    context.emit({
      event: "octg.tokenizer_stage",
      requestId: request.requestId,
      revisionId: context.revisionId,
      stage: "tokenizer_init",
      phase: "start",
    });

    let initialized: Encoding;
    try {
      initialized = this.encodingFactory();
    } catch (error) {
      if (error instanceof Error) {
        return this.conservativeEstimateWithFallback(request, {
          context,
          startedAt,
          stage: "tokenizer_init",
          failureCategory: "encoding_init",
        });
      }

      context.emit({
        event: "octg.tokenizer_stage",
        requestId: request.requestId,
        revisionId: context.revisionId,
        stage: "tokenizer_init",
        phase: "finish",
        durationMs: durationSince(startedAt),
        outcome: "exception",
        failureCategory: "encoding_init",
      });
      throw error;
    }

    this.encoding = initialized;
    context.emit({
      event: "octg.tokenizer_stage",
      requestId: request.requestId,
      revisionId: context.revisionId,
      stage: "tokenizer_init",
      phase: "finish",
      durationMs: durationSince(startedAt),
      outcome: "success",
    });
    return this.encodeWithFallback(initialized, request, context);
  }

  private encodeWithFallback(
    encoding: Encoding,
    request: TokenizeRequest,
    context: TokenizerEstimatorContext,
  ): TokenizeResult {
    const startedAt = performance.now();
    context.emit({
      event: "octg.tokenizer_stage",
      requestId: request.requestId,
      revisionId: context.revisionId,
      stage: "tokenizer_encode",
      phase: "start",
    });

    try {
      assertBpeWorkWithinLimit(request.inputText);
    } catch (error) {
      context.emit({
        event: "octg.tokenizer_stage",
        requestId: request.requestId,
        revisionId: context.revisionId,
        stage: "tokenizer_encode",
        phase: "finish",
        durationMs: durationSince(startedAt),
        outcome: "exception",
        failureCategory: error instanceof TokenizerWorkLimitError ? "work_limit" : "arithmetic",
      });
      throw error;
    }

    let base: number;
    try {
      base = encoding.encode(request.inputText).length;
    } catch (error) {
      if (error instanceof Error) {
        return this.conservativeEstimateWithFallback(request, {
          context,
          startedAt,
          stage: "tokenizer_encode",
          failureCategory: "encoding_encode",
        });
      }

      context.emit({
        event: "octg.tokenizer_stage",
        requestId: request.requestId,
        revisionId: context.revisionId,
        stage: "tokenizer_encode",
        phase: "finish",
        durationMs: durationSince(startedAt),
        outcome: "exception",
        failureCategory: "encoding_encode",
      });
      throw error;
    }

    try {
      const result = {
        estimatedInputTokens: estimatedInputTokensOf({
          baseTokenCount: base,
          messageCount: request.messageCount,
          opaqueInputBytes: request.opaqueInputBytes,
        }),
        estimationPath: "exact_bpe",
      } as const;
      context.emit({
        event: "octg.tokenizer_stage",
        requestId: request.requestId,
        revisionId: context.revisionId,
        stage: "tokenizer_encode",
        phase: "finish",
        durationMs: durationSince(startedAt),
        outcome: "success",
        tokenCount: base,
        estimationPath: result.estimationPath,
      });
      return result;
    } catch (error) {
      context.emit({
        event: "octg.tokenizer_stage",
        requestId: request.requestId,
        revisionId: context.revisionId,
        stage: "tokenizer_encode",
        phase: "finish",
        durationMs: durationSince(startedAt),
        outcome: "exception",
        failureCategory: "arithmetic",
      });
      throw error;
    }
  }

  private conservativeEstimateWithFallback(
    request: TokenizeRequest,
    fallbackContext: ConservativeFallbackContext,
  ): TokenizeResult {
    const { context, startedAt, stage, failureCategory } = fallbackContext;
    try {
      const fallback = this.conservativeEstimate(request);
      context.emit({
        event: "octg.tokenizer_stage",
        requestId: request.requestId,
        revisionId: context.revisionId,
        stage,
        phase: "finish",
        durationMs: durationSince(startedAt),
        outcome: "fallback",
        byteCount: fallback.byteCount,
        tokenCount: fallback.result.estimatedInputTokens,
        estimationPath: fallback.result.estimationPath,
        failureCategory,
      });
      return fallback.result;
    } catch (arithmeticError) {
      context.emit({
        event: "octg.tokenizer_stage",
        requestId: request.requestId,
        revisionId: context.revisionId,
        stage,
        phase: "finish",
        durationMs: durationSince(startedAt),
        outcome: "exception",
        failureCategory: "arithmetic",
      });
      throw arithmeticError;
    }
  }

  private conservativeEstimate(request: TokenizeRequest): {
    readonly result: TokenizeResult;
    readonly byteCount: number;
  } {
    const byteCount = UTF8_ENCODER.encode(request.inputText).byteLength;
    return {
      byteCount,
      result: {
        estimatedInputTokens: estimatedInputTokensOf({
          baseTokenCount: byteCount,
          messageCount: request.messageCount,
          opaqueInputBytes: request.opaqueInputBytes,
        }),
        estimationPath: "conservative_bytes",
      },
    };
  }
}

function durationSince(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function assertBpeWorkWithinLimit(inputText: string): void {
  let workUnits = 0;
  for (const match of inputText.matchAll(BPE_WORK_CHUNK_PATTERN)) {
    const pieceBytes = UTF8_ENCODER.encode(match[0]).byteLength;
    const pieceWorkUnits = pieceBytes * pieceBytes;
    if (workUnits > MAX_BPE_WORK_UNITS - pieceWorkUnits) {
      throw new TokenizerWorkLimitError();
    }
    workUnits += pieceWorkUnits;
  }
}
