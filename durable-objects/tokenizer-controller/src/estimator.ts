import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { TokenizeRequest, TokenizeResult } from "./contracts";
import {
  type TokenizerStageEvent,
} from "./observation";

type Encoding = Pick<Tiktoken, "encode">;
export type EncodingFactory = () => Encoding;

export interface TokenizerEstimatorContext {
  readonly requestId: string;
  readonly revisionId: string;
  readonly emit: (event: TokenizerStageEvent) => void;
}

export class TokenizerEstimator {
  private encoding: Encoding | undefined;

  public constructor(
    private readonly encodingFactory: EncodingFactory = () => getEncoding("o200k_base"),
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
        try {
          const fallback = this.conservativeEstimate(request);
          context.emit({
            event: "octg.tokenizer_stage",
            requestId: request.requestId,
            revisionId: context.revisionId,
            stage: "tokenizer_init",
            phase: "finish",
            durationMs: durationSince(startedAt),
            outcome: "fallback",
            byteCount: fallback.byteCount,
            tokenCount: fallback.result.estimatedInputTokens,
            estimationPath: fallback.result.estimationPath,
            failureCategory: "encoding_init",
          });
          return fallback.result;
        } catch (arithmeticError) {
          context.emit({
            event: "octg.tokenizer_stage",
            requestId: request.requestId,
            revisionId: context.revisionId,
            stage: "tokenizer_init",
            phase: "finish",
            durationMs: durationSince(startedAt),
            outcome: "exception",
            failureCategory: "arithmetic",
          });
          throw arithmeticError;
        }
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

    let base: number;
    try {
      base = encoding.encode(request.inputText).length;
    } catch (error) {
      if (error instanceof Error) {
        try {
          const fallback = this.conservativeEstimate(request);
          context.emit({
            event: "octg.tokenizer_stage",
            requestId: request.requestId,
            revisionId: context.revisionId,
            stage: "tokenizer_encode",
            phase: "finish",
            durationMs: durationSince(startedAt),
            outcome: "fallback",
            byteCount: fallback.byteCount,
            tokenCount: fallback.result.estimatedInputTokens,
            estimationPath: fallback.result.estimationPath,
            failureCategory: "encoding_encode",
          });
          return fallback.result;
        } catch (arithmeticError) {
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
          throw arithmeticError;
        }
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
        estimatedInputTokens: estimatedTokensOf(base, request),
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

  private conservativeEstimate(request: TokenizeRequest): {
    readonly result: TokenizeResult;
    readonly byteCount: number;
  } {
    const byteCount = new TextEncoder().encode(request.inputText).byteLength;
    return {
      byteCount,
      result: {
        estimatedInputTokens: estimatedTokensOf(byteCount, request),
        estimationPath: "conservative_bytes",
      },
    };
  }
}

function durationSince(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function estimatedTokensOf(base: number, request: TokenizeRequest): number {
  const messageOverhead = request.messageCount * 4;
  const estimated = base + request.opaqueInputBytes + messageOverhead + 3;
  if (
    !Number.isSafeInteger(base) ||
    base < 0 ||
    !Number.isSafeInteger(messageOverhead) ||
    messageOverhead < 0 ||
    !Number.isSafeInteger(estimated) ||
    estimated < 0
  ) {
    throw new RangeError("Tokenizer arithmetic overflow.");
  }
  return estimated;
}
