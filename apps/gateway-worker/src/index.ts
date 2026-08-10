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
  readonly OCTG_KEY_PEPPER: string;
  readonly OCTG_UPSTREAM_BASE_URL: string;
  readonly OCTG_UPSTREAM_API_TOKEN: string;
  readonly QUOTA_LIMIT_STANDARD?: string;
  readonly QUOTA_LIMIT_MINI?: string;
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
    try {
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        return await handleProxy(request, env, ctx, "chat");
      }
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        return await handleProxy(request, env, ctx, "responses");
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
      return errorResponse(errInternal(`req_${crypto.randomUUID()}`));
    }
    return new Response("Not Found", { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env, new Date(controller.scheduledTime)));
  }
} satisfies ExportedHandler<Env>;
