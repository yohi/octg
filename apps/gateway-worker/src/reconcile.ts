import { quotaIdOf, type PoolName, type ReconcileDisposition } from "@octg/shared";
import type { Env } from "./index";
import { loadRegistry } from "./policy";

export interface ReconciliationReport { utcDay: string; pool: "STANDARD" | "MINI"; localTokens: number; openaiTokens: number; difference: number; status: "done" | "open"; }
export function targetUtcDay(now: Date): string { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10); }

type UsageResult = { model?: string; input_tokens?: number; output_tokens?: number };
type UsagePage = { data?: Array<{ results?: UsageResult[] }>; has_more?: boolean; next_page?: string | null };

export type ReserveUnknownResolution =
  | { readonly ok: true; readonly applied: boolean; readonly disposition: ReconcileDisposition; readonly reservedTokens: number }
  | { readonly ok: false; readonly reason: "not_found" | "not_reserve_unknown" | "disposition_conflict" };

export async function reconcileReserveUnknown(
  env: Env,
  pool: PoolName,
  utcDay: string,
  requestId: string,
  disposition: ReconcileDisposition,
  evidence?: string,
): Promise<ReserveUnknownResolution> {
  const stub = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, utcDay)));
  const target = await stub.getReconcileRequest(requestId);
  if (!target) return { ok: false, reason: "not_found" };
  const isReserveUnknown = target.uncertaintyOrigin === "reserve_unknown";
  const eligible = target.state === "uncertain" && isReserveUnknown;
  const replayable = isReserveUnknown && (target.state === "reconciled" || target.state === "released") && target.requestedDisposition !== undefined;
  if (!eligible && !replayable) {
    return { ok: false, reason: "not_reserve_unknown" };
  }
  if (replayable && target.requestedDisposition !== disposition) {
    return { ok: false, reason: "disposition_conflict" };
  }
  const result = await stub.reconcileRequest(requestId, disposition);
  const canonicalTarget = await stub.getReconcileRequest(requestId);
  const expectedState = disposition === "consumed" ? "reconciled" : "released";
  if (canonicalTarget?.state !== expectedState || canonicalTarget.requestedDisposition !== disposition) {
    return { ok: false, reason: "disposition_conflict" };
  }
  const completedAt = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE requests SET status = ?, total_tokens = ?, billing_class = ?, reconciliation_evidence = COALESCE(?, reconciliation_evidence), completed_at = ? WHERE request_id = ?",
  )
    .bind(
      disposition === "consumed" ? "completed" : "failed",
      disposition === "consumed" ? canonicalTarget.reservedTokens : 0,
      disposition === "consumed" ? "free" : "none",
      evidence ?? null,
      completedAt,
      requestId,
    )
    .run();
  return { ok: true, applied: result.applied, disposition, reservedTokens: canonicalTarget.reservedTokens };
}

async function fetchUsage(env: Env, day: string): Promise<ReadonlyMap<string, number>> {
  const url = new URL("https://api.openai.com/v1/organization/usage/completions");
  const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  url.searchParams.set("start_time", String(start)); url.searchParams.set("end_time", String(start + 48 * 3600)); url.searchParams.set("bucket_width", "1h"); url.searchParams.set("group_by", "model"); url.searchParams.set("limit", "48");
  if (env.OPENAI_FREE_PROJECT_ID) url.searchParams.set("project_ids", env.OPENAI_FREE_PROJECT_ID);
  const totals = new Map<string, number>();
  do {
    const response = await fetch(url, { headers: { authorization: `Bearer ${env.OPENAI_USAGE_API_KEY ?? ""}` } });
    if (!response.ok) throw new Error(`Usage API ${response.status}`);
    const body = (await response.json()) as UsagePage;
    for (const result of (body.data ?? []).flatMap((group) => group.results ?? [])) {
      const model = result.model ?? "";
      totals.set(model, (totals.get(model) ?? 0) + (result.input_tokens ?? 0) + (result.output_tokens ?? 0));
    }
    if (!body.has_more || !body.next_page) break;
    url.searchParams.set("page", body.next_page);
  } while (true);
  return totals;
}

async function fetchUsageWithRetry(env: Env, day: string): Promise<ReadonlyMap<string, number>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchUsage(env, day);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Usage API failed after three attempts");
}

async function repairConsumedProjection(env: Env, requestId: string, totalTokens: number): Promise<void> {
  await env.DB.prepare("UPDATE requests SET status = 'completed', total_tokens = ?, billing_class = 'free', completed_at = ? WHERE request_id = ?")
    .bind(totalTokens, new Date().toISOString(), requestId)
    .run()
    .catch(() => undefined);
}

