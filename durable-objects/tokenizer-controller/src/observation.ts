import type { EstimationPath } from "./contracts";

export type TokenizerStage = "tokenizer_init" | "tokenizer_encode";
export type TokenizerStageOutcome = "success" | "fallback" | "exception";
export type TokenizerFailureCategory = "encoding_init" | "encoding_encode" | "arithmetic" | "work_limit";

type TokenizerStageEventBase = {
  readonly event: "octg.tokenizer_stage";
  readonly requestId: string;
  readonly revisionId: string;
  readonly stage: TokenizerStage;
  readonly byteCount?: number;
  readonly tokenCount?: number;
  readonly estimationPath?: EstimationPath;
  readonly failureCategory?: TokenizerFailureCategory;
};

export type TokenizerStageEvent =
  | (TokenizerStageEventBase & {
      readonly phase: "start";
      readonly durationMs?: never;
      readonly outcome?: never;
    })
  | (TokenizerStageEventBase & {
      readonly phase: "finish";
      readonly durationMs: number;
      readonly outcome: TokenizerStageOutcome;
    });

export function emitTokenizerStage(event: TokenizerStageEvent): void {
  try {
    const runtimeEvent = {
      event: event.event,
      requestId: event.requestId,
      revisionId: event.revisionId,
      stage: event.stage,
      phase: event.phase,
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
      ...(event.byteCount === undefined ? {} : { byteCount: event.byteCount }),
      ...(event.tokenCount === undefined ? {} : { tokenCount: event.tokenCount }),
      ...(event.estimationPath === undefined ? {} : { estimationPath: event.estimationPath }),
      ...(event.failureCategory === undefined ? {} : { failureCategory: event.failureCategory }),
    };
    console.log(runtimeEvent);
  } catch {
    // no-excuse-ok: catch — telemetry must never make tokenization fail.
  }
}
