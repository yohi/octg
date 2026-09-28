import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RelayTerminalV1 } from "@octg/shared";
import { admitRelayInTransaction } from "../src/relay-admission";
import type { RelayAdmissionInput } from "../src/relay-admission";
import { activateRelayInTransaction } from "../src/relay-grant-lifecycle";
import type { QuotaController } from "../src/quota-controller";
import type { RelayGrant, RelayGrantBinding } from "../src/relay-grant";

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const stub = (day: string): DurableObjectStub<QuotaController> =>
  env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));

function requestId(seed: number): string {
  let body = "";
  for (let i = 0; i < 26; i += 1) body += ID_ALPHABET[(seed * 7 + i * 3) % 32];
  return `req_${body}`;
}

function nonce(seed: number): string {
  return `n${String(seed)}`.padEnd(43, "x");
}

function admissionInput(seed: number): RelayAdmissionInput {
  return {
    context: {
      version: 1,
      audience: "octg-deno-relay",
      environment: "preview",
      route: "responses",
      requestId: requestId(seed),
      clientId: "client-a",
      idempotencyKeyHash: null,
      nonce: nonce(seed),
      issuedAtMs: 1_791_000_000_000,
      expiresAtMs: 1_791_000_060_000,
    },
    metadata: {
      model: "gpt-5-test",
      estimatedInputTokens: 100,
      maxOutputTokens: 200,
      inputBytes: 512,
      rawBodyBytes: 600,
      isToolUse: false,
      stream: false,
    },
    reservedTokens: 300,
    upperBoundTokens: 300,
    maxOutputTokens: 200,
    cacheEnabled: false,
  };
}

const identityOf = (day: string) => ({ pool: "STANDARD" as const, utcDay: day });

async function admit(
  controller: DurableObjectStub<QuotaController>,
  seed: number,
  day: string,
): Promise<RelayGrant> {
  const result = await controller.admitRelay(admissionInput(seed));
  if (result.kind !== "admitted") throw new Error(`expected admitted on ${day}, got ${result.kind}`);
  return result.grant;
}

/** The DO environment mirrored from wrangler vars and the vitest binding. */
const TEST_DO_ENV = {
  QUOTA_LIMIT_STANDARD: "1000000",
  QUOTA_LIMIT_MINI: "9950000",
  MAX_IN_FLIGHT_REQUESTS: "3",
  OCTG_RELAY_ENVIRONMENT: "preview",
} as const;

/** Admits (and optionally activates) with a simulated DO clock for expiry tests. */
async function admitWithClock(
  controller: DurableObjectStub<QuotaController>,
  seed: number,
  day: string,
  nowMs: number,
  withActivation = false,
): Promise<RelayGrant> {
  return runInDurableObject(controller, (_instance, state) =>
    state.storage.transaction(async (storage) => {
      const admitted = await admitRelayInTransaction(
        storage,
        TEST_DO_ENV,
        identityOf(day),
        admissionInput(seed),
        nowMs,
      );
      if (admitted.kind !== "admitted") throw new Error(`expected admitted, got ${admitted.kind}`);
      if (!withActivation) return admitted.grant;
      const activated = await activateRelayInTransaction(
        { storage, env: TEST_DO_ENV, identity: identityOf(day), nowMs },
        grantBinding(admitted.grant),
      );
      if (activated.kind !== "activated") throw new Error(`expected activated, got ${activated.kind}`);
      return activated.grant;
    }));
}

function grantBinding(grant: RelayGrant, overrides: Partial<RelayGrantBinding> = {}): RelayGrantBinding {
  return {
    requestId: grant.requestId,
    grantId: grant.grantId,
    leaseGeneration: grant.leaseGeneration,
    claims: {
      version: 1,
      audience: "octg-worker-relay",
      environment: grant.environment,
      route: "responses",
      requestId: grant.requestId,
      grantId: grant.grantId,
      nonce: grant.nonce,
      clientId: grant.clientId,
      idempotencyKeyHash: grant.idempotencyKeyHash,
      model: grant.model,
      pool: grant.pool,
      admissionUtcDay: grant.admissionUtcDay,
      leaseGeneration: grant.leaseGeneration,
      issuedAtMs: grant.issuedAtMs,
      expiresAtMs: grant.credentialExpiresAtMs,
    },
    ...overrides,
  };
}

