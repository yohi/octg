import { resolveTokenBudget } from "./token-budget";
import { resolveDenoRuntimeConfig } from "./deno-tokenizer-config";
import {
  routeTokenization,
  type RoutedTokenizationOutcome,
} from "./tokenization-routing";
import {
  buildOctgHeaders,
  classifyModel,
  DEFAULT_IN_FLIGHT_LEASE_RENEWAL_MS,
  DEFAULT_IN_FLIGHT_LEASE_TTL_MS,
  errInputTooLarge,
  errInternal,
  errInvalidRequest,
  errMaxTokensConflict,
  errModelNotAllowed,
  errModelRequiresPaid,
  errNonTextInput,
  errQuotaExceeded,
  errRequestTooLarge,
  errWorkerConcurrencyExceeded,
  errorResponse as buildErrorResponse,
  MAX_INPUT_TEXT_BYTES,
  nextUtcMidnight,
  normalizeChatCompletions,
  normalizeResponses,
  parseIdempotencyKey,
  quotaIdOf,
  resolveMaxInputBytes,
  toPoolLower,
  utcDayOf,
  type QuotaSnapshot,
  type QuotaView,
  type InFlightLease,
  type PrepareErrorCode,
  type PrepareMetadata,
  type ReserveResult,
  type Usage,
} from "@octg/shared";
import { authenticate } from "./auth";
import {
  completeRequestAuditBestEffort,
  setReservedTokens,
  startRequestAuditBestEffort,
  type RequestCompleteFields,
} from "./db";
import { loadPolicy, loadRegistry } from "./policy";
import { buildUpstreamBody, callUpstream, UpstreamConfigError } from "./upstream";
import { reserveFailClosed, type ReserveOutcome } from "./quota-reservation";
import type { QuotaController } from "@octg/quota-controller";
import type { Env } from "./index";
import { readJsonBody } from "./request-body";
import {
  emitResourceStage,
  type ResourceStage,
  type ResourceStageOutcome,
  type ResourceStageRoute,
  type TokenizationProvider,
  type TokenizationFailureCategory,
  type TokenizationNetworkErrorName,
} from "./resource-observation";
import { proxyStream } from "./stream";
import type { TokenizeResult } from "@octg/tokenizer-controller/contracts";
import { assertNever } from "./exhaustiveness";
import { workerVersionHeaders, type WorkerVersionMetadataLike } from "./version-metadata";
import { prepareWithDeno } from "./deno-prepare-client";
import { replaceOutputMarker } from "./prepared-body";
import type { UpstreamTransport } from "./upstream";

type Completion = RequestCompleteFields;
const MIN_SAFE_IN_FLIGHT_LEASE_TTL_MS = 120_000;
const MAX_TOKENIZATION_RPC_INPUT_BYTES = MAX_INPUT_TEXT_BYTES;

export type InFlightLeaseReleaser = Pick<QuotaController, "releaseInFlight">;

export async function releaseInFlightBestEffort(
  releaser: InFlightLeaseReleaser,
  lease: InFlightLease,
): Promise<void> {
  await releaser.releaseInFlight(lease.requestId, lease.generation).catch(() => undefined);
}

function completeAudit(
  ctx: ExecutionContext,
  env: Env,
  requestId: string,
  inserted: Promise<boolean> | undefined,
  fields: Completion,
): void {
  if (!inserted) return;
  ctx.waitUntil(completeRequestAuditBestEffort(env, requestId, fields, inserted));
}

function upstreamResponse(
  upstream: Response,
  requestId: string,
  snapshot: QuotaSnapshot,
  versionMetadata: WorkerVersionMetadataLike | undefined,
): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      ...buildOctgHeaders({ requestId, quota: snapshot, route: "free_shared" }),
      ...workerVersionHeaders(versionMetadata),
    },
  });
}

function withWorkerVersion(response: Response, metadata: WorkerVersionMetadataLike | undefined): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(workerVersionHeaders(metadata))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function snapshotOf(view: QuotaView): QuotaSnapshot {
  return {
    pool: view.pool,
    limit: view.limit,
    used: view.confirmedTokens + view.reservedTokens + view.uncertainTokens,
    remaining: view.remaining,
    resetAt: nextUtcMidnight(new Date(`${view.utcDay}T00:00:00Z`)),
  };
}

export function resolveMaxInFlightRequests(configured: string | undefined): number {
  return resolvePositiveSafeInteger(configured, 2);
}

