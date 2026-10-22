// allow: SIZE_OK — single-responsibility Durable Object class; the relay change
// adds only the four mandated thin RPC methods (+41 lines) to an already
// 245-LOC legacy class.
import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_IN_FLIGHT_LEASE_TTL_MS,
  nextUtcMidnight,
  parseIdempotencyKey,
  RELAY_REQUEST_ID_PATTERN,
  remainingOf,
  tierOf,
} from "@octg/shared";
import type {
  RelayCpuGateFenceResult,
  RelayCpuGateGrantInspection,
  RelayCpuGateSlotClaimResult,
  RelayCpuGateSlotCloseResult,
  RelayCpuGateSlotOwner,
  RelayCpuGateSlotState,
  RelayCpuGateSnapshot,
} from "@octg/shared";
import type {
  AcquireInFlightResult,
  FinalizeResult,
  MarkReserveOutcomeUnknownResult,
  MarkUncertainResult,
  QuotaView,
  ReconcileSnapshot,
  ReconcileRequestView,
  ReconcileDisposition,
  ReconcileResult,
  ReleaseInFlightResult,
  ReleaseResult,
  ReserveResult,
  RenewInFlightResult,
  SettleResult,
} from "@octg/shared";
import { QuotaLifecycle } from "./quota-lifecycle";
import {
  acquireInFlightLease,
  getEntry,
  getIdempotencyRequestId,
  FINALIZE_KEY,
  loadPool,
  loadUnresolved,
  putEntry,
  putIdempotencyRequestId,
  releaseInFlightLease,
  renewInFlightLease,
  savePool,
  saveUnresolved,
} from "./store";
import type { QuotaIdentity, QuotaStorage } from "./store";
import { admitRelayInTransaction } from "./relay-admission";
import type { RelayAdmissionInput, RelayAdmissionResult } from "./relay-admission";
import {
  activateRelayInTransaction,
  finishRelayInTransaction,
  renewRelayInTransaction,
} from "./relay-grant-lifecycle";
import type { RelayGrantOperationContext } from "./relay-grant-lifecycle";
import {
  fenceRelayCpuGateSetup,
  getRelayCpuGateGrantInspection,
  getRelayCpuGateSnapshot,
} from "./relay-cpu-gate";
import {
  claimRelayCpuGateSlot,
  closeRelayCpuGateSlot,
  getRelayCpuGateSlot,
  isCpuGateSlotName,
} from "./relay-cpu-gate-slot";
import type { CpuGateSlotIdentity } from "./relay-cpu-gate-slot";
import type {
  ActivateRelayResult,
  FinishRelayInput,
  FinishRelayResult,
  RelayGrantBinding,
  RenewRelayResult,
} from "./relay-grant";

export interface QuotaControllerEnv {
  readonly QUOTA_LIMIT_STANDARD?: string;
  readonly QUOTA_LIMIT_MINI?: string;
  readonly MAX_IN_FLIGHT_REQUESTS?: string;
  readonly OCTG_RELAY_ENVIRONMENT?: string;
  readonly QUOTA_CONTROLLER: DurableObjectNamespace<QuotaController>;
  readonly OCTG_RELAY_CPU_GATE_STANDARD_CLIENT_ID?: string;
  readonly OCTG_RELAY_CPU_GATE_STANDARD_MODEL?: string;
  readonly OCTG_RELAY_CPU_GATE_MINI_CLIENT_ID?: string;
  readonly OCTG_RELAY_CPU_GATE_MINI_MODEL?: string;
}

