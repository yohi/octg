import type { PoolName } from "@octg/shared";

const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 2;

export interface RelayCpuGateFixtureEnv {
  readonly OCTG_RELAY_CPU_GATE_STANDARD_CLIENT_ID?: string;
  readonly OCTG_RELAY_CPU_GATE_STANDARD_MODEL?: string;
  readonly OCTG_RELAY_CPU_GATE_MINI_CLIENT_ID?: string;
  readonly OCTG_RELAY_CPU_GATE_MINI_MODEL?: string;
}

export function resolveMaxInFlightRequests(value?: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_IN_FLIGHT_REQUESTS;
}

export function resolveCpuGateFixtureIdentity(
  env: RelayCpuGateFixtureEnv,
  pool: PoolName,
): { readonly clientId: string; readonly model: string } | undefined {
  const clientId = pool === "STANDARD"
    ? env.OCTG_RELAY_CPU_GATE_STANDARD_CLIENT_ID
    : env.OCTG_RELAY_CPU_GATE_MINI_CLIENT_ID;
  const model = pool === "STANDARD"
    ? env.OCTG_RELAY_CPU_GATE_STANDARD_MODEL
    : env.OCTG_RELAY_CPU_GATE_MINI_MODEL;
  return clientId && model ? { clientId, model } : undefined;
}
