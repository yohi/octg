import { ulid } from "ulid";
import {
  buildOctgHeaders,
  classifyModel,
  decideOutput,
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
  errorResponse,
  estimateInputTokens,
  MAX_NORMALIZED_INPUT_BYTES,
  nextUtcMidnight,
  normalizeChatCompletions,
  normalizeResponses,
  quotaIdOf,
  safetyMargin,
  toPoolLower,
  upperBoundOf,
  utcDayOf,
  type QuotaSnapshot,
  type QuotaView,
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
} from "./resource-observation";
import { proxyStream } from "./stream";

type Usage = { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
type Completion = RequestCompleteFields;

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
): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      ...buildOctgHeaders({ requestId, quota: snapshot, route: "free_shared" }),
    },
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

export function resolveMaxInputBytes(configured: string | undefined): number {
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : MAX_NORMALIZED_INPUT_BYTES;
}

export function resolveMaxInFlightRequests(configured: string | undefined): number {
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 2;
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
  const definedFields: ResourceStageFields = {
    ...(fields.route === undefined ? {} : { route: fields.route }),
    ...(fields.rawBodyBytes === undefined ? {} : { rawBodyBytes: fields.rawBodyBytes }),
    ...(fields.rawBodyBytesSource === undefined ? {} : { rawBodyBytesSource: fields.rawBodyBytesSource }),
    ...(fields.rawBodyTruncated === undefined ? {} : { rawBodyTruncated: fields.rawBodyTruncated }),
    ...(fields.inputBytes === undefined ? {} : { inputBytes: fields.inputBytes }),
    ...(fields.inputTextBytes === undefined ? {} : { inputTextBytes: fields.inputTextBytes }),
    ...(fields.opaqueInputBytes === undefined ? {} : { opaqueInputBytes: fields.opaqueInputBytes }),
    ...(fields.estimationPath === undefined ? {} : { estimationPath: fields.estimationPath }),
    ...(fields.concurrency === undefined ? {} : { concurrency: fields.concurrency }),
    ...(fields.quotaReserved === undefined ? {} : { quotaReserved: fields.quotaReserved }),
    ...(fields.upstreamReached === undefined ? {} : { upstreamReached: fields.upstreamReached }),
  };
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

export async function handleProxy(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  endpoint: "chat" | "responses",
  requestId = `req_${ulid()}`,
): Promise<Response> {
  let auditInserted: Promise<boolean> | undefined;
  let quotaStub: DurableObjectStub<QuotaController> | undefined;
  let reservationState: "none" | "resolved" | "unknown" = "none";
  let upstreamAttempted = false;
  let upstreamReached = false;
  let inFlightAcquired = false;
  let reserveStageStartedAt: number | undefined;
  let upstreamStageStartedAt: number | undefined;

  try {
    const idempotencyKey = request.headers.get("Idempotency-Key") ?? undefined;
    const auth = await authenticate(request, env, requestId);
    if (!("id" in auth)) return errorResponse(auth);

    const maxInputBytes = resolveMaxInputBytes(env.MAX_INPUT_BYTES);
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
    let estimatedInput: number;
    try {
      estimatedInput = estimateInputTokens(requestData.inputText, requestData.messageCount, requestData.opaqueInputBytes);
      finishResourceStage(env, requestId, "tokenize", tokenizeStartedAt, "success", {
        inputBytes: requestData.inputBytes,
        inputTextBytes: requestData.inputTextBytes,
        opaqueInputBytes: requestData.opaqueInputBytes,
      });
    } catch (error) {
      finishResourceStage(env, requestId, "tokenize", tokenizeStartedAt, "exception", {
        inputBytes: requestData.inputBytes,
        inputTextBytes: requestData.inputTextBytes,
        opaqueInputBytes: requestData.opaqueInputBytes,
      });
      throw error;
    }

    const margin = safetyMargin(estimatedInput, before.remaining / before.limit);
    const upperBound = upperBoundOf(estimatedInput, requestData.maxOutputTokens);
    if (upperBound > before.limit) {
      completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
      return errorResponse(errRequestTooLarge(snapshot, requestId));
    }
    const output = decideOutput({
      estimatedInput,
      maxOutputTokens: requestData.maxOutputTokens,
      margin,
      remaining: before.remaining,
      outputLimitMode: policy.outputLimitMode,
    });
    if (output.action === "reject") {
      completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
      return errorResponse(errQuotaExceeded(snapshot, requestId));
    }

    const reservation = estimatedInput + output.maxOutputTokens + margin;
    const reserveStartedAt = startResourceStage(env, requestId, "quota_reserve");
    reserveStageStartedAt = reserveStartedAt;
    let reserveOutcome: ReserveOutcome;
    try {
      reserveOutcome = await reserveFailClosed(
        (sameRequestId, sameTokens, sameUpperBound, sameIdempotencyKey, sameClientId) =>
          stub.reserve(sameRequestId, sameTokens, sameUpperBound, sameIdempotencyKey, sameClientId),
        {
          requestId,
          tokens: reservation,
          upperBoundTokens: upperBound,
          idempotencyKey,
          clientId: auth.id,
        },
      );
    } catch (error) {
      finishResourceStage(env, requestId, "quota_reserve", reserveStartedAt, "exception", {
        route: "error:pre_upstream",
        upstreamReached: false,
      });
      reserveStageStartedAt = undefined;
      throw error;
    }
    if (reserveOutcome.kind === "unknown") {
      reservationState = "unknown";
      finishResourceStage(env, requestId, "quota_reserve", reserveStartedAt, "exception", {
        route: "error:pre_upstream",
        upstreamReached: false,
      });
      reserveStageStartedAt = undefined;
      await stub.markReserveOutcomeUnknown(requestId);
      completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
      return errorResponse(errInternal(requestId));
    }
    const reserved = reserveOutcome.result;
    if (reserved.ok) reservationState = "resolved";
    finishResourceStage(
      env,
      requestId,
      "quota_reserve",
      reserveStartedAt,
      reserved.ok ? "success" : "rejected",
      {
        route: reserved.ok ? "free_shared" : routeForReserveFailure(reserved.reason),
        quotaReserved: reserved.ok,
      },
    );
    reserveStageStartedAt = undefined;
    if (!reserved.ok) {
      completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
      if (reserved.reason === "duplicate_idempotency_key") {
        return errorResponse({
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
        });
      }
      return errorResponse(errQuotaExceeded({ ...snapshot, remaining: reserved.remaining, resetAt: reserved.resetAt }, requestId));
    }
    if (auditInserted) {
      ctx.waitUntil(auditInserted.then((insertSucceeded) =>
        insertSucceeded ? setReservedTokens(env, requestId, reservation) : undefined).catch(() => undefined));
    }

    const lease = await stub.acquireInFlight(requestId, resolveMaxInFlightRequests(env.MAX_IN_FLIGHT_REQUESTS));
    if (!lease.ok) {
      await stub.release(requestId);
      reservationState = "none";
      completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
      return errorResponse(errWorkerConcurrencyExceeded(snapshot, requestId));
    }
    inFlightAcquired = true;

    const upstreamStartedAt = startResourceStage(env, requestId, "upstream");
    upstreamStageStartedAt = upstreamStartedAt;
    let upstream: Response;
    try {
      const upstreamBody = buildUpstreamBody(endpoint, body as Record<string, unknown>, output.maxOutputTokens);
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
        await stub.releaseInFlight(requestId);
        inFlightAcquired = false;
        completeAudit(ctx, env, requestId, auditInserted, { status: "failed", billingClass: "none" });
        return errorResponse(errInternal(requestId));
      }
      await stub.markUncertain(requestId);
      reservationState = "none";
      await stub.releaseInFlight(requestId);
      inFlightAcquired = false;
      completeAudit(ctx, env, requestId, auditInserted, { status: "uncertain", billingClass: "none" });
      return errorResponse(errInternal(requestId));
    }
    upstreamReached = true;
    const upstreamUncertain = !upstream.ok && (upstream.status === 408 || upstream.status === 429 || upstream.status >= 500);
    const upstreamOutcome: ResourceStageOutcome = upstream.ok
      ? "success"
      : upstreamUncertain
        ? "uncertain"
        : "rejected";
    const upstreamFields: ResourceStageFields = {
      route: upstream.ok ? "free_shared" : upstreamUncertain ? "error:upstream_uncertain" : undefined,
      quotaReserved: true,
      upstreamReached: true,
    };
    if (requestData.stream && upstream.ok) {
      return proxyStream(
        upstream,
        stub,
        requestId,
        env,
        ctx,
        snapshot,
        auditInserted,
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
              ? upstreamFields
              : { ...upstreamFields, route: "error:upstream_uncertain" },
          );
        },
      );
    }
    upstreamStageStartedAt = undefined;
    finishResourceStage(env, requestId, "upstream", upstreamStartedAt, upstreamOutcome, upstreamFields);
    if (!upstream.ok) {
      if (upstreamUncertain) await stub.markUncertain(requestId);
      else await stub.release(requestId);
      reservationState = "none";
      await stub.releaseInFlight(requestId);
      inFlightAcquired = false;
      completeAudit(ctx, env, requestId, auditInserted, { status: upstreamUncertain ? "uncertain" : "failed", billingClass: "none" });
      return upstreamResponse(upstream, requestId, snapshot);
    }

    let data: Record<string, unknown> & { usage?: Usage };
    try {
      data = (await upstream.json()) as Record<string, unknown> & { usage?: Usage };
    } catch {
      await stub.markUncertain(requestId);
      reservationState = "none";
      await stub.releaseInFlight(requestId);
      inFlightAcquired = false;
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
        completeAudit(ctx, env, requestId, auditInserted, {
          status: "completed",
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          billingClass: "free",
        });
      }
    } else {
      await stub.markUncertain(requestId);
      reservationState = "none";
      completeAudit(ctx, env, requestId, auditInserted, { status: "uncertain", billingClass: "none" });
    }
    await stub.releaseInFlight(requestId);
    inFlightAcquired = false;
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...buildOctgHeaders({ requestId, quota: snapshot, route: "free_shared" }),
      },
    });
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
      if (inFlightAcquired) await quotaStub.releaseInFlight(requestId).catch(() => undefined);
    }
    completeAudit(ctx, env, requestId, auditInserted, { status: auditStatus, billingClass: "none" });
    return errorResponse(errInternal(requestId));
  }
}
