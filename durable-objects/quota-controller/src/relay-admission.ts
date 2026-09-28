import {
  nextUtcMidnight,
  parseIdempotencyKey,
  parseRelayContext,
  parseRelayRequestMeta,
  RELAY_GRANT_CREDENTIAL_TTL_MS,
  remainingOf,
  tierOf,
} from "@octg/shared";
import type {
  InFlightLease,
  PoolState,
  RelayContextV1,
  RelayErrorCode,
  RelayEnvironment,
  RelayQuotaSnapshotV1,
  RelayRequestMetaV1,
  ReserveResult,
} from "@octg/shared";
import {
  FINALIZE_KEY,
  getEntry,
  getIdempotencyRequestId,
  loadInFlight,
  loadPool,
  loadUnresolved,
  normalizeInFlightState,
  putEntry,
  putIdempotencyRequestId,
  saveInFlight,
  savePool,
  saveUnresolved,
  withoutExpiredLeases,
} from "./store";
import type { QuotaEnvLike, QuotaIdentity, QuotaStorage } from "./store";
import {
  getRelayGrant,
  isKeyBindingConsistent,
  isTerminalGrantState,
  matchesRelayAdmission,
  putRelayGrant,
  RELAY_GRANT_AUTHORIZATION_TTL_MS,
  relayGrantRetentionDeadlineMs,
  relayLeaseExpiry,
} from "./relay-grant";
import type { RelayGrant } from "./relay-grant";

/**
 * Transaction-scoped relay admission (SPEC.md section 19.5). The single
 * admitRelay decision path: it validates the verified context/metadata
 * binding, reservation bounds, exact optional raw key and environment, then
 * commits the RequestEntry, pool/unresolved counters, idempotency mapping,
 * generation-bound lease and initial authorized RelayGrant in one call.
 */

export interface RelayAdmissionInput {
  readonly context: RelayContextV1;
  readonly metadata: RelayRequestMetaV1;
  readonly rawIdempotencyKey?: string;
  readonly reservedTokens: number;
  readonly upperBoundTokens: number;
  readonly maxOutputTokens: number;
  readonly cacheEnabled: boolean;
}

export type RelayAdmissionResult =
  | { readonly kind: "admitted"; readonly grant: RelayGrant; readonly quota: RelayQuotaSnapshotV1 }
  | { readonly kind: "denied"; readonly code: RelayErrorCode };

const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 2;

function resolveMaxInFlightRequests(configured: string | undefined): number {
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_IN_FLIGHT_REQUESTS;
}

