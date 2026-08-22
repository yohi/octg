import type { PoolNameLower } from "@octg/shared";
import type { Env } from "./index";

export class UpstreamConfigError extends Error {}

export type UpstreamTransport = typeof fetch;

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
  idempotencyKey: string | undefined,
  transport: UpstreamTransport = fetch,
): Promise<Response> {
  if (!env.OCTG_UPSTREAM_API_TOKEN) throw new UpstreamConfigError("OCTG_UPSTREAM_API_TOKEN is not configured");
  if (!env.OCTG_UPSTREAM_BASE_URL.endsWith("/openai")) {
    throw new UpstreamConfigError("OCTG_UPSTREAM_BASE_URL must end with /openai");
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cf-aig-authorization": `Bearer ${env.OCTG_UPSTREAM_API_TOKEN}`,
    "cf-aig-request-timeout": "25000",
    "cf-aig-max-attempts": "1",
    "cf-aig-metadata": JSON.stringify(meta),
    "cf-aig-collect-log-payload": "false",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (cacheKey) headers["cf-aig-cache-key"] = cacheKey;
  else headers["cf-aig-skip-cache"] = "true";
  return transport(`${env.OCTG_UPSTREAM_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
