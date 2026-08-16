export type ResourceStage =
  | "body_read"
  | "parse"
  | "normalize"
  | "tokenize"
  | "quota_get_state"
  | "quota_reserve"
  | "upstream";

export type ResourceStageRoute =
  | "free_shared"
  | "reject:request_too_large"
  | "reject:complimentary_quota"
  | "reject:model_not_allowed"
  | "reject:duplicate_idempotency_key"
  | "reject:worker_concurrency"
  | "reject:tokenization_concurrency"
  | "error:pre_upstream"
  | "error:upstream_uncertain";

export type ResourceStageOutcome = "success" | "rejected" | "exception" | "uncertain";

type ResourceStageEventBase = {
  readonly event: "octg.resource_stage";
  readonly requestId: string;
  readonly revisionId: string;
  readonly stage: ResourceStage;
  readonly route?: ResourceStageRoute;
  readonly rawBodyBytes?: number;
  readonly rawBodyBytesSource?: "measured" | "declared_content_length" | "measured_partial";
  readonly rawBodyTruncated?: boolean;
  readonly inputBytes?: number;
  readonly inputTextBytes?: number;
  readonly opaqueInputBytes?: number;
  readonly estimationPath?: "exact_bpe" | "conservative_bytes";
  readonly concurrency?: number;
  readonly quotaReserved?: boolean;
  readonly upstreamReached?: boolean;
};

export type ResourceStageEvent =
  | (ResourceStageEventBase & {
      readonly phase: "start";
      readonly durationMs?: never;
      readonly outcome?: never;
    })
  | (ResourceStageEventBase & {
      readonly phase: "finish";
      readonly durationMs: number;
      readonly outcome: ResourceStageOutcome;
    });

export function emitResourceStage(event: ResourceStageEvent): void {
  console.info(event);
}
