import type { RegistryEntry } from "@octg/shared";
import type { Env } from "./index";

export interface RequestLogRow {
  requestId: string;
  utcDay: string;
  clientId: string;
  requestedModel: string | null;
  upstreamModel: string | null;
  pool: string | null;
  eligibility: string | null;
  reservedTokens: number | null;
}

export async function insertRequestRow(env: Env, row: RequestLogRow): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO requests (request_id, utc_day, client_id, requested_model, upstream_model, pool, eligibility, reserved_tokens, status, started_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_flight', ?) ON CONFLICT(request_id) DO NOTHING",
  )
    .bind(
      row.requestId,
      row.utcDay,
      row.clientId,
      row.requestedModel,
      row.upstreamModel,
      row.pool,
      row.eligibility,
      row.reservedTokens,
      new Date().toISOString(),
    )
    .run();
}

export interface RequestCompleteFields {
  status: "completed" | "failed" | "uncertain" | "orphaned";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  billingClass?: "free" | "paid" | "none";
  openaiRequestId?: string;
}

export async function completeRequestRow(env: Env, requestId: string, fields: RequestCompleteFields): Promise<void> {
  await env.DB.prepare(
    "UPDATE requests SET status = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?, billing_class = ?, openai_request_id = ?, completed_at = ? WHERE request_id = ?",
  )
    .bind(
      fields.status,
      fields.inputTokens ?? null,
      fields.outputTokens ?? null,
      fields.totalTokens ?? null,
      fields.billingClass ?? null,
      fields.openaiRequestId ?? null,
      new Date().toISOString(),
      requestId,
    )
    .run();
}

export async function listRegistryRows(env: Env): Promise<RegistryEntry[]> {
  const result = await env.DB.prepare(
    "SELECT model, provider, complimentary_pool, enabled, fallback_model FROM model_registry",
  ).all<Omit<RegistryEntry, "enabled"> & { enabled: number }>();
  return result.results.map((row) => ({ ...row, enabled: row.enabled === 1 }));
}
