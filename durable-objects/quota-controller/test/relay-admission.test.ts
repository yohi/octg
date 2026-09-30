import { POOL_LIMITS } from "@octg/shared";

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RelayContextV1, RelayRequestMetaV1 } from "@octg/shared";
import type { QuotaController } from "../src/quota-controller";
import type { RelayAdmissionInput } from "../src/relay-admission";
import type { RelayGrant } from "../src/relay-grant";
import { admitRelayInTransaction } from "../src/relay-admission";
import { grantBinding, nonce, quotaController, requestId } from "./relay-test-helpers";

const CONTEXT_ISSUED_AT_MS = 1_791_000_000_000;
function relayContext(overrides: Partial<RelayContextV1> = {}): RelayContextV1 {
  return {
    version: 1,
    audience: "octg-deno-relay",
    environment: "preview",
    route: "responses",
    requestId: requestId(1),
    clientId: "client-a",
    idempotencyKeyHash: null,
    nonce: nonce(1),
    issuedAtMs: CONTEXT_ISSUED_AT_MS,
    expiresAtMs: CONTEXT_ISSUED_AT_MS + 60_000,
    ...overrides,
  };
}

function relayMetadata(overrides: Partial<RelayRequestMetaV1> = {}): RelayRequestMetaV1 {
  return {
    model: "gpt-5-test",
    estimatedInputTokens: 100,
    maxOutputTokens: 200,
    inputBytes: 512,
    rawBodyBytes: 600,
    isToolUse: false,
    stream: false,
    ...overrides,
  };
}

function admissionInput(overrides: Partial<RelayAdmissionInput> = {}): RelayAdmissionInput {
  return {
    context: relayContext(),
    metadata: relayMetadata(),
    reservedTokens: 300,
    upperBoundTokens: 300,
    maxOutputTokens: 200,
    cacheEnabled: false,
    ...overrides,
  };
}

