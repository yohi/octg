import {
  classifyModel,
  RELAY_REQUEST_ID_PATTERN,
  relayRequestUtcDayOf,
  signRelayContext,
  signRelayGrantCredential,
  utcDayOf,
} from "@octg/shared";
import type {
  PoolName,
  RelayContextV1,
  RelayCpuGateFenceResult,
  RelayCpuGateGrantInspection,
  RelayCpuGateReconcileUnusedResponseV1,
  RelayCpuGateSetupCompensatedV1,
  RelayCpuGateSetupRejectionV1,
} from "@octg/shared";
import type { Env } from "./index";
import { resolveRelayConfig, resolveRelayCpuGateControl, verifyRelayCpuGateAuth } from "./relay-auth";
import { relayGrantClaimsOf } from "./relay-grant-claims";
import { loadRegistry } from "./policy";
import { bodyOf, hasExactKeys, json, poolOf, quotaStub, relayEnvironmentOf, slotStub } from "./relay-cpu-gate-utils";

const PREFIX = "/internal/relay/v1/cpu-gate/";

function fixture(env: Env, pool: PoolName): { readonly clientId: string; readonly model: string } | undefined {
  const clientId = pool === "STANDARD" ? env.OCTG_RELAY_CPU_GATE_STANDARD_CLIENT_ID : env.OCTG_RELAY_CPU_GATE_MINI_CLIENT_ID;
  const model = pool === "STANDARD" ? env.OCTG_RELAY_CPU_GATE_STANDARD_MODEL : env.OCTG_RELAY_CPU_GATE_MINI_MODEL;
  return clientId && model ? { clientId, model } : undefined;
}

function context(env: Env, requestId: string, clientId: string): RelayContextV1 | undefined {
  const config = resolveRelayConfig(env);
  if (config.kind !== "enabled") return undefined;
  const issuedAtMs = Date.now();
  return {
    version: 1,
    audience: "octg-deno-relay",
    environment: config.environment,
    route: "responses",
    requestId,
    clientId,
    idempotencyKeyHash: null,
    nonce: btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""),
    issuedAtMs,
    expiresAtMs: issuedAtMs + 60_000,
  };
}

function grantInspectionBody(inspection: RelayCpuGateGrantInspection): Response {
  switch (inspection.kind) {
    case "absent":
      return inspection.fenced
        ? json({ version: 1, kind: "absent" }, 404)
        : json({ version: 1, kind: "pending_ambiguous" }, 425);
    case "non_fixture":
      return json({ version: 1, error: "setup_state_incompatible" }, 409);
    case "fixture":
      return json({ version: 1, kind: "fixture", inspection });
    default:
      return json({ version: 1, error: "internal_error" }, 500);
  }
}

