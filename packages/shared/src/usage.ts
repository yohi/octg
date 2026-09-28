import type { Usage } from "./types.ts";

function hasUsageTotal(value: unknown): value is Usage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof Reflect.get(value, "total_tokens") === "number";
}

function findUsage(event: string, pending: unknown[]): Usage | undefined {
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

  return findBalancedUsage(event);
}

function findBalancedUsage(text: string): Usage | undefined {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '"') continue;
    const keyStart = index;
    index += 1;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        break;
      }
    }
    if (index >= text.length) break;

    let key: unknown;
    try {
      key = JSON.parse(text.slice(keyStart, index + 1)) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    if (key !== "usage") continue;

    let valueStart = index + 1;
    while (/\s/.test(text[valueStart] ?? "")) valueStart += 1;
    if (text[valueStart] !== ":") continue;
    valueStart += 1;
    while (/\s/.test(text[valueStart] ?? "")) valueStart += 1;
    if (text[valueStart] !== "{") continue;

    let depth = 0;
    let inString = false;
    escaped = false;
    for (let end = valueStart; end < text.length; end += 1) {
      const character = text[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const usage: unknown = JSON.parse(text.slice(valueStart, end + 1));
          if (hasUsageTotal(usage)) return usage;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          break;
        }
        break;
      }
    }
  }
  return undefined;
}

export function extractUsageFromEvent(event: string): Usage | undefined {
  const pending: unknown[] = [];

  try {
    pending.push(JSON.parse(event) as unknown);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const completeUsage = findUsage(event, pending);
  if (completeUsage !== undefined) return completeUsage;

  const dataLines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  if (dataLines.length > 0) {
    try {
      pending.push(JSON.parse(dataLines.join("\n")) as unknown);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }

  for (const line of event.split(/\r?\n/)) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (data.length === 0 || data === "[DONE]") continue;

    try {
      pending.push(JSON.parse(data) as unknown);
    } catch {
      continue;
    }
  }

  return findUsage(event, pending);
}
