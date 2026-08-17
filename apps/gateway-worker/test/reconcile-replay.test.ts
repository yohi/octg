import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { runReconciliation } from "../src/reconcile";
import { seedClient } from "./seed";

describe("reconciliation replay safety", () => {
  it("does not project reserved tokens after an upstream settlement races reconciliation", async () => {
    // Given: an uncertain 200-token reservation that settles for 150 tokens during usage retrieval.
    const reconciliationNow = new Date("2026-08-28T00:05:00Z");
    const reconciliationDay = "2026-08-27";
    const requestId = "reconcile-delayed-settlement";
    Object.assign(env, { OPENAI_USAGE_API_KEY: "test" });
    await seedClient();
    const controller = env.QUOTA_CONTROLLER.get(
      env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${reconciliationDay}`),
    );
    await controller.reserve(requestId, 200, 200);
    await controller.markUncertain(requestId);
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, reconciliationDay, "client_test", "STANDARD", 200, 0, "uncertain", reconciliationNow.toISOString()).run();

    let settledDuringUsageFetch = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (!settledDuringUsageFetch) {
        settledDuringUsageFetch = true;
        await controller.settle(requestId, 150);
      }
      return new Response(JSON.stringify({
        data: [{ results: [{ model: "gpt-5", input_tokens: 125, output_tokens: 75 }] }],
        has_more: false,
      }));
    });

    try {
      // When: automatic reconciliation reaches the stale uncertain snapshot after the settle.
      const reports = await runReconciliation(env, reconciliationNow);

      // Then: D1 is not rewritten with the stale 200-token reservation and remains open.
      expect(settledDuringUsageFetch).toBe(true);
      expect(await controller.getState()).toMatchObject({ confirmedTokens: 150, uncertainTokens: 0 });
      expect(
        await env.DB.prepare("SELECT status, total_tokens, billing_class FROM requests WHERE request_id = ?")
          .bind(requestId)
          .first<{ status: string; total_tokens: number; billing_class: string | null }>(),
      ).toEqual({ status: "uncertain", total_tokens: 0, billing_class: null });
      expect(reports.find((report) => report.pool === "STANDARD")).toEqual({
        utcDay: reconciliationDay,
        pool: "STANDARD",
        localTokens: 0,
        openaiTokens: 200,
        difference: 200,
        status: "open",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("repairs the D1 projection after a reconciliation replay", async () => {
    // Given: a Usage API response will settle the DO before automatic projection repair.
    const reconciliationNow = new Date("2026-08-26T00:05:00Z");
    const reconciliationDay = "2026-08-25";
    const requestId = "reconcile-idempotent-projection";
    Object.assign(env, { OPENAI_USAGE_API_KEY: "test" });
    await seedClient();
    const controller = env.QUOTA_CONTROLLER.get(
      env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${reconciliationDay}`),
    );
    await controller.reserve(requestId, 150, 150);
    await controller.markUncertain(requestId);
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, reconciliationDay, "client_test", "STANDARD", 150, 0, "uncertain", reconciliationNow.toISOString()).run();

    let settledDuringUsageFetch = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (!settledDuringUsageFetch) {
        settledDuringUsageFetch = true;
        await controller.reconcileRequest(requestId, "consumed");
      }
      return new Response(JSON.stringify({
        data: [{ results: [{ model: "gpt-5", input_tokens: 125, output_tokens: 25 }] }],
        has_more: false,
      }));
    });

    try {
      // When: automatic reconciliation replays the already-applied DO disposition.
      const reports = await runReconciliation(env, reconciliationNow);

      // Then: D1 is repaired and all reported aggregates use the repaired projection.
      expect(reports.find((report) => report.pool === "STANDARD")).toEqual({
        utcDay: reconciliationDay,
        pool: "STANDARD",
        localTokens: 150,
        openaiTokens: 150,
        difference: 0,
        status: "done",
      });
      expect(settledDuringUsageFetch).toBe(true);
      expect(
        await env.DB.prepare("SELECT status, total_tokens, billing_class FROM requests WHERE request_id = ?")
          .bind(requestId)
          .first<{ status: string; total_tokens: number; billing_class: string }>(),
      ).toEqual({ status: "completed", total_tokens: 150, billing_class: "free" });
      expect(
        await env.DB.prepare("SELECT confirmed_tokens, request_count FROM daily_usage WHERE utc_day = ? AND pool = 'STANDARD'")
          .bind(reconciliationDay)
          .first<{ confirmed_tokens: number; request_count: number }>(),
      ).toEqual({ confirmed_tokens: 150, request_count: 1 });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("repairs an uncertain D1 projection absent from an already-reconciled DO snapshot", async () => {
    // Given: D1 missed a prior consumed reconciliation and retained stale reserved tokens.
    const reconciliationNow = new Date("2026-08-30T00:05:00Z");
    const reconciliationDay = "2026-08-29";
    const requestId = "reconcile-missing-snapshot";
    Object.assign(env, { OPENAI_USAGE_API_KEY: "test" });
    await seedClient();
    const controller = env.QUOTA_CONTROLLER.get(
      env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${reconciliationDay}`),
    );
    await controller.reserve(requestId, 150, 150);
    await controller.markUncertain(requestId);
    await controller.reconcileRequest(requestId, "consumed");
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, reconciliationDay, "client_test", "STANDARD", 999, 0, "uncertain", reconciliationNow.toISOString()).run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      data: [{ results: [{ model: "gpt-5", input_tokens: 125, output_tokens: 25 }] }],
      has_more: false,
    })));

    try {
      // When: automatic reconciliation cannot see the request in its pending DO snapshot.
      const reports = await runReconciliation(env, reconciliationNow);

      // Then: canonical DO tokens repair D1 and all derived aggregates.
      expect(await controller.getState()).toMatchObject({ confirmedTokens: 150, uncertainTokens: 0 });
      expect(
        await env.DB.prepare("SELECT reserved_tokens, status, total_tokens, billing_class FROM requests WHERE request_id = ?")
          .bind(requestId)
          .first<{ reserved_tokens: number; status: string; total_tokens: number; billing_class: string }>(),
      ).toEqual({ reserved_tokens: 999, status: "completed", total_tokens: 150, billing_class: "free" });
      expect(reports.find((report) => report.pool === "STANDARD")).toEqual({
        utcDay: reconciliationDay,
        pool: "STANDARD",
        localTokens: 150,
        openaiTokens: 150,
        difference: 0,
        status: "done",
      });
      expect(
        await env.DB.prepare("SELECT confirmed_tokens, request_count FROM daily_usage WHERE utc_day = ? AND pool = 'STANDARD'")
          .bind(reconciliationDay)
          .first<{ confirmed_tokens: number; request_count: number }>(),
      ).toEqual({ confirmed_tokens: 150, request_count: 1 });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
