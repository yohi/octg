import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { QuotaController } from "@octg/quota-controller";

const stub = (pool = "STANDARD", day = "2026-08-09") =>
  env.QUOTA_CONTROLLER.get(
    env.QUOTA_CONTROLLER.idFromName(`quota:${pool}:${day}`),
  );

async function useConfirmed(
  controller: DurableObjectStub<QuotaController>,
  tokens: number,
): Promise<void> {
  await controller.reserve(`seed-${crypto.randomUUID()}`, tokens, tokens);
}

const invalidReservations = [
  { description: "negative tokens", day: "2026-09-01", tokens: -1, upperBoundTokens: 0 },
  { description: "negative upperBoundTokens", day: "2026-09-02", tokens: 0, upperBoundTokens: -1 },
  { description: "NaN tokens", day: "2026-09-03", tokens: Number.NaN, upperBoundTokens: 0 },
  { description: "NaN upperBoundTokens", day: "2026-09-04", tokens: 0, upperBoundTokens: Number.NaN },
  { description: "fractional tokens", day: "2026-09-05", tokens: 1.5, upperBoundTokens: 2 },
  {
    description: "fractional upperBoundTokens",
    day: "2026-09-06",
    tokens: 1,
    upperBoundTokens: 1.5,
  },
  {
    description: "upperBoundTokens below tokens",
    day: "2026-09-07",
    tokens: 2,
    upperBoundTokens: 1,
  },
] as const;

function hasQuotaControllerMethods<T extends object>(
  instance: T,
): instance is T & Pick<QuotaController, "reserve" | "getState"> {
  return "reserve" in instance && "getState" in instance;
}

async function assertInvalidReservationDoesNotPersist(
  controller: DurableObjectStub<QuotaController>,
  tokens: number,
  upperBoundTokens: number,
): Promise<void> {
  await expect(
    runInDurableObject(controller, async (instance) => {
      if (!hasQuotaControllerMethods(instance)) {
        throw new TypeError("Expected a QuotaController instance.");
      }
      return instance.reserve("req-invalid", tokens, upperBoundTokens);
    }),
  ).rejects.toBeInstanceOf(TypeError);

  const stateAfterRejection = await controller.getState();
  expect(stateAfterRejection.reservedTokens).toBe(0);
  expect(stateAfterRejection.requestCount).toBe(0);

  const validRetry = await controller.reserve("req-invalid", 1, 1);
  const stateAfterRetry = await controller.getState();
  expect(validRetry.ok).toBe(true);
  expect(stateAfterRetry.reservedTokens).toBe(1);
  expect(stateAfterRetry.requestCount).toBe(1);
}

