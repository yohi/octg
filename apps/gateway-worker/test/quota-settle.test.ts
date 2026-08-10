import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const stub = (day: string) =>
  env.QUOTA_CONTROLLER.get(
    env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`),
  );

interface SettlementController {
  settle(requestId: string, actualTokens: number): Promise<unknown>;
}

function hasSettlementController(value: unknown): value is SettlementController {
  return typeof value === "object" && value !== null && "settle" in value && typeof value.settle === "function";
}

describe("QuotaController.settle", () => {
  it("moves a reservation to confirmed usage", async () => {
    // Given: a request with a 40,000-token reservation.
    const controller = stub("2026-09-01");
    await controller.reserve("req-s1", 40_000, 40_000);

    // When: upstream usage confirms 25,000 tokens.
    const result = await controller.settle("req-s1", 25_000);
    const state = await controller.getState();

    // Then: only the actual usage is confirmed and the reservation is cleared.
    expect(result).toEqual({ ok: true });
    expect(state.confirmedTokens).toBe(25_000);
    expect(state.reservedTokens).toBe(0);
  });

  it("does not double-count a duplicate settlement", async () => {
    // Given: a request that has already settled.
    const controller = stub("2026-09-02");
    await controller.reserve("req-s2", 40_000, 40_000);
    await controller.settle("req-s2", 25_000);

    // When: the same settlement is replayed.
    const result = await controller.settle("req-s2", 25_000);
    const state = await controller.getState();

    // Then: the original result is returned without another confirmed charge.
    expect(result).toEqual({ ok: true });
    expect(state.confirmedTokens).toBe(25_000);
  });

  it("accounts overage fail-closed and rejects later reservations", async () => {
    // Given: a pool with a settled 900,000-token request.
    const controller = stub("2026-09-03");
    await controller.reserve("seed", 900_000, 900_000);
    await controller.settle("seed", 900_000);
    await controller.reserve("req-over", 80_000, 80_000);

    // When: actual usage exceeds the second reservation.
    await controller.settle("req-over", 120_000);
    const state = await controller.getState();
    const afterOverage = await controller.reserve("req-after-over", 1, 1);

    // Then: the complete actual amount is accounted and the over-limit pool is closed.
    expect(state.confirmedTokens).toBe(1_020_000);
    expect(state.reservedTokens).toBe(0);
    expect(state.remaining).toBeLessThan(0);
    expect(afterOverage.ok).toBe(false);
  });

  it("settles uncertain usage without double-subtracting its reservation", async () => {
    // Given: a request moved to uncertain after its upstream result was unavailable.
    const controller = stub("2026-09-04");
    await controller.reserve("req-s4", 40_000, 40_000);
    await controller.markUncertain("req-s4");

    // When: delayed upstream usage arrives.
    await controller.settle("req-s4", 25_000);
    const state = await controller.getState();

    // Then: uncertain usage moves to confirmed usage and reserved usage remains zero.
    expect(state.uncertainTokens).toBe(0);
    expect(state.reservedTokens).toBe(0);
    expect(state.confirmedTokens).toBe(25_000);
  });

  it("returns unknown_request without touching counters for an unknown settlement", async () => {
    // Given: an unused pool.
    const controller = stub("2026-09-05");

    // When: a settlement references no reservation.
    const result = await controller.settle("req-nope", 100);
    const state = await controller.getState();

    // Then: the request is rejected and quota state is unchanged.
    expect(result).toEqual({ ok: false, reason: "unknown_request" });
    expect(state.confirmedTokens).toBe(0);
  });

  it("rejects invalid actual usage without changing a reservation", async () => {
    // Given: a pending reservation.
    const controller = stub("2026-09-09");
    await controller.reserve("req-invalid-actual", 40_000, 40_000);

    // When: settlement receives a negative actual usage value.
    await expect(
      runInDurableObject(controller, async (instance) => {
        if (!hasSettlementController(instance)) {
          throw new TypeError("Expected a QuotaController instance.");
        }
        return instance.settle("req-invalid-actual", -1);
      }),
    ).rejects.toThrow(TypeError);
    const state = await controller.getState();

    // Then: the reservation remains fail-closed rather than decreasing confirmed usage.
    expect(state.reservedTokens).toBe(40_000);
    expect(state.confirmedTokens).toBe(0);
  });

  it("keeps the original reserve result after settlement", async () => {
    // Given: a reservation with an observable remaining balance.
    const controller = stub("2026-09-06");
    const reserved = await controller.reserve("req-reserve-result", 40_000, 40_000);
    await controller.settle("req-reserve-result", 25_000);

    // When: reserve is retransmitted after another RPC has stored its own result.
    const replayed = await controller.reserve("req-reserve-result", 40_000, 40_000);

    // Then: reserve returns its own original result rather than a lifecycle result.
    expect(replayed).toEqual(reserved);
  });
});

describe("QuotaController.markUncertain", () => {
  it("keeps unknown outcomes reserved until an explicit later transition", async () => {
    // Given: a request whose upstream outcome cannot be determined.
    const controller = stub("2026-09-07");
    await controller.reserve("req-uncertain", 40_000, 40_000);

    // When: uncertainty is marked and the RPC is replayed.
    const first = await controller.markUncertain("req-uncertain");
    const replayed = await controller.markUncertain("req-uncertain");
    const state = await controller.getState();

    // Then: no TTL release occurs and the replay makes no second counter movement.
    expect(first).toEqual({ ok: true });
    expect(replayed).toEqual(first);
    expect(state.reservedTokens).toBe(0);
    expect(state.uncertainTokens).toBe(40_000);
  });

  it("does not move a settled request back to uncertain", async () => {
    // Given: a request with confirmed usage.
    const controller = stub("2026-09-08");
    await controller.reserve("req-settled", 40_000, 40_000);
    await controller.settle("req-settled", 25_000);

    // When: a stale uncertainty signal arrives.
    const result = await controller.markUncertain("req-settled");
    const state = await controller.getState();

    // Then: the terminal settlement remains authoritative.
    expect(result).toEqual({ ok: true });
    expect(state.confirmedTokens).toBe(25_000);
    expect(state.uncertainTokens).toBe(0);
  });
});