export async function runReconciliation(env: Env, now: Date): Promise<ReconciliationReport[]> {
  const day = targetUtcDay(now); const reports: ReconciliationReport[] = [];
  for (const pool of ["STANDARD", "MINI"] as const) {
    const existing = await env.DB.prepare("SELECT local_tokens AS localTokens, openai_tokens AS openaiTokens, difference, status FROM reconciliations WHERE utc_day = ? AND pool = ?").bind(day, pool).first<ReconciliationReport>();
    if (existing?.status === "done") {
      const lower = pool.toLowerCase();
      const completedCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM requests WHERE utc_day = ? AND LOWER(pool) = ? AND status = 'completed'").bind(day, lower).first<{ count: number }>();
      await env.DB.prepare("INSERT INTO daily_usage (utc_day, pool, confirmed_tokens, paid_tokens, request_count) VALUES (?, ?, ?, 0, ?) ON CONFLICT(utc_day, pool) DO UPDATE SET confirmed_tokens = excluded.confirmed_tokens, request_count = excluded.request_count").bind(day, pool, existing.openaiTokens, completedCount?.count ?? 0).run().catch(() => undefined);
      reports.push({ utcDay: day, pool, localTokens: existing.localTokens, openaiTokens: existing.openaiTokens, difference: existing.difference, status: existing.status }); continue;
    }
    const lower = pool.toLowerCase();
    const local = await env.DB.prepare("SELECT COALESCE(SUM(total_tokens), 0) AS total FROM requests WHERE utc_day = ? AND LOWER(pool) = ? AND status = 'completed'").bind(day, lower).first<{ total: number }>();
    const stub = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, day)));
    const pending = await stub.getReconcileSnapshot();
    const initialLocalTokens = local?.total ?? 0; const usage = await fetchUsageWithRetry(env, day); const registry = await loadRegistry(env); const openaiTokens = [...registry.entries()].filter(([, entry]) => entry.complimentary_pool === pool).reduce((sum, [model]) => sum + (usage.get(model) ?? 0), 0); const difference = openaiTokens - initialLocalTokens;
    const uncertainRequests = pending.requests.filter((row) => row.state === "uncertain");
    const reconcilableUncertainRequests = uncertainRequests.filter((row) => row.uncertaintyOrigin !== "reserve_unknown");
    const uncertainTotal = reconcilableUncertainRequests.reduce((sum, row) => sum + row.reservedTokens, 0);
    if (reconcilableUncertainRequests.length > 0 && difference === uncertainTotal) {
      for (const row of reconcilableUncertainRequests) {
        const result = await stub.reconcileRequest(row.requestId, "consumed");
        const reconciledRequest = result.applied
          ? undefined
          : await stub.getReconcileRequest(row.requestId);
        const shouldRepairProjection = result.applied || (
          reconciledRequest?.state === "reconciled" && reconciledRequest.requestedDisposition === "consumed"
        );
        if (shouldRepairProjection) {
          await repairConsumedProjection(env, row.requestId, row.reservedTokens);
        }
      }
    }
    const snapshotRequestIds = new Set(pending.requests.map((row) => row.requestId));
    const candidates = await env.DB.prepare(
      "SELECT request_id AS requestId FROM requests WHERE utc_day = ? AND LOWER(pool) = ? AND status = 'uncertain'",
    ).bind(day, lower).all<{ requestId: string }>();
    for (const candidate of candidates.results) {
      if (snapshotRequestIds.has(candidate.requestId)) continue;
      const canonicalRequest = await stub.getReconcileRequest(candidate.requestId);
      if (
        canonicalRequest?.state === "reconciled" &&
        canonicalRequest.requestedDisposition === "consumed" &&
        canonicalRequest.uncertaintyOrigin !== "reserve_unknown"
      ) {
        await repairConsumedProjection(env, candidate.requestId, canonicalRequest.reservedTokens);
      }
    }
    const remainingPending = (await stub.getReconcileSnapshot()).requests;
    const recomputedLocal = await env.DB.prepare("SELECT COALESCE(SUM(total_tokens), 0) AS total FROM requests WHERE utc_day = ? AND LOWER(pool) = ? AND status = 'completed'").bind(day, lower).first<{ total: number }>();
    const localTokens = recomputedLocal?.total ?? 0;
    const recomputedDifference = openaiTokens - localTokens;
    const status: "done" | "open" = remainingPending.length === 0 && recomputedDifference === 0 ? "done" : "open";
    await env.DB.prepare("INSERT INTO reconciliations (utc_day, pool, local_tokens, openai_tokens, difference, status, attempts, executed_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(utc_day, pool) DO UPDATE SET local_tokens=excluded.local_tokens, openai_tokens=excluded.openai_tokens, difference=excluded.difference, status=excluded.status, attempts=reconciliations.attempts + 1, executed_at=excluded.executed_at").bind(day, pool, localTokens, openaiTokens, recomputedDifference, status, new Date().toISOString()).run();
    const completedCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM requests WHERE utc_day = ? AND LOWER(pool) = ? AND status = 'completed'").bind(day, lower).first<{ count: number }>();
    await env.DB.prepare("INSERT INTO daily_usage (utc_day, pool, confirmed_tokens, paid_tokens, request_count) VALUES (?, ?, ?, 0, ?) ON CONFLICT(utc_day, pool) DO UPDATE SET confirmed_tokens = excluded.confirmed_tokens, request_count = excluded.request_count").bind(day, pool, localTokens, completedCount?.count ?? 0).run();
    reports.push({ utcDay: day, pool, localTokens, openaiTokens, difference: recomputedDifference, status });
  }
  return reports;
}
