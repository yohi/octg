import { QuotaController } from "@octg/quota-controller";
import { handleProxy } from "./proxy";
import { errInternal, errorResponse } from "@octg/shared";

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
    } catch {
      return errorResponse(errInternal(`req_${crypto.randomUUID()}`));
    }
    return new Response("Not Found", { status: 404 });
  },
  async scheduled(): Promise<void> {}
} satisfies ExportedHandler<Env>;
