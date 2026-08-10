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
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(responses.shift() ?? { data: [{ results: [{ model: "gpt-5", input_tokens: 25, output_tokens: 25 }, { model: "gpt-5-mini", input_tokens: 35, output_tokens: 35 }] }], has_more: false })));
    await env.DB.prepare("INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)").bind("reconcile-standard", "2026-08-09", "client_test", "STANDARD", 0, 150, "completed", now.toISOString(), "reconcile-mini", "2026-08-09", "client_test", "MINI", 0, 50, "completed", now.toISOString()).run();
    const reports = await runReconciliation(env, now);
    expect(reports).toEqual([
      { utcDay: "2026-08-09", pool: "STANDARD", localTokens: 150, openaiTokens: 200, difference: 50, status: "open" },
      { utcDay: "2026-08-09", pool: "MINI", localTokens: 50, openaiTokens: 70, difference: 20, status: "open" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new URL(fetchMock.mock.calls[1]?.[0] as string).searchParams.get("page")).toBe("next");
    fetchMock.mockRestore();
  });
});
