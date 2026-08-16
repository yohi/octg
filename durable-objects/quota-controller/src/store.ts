import { POOL_LIMITS } from "@octg/shared";
import type {
  AcquireInFlightResult,
  InFlightLease,
  PoolName,
  PoolState,
  ReleaseInFlightResult,
  RenewInFlightResult,
  RequestEntry,
} from "@octg/shared";

export const POOL_KEY = "pool";
export const ENTRY_PREFIX = "req:";
export const IDEMPOTENCY_PREFIX = "idem:";
export const UNRESOLVED_KEY = "unresolved";
export const FINALIZE_KEY = "finalized";
export const IN_FLIGHT_KEY = "in_flight";

export interface UnresolvedState {
  readonly uncertainCount: number;
  readonly reservedCount: number;
}

export interface InFlightLeaseState {
  readonly version: 1;
  readonly leases: readonly InFlightLease[];
}

export type InFlightState = InFlightLeaseState | readonly string[];

export interface AcquireInFlightLeaseInput {
  readonly requestId: string;
  readonly limit: number;
  readonly ttlMs: number;
}

export interface RenewInFlightLeaseInput {
  readonly requestId: string;
  readonly generation: string;
  readonly ttlMs: number;
}

export interface ReleaseInFlightLeaseInput {
  readonly requestId: string;
  readonly generation?: string;
}

interface QuotaStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options?: { readonly prefix?: string }): Promise<Map<string, T>>;
}

export interface QuotaEnvLike {
  readonly QUOTA_LIMIT_STANDARD?: string;
  readonly QUOTA_LIMIT_MINI?: string;
}

export interface QuotaIdentity {
  readonly pool: PoolName;
  readonly utcDay: string;
}

export function resolveLimit(env: QuotaEnvLike, pool: PoolName): number {
  const raw = pool === "STANDARD" ? env.QUOTA_LIMIT_STANDARD : env.QUOTA_LIMIT_MINI;
  const configured = Number(raw);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : POOL_LIMITS[pool];
}

export async function loadPool(
  storage: QuotaStorage,
  env: QuotaEnvLike,
  identity: QuotaIdentity,
): Promise<PoolState> {
  const stored = await storage.get<PoolState>(POOL_KEY);
  if (stored) return stored;

  return {
    utcDay: identity.utcDay,
    limit: resolveLimit(env, identity.pool),
    confirmedTokens: 0,
    reservedTokens: 0,
    uncertainTokens: 0,
    requestCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

export async function savePool(storage: QuotaStorage, state: PoolState): Promise<void> {
  await storage.put(POOL_KEY, { ...state, updatedAt: new Date().toISOString() });
}

export async function getEntry(
  storage: QuotaStorage,
  requestId: string,
): Promise<RequestEntry | undefined> {
  return storage.get<RequestEntry>(`${ENTRY_PREFIX}${requestId}`);
}

export async function putEntry(
  storage: QuotaStorage,
  requestId: string,
  entry: RequestEntry,
): Promise<void> {
  await storage.put(`${ENTRY_PREFIX}${requestId}`, {
    ...entry,
    updatedAt: new Date().toISOString(),
  });
}

export async function getIdempotencyRequestId(
  storage: QuotaStorage,
  idempotencyKey: string,
  clientId?: string,
): Promise<string | undefined> {
  return storage.get<string>(`${IDEMPOTENCY_PREFIX}${clientId ?? "legacy"}:${idempotencyKey}`);
}

export async function putIdempotencyRequestId(
  storage: QuotaStorage,
  idempotencyKey: string,
  requestId: string,
  clientId?: string,
): Promise<void> {
  await storage.put(`${IDEMPOTENCY_PREFIX}${clientId ?? "legacy"}:${idempotencyKey}`, requestId);
}

export async function loadUnresolved(storage: QuotaStorage): Promise<UnresolvedState> {
  return (
    (await storage.get<UnresolvedState>(UNRESOLVED_KEY)) ?? {
      uncertainCount: 0,
      reservedCount: 0,
    }
  );
}

export async function saveUnresolved(
  storage: QuotaStorage,
  state: UnresolvedState,
): Promise<void> {
  await storage.put(UNRESOLVED_KEY, state);
}

export async function loadInFlight(storage: QuotaStorage): Promise<InFlightState> {
  return (await storage.get<InFlightState>(IN_FLIGHT_KEY)) ?? [];
}

export async function saveInFlight(storage: QuotaStorage, state: InFlightLeaseState): Promise<void> {
  await storage.put(IN_FLIGHT_KEY, state);
}

const LEGACY_IN_FLIGHT_GENERATION = "";
const LEGACY_IN_FLIGHT_EXPIRY_MS = Number.MAX_SAFE_INTEGER;

function isLegacyInFlightState(state: InFlightState): state is readonly string[] {
  return Array.isArray(state);
}

function leasesOf(state: InFlightState): readonly InFlightLease[] {
  return isLegacyInFlightState(state)
    ? state.map((requestId) => ({
        requestId,
        generation: LEGACY_IN_FLIGHT_GENERATION,
        expiresAtMs: LEGACY_IN_FLIGHT_EXPIRY_MS,
      }))
    : state.leases;
}

function withoutExpiredLeases(leases: readonly InFlightLease[], nowMs: number): readonly InFlightLease[] {
  return leases.filter((lease) => lease.expiresAtMs > nowMs);
}

function expiresAtMs(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError("In-flight lease TTL must be a positive safe integer.");
  }
  const expiresAt = Date.now() + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new TypeError("In-flight lease expiry must be a safe integer.");
  }
  return expiresAt;
}

