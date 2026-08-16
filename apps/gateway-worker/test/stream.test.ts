import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { QuotaController } from "@octg/quota-controller";
import type { QuotaSnapshot } from "@octg/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyStream } from "../src/stream";

const controllerFor = (day: string): DurableObjectStub<QuotaController> =>
  env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));

const sseResponse = (event: string): Response =>
  new Response(`data: ${event}\n\n`, { headers: { "content-type": "text/event-stream" } });

const quotaSnapshot = {
  pool: "STANDARD",
  limit: 1_000_000,
  used: 0,
  remaining: 1_000_000,
  resetAt: "2026-10-08T00:00:00Z",
} satisfies QuotaSnapshot;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("proxy stream finalization", () => {
  it("releases the in-flight lease while preserving a settlement rejection", async () => {
    // Given: a stream whose settlement RPC fails after a lease was acquired.
    const controller = controllerFor("2026-10-05");
    const requestId = "stream-settlement-rejection";
    const replacementRequestId = "stream-settlement-replacement";
    const settlementError = new Error("settlement failed");
    await controller.acquireInFlight(requestId, 1);
    vi.spyOn(controller, "settle").mockRejectedValue(settlementError);
    const context = createExecutionContext();
    const response = proxyStream(
      sseResponse('{"usage":{"total_tokens":1}}'),
      controller,
      requestId,
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
      expect(await controller.acquireInFlight(replacementRequestId, 1)).toEqual({ ok: true });
    } finally {
      await controller.releaseInFlight(requestId);
      await controller.releaseInFlight(replacementRequestId);
    }
  });

  it("preserves the settlement rejection when the finalization callback throws", async () => {
    // Given: settlement fails and the finalization callback also throws.
    const controller = controllerFor("2026-10-09");
    const requestId = "stream-callback-rejection";
    const replacementRequestId = "stream-callback-replacement";
    const settlementError = new Error("settlement failed");
    const callbackError = new Error("stage callback failed");
    await controller.acquireInFlight(requestId, 1);
    vi.spyOn(controller, "settle").mockRejectedValue(settlementError);
    const context = createExecutionContext();
    const response = proxyStream(
      sseResponse('{"usage":{"total_tokens":1}}'),
      controller,
      requestId,
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
      expect(await controller.acquireInFlight(replacementRequestId, 1)).toEqual({ ok: true });
    } finally {
      await controller.releaseInFlight(requestId);
      await controller.releaseInFlight(replacementRequestId);
    }
  });

  it("releases the in-flight lease while preserving an uncertainty-mark rejection", async () => {
    // Given: a stream without usage whose uncertainty RPC fails after a lease was acquired.
    const controller = controllerFor("2026-10-06");
    const requestId = "stream-uncertainty-rejection";
    const replacementRequestId = "stream-uncertainty-replacement";
    const uncertaintyError = new Error("uncertainty marking failed");
    await controller.acquireInFlight(requestId, 1);
    vi.spyOn(controller, "markUncertain").mockRejectedValue(uncertaintyError);
    const context = createExecutionContext();
    const response = proxyStream(
      sseResponse('{"id":"usage-absent"}'),
      controller,
      requestId,
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
      expect(await controller.acquireInFlight(replacementRequestId, 1)).toEqual({ ok: true });
    } finally {
      await controller.releaseInFlight(requestId);
      await controller.releaseInFlight(replacementRequestId);
    }
  });

  it("treats audit insertion rejection as best effort while releasing the in-flight lease", async () => {
    // Given: settlement succeeds but the audit insertion promise rejects after a lease was acquired.
    const controller = controllerFor("2026-10-07");
    const requestId = "stream-audit-rejection";
    const replacementRequestId = "stream-audit-replacement";
    const auditError = new Error("audit insertion failed");
    await controller.reserve(requestId, 10, 10);
    await controller.acquireInFlight(requestId, 1);
    const context = createExecutionContext();
    const inserted = Promise.reject(auditError);
    void inserted.catch(() => undefined);
    const response = proxyStream(
      sseResponse('{"usage":{"total_tokens":5}}'),
      controller,
      requestId,
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
      expect(await controller.acquireInFlight(replacementRequestId, 1)).toEqual({ ok: true });
    } finally {
      await controller.releaseInFlight(requestId);
      await controller.releaseInFlight(replacementRequestId);
    }
  });

});
