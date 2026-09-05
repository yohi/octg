import { buildOctgHeaders, type InFlightLease, type QuotaSnapshot, type Usage } from "@octg/shared";
import type { QuotaController } from "@octg/quota-controller";
import { completeRequestAuditBestEffort } from "./db";
import type { Env } from "./index";
import type { ResourceStageOutcome } from "./resource-observation";
import { workerVersionHeaders } from "./version-metadata";

type Stub = DurableObjectStub<QuotaController>;
export type { Usage };

export function extractUsageFromEvent(event: string): Usage | undefined {
  let searchStart = 0;
  while (searchStart < event.length) {
    const usageKeyIndex = event.indexOf('"usage"', searchStart);
    if (usageKeyIndex === -1) break;
    searchStart = usageKeyIndex + 7;

    const colonIndex = event.indexOf(":", searchStart);
    if (colonIndex === -1 || colonIndex - searchStart > 20) continue;

    let braceOpen = -1;
    for (let i = colonIndex + 1; i < event.length && i < colonIndex + 20; i++) {
      const ch = event.charCodeAt(i);
      if (ch === 123) {
        braceOpen = i;
        break;
      }
      if (ch !== 32 && ch !== 9 && ch !== 10 && ch !== 13) break;
    }
    if (braceOpen === -1) continue;

    let depth = 0;
    let braceClose = -1;
    for (let i = braceOpen; i < event.length; i++) {
      const ch = event.charCodeAt(i);
      if (ch === 123) {
        depth++;
      } else if (ch === 125) {
        depth--;
        if (depth === 0) {
          braceClose = i;
          break;
        }
      }
    }
    if (braceClose === -1) continue;

    try {
      const snippet = event.slice(braceOpen, braceClose + 1);
      const parsed = JSON.parse(snippet) as Record<string, unknown>;
      if (typeof parsed.total_tokens === "number") {
        return parsed as Usage;
      }
    } catch {
      // continue searching
    }
  }
  return undefined;
}

export interface StreamLeaseOptions {
  readonly lease: InFlightLease;
  readonly ttlMs: number;
  readonly renewalMs: number;
}

export function proxyStream(
  upstream: Response,
  stub: Stub,
  options: StreamLeaseOptions,
  env: Env,
  ctx: ExecutionContext,
  snapshot: QuotaSnapshot,
  inserted: Promise<boolean>,
  onFinalized?: (outcome: ResourceStageOutcome) => void,
): Response {
  const { lease, ttlMs, renewalMs } = options;
  const { generation, requestId } = lease;
  let finalized = false;
  let clientDisconnected = false;
  let usage: Usage | undefined;
  let renewalFailed = false;
  let renewalError: unknown;
  let renewalInFlight = false;
  let renewalTimer: ReturnType<typeof setInterval> | undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  const stopRenewal = () => {
    if (renewalTimer === undefined) return;
    clearInterval(renewalTimer);
    renewalTimer = undefined;
  };
  const finalizeUncertain = async (originalError?: unknown) => {
    const markError = await stub.markUncertain(requestId).then(
      () => undefined,
      (error: unknown) => error,
    );
    await completeRequestAuditBestEffort(
      env,
      requestId,
      { status: "uncertain", billingClass: "none" },
      inserted,
    ).catch(() => undefined);
    const releaseError = await stub.releaseInFlight(requestId, generation).then(
      () => undefined,
      (error: unknown) => error,
    );
    await Promise.resolve()
      .then(() => onFinalized?.(originalError === undefined && markError === undefined ? "uncertain" : "exception"))
      .catch(() => undefined);
    if (originalError !== undefined) throw originalError;
    if (markError !== undefined) throw markError;
    if (releaseError !== undefined) throw releaseError;
  };
  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    stopRenewal();
    if (renewalFailed || clientDisconnected) {
      await finalizeUncertain(renewalFailed ? renewalError : undefined);
      return;
    }
    try {
      let outcome: ResourceStageOutcome = "success";
      if (typeof usage?.total_tokens === "number") {
        const settled = await stub.settle(requestId, usage.total_tokens);
        if (!settled.ok && settled.reason === "unknown_request") {
          outcome = "uncertain";
          await completeRequestAuditBestEffort(env, requestId, { status: "orphaned", billingClass: "none" }, inserted);
          await stub.releaseInFlight(requestId, generation);
          onFinalized?.(outcome);
          return;
        }
        const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
        const outputTokens = usage.completion_tokens ?? usage.output_tokens;
        await completeRequestAuditBestEffort(env, requestId, {
          status: "completed",
          inputTokens,
          outputTokens,
          totalTokens: usage.total_tokens,
          billingClass: "free",
        }, inserted);
      } else {
        outcome = "uncertain";
        await stub.markUncertain(requestId);
        await completeRequestAuditBestEffort(env, requestId, { status: "uncertain", billingClass: "none" }, inserted);
      }
      await stub.releaseInFlight(requestId, generation);
      onFinalized?.(outcome);
    } catch (error) {
      await finalizeUncertain(error);
    }
  };
  const parseEvents = (text: string) => {
    let eventStart = 0;
    while (eventStart < text.length) {
      let eventEnd = text.indexOf("\n\n", eventStart);
      if (eventEnd === -1) eventEnd = text.length;
      const event = text.slice(eventStart, eventEnd);
      eventStart = eventEnd + 2;

      if (!event.includes('"usage"') && !event.includes("response.completed")) continue;

      const extracted = extractUsageFromEvent(event);
      if (extracted) {
        usage = extracted;
        continue;
      }

      if (event.length < 2048) {
        let lineStart = 0;
        while (lineStart < event.length) {
          let lineEnd = event.indexOf("\n", lineStart);
          if (lineEnd === -1) lineEnd = event.length;
          const line = event.slice(lineStart, lineEnd);
          lineStart = lineEnd + 1;

          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            if (parsed.usage) usage = parsed.usage as Usage;
            const response = parsed.response as { usage?: Usage } | undefined;
            if (parsed.type === "response.completed" && response?.usage) usage = response.usage;
          } catch {
            continue;
          }
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
        ...workerVersionHeaders(env.CF_VERSION_METADATA),
      },
    });
  }
  const streamAbort = new AbortController();
  const failRenewal = (error: unknown) => {
    if (finalized || renewalFailed) return;
    renewalFailed = true;
    renewalError = error;
    streamAbort.abort();
    ctx.waitUntil(finalize());
  };
  const renewLease = async () => {
    if (finalized || renewalInFlight) return;
    renewalInFlight = true;
    try {
      const renewed = await stub.renewInFlight(requestId, generation, ttlMs);
      if (!renewed.ok) throw new Error("In-flight lease renewal failed.");
    } catch (error) {
      failRenewal(error);
    } finally {
      renewalInFlight = false;
    }
  };
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
      clientDisconnected = true;
      ctx.waitUntil(finalize());
    },
  }), { signal: streamAbort.signal });
  renewalTimer = setInterval(() => {
    void renewLease();
  }, renewalMs);
  return new Response(tapped, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      ...buildOctgHeaders({ requestId, quota: snapshot, route: "free_shared" }),
      ...workerVersionHeaders(env.CF_VERSION_METADATA),
    },
  });
}