describe("QuotaController.reserve", () => {
  it("permits 950,000 used + 40,000 reservation", async () => {
    // Given: a STANDARD pool with 50,000 tokens remaining.
    const controller = stub();
    await useConfirmed(controller, 950_000);

    // When: a reservation within the remaining amount is requested.
    const result = await controller.reserve("req-a", 40_000, 40_000);

    // Then: the reservation succeeds and reports the next UTC reset.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.remaining).toBe(10_000);
      expect(result.resetAt).toBe("2026-08-10T00:00:00Z");
    }
  });

  it("rejects 999,000 used + 2,000 reservation", async () => {
    // Given: a STANDARD pool with 1,000 tokens remaining.
    const controller = stub("STANDARD", "2026-08-10");
    await useConfirmed(controller, 999_000);

    // When: a reservation greater than the remaining amount is requested.
    const result = await controller.reserve("req-b", 2_000, 2_000);

    // Then: the request is rejected with the unmodified remaining amount.
    expect(result).toEqual({
      ok: false,
      reason: "insufficient_quota",
      remaining: 1_000,
      resetAt: "2026-08-11T00:00:00Z",
    });
  });

  it("evaluates a smaller retry as new after an unsuccessful reservation", async () => {
    // Given: a STANDARD pool with 1,000 tokens remaining.
    const controller = stub("STANDARD", "2026-08-11");
    await useConfirmed(controller, 999_000);

    // When: an oversized reservation fails and the same request ID retries smaller.
    const first = await controller.reserve("req-c", 2_000, 2_000);
    const second = await controller.reserve("req-c", 1_000, 1_000);
    const state = await controller.getState();

    // Then: only the smaller reservation is retained.
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    expect(state.reservedTokens).toBe(1_000_000);
  });

  it("returns the original result without double-counting a retransmission", async () => {
    // Given: an unused STANDARD pool.
    const controller = stub("STANDARD", "2026-08-12");

    // When: the same request ID is reserved twice.
    const first = await controller.reserve("req-dup", 10_000, 10_000);
    const second = await controller.reserve("req-dup", 10_000, 10_000);
    const state = await controller.getState();

    // Then: the initial result is reused and one reservation is counted.
    expect(second).toEqual(first);
    expect(state.reservedTokens).toBe(10_000);
    expect(state.requestCount).toBe(1);
  });

  it("rejects a retransmission with different reservation parameters", async () => {
    const controller = stub("STANDARD", "2026-08-13");

    await controller.reserve("req-mismatch", 10_000, 10_000);

    await expect(
      runInDurableObject(controller, async (instance) => {
        if (!hasQuotaControllerMethods(instance)) {
          throw new TypeError("Expected a QuotaController instance.");
        }
        return instance.reserve("req-mismatch", 9_000, 10_000);
      }),
    ).rejects.toThrow("parameters do not match the saved request");
  });

  it("uses the configured MINI pool limit", async () => {
    // Given: an unused MINI pool.
    const controller = stub("MINI", "2026-08-09");

    // When: nearly all of the MINI limit is reserved.
    const result = await controller.reserve("req-m", 9_999_999, 9_999_999);

    // Then: the 10,000,000-token default allows the reservation.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.remaining).toBe(1);
  });

  for (const invalidReservation of invalidReservations) {
    it(`rejects ${invalidReservation.description} without storing a request entry`, async () => {
      // Given: an unused STANDARD pool and an invalid direct RPC reservation.
      const controller = stub("STANDARD", invalidReservation.day);

      // When: the invalid reservation is rejected and the request ID retries validly.
      await assertInvalidReservationDoesNotPersist(
        controller,
        invalidReservation.tokens,
        invalidReservation.upperBoundTokens,
      );

      // Then: no quota mutation or idempotency entry from the invalid call remains.
    });
  }
});

describe("QuotaController in-flight leases", () => {
  it("reuses a released pool slot without changing quota reservations", async () => {
    // Given: a pool whose two in-flight slots are occupied.
    const controller = stub("STANDARD", "2026-08-31");
    const before = await controller.getState();
    expect(await controller.acquireInFlight("request-one", 2)).toEqual({ ok: true });
    expect(await controller.acquireInFlight("request-two", 2)).toEqual({ ok: true });

    // When: a third request is admitted before and after one active request releases its slot.
    const rejected = await controller.acquireInFlight("request-three", 2);
    await controller.releaseInFlight("request-one");
    const admitted = await controller.acquireInFlight("request-three", 2);

    // Then: only the saturated admission is rejected, and lease bookkeeping does not spend quota.
    expect(rejected).toEqual({ ok: false, reason: "worker_concurrency_exceeded" });
    expect(admitted).toEqual({ ok: true });
    expect(await controller.getState()).toMatchObject({
      reservedTokens: before.reservedTokens,
      confirmedTokens: before.confirmedTokens,
      uncertainTokens: before.uncertainTokens,
      requestCount: before.requestCount,
    });
  });

  it("makes repeated acquire and release idempotent for one request", async () => {
    // Given: one available in-flight slot.
    const controller = stub("STANDARD", "2026-09-01");

    // When: one request acquires twice, then releases twice.
    const first = await controller.acquireInFlight("request-one", 1);
    const repeated = await controller.acquireInFlight("request-one", 1);
    await controller.releaseInFlight("request-one");
    await controller.releaseInFlight("request-one");
    const next = await controller.acquireInFlight("request-two", 1);

    // Then: duplicate lifecycle signals neither consume nor release another request's slot.
    expect(first).toEqual({ ok: true });
    expect(repeated).toEqual({ ok: true });
    expect(next).toEqual({ ok: true });
  });
});

