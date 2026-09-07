import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { QuotaController } from "@octg/quota-controller";
import type { InFlightLease, QuotaSnapshot } from "@octg/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractUsageFromEvent, proxyStream, RingTailBuffer } from "../src/stream";

const controllerFor = (day: string): DurableObjectStub<QuotaController> =>
  env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));

const sseResponse = (event: string): Response =>
  new Response(`data: ${event}\n\n`, { headers: { "content-type": "text/event-stream" } });

async function acquireLease(
  controller: DurableObjectStub<QuotaController>,
  requestId: string,
): Promise<InFlightLease> {
  const acquired = await controller.acquireInFlight(requestId, 1);
  if (!acquired.ok) throw new TypeError("Expected the in-flight lease acquisition to succeed.");
  return acquired.lease;
}

const streamOptions = (lease: InFlightLease, renewalMs = 30_000) => ({
  lease,
  ttlMs: 120_000,
  renewalMs,
});

const quotaSnapshot = {
  pool: "STANDARD",
  limit: 1_000_000,
  used: 0,
  remaining: 1_000_000,
  resetAt: "2026-10-08T00:00:00Z",
} satisfies QuotaSnapshot;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("proxy stream finalization", () => {
  it("releases the in-flight lease while preserving a settlement rejection", async () => {
    // Given: a stream whose settlement RPC fails after a lease was acquired.
    const controller = controllerFor("2026-10-05");
    const requestId = "stream-settlement-rejection";
    const replacementRequestId = "stream-settlement-replacement";
    const settlementError = new Error("settlement failed");
    await controller.reserve(requestId, 10, 10);
    const lease = await acquireLease(controller, requestId);
    vi.spyOn(controller, "settle").mockRejectedValue(settlementError);
    const context = createExecutionContext();
    const response = proxyStream(
      sseResponse('{"usage":{"total_tokens":1}}'),
      controller,
      streamOptions(lease),
      env,
      context,
      quotaSnapshot,
      Promise.resolve(false),
    );

    // When: the streamed body flushes and triggers finalization.
    await response.text();

    try {
      // Then: the same failure propagates after the lease becomes available to another request.
      await expect(waitOnExecutionContext(context)).rejects.toBe(settlementError);
      expect(await controller.getState()).toMatchObject({ uncertainTokens: 10, reservedTokens: 0 });
      const replacement = await controller.acquireInFlight(replacementRequestId, 1);
      expect(replacement).toMatchObject({ ok: true, lease: { requestId: replacementRequestId } });
      if (replacement.ok) await controller.releaseInFlight(replacementRequestId, replacement.lease.generation);
    } finally {
      await controller.releaseInFlight(requestId, lease.generation);
    }
  });

  it("preserves the settlement rejection when the finalization callback throws", async () => {
    // Given: settlement fails and the finalization callback also throws.
    const controller = controllerFor("2026-10-09");
    const requestId = "stream-callback-rejection";
    const replacementRequestId = "stream-callback-replacement";
    const settlementError = new Error("settlement failed");
    const callbackError = new Error("stage callback failed");
    const lease = await acquireLease(controller, requestId);
    vi.spyOn(controller, "settle").mockRejectedValue(settlementError);
    const context = createExecutionContext();
    const response = proxyStream(
      sseResponse('{"usage":{"total_tokens":1}}'),
      controller,
      streamOptions(lease),
      env,
      context,
      quotaSnapshot,
      Promise.resolve(false),
      () => {
        throw callbackError;
      },
    );

    // When: the streamed body flushes and triggers finalization.
    await response.text();

    try {
      // Then: the settlement failure remains the propagated error and the lease is released.
      await expect(waitOnExecutionContext(context)).rejects.toBe(settlementError);
      const replacement = await controller.acquireInFlight(replacementRequestId, 1);
      expect(replacement).toMatchObject({ ok: true, lease: { requestId: replacementRequestId } });
      if (replacement.ok) await controller.releaseInFlight(replacementRequestId, replacement.lease.generation);
    } finally {
      await controller.releaseInFlight(requestId, lease.generation);
    }
  });

  it("releases the in-flight lease while preserving an uncertainty-mark rejection", async () => {
    // Given: a stream without usage whose uncertainty RPC fails after a lease was acquired.
    const controller = controllerFor("2026-10-06");
    const requestId = "stream-uncertainty-rejection";
    const replacementRequestId = "stream-uncertainty-replacement";
    const uncertaintyError = new Error("uncertainty marking failed");
    await controller.reserve(requestId, 10, 10);
    const lease = await acquireLease(controller, requestId);
    vi.spyOn(controller, "markUncertain").mockRejectedValue(uncertaintyError);
    const context = createExecutionContext();
    const response = proxyStream(
      sseResponse('{"id":"usage-absent"}'),
      controller,
      streamOptions(lease),
      env,
      context,
      quotaSnapshot,
      Promise.resolve(false),
    );

    // When: the streamed body flushes and triggers finalization.
    await response.text();

    try {
      // Then: the same failure propagates after the lease becomes available to another request.
      await expect(waitOnExecutionContext(context)).rejects.toBe(uncertaintyError);
      expect(await controller.getState()).toMatchObject({ uncertainTokens: 0, reservedTokens: 10 });
      const replacement = await controller.acquireInFlight(replacementRequestId, 1);
      expect(replacement).toMatchObject({ ok: true, lease: { requestId: replacementRequestId } });
      if (replacement.ok) await controller.releaseInFlight(replacementRequestId, replacement.lease.generation);
      vi.restoreAllMocks();
      expect(await controller.reconcileRequest(requestId, "unused")).toEqual({ ok: true, applied: true });
      expect(await controller.getState()).toMatchObject({ uncertainTokens: 0, reservedTokens: 0 });
    } finally {
      await controller.releaseInFlight(requestId, lease.generation);
    }
  });

  it("keeps a client-disconnect reservation recoverable when uncertainty marking fails", async () => {
    // Given: a streamed response whose uncertainty RPC fails after client cancellation.
    const controller = controllerFor("2026-10-14");
    const requestId = "stream-client-disconnect-uncertainty-failure";
    const uncertaintyError = new Error("uncertainty marking failed");
    await controller.reserve(requestId, 10, 10);
    const lease = await acquireLease(controller, requestId);
    vi.spyOn(controller, "markUncertain").mockRejectedValue(uncertaintyError);
    const context = createExecutionContext();
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('data: {"usage":{"total_tokens":5}}\n\n'));
      },
    }), { headers: { "content-type": "text/event-stream" } });
    const response = proxyStream(
      upstream,
      controller,
      streamOptions(lease),
      env,
      context,
      quotaSnapshot,
      Promise.resolve(false),
    );
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("Expected a streamed response body.");

    // When: the client cancels after receiving the first chunk.
    await reader.read();
    await reader.cancel("client disconnected");

    // Then: the marking failure is observable and the reserved entry remains recoverable.
    await expect(waitOnExecutionContext(context)).rejects.toBe(uncertaintyError);
    expect(await controller.getState()).toMatchObject({ uncertainTokens: 0, reservedTokens: 10 });
    vi.restoreAllMocks();
    expect(await controller.reconcileRequest(requestId, "unused")).toEqual({ ok: true, applied: true });
    expect(await controller.getState()).toMatchObject({ uncertainTokens: 0, reservedTokens: 0 });
  });

  it("reports uncertain finalization when usage metadata is absent", async () => {
    const controller = controllerFor("2026-10-12");
    const requestId = "stream-usage-absent";
    const lease = await acquireLease(controller, requestId);
    const finalized = vi.fn();
    const context = createExecutionContext();
    const response = proxyStream(
      sseResponse('{"id":"usage-absent"}'),
      controller,
      streamOptions(lease),
      env,
      context,
      quotaSnapshot,
      Promise.resolve(false),
      finalized,
    );

    await response.text();

    try {
      await expect(waitOnExecutionContext(context)).resolves.toBeUndefined();
      expect(finalized).toHaveBeenCalledTimes(1);
      expect(finalized).toHaveBeenCalledWith("uncertain");
    } finally {
      await controller.releaseInFlight(requestId, lease.generation);
    }
  });

  it("marks a reservation uncertain when the client disconnects after usage was streamed", async () => {
    // Given: a streamed response that has exposed usage but remains open.
    const controller = controllerFor("2026-10-13");
    const requestId = "stream-client-disconnect";
    await controller.reserve(requestId, 10, 10);
    const lease = await acquireLease(controller, requestId);
    const context = createExecutionContext();
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('data: {"usage":{"total_tokens":5}}\n\n'));
      },
    }), { headers: { "content-type": "text/event-stream" } });

    const response = proxyStream(
      upstream,
      controller,
      streamOptions(lease),
      env,
      context,
      quotaSnapshot,
      Promise.resolve(false),
    );
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("Expected a streamed response body.");

    // When: the client cancels after receiving the first chunk.
    await reader.read();
    await reader.cancel("client disconnected");
    await waitOnExecutionContext(context);

    // Then: the reservation remains fail-closed instead of settling partial usage.
    expect(await controller.getState()).toMatchObject({
      confirmedTokens: 0,
      reservedTokens: 0,
      uncertainTokens: 10,
    });
  });

  it("treats audit insertion rejection as best effort while releasing the in-flight lease", async () => {
    // Given: settlement succeeds but the audit insertion promise rejects after a lease was acquired.
    const controller = controllerFor("2026-10-07");
    const requestId = "stream-audit-rejection";
    const replacementRequestId = "stream-audit-replacement";
    const auditError = new Error("audit insertion failed");
    await controller.reserve(requestId, 10, 10);
    const lease = await acquireLease(controller, requestId);
    const context = createExecutionContext();
    const inserted = Promise.reject(auditError);
    void inserted.catch(() => undefined);
    const response = proxyStream(
      sseResponse('{"usage":{"total_tokens":5}}'),
      controller,
      streamOptions(lease),
      env,
      context,
      quotaSnapshot,
      inserted,
    );

    // When: the streamed body flushes and triggers finalization.
    await response.text();

    try {
      // Then: the audit failure is best effort and the lease becomes available to another request.
      await expect(waitOnExecutionContext(context)).resolves.toBeUndefined();
      const replacement = await controller.acquireInFlight(replacementRequestId, 1);
      expect(replacement).toMatchObject({ ok: true, lease: { requestId: replacementRequestId } });
      if (replacement.ok) await controller.releaseInFlight(replacementRequestId, replacement.lease.generation);
    } finally {
      await controller.releaseInFlight(requestId, lease.generation);
    }
  });

  it("renews an idle stream without waiting for another chunk", async () => {
    vi.useFakeTimers();
    const controller = controllerFor("2026-10-10");
    const requestId = "stream-idle-renewal";
    const lease = await acquireLease(controller, requestId);
    const renewedLease = { ...lease, expiresAtMs: lease.expiresAtMs + 120_000 };
    const renew = vi.spyOn(controller, "renewInFlight").mockResolvedValue({ ok: true, lease: renewedLease });
    const context = createExecutionContext();
    const upstream = new Response(new ReadableStream<Uint8Array>(), { headers: { "content-type": "text/event-stream" } });
    const response = proxyStream(
      upstream,
      controller,
      streamOptions(lease, 10),
      env,
      context,
      quotaSnapshot,
      Promise.resolve(false),
    );

    // When: the stream remains idle for one renewal interval, then is cancelled.
    await vi.advanceTimersByTimeAsync(10);
    await response.body?.cancel();
    await waitOnExecutionContext(context);

    // Then: renewal happened without a body chunk and cancellation released the lease.
    expect(renew).toHaveBeenCalledWith(requestId, lease.generation, 120_000);
    const replacement = await controller.acquireInFlight("stream-idle-replacement", 1);
    expect(replacement).toMatchObject({ ok: true, lease: { requestId: "stream-idle-replacement" } });
    if (replacement.ok) await controller.releaseInFlight("stream-idle-replacement", replacement.lease.generation);
  });

  it("aborts and marks a stream uncertain when renewal fails", async () => {
    vi.useFakeTimers();
    const controller = controllerFor("2026-10-11");
    const requestId = "stream-renewal-failure";
    await controller.reserve(requestId, 10, 10);
    const lease = await acquireLease(controller, requestId);
    const renewalError = new Error("renewal failed");
    vi.spyOn(controller, "renewInFlight").mockRejectedValue(renewalError);
    const context = createExecutionContext();
    const response = proxyStream(
      new Response(new ReadableStream<Uint8Array>(), { headers: { "content-type": "text/event-stream" } }),
      controller,
      streamOptions(lease, 10),
      env,
      context,
      quotaSnapshot,
      Promise.resolve(false),
    );

    // When: the renewal timer fails while the stream has no new chunk.
    await vi.advanceTimersByTimeAsync(10);

    // Then: the original renewal error propagates after fail-closed quota cleanup.
    await expect(waitOnExecutionContext(context)).rejects.toBe(renewalError);
    expect(await controller.getState()).toMatchObject({ uncertainTokens: 10, reservedTokens: 0 });
    await response.body?.cancel().catch(() => undefined);
  });

  it.each([
    ["stale generation", "2026-10-15", { ok: false, reason: "stale_generation" }],
    ["expired TTL", "2026-10-16", { ok: false, reason: "lease_not_found" }],
  ] as const)("aborts and finalizes exactly once when renewal reports %s", async (_label, day, renewalResult) => {
    vi.useFakeTimers();
    const controller = controllerFor(day);
    const requestId = `stream-renewal-${renewalResult.reason}`;
    await controller.reserve(requestId, 10, 10);
    const lease = await acquireLease(controller, requestId);
    const renew = vi.spyOn(controller, "renewInFlight").mockResolvedValue(renewalResult);
    const markUncertain = vi.spyOn(controller, "markUncertain");
    const releaseInFlight = vi.spyOn(controller, "releaseInFlight");
    const settle = vi.spyOn(controller, "settle");
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const context = createExecutionContext();
    const waitUntil = context.waitUntil.bind(context);
    context.waitUntil = (promise) => {
      void promise.catch(() => undefined);
      waitUntil(promise);
    };
    const response = proxyStream(
      new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "text/event-stream" },
      }),
      controller,
      streamOptions(lease, 10),
      env,
      context,
      quotaSnapshot,
      Promise.resolve(false),
    );

    await vi.advanceTimersByTimeAsync(10);

    await expect(waitOnExecutionContext(context)).rejects.toThrow("In-flight lease renewal failed.");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(markUncertain).toHaveBeenCalledTimes(1);
    expect(markUncertain).toHaveBeenCalledWith(requestId);
    expect(releaseInFlight).toHaveBeenCalledTimes(1);
    expect(releaseInFlight).toHaveBeenCalledWith(requestId, lease.generation);
    expect(settle).not.toHaveBeenCalled();
    expect(markUncertain).toHaveBeenCalledTimes(1);
    expect(releaseInFlight).toHaveBeenCalledTimes(1);
  });

  it("settles and records audit for Responses API streaming response with input_tokens/output_tokens", async () => {
    const controller = controllerFor("2026-10-18");
    const requestId = "stream-responses-settlement";
    await controller.reserve(requestId, 200, 200);
    const lease = await acquireLease(controller, requestId);
    const settle = vi.spyOn(controller, "settle").mockResolvedValue({ ok: true });
    const context = createExecutionContext();
    const event = 'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":120,"output_tokens":30,"total_tokens":150}}}\n\n';
    const response = proxyStream(
      new Response(event, { headers: { "content-type": "text/event-stream" } }),
      controller,
      streamOptions(lease),
      env,
      context,
      quotaSnapshot,
      Promise.resolve(false),
    );

    await response.text();
    await waitOnExecutionContext(context);

    expect(settle).toHaveBeenCalledWith(requestId, 150);
    await controller.releaseInFlight(requestId, lease.generation).catch(() => undefined);
  });

  const runStreamSettlementTest = async (
    requestId: string,
    day: string,
    stream: ReadableStream<Uint8Array>,
    expectedSettledTokens: number,
  ) => {
    const controller = controllerFor(day);
    await controller.reserve(requestId, 200, 200);
    const lease = await acquireLease(controller, requestId);
    const settle = vi.spyOn(controller, "settle").mockResolvedValue({ ok: true });
    const context = createExecutionContext();

    const response = proxyStream(
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      controller,
      streamOptions(lease),
      env,
      context,
      quotaSnapshot,
      Promise.resolve(false),
    );

    await response.text();
    await waitOnExecutionContext(context);

    expect(settle).toHaveBeenCalledWith(requestId, expectedSettledTokens);
    await controller.releaseInFlight(requestId, lease.generation).catch(() => undefined);
  };

  it("settles and records audit when usage event is split across chunk boundaries", async () => {
    const chunk1 = 'data: {"type":"response.completed","response":{"id":"resp_boundary","us';
    const chunk2 = 'age":{"input_tokens":120,"output_tokens":30,"total_tokens":150}}}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(chunk1));
        c.enqueue(new TextEncoder().encode(chunk2));
        c.close();
      },
    });
    await runStreamSettlementTest("stream-split-boundary-settlement", "2026-10-19", stream, 150);
  });

  it("settles correctly when output chunks contain misleading usage text before the final usage chunk", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"code: \\"usage\\": {\\\"bad\\\": true}\\nresponse.completed"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":50,"completion_tokens":25,"total_tokens":75}}\n\n'));
        c.close();
      },
    });
    await runStreamSettlementTest("stream-misleading-usage-text", "2026-10-20", stream, 75);
  });

  it("settles correctly when earlier stream chunks exceed the pruning threshold", async () => {
    const largeChunk = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"' + "x".repeat(1024) + '"}}]}\n\n');
    const finalChunk = new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 70; i++) c.enqueue(largeChunk);
        c.enqueue(finalChunk);
        c.close();
      },
    });
    await runStreamSettlementTest("stream-pruning-settlement", "2026-10-21", stream, 150);
  });
});

