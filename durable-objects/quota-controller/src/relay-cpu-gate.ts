import { remainingOf } from "@octg/shared";
import type { RelayCpuGateFenceResult, RelayCpuGateGrantInspection, RelayCpuGateSnapshot } from "@octg/shared";
import { getEntry, loadInFlight, loadPool, loadUnresolved, normalizeInFlightState, withoutExpiredLeases } from "./store";
import type { QuotaEnvLike, QuotaIdentity, QuotaStorage } from "./store";
import { resolveCpuGateFixtureIdentity, resolveMaxInFlightRequests } from "./relay-config";
import { getRelayGrant } from "./relay-grant";

export const CPU_GATE_FENCE_PREFIX = "cpu-gate-fence:";

export async function getRelayCpuGateSnapshot(
  storage: QuotaStorage,
  env: QuotaEnvLike,
  identity: QuotaIdentity,
  nowMs: number,
): Promise<RelayCpuGateSnapshot> {
  const [pool, unresolved, inFlight] = await Promise.all([
    loadPool(storage, env, identity),
    loadUnresolved(storage),
    loadInFlight(storage),
  ]);
  const leases = withoutExpiredLeases(normalizeInFlightState(inFlight, nowMs).state.leases, nowMs);
  return {
    version: 1,
    pool: identity.pool,
    utcDay: identity.utcDay,
    limit: pool.limit,
    remaining: remainingOf(pool),
    confirmedTokens: pool.confirmedTokens,
    reservedTokens: pool.reservedTokens,
    uncertainTokens: pool.uncertainTokens,
    requestCount: pool.requestCount,
    unresolvedReservedCount: unresolved.reservedCount,
    unresolvedUncertainCount: unresolved.uncertainCount,
    activeLeaseCount: leases.length,
    maxInFlight: resolveMaxInFlightRequests(env.MAX_IN_FLIGHT_REQUESTS),
  };
}

export async function getRelayCpuGateGrantInspection(
  storage: QuotaStorage,
  env: QuotaEnvLike,
  identity: QuotaIdentity,
  requestId: string,
  nowMs: number,
): Promise<RelayCpuGateGrantInspection> {
  const [grant, entry, storedFence, inFlight] = await Promise.all([
    getRelayGrant(storage, requestId),
    getEntry(storage, requestId),
    storage.get<boolean>(`${CPU_GATE_FENCE_PREFIX}${requestId}`),
    loadInFlight(storage),
  ]);
  if (!grant && !entry) return { kind: "absent", cpuGateFixture: false, fenced: storedFence === true };
  const fixture = resolveCpuGateFixtureIdentity(env, identity.pool);
  if (!grant || !entry || !fixture || !isCanonicalFixture(grant, entry, fixture, identity)) {
    return { kind: "non_fixture", cpuGateFixture: false };
  }
  const leases = withoutExpiredLeases(normalizeInFlightState(inFlight, nowMs).state.leases, nowMs);
  const activeLease = leases.some((lease) =>
    lease.requestId === requestId && lease.generation === grant.leaseGeneration
  );
  return {
    kind: "fixture",
    state: grant.state,
    requestState: entry.state,
    reservedTokens: grant.admission.reservedTokens,
    upperBoundTokens: grant.admission.upperBoundTokens,
    maxOutputTokens: grant.admission.maxOutputTokens,
    actualTokens: entry.actualTokens ?? null,
    activeLease,
    cpuGateFixture: true,
  };
}

export async function fenceRelayCpuGateSetup(
  storage: QuotaStorage,
  env: QuotaEnvLike,
  identity: QuotaIdentity,
  requestId: string,
  nowMs: number,
): Promise<RelayCpuGateFenceResult> {
  const inspection = await getRelayCpuGateGrantInspection(storage, env, identity, requestId, nowMs);
  if (inspection.kind === "fixture") return { kind: "fixture", inspection };
  if (inspection.kind === "non_fixture") return { kind: "non_fixture", inspection };
  if (inspection.fenced) return { kind: "fenced" };
  await storage.put(`${CPU_GATE_FENCE_PREFIX}${requestId}`, true);
  return { kind: "fenced" };
}

function isCanonicalFixture(
  grant: NonNullable<Awaited<ReturnType<typeof getRelayGrant>>>,
  entry: NonNullable<Awaited<ReturnType<typeof getEntry>>>,
  fixture: { readonly clientId: string; readonly model: string },
  identity: QuotaIdentity,
): boolean {
  const metadata = grant.admission.metadata;
  return grant.clientId === fixture.clientId && grant.model === fixture.model &&
    grant.pool === identity.pool && grant.admissionUtcDay === identity.utcDay &&
    grant.idempotencyKeyHash === null && grant.admission.reservedTokens === 0 &&
    grant.admission.upperBoundTokens === 0 && grant.admission.maxOutputTokens === 0 &&
    grant.admission.cacheEnabled === false && metadata.estimatedInputTokens === 0 &&
    metadata.maxOutputTokens === 0 && metadata.inputBytes === 0 && metadata.rawBodyBytes === 0 &&
    metadata.isToolUse === false && metadata.stream === false && entry.idempotencyKey === undefined &&
    entry.tokens === 0 && entry.upperBoundTokens === 0 && entry.reservedTokens === 0;
}