export class QuotaController extends DurableObject<QuotaControllerEnv> {
  private get identity(): QuotaIdentity {
    const parts = this.ctx.id.name?.split(":") ?? [];
    const [prefix, pool, utcDay] = parts;
    if (
      parts.length !== 3 ||
      prefix !== "quota" ||
      (pool !== "STANDARD" && pool !== "MINI") ||
      utcDay === undefined ||
      utcDay.length === 0
    ) {
      throw new TypeError("QuotaController requires a quota:{POOL}:{UTC_DAY} name.");
    }

    const hasAsciiUtcDayFormat =
      utcDay.length === 10 && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(utcDay);
    if (!hasAsciiUtcDayFormat) {
      throw new TypeError("QuotaController requires a quota:{POOL}:{UTC_DAY} name.");
    }

    const date = new Date(`${utcDay}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== utcDay) {
      throw new TypeError("QuotaController requires a quota:{POOL}:{UTC_DAY} name.");
    }

    return { pool, utcDay };
  }

  async reserve(
    requestId: string,
    tokens: number,
    upperBoundTokens: number,
    idempotencyKey?: string,
    clientId?: string,
  ): Promise<ReserveResult> {
    this.assertQuotaIdentity();
    if (
      !Number.isSafeInteger(tokens) ||
      tokens < 0 ||
      !Number.isSafeInteger(upperBoundTokens) ||
      upperBoundTokens < 0 ||
      upperBoundTokens < tokens
    ) {
      throw new TypeError("Reservation tokens and upper bound must be non-negative integers.");
    }
    const parsedIdempotencyKey = parseIdempotencyKey(idempotencyKey);
    if (parsedIdempotencyKey.kind === "invalid") {
      throw new TypeError("Idempotency-Key must be at most 255 UTF-8 bytes.");
    }
    const normalizedIdempotencyKey = parsedIdempotencyKey.kind === "valid"
      ? parsedIdempotencyKey.value
      : undefined;

    const { pool, utcDay } = this.identity;
    const resetAt = nextUtcMidnight(new Date(`${utcDay}T00:00:00Z`));

    return this.ctx.storage.transaction(async (storage) => {
      const idempotencyRequestId = normalizedIdempotencyKey !== undefined
        ? await getIdempotencyRequestId(storage, normalizedIdempotencyKey, clientId)
        : undefined;
      const mappedEntry = idempotencyRequestId === undefined
        ? undefined
        : await getEntry(storage, idempotencyRequestId);
      const entryRequestId = mappedEntry?.state === "released"
        ? requestId
        : (idempotencyRequestId ?? requestId);
      const existing = await getEntry(storage, entryRequestId);
      if (existing) {
        if (
          idempotencyRequestId !== undefined &&
          existing.state !== "released" &&
          idempotencyRequestId !== requestId
        ) {
          return {
            ok: false,
            reason: "duplicate_idempotency_key",
            requestId: entryRequestId,
            resetAt,
          };
        }
        if (
          existing.tokens !== tokens ||
          existing.upperBoundTokens !== upperBoundTokens
        ) {
          throw new TypeError(
            `Request ${entryRequestId} parameters do not match the saved request.`,
          );
        }
        const result = existing.results.reserve;
        if (result) return result;
        throw new TypeError(`Request ${entryRequestId} has no saved reserve result.`);
      }

      if (await storage.get<boolean>(FINALIZE_KEY)) {
        return { ok: false, reason: "insufficient_quota", remaining: 0, resetAt };
      }

      const state = await loadPool(storage, this.env, { pool, utcDay });
      const remaining = remainingOf(state);
      const hasCapacity = tokens <= remaining;
      const isStrict = tierOf(remaining, state.limit) === "STRICT";
      const fitsStrictBound = upperBoundTokens <= remaining;
      if (!hasCapacity || (isStrict && !fitsStrictBound)) {
        return { ok: false, reason: "insufficient_quota", remaining, resetAt };
      }

      const result: ReserveResult = {
        ok: true,
        remaining: remaining - tokens,
        resetAt,
      };
      const now = new Date().toISOString();
      const unresolved = await loadUnresolved(storage);
      await savePool(storage, {
        ...state,
        reservedTokens: state.reservedTokens + tokens,
        requestCount: state.requestCount + 1,
      });
      await putEntry(storage, requestId, {
        state: "reserved",
        tokens,
        upperBoundTokens,
        reservedTokens: tokens,
        ...(normalizedIdempotencyKey === undefined ? {} : { idempotencyKey: normalizedIdempotencyKey }),
        results: { reserve: result },
        createdAt: now,
        updatedAt: now,
      });
      await saveUnresolved(storage, {
        ...unresolved,
        reservedCount: unresolved.reservedCount + 1,
      });
      if (normalizedIdempotencyKey !== undefined) {
        await putIdempotencyRequestId(storage, normalizedIdempotencyKey, requestId, clientId);
      }
      return result;
    });
  }

  async settle(requestId: string, actualTokens: number): Promise<SettleResult> {
    this.assertQuotaIdentity();
    if (!Number.isSafeInteger(actualTokens) || actualTokens < 0) {
      throw new TypeError("Actual tokens must be a non-negative safe integer.");
    }
    return this.lifecycle.settle(requestId, actualTokens);
  }

  async markUncertain(requestId: string): Promise<MarkUncertainResult> {
    this.assertQuotaIdentity();
    return this.lifecycle.markUncertain(requestId);
  }

  async markReserveOutcomeUnknown(requestId: string): Promise<MarkReserveOutcomeUnknownResult> {
    this.assertQuotaIdentity();
    return this.lifecycle.markReserveOutcomeUnknown(requestId);
  }

  async release(requestId: string): Promise<ReleaseResult> {
    this.assertQuotaIdentity();
    return this.lifecycle.release(requestId);
  }

  async acquireInFlight(
    requestId: string,
    limit: number,
    ttlMs = DEFAULT_IN_FLIGHT_LEASE_TTL_MS,
  ): Promise<AcquireInFlightResult> {
    this.assertQuotaIdentity();
    return this.ctx.storage.transaction((storage) =>
      acquireInFlightLease(storage, { requestId, limit, ttlMs }),
    );
  }

  async renewInFlight(
    requestId: string,
    generation: string,
    ttlMs = DEFAULT_IN_FLIGHT_LEASE_TTL_MS,
  ): Promise<RenewInFlightResult> {
    this.assertQuotaIdentity();
    return this.ctx.storage.transaction((storage) =>
      renewInFlightLease(storage, { requestId, generation, ttlMs }),
    );
  }

  async admitRelay(input: RelayAdmissionInput): Promise<RelayAdmissionResult> {
    this.assertQuotaIdentity();
    return this.ctx.storage.transaction((storage) =>
      admitRelayInTransaction(storage, this.env, this.identity, input, Date.now()),
    );
  }

  async activateRelay(input: RelayGrantBinding): Promise<ActivateRelayResult> {
    this.assertQuotaIdentity();
    return this.ctx.storage.transaction((storage) =>
      activateRelayInTransaction(this.relayContext(storage), input),
    );
  }

  async renewRelay(input: RelayGrantBinding): Promise<RenewRelayResult> {
    this.assertQuotaIdentity();
    return this.ctx.storage.transaction((storage) =>
      renewRelayInTransaction(this.relayContext(storage), input),
    );
  }

  async finishRelay(input: FinishRelayInput): Promise<FinishRelayResult> {
    this.assertQuotaIdentity();
    return this.ctx.storage.transaction((storage) =>
      finishRelayInTransaction(this.relayContext(storage), input),
    );
  }

  async releaseInFlight(
    requestId: string,
    generation?: string,
  ): Promise<ReleaseInFlightResult> {
    this.assertQuotaIdentity();
    return this.ctx.storage.transaction((storage) =>
      releaseInFlightLease(storage, { requestId, generation }),
    );
  }

  async reconcileRequest(
    requestId: string,
    disposition: ReconcileDisposition,
  ): Promise<ReconcileResult> {
    this.assertQuotaIdentity();
    if (disposition !== "consumed" && disposition !== "unused") {
      throw new TypeError("Reconcile disposition must be consumed or unused.");
    }
    return this.lifecycle.reconcileRequest(requestId, disposition);
  }

  async getReconcileSnapshot(): Promise<ReconcileSnapshot> {
    this.assertQuotaIdentity();
    return this.lifecycle.getReconcileSnapshot();
  }

  async getReconcileRequest(requestId: string): Promise<ReconcileRequestView | undefined> {
    this.assertQuotaIdentity();
    return this.lifecycle.getReconcileRequest(requestId);
  }

  async finalizeDay(): Promise<FinalizeResult> {
    this.assertQuotaIdentity();
    return this.lifecycle.finalizeDay();
  }

  private get lifecycle(): QuotaLifecycle {
    return new QuotaLifecycle({
      storage: this.ctx.storage,
      env: this.env,
      quotaId: this.ctx.id.name,
      identityOf: () => this.identity,
    });
  }

  private relayContext(storage: QuotaStorage): RelayGrantOperationContext {
    const identity = this.identity;
    return { storage, env: this.env, identity, nowMs: Date.now() };
  }

  async getState(): Promise<QuotaView> {
    const { pool, utcDay } = this.assertQuotaIdentity();
    const state = await loadPool(this.ctx.storage, this.env, { pool, utcDay });
    return { ...state, pool, remaining: remainingOf(state) };
  }

  async getRelayCpuGateSnapshot(): Promise<RelayCpuGateSnapshot> {
    const identity = this.assertQuotaIdentity();
    return getRelayCpuGateSnapshot(this.ctx.storage, this.env, identity, Date.now());
  }

  async getRelayCpuGateGrantInspection(requestId: string): Promise<RelayCpuGateGrantInspection> {
    const identity = this.assertQuotaIdentity();
    if (!RELAY_REQUEST_ID_PATTERN.test(requestId)) throw new TypeError("CPU-gate request ID is invalid.");
    return getRelayCpuGateGrantInspection(this.ctx.storage, this.env, identity, requestId, Date.now());
  }

  async fenceRelayCpuGateSetup(requestId: string): Promise<RelayCpuGateFenceResult> {
    const identity = this.assertQuotaIdentity();
    if (!RELAY_REQUEST_ID_PATTERN.test(requestId)) throw new TypeError("CPU-gate request ID is invalid.");
    return this.ctx.storage.transaction((storage) =>
      fenceRelayCpuGateSetup(storage, this.env, identity, requestId, Date.now()),
    );
  }

  async getRelayCpuGateSlot(): Promise<RelayCpuGateSlotState> {
    return getRelayCpuGateSlot(this.cpuGateSlotIdentity);
  }

  async claimRelayCpuGateSlot(owner: RelayCpuGateSlotOwner): Promise<RelayCpuGateSlotClaimResult> {
    return claimRelayCpuGateSlot(this.cpuGateSlotIdentity, owner);
  }

  async closeRelayCpuGateSlot(
    owner: RelayCpuGateSlotOwner,
    generation: number,
  ): Promise<RelayCpuGateSlotCloseResult> {
    return closeRelayCpuGateSlot(this.cpuGateSlotIdentity, owner, generation);
  }

  private get cpuGateSlotIdentity(): CpuGateSlotIdentity {
    const idName = this.ctx.id.name;
    if (!isCpuGateSlotName(idName, this.env.OCTG_RELAY_ENVIRONMENT)) {
      throw new TypeError("CPU-gate slot RPC requires the environment-local singleton identity.");
    }
    return { idName, env: this.env, storage: this.ctx.storage };
  }

  private assertQuotaIdentity(): QuotaIdentity {
    return this.identity;
  }
}
