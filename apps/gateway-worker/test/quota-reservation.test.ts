import { describe, expect, it, vi } from "vitest";
import {
  completeRequestAuditBestEffort,
  startRequestAuditBestEffort,
} from "../src/db";
import { reserveFailClosed } from "../src/quota-reservation";
import type { Env } from "../src/index";
import type { RequestLogRow } from "../src/db";

const row: RequestLogRow = {
  requestId: "req-audit",
  utcDay: "2026-08-16",
  clientId: "client-test",
  requestedModel: "gpt-5",
  upstreamModel: "gpt-5",
  pool: "STANDARD",
  eligibility: "COMPLIMENTARY",
  reservedTokens: null,
};

function fakeEnv(run: ReturnType<typeof vi.fn>): Env {
  const statement = {
    bind: vi.fn(() => statement),
    run,
  };
  return {
    DB: { prepare: vi.fn(() => statement) },
  } as unknown as Env;
}

describe("best-effort request audit", () => {
  it("does not reject the request flow when the insert fails", async () => {
    const env = fakeEnv(vi.fn().mockRejectedValue(new Error("D1 unavailable")));

    await expect(startRequestAuditBestEffort(env, row)).resolves.toBe(false);
  });

  it("skips completion when the insert did not succeed", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const env = fakeEnv(run);

    await expect(
      completeRequestAuditBestEffort(env, row.requestId, { status: "failed" }, Promise.resolve(false)),
    ).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("swallows a completion failure", async () => {
    const env = fakeEnv(vi.fn().mockRejectedValue(new Error("D1 unavailable")));

    await expect(
      completeRequestAuditBestEffort(env, row.requestId, { status: "failed" }, Promise.resolve(true)),
    ).resolves.toBeUndefined();
  });
});

describe("reserveFailClosed", () => {
  it("retries the same reservation after a transport failure", async () => {
    const reserve = vi.fn()
      .mockRejectedValueOnce(new TypeError("transport failure"))
      .mockResolvedValueOnce({ ok: true, remaining: 10, resetAt: "2026-08-17T00:00:00Z" });

    const result = await reserveFailClosed(reserve, {
      requestId: "req-reserve",
      tokens: 20,
      upperBoundTokens: 25,
      idempotencyKey: "idem-1",
      clientId: "client-test",
    });

    expect(result).toEqual({
      kind: "resolved",
      result: { ok: true, remaining: 10, resetAt: "2026-08-17T00:00:00Z" },
    });
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenNthCalledWith(1, "req-reserve", 20, 25, "idem-1", "client-test");
    expect(reserve).toHaveBeenNthCalledWith(2, "req-reserve", 20, 25, "idem-1", "client-test");
  });

  it("returns unknown after both reservation attempts fail", async () => {
    const reserve = vi.fn().mockRejectedValue(new TypeError("transport failure"));

    await expect(
      reserveFailClosed(reserve, {
        requestId: "req-unknown",
        tokens: 20,
        upperBoundTokens: 25,
      }),
    ).resolves.toEqual({ kind: "unknown" });
    expect(reserve).toHaveBeenCalledTimes(2);
  });
});
