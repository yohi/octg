import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { completeRequestRow } from "../src/db";
import { seedClient } from "./seed";

describe("completeRequestRow", () => {
  beforeEach(async () => seedClient());

  it("does not overwrite a terminal manual reconciliation projection", async () => {
    // Given: a canonical completed projection from manual reconciliation.
    const requestId = "terminal-manual-reconciliation";
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, billing_class, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, "2026-11-10", "client_test", "STANDARD", 200, 200, "free", "completed", new Date().toISOString()).run();

    // When: a delayed audit attempts to record a conflicting failed outcome.
    await completeRequestRow(env, requestId, { status: "failed", totalTokens: 0, billingClass: "none" });

    // Then: the canonical terminal projection remains unchanged.
    expect(
      await env.DB.prepare("SELECT status, total_tokens, billing_class FROM requests WHERE request_id = ?")
        .bind(requestId)
        .first<{ status: string; total_tokens: number; billing_class: string }>(),
    ).toEqual({ status: "completed", total_tokens: 200, billing_class: "free" });
  });

  it("does not overwrite an orphaned terminal audit row", async () => {
    // Given: reconciliation permanently classified an audit record as orphaned.
    const requestId = "terminal-orphaned-audit";
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, billing_class, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, "2026-11-10", "client_test", "STANDARD", 200, 0, "none", "orphaned", new Date().toISOString()).run();

    // When: delayed audit completion arrives after the terminal classification.
    await completeRequestRow(env, requestId, { status: "completed", totalTokens: 200, billingClass: "free" });

    // Then: terminal orphaned state and its accounting remain unchanged.
    expect(
      await env.DB.prepare("SELECT status, total_tokens, billing_class FROM requests WHERE request_id = ?")
        .bind(requestId)
        .first<{ status: string; total_tokens: number; billing_class: string }>(),
    ).toEqual({ status: "orphaned", total_tokens: 0, billing_class: "none" });
  });
});
