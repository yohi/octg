import { isRecord, quotaIdOf } from "@octg/shared";
import type { PoolName, RelayEnvironment } from "@octg/shared";
import type { QuotaController } from "@octg/quota-controller";
import type { Env } from "./index";

const SLOT_PREFIX = "cpu-gate-slot:v1:";
const MAX_CONTROL_BODY_BYTES = 8_192;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function poolOf(value: unknown): PoolName | undefined {
  return value === "STANDARD" || value === "MINI" ? value : undefined;
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function relayEnvironmentOf(env: Env): RelayEnvironment | undefined {
  if (env.OCTG_RELAY_ENVIRONMENT === "preview" || env.OCTG_RELAY_ENVIRONMENT === "production") {
    return env.OCTG_RELAY_ENVIRONMENT;
  }
  return undefined;
}

export function slotStub(env: Env, environment: RelayEnvironment): DurableObjectStub<QuotaController> {
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`${SLOT_PREFIX}${environment}`));
}

export function quotaStub(env: Env, pool: PoolName, day: string): DurableObjectStub<QuotaController> {
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, day)));
}

export async function bodyOf(request: Request): Promise<Record<string, unknown> | undefined> {
  const contentType = request.headers.get("Content-Type");
  if (contentType === null) return undefined;
  const contentTypeParts = contentType.split(";").map((part) => part.trim().toLowerCase());
  if (contentTypeParts[0] !== "application/json" || contentTypeParts.slice(1).some((part) => part !== "charset=utf-8")) return undefined;
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_CONTROL_BODY_BYTES)) return undefined;
  const reader = request.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_CONTROL_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}