function resolvePositiveSafeInteger(configured: string | undefined, defaultValue: number): number {
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function resolveInFlightLeaseTtlMs(configured: string | undefined): number {
  return Math.max(
    resolvePositiveSafeInteger(configured, DEFAULT_IN_FLIGHT_LEASE_TTL_MS),
    MIN_SAFE_IN_FLIGHT_LEASE_TTL_MS,
  );
}

export function resolveInFlightLeaseRenewalMs(configured: string | undefined): number {
  return Math.min(
    resolvePositiveSafeInteger(configured, DEFAULT_IN_FLIGHT_LEASE_RENEWAL_MS),
    DEFAULT_IN_FLIGHT_LEASE_RENEWAL_MS,
  );
}

type ResourceStageFields = {
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
  readonly tokenizationProvider?: TokenizationProvider;
  readonly tokenizationFailureCategory?: TokenizationFailureCategory;
  readonly tokenizationNetworkErrorName?: TokenizationNetworkErrorName;
};

type MutableResourceStageFields = {
  -readonly [Key in keyof ResourceStageFields]: ResourceStageFields[Key];
};

function revisionIdOf(env: Env): string {
  const revisionId = env.CF_VERSION_METADATA?.id;
  return typeof revisionId === "string" && revisionId.length > 0 ? revisionId : "local";
}

function startResourceStage(env: Env, requestId: string, stage: ResourceStage): number {
  const startedAt = performance.now();
  emitResourceStage({
    event: "octg.resource_stage",
    requestId,
    revisionId: revisionIdOf(env),
    stage,
    phase: "start",
  });
  return startedAt;
}

function finishResourceStage(
  env: Env,
  requestId: string,
  stage: ResourceStage,
  startedAt: number,
  outcome: ResourceStageOutcome,
  fields: ResourceStageFields = {},
  measuredDurationMs?: number,
): void {
  const definedFields: MutableResourceStageFields = {};
  if (fields.route !== undefined) definedFields.route = fields.route;
  if (fields.rawBodyBytes !== undefined) definedFields.rawBodyBytes = fields.rawBodyBytes;
  if (fields.rawBodyBytesSource !== undefined) definedFields.rawBodyBytesSource = fields.rawBodyBytesSource;
  if (fields.rawBodyTruncated !== undefined) definedFields.rawBodyTruncated = fields.rawBodyTruncated;
  if (fields.inputBytes !== undefined) definedFields.inputBytes = fields.inputBytes;
  if (fields.inputTextBytes !== undefined) definedFields.inputTextBytes = fields.inputTextBytes;
  if (fields.opaqueInputBytes !== undefined) definedFields.opaqueInputBytes = fields.opaqueInputBytes;
  if (fields.estimationPath !== undefined) definedFields.estimationPath = fields.estimationPath;
  if (fields.concurrency !== undefined) definedFields.concurrency = fields.concurrency;
  if (fields.quotaReserved !== undefined) definedFields.quotaReserved = fields.quotaReserved;
  if (fields.upstreamReached !== undefined) definedFields.upstreamReached = fields.upstreamReached;
  if (fields.tokenizationProvider !== undefined) definedFields.tokenizationProvider = fields.tokenizationProvider;
  if (fields.tokenizationFailureCategory !== undefined) definedFields.tokenizationFailureCategory = fields.tokenizationFailureCategory;
  if (fields.tokenizationNetworkErrorName !== undefined) definedFields.tokenizationNetworkErrorName = fields.tokenizationNetworkErrorName;
  emitResourceStage({
    event: "octg.resource_stage",
    requestId,
    revisionId: revisionIdOf(env),
    stage,
    phase: "finish",
    durationMs: Math.max(0, measuredDurationMs ?? performance.now() - startedAt),
    outcome,
    ...definedFields,
  });
}

function routeForReserveFailure(reason: string): ResourceStageRoute {
  return reason === "duplicate_idempotency_key"
    ? "reject:duplicate_idempotency_key"
    : "reject:complimentary_quota";
}

function upstreamStageResult(upstream: Response): {
  readonly isUncertain: boolean;
  readonly outcome: ResourceStageOutcome;
  readonly fields: ResourceStageFields;
} {
  if (upstream.ok) {
    return {
      isUncertain: false,
      outcome: "success",
      fields: { route: "free_shared", quotaReserved: true, upstreamReached: true },
    };
  }
  return {
    isUncertain: true,
    outcome: "uncertain",
    fields: { route: "error:upstream_uncertain", quotaReserved: true, upstreamReached: true },
  };
}

type DeclaredContentLength =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "valid"; readonly value: number };

function parseDeclaredContentLength(value: string | null): DeclaredContentLength {
  if (value === null) return { kind: "absent" };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? { kind: "valid", value: parsed }
    : { kind: "malformed" };
}

type PreparedBodyTerminal = "close" | "error" | "cancel";

function createPrepareFinalizer(
  env: Env,
  requestId: string,
  startedAt: number,
): (
  outcome: ResourceStageOutcome,
  fields?: ResourceStageFields,
) => void {
  let finished = false;
  return function finishPrepareOnce(
    outcome: ResourceStageOutcome,
    fields: ResourceStageFields = {},
  ): void {
    if (finished) return;
    finished = true;
    finishResourceStage(env, requestId, "prepare", startedAt, outcome, fields);
  };
}

function observePreparedBody(
  body: ReadableStream<Uint8Array>,
  cancelSource: () => Promise<void>,
  onTerminal: (terminal: PreparedBodyTerminal) => void,
): {
  readonly body: ReadableStream<Uint8Array>;
  readonly cancel: () => Promise<void>;
} {
  const reader = body.getReader();
  let terminalSeen = false;
  let cancelPromise: Promise<void> | undefined;
  const releaseReader = (): void => {
    try {
      reader.releaseLock();
    } catch {
      // The terminal path may already have released the lock.
    }
  };
  const notify = (terminal: PreparedBodyTerminal): void => {
    if (terminalSeen) return;
    terminalSeen = true;
    onTerminal(terminal);
  };
  const cancelResources = (): Promise<void> => {
    cancelPromise ??= (async () => {
      await cancelSource().catch(() => undefined);
      await reader.cancel().catch(() => undefined);
    })();
    return cancelPromise;
  };
  const cancel = async (): Promise<void> => {
    if (terminalSeen) {
      if (cancelPromise !== undefined) await cancelPromise;
      return;
    }
    notify("cancel");
    await cancelResources();
    releaseReader();
  };
  return {
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            notify("close");
            releaseReader();
            controller.close();
            return;
          }
          controller.enqueue(chunk.value);
        } catch {
          await cancelResources();
          notify("error");
          releaseReader();
          controller.error(new Error("Prepared body read failed."));
        }
      },
      cancel,
    }),
    cancel,
  };
}

function mapPrepareError(
  code: PrepareErrorCode,
  requestId: string,
): Parameters<typeof buildErrorResponse>[0] {
  switch (code) {
    case "invalid_body":
      return errInvalidRequest(requestId);
    case "non_text":
      return errNonTextInput(requestId);
    case "max_tokens_conflict":
      return errMaxTokensConflict(requestId);
    case "input_too_large":
    case "request_too_large":
      return errInputTooLarge(requestId);
    default:
      return assertNever(code, "prepare error code");
  }
}

type RejectedReserve = Extract<ReserveResult, { readonly ok: false }>;