export async function acquireInFlightLease(
  storage: QuotaStorage,
  input: AcquireInFlightLeaseInput,
): Promise<AcquireInFlightResult> {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new TypeError("In-flight limit must be a positive safe integer.");
  }
  const leaseExpiresAtMs = expiresAtMs(input.ttlMs);
  const leases = leasesOf(await loadInFlight(storage));
  const activeLeases = withoutExpiredLeases(leases, Date.now());
  if (activeLeases.length !== leases.length) {
    await saveInFlight(storage, { version: 1, leases: activeLeases });
  }
  const activeLease = activeLeases.find((lease) => lease.requestId === input.requestId);
  if (activeLease) return { ok: true, lease: activeLease };
  if (activeLeases.length >= input.limit) return { ok: false, reason: "worker_concurrency_exceeded" };
  const lease: InFlightLease = {
    requestId: input.requestId,
    generation: crypto.randomUUID(),
    expiresAtMs: leaseExpiresAtMs,
  };
  await saveInFlight(storage, { version: 1, leases: [...activeLeases, lease] });
  return { ok: true, lease };
}

export async function renewInFlightLease(
  storage: QuotaStorage,
  input: RenewInFlightLeaseInput,
): Promise<RenewInFlightResult> {
  const leaseExpiresAtMs = expiresAtMs(input.ttlMs);
  const leases = leasesOf(await loadInFlight(storage));
  const activeLeases = withoutExpiredLeases(leases, Date.now());
  if (activeLeases.length !== leases.length) {
    await saveInFlight(storage, { version: 1, leases: activeLeases });
  }
  const activeLease = activeLeases.find((lease) => lease.requestId === input.requestId);
  if (!activeLease) return { ok: false, reason: "lease_not_found" };
  if (activeLease.generation === LEGACY_IN_FLIGHT_GENERATION || activeLease.generation !== input.generation) {
    return { ok: false, reason: "stale_generation" };
  }
  const renewedLease: InFlightLease = { ...activeLease, expiresAtMs: leaseExpiresAtMs };
  await saveInFlight(storage, {
    version: 1,
    leases: activeLeases.map((lease) => lease === activeLease ? renewedLease : lease),
  });
  return { ok: true, lease: renewedLease };
}

export async function releaseInFlightLease(
  storage: QuotaStorage,
  input: ReleaseInFlightLeaseInput,
): Promise<ReleaseInFlightResult> {
  const leases = leasesOf(await loadInFlight(storage));
  const activeLeases = withoutExpiredLeases(leases, Date.now());
  const activeLease = activeLeases.find((lease) => lease.requestId === input.requestId);
  const canRelease = activeLease !== undefined && (
    input.generation === undefined
      ? activeLease.generation === LEGACY_IN_FLIGHT_GENERATION
      : activeLease.generation === input.generation
  );
  const retainedLeases = canRelease
    ? activeLeases.filter((lease) => lease !== activeLease)
    : activeLeases;
  if (retainedLeases.length !== leases.length) {
    await saveInFlight(storage, { version: 1, leases: retainedLeases });
  }
  return { ok: true, released: canRelease };
}