function terminalReport(
  grant: RelayGrant,
  outcome: RelayTerminalV1["outcome"],
  totalTokens: number | null,
): RelayTerminalV1 {
  return { version: 1, grantId: grant.grantId, leaseGeneration: grant.leaseGeneration, outcome, totalTokens };
}

async function readGrant(
  controller: DurableObjectStub<QuotaController>,
  grant: RelayGrant,
): Promise<RelayGrant | undefined> {
  return runInDurableObject(controller, (_instance, state) =>
    state.storage.get<RelayGrant>(`relay-grant:${grant.requestId}`));
}

async function readPool(controller: DurableObjectStub<QuotaController>): Promise<Record<string, number>> {
  const pool = await runInDurableObject(controller, (_instance, state) =>
    state.storage.get<Record<string, number>>("pool"));
  if (!pool) throw new Error("expected pool state");
  return pool;
}

async function readLeases(
  controller: DurableObjectStub<QuotaController>,
): Promise<Array<{ requestId: string; generation: string; expiresAtMs: number }>> {
  const inFlight = await runInDurableObject(controller, (_instance, state) =>
    state.storage.get<{ leases: Array<{ requestId: string; generation: string; expiresAtMs: number }> }>("in_flight"));
  return inFlight?.leases ?? [];
}

async function activate(
  controller: DurableObjectStub<QuotaController>,
  grant: RelayGrant,
): Promise<void> {
  const result = await controller.activateRelay(grantBinding(grant));
  if (result.kind !== "activated") throw new Error(`expected activated, got ${result.kind}`);
}

describe("QuotaController.activateRelay", () => {
  it("activates exactly once under concurrent double activation", async () => {
    // Given: one admitted authorized grant.
    const controller = stub("2026-09-20");
    const grant = await admit(controller, 1, "2026-09-20");

    // When: activation is attempted twice concurrently.
    const [first, second] = await Promise.all([
      controller.activateRelay(grantBinding(grant)),
      controller.activateRelay(grantBinding(grant)),
    ]);

    // Then: exactly one activates and the other is a replay denial.
    const activated = [first, second].filter((r) => r.kind === "activated");
    const replayed = [first, second].filter((r) => r.kind === "denied" && r.code === "grant_replayed");
    expect(activated).toHaveLength(1);
    expect(replayed).toHaveLength(1);
    const stored = await readGrant(controller, grant);
    expect(stored?.state).toBe("attempted");
  });

  it("denies activation when immutable claims do not match the stored grant", async () => {
    // Given: an admitted grant.
    const controller = stub("2026-09-21");
    const grant = await admit(controller, 1, "2026-09-21");

    // When: activation presents a tampered pool claim.
    const binding = grantBinding(grant);
    const wrongPool = await controller.activateRelay({
      ...binding,
      claims: { ...binding.claims, pool: "MINI" },
    });

    // Then: the binding mismatch denies without transitioning state.
    expect(wrongPool).toEqual({ kind: "denied", code: "grant_not_found" });
    expect((await readGrant(controller, grant))?.state).toBe("authorized");
  });

  it("denies activation for an unknown grant", async () => {
    // Given: an admitted grant used only as a claim template.
    const controller = stub("2026-09-22");
    const grant = await admit(controller, 1, "2026-09-22");

    // When: activation references a request that was never admitted.
    const phantom = grantBinding({
      ...grant,
      requestId: requestId(99),
      grantId: "00000000-0000-4000-8000-000000000099",
      leaseGeneration: "00000000-0000-4000-8000-000000000098",
    });

    // Then: the activation is denied grant_not_found.
    expect(await controller.activateRelay(phantom)).toEqual({ kind: "denied", code: "grant_not_found" });
  });

  it("releases an expired authorized grant atomically and denies activation", async () => {
    // Given: a grant admitted just past its authorization expiry with a live credential.
    const controller = stub("2026-09-23");
    const grant = await admitWithClock(controller, 1, "2026-09-23", Date.now() - 3_650_000);

    // When: activation arrives late.
    const result = await controller.activateRelay(grantBinding(grant));

    // Then: the grant is released with reservation and lease, and activation is denied.
    expect(result).toEqual({ kind: "denied", code: "grant_expired" });
    expect((await readGrant(controller, grant))?.state).toBe("released");
    const pool = await readPool(controller);
    expect(pool).toMatchObject({ reservedTokens: 0, uncertainTokens: 0 });
    expect(await readLeases(controller)).toHaveLength(0);
  });
});