async function keyHash(clientId: string, rawKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = new Uint8Array([...encoder.encode(clientId), 0, ...encoder.encode(rawKey)]);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readStorage<T>(
  controller: DurableObjectStub<QuotaController>,
  key: string,
): Promise<T | undefined> {
  return runInDurableObject(controller, (_instance, state) => state.storage.get<T>(key));
}

async function listStorage<T>(
  controller: DurableObjectStub<QuotaController>,
  prefix: string,
): Promise<Map<string, T>> {
  return runInDurableObject(controller, (_instance, state) => state.storage.list<T>({ prefix }));
}

function expectUuid(value: string): void {
  expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
}

describe("QuotaController.admitRelay", () => {
  it("commits entry, counters, mapping, lease and grant in one call", async () => {
    // Given: an unused pool and an admission with an idempotency key.
    const controller = quotaController("2026-09-01");
    const hash = await keyHash("client-a", "key-1");

    // When: the Decision DO admits the request.
    const result = await controller.admitRelay(
      admissionInput({
        context: relayContext({ requestId: requestId(1), nonce: nonce(1), idempotencyKeyHash: hash }),
        rawIdempotencyKey: "key-1",
      }),
    );

    // Then: all admission records exist atomically and the grant is authorized.
    if (result.kind !== "admitted") throw new Error(`expected admitted, got ${result.kind}`);
    expectUuid(result.grant.grantId);
    expectUuid(result.grant.leaseGeneration);
    expect(result.grant).toMatchObject({
      version: 1,
      requestId: requestId(1),
      environment: "preview",
      clientId: "client-a",
      idempotencyKeyHash: hash,
      model: "gpt-5-test",
      pool: "STANDARD",
      admissionUtcDay: "2026-09-01",
      state: "authorized",
    });
    expect(result.grant.authorizationExpiresAtMs - result.grant.issuedAtMs).toBe(3_600_000);
    expect(result.grant.credentialExpiresAtMs - result.grant.issuedAtMs).toBe(3_900_000);
    expect(result.grant.retentionDeadlineMs).toBeGreaterThan(result.grant.issuedAtMs);
    expect(result.quota).toEqual({
      pool: "STANDARD",
      limit: POOL_LIMITS.STANDARD,
      used: 300,
      remaining: POOL_LIMITS.STANDARD - 300,
      resetAt: "2026-09-02T00:00:00Z",
    });

    const pool = await readStorage<Record<string, number>>(controller, "pool");
    expect(pool).toMatchObject({ reservedTokens: 300, requestCount: 1 });
    const unresolved = await readStorage<{ reservedCount: number }>(controller, "unresolved");
    expect(unresolved?.reservedCount).toBe(1);
    const entry = await readStorage<{ state: string; tokens: number }>(controller, `req:${requestId(1)}`);
    expect(entry).toMatchObject({ state: "reserved", tokens: 300 });
    const mappings = await listStorage<string>(controller, "idem:");
    expect([...mappings.values()]).toEqual([requestId(1)]);
    const inFlight = await readStorage<{ leases: Array<{ requestId: string; generation: string; expiresAtMs: number }> }>(
      controller,
      "in_flight",
    );
    const lease = inFlight?.leases.find((l) => l.requestId === requestId(1));
    expect(lease).toBeDefined();
    if (lease) {
      expect(lease.generation).toBe(result.grant.leaseGeneration);
      expect(lease.expiresAtMs).toBe(result.grant.issuedAtMs + 120_000);
    }
    const grantRecord = await readStorage<RelayGrant>(controller, `relay-grant:${requestId(1)}`);
    expect(grantRecord?.grantId).toBe(result.grant.grantId);
    expect(grantRecord?.admission).toMatchObject({ reservedTokens: 300, upperBoundTokens: 300, cacheEnabled: false });
  });

  it("denies quota exhaustion without writing any admission state", async () => {
    // Given: a pool that cannot fit the reservation.
    const controller = quotaController("2026-09-02");

    // When: the reservation exceeds the remaining quota.
    const result = await controller.admitRelay(admissionInput({ reservedTokens: 2_000_000, upperBoundTokens: 2_000_000 }));

    // Then: the denial carries insufficient_quota and nothing was written.
    expect(result).toEqual({ kind: "denied", code: "insufficient_quota" });
    expect(await readStorage(controller, "pool")).toBeUndefined();
    expect(await readStorage(controller, `relay-grant:${requestId(1)}`)).toBeUndefined();
    expect(await readStorage(controller, "in_flight")).toBeUndefined();
    expect((await listStorage(controller, "req:")).size).toBe(0);
    expect((await listStorage(controller, "idem:")).size).toBe(0);
  });

  it("denies concurrency exhaustion without writing admission state", async () => {
    // Given: the in-flight pool is already at the configured limit of three.
    const controller = quotaController("2026-09-03");
    for (const seed of [1, 2, 3]) {
      const admitted = await controller.admitRelay(admissionInput({ context: relayContext({ requestId: requestId(seed), nonce: nonce(seed) }) }));
      expect(admitted.kind).toBe("admitted");
    }

    // When: a fourth request is admitted.
    const result = await controller.admitRelay(admissionInput({ context: relayContext({ requestId: requestId(4), nonce: nonce(4) }) }));

    // Then: the denial carries worker_concurrency_exceeded and no fourth record exists.
    expect(result).toEqual({ kind: "denied", code: "worker_concurrency_exceeded" });
    expect((await listStorage(controller, "req:")).size).toBe(3);
    expect(await readStorage(controller, `relay-grant:${requestId(4)}`)).toBeUndefined();
    const inFlight = await readStorage<{ leases: unknown[] }>(controller, "in_flight");
    expect(inFlight?.leases).toHaveLength(3);
  });

  it("returns the saved authorized admission for an exact replay", async () => {
    // Given: one admitted request.
    const controller = quotaController("2026-09-04");
    const input = admissionInput({ context: relayContext({ requestId: requestId(1), nonce: nonce(1) }) });
    const first = await controller.admitRelay(input);
    if (first.kind !== "admitted") throw new Error("expected admitted");

    // When: the identical admission is retried after a lost acknowledgement.
    const replay = await controller.admitRelay(input);

    // Then: the same grant is returned and quota is counted once.
    if (replay.kind !== "admitted") throw new Error("expected admitted");
    expect(replay.grant).toEqual(first.grant);
    expect(replay.quota.used).toBe(300);
    const pool = await readStorage<Record<string, number>>(controller, "pool");
    expect(pool).toMatchObject({ reservedTokens: 300, requestCount: 1 });
  });

  it("denies an exact replay once the grant is attempted", async () => {
    // Given: an admitted request whose grant was activated.
    const controller = quotaController("2026-09-05");
    const input = admissionInput({ context: relayContext({ requestId: requestId(1), nonce: nonce(1) }) });
    const first = await controller.admitRelay(input);
    if (first.kind !== "admitted") throw new Error("expected admitted");
    const grant: RelayGrant = first.grant;
    const activation = await controller.activateRelay(grantBinding(grant));
    expect(activation.kind).toBe("activated");

    // When: the same decision is replayed after activation.
    const replay = await controller.admitRelay(input);

    // Then: no second allow is produced.
    expect(replay).toEqual({ kind: "denied", code: "grant_replayed" });
  });

  it("rejects a conflicting replay with different reservation bounds", async () => {
    // Given: one admitted request.
    const controller = quotaController("2026-09-06");
    await controller.admitRelay(admissionInput({ context: relayContext({ requestId: requestId(1), nonce: nonce(1) }) }));

    // When: the same request ID replays with a different token budget.
    const replay = await controller.admitRelay(
      admissionInput({
        context: relayContext({ requestId: requestId(1), nonce: nonce(1) }),
        reservedTokens: 301,
        upperBoundTokens: 301,
      }),
    );

    // Then: the conflicting replay is rejected and state is unchanged.
    expect(replay).toEqual({ kind: "denied", code: "invalid_request" });
    const pool = await readStorage<Record<string, number>>(controller, "pool");
    expect(pool).toMatchObject({ reservedTokens: 300, requestCount: 1 });
  });

  it("rejects a different request ID with the same raw key while the mapped entry is active", async () => {
    // Given: request A admitted with idempotency key.
    const controller = quotaController("2026-09-07");
    const hash = await keyHash("client-a", "key-1");
    await controller.admitRelay(
      admissionInput({ context: relayContext({ requestId: requestId(1), nonce: nonce(1), idempotencyKeyHash: hash }), rawIdempotencyKey: "key-1" }),
    );

    // When: request B presents the same key for the same client.
    const second = await controller.admitRelay(
      admissionInput({
        context: relayContext({ requestId: requestId(2), nonce: nonce(2), clientId: "client-a", idempotencyKeyHash: hash }),
        rawIdempotencyKey: "key-1",
      }),
    );

    // Then: the collision is rejected.
    expect(second).toEqual({ kind: "denied", code: "duplicate_idempotency_key" });
    const pool = await readStorage<Record<string, number>>(controller, "pool");
    expect(pool).toMatchObject({ reservedTokens: 300, requestCount: 1 });
  });

  it("refreshes the key mapping when the mapped entry is released", async () => {
    // Given: request A admitted with a key and then released.
    const controller = quotaController("2026-09-08");
    const hash = await keyHash("client-a", "key-1");
    await controller.admitRelay(
      admissionInput({ context: relayContext({ requestId: requestId(1), nonce: nonce(1), idempotencyKeyHash: hash }), rawIdempotencyKey: "key-1" }),
    );
    await controller.release(requestId(1));

    // When: request B reuses the released key binding.
    const second = await controller.admitRelay(
      admissionInput({
        context: relayContext({ requestId: requestId(2), nonce: nonce(2), clientId: "client-a", idempotencyKeyHash: hash }),
        rawIdempotencyKey: "key-1",
      }),
    );

    // Then: the mapping is refreshed for the new request.
    if (second.kind !== "admitted") throw new Error("expected admitted");
    expect(second.grant.requestId).toBe(requestId(2));
    const mappings = await listStorage<string>(controller, "idem:");
    expect([...mappings.values()]).toEqual([requestId(2)]);
    const pool = await readStorage<Record<string, number>>(controller, "pool");
    expect(pool).toMatchObject({ reservedTokens: 300, requestCount: 2 });
  });

  it("rejects a raw key that disagrees with the signed context hash", async () => {
    // Given: a context whose hash binds a different raw key.
    const controller = quotaController("2026-09-09");
    const hash = await keyHash("client-a", "other-key");

    // When: the raw key does not match the verified hash binding.
    const result = await controller.admitRelay(
      admissionInput({ context: relayContext({ requestId: requestId(1), nonce: nonce(1), idempotencyKeyHash: hash }), rawIdempotencyKey: "key-1" }),
    );

    // Then: admission fails closed without state.
    expect(result).toEqual({ kind: "denied", code: "invalid_request" });
    expect((await listStorage(controller, "req:")).size).toBe(0);
  });

  it("admits without a key when the context hash is null and writes no mapping", async () => {
    // Given: a request without an effective idempotency key.
    const controller = quotaController("2026-09-10");

    // When: admission without a raw key.
    const result = await controller.admitRelay(admissionInput({ context: relayContext({ requestId: requestId(1), nonce: nonce(1) }) }));

    // Then: admission succeeds and no mapping exists.
    expect(result.kind).toBe("admitted");
    expect((await listStorage(controller, "idem:")).size).toBe(0);
  });

  it("denies an environment mismatch against the DO environment binding", async () => {
    // Given: a verified context for preview and a DO bound to production.
    const controller = quotaController("2026-09-11");
    const result = await runInDurableObject(controller, (_instance, state) =>
      state.storage.transaction((storage) =>
        admitRelayInTransaction(
          storage,
          { OCTG_RELAY_ENVIRONMENT: "production" },
          { pool: "STANDARD", utcDay: "2026-09-11" },
          admissionInput(),
          Date.now(),
        ),
      ),
    );

    // Then: the environment mismatch denies without state.
    expect(result).toEqual({ kind: "denied", code: "environment_mismatch" });
    expect((await listStorage(controller, "req:")).size).toBe(0);
  });

  it("denies internal_error when the environment binding is absent", async () => {
    // Given: a DO environment without OCTG_RELAY_ENVIRONMENT.
    const controller = quotaController("2026-09-12");
    const result = await runInDurableObject(controller, (_instance, state) =>
      state.storage.transaction((storage) =>
        admitRelayInTransaction(
          storage,
          {},
          { pool: "STANDARD", utcDay: "2026-09-12" },
          admissionInput(),
          Date.now(),
        ),
      ),
    );

    // Then: configuration failure denies closed.
    expect(result).toEqual({ kind: "denied", code: "internal_error" });
    expect((await listStorage(controller, "req:")).size).toBe(0);
  });

  it("rejects inverted or negative bounds but allows a zero reservation", async () => {
    // Given: a DO with an unused pool.
    const controller = quotaController("2026-09-13");

    // When: the admission carries zero, inverted, or negative bounds.
    const zero = await controller.admitRelay(admissionInput({ reservedTokens: 0 }));
    const inverted = await controller.admitRelay(admissionInput({ reservedTokens: 300, upperBoundTokens: 200 }));
    const negativeOutput = await controller.admitRelay(admissionInput({ maxOutputTokens: -1 }));

    // Then: only the non-negative, well-formed zero reservation succeeds.
    expect(zero.kind).toBe("admitted");
    expect(inverted).toEqual({ kind: "denied", code: "internal_error" });
    expect(negativeOutput).toEqual({ kind: "denied", code: "internal_error" });
    const pool = await readStorage<Record<string, number>>(controller, "pool");
    expect(pool).toMatchObject({ reservedTokens: 0, requestCount: 1 });
  });

  it("accumulates independent admissions into the same pool/day controller", async () => {
    // Given: two decisions routed from different shards to one pool/day DO.
    const controller = quotaController("2026-09-14");

    // When: both requests are admitted.
    const first = await controller.admitRelay(admissionInput({ context: relayContext({ requestId: requestId(1), nonce: nonce(1) }) }));
    const second = await controller.admitRelay(admissionInput({ context: relayContext({ requestId: requestId(2), nonce: nonce(2) }) }));

    // Then: the shared pool counts both.
    expect(first.kind).toBe("admitted");
    expect(second.kind).toBe("admitted");
    const pool = await readStorage<Record<string, number>>(controller, "pool");
    expect(pool).toMatchObject({ reservedTokens: 600, requestCount: 2 });
  });
});
