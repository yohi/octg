import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const stub = (pool = "STANDARD", day = "2026-08-09") =>
  env.QUOTA_CONTROLLER.get(
    env.QUOTA_CONTROLLER.idFromName(`quota:${pool}:${day}`),
  );

describe("QuotaController.reserve policy tiers", () => {
  it("rejects in STRICT when upperBoundTokens exceeds remaining", async () => {
    // Given: a STANDARD pool in STRICT with 49,000 tokens remaining.
    const controller = stub("STANDARD", "2026-08-20");
    await controller.reserve("seed", 951_000, 951_000);

    // When: the immediate reservation fits but its upper bound does not.
    const result = await controller.reserve("req-strict", 10_000, 60_000);

    // Then: the conservative STRICT gate rejects the request.
    expect(result.ok).toBe(false);
  });

  it("permits in STRICT when upperBoundTokens does not exceed remaining", async () => {
    // Given: a STANDARD pool in STRICT with 49,000 tokens remaining.
    const controller = stub("STANDARD", "2026-08-21");
    await controller.reserve("seed", 951_000, 951_000);

    // When: the immediate reservation and its upper bound fit.
    const result = await controller.reserve("req-strict-ok", 10_000, 49_000);

    // Then: the reservation succeeds.
    expect(result.ok).toBe(true);
  });

  it("does not apply the STRICT upper-bound gate in CAUTION", async () => {
    // Given: a STANDARD pool in CAUTION with 150,000 tokens remaining.
    const controller = stub("STANDARD", "2026-08-22");
    await controller.reserve("seed", 850_000, 850_000);

    // When: a reservation fits although its upper bound exceeds remaining.
    const result = await controller.reserve("req-caution", 10_000, 160_000);

    // Then: the CAUTION tier permits it without the STRICT restriction.
    expect(result.ok).toBe(true);
  });
});

describe("QuotaController.reserve concurrency", () => {
  it("permits only one 40,000-token reservation when 50,000 remains", async () => {
    // Given: a STANDARD pool with 50,000 tokens remaining.
    const controller = stub("STANDARD", "2026-08-23");
    await controller.reserve("seed", 950_000, 950_000);

    // When: two concurrent 40,000-token reservations are submitted.
    const [first, second] = await Promise.all([
      controller.reserve("req-A", 40_000, 40_000),
      controller.reserve("req-B", 40_000, 40_000),
    ]);
    const state = await controller.getState();

    // Then: one succeeds and storage contains only one additional reservation.
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(state.reservedTokens).toBe(990_000);
  });
});

describe("QuotaController.reserve UTC day boundary", () => {
  it("keeps simultaneous requests for adjacent UTC days in separate states", async () => {
    // Given: two DOs resolved from adjacent UTC dates.
    const previousDay = stub("STANDARD", "2026-08-30");
    const nextDay = stub("STANDARD", "2026-08-31");

    // When: each date receives a reservation.
    await Promise.all([
      previousDay.reserve("req-d1", 700_000, 700_000),
      nextDay.reserve("req-d2", 100_000, 100_000),
    ]);
    const [previousState, nextState] = await Promise.all([
      previousDay.getState(),
      nextDay.getState(),
    ]);

    // Then: each date retains only its own counters and remaining value.
    expect(previousState.reservedTokens).toBe(700_000);
    expect(previousState.utcDay).toBe("2026-08-30");
    expect(previousState.remaining).toBe(300_000);
    expect(nextState.reservedTokens).toBe(100_000);
    expect(nextState.utcDay).toBe("2026-08-31");
    expect(nextState.remaining).toBe(900_000);
  });
});
