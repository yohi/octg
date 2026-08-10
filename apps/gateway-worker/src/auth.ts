import { errClientDisabled, errInvalidApiKey, type OctgHttpError } from "@octg/shared";
import { hashClientKey } from "./crypto";
import type { Env } from "./index";

export interface ClientContext {
  id: string;
  name: string;
}

interface ClientRow {
  id: string;
  name: string;
  enabled: number;
}

export async function authenticate(
  request: Request,
  env: Env,
  requestId?: string,
): Promise<ClientContext | OctgHttpError> {
  const id = requestId ?? crypto.randomUUID();
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer octg_sk_")) return errInvalidApiKey(id);
  const rawKey = header.slice("Bearer ".length);
  const keyHash = await hashClientKey(rawKey, env.OCTG_KEY_PEPPER);
  const row = await env.DB.prepare("SELECT id, name, enabled FROM clients WHERE key_hash = ?")
    .bind(keyHash)
    .first<ClientRow>();
  if (!row) return errInvalidApiKey(id);
  if (!row.enabled) return errClientDisabled(id);
  return { id: row.id, name: row.name };
}
