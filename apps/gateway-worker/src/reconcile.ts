import { quotaIdOf } from "@octg/shared";
import type { Env } from "./index";
import { loadRegistry } from "./policy";

export interface ReconciliationReport { utcDay: string; pool: "STANDARD" | "MINI"; localTokens: number; openaiTokens: number; difference: number; status: "done" | "open"; }
export function targetUtcDay(now: Date): string { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10); }

type UsageResult = { model?: string; input_tokens?: number; output_tokens?: number };
type UsagePage = { data?: Array<{ results?: UsageResult[] }>; has_more?: boolean; next_page?: string | null };

async function fetchUsage(env: Env, day: string): Promise<ReadonlyMap<string, number>> {
  const url = new URL("https://api.openai.com/v1/organization/usage/completions");
  const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  url.searchParams.set("start_time", String(start)); url.searchParams.set("end_time", String(start + 24 * 3600)); url.searchParams.set("bucket_width", "1h"); url.searchParams.set("group_by", "model"); url.searchParams.set("limit", "24");
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

export async function runReconciliation(env: Env, now: Date): Promise<ReconciliationReport[]> {
  const day = targetUtcDay(now); const reports: ReconciliationReport[] = [];
  for (const pool of ["STANDARD", "MINI"] as const) {
    const existing = await env.DB.prepare("SELECT local_tokens AS localTokens, openai_tokens AS openaiTokens, difference, status FROM reconciliations WHERE utc_day = ? AND pool = ?").bind(day, pool).first<ReconciliationReport>();
    if (existing?.status === "done") { reports.push({ utcDay: day, pool, localTokens: existing.localTokens, openaiTokens: existing.openaiTokens, difference: existing.difference, status: existing.status }); continue; }
    const lower = pool.toLowerCase();
    const local = await env.DB.prepare("SELECT COALESCE(SUM(total_tokens), 0) AS total FROM requests WHERE utc_day = ? AND LOWER(pool) = ? AND status = 'completed'").bind(day, lower).first<{ total: number }>();
    const uncertain = await env.DB.prepare("SELECT request_id, COALESCE(reserved_tokens, 0) AS reserved FROM requests WHERE utc_day = ? AND LOWER(pool) = ? AND status = 'uncertain'").bind(day, lower).all<{ request_id: string; reserved: number }>();
    const localTokens = local?.total ?? 0; const usage = await fetchUsage(env, day); const registry = await loadRegistry(env); const openaiTokens = [...registry.entries()].filter(([, entry]) => entry.complimentary_pool === pool).reduce((sum, [model]) => sum + (usage.get(model) ?? 0), 0); const difference = openaiTokens - localTokens;
    let status: "done" | "open" = uncertain.results.length === 0 && difference === 0 ? "done" : "open";
    const uncertainTotal = uncertain.results.reduce((sum, row) => sum + row.reserved, 0);
    if (uncertain.results.length > 0 && difference === uncertainTotal) {
      const stub = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, day)));
      for (const row of uncertain.results) { await stub.reconcileRequest(row.request_id, "consumed"); await env.DB.prepare("UPDATE requests SET status = 'completed', completed_at = ? WHERE request_id = ?").bind(new Date().toISOString(), row.request_id).run(); }
      status = "done";
    }
    await env.DB.prepare("INSERT INTO reconciliations (utc_day, pool, local_tokens, openai_tokens, difference, status, attempts, executed_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(utc_day, pool) DO UPDATE SET local_tokens=excluded.local_tokens, openai_tokens=excluded.openai_tokens, difference=excluded.difference, status=excluded.status, attempts=reconciliations.attempts + 1, executed_at=excluded.executed_at").bind(day, pool, localTokens, openaiTokens, difference, status, new Date().toISOString()).run();
    reports.push({ utcDay: day, pool, localTokens, openaiTokens, difference, status });
  }
  return reports;
}
