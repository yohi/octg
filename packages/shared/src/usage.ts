import type { Usage } from "./types.ts";

function hasUsageTotal(value: unknown): value is Usage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof Reflect.get(value, "total_tokens") === "number";
}

export function extractUsageFromEvent(event: string): Usage | undefined {
  const pending: unknown[] = [];

  for (const line of event.split(/\r?\n/)) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (data.length === 0 || data === "[DONE]") continue;

    try {
      pending.push(JSON.parse(data) as unknown);
    } catch {
      continue;
    }
  }

  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (typeof value !== "object" || value === null) continue;

    const usage = Reflect.get(value, "usage");
    if (hasUsageTotal(usage)) return usage;
    pending.push(...Object.values(value));
  }

  return undefined;
}
