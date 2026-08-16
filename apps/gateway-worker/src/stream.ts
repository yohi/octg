import { buildOctgHeaders, type QuotaSnapshot } from "@octg/shared";
import type { QuotaController } from "@octg/quota-controller";
import { completeRequestAuditBestEffort } from "./db";
import type { Env } from "./index";
import type { ResourceStageOutcome } from "./resource-observation";

type Stub = DurableObjectStub<QuotaController>;
type Usage = { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };

export function proxyStream(
  upstream: Response,
  stub: Stub,
  requestId: string,
  env: Env,
  ctx: ExecutionContext,
  snapshot: QuotaSnapshot,
  inserted: Promise<boolean>,
  onFinalized?: (outcome: ResourceStageOutcome) => void,
): Response {
  let finalized = false;
  let usage: Usage | undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    try {
      let outcome: ResourceStageOutcome = "success";
      if (typeof usage?.total_tokens === "number") {
        const settled = await stub.settle(requestId, usage.total_tokens);
        if (!settled.ok && settled.reason === "unknown_request") {
          outcome = "uncertain";
          await completeRequestAuditBestEffort(env, requestId, { status: "orphaned", billingClass: "none" }, inserted);
          await stub.releaseInFlight(requestId);
          onFinalized?.(outcome);
          return;
        }
        await completeRequestAuditBestEffort(env, requestId, {
          status: "completed",
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          billingClass: "free",
        }, inserted);
      } else {
        outcome = "uncertain";
        await stub.markUncertain(requestId);
        await completeRequestAuditBestEffort(env, requestId, { status: "uncertain", billingClass: "none" }, inserted);
      }
      await stub.releaseInFlight(requestId);
      onFinalized?.(outcome);
    } catch (error) {
      await stub.releaseInFlight(requestId).catch(() => undefined);
      await Promise.resolve().then(() => onFinalized?.("exception")).catch(() => undefined);
      throw error;
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
          continue;
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