function reserveFailureError(
  requestId: string,
  snapshot: QuotaSnapshot,
  reserved: RejectedReserve,
): Parameters<typeof buildErrorResponse>[0] {
  if (reserved.reason === "duplicate_idempotency_key") {
    return {
      status: 409,
      requestId,
      quota: snapshot,
      route: "reject:duplicate_idempotency_key",
      body: {
        error: {
          message: "Duplicate Idempotency-Key.",
          type: "invalid_request_error",
          param: null,
          code: "duplicate_idempotency_key",
        },
        request_id: requestId,
      },
    };
  }
  return errQuotaExceeded(
    { ...snapshot, remaining: reserved.remaining, resetAt: reserved.resetAt },
    requestId,
  );
}
export async function handleProxy(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  endpoint: "chat" | "responses",
  requestId: string,
): Promise<Response> {
  let auditInserted: Promise<boolean> | undefined;
  let quotaStub: DurableObjectStub<QuotaController> | undefined;
  let reservationState: "none" | "resolved" | "unknown" = "none";
  let upstreamAttempted = false;
  let upstreamReached = false;
  let inFlightAcquired = false;
  let inFlightLease: InFlightLease | undefined;
  let reserveStageStartedAt: number | undefined;
  let upstreamStageStartedAt: number | undefined;
  let preparedQuotaReserved = false;
  let explicitCancelInProgress = false;
  let prepareTimedOut = false;
  let prepared: { metadata: PrepareMetadata; body: ReadableStream<Uint8Array>; cancel: () => Promise<void> } | undefined;
  let cancelPreparedBeforeUpstream: ((outcome: "rejected" | "exception", fields: ResourceStageFields) => Promise<void>) | undefined;
  const errorResponse = (err: Parameters<typeof buildErrorResponse>[0]): Response =>
    withWorkerVersion(buildErrorResponse(err), env.CF_VERSION_METADATA);
  const handleCompletedUpstream = async (
    upstream: Response,
    upstreamStartedAt: number,
    stream: boolean,
    stub: DurableObjectStub<QuotaController>,
    snapshot: QuotaSnapshot,
  ): Promise<Response> => {
    upstreamReached = true;
    const inserted = auditInserted;
    if (inserted === undefined) throw new TypeError("Upstream response has no audit record.");
    const upstreamStage = upstreamStageResult(upstream);
    if (stream && upstream.ok) {
      const lease = inFlightLease;
      if (lease === undefined) throw new TypeError("Upstream response has no in-flight lease.");
      const response = proxyStream(
        upstream,
        stub,
        {
          lease,
          ttlMs: resolveInFlightLeaseTtlMs(env.IN_FLIGHT_LEASE_TTL_MS),
          renewalMs: resolveInFlightLeaseRenewalMs(env.IN_FLIGHT_LEASE_RENEWAL_MS),
        },
        env,
        ctx,
        snapshot,
        inserted,
        (finalizationOutcome) => {
          if (upstreamStageStartedAt === undefined) return;
          const stageStartedAt = upstreamStageStartedAt;
          upstreamStageStartedAt = undefined;
          finishResourceStage(
            env,
            requestId,
            "upstream",
            stageStartedAt,
            finalizationOutcome,
            finalizationOutcome === "success"
              ? upstreamStage.fields
              : { ...upstreamStage.fields, route: "error:upstream_uncertain" },
          );
        },
      );
      inFlightAcquired = false;
      return response;
    }

    upstreamStageStartedAt = undefined;
    finishResourceStage(env, requestId, "upstream", upstreamStartedAt, upstreamStage.outcome, upstreamStage.fields);
    if (!upstream.ok) {
      if (upstreamStage.isUncertain) await stub.markUncertain(requestId);
      else await stub.release(requestId);
      reservationState = "none";
      const lease = inFlightLease;
      if (lease === undefined) throw new TypeError("Upstream response has no in-flight lease.");
      await stub.releaseInFlight(requestId, lease.generation);
      inFlightAcquired = false;
      inFlightLease = undefined;
      completeAudit(ctx, env, requestId, auditInserted, {
        status: upstreamStage.isUncertain ? "uncertain" : "failed",
        billingClass: "none",
      });
      return upstreamResponse(upstream, requestId, snapshot, env.CF_VERSION_METADATA);
    }

    let rawText: string;
    let data: Record<string, unknown> & { usage?: Usage };
    try {
      rawText = await upstream.text();
      data = JSON.parse(rawText) as Record<string, unknown> & { usage?: Usage };
    } catch {
      await stub.markUncertain(requestId);
      reservationState = "none";
      const lease = inFlightLease;
      if (lease === undefined) throw new TypeError("Upstream response has no in-flight lease.");
      await stub.releaseInFlight(requestId, lease.generation);
      inFlightAcquired = false;
      inFlightLease = undefined;
      completeAudit(ctx, env, requestId, auditInserted, { status: "uncertain", billingClass: "none" });
      return errorResponse(errInternal(requestId));
    }

    const usage = data.usage;
    if (typeof usage?.total_tokens === "number") {
      const settled = await stub.settle(requestId, usage.total_tokens);
      reservationState = "none";
      if (!settled.ok && settled.reason === "unknown_request") {
        completeAudit(ctx, env, requestId, auditInserted, { status: "orphaned", billingClass: "none" });
      } else {
        const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
        const outputTokens = usage.completion_tokens ?? usage.output_tokens;
        completeAudit(ctx, env, requestId, auditInserted, {
          status: "completed",
          inputTokens,
          outputTokens,
          totalTokens: usage.total_tokens,
          billingClass: "free",
        });
      }
    } else {
      await stub.markUncertain(requestId);
      reservationState = "none";
      completeAudit(ctx, env, requestId, auditInserted, { status: "uncertain", billingClass: "none" });
    }
    const lease = inFlightLease;
    if (lease === undefined) throw new TypeError("Upstream response has no in-flight lease.");
    await stub.releaseInFlight(requestId, lease.generation);
    inFlightAcquired = false;
    inFlightLease = undefined;
    return new Response(rawText, {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...buildOctgHeaders({ requestId, quota: snapshot, route: "free_shared" }),
        ...workerVersionHeaders(env.CF_VERSION_METADATA),
      },
    });
  };
  const reserveRequest = async (args: {
    readonly stub: DurableObjectStub<QuotaController>;
    readonly reservation: number;
    readonly upperBound: number;
    readonly idempotencyKey: string | undefined;
    readonly clientId: string;
    readonly hasPreparedBody: boolean;
  }): Promise<ReserveOutcome> => {
    const reserveStartedAt = startResourceStage(env, requestId, "quota_reserve");
    reserveStageStartedAt = reserveStartedAt;
    let reserveOutcome: ReserveOutcome;
    try {
      reserveOutcome = await reserveFailClosed(
        (sameRequestId, sameTokens, sameUpperBound, sameIdempotencyKey, sameClientId) =>
          args.stub.reserve(sameRequestId, sameTokens, sameUpperBound, sameIdempotencyKey, sameClientId),
        {
          requestId,
          tokens: args.reservation,
          upperBoundTokens: args.upperBound,
          idempotencyKey: args.idempotencyKey,
          clientId: args.clientId,
        },
      );
    } catch (error) {
      finishResourceStage(env, requestId, "quota_reserve", reserveStartedAt, "exception", {
        route: "error:pre_upstream",
        upstreamReached: false,
      });
      reserveStageStartedAt = undefined;
      await cancelPreparedBeforeUpstream?.("exception", {
        route: "error:pre_upstream",
        quotaReserved: preparedQuotaReserved,
        upstreamReached: false,
      });
      throw error;
    }

    if (reserveOutcome.kind === "unknown") {
      reservationState = "unknown";
      finishResourceStage(env, requestId, "quota_reserve", reserveStartedAt, "exception", {
        route: "error:pre_upstream",
        upstreamReached: false,
      });
    } else {
      const reserved = reserveOutcome.result;
      reservationState = reserved.ok ? "resolved" : "none";
      preparedQuotaReserved = args.hasPreparedBody && reserved.ok;
      finishResourceStage(
        env,
        requestId,
        "quota_reserve",
        reserveStartedAt,
        reserved.ok ? "success" : "rejected",
        {
          route: reserved.ok ? "free_shared" : routeForReserveFailure(reserved.reason),
          quotaReserved: reserved.ok,
          ...(args.hasPreparedBody ? { upstreamReached: false } : {}),
        },
      );
    }
    reserveStageStartedAt = undefined;
    return reserveOutcome;
  };
  const rejectUnknownReservation = async (
    stub: DurableObjectStub<QuotaController>,
    snapshot: QuotaSnapshot,
  ): Promise<Response> => {
    await cancelPreparedBeforeUpstream?.("exception", {
      route: "error:pre_upstream",
      quotaReserved: false,
      upstreamReached: false,
    });
    await stub.markReserveOutcomeUnknown(requestId).catch(() => undefined);
    completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
    return errorResponse(errInternal(requestId, { quota: snapshot, route: "error:internal_error" }));
  };

  try {
    const auth = await authenticate(request, env, requestId);
    if (!("id" in auth)) return errorResponse(auth);
    const parsedIdempotencyKey = parseIdempotencyKey(request.headers.get("Idempotency-Key"));
    if (parsedIdempotencyKey.kind === "invalid") {
      return errorResponse(
        errInvalidRequest(requestId, "Idempotency-Key must be at most 255 UTF-8 bytes."),
      );
    }
    const idempotencyKey = parsedIdempotencyKey.kind === "valid"
      ? parsedIdempotencyKey.value
      : undefined;
    const denoRuntimeConfig = resolveDenoRuntimeConfig(env);
    if (denoRuntimeConfig.tokenizer.kind === "invalid") {
      const tokenizeStartedAt = startResourceStage(env, requestId, "tokenize");
      finishResourceStage(env, requestId, "tokenize", tokenizeStartedAt, "exception", {
        route: "error:tokenizer_unavailable",
        tokenizationProvider: "deno",
        tokenizationFailureCategory: "configuration",
        quotaReserved: false,
        upstreamReached: false,
      });
      return errorResponse(errInternal(requestId));
    }
    const denoTokenizerConfig = denoRuntimeConfig.tokenizer;
    const denoPrepareConfig = denoRuntimeConfig.prepare;
    if (endpoint === "responses" && denoPrepareConfig.kind === "invalid") {
      const prepareStartedAt = startResourceStage(env, requestId, "prepare");
      finishResourceStage(env, requestId, "prepare", prepareStartedAt, "exception", {
        route: "error:pre_upstream",
        quotaReserved: false,
        upstreamReached: false,
      });
      return errorResponse(errInternal(requestId));
    }


    const maxInputBytes = Math.min(
      resolveMaxInputBytes(env.MAX_INPUT_BYTES),
      MAX_TOKENIZATION_RPC_INPUT_BYTES,
    );

    // --- Prepare routing ---
    const declared = parseDeclaredContentLength(request.headers.get("content-length"));
    if (declared.kind === "valid" && declared.value > maxInputBytes) {
      await request.body?.cancel().catch(() => undefined);
      return errorResponse(errInputTooLarge(requestId));
    }

    const usePrepare = endpoint === "responses" && denoPrepareConfig.kind === "enabled" &&
      declared.kind !== "malformed" &&
      (declared.kind === "absent" || declared.value > denoPrepareConfig.thresholdBytes);

    if (usePrepare && denoPrepareConfig.kind === "enabled") {
      const prepareConfig = denoPrepareConfig;
      const prepareStartedAt = startResourceStage(env, requestId, "prepare");
      const finishPrepareOnce = createPrepareFinalizer(env, requestId, prepareStartedAt);
      explicitCancelInProgress = false;
      preparedQuotaReserved = false;
      prepareTimedOut = false;
      const finishPrepareTimeout = (): void => {
        prepareTimedOut = true;
        if (explicitCancelInProgress) return;
        finishPrepareOnce(upstreamAttempted ? "uncertain" : "exception", {
          route: upstreamAttempted ? "error:upstream_uncertain" : "error:pre_upstream",
          quotaReserved: preparedQuotaReserved,
          upstreamReached,
        });
      };
      const outcome = await prepareWithDeno({
        endpoint: prepareConfig.endpoint,
        authToken: prepareConfig.authToken,
        timeoutMs: prepareConfig.timeoutMs,
        maxInputBytes: prepareConfig.maxInputBytes,
        request,
        onTimeout: finishPrepareTimeout,
      });

      let prepareMetadata: PrepareMetadata;
      switch (outcome.kind) {
        case "rejected":
          finishPrepareOnce("rejected", {
            quotaReserved: false,
            upstreamReached: false,
          });
          return errorResponse(mapPrepareError(outcome.code, requestId));
        case "unavailable":
          finishPrepareOnce("exception", {
            quotaReserved: false,
            upstreamReached: false,
          });
          return errorResponse(errInternal(requestId));
        case "resolved":
          prepareMetadata = outcome.metadata;
          prepared = { metadata: prepareMetadata, body: outcome.body, cancel: outcome.cancel };
          break;
        default:
          return assertNever(outcome, "prepare outcome");
      }

      // --- Metadata-only downstream decisions for the resolved prepared request ---
      const finishPreparedTerminal = (terminal: PreparedBodyTerminal): void => {
        if (explicitCancelInProgress) return;
        const attempted = upstreamAttempted;
        if (terminal === "close") {
          finishPrepareOnce("success", {
            rawBodyBytes: prepareMetadata.rawBodyBytes,
            inputBytes: prepareMetadata.inputBytes,
            inputTextBytes: prepareMetadata.inputTextBytes,
            opaqueInputBytes: prepareMetadata.opaqueInputBytes,
            estimationPath: prepareMetadata.estimationPath,
            tokenizationProvider: "deno",
            quotaReserved: preparedQuotaReserved,
            upstreamReached,
          });
          return;
        }
        finishPrepareOnce(attempted ? "uncertain" : "exception", {
          route: attempted ? "error:upstream_uncertain" : "error:pre_upstream",
          quotaReserved: preparedQuotaReserved,
          upstreamReached,
        });
      };

      cancelPreparedBeforeUpstream = async (
        cancelOutcome: "rejected" | "exception",
        cancelFields: ResourceStageFields,
      ): Promise<void> => {
        if (prepared === undefined) return;
        explicitCancelInProgress = true;
        try {
          await prepared.cancel().catch(() => undefined);
        } finally {
          explicitCancelInProgress = false;
          finishPrepareOnce(cancelOutcome, cancelFields);
        }
      };

      // Model classification
      const registry = await loadRegistry(env);
      if (prepareTimedOut) {
        await cancelPreparedBeforeUpstream("exception", {
          route: "error:pre_upstream",
          quotaReserved: preparedQuotaReserved,
          upstreamReached: false,
        });
        completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
        return errorResponse(errInternal(requestId));
      }
      const pool = classifyModel(prepareMetadata.model, registry);
      if (pool === "NONE") {
        await cancelPreparedBeforeUpstream("rejected", {
          route: "reject:complimentary_quota",
          quotaReserved: false,
          upstreamReached: false,
        });
        return errorResponse(errModelRequiresPaid(requestId));
      }
      const day = utcDayOf(new Date());
      const stub = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, day)));
      quotaStub = stub;
      const policy = await loadPolicy(env, auth.id);
      if (prepareTimedOut) {
        await cancelPreparedBeforeUpstream("exception", {
          route: "error:pre_upstream",
          quotaReserved: preparedQuotaReserved,
          upstreamReached: false,
        });
        completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
        return errorResponse(errInternal(requestId));
      }

      // Tool-policy rejection
      if (prepareMetadata.isToolUse && policy.toolsMode !== "ALLOW") {
        const toolGetStateStartedAt = startResourceStage(env, requestId, "quota_get_state");
        let toolState;
        try {
          toolState = await stub.getState();
        } catch (error) {
          finishResourceStage(env, requestId, "quota_get_state", toolGetStateStartedAt, "exception");
          throw error;
        }
        finishResourceStage(env, requestId, "quota_get_state", toolGetStateStartedAt, "success");
        if (prepareTimedOut) {
          await cancelPreparedBeforeUpstream("exception", {
            route: "error:pre_upstream",
            quotaReserved: preparedQuotaReserved,
            upstreamReached: false,
          });
          completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
          return errorResponse(errInternal(requestId));
        }
        await cancelPreparedBeforeUpstream("rejected", {
          route: "reject:model_not_allowed",
          quotaReserved: false,
          upstreamReached: false,
        });
        return errorResponse(errModelNotAllowed(requestId, snapshotOf(toolState)));
      }

      auditInserted = startRequestAuditBestEffort(env, {
        requestId,
        utcDay: day,
        clientId: auth.id,
        requestedModel: prepareMetadata.model,
        upstreamModel: prepareMetadata.model,
        pool: pool,
        eligibility: "COMPLIMENTARY",
        reservedTokens: null,
      });

      // Quota get_state
      const getStateStartedAt = startResourceStage(env, requestId, "quota_get_state");
      let before;
      try {
        before = await stub.getState();
      } catch (error) {
        finishResourceStage(env, requestId, "quota_get_state", getStateStartedAt, "exception");
        throw error;
      }
      finishResourceStage(env, requestId, "quota_get_state", getStateStartedAt, "success");
      if (prepareTimedOut) {
        await cancelPreparedBeforeUpstream("exception", {
          route: "error:pre_upstream",
          quotaReserved: preparedQuotaReserved,
          upstreamReached: false,
        });
        completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
        return errorResponse(errInternal(requestId));
      }
      const snapshot = snapshotOf(before);

      // Token budget from metadata
      const budget = resolveTokenBudget({
        estimatedInput: prepareMetadata.estimatedInputTokens,
        maxOutputTokens: prepareMetadata.maxOutputTokens,
        remaining: before.remaining,
        limit: before.limit,
        outputLimitMode: policy.outputLimitMode,
      });
      switch (budget.kind) {
        case "arithmetic_error":
          await cancelPreparedBeforeUpstream("exception", {
            route: "error:arithmetic_error",
            inputBytes: prepareMetadata.inputBytes,
            inputTextBytes: prepareMetadata.inputTextBytes,
            opaqueInputBytes: prepareMetadata.opaqueInputBytes,
            estimationPath: prepareMetadata.estimationPath,
            tokenizationProvider: "deno",
            quotaReserved: false,
            upstreamReached: false,
          });
          completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
          return errorResponse(errInternal(requestId, { quota: snapshot, route: "error:internal_error" }));
        case "request_too_large":
          await cancelPreparedBeforeUpstream("rejected", {
            route: "reject:request_too_large",
            inputBytes: prepareMetadata.inputBytes,
            inputTextBytes: prepareMetadata.inputTextBytes,
            opaqueInputBytes: prepareMetadata.opaqueInputBytes,
            estimationPath: prepareMetadata.estimationPath,
            tokenizationProvider: "deno",
            quotaReserved: false,
            upstreamReached: false,
          });
          completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
          return errorResponse(errRequestTooLarge(snapshot, requestId));
        case "quota_exceeded":
          await cancelPreparedBeforeUpstream("rejected", {
            route: "reject:complimentary_quota",
            inputBytes: prepareMetadata.inputBytes,
            inputTextBytes: prepareMetadata.inputTextBytes,
            opaqueInputBytes: prepareMetadata.opaqueInputBytes,
            estimationPath: prepareMetadata.estimationPath,
            tokenizationProvider: "deno",
            quotaReserved: false,
            upstreamReached: false,
          });
          completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
          return errorResponse(errQuotaExceeded(snapshot, requestId));
        case "resolved":
          break;
        default:
          return assertNever(budget, "proxy outcome");
      }

      // Quota reservation
      const { reservation, upperBound } = budget;
      const reserveOutcome = await reserveRequest({
        stub,
        reservation,
        upperBound,
        idempotencyKey,
        clientId: auth.id,
        hasPreparedBody: true,
      });
      reservationState = reserveOutcome.kind === "unknown"
        ? "unknown"
        : reserveOutcome.result.ok ? "resolved" : "none";
      preparedQuotaReserved = reserveOutcome.kind === "resolved" && reserveOutcome.result.ok;

      if (prepareTimedOut) {
        await cancelPreparedBeforeUpstream?.("exception", {
          route: "error:pre_upstream",
          quotaReserved: preparedQuotaReserved,
          upstreamReached: false,
        });
        if (reservationState === "unknown") {
          await stub.markReserveOutcomeUnknown(requestId).catch(() => undefined);
        } else if (reservationState === "resolved") {
          await stub.release(requestId).catch(() => undefined);
          reservationState = "none";
        }
        completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
        return errorResponse(errInternal(requestId));
      }

      // Handle reserve rejection
      if (reserveOutcome.kind !== "unknown") {
        const reserved = reserveOutcome.result;
        if (!reserved.ok) {
          await cancelPreparedBeforeUpstream?.("rejected", {
            route: routeForReserveFailure(reserved.reason),
            quotaReserved: false,
            upstreamReached: false,
          });
          completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
          return errorResponse(reserveFailureError(requestId, snapshot, reserved));
        }
      }

      // Handle unknown reserve outcome
      if (reserveOutcome.kind === "unknown") {
        return rejectUnknownReservation(stub, snapshot);
      }

      if (auditInserted !== undefined) {
        ctx.waitUntil(auditInserted.then((insertSucceeded) =>
          insertSucceeded ? setReservedTokens(env, requestId, reservation) : undefined).catch(() => undefined));
      }

      const rejectPrepareTimeout = async (): Promise<Response> => {
        await cancelPreparedBeforeUpstream?.("exception", {
          route: "error:pre_upstream",
          quotaReserved: preparedQuotaReserved,
          upstreamReached: false,
        });
        if (inFlightAcquired && inFlightLease !== undefined) {
          await releaseInFlightBestEffort(stub, inFlightLease);
          inFlightAcquired = false;
          inFlightLease = undefined;
        }
        if (reservationState === "resolved") {
          await stub.release(requestId).catch(() => undefined);
          reservationState = "none";
        }
        completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
        return errorResponse(errInternal(requestId));
      };

      // In-flight admission
      const lease = await stub.acquireInFlight(
        requestId,
        resolveMaxInFlightRequests(env.MAX_IN_FLIGHT_REQUESTS),
        resolveInFlightLeaseTtlMs(env.IN_FLIGHT_LEASE_TTL_MS),
      );
      if (lease.ok) {
        inFlightAcquired = true;
        inFlightLease = lease.lease;
      }

      if (prepareTimedOut) {
        return rejectPrepareTimeout();
      }

      if (!lease.ok) {
        await cancelPreparedBeforeUpstream?.("rejected", {
          route: "reject:worker_concurrency",
          quotaReserved: preparedQuotaReserved,
          upstreamReached: false,
        });
        await stub.release(requestId);
        reservationState = "none";
        completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
        return errorResponse(errWorkerConcurrencyExceeded(snapshot, requestId));
      }

      if (prepareTimedOut) {
        return rejectPrepareTimeout();
      }

      // Build marker transform + observer, then call upstream
      const upstreamStartedAt = startResourceStage(env, requestId, "upstream");
      upstreamStageStartedAt = upstreamStartedAt;
      let upstream: Response;
      try {
        const upstreamTransport: UpstreamTransport = (input, init) => {
          upstreamAttempted = true;
          return fetch(input, init);
        };
        const replacedBody = replaceOutputMarker(prepared.body, prepareMetadata.outputMarker, budget.maxOutputTokens);
        const observed = observePreparedBody(replacedBody, prepared.cancel, finishPreparedTerminal);
        prepared = { ...prepared, body: observed.body, cancel: observed.cancel };
        upstream = await callUpstream(
          env,
          "/responses",
          prepared.body,
          {
            client_id: auth.id,
            pool: toPoolLower(pool),
            eligibility: "COMPLIMENTARY",
            route: "free_shared",
            request_id: requestId,
          },
          policy.cacheEnabled ? `octg:${auth.id}` : null,
          idempotencyKey,
          upstreamTransport,
        );
      } catch (error) {
        finishResourceStage(
          env,
          requestId,
          "upstream",
          upstreamStartedAt,
          "exception",
          {
            route: error instanceof UpstreamConfigError || !upstreamAttempted
              ? "error:pre_upstream"
              : "error:upstream_uncertain",
            quotaReserved: true,
            upstreamReached: false,
          },
        );
        upstreamStageStartedAt = undefined;
        if (error instanceof UpstreamConfigError || !upstreamAttempted) {
          await cancelPreparedBeforeUpstream?.("exception", {
            route: "error:pre_upstream",
            quotaReserved: preparedQuotaReserved,
            upstreamReached: false,
          });
          await stub.release(requestId);
          reservationState = "none";
          await stub.releaseInFlight(requestId, inFlightLease!.generation);
          inFlightAcquired = false;
          inFlightLease = undefined;
          completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
          return errorResponse(errInternal(requestId));
        }
        await stub.markUncertain(requestId);
        reservationState = "none";
        await stub.releaseInFlight(requestId, inFlightLease!.generation);
        inFlightAcquired = false;
        inFlightLease = undefined;
        completeAudit(ctx, env, requestId, auditInserted, { status: "uncertain", billingClass: "none" });
        return errorResponse(errInternal(requestId));
      }
      return handleCompletedUpstream(upstream, upstreamStartedAt, prepareMetadata.stream, stub, snapshot);
    }

    // --- Legacy path ---
    const bodyReadStartedAt = startResourceStage(env, requestId, "body_read");
    const parseStartedAt = startResourceStage(env, requestId, "parse");
    let parsedBody;
    try {
      parsedBody = await readJsonBody(request, maxInputBytes);
    } catch (error) {
      finishResourceStage(env, requestId, "body_read", bodyReadStartedAt, "exception");
      finishResourceStage(env, requestId, "parse", parseStartedAt, "exception");
      throw error;
    }
    const bodyOutcome: ResourceStageOutcome = parsedBody.ok ? "success" : "rejected";
    const bodyRoute = parsedBody.ok || parsedBody.reason !== "too_large"
      ? undefined
      : "reject:request_too_large";
    const bodyFields: ResourceStageFields = {
      route: bodyRoute,
      rawBodyBytes: parsedBody.metrics.rawBodyBytes,
      rawBodyBytesSource: parsedBody.metrics.rawBodyBytesSource,
      rawBodyTruncated: parsedBody.metrics.truncated,
    };
    finishResourceStage(
      env,
      requestId,
      "body_read",
      bodyReadStartedAt,
      bodyOutcome,
      bodyFields,
      parsedBody.metrics.bodyReadMs,
    );
    finishResourceStage(
      env,
      requestId,
      "parse",
      parseStartedAt,
      bodyOutcome,
      bodyFields,
      parsedBody.metrics.parseMs,
    );
    if (!parsedBody.ok) {
      return errorResponse(parsedBody.reason === "too_large" ? errInputTooLarge(requestId) : errInvalidRequest(requestId));
    }
    const body = parsedBody.body;
    const normalizeStartedAt = startResourceStage(env, requestId, "normalize");
    let normalized;
    try {
      normalized = endpoint === "chat"
        ? normalizeChatCompletions(body, maxInputBytes)
        : normalizeResponses(body, maxInputBytes);
    } catch (error) {
      finishResourceStage(env, requestId, "normalize", normalizeStartedAt, "exception");
      throw error;
    }
    finishResourceStage(
      env,
      requestId,
      "normalize",
      normalizeStartedAt,
      normalized.ok ? "success" : "rejected",
      normalized.ok
        ? {
            inputBytes: normalized.value.inputBytes,
            inputTextBytes: normalized.value.inputTextBytes,
            opaqueInputBytes: normalized.value.opaqueInputBytes,
          }
        : {},
    );
    if (!normalized.ok) {
      if (normalized.error === "input_too_large") return errorResponse(errInputTooLarge(requestId));
      if (normalized.error === "non_text") return errorResponse(errNonTextInput(requestId));
      if (normalized.error === "max_tokens_conflict") return errorResponse(errMaxTokensConflict(requestId));
      return errorResponse(errInvalidRequest(requestId));
    }

    const requestData = normalized.value;
    const pool = classifyModel(requestData.model, await loadRegistry(env));
    if (pool === "NONE") return errorResponse(errModelRequiresPaid(requestId));
    const day = utcDayOf(new Date());
    const stub = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, day)));
    quotaStub = stub;
    const policy = await loadPolicy(env, auth.id);

    if (requestData.isToolUse && policy.toolsMode !== "ALLOW") {
      const getStateStartedAt = startResourceStage(env, requestId, "quota_get_state");
      try {
        const state = await stub.getState();
        finishResourceStage(env, requestId, "quota_get_state", getStateStartedAt, "success");
        return errorResponse(errModelNotAllowed(requestId, snapshotOf(state)));
      } catch (error) {
        finishResourceStage(env, requestId, "quota_get_state", getStateStartedAt, "exception");
        throw error;
      }
    }

    auditInserted = startRequestAuditBestEffort(env, {
      requestId,
      utcDay: day,
      clientId: auth.id,
      requestedModel: requestData.model,
      upstreamModel: requestData.model,
      pool: pool,
      eligibility: "COMPLIMENTARY",
      reservedTokens: null,
    });

    const getStateStartedAt = startResourceStage(env, requestId, "quota_get_state");
    let before;
    try {
      before = await stub.getState();
      finishResourceStage(env, requestId, "quota_get_state", getStateStartedAt, "success");
    } catch (error) {
      finishResourceStage(env, requestId, "quota_get_state", getStateStartedAt, "exception");
      throw error;
    }
    const snapshot = snapshotOf(before);

    const tokenizeStartedAt = startResourceStage(env, requestId, "tokenize");
    const tokenizeOutcome: RoutedTokenizationOutcome = await routeTokenization({
      config: denoTokenizerConfig,
      namespace: env.TOKENIZER_CONTROLLER,
      request: {
        requestId,
        inputText: requestData.inputText,
        inputTextBytes: requestData.inputTextBytes,
        messageCount: requestData.messageCount,
        opaqueInputBytes: requestData.opaqueInputBytes,
      },
    });

    let tokenizedResult: TokenizeResult;
    switch (tokenizeOutcome.kind) {
      case "resolved":
        tokenizedResult = tokenizeOutcome.result;
        break;
      case "request_too_large":
        finishResourceStage(env, requestId, "tokenize", tokenizeStartedAt, "rejected", {
          route: "reject:request_too_large",
          inputBytes: requestData.inputBytes,
          inputTextBytes: requestData.inputTextBytes,
          opaqueInputBytes: requestData.opaqueInputBytes,
          quotaReserved: false,
          upstreamReached: false,
          tokenizationProvider: tokenizeOutcome.provider,
        });
        completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
        return errorResponse(errRequestTooLarge(snapshot, requestId));
      case "unavailable":
        finishResourceStage(env, requestId, "tokenize", tokenizeStartedAt, "exception", {
          route: "error:tokenizer_unavailable",
          inputBytes: requestData.inputBytes,
          inputTextBytes: requestData.inputTextBytes,
          opaqueInputBytes: requestData.opaqueInputBytes,
          quotaReserved: false,
          upstreamReached: false,
          tokenizationProvider: tokenizeOutcome.provider,
          tokenizationFailureCategory: tokenizeOutcome.failureCategory,
          tokenizationNetworkErrorName: tokenizeOutcome.networkErrorName,
        });
        completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
        return errorResponse(errInternal(requestId, { quota: snapshot, route: "error:internal_error" }));
      default:
        return assertNever(tokenizeOutcome, "proxy outcome");
    }

    const estimatedInput = tokenizedResult.estimatedInputTokens;
    const budget = resolveTokenBudget({
      estimatedInput,
      maxOutputTokens: requestData.maxOutputTokens,
      remaining: before.remaining,
      limit: before.limit,
      outputLimitMode: policy.outputLimitMode,
    });
    const finishTokenizeSuccess = (): void => {
      finishResourceStage(env, requestId, "tokenize", tokenizeStartedAt, "success", {
        inputBytes: requestData.inputBytes,
        inputTextBytes: requestData.inputTextBytes,
        opaqueInputBytes: requestData.opaqueInputBytes,
        estimationPath: tokenizedResult.estimationPath,
        tokenizationProvider: tokenizeOutcome.provider,
      });
    };
    switch (budget.kind) {
      case "arithmetic_error":
        finishResourceStage(env, requestId, "tokenize", tokenizeStartedAt, "exception", {
          route: "error:arithmetic_error",
          inputBytes: requestData.inputBytes,
          inputTextBytes: requestData.inputTextBytes,
          opaqueInputBytes: requestData.opaqueInputBytes,
          estimationPath: tokenizedResult.estimationPath,
          tokenizationProvider: tokenizeOutcome.provider,
          quotaReserved: false,
          upstreamReached: false,
        });
        completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
        return errorResponse(errInternal(requestId, { quota: snapshot, route: "error:internal_error" }));
      case "request_too_large":
        finishTokenizeSuccess();
        completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
        return errorResponse(errRequestTooLarge(snapshot, requestId));
      case "quota_exceeded":
        finishTokenizeSuccess();
        completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
        return errorResponse(errQuotaExceeded(snapshot, requestId));
      case "resolved":
        finishTokenizeSuccess();
        break;
      default:
        return assertNever(budget, "proxy outcome");
    }

    const { maxOutputTokens, reservation, upperBound } = budget;
    const reserveOutcome = await reserveRequest({
      stub,
      reservation,
      upperBound,
      idempotencyKey,
      clientId: auth.id,
      hasPreparedBody: false,
    });
    reservationState = reserveOutcome.kind === "unknown"
      ? "unknown"
      : reserveOutcome.result.ok ? "resolved" : "none";
    if (reserveOutcome.kind === "resolved" && !reserveOutcome.result.ok) {
      const reserved = reserveOutcome.result;
      completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
      return errorResponse(reserveFailureError(requestId, snapshot, reserved));
    }
    if (reserveOutcome.kind === "unknown") {
      return rejectUnknownReservation(stub, snapshot);
    }
    if (auditInserted !== undefined) {
      ctx.waitUntil(auditInserted.then((insertSucceeded) =>
        insertSucceeded ? setReservedTokens(env, requestId, reservation) : undefined).catch(() => undefined));
    }

    const lease = await stub.acquireInFlight(
      requestId,
      resolveMaxInFlightRequests(env.MAX_IN_FLIGHT_REQUESTS),
      resolveInFlightLeaseTtlMs(env.IN_FLIGHT_LEASE_TTL_MS),
    );
    if (!lease.ok) {
      await stub.release(requestId);
      reservationState = "none";
      completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
      return errorResponse(errWorkerConcurrencyExceeded(snapshot, requestId));
    }
    inFlightAcquired = true;
    inFlightLease = lease.lease;

    const upstreamStartedAt = startResourceStage(env, requestId, "upstream");
    upstreamStageStartedAt = upstreamStartedAt;
    let upstream: Response;
    try {
      const upstreamBody = buildUpstreamBody(endpoint, body as Record<string, unknown>, maxOutputTokens);
      upstreamAttempted = true;
      upstream = await callUpstream(
        env,
        endpoint === "chat" ? "/chat/completions" : "/responses",
        upstreamBody,
        {
          client_id: auth.id,
          pool: toPoolLower(pool),
          eligibility: "COMPLIMENTARY",
          route: "free_shared",
          request_id: requestId,
        },
        policy.cacheEnabled ? `octg:${auth.id}` : null,
        idempotencyKey,
      );
    } catch (error) {
      finishResourceStage(
        env,
        requestId,
        "upstream",
        upstreamStartedAt,
        "exception",
        {
          route: error instanceof UpstreamConfigError || !upstreamAttempted
            ? "error:pre_upstream"
            : "error:upstream_uncertain",
          quotaReserved: true,
          upstreamReached: false,
        },
      );
      upstreamStageStartedAt = undefined;
      if (error instanceof UpstreamConfigError || !upstreamAttempted) {
        await stub.release(requestId);
        reservationState = "none";
        await stub.releaseInFlight(requestId, inFlightLease.generation);
        inFlightAcquired = false;
        inFlightLease = undefined;
        completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
        return errorResponse(errInternal(requestId));
      }
      await stub.markUncertain(requestId);
      reservationState = "none";
      await stub.releaseInFlight(requestId, inFlightLease.generation);
      inFlightAcquired = false;
      inFlightLease = undefined;
      completeAudit(ctx, env, requestId, auditInserted, { status: "uncertain", billingClass: "none" });
      return errorResponse(errInternal(requestId));
    }
    return handleCompletedUpstream(upstream, upstreamStartedAt, requestData.stream, stub, snapshot);
  } catch {
    if (reserveStageStartedAt !== undefined) {
      finishResourceStage(env, requestId, "quota_reserve", reserveStageStartedAt, "exception", {
        route: "error:pre_upstream",
        upstreamReached: false,
      });
      reserveStageStartedAt = undefined;
    }
    if (upstreamStageStartedAt !== undefined) {
      finishResourceStage(env, requestId, "upstream", upstreamStageStartedAt, "exception", {
        route: upstreamAttempted ? "error:upstream_uncertain" : "error:pre_upstream",
        quotaReserved: reservationState === "resolved",
        upstreamReached,
      });
      upstreamStageStartedAt = undefined;
    }
    // Cancel the prepared body before existing quota cleanup when upstream was not attempted.
    if (cancelPreparedBeforeUpstream !== undefined && !upstreamAttempted) {
      await cancelPreparedBeforeUpstream("exception", {
        route: "error:pre_upstream",
        quotaReserved: preparedQuotaReserved,
        upstreamReached,
      });
    }
    const auditStatus: Completion["status"] = upstreamAttempted || upstreamReached ? "uncertain" : "failed";
    if (quotaStub) {
      if (reservationState === "unknown") {
        await quotaStub.markReserveOutcomeUnknown(requestId).catch(() => undefined);
      } else if (reservationState === "resolved") {
        if (upstreamAttempted || upstreamReached) {
          await quotaStub.markUncertain(requestId).catch(() => undefined);
        } else {
          await quotaStub.release(requestId).catch(() => undefined);
        }
      }
      if (inFlightAcquired && inFlightLease !== undefined) {
        await releaseInFlightBestEffort(quotaStub, inFlightLease);
      }
    }
    completeAudit(ctx, env, requestId, auditInserted, { status: auditStatus, billingClass: "none" });
    return errorResponse(errInternal(requestId));
  }
}
