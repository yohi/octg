import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { QuotaController } from "../src/quota-controller";

const stub = (day: string): DurableObjectStub<QuotaController> =>
  env.QUOTA_CONTROLLER.get(
    env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`),
  );

function hasReserve(instance: object): instance is Pick<QuotaController, "reserve"> {
  return "reserve" in instance;
}

describe("QuotaController.reserve idempotency key", () => {
  it("rejects a duplicate idempotency key after the first reservation", async () => {
    // Given: an unused quota pool and one idempotency key.
    const controller = stub("2026-08-12");

    // When: different request IDs reserve with the same key.
    const first = await controller.reserve("req-1", 100, 100, "idem-1");
    const second = await controller.reserve("req-2", 100, 100, "idem-1");
    const state = await controller.getState();

    // Then: the duplicate is rejected and quota is counted once.
    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: false,
      reason: "duplicate_idempotency_key",
      requestId: "req-1",
      resetAt: "2026-08-13T00:00:00Z",
    });
    expect(state.reservedTokens).toBe(100);
    expect(state.requestCount).toBe(1);
  });

  it("reserves independently for different idempotency keys", async () => {
    // Given: an unused quota pool and two idempotency keys.
    const controller = stub("2026-08-13");

    // When: each key reserves using a distinct request ID.
    const first = await controller.reserve("req-1", 100, 100, "idem-1");
    const second = await controller.reserve("req-2", 100, 100, "idem-2");
    const state = await controller.getState();

    // Then: both reservations consume quota independently.
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.remaining).toBe(999_800);
    expect(state.reservedTokens).toBe(200);
    expect(state.requestCount).toBe(2);
  });

  it("rejects a reused idempotency key without re-evaluating its parameters", async () => {
    // Given: a saved reservation for an idempotency key.
    const controller = stub("2026-08-14");
    await controller.reserve("req-1", 100, 100, "idem-1");

    // When: another request ID reuses the key with different tokens.
    const mismatchedReservation = runInDurableObject(controller, async (instance) => {
      if (!hasReserve(instance)) {
        throw new TypeError("Expected a QuotaController instance.");
      }
      return instance.reserve("req-2", 99, 100, "idem-1");
    });

    // Then: the existing key is rejected without changing quota.
    await expect(mismatchedReservation).resolves.toMatchObject({
      ok: false,
      reason: "duplicate_idempotency_key",
      requestId: "req-1",
    });
  });
});
