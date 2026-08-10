import { describe, expect, it } from "vitest";
import {
  buildOctgHeaders,
  errInvalidApiKey,
  errMaxTokensConflict,
  errModelNotAllowed,
  errModelRequiresPaid,
  errNonTextInput,
  errQuotaExceeded,
  errRequestTooLarge,
  errorResponse,
  type QuotaSnapshot,
} from "../src/errors";

const snapshot: QuotaSnapshot = {
  pool: "STANDARD",
  limit: 1_000_000,
  used: 987_500,
  remaining: 12_500,
  resetAt: "2026-08-10T00:00:00Z",
};

describe("canonical error bodies", () => {
  it("includes quota details in a 429 body and pool headers", async () => {
    const response = errorResponse(errQuotaExceeded(snapshot, "req_1"));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        message: "Complimentary quota exceeded for pool 'standard'.",
        type: "complimentary_quota_exceeded",
        param: null,
        code: "insufficient_quota",
        pool: "standard",
        remaining_tokens: 12_500,
        reset_at: "2026-08-10T00:00:00Z",
      },
      request_id: "req_1",
    });
    expect(response.headers.get("X-OCTG-Pool")).toBe("standard");
    expect(response.headers.get("X-OCTG-Quota-Used")).toBe("987500");
    expect(response.headers.get("X-OCTG-Route")).toBe("reject:complimentary_quota");
  });

  it("uses the error request id in the body and header", async () => {
    const error = errModelRequiresPaid("req_2");
    error.body.request_id = "stale-body-id";
    const response = errorResponse(error);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { request_id: string };
    expect(body.request_id).toBe("req_2");
    expect(response.headers.get("X-OCTG-Request-Id")).toBe("req_2");
  });

  it("keeps pool headers out of pre-pool errors", async () => {
    const response = errorResponse(errModelRequiresPaid("req_2"));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { param: string | null; code: string } };
    expect(body.error).toEqual({
      message: "The requested model requires paid mode, which is not enabled.",
      type: "invalid_request_error",
      param: "model",
      code: "model_requires_paid",
    });
    expect(response.headers.get("X-OCTG-Pool")).toBeNull();
    expect(response.headers.get("X-OCTG-Request-Id")).toBe("req_2");
  });

  it("builds the remaining canonical error variants", () => {
    expect(errRequestTooLarge(snapshot, "r").status).toBe(413);
    expect(errModelNotAllowed("r", snapshot).quota).toEqual(snapshot);
    expect(errModelNotAllowed("r").quota).toBeUndefined();
    expect(errNonTextInput("r").body.error.param).toBe("input");
    expect(errMaxTokensConflict("r").body.error.param).toBe("max_tokens");
    expect(errInvalidApiKey("r").status).toBe(401);
  });
});

describe("buildOctgHeaders", () => {
  it("emits request id alone before pool determination", () => {
    expect(buildOctgHeaders({ requestId: "r" })).toEqual({ "X-OCTG-Request-Id": "r" });
  });

  it("emits all pool headers only when route and quota are both known", () => {
    expect(buildOctgHeaders({ requestId: "r", quota: snapshot, route: "free_shared" })).toEqual({
      "X-OCTG-Request-Id": "r",
      "X-OCTG-Pool": "standard",
      "X-OCTG-Quota-Limit": "1000000",
      "X-OCTG-Quota-Used": "987500",
      "X-OCTG-Quota-Remaining": "12500",
      "X-OCTG-Quota-Reset": "2026-08-10T00:00:00Z",
      "X-OCTG-Route": "free_shared",
    });
  });
});
