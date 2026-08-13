import type { RegistryEntry } from "@octg/shared";
import { listRegistryRows } from "./db";
import type { Env } from "./index";

export interface ClientPolicy {
  overflowMode: "REJECT" | "PAID_SHARED";
  outputLimitMode: "REJECT" | "CLAMP";
  maxPaidUsdDay: number;
  cacheEnabled: boolean;
  toolsMode: "REJECT" | "ALLOW";
}

export const DEFAULT_CLIENT_POLICY: ClientPolicy = {
  overflowMode: "REJECT",
  outputLimitMode: "REJECT",
  maxPaidUsdDay: 0,
  cacheEnabled: false,
  toolsMode: "REJECT",
};

const TTL_MS = 60_000;
let registryCache: { map: ReadonlyMap<string, RegistryEntry>; expiresAt: number } | undefined;
const policyCache = new Map<string, { policy: ClientPolicy; expiresAt: number }>();

export function invalidateConfigCaches(): void {
  registryCache = undefined;
  policyCache.clear();
}

export async function loadRegistry(env: Env): Promise<ReadonlyMap<string, RegistryEntry>> {
  const now = Date.now();
  if (registryCache && registryCache.expiresAt > now) return registryCache.map;
  const rows = await listRegistryRows(env);
  const map = new Map(rows.map((row) => [row.model, row]));
  registryCache = { map, expiresAt: now + TTL_MS };
  return map;
}

interface PolicyRow {
  overflow_mode: string;
  output_limit_mode: string;
  max_paid_usd_day: number;
  cache_enabled: number;
  tools_mode: string;
}

export async function loadPolicy(env: Env, clientId: string): Promise<ClientPolicy> {
  const now = Date.now();
  const cached = policyCache.get(clientId);
  if (cached && cached.expiresAt > now) return cached.policy;
  const row = await env.DB.prepare(
    "SELECT overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode FROM client_policies WHERE client_id = ?",
  )
    .bind(clientId)
    .first<PolicyRow>();
  const policy: ClientPolicy = row
    ? {
        overflowMode: row.overflow_mode === "PAID_SHARED" ? "PAID_SHARED" : "REJECT",
        outputLimitMode: row.output_limit_mode === "CLAMP" ? "CLAMP" : "REJECT",
        maxPaidUsdDay: row.max_paid_usd_day,
        cacheEnabled: row.cache_enabled === 1,
        toolsMode: row.tools_mode === "ALLOW" ? "ALLOW" : "REJECT",
      }
    : DEFAULT_CLIENT_POLICY;
  policyCache.set(clientId, { policy, expiresAt: now + TTL_MS });
  return policy;
}
