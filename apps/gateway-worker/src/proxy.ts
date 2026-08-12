import { ulid } from "ulid";
import {
  buildOctgHeaders,
  classifyModel,
  decideOutput,
  errInternal,
  errInvalidRequest,
  errMaxTokensConflict,
  errModelNotAllowed,
  errModelRequiresPaid,
  errNonTextInput,
  errQuotaExceeded,
  errRequestTooLarge,
  errorResponse,
  estimateInputTokens,
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
import type { QuotaController } from "@octg/quota-controller";
import { authenticate } from "./auth";
import { completeRequestRow, insertRequestRow, setReservedTokens } from "./db";
import { loadPolicy, loadRegistry } from "./policy";
import { buildUpstreamBody, callUpstream, UpstreamConfigError } from "./upstream";
import type { Env } from "./index";

type Stub = DurableObjectStub<QuotaController>;
type Usage = { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
type Completion = Parameters<typeof completeRequestRow>[2];

function completeAfterInsert(
  inserted: Promise<void>,
  env: Env,
  requestId: string,
  fields: Completion,
): Promise<void> {
  return inserted.then(() => completeRequestRow(env, requestId, fields));
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

export async function handleProxy(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  endpoint: "chat" | "responses",
): Promise<Response> {
  const requestId = `req_${ulid()}`;
  const idempotencyKey = request.headers.get("Idempotency-Key") ?? undefined;
  const auth = await authenticate(request, env, requestId);
  if (!("id" in auth)) return errorResponse(auth);

  const body: unknown = await request.json().catch(() => null);
  const normalized = endpoint === "chat" ? normalizeChatCompletions(body) : normalizeResponses(body);
  if (!normalized.ok) {
    if (normalized.error === "non_text") return errorResponse(errNonTextInput(requestId));
    if (normalized.error === "max_tokens_conflict") return errorResponse(errMaxTokensConflict(requestId));
    return errorResponse(errInvalidRequest(requestId));
  }

  const requestData = normalized.value;
  const pool = classifyModel(requestData.model, await loadRegistry(env));
  if (pool === "NONE") return errorResponse(errModelRequiresPaid(requestId));
  const day = utcDayOf(new Date());
  const stub = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, day)));
  const policy = await loadPolicy(env, auth.id);

  if (requestData.isToolUse) {
    return errorResponse(errModelNotAllowed(requestId, snapshotOf(await stub.getState())));
  }

  const inserted = insertRequestRow(env, {
      requestId,
      utcDay: day,
      clientId: auth.id,
      requestedModel: requestData.model,
      upstreamModel: requestData.model,
      pool: pool,
      eligibility: "COMPLIMENTARY",
      reservedTokens: null,
    });

  const before = await stub.getState();
  const snapshot = snapshotOf(before);
  const estimatedInput = estimateInputTokens(requestData.inputText, requestData.messageCount);
  const margin = safetyMargin(estimatedInput, before.remaining / before.limit);
  const upperBound = upperBoundOf(estimatedInput, requestData.maxOutputTokens);
  if (upperBound > before.limit) {
    ctx.waitUntil(completeAfterInsert(inserted, env, requestId, { status: "failed", billingClass: "none" }));
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
    ctx.waitUntil(completeAfterInsert(inserted, env, requestId, { status: "failed", billingClass: "none" }));
    return errorResponse(errQuotaExceeded(snapshot, requestId));
  }

  const reservation = estimatedInput + output.maxOutputTokens + margin;
  const reserved = await stub.reserve(requestId, reservation, upperBound, idempotencyKey);
  if (!reserved.ok) {
    ctx.waitUntil(completeAfterInsert(inserted, env, requestId, { status: "failed", billingClass: "none" }));
    return errorResponse(errQuotaExceeded({ ...snapshot, remaining: reserved.remaining, resetAt: reserved.resetAt }, requestId));
  }
  ctx.waitUntil(inserted.then(() => setReservedTokens(env, requestId, reservation)).catch(() => undefined));

  let upstream: Response;
  try {
    upstream = await callUpstream(
      env,
      endpoint === "chat" ? "/chat/completions" : "/responses",
      buildUpstreamBody(endpoint, body as Record<string, unknown>, output.maxOutputTokens),
      {
        client_id: auth.id,
        pool: toPoolLower(pool),
        eligibility: "COMPLIMENTARY",
        route: "free_shared",
        request_id: requestId,
      },
      policy.cacheEnabled ? `octg:${auth.id}` : null,
    );
  } catch (error) {
    if (error instanceof UpstreamConfigError) {
      await stub.release(requestId);
      ctx.waitUntil(completeAfterInsert(inserted, env, requestId, { status: "failed", billingClass: "none" }));
      return errorResponse(errInternal(requestId));
    }
    await stub.markUncertain(requestId);
    ctx.waitUntil(completeAfterInsert(inserted, env, requestId, { status: "uncertain", billingClass: "none" }));
    return errorResponse(errInternal(requestId));
  }
  if (!upstream.ok) {
    const uncertain = upstream.status === 408 || upstream.status === 429 || upstream.status >= 500;
    if (uncertain) await stub.markUncertain(requestId);
    else await stub.release(requestId);
    ctx.waitUntil(completeAfterInsert(inserted, env, requestId, { status: uncertain ? "uncertain" : "failed", billingClass: "none" }));
    return upstreamResponse(upstream, requestId, snapshot);
  }

  if (requestData.stream) return proxyStream(upstream, stub, requestId, env, ctx, snapshot, inserted);
  let data: Record<string, unknown> & { usage?: Usage };
  try {
    data = (await upstream.json()) as Record<string, unknown> & { usage?: Usage };
  } catch {
    await stub.markUncertain(requestId);
    ctx.waitUntil(completeAfterInsert(inserted, env, requestId, { status: "uncertain", billingClass: "none" }));
    return errorResponse(errInternal(requestId));
  }
  const usage = data.usage;
  if (typeof usage?.total_tokens === "number") {
    const settled = await stub.settle(requestId, usage.total_tokens);
    if (!settled.ok && settled.reason === "unknown_request") {
      ctx.waitUntil(completeAfterInsert(inserted, env, requestId, { status: "orphaned", billingClass: "none" }));
    } else {
      ctx.waitUntil(completeAfterInsert(inserted, env, requestId, {
        status: "completed",
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        billingClass: "free",
      }));
    }
  } else {
    await stub.markUncertain(requestId);
    ctx.waitUntil(completeAfterInsert(inserted, env, requestId, { status: "uncertain", billingClass: "none" }));
  }
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...buildOctgHeaders({ requestId, quota: snapshot, route: "free_shared" }),
    },
  });
}

