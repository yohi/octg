import type { PoolName } from "./types";

export interface RegistryEntry {
  model: string;
  provider: string;
  complimentary_pool: PoolName | "NONE";
  enabled: boolean;
  fallback_model: string | null;
}

export function classifyModel(
  model: string,
  registry: ReadonlyMap<string, RegistryEntry>,
): PoolName | "NONE" {
  const entry = registry.get(model);
  if (!entry || !entry.enabled) return "NONE";
  return entry.complimentary_pool;
}

const TOOL_KEYS = ["tools", "tool_choice", "functions", "function_call"] as const;

export function hasToolUse(body: Record<string, unknown>): boolean {
  return TOOL_KEYS.some((key) => key in body);
}