describe("extractUsageFromEvent", () => {
  it("extracts usage from Chat Completions chunk", () => {
    const event = 'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}';
    expect(extractUsageFromEvent(event)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
  });

  it("extracts usage from Responses API response.completed chunk", () => {
    const event = 'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150}}}';
    expect(extractUsageFromEvent(event)).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });
  });

  it("extracts usage from a large payload without parsing entire response", () => {
    const hugePadding = "x".repeat(100_000);
    const event = `data: {"type":"response.completed","response":{"id":"resp_1","padding":"${hugePadding}","usage":{"input_tokens":200000,"output_tokens":300,"total_tokens":200300}}}`;
    expect(extractUsageFromEvent(event)).toEqual({
      input_tokens: 200000,
      output_tokens: 300,
      total_tokens: 200300,
    });
  });

  it("returns undefined when usage is null or absent", () => {
    expect(extractUsageFromEvent('data: {"type":"response.created","response":{"usage":null}}')).toBeUndefined();
    expect(extractUsageFromEvent('data: {"choices":[{"delta":{"content":"no usage here"}}]}')).toBeUndefined();
  });

  it("returns undefined when the word usage appears in message content", () => {
    const event = 'data: {"choices":[{"delta":{"content":"Discussing \\"usage\\": { not real tokens }"}}]}';
    expect(extractUsageFromEvent(event)).toBeUndefined();
  });
});

