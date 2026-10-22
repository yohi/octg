import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { QuotaController } from "../src/quota-controller";
import { quotaController, requestId } from "./relay-test-helpers";

async function storageKeys(controller: DurableObjectStub<QuotaController>): Promise<readonly string[]> {
  return runInDurableObject(controller, (_instance, state) =>
    state.storage.list().then((entries) => [...entries.keys()]),
  );
}

describe("QuotaController CPU-gate inspection and fencing", () => {
  it("returns canonical snapshot without writing expired-lease cleanup", async () => {
    // Given: an expired lease in canonical in-flight storage.
    const controller = quotaController("2026-09-20");
    await runInDurableObject(controller, (_instance, state) => state.storage.put("in_flight", {
      version: 1,
      leases: [{ requestId: requestId(1), generation: "g", expiresAtMs: 1 }],
    }));
    const before = await storageKeys(controller);

    // When: the read-only CPU-gate snapshot is requested.
    const snapshot = await controller.getRelayCpuGateSnapshot();

    // Then: expired leases are excluded without storage mutation.
    expect(snapshot).toMatchObject({ version: 1, pool: "STANDARD", utcDay: "2026-09-20", activeLeaseCount: 0 });
    expect(await storageKeys(controller)).toEqual(before);
    expect(snapshot.maxInFlight).toBe(Number(env.MAX_IN_FLIGHT_REQUESTS));
  });

  it("fences an absent request and rejects its delayed admission", async () => {
    // Given: an unused QuotaController and a request ID with no canonical state.
    const controller = quotaController("2026-09-21");
    const id = requestId(7);

    // When: setup is fenced before the delayed admission runs.
    const fenced = await controller.fenceRelayCpuGateSetup(id);
    const inspection = await controller.getRelayCpuGateGrantInspection(id);

    // Then: the durable fence closes admission without exposing it as a public error code.
    expect(fenced).toEqual({ kind: "fenced" });
    expect(inspection).toEqual({ kind: "absent", cpuGateFixture: false, fenced: true });
    const delayed = await controller.admitRelay({
      context: {
        version: 1,
        audience: "octg-deno-relay",
        environment: "preview",
        route: "responses",
        requestId: id,
        clientId: "client-a",
        idempotencyKeyHash: null,
        nonce: "n7".padEnd(43, "x"),
        issuedAtMs: 1_791_000_000_000,
        expiresAtMs: 1_791_000_060_000,
      },
      metadata: {
        model: "gpt-5-test", estimatedInputTokens: 100, maxOutputTokens: 200,
        inputBytes: 512, rawBodyBytes: 600, isToolUse: false, stream: false,
      },
      reservedTokens: 1,
      upperBoundTokens: 1,
      maxOutputTokens: 200,
      cacheEnabled: false,
    });
    expect(delayed).toEqual({ kind: "denied", code: "invalid_context" });
  });

  it("recognizes only the configured zero-cost fixture facts", async () => {
    // Given: a zero-cost admission matching the controller's configured fixture identity.
    const controller = quotaController("2026-09-22");
    const id = requestId(9);
    const fixtureInput = {
      context: {
        version: 1 as const, audience: "octg-deno-relay" as const, environment: "preview" as const,
        route: "responses" as const, requestId: id, clientId: "cpu-gate-standard-client",
        idempotencyKeyHash: null, nonce: "n9".padEnd(43, "x"),
        issuedAtMs: 1_791_000_000_000, expiresAtMs: 1_791_000_060_000,
      },
      metadata: {
        model: "cpu-gate-standard-model", estimatedInputTokens: 0, maxOutputTokens: 0,
        inputBytes: 0, rawBodyBytes: 0, isToolUse: false, stream: false,
      },
      reservedTokens: 0, upperBoundTokens: 0, maxOutputTokens: 0, cacheEnabled: false,
    };

    // When: the admission is inspected, then one canonical request fact is corrupted.
    const admitted = await controller.admitRelay(fixtureInput);
    const inspection = await controller.getRelayCpuGateGrantInspection(id);
    const replay = await controller.admitRelay(fixtureInput);
    const fence = await controller.fenceRelayCpuGateSetup(id);
    await controller.reconcileRequest(id, "unused");
    const terminalFence = await controller.fenceRelayCpuGateSetup(id);
    await runInDurableObject(controller, (_instance, state) =>
      state.storage.put(`req:${id}`, { state: "reserved", tokens: 0, upperBoundTokens: 0, reservedTokens: 1 }),
    );
    const mismatch = await controller.getRelayCpuGateGrantInspection(id);

    // Then: exact canonical fixture is distinguished, and any predicate mismatch is opaque.
    expect(admitted.kind).toBe("admitted");
    expect(replay).toEqual(admitted);
    expect(fence.kind).toBe("fixture");
    expect(inspection).toMatchObject({ kind: "fixture", cpuGateFixture: true, activeLease: true });
    expect(terminalFence).toMatchObject({
      kind: "fixture",
      inspection: { state: "reconciled_unused", requestState: "released", activeLease: false },
    });
    expect(mismatch).toEqual({ kind: "non_fixture", cpuGateFixture: false });
  });

  it("makes concurrent setup fences idempotent", async () => {
    // Given: an absent request observed through one QuotaController transaction domain.
    const controller = quotaController("2026-09-23");
    const id = requestId(11);

    // When: two callers fence the same ID concurrently.
    const fences = await Promise.all([
      controller.fenceRelayCpuGateSetup(id),
      controller.fenceRelayCpuGateSetup(id),
    ]);

    // Then: both callers observe fenced and only one durable fence key exists.
    expect(fences).toEqual([{ kind: "fenced" }, { kind: "fenced" }]);
    expect((await storageKeys(controller)).filter((key) => key === `cpu-gate-fence:${id}`)).toHaveLength(1);
  });
});
