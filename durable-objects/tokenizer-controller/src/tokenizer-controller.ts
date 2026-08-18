import { DurableObject } from "cloudflare:workers";
import { getEncoding, type Tiktoken } from "js-tiktoken";

export interface TokenizerControllerEnv {
  readonly CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export interface TokenizeRequest {
  readonly requestId: string;
  readonly inputText: string;
  readonly messageCount: number;
  readonly opaqueInputBytes: number;
}

export interface TokenizeResult {
  readonly estimatedInputTokens: number;
  readonly estimationPath: "exact_bpe" | "conservative_bytes";
}

export type TokenizerOutcome =
  | { readonly kind: "resolved"; readonly result: TokenizeResult }
  | { readonly kind: "unavailable" };

type TokenizerStage = "tokenizer_init" | "tokenizer_encode";
type TokenizerStagePhase = "start" | "finish";
type TokenizerStageOutcome = "success" | "fallback" | "exception";

interface TokenizerStageEvent {
  readonly event: "octg.tokenizer_stage";
  readonly requestId: string;
  readonly revisionId: string;
  readonly stage: TokenizerStage;
  readonly phase: TokenizerStagePhase;
  readonly outcome?: TokenizerStageOutcome;
  readonly durationMs?: number;
  readonly byteCount?: number;
  readonly tokenCount?: number;
  readonly estimationPath?: "exact_bpe" | "conservative_bytes";
  readonly failureCategory?: string;
}

export class TokenizerController extends DurableObject<TokenizerControllerEnv> {
  private encoding: Tiktoken | undefined;

  private get revisionId(): string {
    const id = this.env.CF_VERSION_METADATA?.id;
    return typeof id === "string" && id.length > 0 ? id : "local";
  }

  async estimate(request: unknown): Promise<TokenizerOutcome> {
    const validated = validateTokenizeRequest(request);
    if (validated === null) {
      return { kind: "unavailable" };
    }

    const encodeStartedAt = performance.now();
    const encodeStage = this.startStage(validated.requestId, "tokenizer_encode");
    let encodingReady = false;
    let byteCount: number | undefined;
    try {
      if (this.encoding === undefined) {
        const initStartedAt = performance.now();
        const initStage = this.startStage(validated.requestId, "tokenizer_init");
        try {
          this.encoding = getEncoding("o200k_base");
          this.finishStage(initStage, "success", performance.now() - initStartedAt, {});
        } catch {
          this.finishStage(initStage, "fallback", performance.now() - initStartedAt, {
            failureCategory: "encoding_init_failure",
          });
          // byteCount is needed for the fallback path below
          byteCount = byteCountFor(validated.inputText);
          const base = byteCount;
          const estimated =
            base + validated.opaqueInputBytes + 4 * validated.messageCount + 3;
          if (!isNonNegativeSafeInteger(estimated)) {
            this.finishStage(encodeStage, "exception", performance.now() - encodeStartedAt, {
              byteCount,
              failureCategory: "unsafe_integer",
            });
            return { kind: "unavailable" };
          }
          this.finishStage(encodeStage, "fallback", performance.now() - encodeStartedAt, {
            byteCount,
            tokenCount: base,
            estimationPath: "conservative_bytes",
          });
          return {
            kind: "resolved",
            result: {
              estimatedInputTokens: estimated,
              estimationPath: "conservative_bytes",
            },
          };
        }
      }

      encodingReady = true;
      const encoding = this.encoding;
      const base = encoding.encode(validated.inputText).length;
      byteCount = byteCount ?? byteCountFor(validated.inputText);
      const estimated =
        base + validated.opaqueInputBytes + 4 * validated.messageCount + 3;
      if (!isNonNegativeSafeInteger(estimated)) {
        this.finishStage(encodeStage, "exception", performance.now() - encodeStartedAt, {
          byteCount,
          failureCategory: "unsafe_integer",
        });
        return { kind: "unavailable" };
      }
      this.finishStage(encodeStage, "success", performance.now() - encodeStartedAt, {
        byteCount,
        tokenCount: base,
        estimationPath: "exact_bpe",
      });
      return {
        kind: "resolved",
        result: {
          estimatedInputTokens: estimated,
          estimationPath: "exact_bpe",
        },
      };
    } catch {
      byteCount = byteCount ?? byteCountFor(validated.inputText);
      const base = byteCount;
      const estimated =
        base + validated.opaqueInputBytes + 4 * validated.messageCount + 3;
      if (!isNonNegativeSafeInteger(estimated)) {
        this.finishStage(encodeStage, "exception", performance.now() - encodeStartedAt, {
          byteCount,
          failureCategory: "unsafe_integer",
        });
        return { kind: "unavailable" };
      }
      this.finishStage(encodeStage, "fallback", performance.now() - encodeStartedAt, {
        byteCount,
        tokenCount: base,
        estimationPath: "conservative_bytes",
        failureCategory: "encoding_encode_failure",
      });
      return {
        kind: "resolved",
        result: {
          estimatedInputTokens: estimated,
          estimationPath: "conservative_bytes",
        },
      };
    }
  }

  private startStage(requestId: string, stage: TokenizerStage): TokenizerStageEvent {
    const event: TokenizerStageEvent = {
      event: "octg.tokenizer_stage",
      requestId,
      revisionId: this.revisionId,
      stage,
      phase: "start",
    };
    console.info(event);
    return { ...event, phase: "finish" };
  }

  private finishStage(
    base: TokenizerStageEvent,
    outcome: TokenizerStageOutcome,
    durationMs: number,
    fields: Omit<
      Partial<TokenizerStageEvent>,
      "event" | "requestId" | "revisionId" | "stage" | "phase" | "outcome" | "durationMs"
    > = {},
  ): void {
    console.info({
      ...base,
      phase: "finish",
      outcome,
      durationMs: Math.max(0, durationMs),
      ...fields,
    });
  }
}

function validateTokenizeRequest(request: unknown): TokenizeRequest | null {
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const candidate = request as Record<string, unknown>;
  if (typeof candidate.requestId !== "string" || candidate.requestId.length === 0) {
    return null;
  }
  if (typeof candidate.inputText !== "string") {
    return null;
  }
  if (!isNonNegativeSafeInteger(candidate.messageCount)) {
    return null;
  }
  if (!isNonNegativeSafeInteger(candidate.opaqueInputBytes)) {
    return null;
  }
  return {
    requestId: candidate.requestId,
    inputText: candidate.inputText,
    messageCount: candidate.messageCount,
    opaqueInputBytes: candidate.opaqueInputBytes,
  };
}

function byteCountFor(inputText: string): number {
  return new TextEncoder().encode(inputText).length;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