describe("RingTailBuffer", () => {
  it("returns empty buffer when no chunks written", () => {
    const ring = new RingTailBuffer(16);
    expect(ring.getTail()).toEqual(new Uint8Array(0));
  });

  it("handles write of empty chunks without error", () => {
    const ring = new RingTailBuffer(16);
    ring.write(new Uint8Array(0));
    expect(ring.getTail()).toEqual(new Uint8Array(0));
  });

  it("returns exact data when total bytes is less than capacity", () => {
    const ring = new RingTailBuffer(16);
    const chunk1 = new TextEncoder().encode("hello ");
    const chunk2 = new TextEncoder().encode("world");
    ring.write(chunk1);
    ring.write(chunk2);
    expect(new TextDecoder().decode(ring.getTail())).toBe("hello world");
  });

  it("returns exact data when total bytes equals capacity", () => {
    const ring = new RingTailBuffer(10);
    ring.write(new TextEncoder().encode("0123456789"));
    expect(new TextDecoder().decode(ring.getTail())).toBe("0123456789");
  });

  it("returns last capacity bytes when total bytes exceeds capacity across multiple chunks", () => {
    const ring = new RingTailBuffer(8);
    // Write 4 chunks of 3 bytes each: "abc", "def", "ghi", "jkl" -> "abcdefghijkl" (12 bytes)
    // Tail 8 bytes should be "efghijkl"
    ring.write(new TextEncoder().encode("abc"));
    ring.write(new TextEncoder().encode("def"));
    ring.write(new TextEncoder().encode("ghi"));
    ring.write(new TextEncoder().encode("jkl"));
    expect(new TextDecoder().decode(ring.getTail())).toBe("efghijkl");
  });

  it("returns tail of chunk when a single chunk exceeds capacity", () => {
    const ring = new RingTailBuffer(5);
    ring.write(new TextEncoder().encode("initial"));
    ring.write(new TextEncoder().encode("0123456789"));
    expect(new TextDecoder().decode(ring.getTail())).toBe("56789");
  });
});

