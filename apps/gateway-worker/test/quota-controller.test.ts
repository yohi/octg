import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuotaController } from "@octg/quota-controller";
import {
  acquireInFlightLease,
  type QuotaStorage,
} from "../../../durable-objects/quota-controller/src/store";

const stub = (pool = "STANDARD", day = "2026-08-09") =>
  env.QUOTA_CONTROLLER.get(
    env.QUOTA_CONTROLLER.idFromName(`quota:${pool}:${day}`),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

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
): instance is T & Pick<QuotaController, "acquireInFlight" | "getState" | "reserve"> {
  return "reserve" in instance && "getState" in instance && "acquireInFlight" in instance;
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
  it("returns one lease generation for a repeated active acquire without consuming another slot", async () => {
    // Given: a pool with capacity for one active request at a fixed instant.
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const controller = stub("STANDARD", "2026-08-31");

    // When: the same request acquires twice before its lease expires.
    const first = await controller.acquireInFlight("request-one", 1, 50);
    expect(first).toMatchObject({
      ok: true,
      lease: { requestId: "request-one", expiresAtMs: 1_050 },
    });
    if (!first.ok) throw new TypeError("Expected the first lease acquisition to succeed.");
    const repeated = await controller.acquireInFlight("request-one", 1, 50);
    const saturated = await controller.acquireInFlight("request-two", 1, 50);

    // Then: the retry owns the same generation and the one slot remains occupied.
    expect(first.lease.generation).toMatch(/^[0-9a-f-]{36}$/);
    expect(repeated).toMatchObject({
      ok: true,
      lease: { generation: first.lease.generation, expiresAtMs: 1_050 },
    });
    expect(saturated).toEqual({ ok: false, reason: "worker_concurrency_exceeded" });
  });

  it("prunes expired leases transactionally before reusing capacity", async () => {
    // Given: a one-slot pool with an expired lease.
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const controller = stub("STANDARD", "2026-09-01");
    await controller.acquireInFlight("expired-request", 1, 1);

    // When: another request acquires after the prior lease has expired.
    now.mockReturnValue(1_002);
    const replacement = await controller.acquireInFlight("replacement-request", 1, 50);

    // Then: expiry is removed within the acquisition transaction and capacity is reusable.
    expect(replacement).toMatchObject({
      ok: true,
      lease: { requestId: "replacement-request", expiresAtMs: 1_052 },
    });
  });

  it("returns a one-millisecond lease that remains unexpired after asynchronous storage access", async () => {
    // Given: storage advances the clock while the in-flight lease transaction awaits state.
    let nowMs = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const storage: QuotaStorage = {
      get: async <T>(_key: string): Promise<T | undefined> => {
        nowMs = 1_001;
        return undefined;
      },
      put: async <T>(_key: string, _value: T): Promise<void> => undefined,
      list: async <T>(): Promise<Map<string, T>> => new Map<string, T>(),
    };

    // When: a one-millisecond lease is acquired through the storage lifecycle.
    const acquired = await acquireInFlightLease(storage, {
      requestId: "async-boundary-request",
      limit: 1,
      ttlMs: 1,
    });

    // Then: the lease expiry is strictly after the transaction's current instant.
    expect(acquired).toMatchObject({
      ok: true,
      lease: { requestId: "async-boundary-request", expiresAtMs: 1_002 },
    });
    if (!acquired.ok) throw new TypeError("Expected the boundary lease acquisition to succeed.");
    expect(acquired.lease.expiresAtMs).toBeGreaterThan(nowMs);
  });

  it("fences a replacement lease from the expired generation", async () => {
    // Given: a request whose original one-millisecond lease has expired.
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const controller = stub("STANDARD", "2026-09-02");
    const original = await controller.acquireInFlight("request-one", 1, 1);
    expect(original).toMatchObject({ ok: true, lease: { expiresAtMs: 1_001 } });
    if (!original.ok) throw new TypeError("Expected the original lease acquisition to succeed.");

    // When: the request acquires a replacement lease and the stale owner renews and releases.
    now.mockReturnValue(1_002);
    const replacement = await controller.acquireInFlight("request-one", 1, 50);
    expect(replacement).toMatchObject({ ok: true, lease: { expiresAtMs: 1_052 } });
    if (!replacement.ok) throw new TypeError("Expected the replacement lease acquisition to succeed.");
    const staleRenewal = await controller.renewInFlight("request-one", original.lease.generation, 50);
    const staleRelease = await controller.releaseInFlight("request-one", original.lease.generation);
    const saturated = await controller.acquireInFlight("request-two", 1, 50);

    // Then: only the replacement generation retains ownership of the slot.
    expect(replacement.lease.generation).not.toBe(original.lease.generation);
    expect(staleRenewal).toEqual({ ok: false, reason: "stale_generation" });
    expect(staleRelease).toEqual({ ok: true, released: false });
    expect(saturated).toEqual({ ok: false, reason: "worker_concurrency_exceeded" });
  });

  it("renews an active lease but does not revive an expired one", async () => {
    // Given: an active lease with a generation held by its current owner.
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const controller = stub("STANDARD", "2026-09-03");
    const acquired = await controller.acquireInFlight("request-one", 1, 5);
    expect(acquired).toMatchObject({ ok: true, lease: { expiresAtMs: 1_005 } });
    if (!acquired.ok) throw new TypeError("Expected the lease acquisition to succeed.");

    // When: the owner renews before expiry and retries only after the renewed lease expires.
    now.mockReturnValue(1_001);
    const renewed = await controller.renewInFlight("request-one", acquired.lease.generation, 5);
    now.mockReturnValue(1_007);
    const expiredRenewal = await controller.renewInFlight("request-one", acquired.lease.generation, 5);
    const replacement = await controller.acquireInFlight("request-two", 1, 5);

    // Then: the active renewal extends expiry, while the expired lease cannot be revived.
    expect(renewed).toMatchObject({ ok: true, lease: { expiresAtMs: 1_006 } });
    expect(expiredRenewal).toEqual({ ok: false, reason: "lease_not_found" });
    expect(replacement).toMatchObject({ ok: true, lease: { requestId: "request-two" } });
  });

  it("releases legacy string-array entries with the request-ID-only compatibility call", async () => {
    // Given: a durable object persisted by the legacy string-array format.
    const controller = stub("STANDARD", "2026-09-04");
    await runInDurableObject(controller, (_instance, state) =>
      state.storage.put("in_flight", ["legacy-request"]),
    );

    // When: the legacy owner releases only by request ID.
    const released = await controller.releaseInFlight("legacy-request");
    const acquired = await controller.acquireInFlight("new-request", 1, 50);

    // Then: the old record no longer occupies the one available slot.
    expect(released).toEqual({ ok: true, released: true });
    expect(acquired).toMatchObject({ ok: true, lease: { requestId: "new-request" } });
  });

  it("gives migrated legacy leases a finite grace period and allows renewal", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const controller = stub("STANDARD", "2026-09-05");
    await runInDurableObject(controller, (_instance, state) =>
      state.storage.put("in_flight", ["legacy-request"]),
    );

    const migrated = await controller.acquireInFlight("legacy-request", 1, 50);
    const blocked = await controller.acquireInFlight("new-request", 1, 50);
    if (!migrated.ok) throw new TypeError("Expected the legacy lease to be visible during its grace period.");
    const persisted = await runInDurableObject(controller, (_instance, state) => state.storage.get("in_flight"));
    const renewed = await controller.renewInFlight("legacy-request", migrated.lease.generation, 50);
    now.mockReturnValue(121_001);
    const reclaimed = await controller.acquireInFlight("new-request", 1, 50);

    expect(migrated.lease.generation).toBe("legacy:legacy-request");
    expect(persisted).toEqual({
      version: 1,
      leases: [{ requestId: "legacy-request", generation: "legacy:legacy-request", expiresAtMs: 121_000 }],
    });
    expect(blocked).toEqual({ ok: false, reason: "worker_concurrency_exceeded" });
    expect(renewed).toMatchObject({ ok: true, lease: { expiresAtMs: 1_050 } });
    expect(reclaimed).toMatchObject({ ok: true, lease: { requestId: "new-request" } });
  });

  it("keeps duplicate acquire and release signals from freeing another request", async () => {
    const controller = stub("STANDARD", "2026-09-10");
    const first = await controller.acquireInFlight("request-one", 1, 50);
    if (!first.ok) throw new TypeError("Expected the first lease acquisition to succeed.");
    const repeated = await controller.acquireInFlight("request-one", 1, 50);
    const released = await controller.releaseInFlight("request-one", first.lease.generation);
    const next = await controller.acquireInFlight("request-two", 1, 50);
    const duplicateRelease = await controller.releaseInFlight("request-one", first.lease.generation);
    const saturated = await controller.acquireInFlight("request-three", 1, 50);

    expect(repeated).toMatchObject({ ok: true, lease: { generation: first.lease.generation } });
    expect(released).toEqual({ ok: true, released: true });
    expect(next).toMatchObject({ ok: true, lease: { requestId: "request-two" } });
    expect(duplicateRelease).toEqual({ ok: true, released: false });
    expect(saturated).toEqual({ ok: false, reason: "worker_concurrency_exceeded" });
    if (next.ok) await controller.releaseInFlight("request-two", next.lease.generation);
  });

  it.each([
    [0, "2026-09-06"],
    [-1, "2026-09-07"],
    [1.5, "2026-09-08"],
    [Number.MAX_SAFE_INTEGER + 1, "2026-09-09"],
  ] as const)(
    "rejects an invalid lease TTL of %s without acquiring a slot",
    async (ttlMs, day) => {
      // Given: an empty one-slot pool and an invalid caller-provided TTL.
      const controller = stub("STANDARD", day);

      // When: a direct RPC acquire uses the invalid TTL.
      // Then: the boundary rejects it before persisting a lease.
      await expect(
        runInDurableObject(controller, async (instance) => {
          if (!hasQuotaControllerMethods(instance)) {
            throw new TypeError("Expected a QuotaController instance.");
          }
          return instance.acquireInFlight("request-one", 1, ttlMs);
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(await controller.acquireInFlight("request-two", 1, 50)).toMatchObject({ ok: true });
    },
  );
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

  it("does not mutate a settled entry when its reserve outcome becomes unknown", async () => {
    const controller = stub("STANDARD", "2026-10-03");
    await controller.reserve("req-settled-reserve-outcome", 500, 500);
    await controller.settle("req-settled-reserve-outcome", 300);
    const before = await controller.getState();

    const result = await controller.markReserveOutcomeUnknown("req-settled-reserve-outcome");

    expect(result).toEqual({ ok: true, applied: false });
    expect(await controller.getState()).toEqual(before);
  });

  it("does not mutate an uncertain entry when its reserve outcome becomes unknown", async () => {
    const controller = stub("STANDARD", "2026-10-04");
    await controller.reserve("req-uncertain-reserve-outcome", 500, 500);
    await controller.markUncertain("req-uncertain-reserve-outcome");
    const before = await controller.getState();

    const result = await controller.markReserveOutcomeUnknown("req-uncertain-reserve-outcome");

    expect(result).toEqual({ ok: true, applied: false });
    expect(await controller.getState()).toEqual(before);
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
