import type { PoolNameLower } from "@octg/shared";
import type { Env } from "./index";

export class UpstreamConfigError extends Error {}

export interface UpstreamMeta {
  client_id: string;
  pool: PoolNameLower;
  eligibility: "COMPLIMENTARY" | "PAID_ONLY";
  route: "free_shared" | "paid_shared";
  request_id: string;
}

export function buildUpstreamBody(
  endpoint: "chat" | "responses",
  body: Record<string, unknown>,
  maxOutputTokens: number,
): Record<string, unknown> {
  if (endpoint === "chat") {
    const { max_tokens: _legacy, max_completion_tokens: _completion, ...rest } = body;
    return {
      ...rest,
      max_completion_tokens: maxOutputTokens,
      ...(body.stream === true ? { stream_options: { include_usage: true } } : {}),
    };
  }
  const { max_output_tokens: _output, ...rest } = body;
  return { ...rest, max_output_tokens: maxOutputTokens };
}

export async function callUpstream(
  env: Env,
  path: "/chat/completions" | "/responses",
  body: unknown,
  meta: UpstreamMeta,
  cacheKey: string | null,
): Promise<Response> {
  if (!env.OCTG_UPSTREAM_API_TOKEN) throw new UpstreamConfigError("OCTG_UPSTREAM_API_TOKEN is not configured");
  if (env.OCTG_UPSTREAM_BASE_URL === "https://aigw.invalid" && env.TEST_UPSTREAM_STATUS === "network") {
    throw new TypeError("fetch failed");
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${env.OCTG_UPSTREAM_API_TOKEN}`,
    "cf-aig-request-timeout": "25000",
    "cf-aig-max-attempts": "2",
    "cf-aig-retry-delay": "1000",
    "cf-aig-backoff": "exponential",
    "cf-aig-metadata": JSON.stringify(meta),
  };
  if (cacheKey) headers["cf-aig-cache-key"] = cacheKey;
  else headers["cf-aig-skip-cache"] = "true";
  if (env.OCTG_UPSTREAM_BASE_URL === "https://aigw.invalid" && env.TEST_UPSTREAM_RESPONSE) {
    return new Response(env.TEST_UPSTREAM_RESPONSE, {
      status: Number(env.TEST_UPSTREAM_STATUS ?? "200"),
      headers: { "content-type": "application/json" },
    });
  }
  return fetch(`${env.OCTG_UPSTREAM_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