function resolveRelayEnvironment(configured: string | undefined): RelayEnvironment | undefined {
  return configured === "preview" || configured === "production" ? configured : undefined;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function buildQuotaSnapshot(state: PoolState, identity: QuotaIdentity): RelayQuotaSnapshotV1 {
  return {
    pool: identity.pool,
    limit: state.limit,
    used: state.confirmedTokens + state.reservedTokens + state.uncertainTokens,
    remaining: remainingOf(state),
    resetAt: nextUtcMidnight(new Date(`${identity.utcDay}T00:00:00Z`)),
  };
}

export async function admitRelayInTransaction(
  storage: QuotaStorage,
  env: QuotaEnvLike,
  identity: QuotaIdentity,
  input: RelayAdmissionInput,
  nowMs: number,
): Promise<RelayAdmissionResult> {
  const context = parseRelayContext(input.context);
  const metadata = parseRelayRequestMeta(input.metadata);
  if (context === undefined || metadata === undefined) {
    return { kind: "denied", code: "invalid_request" };
  }
  if (
    !isNonNegativeSafeInteger(input.reservedTokens) ||
    !isNonNegativeSafeInteger(input.upperBoundTokens) ||
    input.upperBoundTokens < input.reservedTokens ||
    !Number.isSafeInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 0
  ) {
    return { kind: "denied", code: "internal_error" };
  }
  const parsedKey = parseIdempotencyKey(input.rawIdempotencyKey);
  if (parsedKey.kind === "invalid") return { kind: "denied", code: "invalid_request" };
  const rawIdempotencyKey = parsedKey.kind === "valid" ? parsedKey.value : undefined;
  const relayEnvironment = resolveRelayEnvironment(env.OCTG_RELAY_ENVIRONMENT);
  if (relayEnvironment === undefined) return { kind: "denied", code: "internal_error" };
  if (context.environment !== relayEnvironment) {
    return { kind: "denied", code: "environment_mismatch" };
  }
  if (!(await isKeyBindingConsistent(context, rawIdempotencyKey))) {
    return { kind: "denied", code: "invalid_request" };
  }

  const mappedRequestId = rawIdempotencyKey !== undefined
    ? await getIdempotencyRequestId(storage, rawIdempotencyKey, context.clientId)
    : undefined;
  if (mappedRequestId !== undefined && mappedRequestId !== context.requestId) {
    const mappedEntry = await getEntry(storage, mappedRequestId);
    if (mappedEntry?.state !== "released") {
      return { kind: "denied", code: "duplicate_idempotency_key" };
    }
  }

  const existingEntry = await getEntry(storage, context.requestId);
  if (existingEntry) {
    const grant = await getRelayGrant(storage, context.requestId);
    if (grant === undefined || !matchesRelayAdmission(grant, context, metadata, input)) {
      return { kind: "denied", code: "invalid_request" };
    }
    if (grant.state === "authorized") {
      const poolState = await loadPool(storage, env, identity);
      return { kind: "admitted", grant, quota: buildQuotaSnapshot(poolState, identity) };
    }
    if (isTerminalGrantState(grant.state)) return { kind: "denied", code: "grant_terminalized" };
    return { kind: "denied", code: "grant_replayed" };
  }

  if (await storage.get<boolean>(FINALIZE_KEY)) {
    return { kind: "denied", code: "insufficient_quota" };
  }

  const poolState = await loadPool(storage, env, identity);
  const remaining = remainingOf(poolState);
  const hasCapacity = input.reservedTokens <= remaining;
  const isStrict = tierOf(remaining, poolState.limit) === "STRICT";
  const fitsStrictBound = input.upperBoundTokens <= remaining;
  if (!hasCapacity || (isStrict && !fitsStrictBound)) {
    return { kind: "denied", code: "insufficient_quota" };
  }

  const maxInFlight = resolveMaxInFlightRequests(env.MAX_IN_FLIGHT_REQUESTS);
  const inFlight = normalizeInFlightState(await loadInFlight(storage), nowMs);
  const activeLeases = withoutExpiredLeases(inFlight.state.leases, nowMs);
  if (inFlight.migrated || activeLeases.length !== inFlight.state.leases.length) {
    await saveInFlight(storage, { version: 1, leases: activeLeases });
  }
  if (activeLeases.length >= maxInFlight) {
    return { kind: "denied", code: "worker_concurrency_exceeded" };
  }

  const resetAt = nextUtcMidnight(new Date(`${identity.utcDay}T00:00:00Z`));
  const reserveResult: ReserveResult = {
    ok: true,
    remaining: remaining - input.reservedTokens,
    resetAt,
  };
  const createdAt = new Date(nowMs).toISOString();
  const unresolved = await loadUnresolved(storage);
  const nextPoolState: PoolState = {
    ...poolState,
    reservedTokens: poolState.reservedTokens + input.reservedTokens,
    requestCount: poolState.requestCount + 1,
  };
  const leaseGeneration = crypto.randomUUID();
  const lease: InFlightLease = {
    requestId: context.requestId,
    generation: leaseGeneration,
    expiresAtMs: relayLeaseExpiry(nowMs),
  };
  const grant: RelayGrant = {
    version: 1,
    requestId: context.requestId,
    grantId: crypto.randomUUID(),
    leaseGeneration,
    environment: context.environment,
    clientId: context.clientId,
    idempotencyKeyHash: context.idempotencyKeyHash,
    nonce: context.nonce,
    model: metadata.model,
    pool: identity.pool,
    admissionUtcDay: identity.utcDay,
    state: "authorized",
    issuedAtMs: nowMs,
    authorizationExpiresAtMs: nowMs + RELAY_GRANT_AUTHORIZATION_TTL_MS,
    credentialExpiresAtMs: nowMs + RELAY_GRANT_CREDENTIAL_TTL_MS,
    retentionDeadlineMs: relayGrantRetentionDeadlineMs(identity.utcDay),
    admission: {
      contextIssuedAtMs: context.issuedAtMs,
      contextExpiresAtMs: context.expiresAtMs,
      metadata,
      reservedTokens: input.reservedTokens,
      upperBoundTokens: input.upperBoundTokens,
      maxOutputTokens: input.maxOutputTokens,
      cacheEnabled: input.cacheEnabled,
    },
    terminalReport: null,
    terminalFingerprint: null,
  };

  await savePool(storage, nextPoolState);
  await putEntry(storage, context.requestId, {
    state: "reserved",
    tokens: input.reservedTokens,
    upperBoundTokens: input.upperBoundTokens,
    reservedTokens: input.reservedTokens,
    ...(rawIdempotencyKey === undefined ? {} : { idempotencyKey: rawIdempotencyKey }),
    results: { reserve: reserveResult },
    createdAt,
    updatedAt: createdAt,
  });
  await saveUnresolved(storage, {
    ...unresolved,
    reservedCount: unresolved.reservedCount + 1,
  });
  if (rawIdempotencyKey !== undefined) {
    await putIdempotencyRequestId(storage, rawIdempotencyKey, context.requestId, context.clientId);
  }
  await saveInFlight(storage, { version: 1, leases: [...activeLeases, lease] });
  await putRelayGrant(storage, grant);
  return { kind: "admitted", grant, quota: buildQuotaSnapshot(nextPoolState, identity) };
}
