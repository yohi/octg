import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { QuotaController } from "../src/quota-controller";

describe("QuotaController CPU-gate singleton slot", () => {
  it("claims once across pool/day quota identities and rejects quota RPCs on the singleton", async () => {
    // Given: the environment-local CPU-gate singleton and a quota identity.
    const name = `cpu-gate-slot:v1:${env.OCTG_RELAY_ENVIRONMENT}`;
    const slot: DurableObjectStub<QuotaController> = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(name));
    const owner = { pool: "STANDARD" as const, requestId: "req_00000000000000000000000000" };
    const second = { pool: "MINI" as const, requestId: "req_00000000000000000000000001" };

    // When: distinct owners claim concurrently.
    const claims = await Promise.all([
      slot.claimRelayCpuGateSlot(owner),
      slot.claimRelayCpuGateSlot(second),
    ]);

    // Then: exactly one durable owner is claimed and quota RPCs are guarded.
    expect(claims.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((result) => result.kind === "busy")).toHaveLength(1);
    const held = await slot.getRelayCpuGateSlot();
    expect(held.kind).toBe("held");
    if (held.kind !== "held") throw new Error("expected held slot");
    const closed = await slot.closeRelayCpuGateSlot(held.owner, held.generation);
    expect(closed).toEqual({ kind: "closed" });
    expect(await slot.getRelayCpuGateSlot()).toEqual({ kind: "idle" });
    expect(await runInDurableObject(slot, (_instance, state) => state.storage.get("pool"))).toBeUndefined();
  });
});
