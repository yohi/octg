import { POOL_LIMITS } from "@octg/shared";
import type { PoolName, PoolState, RequestEntry } from "@octg/shared";

export const POOL_KEY = "pool";
export const ENTRY_PREFIX = "req:";
export const UNRESOLVED_KEY = "unresolved";

export interface UnresolvedState {
  readonly uncertainCount: number;
  readonly reservedCount: number;
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
