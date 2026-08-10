import { errorResponse, quotaIdOf, utcDayOf, type OctgHttpError } from "@octg/shared";
import { snapshotOf } from "./proxy";
import { verifyAccessJwt } from "./access";
import { invalidateConfigCaches, loadRegistry } from "./policy";
import { runReconciliation, targetUtcDay } from "./reconcile";
import type { Env } from "./index";

const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
const notFound = (requestId: string): OctgHttpError => ({ status: 404, requestId, body: { error: { message: "Not found.", type: "invalid_request_error", param: null, code: "not_found" }, request_id: requestId } });

export async function handleAdmin(request: Request, env: Env, requestId: string): Promise<Response | undefined> {
  const url = new URL(request.url); if (!url.pathname.startsWith("/admin/")) return undefined;
  const verified = await verifyAccessJwt(request, env, requestId); if (verified !== true) return errorResponse(verified);
  const day = utcDayOf(new Date());
  if (request.method === "GET" && url.pathname === "/admin/quota") {
    const view = async (pool: "STANDARD" | "MINI") => snapshotOf(await env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, day))).getState());
    return json({ request_id: requestId, utc_day: day, pools: { standard: await view("STANDARD"), mini: await view("MINI") } });
  }
  if (request.method === "GET" && url.pathname === "/admin/usage") {
    const rows = await env.DB.prepare("SELECT client_id, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens FROM requests WHERE utc_day = ? AND status = 'completed' GROUP BY client_id").bind(day).all();
    return json({ request_id: requestId, utc_day: day, clients: rows.results });
  }
  if (request.method === "GET" && url.pathname === "/admin/clients") {
    const rows = await env.DB.prepare("SELECT id, name, enabled, created_at FROM clients ORDER BY id").all();
    return json({ request_id: requestId, clients: rows.results });
  }
  if (request.method === "GET" && url.pathname === "/admin/models") return json({ request_id: requestId, models: [...(await loadRegistry(env)).values()] });
  const policyMatch = url.pathname.match(/^\/admin\/clients\/([^/]+)\/policy$/);
  if (request.method === "PUT" && policyMatch) {
    const clientId = decodeURIComponent(policyMatch[1]!); if (!(await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(clientId).first())) return errorResponse(notFound(requestId));
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    await env.DB.prepare("INSERT INTO client_policies (client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled) VALUES (?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET overflow_mode=excluded.overflow_mode, output_limit_mode=excluded.output_limit_mode, max_paid_usd_day=excluded.max_paid_usd_day, cache_enabled=excluded.cache_enabled").bind(clientId, body?.overflow_mode === "PAID_SHARED" ? "PAID_SHARED" : "REJECT", body?.output_limit_mode === "CLAMP" ? "CLAMP" : "REJECT", typeof body?.max_paid_usd_day === "number" ? body.max_paid_usd_day : 0, body?.cache_enabled === true ? 1 : 0).run();
    invalidateConfigCaches(); return json({ request_id: requestId, client_id: clientId, updated: true });
  }
  const modelMatch = url.pathname.match(/^\/admin\/models\/([^/]+)$/);
  if (request.method === "PUT" && modelMatch) {
    const model = decodeURIComponent(modelMatch[1]!); const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const pool = body?.complimentary_pool === "STANDARD" || body?.complimentary_pool === "MINI" ? body.complimentary_pool : "NONE";
    const result = await env.DB.prepare("UPDATE model_registry SET complimentary_pool = ?, enabled = ?, fallback_model = ?, updated_at = ? WHERE model = ?").bind(pool, body?.enabled === false ? 0 : 1, typeof body?.fallback_model === "string" ? body.fallback_model : null, new Date().toISOString(), model).run();
    if (!result.meta.changes) return errorResponse(notFound(requestId)); invalidateConfigCaches(); return json({ request_id: requestId, model, complimentary_pool: pool });
  }
  if (request.method === "POST" && url.pathname === "/admin/reconcile") {
    try { return json({ request_id: requestId, utc_day: targetUtcDay(new Date()), reports: await runReconciliation(env, new Date()) }); }
    catch { return json({ request_id: requestId, error: { message: "Reconciliation failed.", type: "api_error", param: null, code: "reconciliation_failed" } }, { status: 502 }); }
  }
  return errorResponse(notFound(requestId));
}