describe("QuotaController.renewRelay", () => {
  it("extends the lease by exactly the relay TTL for a live attempted grant", async () => {
    // Given: an activated grant with a live lease.
    const controller = stub("2026-09-24");
    const grant = await admit(controller, 1, "2026-09-24");
    await activate(controller, grant);
    const before = Date.now();

    // When: the upstream renewal callback arrives.
    const result = await controller.renewRelay(grantBinding(grant));

    // Then: the lease is extended by 120,000 ms from the transaction time.
    if (result.kind !== "renewed") throw new Error(`expected renewed, got ${result.kind}`);
    expect(result.leaseExpiresAtMs - before).toBeGreaterThanOrEqual(119_000);
    expect(result.leaseExpiresAtMs - before).toBeLessThanOrEqual(120_500);
    const lease = (await readLeases(controller)).find((l) => l.requestId === grant.requestId);
    expect(lease?.expiresAtMs).toBe(result.leaseExpiresAtMs);
    expect((await readGrant(controller, grant))?.state).toBe("attempted");
  });

  it("denies renewal with a stale lease generation binding", async () => {
    // Given: an activated grant.
    const controller = stub("2026-09-25");
    const grant = await admit(controller, 1, "2026-09-25");
    await activate(controller, grant);

    // When: renewal presents a different lease generation in the binding and claims.
    const stale = grantBinding(grant, {
      leaseGeneration: "00000000-0000-4000-8000-000000000001",
      claims: { ...grantBinding(grant).claims, leaseGeneration: "00000000-0000-4000-8000-000000000001" },
    });
    const result = await controller.renewRelay(stale);

    // Then: the binding mismatch denies.
    expect(result).toEqual({ kind: "denied", code: "grant_not_found" });
  });

  it("denies renewal when the live lease is gone", async () => {
    // Given: an activated grant whose concurrency lease expired.
    const controller = stub("2026-09-26");
    const grant = await admit(controller, 1, "2026-09-26");
    await activate(controller, grant);
    await runInDurableObject(controller, (_instance, state) =>
      state.storage.put("in_flight", {
        version: 1,
        leases: [{ requestId: grant.requestId, generation: grant.leaseGeneration, expiresAtMs: Date.now() - 1_000 }],
      }));

    // When: renewal arrives after the lease expired.
    const result = await controller.renewRelay(grantBinding(grant));

    // Then: the lease is lost and the reservation is retained.
    expect(result).toEqual({ kind: "denied", code: "lease_lost" });
    expect(await readPool(controller)).toMatchObject({ reservedTokens: 300 });
  });

  it("denies renewal before activation", async () => {
    // Given: an admitted but not activated grant.
    const controller = stub("2026-09-27");
    const grant = await admit(controller, 1, "2026-09-27");

    // When: a renewal arrives for the authorized grant.
    const result = await controller.renewRelay(grantBinding(grant));

    // Then: the protocol violation is denied.
    expect(result).toEqual({ kind: "denied", code: "invalid_request" });
  });

  it("transitions an expired attempted grant to uncertain and retains the reservation", async () => {
    // Given: an activated grant whose authorization expired on the simulated clock.
    const controller = stub("2026-09-28");
    const grant = await admitWithClock(controller, 1, "2026-09-28", Date.now() - 3_700_000, true);

    // When: a renewal observes the expired attempted grant.
    const result = await controller.renewRelay(grantBinding(grant));

    // Then: the grant becomes uncertain, the lease is released, and quota is retained.
    expect(result).toEqual({ kind: "denied", code: "grant_expired" });
    expect((await readGrant(controller, grant))?.state).toBe("uncertain");
    expect(await readPool(controller)).toMatchObject({ reservedTokens: 0, uncertainTokens: 300 });
    expect(await readLeases(controller)).toHaveLength(0);
  });

  it("denies renewal after reconciliation terminalization", async () => {
    // Given: an activated grant whose quota was reconciled as consumed.
    const controller = stub("2026-09-29");
    const grant = await admit(controller, 1, "2026-09-29");
    await activate(controller, grant);
    await controller.reconcileRequest(grant.requestId, "consumed");

    // When: a late renewal arrives.
    const result = await controller.renewRelay(grantBinding(grant));

    // Then: the terminalized grant denies renewal.
    expect(result).toEqual({ kind: "denied", code: "grant_terminalized" });
  });
});

