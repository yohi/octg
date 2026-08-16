import { QuotaController } from "@octg/quota-controller";
import { handleProxy } from "./proxy";
import { handleModels } from "./models";
import { handleQuota } from "./quota-api";
import { errInternal, errorResponse } from "@octg/shared";
import { ulid } from "ulid";
import { handleAdmin } from "./admin";
import { runScheduled } from "./scheduled";

export { QuotaController };

export interface Env {
  readonly QUOTA_CONTROLLER: DurableObjectNamespace<QuotaController>;
  readonly DB: D1Database;
  readonly CF_VERSION_METADATA: WorkerVersionMetadata;
  readonly OCTG_KEY_PEPPER: string;
  readonly OCTG_UPSTREAM_BASE_URL: string;
  readonly OCTG_UPSTREAM_API_TOKEN: string;
  readonly QUOTA_LIMIT_STANDARD?: string;
  readonly QUOTA_LIMIT_MINI?: string;
  readonly MAX_INPUT_BYTES?: string;
  readonly MAX_IN_FLIGHT_REQUESTS?: string;
  readonly IN_FLIGHT_LEASE_TTL_MS?: string;
  readonly IN_FLIGHT_LEASE_RENEWAL_MS?: string;
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;
  readonly OPENAI_USAGE_API_KEY?: string;
  readonly OPENAI_FREE_PROJECT_ID?: string;
  TEST_UPSTREAM_RESPONSE?: string;
  TEST_UPSTREAM_STATUS?: string;
  readonly ACCESS_JWT_PUBLIC_JWK?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let requestId: string | undefined;
    try {
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        requestId = `req_${ulid()}`;
        return await handleProxy(request, env, ctx, "chat", requestId);
      }
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        requestId = `req_${ulid()}`;
        return await handleProxy(request, env, ctx, "responses", requestId);
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return await handleModels(request, env);
      }
      if (request.method === "GET" && url.pathname === "/quota") {
        return await handleQuota(request, env, `req_${ulid()}`);
      }
      const admin = await handleAdmin(request, env, `req_${ulid()}`);
      if (admin) return admin;
    } catch {
      return errorResponse(errInternal(requestId ?? `req_${crypto.randomUUID()}`));
    }
    return new Response("Not Found", { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env, new Date(controller.scheduledTime)));
  }
} satisfies ExportedHandler<Env>;
