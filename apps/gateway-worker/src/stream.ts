import { buildOctgHeaders, type InFlightLease, type QuotaSnapshot, type Usage } from "@octg/shared";
import type { QuotaController } from "@octg/quota-controller";

import { completeRequestAuditBestEffort } from "./db";
import type { Env } from "./index";
import type { ResourceStageOutcome } from "./resource-observation";
import { workerVersionHeaders } from "./version-metadata";

type Stub = DurableObjectStub<QuotaController>;
export type { Usage };

function findBraceOpen(event: string, colonIndex: number): number {
  const limit = Math.min(event.length, colonIndex + 20);
  for (let i = colonIndex + 1; i < limit; i++) {
    const code = event.codePointAt(i);
    if (code === 123) return i;
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
  }
  return -1;
}

function findMatchingBraceClose(event: string, braceOpen: number): number {
  let depth = 0;
  for (let i = braceOpen; i < event.length; i++) {
    const code = event.codePointAt(i);
    if (code === 123) {
      depth++;
    } else if (code === 125) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tryParseUsageSnippet(event: string, braceOpen: number, braceClose: number): Usage | undefined {
  try {
    const snippet = event.slice(braceOpen, braceClose + 1);
    const parsed = JSON.parse(snippet) as Record<string, unknown>;
    if (typeof parsed.total_tokens === "number") {
      return parsed as Usage;
    }
  } catch {
    // continue searching
  }
  return undefined;
}

export function extractUsageFromEvent(event: string): Usage | undefined {
  let searchStart = 0;
  while (searchStart < event.length) {
    const usageKeyIndex = event.indexOf('"usage"', searchStart);
    if (usageKeyIndex === -1) break;
    searchStart = usageKeyIndex + 7;

    const colonIndex = event.indexOf(":", searchStart);
    if (colonIndex === -1 || colonIndex - searchStart > 20) continue;

    const braceOpen = findBraceOpen(event, colonIndex);
    if (braceOpen === -1) continue;

    const braceClose = findMatchingBraceClose(event, braceOpen);
    if (braceClose === -1) continue;

    const parsed = tryParseUsageSnippet(event, braceOpen, braceClose);
    if (parsed) return parsed;
  }
  return undefined;
}

export function bytesIncludesAscii(bytes: Uint8Array, needle: string): boolean {
  const len = bytes.byteLength;
  const nlen = needle.length;
  if (len < nlen) return false;
  const first = needle.codePointAt(0)!;
  for (let i = 0; i <= len - nlen; i++) {
    if (bytes[i] === first) {
      let match = true;
      for (let j = 1; j < nlen; j++) {
        if (bytes[i + j] !== needle.codePointAt(j)) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
  }
  return false;
}

const USAGE_NEEDLE = '"usage"';
const RESPONSE_COMPLETED_NEEDLE = "response.completed";

export function mightContainUsage(bytes: Uint8Array): boolean {
  return bytesIncludesAscii(bytes, USAGE_NEEDLE) || bytesIncludesAscii(bytes, RESPONSE_COMPLETED_NEEDLE);
}

export class RingTailBuffer {
  private readonly buffer: Uint8Array;
  private readonly capacity: number;
  private writeIndex = 0;
  private totalBytes = 0;

  constructor(capacity = 32768) {
    this.capacity = capacity;
    this.buffer = new Uint8Array(capacity);
  }

  write(chunk: Uint8Array): void {
    const len = chunk.byteLength;
    if (len === 0) return;
    this.totalBytes += len;

    if (len >= this.capacity) {
      this.buffer.set(chunk.subarray(len - this.capacity), 0);
      this.writeIndex = 0;
      return;
    }

    const firstPart = Math.min(len, this.capacity - this.writeIndex);
    this.buffer.set(chunk.subarray(0, firstPart), this.writeIndex);
    if (len > firstPart) {
      const secondPart = len - firstPart;
      this.buffer.set(chunk.subarray(firstPart, len), 0);
      this.writeIndex = secondPart;
    } else {
      this.writeIndex = (this.writeIndex + len) % this.capacity;
    }
  }

  getTail(): Uint8Array {
    if (this.totalBytes === 0) {
      return new Uint8Array(0);
    }
    if (this.totalBytes < this.capacity) {
      return this.buffer.slice(0, this.totalBytes);
    }
    const result = new Uint8Array(this.capacity);
    const firstPart = this.capacity - this.writeIndex;
    result.set(this.buffer.subarray(this.writeIndex), 0);
    result.set(this.buffer.subarray(0, this.writeIndex), firstPart);
    return result;
  }
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
  const ringBuffer = new RingTailBuffer(32768);
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
      controller.enqueue(chunk);
      ringBuffer.write(chunk);
      if (usage === undefined && mightContainUsage(chunk)) {
        const text = new TextDecoder().decode(ringBuffer.getTail());
        parseEvents(text);
      }
    },
    flush() {
      if (usage === undefined) {
        const tail = ringBuffer.getTail();
        if (tail.byteLength > 0) {
          const text = new TextDecoder().decode(tail);
          parseEvents(text);
        }
      }
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
