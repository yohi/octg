import { errorResponse, nextUtcMidnight, quotaIdOf, utcDayOf } from "@octg/shared";
import { authenticate } from "./auth";
import type { Env } from "./index";

export async function handleQuota(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticate(request, env, requestId);
  if (!("id" in auth)) return errorResponse(auth);
  const day = utcDayOf(new Date());
  const resetAt = nextUtcMidnight(new Date(`${day}T00:00:00Z`));
  const view = async (pool: "STANDARD" | "MINI") => {
    const stub = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, day)));
    const state = await stub.getState();
    const used = state.confirmedTokens + state.reservedTokens + state.uncertainTokens;
    return {
      pool: pool.toLowerCase(),
      limit: state.limit,
      confirmed: state.confirmedTokens,
      reserved: state.reservedTokens,
      uncertain: state.uncertainTokens,
      remaining: state.remaining,
      usage_percent: Math.round((used / state.limit) * 10_000) / 100,
      reset_at: resetAt,
    };
  };
  return new Response(JSON.stringify({ request_id: requestId, pools: { standard: await view("STANDARD"), mini: await view("MINI") } }), {
    headers: { "content-type": "application/json", "X-OCTG-Request-Id": requestId },
  });
}