describe("QuotaController.finishRelay", () => {
  it("settles an attempted grant atomically with quota, terminal state and lease release", async () => {
    // Given: an activated grant.
    const controller = stub("2026-09-30");
    const grant = await admit(controller, 1, "2026-09-30");
    await activate(controller, grant);

    // When: the terminal settle report arrives.
    const result = await controller.finishRelay({
      ...grantBinding(grant),
      report: terminalReport(grant, "settle", 123),
      reportFingerprint: "fp-settle-1",
    });

    // Then: quota settles, the grant is terminal, and the lease is released.
    if (result.kind !== "accepted") throw new Error(`expected accepted, got ${result.kind}`);
    expect(result.grant.state).toBe("settled");
    expect(result.quota).toMatchObject({ state: "settled", actualTokens: 123 });
    expect(await readPool(controller)).toMatchObject({ confirmedTokens: 123, reservedTokens: 0 });
    expect(await readLeases(controller)).toHaveLength(0);
    expect((await readGrant(controller, grant))?.terminalFingerprint).toBe("fp-settle-1");
  });

  it("releases an authorized grant for a proven pre-activation failure", async () => {
    // Given: an admitted grant that never activated.
    const controller = stub("2026-10-01");
    const grant = await admit(controller, 1, "2026-10-01");

    // When: the terminal release report arrives.
    const result = await controller.finishRelay({
      ...grantBinding(grant),
      report: terminalReport(grant, "release", null),
      reportFingerprint: "fp-release-1",
    });

    // Then: the reservation is released and the lease is removed.
    if (result.kind !== "accepted") throw new Error(`expected accepted, got ${result.kind}`);
    expect(result.grant.state).toBe("released");
    expect(await readPool(controller)).toMatchObject({ reservedTokens: 0 });
    expect(await readLeases(controller)).toHaveLength(0);
  });

  it("marks an authorized grant uncertain while retaining the reservation", async () => {
    // Given: an admitted grant with an unconfirmed activation result.
    const controller = stub("2026-10-02");
    const grant = await admit(controller, 1, "2026-10-02");

    // When: the terminal uncertain report arrives.
    const result = await controller.finishRelay({
      ...grantBinding(grant),
      report: terminalReport(grant, "uncertain", null),
      reportFingerprint: "fp-uncertain-1",
    });

    // Then: the reservation moves to uncertain and the lease is released.
    if (result.kind !== "accepted") throw new Error(`expected accepted, got ${result.kind}`);
    expect(result.grant.state).toBe("uncertain");
    expect(await readPool(controller)).toMatchObject({ reservedTokens: 0, uncertainTokens: 300 });
    expect(await readLeases(controller)).toHaveLength(0);
  });

  it("denies release after activation without mutating quota", async () => {
    // Given: an activated grant.
    const controller = stub("2026-10-03");
    const grant = await admit(controller, 1, "2026-10-03");
    await activate(controller, grant);

    // When: a release report arrives post-activation.
    const result = await controller.finishRelay({
      ...grantBinding(grant),
      report: terminalReport(grant, "release", null),
      reportFingerprint: "fp-release-2",
    });

    // Then: the illegal release is denied and the reservation stays.
    expect(result).toEqual({ kind: "denied", code: "invalid_request" });
    expect((await readGrant(controller, grant))?.state).toBe("attempted");
    expect(await readPool(controller)).toMatchObject({ reservedTokens: 300 });
    expect(await readLeases(controller)).toHaveLength(1);
  });

  it("replays the saved terminal result for the exact report and rejects conflicts", async () => {
    // Given: a settled grant.
    const controller = stub("2026-10-04");
    const grant = await admit(controller, 1, "2026-10-04");
    await activate(controller, grant);
    const report = terminalReport(grant, "settle", 123);
    const first = await controller.finishRelay({ ...grantBinding(grant), report, reportFingerprint: "fp-1" });
    if (first.kind !== "accepted") throw new Error("expected accepted");

    // When: the identical report replays, then a conflicting report arrives.
    const replay = await controller.finishRelay({ ...grantBinding(grant), report, reportFingerprint: "fp-1" });
    const conflict = await controller.finishRelay({
      ...grantBinding(grant),
      report: terminalReport(grant, "settle", 999),
      reportFingerprint: "fp-2",
    });

    // Then: the exact replay returns the saved result and the conflict fails closed.
    if (replay.kind !== "accepted") throw new Error("expected accepted");
    expect(replay.grant.state).toBe("settled");
    expect(replay.quota).toMatchObject({ actualTokens: 123 });
    expect(conflict).toEqual({ kind: "denied", code: "grant_terminalized" });
    expect(await readPool(controller)).toMatchObject({ confirmedTokens: 123 });
  });

  it("settles an uncertain entry from a trustworthy late report during the credential grace", async () => {
    // Given: an activated grant whose authorization expired on the simulated clock.
    const controller = stub("2026-10-05");
    const grant = await admitWithClock(controller, 1, "2026-10-05", Date.now() - 3_700_000, true);

    // When: a late settle report arrives while the credential is still valid.
    const result = await controller.finishRelay({
      ...grantBinding(grant),
      report: terminalReport(grant, "settle", 77),
      reportFingerprint: "fp-late-1",
    });

    // Then: the uncertain entry settles.
    if (result.kind !== "accepted") throw new Error(`expected accepted, got ${result.kind}`);
    expect(result.grant.state).toBe("settled");
    expect(await readPool(controller)).toMatchObject({ confirmedTokens: 77, uncertainTokens: 0 });
  });

  it("rejects all callbacks after credential expiry", async () => {
    // Given: a grant admitted after its credential already expired.
    const controller = stub("2026-10-06");
    const grant = await admitWithClock(controller, 1, "2026-10-06", Date.now() - 3_950_000);

    // When: a terminal report arrives after credential expiry.
    const result = await controller.finishRelay({
      ...grantBinding(grant),
      report: terminalReport(grant, "settle", 5),
      reportFingerprint: "fp-expired-1",
    });

    // Then: the report is denied and quota is untouched.
    expect(result).toEqual({ kind: "denied", code: "grant_expired" });
    expect(await readPool(controller)).toMatchObject({ reservedTokens: 300, confirmedTokens: 0 });
  });

  it("denies a production credential at the preview-bound callback boundary", async () => {
    // Given: a preview-bound DO holding an authorized grant.
    const controller = stub("2026-10-08");
    const grant = await admit(controller, 1, "2026-10-08");
    const binding = grantBinding(grant);

    // When: activation and terminal callbacks present production claims.
    const activation = await controller.activateRelay({
      ...binding,
      claims: { ...binding.claims, environment: "production" },
    });
    const terminal = await controller.finishRelay({
      ...binding,
      claims: { ...binding.claims, environment: "production" },
      report: terminalReport(grant, "release", null),
      reportFingerprint: "fp-foreign-env",
    });

    // Then: the cross-environment credential is rejected and nothing changed.
    expect(activation).toEqual({ kind: "denied", code: "grant_not_found" });
    expect(terminal).toEqual({ kind: "denied", code: "grant_not_found" });
    expect((await readGrant(controller, grant))?.state).toBe("authorized");
    expect(await readLeases(controller)).toHaveLength(1);
  });

  it("records the 45-day retention deadline at the admission day end", async () => {
    // Given: a grant admitted on a fixed UTC day.
    const controller = stub("2026-10-08");

    // When: the grant is admitted.
    const grant = await admit(controller, 1, "2026-10-08");

    // Then: retention expires 45 days after the admission day ends.
    expect(grant.retentionDeadlineMs).toBe(
      Date.parse("2026-10-09T00:00:00Z") + 45 * 24 * 60 * 60 * 1000,
    );
  });

  it("blocks day finalization while a relay grant is unresolved", async () => {
    // Given: an authorized grant holding a reservation.
    const controller = stub("2026-10-09");
    const grant = await admit(controller, 1, "2026-10-09");

    // When: the day finalization runs before the grant resolves.
    const finalizeResult = await controller.finalizeDay();

    // Then: finalization is refused and the grant remains in place.
    expect(finalizeResult).toEqual({
      ok: false,
      reason: "reserved_remaining",
      uncertainCount: 0,
      reservedCount: 1,
    });
    expect((await readGrant(controller, grant))?.state).toBe("authorized");
  });

  it("removes the settled relay grant with the day at finalization", async () => {
    // Given: a settled grant with no remaining unresolved quota.
    const controller = stub("2026-10-10");
    const grant = await admit(controller, 1, "2026-10-10");
    await activate(controller, grant);
    const settled = await controller.finishRelay({
      ...grantBinding(grant),
      report: terminalReport(grant, "settle", 10),
      reportFingerprint: "fp-retention-1",
    });
    expect(settled.kind).toBe("accepted");

    // When: the day finalization runs after settlement.
    const finalizeResult = await controller.finalizeDay();

    // Then: the terminal grant is removed with the day's state.
    expect(finalizeResult).toEqual({ ok: true, deleted: true });
    expect(await readGrant(controller, grant)).toBeUndefined();
  });

  it("terminalizes the grant during reconciliation and rejects late reports", async () => {
    // Given: an activated grant.
    const controller = stub("2026-10-07");
    const grant = await admit(controller, 1, "2026-10-07");
    await activate(controller, grant);

    // When: next-day reconciliation consumes the reservation.
    const reconcile = await controller.reconcileRequest(grant.requestId, "consumed");

    // Then: the grant terminalizes to reconciled_consumed with the disposition fingerprint.
    expect(reconcile).toEqual({ ok: true, applied: true });
    const stored = await readGrant(controller, grant);
    expect(stored?.state).toBe("reconciled_consumed");
    expect(stored?.terminalFingerprint).toBe("consumed");
    expect(await readLeases(controller)).toHaveLength(0);
    expect(await readPool(controller)).toMatchObject({ confirmedTokens: 300, reservedTokens: 0 });

    // When: an otherwise identical late terminal report arrives.
    const lateReport = await controller.finishRelay({
      ...grantBinding(grant),
      report: terminalReport(grant, "settle", 300),
      reportFingerprint: "fp-late-report",
    });

    // Then: the late report cannot alter quota.
    expect(lateReport).toEqual({ kind: "denied", code: "grant_terminalized" });
    expect(await readPool(controller)).toMatchObject({ confirmedTokens: 300 });
  });
});
