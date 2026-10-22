import { env, runInDurableObject } from "cloudflare:test";
import { ulid } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import { QuotaController } from "../src/quota-controller";
import type { RelayCpuGateSlotOwner } from "@octg/shared";
import type { RelayAdmissionInput } from "../src/relay-admission";
import type { RelayGrant } from "../src/relay-grant";
import { grantBinding, nonce } from "./relay-test-helpers";

function idForDay(day: string): string {
  return `req_${ulid(Date.parse(`${day}T00:00:00Z`))}`;
}

function controllerFor(day: string): DurableObjectStub<QuotaController> {
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
}

function singleton(): DurableObjectStub<QuotaController> {
  return env.QUOTA_CONTROLLER.get(
    env.QUOTA_CONTROLLER.idFromName(`cpu-gate-slot:v1:${env.OCTG_RELAY_ENVIRONMENT}`),
  );
}

async function resetSlotStorage(): Promise<void> {
  await runInDurableObject(singleton(), (_instance, state) =>
    state.storage.transaction(async (storage) => {
      await storage.delete("cpu-gate-slot:v1:state");
      await storage.delete("cpu-gate-slot:v1:generation");
    }),
  );
}

function fixtureInput(requestId: string): RelayAdmissionInput {
  const issuedAtMs = Date.now();
  return {
    context: {
      version: 1,
      audience: "octg-deno-relay",
      environment: "preview",
      route: "responses",
      requestId,
      clientId: "cpu-gate-standard-client",
      idempotencyKeyHash: null,
      nonce: nonce(1),
      issuedAtMs,
      expiresAtMs: issuedAtMs + 60_000,
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
  };
}

async function admitFixture(controller: DurableObjectStub<QuotaController>, requestId: string): Promise<RelayGrant> {
  const result = await controller.admitRelay(fixtureInput(requestId));
  if (result.kind !== "admitted") throw new Error(`expected fixture admission, got ${result.kind}`);
  return result.grant;
}

async function claim(owner: RelayCpuGateSlotOwner): Promise<{ readonly generation: number }> {
  const result = await singleton().claimRelayCpuGateSlot(owner);
  if (result.kind !== "claimed") throw new Error("expected singleton claim");
  return { generation: result.slot.generation };
}

describe("QuotaController CPU-gate singleton slot", () => {
  beforeEach(resetSlotStorage);

  it("serializes concurrent cross-pool claims and closes a fenced-absent owner", async () => {
    // Given: the environment-local CPU-gate singleton and distinct pool owners.
    const slot = singleton();
    const owner = {
      pool: "STANDARD" as const,
      requestId: "req_00000000000000000000000000",
      extra: "must not persist",
    };
    const second = { pool: "MINI" as const, requestId: "req_00000000000000000000000001" };

    // When: both owners claim concurrently.
    const results = await Promise.all([
      slot.claimRelayCpuGateSlot(owner),
      slot.claimRelayCpuGateSlot(second),
    ]);

    // Then: one owner holds the slot, and target proof is required to close it.
    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "busy")).toHaveLength(1);
    const held = await slot.getRelayCpuGateSlot();
    expect(held.kind).toBe("held");
    if (held.kind !== "held") throw new Error("expected held slot");
    expect(Object.keys(held.owner).sort()).toEqual(["pool", "requestId"]);
    expect(await slot.closeRelayCpuGateSlot(held.owner, held.generation)).toEqual({ kind: "closed" });
    expect(await slot.getRelayCpuGateSlot()).toEqual({ kind: "idle" });
  });

  it.each(["settled", "released", "reconciled_unused"] as const)(
    "closes a terminal %s fixture",
    async (terminalState: "settled" | "released" | "reconciled_unused") => {
      // Given: a canonical fixture terminalized through its authoritative lifecycle.
      const day = "2026-09-24";
      const requestId = idForDay(day);
      const controller = controllerFor(day);
      const grant = await admitFixture(controller, requestId);
      if (terminalState === "settled") {
        await controller.activateRelay(grantBinding(grant));
        await controller.finishRelay({
          ...grantBinding(grant),
          report: {
            version: 1,
            grantId: grant.grantId,
            leaseGeneration: grant.leaseGeneration,
            outcome: "settle",
            totalTokens: 0,
          },
          reportFingerprint: "fixture-settle",
        });
      } else if (terminalState === "released") {
        await controller.finishRelay({
          ...grantBinding(grant),
          report: {
            version: 1,
            grantId: grant.grantId,
            leaseGeneration: grant.leaseGeneration,
            outcome: "release",
            totalTokens: null,
          },
          reportFingerprint: "fixture-release",
        });
      } else {
        await controller.reconcileRequest(requestId, "unused");
      }
      const owner = { pool: "STANDARD" as const, requestId };
      const { generation } = await claim(owner);

      // When: the singleton closes the terminal owner.
      const result = await singleton().closeRelayCpuGateSlot(owner, generation);

      // Then: target terminal proof permits release of the global slot.
      expect(result).toEqual({ kind: "closed" });
      expect(await singleton().getRelayCpuGateSlot()).toEqual({ kind: "idle" });
    },
  );

  it("closes a consumed-reconciliation fixture whose request state is reconciled", async () => {
    // Given: a fixture reconciled as consumed by the authoritative QuotaController.
    const day = "2026-09-25";
    const requestId = idForDay(day);
    const controller = controllerFor(day);
    await admitFixture(controller, requestId);
    await controller.reconcileRequest(requestId, "consumed");
    const owner = { pool: "STANDARD" as const, requestId };
    const { generation } = await claim(owner);

    // When: the slot verifies the terminal fixture and closes it.
    const result = await singleton().closeRelayCpuGateSlot(owner, generation);

    // Then: reconciled_consumed is accepted as a terminal request state.
    expect(result).toEqual({ kind: "closed" });
  });

  it("retains closing and blocks another owner while a live target is non-fixture", async () => {
    // Given: a normal live admission for the owner request ID.
    const day = "2026-09-26";
    const requestId = idForDay(day);
    const controller = controllerFor(day);
    const issuedAtMs = Date.now();
    const normalInput: RelayAdmissionInput = {
      context: {
        version: 1,
        audience: "octg-deno-relay",
        environment: "preview",
        route: "responses",
        requestId,
        clientId: "ordinary-client",
        idempotencyKeyHash: null,
        nonce: nonce(2),
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
    await controller.admitRelay(normalInput);
    const owner = { pool: "STANDARD" as const, requestId };
    const { generation } = await claim(owner);

    // When: close attempts to prove the target and another owner claims.
    const closeResult = await singleton().closeRelayCpuGateSlot(owner, generation);
    const other = await singleton().claimRelayCpuGateSlot({
      pool: "MINI",
      requestId: idForDay("2026-09-27"),
    });

    // Then: uncertain/non-fixture target state remains closing and blocks takeover.
    expect(closeResult).toEqual({ kind: "blocked" });
    expect(await singleton().getRelayCpuGateSlot()).toMatchObject({ kind: "closing", owner, generation });
    expect(other).toEqual({ kind: "busy" });
  });

  it("retains closing and blocks another owner while the fixture lease is active", async () => {
    // Given: a canonical live fixture with its active in-flight lease.
    const day = "2026-10-02";
    const requestId = idForDay(day);
    await admitFixture(controllerFor(day), requestId);
    const owner = { pool: "STANDARD" as const, requestId };
    const { generation } = await claim(owner);

    // When: close inspects the still-active fixture.
    const result = await singleton().closeRelayCpuGateSlot(owner, generation);
    const anotherOwner = await singleton().claimRelayCpuGateSlot({
      pool: "MINI",
      requestId: idForDay("2026-10-03"),
    });

    // Then: the live fixture retains closing and excludes a different operation.
    expect(result).toEqual({ kind: "blocked" });
    expect(await singleton().getRelayCpuGateSlot()).toMatchObject({ kind: "closing", owner, generation });
    expect(anotherOwner).toEqual({ kind: "busy" });
  });

  it("does not let a stale generation clear a newer owner and treats idle close as a no-op", async () => {
    // Given: an owner closed with target proof, followed by a different claim.
    const slot = singleton();
    const firstOwner = { pool: "STANDARD" as const, requestId: "req_00000000000000000000000000" };
    const first = await claim(firstOwner);
    expect(await slot.closeRelayCpuGateSlot(firstOwner, first.generation)).toEqual({ kind: "closed" });
    expect(await slot.closeRelayCpuGateSlot(firstOwner, first.generation)).toEqual({ kind: "closed" });
    const nextOwner = { pool: "MINI" as const, requestId: "req_00000000000000000000000001" };
    const next = await claim(nextOwner);

    // When: the old generation attempts to close after the new owner claims.
    const staleClose = await slot.closeRelayCpuGateSlot(firstOwner, first.generation);

    // Then: the stale operation cannot clear the current owner.
    expect(staleClose).toEqual({ kind: "blocked" });
    expect(await slot.getRelayCpuGateSlot()).toMatchObject({ kind: "held", owner: nextOwner, generation: next.generation });
    expect(await slot.closeRelayCpuGateSlot(nextOwner, next.generation)).toEqual({ kind: "closed" });
  });

  it("rejects quota RPCs on the singleton and slot RPCs on quota identities", async () => {
    // Given: one control identity and one ordinary quota identity.
    const slot = singleton();
    const quota = controllerFor("2026-09-28");

    // When: each identity calls methods belonging to the other RPC class.
    const controlRejected = await runInDurableObject(slot, async (instance) => {
      if (!(instance instanceof QuotaController)) throw new TypeError("unexpected Durable Object instance");
      const rejected: boolean[] = [];
      for (const invoke of [
        () => instance.getState(),
        () => instance.reserve("req_00000000000000000000000002", 0, 0),
      ]) {
        try {
          await invoke();
          rejected.push(false);
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          rejected.push(true);
        }
      }
      return rejected;
    });
    const quotaRejected = await runInDurableObject(quota, async (instance) => {
      if (!(instance instanceof QuotaController)) throw new TypeError("unexpected Durable Object instance");
      try {
        await instance.getRelayCpuGateSlot();
        return false;
      } catch (error) {
        if (error instanceof TypeError) return true;
        throw error;
      }
    });

    // Then: all cross-identity calls fail before accessing the wrong storage schema.
    expect(controlRejected).toEqual([true, true]);
    expect(quotaRejected).toBe(true);
  });

  it("rejects an out-of-range ULID timestamp without constructing a malformed quota identity", async () => {
    // Given: a syntactically valid ID whose timestamp is outside the supported UTC range.
    const owner = { pool: "STANDARD" as const, requestId: `req_7${"Z".repeat(25)}` };
    const { generation } = await claim(owner);

    // When: close derives the target day from that ID.
    const result = await singleton().closeRelayCpuGateSlot(owner, generation);

    // Then: the slot stays closing without attempting a malformed target RPC.
    expect(result).toEqual({ kind: "blocked" });
    expect(await singleton().getRelayCpuGateSlot()).toMatchObject({ kind: "closing", owner, generation });
  });
});
