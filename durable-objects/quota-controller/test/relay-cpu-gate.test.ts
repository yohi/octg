import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RequestEntry } from "@octg/shared";
import type { QuotaController } from "../src/quota-controller";
import { resolveMaxInFlightRequests } from "../src/relay-config";
import { getRelayCpuGateSnapshot } from "../src/relay-cpu-gate";
import { nonce, quotaController, requestId } from "./relay-test-helpers";
import { fixturePredicateMutations } from "./relay-cpu-gate-predicate-mutations";

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
    expect(snapshot).toEqual({
      version: 1,
      pool: "STANDARD",
      utcDay: "2026-09-20",
      limit: Number(env.QUOTA_LIMIT_STANDARD),
      remaining: Number(env.QUOTA_LIMIT_STANDARD),
      confirmedTokens: 0,
      reservedTokens: 0,
      uncertainTokens: 0,
      requestCount: 0,
      unresolvedReservedCount: 0,
      unresolvedUncertainCount: 0,
      activeLeaseCount: 0,
      maxInFlight: Number(env.MAX_IN_FLIGHT_REQUESTS),
    });
    expect(await storageKeys(controller)).toEqual(before);
    expect(snapshot.maxInFlight).toBe(Number(env.MAX_IN_FLIGHT_REQUESTS));
    expect(resolveMaxInFlightRequests(undefined)).toBe(2);
    const defaultSnapshot = await runInDurableObject(controller, (_instance, state) =>
      getRelayCpuGateSnapshot(state.storage, {}, { pool: "STANDARD", utcDay: "2026-09-20" }, Date.now()),
    );
    expect(defaultSnapshot).toEqual({
      version: 1,
      pool: "STANDARD",
      utcDay: "2026-09-20",
      limit: 1_000_000,
      remaining: 1_000_000,
      confirmedTokens: 0,
      reservedTokens: 0,
      uncertainTokens: 0,
      requestCount: 0,
      unresolvedReservedCount: 0,
      unresolvedUncertainCount: 0,
      activeLeaseCount: 0,
      maxInFlight: 2,
    });
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

  it("reports a never-seen request as absent when no fence exists", async () => {
    // Given: a request ID with no entry, grant or fence.
    const controller = quotaController("2026-09-29");
    const id = requestId(12);

    // When: the request is inspected.
    const inspection = await controller.getRelayCpuGateGrantInspection(id);

    // Then: inspection reports absent without claiming a fence.
    expect(inspection).toEqual({ kind: "absent", cpuGateFixture: false, fenced: false });
  });

  it("rejects admission when a concurrent fence transaction commits first", async () => {
    // Given: a valid admission and an absent request ID.
    const controller = quotaController("2026-09-30");
    const id = requestId(13);
    const issuedAtMs = Date.now();
    const admission = {
      context: {
        version: 1 as const,
        audience: "octg-deno-relay" as const,
        environment: "preview" as const,
        route: "responses" as const,
        requestId: id,
        clientId: "ordinary-client",
        idempotencyKeyHash: null,
        nonce: nonce(13),
        issuedAtMs,
        expiresAtMs: issuedAtMs + 60_000,
      },
      metadata: {
        model: "gpt-5-test",
        estimatedInputTokens: 1,
        maxOutputTokens: 1,
        inputBytes: 1,
        rawBodyBytes: 1,
        isToolUse: false,
        stream: false,
      },
      reservedTokens: 1,
      upperBoundTokens: 1,
      maxOutputTokens: 1,
      cacheEnabled: false,
    };

    // When: fence and admission transactions are started concurrently in that order.
    const fencePromise = controller.fenceRelayCpuGateSetup(id);
    const admissionPromise = controller.admitRelay(admission);
    const [fence, result] = await Promise.all([fencePromise, admissionPromise]);

    // Then: admission observes the committed fence and fails closed.
    expect(fence).toEqual({ kind: "fenced" });
    expect(result).toEqual({ kind: "denied", code: "invalid_context" });
  });

  it("rejects each canonical fixture predicate mismatch independently", async () => {
    // Given: a complete canonical CPU-gate fixture with grant and request records.
    const controller = quotaController("2026-10-01");
    const id = requestId(14);
    const admitted = await controller.admitRelay({
      ...{
        context: {
          version: 1 as const,
          audience: "octg-deno-relay" as const,
          environment: "preview" as const,
          route: "responses" as const,
          requestId: id,
          clientId: "cpu-gate-standard-client",
          idempotencyKeyHash: null,
          nonce: nonce(14),
          issuedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
        metadata: {
          model: "cpu-gate-standard-model",
          estimatedInputTokens: 0,
          maxOutputTokens: 0,
          inputBytes: 0,
          rawBodyBytes: 0,
          isToolUse: false,
          stream: false,
        },
        reservedTokens: 0,
        upperBoundTokens: 0,
        maxOutputTokens: 0,
        cacheEnabled: false,
      },
    });
    if (admitted.kind !== "admitted") throw new Error("expected canonical fixture admission");
    const canonicalGrant = admitted.grant;
    const canonicalEntry = await runInDurableObject(controller, (_instance, state) =>
      state.storage.get<RequestEntry>(`req:${id}`),
    );
    if (canonicalEntry === undefined) throw new Error("expected canonical request entry");
    const mutations = fixturePredicateMutations(canonicalGrant, canonicalEntry);

    // When: each canonical fact is changed independently and inspection runs.
    for (const mutation of mutations) {
      const altered = mutation.change({ grant: canonicalGrant, entry: canonicalEntry });
      await runInDurableObject(controller, async (_instance, state) => {
        if (altered.grant === undefined) await state.storage.delete(`relay-grant:${id}`);
        else await state.storage.put(`relay-grant:${id}`, altered.grant);
        if (altered.entry === undefined) await state.storage.delete(`req:${id}`);
        else await state.storage.put(`req:${id}`, altered.entry);
      });
      const inspection = await controller.getRelayCpuGateGrantInspection(id);
      expect(inspection, mutation.name).toEqual({ kind: "non_fixture", cpuGateFixture: false });
      await runInDurableObject(controller, async (_instance, state) => {
        await state.storage.put(`relay-grant:${id}`, canonicalGrant);
        await state.storage.put(`req:${id}`, canonicalEntry);
      });
    }
  });
});
