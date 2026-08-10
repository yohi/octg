import { quotaIdOf } from "@octg/shared";
import { runReconciliation, targetUtcDay } from "./reconcile";
import type { Env } from "./index";

export async function runScheduled(env: Env, now: Date): Promise<void> {
  const target = targetUtcDay(now); await runReconciliation(env, now);
  const horizon = targetUtcDay(new Date(`${target}T00:00:00Z`));
  const rows = await env.DB.prepare("SELECT utc_day, pool FROM reconciliations WHERE utc_day <= ? AND status = 'done'").bind(horizon).all<{ utc_day: string; pool: "STANDARD" | "MINI" }>();
  for (const row of rows.results) {
    const result = await env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(row.pool, row.utc_day))).finalizeDay();
    if (result.ok) await env.DB.prepare("UPDATE reconciliations SET status = 'deleted', executed_at = ? WHERE utc_day = ? AND pool = ?").bind(new Date().toISOString(), row.utc_day, row.pool).run();
  }
}
