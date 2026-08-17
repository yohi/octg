import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { QuotaController } from "@octg/quota-controller";
import type { InFlightLease, QuotaSnapshot } from "@octg/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyStream } from "../src/stream";

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
      const replacement = await controller.acquireInFlight(replacementRequestId, 1);
      expect(replacement).toMatchObject({ ok: true, lease: { requestId: replacementRequestId } });
      if (replacement.ok) await controller.releaseInFlight(replacementRequestId, replacement.lease.generation);
    } finally {
      await controller.releaseInFlight(requestId, lease.generation);
    }
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

});
