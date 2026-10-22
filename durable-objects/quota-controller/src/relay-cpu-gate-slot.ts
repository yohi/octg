import { RELAY_REQUEST_ID_PATTERN } from "@octg/shared";
import type {
  RelayCpuGateSlotClaimResult,
  RelayCpuGateSlotCloseResult,
  RelayCpuGateSlotOwner,
  RelayCpuGateSlotState,
} from "@octg/shared";
import type { QuotaControllerEnv } from "./quota-controller";

export const CPU_GATE_SLOT_PREFIX = "cpu-gate-slot:v1:";
const SLOT_KEY = "cpu-gate-slot:v1:state";
const GENERATION_KEY = "cpu-gate-slot:v1:generation";

export interface CpuGateSlotIdentity {
  readonly idName: string | undefined;
  readonly env: QuotaControllerEnv;
  readonly storage: DurableObjectStorage;
}

export function isCpuGateSlotName(idName: string | undefined, environment: string | undefined): boolean {
  return environment !== undefined && (environment === "preview" || environment === "production") &&
    idName === `${CPU_GATE_SLOT_PREFIX}${environment}`;
}

export async function getRelayCpuGateSlot(identity: CpuGateSlotIdentity): Promise<RelayCpuGateSlotState> {
  assertSlotIdentity(identity);
  return (await identity.storage.get<RelayCpuGateSlotState>(SLOT_KEY)) ?? { kind: "idle" };
}

export async function claimRelayCpuGateSlot(
  identity: CpuGateSlotIdentity,
  owner: RelayCpuGateSlotOwner,
): Promise<RelayCpuGateSlotClaimResult> {
  assertSlotIdentity(identity);
  assertOwner(owner);
  return identity.storage.transaction(async (storage) => {
    const current = await storage.get<RelayCpuGateSlotState>(SLOT_KEY) ?? { kind: "idle" as const };
    if (current.kind !== "idle") {
      return current.kind === "held" && current.owner.pool === owner.pool &&
          current.owner.requestId === owner.requestId
        ? { kind: "claimed", slot: current }
        : { kind: "busy" };
    }
    const generation = (await storage.get<number>(GENERATION_KEY) ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new RangeError("CPU-gate slot generation exhausted.");
    const slot = { kind: "held" as const, owner, generation };
    await storage.put(GENERATION_KEY, generation);
    await storage.put(SLOT_KEY, slot);
    return { kind: "claimed", slot };
  });
}

export async function closeRelayCpuGateSlot(
  identity: CpuGateSlotIdentity,
  owner: RelayCpuGateSlotOwner,
  generation: number,
): Promise<RelayCpuGateSlotCloseResult> {
  assertSlotIdentity(identity);
  assertOwner(owner);
  if (!Number.isSafeInteger(generation) || generation < 1) return { kind: "blocked" };
  const marked = await identity.storage.transaction(async (storage) => {
    const current = await storage.get<RelayCpuGateSlotState>(SLOT_KEY) ?? { kind: "idle" as const };
    if (current.kind === "idle") return { kind: "idle" as const };
    if (!matchesOwner(current.owner, owner) || current.generation !== generation) {
      return { kind: "blocked" as const };
    }
    if (current.kind === "held") {
      const closing = { ...current, kind: "closing" as const };
      await storage.put(SLOT_KEY, closing);
      return { kind: "closing" as const };
    }
    return { kind: "closing" as const };
  });
  if (marked.kind === "idle") return { kind: "closed" };
  if (marked.kind === "blocked") return { kind: "blocked" };

  const targetDay = requestDay(owner.requestId);
  if (targetDay === undefined) return { kind: "blocked" };
  const target = identity.env.QUOTA_CONTROLLER.get(
    identity.env.QUOTA_CONTROLLER.idFromName(`quota:${owner.pool}:${targetDay}`),
  );
  const fence = await target.fenceRelayCpuGateSetup(owner.requestId);
  const inspection = await target.getRelayCpuGateGrantInspection(owner.requestId);
  const proof = fence.kind === "fenced" && inspection.kind === "absent" && inspection.fenced ||
    fence.kind === "fixture" && inspection.kind === "fixture" && !inspection.activeLease &&
      (inspection.state === "settled" && inspection.requestState === "settled" ||
        inspection.state === "released" && inspection.requestState === "released" ||
        inspection.state === "reconciled_consumed" && inspection.requestState === "settled" ||
        inspection.state === "reconciled_unused" && inspection.requestState === "released");
  if (!proof) return { kind: "blocked" };
  return identity.storage.transaction(async (storage) => {
    const current = await storage.get<RelayCpuGateSlotState>(SLOT_KEY);
    if (current?.kind !== "closing" || current.generation !== generation || !matchesOwner(current.owner, owner)) {
      return { kind: "blocked" };
    }
    await storage.delete(SLOT_KEY);
    return { kind: "closed" };
  });
}

function assertSlotIdentity(identity: CpuGateSlotIdentity): void {
  if (!isCpuGateSlotName(identity.idName, identity.env.OCTG_RELAY_ENVIRONMENT)) {
    throw new TypeError("CPU-gate slot RPC requires the environment-local singleton identity.");
  }
}

function assertOwner(owner: RelayCpuGateSlotOwner): void {
  if ((owner.pool !== "STANDARD" && owner.pool !== "MINI") || !RELAY_REQUEST_ID_PATTERN.test(owner.requestId)) {
    throw new TypeError("CPU-gate slot owner is invalid.");
  }
}

function matchesOwner(left: RelayCpuGateSlotOwner, right: RelayCpuGateSlotOwner): boolean {
  return left.pool === right.pool && left.requestId === right.requestId;
}

function requestDay(requestId: string): string | undefined {
  if (!RELAY_REQUEST_ID_PATTERN.test(requestId)) return undefined;
  const timestamp = requestId.slice(4, 14);
  let milliseconds = 0;
  for (const character of timestamp) {
    const digit = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".indexOf(character);
    if (digit < 0 || milliseconds > Number.MAX_SAFE_INTEGER / 32) return undefined;
    milliseconds = milliseconds * 32 + digit;
  }
  if (milliseconds > 281_474_976_710_655) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}
