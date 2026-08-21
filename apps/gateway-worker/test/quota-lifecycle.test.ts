import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const stub = (day: string) =>
  env.QUOTA_CONTROLLER.get(
    env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`),
  );

interface UnvalidatedReconcileController {
  reconcileRequest(requestId: string, disposition: string): Promise<unknown>;
}

interface UnvalidatedReserveController {
  reserve(requestId: string, tokens: number, upperBoundTokens: number, idempotencyKey: string): Promise<unknown>;
}

function hasUnvalidatedReconcileController(value: unknown): value is UnvalidatedReconcileController {
  return (
    typeof value === "object" &&
    value !== null &&
    "reconcileRequest" in value &&
    typeof value.reconcileRequest === "function"
  );
}

function hasUnvalidatedReserveController(value: unknown): value is UnvalidatedReserveController {
  return (
    typeof value === "object" &&
    value !== null &&
    "reserve" in value &&
    typeof value.reserve === "function"
  );
}

describe("QuotaController.reserve idempotency key", () => {
  it("replays the saved reserve result for the same request ID and key", async () => {
    // Given: one reservation identified by a request ID and idempotency key.
    const controller = stub("2026-08-17");
    const first = await controller.reserve("req-replay", 100, 100, "idem-replay");

    // When: the same reserve RPC is retried with the same identity and parameters.
    const replay = await controller.reserve("req-replay", 100, 100, "idem-replay");
    const state = await controller.getState();

    // Then: the original result is returned and quota is counted once.
    expect(replay).toEqual(first);
    expect(state.reservedTokens).toBe(100);
    expect(state.requestCount).toBe(1);
  });

  it("rejects an idempotency key over 255 UTF-8 bytes", async () => {
    // Given: a direct RPC call with a key beyond the documented storage bound.
    const controller = stub("2026-08-18");

    // When: the key crosses the QuotaController RPC boundary.
    const reservation = runInDurableObject(controller, async (instance) => {
      if (!hasUnvalidatedReserveController(instance)) {
        throw new TypeError("Expected a QuotaController instance.");
      }
      return instance.reserve("req-too-long-key", 100, 100, "€".repeat(86));
    });

    // Then: the invalid key is rejected before any reservation is stored.
    await expect(reservation).rejects.toThrow("Idempotency-Key must be at most 255 UTF-8 bytes.");
    expect(await controller.getState()).toMatchObject({ reservedTokens: 0, requestCount: 0 });
  });

  it("accepts a 255-byte multibyte idempotency key", async () => {
    // Given: an idempotency key whose UTF-8 representation is exactly 255 bytes.
    const controller = stub("2026-08-19");
    const key = "€".repeat(85);

    // When: the key crosses the QuotaController RPC boundary.
    const reservation = await controller.reserve("req-utf8-boundary", 100, 100, key);

    // Then: the exact byte-boundary key is accepted and stored once.
    expect(reservation.ok).toBe(true);
    expect(await controller.getState()).toMatchObject({ reservedTokens: 100, requestCount: 1 });
  });
});

describe("QuotaController.release", () => {
  it("frees a reservation before upstream contact", async () => {
    // Given: a reserved request that is known not to have reached upstream.
    const controller = stub("2026-09-10");
    await controller.reserve("req-r1", 30_000, 30_000);

    // When: the worker releases that reservation.
    const result = await controller.release("req-r1");
    const state = await controller.getState();

    // Then: the reservation is released without confirmed usage.
    expect(result).toEqual({ ok: true });
    expect(state.reservedTokens).toBe(0);
    expect(state.remaining).toBe(1_000_000);
  });

  it("does not alter settled usage when release arrives late", async () => {
    // Given: a request with confirmed usage.
    const controller = stub("2026-09-11");
    await controller.reserve("req-r2", 30_000, 30_000);
    await controller.settle("req-r2", 10_000);

    // When: a release is replayed after settlement.
    const result = await controller.release("req-r2");
    const state = await controller.getState();

    // Then: the terminal settlement is retained.
    expect(result).toEqual({ ok: true });
    expect(state.confirmedTokens).toBe(10_000);
  });

  it("returns unknown_request without creating state", async () => {
    // Given: a pool without a matching reservation.
    const controller = stub("2026-09-12");

    // When: release is requested for an unknown ID.
    const result = await controller.release("req-missing");
    const state = await controller.getState();

    // Then: the request is rejected and no request entry is created.
    expect(result).toEqual({ ok: false, reason: "unknown_request" });
    expect(state.requestCount).toBe(0);
  });
});

describe("QuotaController.reconcileRequest", () => {
  it("releases a reserved request left after uncertainty marking failed", async () => {
    // Given: a reservation that could not be moved to uncertain state.
    const controller = stub("2026-09-26");
    await controller.reserve("req-reserved-reconcile-unused", 25_000, 25_000);

    // When: reconciliation confirms that the request was unused.
    const result = await controller.reconcileRequest("req-reserved-reconcile-unused", "unused");
    const state = await controller.getState();

    // Then: the reserved bucket is released exactly once.
    expect(result).toEqual({ ok: true, applied: true });
    expect(state.reservedTokens).toBe(0);
    expect(state.uncertainTokens).toBe(0);
    expect(state.remaining).toBe(1_000_000);
  });

  it("confirms a reserved request left after uncertainty marking failed", async () => {
    // Given: a reservation that could not be moved to uncertain state.
    const controller = stub("2026-09-27");
    await controller.reserve("req-reserved-reconcile-consumed", 25_000, 25_000);

    // When: reconciliation confirms that the request was consumed.
    const result = await controller.reconcileRequest("req-reserved-reconcile-consumed", "consumed");
    const state = await controller.getState();

    // Then: the reserved bucket becomes confirmed usage exactly once.
    expect(result).toEqual({ ok: true, applied: true });
    expect(state.reservedTokens).toBe(0);
    expect(state.uncertainTokens).toBe(0);
    expect(state.confirmedTokens).toBe(25_000);
  });

  it("moves consumed uncertain usage to confirmed", async () => {
    // Given: an uncertain reservation.
    const controller = stub("2026-09-13");
    await controller.reserve("req-c1", 25_000, 25_000);
    await controller.markUncertain("req-c1");

    // When: reconciliation positively confirms consumption.
    const result = await controller.reconcileRequest("req-c1", "consumed");
    const state = await controller.getState();

    // Then: its reserved amount becomes confirmed usage.
    expect(result).toEqual({ ok: true, applied: true });
    expect(state.uncertainTokens).toBe(0);
    expect(state.confirmedTokens).toBe(25_000);
  });

  it("releases uncertain usage only when reconciliation confirms it was unused", async () => {
    // Given: an uncertain reservation backed by an unused reconciliation disposition.
    const controller = stub("2026-09-14");
    await controller.reserve("req-c2", 25_000, 25_000);
    await controller.markUncertain("req-c2");

    // When: reconciliation confirms it was not consumed.
    const result = await controller.reconcileRequest("req-c2", "unused");
    const state = await controller.getState();

    // Then: neither uncertain nor confirmed usage remains.
    expect(result).toEqual({ ok: true, applied: true });
    expect(state.uncertainTokens).toBe(0);
    expect(state.confirmedTokens).toBe(0);
    expect(state.remaining).toBe(1_000_000);
  });

  it("returns no-op for an unknown request without recreating quota state", async () => {
    // Given: a deleted or never-created request ID.
    const controller = stub("2026-09-15");

    // When: reconciliation is retried.
    const result = await controller.reconcileRequest("req-ghost", "consumed");
    const state = await controller.getState();

    // Then: the retry is idempotent and does not create a request entry.
    expect(result).toEqual({ ok: true, applied: false });
    expect(state.requestCount).toBe(0);
  });

  it("does not move settled usage backwards during reconciliation", async () => {
    // Given: a request that settled before reconciliation.
    const controller = stub("2026-09-16");
    await controller.reserve("req-c4", 5_000, 5_000);
    await controller.settle("req-c4", 4_000);

    // When: reconciliation later asserts it was unused.
    const result = await controller.reconcileRequest("req-c4", "unused");
    const state = await controller.getState();

    // Then: reconciliation cannot reverse the terminal settlement.
    expect(result).toEqual({ ok: true, applied: false });
    expect(state.confirmedTokens).toBe(4_000);
  });

  it("returns the original applied result when a successful reconciliation is retried", async () => {
    // Given: uncertain usage reconciled as consumed once.
    const controller = stub("2026-09-21");
    await controller.reserve("req-c5", 5_000, 5_000);
    await controller.markUncertain("req-c5");
    const applied = await controller.reconcileRequest("req-c5", "consumed");

    // When: the same reconciliation RPC is replayed.
    const replayed = await controller.reconcileRequest("req-c5", "consumed");
    const state = await controller.getState();

    // Then: its original successful result and one-time accounting are preserved.
    expect(replayed).toEqual(applied);
    expect(state.confirmedTokens).toBe(5_000);
  });

  it("returns the saved result for a mismatched reconciliation retry", async () => {
    const controller = stub("2026-09-24");
    await controller.reserve("req-c-mismatch", 5_000, 5_000);
    await controller.markUncertain("req-c-mismatch");
    const applied = await controller.reconcileRequest("req-c-mismatch", "consumed");

    const replayed = await controller.reconcileRequest("req-c-mismatch", "unused");

    expect(replayed).toEqual(applied);
  });

  it("rejects an invalid disposition without releasing uncertain usage", async () => {
    // Given: an uncertain reservation.
    const controller = stub("2026-09-17");
    await controller.reserve("req-invalid-disposition", 5_000, 5_000);
    await controller.markUncertain("req-invalid-disposition");

    // When: an untyped RPC caller sends an unsupported disposition.
    await expect(
      runInDurableObject(controller, async (instance) => {
        if (!hasUnvalidatedReconcileController(instance)) {
          throw new TypeError("Expected a QuotaController instance.");
        }
        return instance.reconcileRequest("req-invalid-disposition", "invalid");
      }),
    ).rejects.toThrow(TypeError);
    const state = await controller.getState();

    // Then: fail-closed accounting retains the uncertain reservation.
    expect(state.uncertainTokens).toBe(5_000);
    expect(state.confirmedTokens).toBe(0);
  });
});

describe("QuotaController.finalizeDay", () => {
  it("serializes finalization with a concurrent reservation", async () => {
    const controller = stub("2026-09-25");
    await controller.reserve("req-f-race-seed", 1_000, 1_000);

    const result = await Promise.all([
      controller.finalizeDay(),
      controller.reserve("req-f-race", 1_000, 1_000),
    ]);

    expect(result).toHaveLength(2);
    expect(result.some((entry) => entry.ok === false)).toBe(true);
    expect(result.some((entry) => entry.ok === true)).toBe(true);
  });

  it("refuses deletion while uncertain entries remain", async () => {
    // Given: an unresolved uncertain request.
    const controller = stub("2026-09-18");
    await controller.reserve("req-f1", 10_000, 10_000);
    await controller.markUncertain("req-f1");

    // When: day finalization is requested.
    const result = await controller.finalizeDay();
    const state = await controller.getState();

    // Then: storage remains intact and reports the guard count.
    expect(result).toEqual({
      ok: false,
      reason: "uncertain_remaining",
      uncertainCount: 1,
      reservedCount: 0,
    });
    expect(state.uncertainTokens).toBe(10_000);
  });

  it("refuses deletion while reserved entries remain", async () => {
    const controller = stub("2026-09-23");
    await controller.reserve("req-f-reserved", 10_000, 10_000);

    const result = await controller.finalizeDay();
    const state = await controller.getState();

    expect(result).toEqual({
      ok: false,
      reason: "reserved_remaining",
      uncertainCount: 0,
      reservedCount: 1,
    });
    expect(state.reservedTokens).toBe(10_000);
    expect(state.requestCount).toBe(1);
  });

  it("deletes the day after all uncertainty has been resolved", async () => {
    // Given: a settled request with no uncertain entries.
    const controller = stub("2026-09-19");
    await controller.reserve("req-f2", 10_000, 10_000);
    await controller.settle("req-f2", 8_000);

    // When: day finalization is requested.
    const result = await controller.finalizeDay();
    const state = await controller.getState();

    // Then: state materializes again as a clean quota day on the same DO name.
    expect(result).toEqual({ ok: true, deleted: true });
    expect(state.confirmedTokens).toBe(0);
    expect(state.requestCount).toBe(0);
  });

  it("rejects a late settlement after deletion as an orphan", async () => {
    // Given: a finalized day whose request entry has been deleted.
    const controller = stub("2026-09-20");
    await controller.reserve("req-f3", 10_000, 10_000);
    await controller.settle("req-f3", 8_000);
    await controller.finalizeDay();

    // When: a late settlement for the deleted request arrives.
    const result = await controller.settle("req-f3", 8_000);

    // Then: it cannot consume the later materialized quota state.
    expect(result).toEqual({ ok: false, reason: "unknown_request" });
  });
});
