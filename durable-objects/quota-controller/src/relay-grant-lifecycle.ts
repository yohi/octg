import { parseRelayTerminal } from "@octg/shared";
import type {
  MarkUncertainResult,
  ReleaseResult,
  SettleResult,
} from "@octg/shared";
import {
  getEntry,
  loadInFlight,
  normalizeInFlightState,
  releaseInFlightLease,
  saveInFlight,
  withoutExpiredLeases,
} from "./store";
import type { QuotaEnvLike, QuotaIdentity, QuotaStorage } from "./store";
import { applyQuotaLifecycleTransition } from "./quota-lifecycle";
import type { QuotaLifecycleRuntime } from "./quota-lifecycle";
import {
  getRelayGrant,
  grantBindingMismatch,
  isTerminalGrantState,
  putRelayGrant,
  relayLeaseExpiry,
} from "./relay-grant";
import type {
  ActivateRelayResult,
  FinishRelayInput,
  FinishRelayResult,
  RelayGrant,
  RelayGrantBinding,
  RenewRelayResult,
} from "./relay-grant";

/**
 * Transaction-scoped relay grant lifecycle operations: activation, renewal and
 * terminal settlement (SPEC.md section 19.5). Every function runs inside the
 * one ctx.storage.transaction() opened by the public QuotaController RPC and
 * never opens a nested transaction.
 */

export interface RelayGrantOperationContext {
  readonly storage: QuotaStorage;
  readonly env: QuotaEnvLike;
  readonly identity: QuotaIdentity;
  readonly nowMs: number;
}

const MAX_FINGERPRINT_BYTES = 128;

function lifecycleRuntime(ctx: RelayGrantOperationContext): QuotaLifecycleRuntime {
  return {
    env: ctx.env,
    quotaId: `quota:${ctx.identity.pool}:${ctx.identity.utcDay}`,
    identityOf: () => ctx.identity,
  };
}

async function releaseGrantLease(ctx: RelayGrantOperationContext, grant: RelayGrant): Promise<void> {
  await releaseInFlightLease(ctx.storage, {
    requestId: grant.requestId,
    generation: grant.leaseGeneration,
  });
}

async function expireAttemptedGrant(ctx: RelayGrantOperationContext, grant: RelayGrant): Promise<void> {
  await applyQuotaLifecycleTransition(lifecycleRuntime(ctx), ctx.storage, grant.requestId, {
    kind: "markUncertain",
  });
  await releaseGrantLease(ctx, grant);
  await putRelayGrant(ctx.storage, { ...grant, state: "uncertain" });
}

async function activeGrantLeases(ctx: RelayGrantOperationContext, grant: RelayGrant) {
  const entry = await getEntry(ctx.storage, grant.requestId);
  if (entry === undefined || entry.state !== "reserved") {
    return { kind: "entry_missing" as const };
  }
  const inFlight = normalizeInFlightState(await loadInFlight(ctx.storage), ctx.nowMs);
  const activeLeases = withoutExpiredLeases(inFlight.state.leases, ctx.nowMs);
  const lease = activeLeases.find((candidate) => candidate.requestId === grant.requestId);
  return { kind: "checked" as const, inFlight, activeLeases, lease };
}

export async function activateRelayInTransaction(
  ctx: RelayGrantOperationContext,
  input: RelayGrantBinding,
): Promise<ActivateRelayResult> {
  const grant = await getRelayGrant(ctx.storage, input.requestId);
  if (grant === undefined || grantBindingMismatch(grant, input, ctx.identity)) {
    return { kind: "denied", code: "grant_not_found" };
  }
  if (ctx.nowMs >= grant.credentialExpiresAtMs) {
    return { kind: "denied", code: "grant_expired" };
  }
  if (isTerminalGrantState(grant.state)) {
    return { kind: "denied", code: "grant_terminalized" };
  }
  if (grant.state === "attempted" || grant.state === "uncertain") {
    return { kind: "denied", code: "grant_replayed" };
  }
  if (ctx.nowMs >= grant.authorizationExpiresAtMs) {
    // An expired authorized grant can never activate; release reservation and lease.
    await applyQuotaLifecycleTransition(lifecycleRuntime(ctx), ctx.storage, grant.requestId, {
      kind: "release",
    });
    await releaseGrantLease(ctx, grant);
    await putRelayGrant(ctx.storage, { ...grant, state: "released" });
    return { kind: "denied", code: "grant_expired" };
  }
  const leases = await activeGrantLeases(ctx, grant);
  if (leases.kind === "entry_missing") {
    return { kind: "denied", code: "grant_not_found" };
  }
  if (leases.lease === undefined || leases.lease.generation !== grant.leaseGeneration) {
    return { kind: "denied", code: "lease_lost" };
  }
  const activated: RelayGrant = { ...grant, state: "attempted" };
  await putRelayGrant(ctx.storage, activated);
  return { kind: "activated", grant: activated };
}