export async function handleRelayCpuGate(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return new Response("Not Found", { status: 404 });
  const control = resolveRelayCpuGateControl(env);
  if (control.kind !== "enabled") return new Response("Not Found", { status: 404 });
  if (!verifyRelayCpuGateAuth(request.headers.get("Authorization"), control.token)) {
    return new Response(null, { status: 401 });
  }
  const route = url.pathname.slice(PREFIX.length);
  const validRoute = ["quota", "slot", "setup", "setup-fence", "decision-context", "operation-inspection", "reconcile-unused", "close-operation"].includes(route);
  if (!validRoute) return new Response("Not Found", { status: 404 });
  if ((route === "quota" || route === "slot") && request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  if (route !== "quota" && route !== "slot" && request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const configuredSlotEnvironment = relayEnvironmentOf(env);
  if ((route === "slot" || route === "close-operation") && configuredSlotEnvironment === undefined) {
    return json({ version: 1, error: "cpu_gate_slot_unavailable" }, 503);
  }
  if (route === "quota" && request.method === "GET") {
    const pool = poolOf(url.searchParams.get("pool"));
    const day = url.searchParams.get("utcDay");
    if (!pool || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ version: 1, error: "invalid_request" }, 400);
    const dayValue = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(dayValue.getTime()) || dayValue.toISOString().slice(0, 10) !== day) return json({ version: 1, error: "invalid_request" }, 400);
    try { return json(await quotaStub(env, pool, day).getRelayCpuGateSnapshot()); }
    catch { return json({ version: 1, error: "internal_error" }, 503); }
  }
  if (route === "slot" && request.method === "GET") {
    try {
      if (configuredSlotEnvironment === undefined) return json({ version: 1, error: "cpu_gate_slot_unavailable" }, 503);
      const state = await slotStub(env, configuredSlotEnvironment).getRelayCpuGateSlot();
      return json({ version: 1, slot: state });
    } catch { return json({ version: 1, error: "cpu_gate_slot_unavailable" }, 503); }
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: route === "quota" || route === "slot" ? "GET" : "POST" } });
  const body = await bodyOf(request);
  if (!body) return json({ version: 1, error: "invalid_request" }, 400);
  const pool = poolOf(body.pool);
  const requestId = body.requestId;
  const expectedKeys = route === "close-operation" ? ["version", "pool", "requestId", "generation"] : ["version", "pool", "requestId"];
  if (!hasExactKeys(body, expectedKeys) || body.version !== 1 || !pool || typeof requestId !== "string" || !RELAY_REQUEST_ID_PATTERN.test(requestId)) return json({ version: 1, error: "invalid_request" }, 400);
  const day = relayRequestUtcDayOf(requestId);
  if (!day) return json({ version: 1, error: "invalid_request" }, 400);
  const stub = quotaStub(env, pool, day);
  try {
    if (route === "setup-fence") {
      const result: RelayCpuGateFenceResult = await stub.fenceRelayCpuGateSetup(requestId);
      switch (result.kind) {
        case "fenced": return json({ version: 1, requestId, kind: "fenced" });
        case "fixture": return json({ version: 1, requestId, kind: "fixture", inspection: result.inspection });
        case "non_fixture": return json({ version: 1, requestId, kind: "non_fixture", inspection: result.inspection });
        default: return json({ version: 1, error: "internal_error" }, 503);
      }
    }
    if (route === "operation-inspection") return grantInspectionBody(await stub.getRelayCpuGateGrantInspection(requestId));
    if (route === "decision-context") {
      if (day !== utcDayOf(new Date())) return json({ version: 1, error: "invalid_request" }, 400);
      const configured = fixture(env, pool);
      const claims = configured && context(env, requestId, configured.clientId);
      const config = resolveRelayConfig(env);
      if (!claims || config.kind !== "enabled") return json({ version: 1, error: "internal_error" }, 503);
      const inspection = await stub.getRelayCpuGateGrantInspection(requestId);
      if (inspection.kind !== "absent" || inspection.fenced) return json({ version: 1, error: "setup_state_ambiguous" }, 409);
      return json({ version: 1, requestId, contextToken: await signRelayContext(claims, config.contextHmacKey) });
    }
    if (route === "setup") {
      if (day !== utcDayOf(new Date())) return json({ version: 1, error: "invalid_request" }, 400);
      const configured = fixture(env, pool);
      const config = resolveRelayConfig(env);
      if (!configured || config.kind !== "enabled") return json({ version: 1, error: "internal_error" }, 503);
      const client = await env.DB.prepare("SELECT enabled FROM clients WHERE id = ?")
        .bind(configured.clientId)
        .first<{ readonly enabled: number }>();
      if (client?.enabled !== 1) return json({ version: 1, error: "internal_error" }, 503);
      if (classifyModel(configured.model, await loadRegistry(env)) !== pool) return json({ version: 1, error: "internal_error" }, 503);
      const slotEnvironment = relayEnvironmentOf(env);
      if (slotEnvironment === undefined || slotEnvironment !== config.environment) return json({ version: 1, error: "cpu_gate_slot_unavailable" }, 503);
      const singleton = slotStub(env, slotEnvironment);
      const owner = { pool, requestId };
      if (config.environment === "production") {
        let claim: Awaited<ReturnType<typeof singleton.claimRelayCpuGateSlot>>;
        try {
          claim = await singleton.claimRelayCpuGateSlot(owner);
        } catch {
          return json({ version: 1, error: "cpu_gate_slot_unavailable" }, 503);
        }
        if (claim.kind === "busy") return json({ version: 1, error: "cpu_gate_busy" }, 409);
      }
      const inspection = await stub.getRelayCpuGateGrantInspection(requestId);
      if (inspection.kind !== "absent" || inspection.fenced) return json({ version: 1, error: "setup_state_ambiguous" }, 409);
      const claims = context(env, requestId, configured.clientId);
      if (!claims) return json({ version: 1, error: "internal_error" }, 503);
      const metadata = { model: configured.model, estimatedInputTokens: 0, maxOutputTokens: 0, inputBytes: 0, rawBodyBytes: 0, isToolUse: false, stream: false };
      const admitted = await stub.admitRelay({ context: claims, metadata, reservedTokens: 0, upperBoundTokens: 0, maxOutputTokens: 0, cacheEnabled: false });
      if (admitted.kind === "denied") {
        const rejection: RelayCpuGateSetupRejectionV1 = { version: 1, error: admitted.code };
        return json(rejection, 409);
      }
      try {
        const grantToken = await signRelayGrantCredential(relayGrantClaimsOf(admitted.grant), config.contextHmacKey);
        return json({ version: 1, requestId, grantToken, grantId: admitted.grant.grantId, leaseGeneration: admitted.grant.leaseGeneration, pool, admissionUtcDay: day });
      } catch {
        await stub.reconcileRequest(requestId, "unused");
        const inspected = await stub.getRelayCpuGateGrantInspection(requestId);
        if (inspected.kind === "fixture" && inspected.state === "reconciled_unused" && inspected.requestState === "released" && !inspected.activeLease) {
          const compensated: RelayCpuGateSetupCompensatedV1 = { version: 1, kind: "setup_failed_compensated" };
          return json(compensated, 500);
        }
        return json({ version: 1, error: "setup_state_ambiguous" }, 503);
      }
    }
    if (route === "reconcile-unused") {
      const inspection = await stub.getRelayCpuGateGrantInspection(requestId);
      if (inspection.kind !== "fixture" || !["authorized", "attempted", "uncertain"].includes(inspection.state)) return json({ version: 1, error: "setup_state_incompatible" }, 409);
      await stub.reconcileRequest(requestId, "unused");
      const after = await stub.getRelayCpuGateGrantInspection(requestId);
      if (after.kind === "fixture" && after.state === "reconciled_unused" && after.requestState === "released" && after.actualTokens === null && !after.activeLease) {
        const response: RelayCpuGateReconcileUnusedResponseV1 = { version: 1, kind: "reconciled_unused" };
        return json(response);
      }
      return json({ version: 1, error: "setup_state_ambiguous" }, 503);
    }
    if (route === "close-operation") {
      const generation = body.generation;
      if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) return json({ version: 1, error: "invalid_request" }, 400);
      if (configuredSlotEnvironment === undefined) return json({ version: 1, error: "cpu_gate_slot_unavailable" }, 503);
      const singleton = slotStub(env, configuredSlotEnvironment);
      let closed: Awaited<ReturnType<typeof singleton.closeRelayCpuGateSlot>>;
      try {
        closed = await singleton.closeRelayCpuGateSlot({ pool, requestId }, generation);
      } catch {
        return json({ version: 1, error: "cpu_gate_slot_unavailable" }, 503);
      }
      return closed.kind === "closed" ? json({ version: 1, kind: "closed" }) : json({ version: 1, error: "cpu_gate_close_blocked" }, 409);
    }
    return new Response("Not Found", { status: 404 });
  } catch {
    return json({ version: 1, error: route === "setup" ? "setup_state_ambiguous" : "internal_error" }, 503);
  }
}
