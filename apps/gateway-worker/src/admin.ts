import { errorResponse, quotaIdOf, utcDayOf, type OctgHttpError } from "@octg/shared";
import { snapshotOf } from "./proxy";
import { verifyAccessJwt } from "./access";
import { invalidateConfigCaches, loadRegistry } from "./policy";
import { runReconciliation, targetUtcDay } from "./reconcile";
import type { Env } from "./index";

const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
const notFound = (requestId: string): OctgHttpError => ({ status: 404, requestId, body: { error: { message: "Not found.", type: "invalid_request_error", param: null, code: "not_found" }, request_id: requestId } });
const badRequest = (requestId: string, message: string): OctgHttpError => ({ status: 400, requestId, body: { error: { message, type: "invalid_request_error", param: null, code: "invalid_request" }, request_id: requestId } });

type ClientPolicyInput = { overflow_mode: "REJECT" | "PAID_SHARED"; output_limit_mode: "REJECT" | "CLAMP"; max_paid_usd_day: number; cache_enabled: boolean };
type ModelInput = { complimentary_pool: "STANDARD" | "MINI" | "NONE"; enabled: boolean; fallback_model: string | null };
type ClientListRow = { id: string; name: string; enabled: number; created_at: string; overflow_mode: string | null; output_limit_mode: string | null; max_paid_usd_day: number | null; cache_enabled: number | null };
const DEFAULT_CLIENT_POLICY = { overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 0, cache_enabled: true } as const;

function effectiveClientPolicy(row: { overflow_mode: string | null; output_limit_mode: string | null; max_paid_usd_day: number | null; cache_enabled: number | null }): { overflow_mode: "REJECT" | "PAID_SHARED"; output_limit_mode: "REJECT" | "CLAMP"; max_paid_usd_day: number; cache_enabled: boolean } {
  const overflow_mode = row.overflow_mode === "PAID_SHARED" ? "PAID_SHARED" : "REJECT";
  const output_limit_mode = row.output_limit_mode === "CLAMP" ? "CLAMP" : "REJECT";
  const max_paid_usd_day = typeof row.max_paid_usd_day === "number" && Number.isFinite(row.max_paid_usd_day) && row.max_paid_usd_day >= 0 ? row.max_paid_usd_day : 0;
  const cache_enabled = row.cache_enabled === 1 ? true : row.cache_enabled === 0 ? false : DEFAULT_CLIENT_POLICY.cache_enabled;
  return { overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled };
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

async function parseJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try { return parseObject(await request.json()); } catch { return undefined; }
}

function parseClientPolicy(value: Record<string, unknown> | undefined): ClientPolicyInput | undefined {
  if (!value || (value.overflow_mode !== "REJECT" && value.overflow_mode !== "PAID_SHARED") || (value.output_limit_mode !== "REJECT" && value.output_limit_mode !== "CLAMP") || typeof value.max_paid_usd_day !== "number" || !Number.isFinite(value.max_paid_usd_day) || value.max_paid_usd_day < 0 || typeof value.cache_enabled !== "boolean") return undefined;
  return { overflow_mode: value.overflow_mode, output_limit_mode: value.output_limit_mode, max_paid_usd_day: value.max_paid_usd_day, cache_enabled: value.cache_enabled };
}

function parseModel(value: Record<string, unknown> | undefined): ModelInput | undefined {
  if (!value || (value.complimentary_pool !== "STANDARD" && value.complimentary_pool !== "MINI" && value.complimentary_pool !== "NONE") || typeof value.enabled !== "boolean" || (value.fallback_model !== null && typeof value.fallback_model !== "string")) return undefined;
  return { complimentary_pool: value.complimentary_pool, enabled: value.enabled, fallback_model: value.fallback_model };
}

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
    const rows = await env.DB.prepare("SELECT c.id, c.name, c.enabled, c.created_at, p.overflow_mode, p.output_limit_mode, p.max_paid_usd_day, p.cache_enabled FROM clients c LEFT JOIN client_policies p ON c.id = p.client_id ORDER BY c.id").all<ClientListRow>();
    const clients = rows.results.map((row) => ({ id: row.id, name: row.name, enabled: row.enabled === 1, created_at: row.created_at, ...effectiveClientPolicy(row) }));
    return json({ request_id: requestId, clients });
  }
  if (request.method === "GET" && url.pathname === "/admin/models") return json({ request_id: requestId, models: [...(await loadRegistry(env)).values()] });
  const policyMatch = url.pathname.match(/^\/admin\/clients\/([^/]+)\/policy$/);
  if (request.method === "PUT" && policyMatch) {
    const clientId = decodeURIComponent(policyMatch[1]!); if (!(await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(clientId).first())) return errorResponse(notFound(requestId));
    const body = parseClientPolicy(await parseJson(request));
    if (!body) return errorResponse(badRequest(requestId, "Invalid client policy."));
    await env.DB.prepare("INSERT INTO client_policies (client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled) VALUES (?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET overflow_mode=excluded.overflow_mode, output_limit_mode=excluded.output_limit_mode, max_paid_usd_day=excluded.max_paid_usd_day, cache_enabled=excluded.cache_enabled").bind(clientId, body.overflow_mode, body.output_limit_mode, body.max_paid_usd_day, body.cache_enabled ? 1 : 0).run();
    invalidateConfigCaches(); return json({ request_id: requestId, client_id: clientId, updated: true });
  }
  const modelMatch = url.pathname.match(/^\/admin\/models\/([^/]+)$/);
  if (request.method === "PUT" && modelMatch) {
    const model = decodeURIComponent(modelMatch[1]!); const body = parseModel(await parseJson(request));
    if (!body) return errorResponse(badRequest(requestId, "Invalid model configuration."));
    const result = await env.DB.prepare("UPDATE model_registry SET complimentary_pool = ?, enabled = ?, fallback_model = ?, updated_at = ? WHERE model = ?").bind(body.complimentary_pool, body.enabled ? 1 : 0, body.fallback_model, new Date().toISOString(), model).run();
    if (!result.meta.changes) return errorResponse(notFound(requestId)); invalidateConfigCaches(); return json({ request_id: requestId, model, complimentary_pool: body.complimentary_pool });
  }
  if (request.method === "POST" && url.pathname === "/admin/reconcile") {
    try { return json({ request_id: requestId, utc_day: targetUtcDay(new Date()), reports: await runReconciliation(env, new Date()) }); }
    catch { return json({ request_id: requestId, error: { message: "Reconciliation failed.", type: "api_error", param: null, code: "reconciliation_failed" } }, { status: 502 }); }
  }
  return errorResponse(notFound(requestId));
}