export function proxyStream(
  upstream: Response,
  stub: Stub,
  requestId: string,
  env: Env,
  ctx: ExecutionContext,
  snapshot: QuotaSnapshot,
  inserted: Promise<void>,
): Response {
  let finalized = false;
  let usage: Usage | undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    if (typeof usage?.total_tokens === "number") {
      const settled = await stub.settle(requestId, usage.total_tokens);
      if (!settled.ok && settled.reason === "unknown_request") {
        await inserted;
        await completeRequestRow(env, requestId, { status: "orphaned", billingClass: "none" });
        return;
      }
      await inserted;
      await completeRequestRow(env, requestId, {
        status: "completed",
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        billingClass: "free",
      });
    } else {
      await stub.markUncertain(requestId);
      await inserted;
      await completeRequestRow(env, requestId, { status: "uncertain", billingClass: "none" });
    }
  };
  const parseEvents = (text: string) => {
    for (const event of text.split("\n\n")) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>;
          if (parsed.usage) usage = parsed.usage as Usage;
          const response = parsed.response as { usage?: Usage } | undefined;
          if (parsed.type === "response.completed" && response?.usage) usage = response.usage;
        } catch {
          // Wait for the next chunk when a JSON event is split across chunks.
        }
      }
    }
  };
  if (!upstream.body) {
    ctx.waitUntil(finalize());
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        ...buildOctgHeaders({ requestId, quota: snapshot, route: "free_shared" }),
      },
    });
  }
  const tapped = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const cut = buffer.lastIndexOf("\n\n");
      if (cut >= 0) {
        parseEvents(buffer.slice(0, cut + 2));
        buffer = buffer.slice(cut + 2);
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (buffer.trim()) parseEvents(`${buffer}\n\n`);
      ctx.waitUntil(finalize());
    },
    cancel() {
      ctx.waitUntil(finalize());
    },
  }));
  return new Response(tapped, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      ...buildOctgHeaders({ requestId, quota: snapshot, route: "free_shared" }),
    },
  });
}
