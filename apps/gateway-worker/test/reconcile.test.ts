import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { runReconciliation, targetUtcDay } from "../src/reconcile";
import { seedClient } from "./seed";

const now = new Date("2026-08-10T00:05:00Z");
describe("reconciliation", () => {
  it("targets the previous UTC day", () => {
    expect(targetUtcDay(now)).toBe("2026-08-09");
  });

  it("returns pool-specific reports from paginated Usage API results", async () => {
    Object.assign(env, { OPENAI_USAGE_API_KEY: "test" });
    await seedClient();
    const responses = [
      { data: [{ results: [{ model: "gpt-5", input_tokens: 100, output_tokens: 50 }, { model: "gpt-5-mini", input_tokens: 30, output_tokens: 20 }] }], has_more: true, next_page: "next" },
      { data: [{ results: [{ model: "gpt-5", input_tokens: 25, output_tokens: 25 }, { model: "gpt-5-mini", input_tokens: 35, output_tokens: 35 }] }], has_more: false },
      { data: [{ results: [{ model: "gpt-5", input_tokens: 0, output_tokens: 0 }] }], has_more: true, next_page: "next-mini" },
      { data: [{ results: [{ model: "gpt-5-mini", input_tokens: 70, output_tokens: 0 }] }], has_more: false },
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(responses.shift())));
    await env.DB.prepare("INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)").bind("reconcile-standard", "2026-08-09", "client_test", "STANDARD", 0, 150, "completed", now.toISOString(), "reconcile-mini", "2026-08-09", "client_test", "MINI", 0, 50, "completed", now.toISOString()).run();
    const reports = await runReconciliation(env, now);
    expect(reports).toEqual([
      { utcDay: "2026-08-09", pool: "STANDARD", localTokens: 150, openaiTokens: 200, difference: 50, status: "open" },
      { utcDay: "2026-08-09", pool: "MINI", localTokens: 50, openaiTokens: 70, difference: 20, status: "open" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const firstUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(firstUrl.searchParams.get("start_time")).toBe(String(Date.parse("2026-08-09T00:00:00Z") / 1000));
    expect(firstUrl.searchParams.get("end_time")).toBe(String(Date.parse("2026-08-09T00:00:00Z") / 1000 + 48 * 3600));
    expect(firstUrl.searchParams.get("bucket_width")).toBe("1h");
    expect(firstUrl.searchParams.get("limit")).toBe("48");
    expect(new URL(fetchMock.mock.calls[1]?.[0] as string).searchParams.get("page")).toBe("next");
    expect(new URL(fetchMock.mock.calls[3]?.[0] as string).searchParams.get("page")).toBe("next-mini");
    fetchMock.mockRestore();
  });

  it("marks matching uncertain usage as done and consumes its reservation", async () => {
    const reconciliationNow = new Date("2026-08-20T00:05:00Z");
    const reconciliationDay = "2026-08-19";
    Object.assign(env, { OPENAI_USAGE_API_KEY: "test" });
    await seedClient();
    const controller = env.QUOTA_CONTROLLER.get(
      env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${reconciliationDay}`),
    );
    await controller.reserve("reconcile-uncertain-2026-08-19", 150, 150);
    await controller.markUncertain("reconcile-uncertain-2026-08-19");
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("reconcile-uncertain-2026-08-19", reconciliationDay, "client_test", "STANDARD", 150, 0, "uncertain", reconciliationNow.toISOString()).run();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        data: [{ results: [{ model: "gpt-5", input_tokens: 125, output_tokens: 25 }] }],
        has_more: false,
      })),
    );

    const reports = await runReconciliation(env, reconciliationNow);

    expect(reports[0]).toEqual({
      utcDay: reconciliationDay,
      pool: "STANDARD",
      localTokens: 0,
      openaiTokens: 150,
      difference: 150,
      status: "done",
    });
    expect((await controller.getState()).uncertainTokens).toBe(0);
    expect((await controller.getState()).confirmedTokens).toBe(150);
    expect((await env.DB.prepare("SELECT status FROM requests WHERE request_id = ?").bind("reconcile-uncertain-2026-08-19").first<{ status: string }>())?.status).toBe("completed");
    expect((await env.DB.prepare("SELECT confirmed_tokens FROM daily_usage WHERE utc_day = ? AND pool = 'STANDARD'").bind(reconciliationDay).first<{ confirmed_tokens: number }>())?.confirmed_tokens).toBe(150);
    fetchMock.mockRestore();
  });

  it("keeps unresolved usage open and records only confirmed local usage", async () => {
    const reconciliationNow = new Date("2026-08-21T00:05:00Z");
    const reconciliationDay = "2026-08-20";
    Object.assign(env, { OPENAI_USAGE_API_KEY: "test" });
    await seedClient();
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("reconcile-completed", reconciliationDay, "client_test", "STANDARD", 0, 100, "completed", reconciliationNow.toISOString(), "reconcile-open", reconciliationDay, "client_test", "STANDARD", 40, 0, "uncertain", reconciliationNow.toISOString()).run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      data: [{ results: [{ model: "gpt-5", input_tokens: 70, output_tokens: 60 }] }],
      has_more: false,
    })));
    const reports = await runReconciliation(env, reconciliationNow);
    expect(reports.find((report) => report.pool === "STANDARD")?.status).toBe("open");
    expect((await env.DB.prepare("SELECT confirmed_tokens FROM daily_usage WHERE utc_day = ? AND pool = 'STANDARD'").bind(reconciliationDay).first<{ confirmed_tokens: number }>())?.confirmed_tokens).toBe(100);
    fetchMock.mockRestore();
  });

  it("uses the Durable Object snapshot instead of D1 reservation amounts", async () => {
    const reconciliationNow = new Date("2026-08-23T00:05:00Z");
    const reconciliationDay = "2026-08-22";
    Object.assign(env, { OPENAI_USAGE_API_KEY: "test" });
    await seedClient();
    const controller = env.QUOTA_CONTROLLER.get(
      env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${reconciliationDay}`),
    );
    await controller.reserve("reconcile-do-source", 150, 150);
    await controller.markUncertain("reconcile-do-source");
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("reconcile-do-source", reconciliationDay, "client_test", "STANDARD", 999, 0, "uncertain", reconciliationNow.toISOString()).run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      data: [{ results: [{ model: "gpt-5", input_tokens: 125, output_tokens: 25 }] }],
      has_more: false,
    })));

    const reports = await runReconciliation(env, reconciliationNow);

    expect(reports.find((report) => report.pool === "STANDARD")?.status).toBe("done");
    expect((await controller.getState()).confirmedTokens).toBe(150);
    fetchMock.mockRestore();
  });

  it("backfills daily usage when a completed reconciliation is replayed", async () => {
    const reconciliationNow = new Date("2026-08-22T00:05:00Z");
    const reconciliationDay = "2026-08-21";
    await seedClient();
    Object.assign(env, { OPENAI_USAGE_API_KEY: "test" });
    await env.DB.prepare(
      "INSERT INTO reconciliations (utc_day, pool, local_tokens, openai_tokens, difference, status, attempts, executed_at) VALUES (?, ?, ?, ?, ?, 'done', 1, ?)",
    ).bind(reconciliationDay, "STANDARD", 100, 150, 50, reconciliationNow.toISOString()).run();
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, 'completed', ?), (?, ?, ?, ?, ?, 'failed', ?)",
    ).bind("replayed-completed", reconciliationDay, "client_test", "STANDARD", 150, reconciliationNow.toISOString(), "replayed-failed", reconciliationDay, "client_test", "STANDARD", 10, reconciliationNow.toISOString()).run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [], has_more: false })));

    const reports = await runReconciliation(env, reconciliationNow);

    expect(reports[0]?.status).toBe("done");
    expect(await env.DB.prepare("SELECT confirmed_tokens, request_count FROM daily_usage WHERE utc_day = ? AND pool = 'STANDARD'").bind(reconciliationDay).first<{ confirmed_tokens: number; request_count: number }>()).toEqual({ confirmed_tokens: 150, request_count: 1 });
    fetchMock.mockRestore();
  });
});