export async function renewRelayInTransaction(
  ctx: RelayGrantOperationContext,
  input: RelayGrantBinding,
): Promise<RenewRelayResult> {
  const grant = await getRelayGrant(ctx.storage, input.requestId);
  if (grant === undefined || grantBindingMismatch(grant, input, ctx.identity)) {
    return { kind: "denied", code: "grant_not_found" };
  }
  if (ctx.nowMs >= grant.credentialExpiresAtMs) {
    return { kind: "denied", code: "grant_expired" };
  }
  if (isTerminalGrantState(grant.state) || grant.state === "uncertain") {
    return { kind: "denied", code: "grant_terminalized" };
  }
  if (grant.state !== "attempted") {
    return { kind: "denied", code: "invalid_request" };
  }
  if (ctx.nowMs >= grant.authorizationExpiresAtMs) {
    await expireAttemptedGrant(ctx, grant);
    return { kind: "denied", code: "grant_expired" };
  }
  const leases = await activeGrantLeases(ctx, grant);
  if (leases.kind === "entry_missing") {
    return { kind: "denied", code: "invalid_request" };
  }
  if (leases.lease === undefined || leases.lease.generation !== grant.leaseGeneration) {
    if (leases.inFlight.migrated || leases.activeLeases.length !== leases.inFlight.state.leases.length) {
      await saveInFlight(ctx.storage, { version: 1, leases: leases.activeLeases });
    }
    return { kind: "denied", code: "lease_lost" };
  }
  const expiresAtMs = relayLeaseExpiry(ctx.nowMs);
  await saveInFlight(ctx.storage, {
    version: 1,
    leases: leases.activeLeases.map((candidate) =>
      candidate.requestId === grant.requestId ? { ...candidate, expiresAtMs } : candidate),
  });
  return { kind: "renewed", grant, leaseExpiresAtMs: expiresAtMs };
}

export async function finishRelayInTransaction(
  ctx: RelayGrantOperationContext,
  input: FinishRelayInput,
): Promise<FinishRelayResult> {
  const report = parseRelayTerminal(input.report);
  if (
    report === undefined ||
    report.grantId !== input.grantId ||
    report.leaseGeneration !== input.leaseGeneration ||
    input.reportFingerprint.length === 0 ||
    input.reportFingerprint.length > MAX_FINGERPRINT_BYTES
  ) {
    return { kind: "denied", code: "invalid_request" };
  }
  const grant = await getRelayGrant(ctx.storage, input.requestId);
  if (grant === undefined || grantBindingMismatch(grant, input, ctx.identity)) {
    return { kind: "denied", code: "grant_not_found" };
  }
  if (ctx.nowMs >= grant.credentialExpiresAtMs) {
    return { kind: "denied", code: "grant_expired" };
  }
  if (isTerminalGrantState(grant.state)) {
    if (grant.terminalFingerprint === input.reportFingerprint) {
      const entry = await getEntry(ctx.storage, grant.requestId);
      if (entry === undefined) return { kind: "denied", code: "invalid_request" };
      return { kind: "accepted", grant, quota: entry };
    }
    return { kind: "denied", code: "grant_terminalized" };
  }
  // Release is legal only before activation may have occurred; settle is legal
  // only after the grant reached attempted (or is already uncertain).
  if (report.outcome === "release" && grant.state !== "authorized") {
    if (grant.state === "attempted" && ctx.nowMs >= grant.authorizationExpiresAtMs) {
      await expireAttemptedGrant(ctx, grant);
    }
    return { kind: "denied", code: "invalid_request" };
  }
  if (report.outcome === "settle" && grant.state === "authorized") {
    return { kind: "denied", code: "invalid_request" };
  }
  const runtime = lifecycleRuntime(ctx);
  let applied: SettleResult | MarkUncertainResult | ReleaseResult;
  switch (report.outcome) {
    case "settle": {
      if (report.totalTokens === null) return { kind: "denied", code: "invalid_request" };
      applied = await applyQuotaLifecycleTransition(runtime, ctx.storage, grant.requestId, {
        kind: "settle",
        actualTokens: report.totalTokens,
      });
      break;
    }
    case "uncertain":
      applied = await applyQuotaLifecycleTransition(runtime, ctx.storage, grant.requestId, {
        kind: "markUncertain",
      });
      break;
    case "release":
      applied = await applyQuotaLifecycleTransition(runtime, ctx.storage, grant.requestId, {
        kind: "release",
      });
      break;
  }
  if (!applied.ok) return { kind: "denied", code: "invalid_request" };
  await releaseGrantLease(ctx, grant);
  const nextState: RelayGrant["state"] = report.outcome === "settle"
    ? "settled"
    : report.outcome === "uncertain"
      ? "uncertain"
      : "released";
  const finished: RelayGrant = {
    ...grant,
    state: nextState,
    terminalReport: report,
    terminalFingerprint: input.reportFingerprint,
  };
  await putRelayGrant(ctx.storage, finished);
  const entry = await getEntry(ctx.storage, grant.requestId);
  if (entry === undefined) return { kind: "denied", code: "invalid_request" };
  return { kind: "accepted", grant: finished, quota: entry };
}