describe("QuotaController reserve uncertainty", () => {
  it("discovers reserved and uncertain entries with bounded origins", async () => {
    const controller = stub("STANDARD", "2026-09-30");
    await controller.reserve("req-reserved-snapshot", 100, 100);
    await controller.reserve("req-upstream-uncertain", 200, 200);
    await controller.markUncertain("req-upstream-uncertain");
    await controller.reserve("req-reserve-unknown", 300, 300);
    await controller.markReserveOutcomeUnknown("req-reserve-unknown");

    const snapshot = await controller.getReconcileSnapshot();

    expect(snapshot.requests).toEqual(expect.arrayContaining([
      { requestId: "req-reserved-snapshot", reservedTokens: 100, state: "reserved", uncertaintyOrigin: undefined },
      { requestId: "req-upstream-uncertain", reservedTokens: 200, state: "uncertain", uncertaintyOrigin: "upstream_uncertain" },
      { requestId: "req-reserve-unknown", reservedTokens: 300, state: "uncertain", uncertaintyOrigin: "reserve_unknown" },
    ]));
  });

  it("moves an unresolved reservation to reserve_unknown exactly once", async () => {
    const controller = stub("STANDARD", "2026-10-01");
    await controller.reserve("req-mark-unknown", 400, 400);

    const first = await controller.markReserveOutcomeUnknown("req-mark-unknown");
    const second = await controller.markReserveOutcomeUnknown("req-mark-unknown");
    const state = await controller.getState();
    const snapshot = await controller.getReconcileSnapshot();

    expect(first).toEqual({ ok: true, applied: true });
    expect(second).toEqual(first);
    expect(state.reservedTokens).toBe(0);
    expect(state.uncertainTokens).toBe(400);
    expect(snapshot.requests).toContainEqual({
      requestId: "req-mark-unknown",
      reservedTokens: 400,
      state: "uncertain",
      uncertaintyOrigin: "reserve_unknown",
    });
  });

  it("keeps the reserve-unknown entry until an explicit disposition", async () => {
    const controller = stub("STANDARD", "2026-10-02");
    await controller.reserve("req-explicit-disposition", 500, 500);
    await controller.markReserveOutcomeUnknown("req-explicit-disposition");

    const pending = await controller.getReconcileSnapshot();
    const reconciled = await controller.reconcileRequest("req-explicit-disposition", "consumed");
    const retry = await controller.reconcileRequest("req-explicit-disposition", "consumed");

    expect(pending.requests).toContainEqual(expect.objectContaining({
      requestId: "req-explicit-disposition",
      uncertaintyOrigin: "reserve_unknown",
    }));
    expect(reconciled).toEqual({ ok: true, applied: true });
    expect(retry).toEqual(reconciled);
    expect((await controller.getReconcileSnapshot()).requests).not.toContainEqual(
      expect.objectContaining({ requestId: "req-explicit-disposition" }),
    );
  });
});

describe("QuotaController identity", () => {
  const invalidQuotaNames = [
    "quota:STANDARD:2026-09-08:extra",
    "quota:MINI:2026-02-30",
    "quota:STANDARD:+002026-08-09",
  ] as const;

  for (const quotaName of invalidQuotaNames) {
    it(`rejects the invalid identity ${quotaName}`, async () => {
      // Given: a Durable Object ID that is not quota:{STANDARD|MINI}:{YYYY-MM-DD}.
      const controller = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaName));

      // When: the controller instance receives its state request.
      // Then: the malformed identity is rejected before any storage access.
      await expect(
        runInDurableObject(controller, async (instance) => {
          if (!hasQuotaControllerMethods(instance)) {
            throw new TypeError("Expected a QuotaController instance.");
          }
          return instance.getState();
        }),
      ).rejects.toThrow(
        "QuotaController requires a quota:{POOL}:{UTC_DAY} name.",
      );
    });
  }
});

describe("QuotaController client-scoped idempotency", () => {
  it("allows the same key for different clients", async () => {
    const controller = stub("STANDARD", "2026-08-26");

    const first = await controller.reserve("req-client-a", 100, 100, "shared-key", "client-a");
    const second = await controller.reserve("req-client-b", 100, 100, "shared-key", "client-b");
    const state = await controller.getState();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(state.requestCount).toBe(2);
  });
});
