import { SELF, env, runInDurableObject } from "cloudflare:test";
import { decodeRelayContextHmacKey, isRecord, quotaIdOf, relayRequestUtcDayOf, utcDayOf, verifyRelayContext } from "@octg/shared";
import type { PoolName, RelayContextV1 } from "@octg/shared";
import type { QuotaController } from "@octg/quota-controller";
import { ulid } from "ulid";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateConfigCaches } from "../src/policy";

const URL = "https://worker.example/internal/relay/v1/cpu-gate";
const CONTROL_TOKEN = "c".repeat(43);

beforeAll(async () => {
  Object.assign(env, {
    OCTG_RELAY_ENABLED: "true",
    OCTG_RELAY_ENVIRONMENT: "production",
    OCTG_RELAY_INGRESS_ENDPOINT: "https://relay.example/",
    OCTG_RELAY_INGRESS_AUTH_TOKEN: "i".repeat(32),
    OCTG_RELAY_SERVICE_AUTH_TOKEN: "s".repeat(32),
    OCTG_RELAY_CONTEXT_HMAC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    QUOTA_LIMIT_STANDARD: "950000",
    QUOTA_LIMIT_MINI: "9950000",
    MAX_IN_FLIGHT_REQUESTS: "64",
  });
  await env.DB.prepare("INSERT INTO clients (id, name, key_hash, enabled, created_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(id) DO NOTHING")
    .bind("cpu-gate-standard-client", "CPU gate standard", "c".repeat(64), new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO clients (id, name, key_hash, enabled, created_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(id) DO NOTHING")
    .bind("cpu-gate-mini-client", "CPU gate mini", "m".repeat(64), new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO model_registry (model, provider, complimentary_pool, enabled, fallback_model, updated_at) VALUES (?, 'openai', ?, 1, NULL, ?) ON CONFLICT(model) DO UPDATE SET complimentary_pool = excluded.complimentary_pool, enabled = 1")
    .bind("cpu-gate-standard-model", "STANDARD", new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO model_registry (model, provider, complimentary_pool, enabled, fallback_model, updated_at) VALUES (?, 'openai', ?, 1, NULL, ?) ON CONFLICT(model) DO UPDATE SET complimentary_pool = excluded.complimentary_pool, enabled = 1")
    .bind("cpu-gate-mini-model", "MINI", new Date().toISOString()).run();
  invalidateConfigCaches();
});

beforeEach(async () => {
  await runInDurableObject(slot(), async (_instance, state) => {
    await state.storage.delete("cpu-gate-slot:v1:state");
    await state.storage.delete("cpu-gate-slot:v1:generation");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  invalidateConfigCaches();
});

function requestId(): string {
  return `req_${ulid()}`;
}

function quota(pool: PoolName, day: string): DurableObjectStub<QuotaController> {
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, day)));
}

function slot() {
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName("cpu-gate-slot:v1:production"));
}

function controlRequest(path: string, body?: unknown, token = CONTROL_TOKEN): Request {
  return new Request(`${URL}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function fixtureContext(id: string, clientId: string): RelayContextV1 {
  const issuedAtMs = Date.now();
  return {
    version: 1,
    audience: "octg-deno-relay",
    environment: "production",
    route: "responses",
    requestId: id,
    clientId,
    idempotencyKeyHash: null,
    nonce: "n".repeat(43),
    issuedAtMs,
    expiresAtMs: issuedAtMs + 60_000,
  };
}

async function admitFixture(id: string, pool: PoolName): Promise<void> {
  const day = relayRequestUtcDayOf(id);
  if (day === undefined) throw new Error("test ULID must have a valid UTC day");
  const result = await quota(pool, day).admitRelay(relayInput(id, pool));
  expect(result.kind).toBe("admitted");
}

function relayInput(id: string, pool: PoolName) {
  const day = relayRequestUtcDayOf(id);
  if (day === undefined) throw new Error("test ULID must have a valid UTC day");
  const standard = pool === "STANDARD";
  return {
    context: fixtureContext(id, standard ? "cpu-gate-standard-client" : "cpu-gate-mini-client"),
    metadata: {
      model: standard ? "cpu-gate-standard-model" : "cpu-gate-mini-model",
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

async function slotGeneration(): Promise<number> {
  const slotState = await slot().getRelayCpuGateSlot();
  if (slotState.kind === "idle") throw new Error("expected a held CPU-gate slot");
  return slotState.generation;
}

function setupBody(id: string, pool: PoolName = "STANDARD") {
  return { version: 1, pool, requestId: id };
}

async function closeSlot(ownerId: string, pool: PoolName, generation: number): Promise<Response> {
  return SELF.fetch(controlRequest("close-operation", { ...setupBody(ownerId, pool), generation }));
}

describe("relay CPU-gate routes", () => {
  // SELF.fetch crosses Workerd's stream transport, which can pull/cancel a body
  // independently of handler code. Therefore stream callbacks cannot reliably
  // attribute body access to the handler; these entrypoint assertions instead
  // prove denied status and zero Durable Object identity lookups.
  it("disables missing or service-equal control credentials before reading the body", async () => {
    const request = new Request(`${URL}/setup`, { method: "POST", body: "not-json" });
    const previous = env.OCTG_RELAY_CPU_GATE_AUTH_TOKEN;
    const idFromName = vi.spyOn(env.QUOTA_CONTROLLER, "idFromName");
    Reflect.deleteProperty(env, "OCTG_RELAY_CPU_GATE_AUTH_TOKEN");
    try {
      const response = await SELF.fetch(request);
      expect(response.status).toBe(404);
      expect(idFromName).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(env, "OCTG_RELAY_CPU_GATE_AUTH_TOKEN");
      else Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: previous });
    }
  });

  it("requires the dedicated bearer before a route can parse a request", async () => {
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    const idFromName = vi.spyOn(env.QUOTA_CONTROLLER, "idFromName");
    const response = await SELF.fetch(new Request(`${URL}/setup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${"s".repeat(32)}` },
      body: "not-json",
    }));
    expect(response.status).toBe(401);
    expect(idFromName).not.toHaveBeenCalled();
  });

  it("rejects a missing control bearer before a Durable Object lookup", async () => {
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    const idFromName = vi.spyOn(env.QUOTA_CONTROLLER, "idFromName");
    const response = await SELF.fetch(new Request(`${URL}/slot`));
    expect(response.status).toBe(401);
    expect(idFromName).not.toHaveBeenCalled();
  });

  it("routes the CPU-gate prefix independently from lifecycle callback actions", async () => {
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    const response = await SELF.fetch(new Request(`${URL}/unknown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
      body: "{}",
    }));
    expect(response.status).toBe(404);
  });

  it("disables a service-equal control secret at route level without a DO call", async () => {
    const get = vi.spyOn(env.QUOTA_CONTROLLER, "idFromName");
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: env.OCTG_RELAY_SERVICE_AUTH_TOKEN });
    const response = await SELF.fetch(controlRequest("slot"));
    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
  });

  it.each([
    ["invalid", "not-a-valid-control-token"],
    ["ingress-equal", "i".repeat(32)],
  ])("disables %s control credentials before a DO lookup", async (_label, token) => {
    const previous = env.OCTG_RELAY_CPU_GATE_AUTH_TOKEN;
    const idFromName = vi.spyOn(env.QUOTA_CONTROLLER, "idFromName");
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: token });
    try {
      const response = await SELF.fetch(controlRequest("slot"));
      expect(response.status).toBe(404);
      expect(idFromName).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(env, "OCTG_RELAY_CPU_GATE_AUTH_TOKEN");
      else Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: previous });
    }
  });

  it.each([
    ["quota", "POST", "GET"],
    ["slot", "POST", "GET"],
    ["setup", "GET", "POST"],
  ] as const)("rejects %s with the required %s-only method", async (route, method, allowed) => {
    const previous = env.OCTG_RELAY_CPU_GATE_AUTH_TOKEN;
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    const idFromName = vi.spyOn(env.QUOTA_CONTROLLER, "idFromName");
    try {
      const response = await SELF.fetch(new Request(`${URL}/${route}`, {
        method,
        headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
      }));
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe(allowed);
      expect(idFromName).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(env, "OCTG_RELAY_CPU_GATE_AUTH_TOKEN");
      else Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: previous });
    }
  });

  it("returns the exact compensated setup envelope only after reconciliation proof", async () => {
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    const id = requestId();
    const sign = vi.spyOn(crypto.subtle, "sign").mockRejectedValue(new Error("injected signing failure"));
    const response = await SELF.fetch(controlRequest("setup", setupBody(id)));
    expect(sign).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ version: 1, kind: "setup_failed_compensated" });
    const day = relayRequestUtcDayOf(id);
    if (day === undefined) throw new Error("generated request ID must have a UTC day");
    expect(await quota("STANDARD", day).getRelayCpuGateGrantInspection(id)).toMatchObject({
      kind: "fixture",
      state: "reconciled_unused",
      requestState: "released",
      activeLease: false,
    });
    const fenced = await SELF.fetch(controlRequest("setup-fence", setupBody(id)));
    expect(await fenced.json()).toMatchObject({
      version: 1,
      requestId: id,
      kind: "fixture",
      inspection: { state: "reconciled_unused", requestState: "released", activeLease: false },
    });

    const generation = await slotGeneration();
    const close = await closeSlot(id, "STANDARD", generation);
    expect(close.status).toBe(200);
  });

  it("creates a configured fixture through QuotaController and retains the slot until closure", async () => {
    // Given: an unused ID in today's UTC day and valid fixture registry rows.
    const id = requestId();
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    // When: the protected setup route admits and signs the fixture.
    const setup = await SELF.fetch(controlRequest("setup", setupBody(id)));
    const value: unknown = await setup.json();
    const day = relayRequestUtcDayOf(id);
    if (day === undefined) throw new Error("generated request ID must have a UTC day");
    const inspected = await SELF.fetch(controlRequest("operation-inspection", setupBody(id)));
    const slotResponse = await SELF.fetch(controlRequest("slot"));
    const slotValue: unknown = await slotResponse.json();
    // Then: the response carries only the setup contract and target inspection remains live.
    expect(setup.status).toBe(200);
    expect(isRecord(value)).toBe(true);
    if (!isRecord(value)) throw new Error("successful setup response must be an object");
    expect(Object.keys(value).sort()).toEqual(["admissionUtcDay", "grantId", "grantToken", "leaseGeneration", "pool", "requestId", "version"].sort());
    expect(value).toMatchObject({ version: 1, requestId: id, pool: "STANDARD", admissionUtcDay: day });
    expect(typeof value.grantToken).toBe("string");
    expect(await inspected.json()).toMatchObject({ kind: "fixture", inspection: { state: "authorized", reservedTokens: 0, activeLease: true } });
    expect(slotResponse.status).toBe(200);
    expect(slotValue).toMatchObject({ slot: { kind: "held", owner: { pool: "STANDARD", requestId: id } } });
    const reconciled = await SELF.fetch(controlRequest("reconcile-unused", setupBody(id)));
    expect(reconciled.status).toBe(200);
    expect((await closeSlot(id, "STANDARD", await slotGeneration())).status).toBe(200);
  });

  it("returns a signed decision context without admitting a request", async () => {
    // Given: an unused current-day operation ID and configured fixture identity.
    const id = requestId();
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    // When: the protected decision-context route is called.
    const response = await SELF.fetch(controlRequest("decision-context", setupBody(id)));
    const value: unknown = await response.json();
    // Then: the Worker returns a verifiable same-environment Context without model claims or admission.
    expect(response.status).toBe(200);
    if (!isRecord(value) || typeof value.contextToken !== "string") throw new Error("decision context response must include a token");
    const encodedKey = env.OCTG_RELAY_CONTEXT_HMAC_KEY;
    if (encodedKey === undefined) throw new Error("test relay HMAC key must be configured");
    const key = decodeRelayContextHmacKey(encodedKey);
    if (key === undefined) throw new Error("test relay HMAC key must decode");
    const claims = await verifyRelayContext(value.contextToken, key, "production", Date.now());
    expect(claims).toMatchObject({ requestId: id, clientId: "cpu-gate-standard-client", idempotencyKeyHash: null });
    if (claims === undefined) throw new Error("context token must verify");
    expect(Object.keys(claims).sort()).toEqual(["audience", "clientId", "environment", "expiresAtMs", "idempotencyKeyHash", "issuedAtMs", "nonce", "requestId", "route", "version"].sort());
    const day = relayRequestUtcDayOf(id);
    if (day === undefined) throw new Error("generated request ID must have a UTC day");
    expect(await quota("STANDARD", day).getRelayCpuGateGrantInspection(id)).toMatchObject({ kind: "absent", fenced: false });
  });

  it("returns the current canonical quota snapshot for the requested pool and day", async () => {
    // Given: the authenticated CPU-gate route and current production quota day.
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    const day = utcDayOf(new Date());
    // When: the quota snapshot route is called.
    const response = await SELF.fetch(new Request(`${URL}/quota?pool=STANDARD&utcDay=${day}`, {
      headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
    }));
    const value: unknown = await response.json();
    // Then: only the versioned authoritative snapshot is returned.
    expect(response.status).toBe(200);
    expect(value).toMatchObject({ version: 1, pool: "STANDARD", utcDay: day });
  });

  it("maps an overflowing ULID to invalid request day at the shared boundary", async () => {
    // Given: a maximum Crockford ULID timestamp that is outside supported year range.
    const id = `req_7${"Z".repeat(25)}`;
    expect(relayRequestUtcDayOf(id)).toBeUndefined();
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    // When: operation inspection receives the syntactically valid request ID.
    const response = await SELF.fetch(controlRequest("operation-inspection", setupBody(id)));
    // Then: the request is rejected before QuotaController resolution.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ version: 1, error: "invalid_request" });
  });

  it("fences delayed admission and exposes absent only after the fence commits", async () => {
    // Given: an operation ID with no QuotaController state.
    const id = requestId();
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    // When: inspect, fence, inspect, then attempt the delayed real DO admission.
    const pending = await SELF.fetch(controlRequest("operation-inspection", setupBody(id)));
    const fenced = await SELF.fetch(controlRequest("setup-fence", setupBody(id)));
    const absent = await SELF.fetch(controlRequest("operation-inspection", setupBody(id)));
    const day = relayRequestUtcDayOf(id);
    if (day === undefined) throw new Error("generated request ID must have a UTC day");
    const delayed = await quota("STANDARD", day).admitRelay(relayInput(id, "STANDARD"));
    // Then: unresolved inspection is 425, fence is durable, and delayed admission fails closed.
    expect(pending.status).toBe(425);
    expect(await fenced.json()).toEqual({ version: 1, requestId: id, kind: "fenced" });
    expect(absent.status).toBe(404);
    expect(delayed).toEqual({ kind: "denied", code: "invalid_context" });
  });

  it("keeps the singleton held for an existing fixture collision and redirects to recovery", async () => {
    // Given: a live canonical fixture already admitted for this operation ID.
    const id = requestId();
    await admitFixture(id, "STANDARD");
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    // When: setup collides, then the runner asks the fence route for recovery state.
    const setup = await SELF.fetch(controlRequest("setup", setupBody(id)));
    const fenced = await SELF.fetch(controlRequest("setup-fence", setupBody(id)));
    const slotState = await slot().getRelayCpuGateSlot();
    // Then: setup is ambiguous, recovery sees the existing fixture, and the slot remains held.
    expect(setup.status).toBe(409);
    expect(await setup.json()).toEqual({ version: 1, error: "setup_state_ambiguous" });
    expect(await fenced.json()).toMatchObject({ version: 1, requestId: id, kind: "fixture", inspection: { state: "authorized" } });
    expect(slotState).toMatchObject({ kind: "held", owner: { pool: "STANDARD", requestId: id } });
    const reconciled = await SELF.fetch(controlRequest("reconcile-unused", setupBody(id)));
    expect(reconciled.status).toBe(200);
    const close = await closeSlot(id, "STANDARD", await slotGeneration());
    expect(close.status).toBe(200);
  });

  it("keeps the singleton held for an ordinary-request collision", async () => {
    // Given: an ordinary admitted request occupying the runner-owned request ID.
    const id = requestId();
    const day = relayRequestUtcDayOf(id);
    if (day === undefined) throw new Error("generated request ID must have a UTC day");
    const context: RelayContextV1 = {
      ...fixtureContext(id, "ordinary-client"),
    };
    await quota("STANDARD", day).admitRelay({
      context,
      metadata: { model: "ordinary-model", estimatedInputTokens: 1, maxOutputTokens: 1, inputBytes: 1, rawBodyBytes: 1, isToolUse: false, stream: false },
      reservedTokens: 1,
      upperBoundTokens: 1,
      maxOutputTokens: 1,
      cacheEnabled: false,
    });
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    // When: CPU-gate setup encounters that canonical non-fixture state.
    const response = await SELF.fetch(controlRequest("setup", setupBody(id)));
    const state = await slot().getRelayCpuGateSlot();
    // Then: the operation is ambiguous and its claimed singleton is retained for safe blocking.
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ version: 1, error: "setup_state_ambiguous" });
    expect(state).toMatchObject({ kind: "held", owner: { pool: "STANDARD", requestId: id } });
  });

  it("returns busy without admission when another owner holds the singleton", async () => {
    // Given: another pool/ID already owns the singleton.
    const owner = { pool: "MINI" as const, requestId: requestId() };
    const claim = await slot().claimRelayCpuGateSlot(owner);
    expect(claim.kind).toBe("claimed");
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    const id = requestId();
    // When: setup is requested for a distinct operation.
    const response = await SELF.fetch(controlRequest("setup", setupBody(id, "STANDARD")));
    const day = relayRequestUtcDayOf(id);
    if (day === undefined) throw new Error("generated request ID must have a UTC day");
    // Then: contention is 409 and no target grant was admitted.
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ version: 1, error: "cpu_gate_busy" });
    expect(await quota("STANDARD", day).getRelayCpuGateGrantInspection(id)).toMatchObject({ kind: "absent" });
    if (claim.kind === "claimed") {
      expect(await slot().closeRelayCpuGateSlot(owner, claim.slot.generation)).toEqual({ kind: "closed" });
    }
  });

  it("returns slot-unavailable on a claim RPC failure without target admission", async () => {
    // Given: the singleton binding responds to its claim RPC with an unavailable error.
    const target = slot();
    const get = vi.spyOn(env.QUOTA_CONTROLLER, "get").mockReturnValue(new Proxy(target, {
      get: (stub, key, receiver) => key === "claimRelayCpuGateSlot"
        ? async () => { throw new Error("simulated unavailable slot"); }
        : Reflect.get(stub, key, receiver),
    }));
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    const id = requestId();
    const day = relayRequestUtcDayOf(id);
    if (day === undefined) throw new Error("generated request ID must have a UTC day");
    // When: setup attempts to claim the singleton.
    const response = await SELF.fetch(controlRequest("setup", setupBody(id)));
    // Then: slot unavailability is a 503 and no fixture reaches QuotaController admission.
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ version: 1, error: "cpu_gate_slot_unavailable" });
    get.mockRestore();
    expect(await quota("STANDARD", day).getRelayCpuGateGrantInspection(id)).toMatchObject({ kind: "absent" });
  });

  it("allows at most one owner across IDs and pools on the real singleton", async () => {
    // Given: two operation owners race for the environment singleton.
    const ownerA = { pool: "STANDARD" as const, requestId: requestId() };
    const ownerB = { pool: "MINI" as const, requestId: requestId() };
    // When: both requests try the actual QuotaController slot RPC concurrently.
    const [claimA, claimB] = await Promise.all([
      slot().claimRelayCpuGateSlot(ownerA),
      slot().claimRelayCpuGateSlot(ownerB),
    ]);
    // Then: exactly one wins regardless of ID or pool.
    const claimed = claimA.kind === "claimed" ? claimA : claimB.kind === "claimed" ? claimB : undefined;
    expect(claimA.kind === "claimed" || claimB.kind === "claimed").toBe(true);
    expect(claimA.kind === "busy" || claimB.kind === "busy").toBe(true);
    if (claimed === undefined) throw new Error("one slot claim must succeed");
    const close = await closeSlot(claimed.slot.owner.requestId, claimed.slot.owner.pool, claimed.slot.generation);
    expect(close.status).toBe(200);
  });

  it("blocks a stale close generation and closes only the matching owner", async () => {
    // Given: an absent target held under a live owner generation.
    const owner = { pool: "STANDARD" as const, requestId: requestId() };
    const claim = await slot().claimRelayCpuGateSlot(owner);
    if (claim.kind !== "claimed") throw new Error("first slot claim must succeed");
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    const stale = await closeSlot(owner.requestId, owner.pool, claim.slot.generation + 1);
    // When: the runner closes using both a stale and the current generation.
    const afterStale = await slot().getRelayCpuGateSlot();
    const current = await closeSlot(owner.requestId, owner.pool, claim.slot.generation);
    // Then: stale ownership is blocked and matching closure proves idle.
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ version: 1, error: "cpu_gate_close_blocked" });
    expect(afterStale).toMatchObject({ kind: "held", owner, generation: claim.slot.generation });
    expect(current.status).toBe(200);
    expect(await slot().getRelayCpuGateSlot()).toEqual({ kind: "idle" });
  });

  it("reconciles only live fixtures and leaves absent or terminal operations unchanged", async () => {
    // Given: one live fixture, one absent ID, and one already terminal fixture.
    const liveId = requestId();
    const absentId = requestId();
    const terminalId = requestId();
    await admitFixture(liveId, "STANDARD");
    await admitFixture(terminalId, "STANDARD");
    const terminalDay = relayRequestUtcDayOf(terminalId);
    if (terminalDay === undefined) throw new Error("generated request ID must have a UTC day");
    await quota("STANDARD", terminalDay).reconcileRequest(terminalId, "unused");
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    // When: reconcile-unused is requested for the three operation states.
    const live = await SELF.fetch(controlRequest("reconcile-unused", setupBody(liveId)));
    const absent = await SELF.fetch(controlRequest("reconcile-unused", setupBody(absentId)));
    const terminal = await SELF.fetch(controlRequest("reconcile-unused", setupBody(terminalId)));
    const nonFixtureId = requestId();
    const nonFixtureDay = relayRequestUtcDayOf(nonFixtureId);
    if (nonFixtureDay === undefined) throw new Error("generated request ID must have a UTC day");
    await quota("STANDARD", nonFixtureDay).admitRelay({
      context: fixtureContext(nonFixtureId, "ordinary-client"),
      metadata: { model: "ordinary-model", estimatedInputTokens: 1, maxOutputTokens: 1, inputBytes: 1, rawBodyBytes: 1, isToolUse: false, stream: false },
      reservedTokens: 1,
      upperBoundTokens: 1,
      maxOutputTokens: 1,
      cacheEnabled: false,
    });
    const nonFixture = await SELF.fetch(controlRequest("reconcile-unused", setupBody(nonFixtureId)));
    // Then: only the live canonical fixture is reconciled.
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ version: 1, kind: "reconciled_unused" });
    expect(absent.status).toBe(409);
    expect(terminal.status).toBe(409);
    expect(nonFixture.status).toBe(409);
    expect(await quota("STANDARD", nonFixtureDay).getRelayCpuGateGrantInspection(nonFixtureId)).toMatchObject({ kind: "non_fixture" });
    expect(await quota("STANDARD", terminalDay).getRelayCpuGateGrantInspection(terminalId)).toMatchObject({
      kind: "fixture",
      state: "reconciled_unused",
      requestState: "released",
    });
  });

  it("returns 503 without invoking a slot DO when the runtime environment is invalid", async () => {
    // Given: valid CPU-gate auth but no usable runtime environment.
    const previous = env.OCTG_RELAY_ENVIRONMENT;
    const idFromName = vi.spyOn(env.QUOTA_CONTROLLER, "idFromName");
    Reflect.deleteProperty(env, "OCTG_RELAY_ENVIRONMENT");
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    try {
      // When: the slot endpoint is requested.
      const response = await SELF.fetch(controlRequest("slot"));
      const close = await SELF.fetch(controlRequest("close-operation", { ...setupBody(requestId()), generation: 1 }));
      // Then: it fails closed before namespace identity resolution.
      expect(response.status).toBe(503);
      expect(close.status).toBe(503);
      expect(idFromName).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) Object.assign(env, { OCTG_RELAY_ENVIRONMENT: previous });
    }
  });
});
