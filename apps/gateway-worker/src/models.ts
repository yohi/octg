import { errInternal, errorResponse } from "@octg/shared";
import { ulid } from "ulid";
import { authenticate } from "./auth";
import { resolveDenoTokenizerConfig } from "./deno-tokenizer-config";
import { loadRegistry } from "./policy";
import type { Env } from "./index";

export async function handleModels(request: Request, env: Env): Promise<Response> {
  const requestId = `req_${ulid()}`;
  const auth = await authenticate(request, env, requestId);
  if (!("id" in auth)) return errorResponse(auth);
  const denoTokenizerConfig = resolveDenoTokenizerConfig(env);
  if (denoTokenizerConfig.kind === "invalid") return errorResponse(errInternal(requestId));
  const data = [...(await loadRegistry(env)).values()]
    .filter((model) => model.enabled && model.complimentary_pool !== "NONE")
    .sort((a, b) => a.model.localeCompare(b.model))
    .map((model) => ({ id: model.model, object: "model" as const, created: 0, owned_by: model.provider }));
  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "content-type": "application/json", "X-OCTG-Request-Id": requestId },
  });
}
