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
const MESSAGE_TOOL_KEYS = ["tool_calls", "tool_call_id", "function_call"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasToolUse(body: Record<string, unknown>): boolean {
  if (TOOL_KEYS.some((key) => key in body)) return true;
  const messages = body.messages;
  return Array.isArray(messages) && messages.some((message) =>
    isRecord(message) && MESSAGE_TOOL_KEYS.some((key) => key in message)
  );
}
