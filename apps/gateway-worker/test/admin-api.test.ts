import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { RequestEntry } from "@octg/shared";
import { seedClient, TEST_CLIENT_ID } from "./seed";

let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey as CryptoKey;
  Object.assign(env, { ACCESS_JWT_PUBLIC_JWK: JSON.stringify({ keys: [await exportJWK(pair.publicKey)] }), ACCESS_AUD: "test-aud", ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com" });
});
beforeEach(async () => seedClient());
const token = () => new SignJWT({ sub: "admin@example.com" }).setProtectedHeader({ alg: "RS256" }).setIssuer("https://team.cloudflareaccess.com").setAudience("test-aud").setExpirationTime("10m").sign(privateKey);
const admin = async (path: string, init?: RequestInit, authenticated: "jwt" | false = false) => {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (authenticated === "jwt") headers.set("cf-access-jwt-assertion", await token());
  return SELF.fetch(`https://octg.test${path}`, { ...init, headers });
};
function withForeignOrigin(accessJwt: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", accessJwt);
  headers.set("origin", "https://attacker.example");
  headers.set("content-type", "application/json");
  return { ...init, headers };
}
const foreignAdmin = async (path: string, init: RequestInit = {}) => SELF.fetch(`https://octg.test${path}`, withForeignOrigin(await token(), init));
const expectOriginNotAllowed = async (response: Response) => {
  expect(response.status).toBe(403);
  expect((await response.json<{ error: { code: string } }>()).error.code).toBe("origin_not_allowed");
};

describe("admin API", () => {
  it("requires Access JWT", async () => {
    expect((await admin("/admin/quota")).status).toBe(401);
  });

  it("requires evidence before releasing a reserve-unknown request", async () => {
    const day = "2026-11-01";
    const requestId = "admin-reserve-unknown-unused";
    const controller = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await controller.reserve(requestId, 200, 200);
    await controller.markReserveOutcomeUnknown(requestId);
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, day, TEST_CLIENT_ID, "STANDARD", 200, 0, "uncertain", new Date().toISOString()).run();

    const response = await admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ disposition: "unused" }),
    }, "jwt");

    expect(response.status).toBe(400);
    expect(await controller.getState()).toMatchObject({ uncertainTokens: 200, confirmedTokens: 0 });

    const accepted = await admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ disposition: "unused", evidence: "upstream request was never sent" }),
    }, "jwt");

    expect(accepted.status).toBe(200);
    expect(await controller.getState()).toMatchObject({ uncertainTokens: 0, confirmedTokens: 0 });
    expect(await env.DB.prepare("SELECT status, reconciliation_evidence FROM requests WHERE request_id = ?").bind(requestId).first()).toEqual({ status: "failed", reconciliation_evidence: "upstream request was never sent" });
  });

  it("resolves a reserve-unknown request through its authoritative Durable Object", async () => {
    const day = "2026-11-02";
    const requestId = "admin-reserve-unknown-consumed";
    const controller = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await controller.reserve(requestId, 200, 200);
    await controller.markReserveOutcomeUnknown(requestId);
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, day, TEST_CLIENT_ID, "STANDARD", 999, 0, "uncertain", new Date().toISOString()).run();

    const response = await admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ disposition: "consumed" }),
    }, "jwt");

    expect(response.status).toBe(200);
    expect(await controller.getState()).toMatchObject({ uncertainTokens: 0, confirmedTokens: 200 });
    expect(await env.DB.prepare("SELECT status, total_tokens FROM requests WHERE request_id = ?").bind(requestId).first()).toEqual({ status: "completed", total_tokens: 200 });
  });

  it("rejects malformed and non-reserve-unknown reconciliation targets", async () => {
    const malformed = await admin("/admin/reconcile/OTHER/2026-11-03/request", {
      method: "POST",
      body: JSON.stringify({ disposition: "consumed" }),
    }, "jwt");
    expect(malformed.status).toBe(400);
    const invalidDay = await admin("/admin/reconcile/STANDARD/2026-13-01/request", {
      method: "POST",
      body: JSON.stringify({ disposition: "consumed" }),
    }, "jwt");
    expect(invalidDay.status).toBe(400);

    const day = "2026-11-03";
    const requestId = "admin-upstream-uncertain";
    const controller = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await controller.reserve(requestId, 200, 200);
    await controller.markUncertain(requestId);
    const response = await admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ disposition: "consumed" }),
    }, "jwt");

    expect(response.status).toBe(409);
    expect(await controller.getState()).toMatchObject({ uncertainTokens: 200, confirmedTokens: 0 });
  });

  it("replays the saved disposition without changing quota twice", async () => {
    const day = "2026-11-04";
    const requestId = "admin-reserve-unknown-retry";
    const controller = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await controller.reserve(requestId, 200, 200);
    await controller.markReserveOutcomeUnknown(requestId);

    const init = { method: "POST", body: JSON.stringify({ disposition: "consumed" }), } satisfies RequestInit;
    const first = await admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, init, "jwt");
    const second = await admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, init, "jwt");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const conflict = await admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ disposition: "unused", evidence: "operator-confirmed" }),
    }, "jwt");
    expect(conflict.status).toBe(409);
    expect(await controller.getState()).toMatchObject({ uncertainTokens: 0, confirmedTokens: 200 });
  });

  it("preserves reconciliation evidence when an identical replay omits it", async () => {
    // Given: a consumed reserve-unknown projection with operator-provided evidence.
    const day = "2026-11-07";
    const requestId = "admin-reserve-unknown-evidence-replay";
    const evidence = "operator-confirmed upstream request";
    const controller = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await controller.reserve(requestId, 200, 200);
    await controller.markReserveOutcomeUnknown(requestId);
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, day, TEST_CLIENT_ID, "STANDARD", 200, 0, "uncertain", new Date().toISOString()).run();
    await admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ disposition: "consumed", evidence }),
    }, "jwt");

    // When: the operator repeats the disposition without supplying evidence.
    const replay = await admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ disposition: "consumed" }),
    }, "jwt");

    // Then: projection repair retains the prior audit context.
    expect(replay.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT reconciliation_evidence FROM requests WHERE request_id = ?")
        .bind(requestId)
        .first<{ reconciliation_evidence: string }>(),
    ).toEqual({ reconciliation_evidence: evidence });
  });

  it("repairs a missing requests projection during an identical reserve-unknown replay", async () => {
    // Given: a consumed DO entry whose legacy terminal state has no saved reconcile result.
    const day = "2026-11-05";
    const requestId = "admin-reserve-unknown-projection-repair";
    const controller = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await controller.reserve(requestId, 200, 200);
    await controller.markReserveOutcomeUnknown(requestId);
    await controller.reconcileRequest(requestId, "consumed");
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, day, TEST_CLIENT_ID, "STANDARD", 200, 0, "uncertain", new Date().toISOString()).run();
    await runInDurableObject(controller, async (_instance, state) => {
      const entry = await state.storage.get<RequestEntry>(`req:${requestId}`);
      if (entry === undefined) throw new TypeError("Expected a stored reconciliation entry.");
      const results = { ...entry.results };
      delete results.reconcile;
      await state.storage.put(`req:${requestId}`, { ...entry, results });
    });

    // When: the operator repeats the identical consumed disposition.
    const response = await admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ disposition: "consumed" }),
    }, "jwt");

    // Then: the replay reports no new DO transition but restores the canonical D1 projection.
    expect(response.status).toBe(200);
    expect(await response.json<{ applied: boolean }>()).toMatchObject({ applied: false });
    expect(
      await env.DB.prepare("SELECT status, total_tokens, billing_class FROM requests WHERE request_id = ?")
        .bind(requestId)
        .first<{ status: string; total_tokens: number; billing_class: string }>(),
    ).toEqual({ status: "completed", total_tokens: 200, billing_class: "free" });
  });

  it("returns a non-success response when its D1 projection fails and repairs on retry", async () => {
    // Given: a reserve-unknown request and a database trigger that rejects its projection update.
    const day = "2026-11-06";
    const requestId = "admin-reserve-unknown-db-failure";
    const controller = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await controller.reserve(requestId, 200, 200);
    await controller.markReserveOutcomeUnknown(requestId);
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, day, TEST_CLIENT_ID, "STANDARD", 200, 0, "uncertain", new Date().toISOString()).run();
    await env.DB.prepare(
      "CREATE TRIGGER admin_reserve_unknown_projection_failure BEFORE UPDATE ON requests WHEN NEW.request_id = 'admin-reserve-unknown-db-failure' BEGIN SELECT RAISE(ABORT, 'forced projection failure'); END",
    ).run();

    try {
      // When: the operator consumes the reservation through the Admin API.
      const response = await admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
        method: "POST",
        body: JSON.stringify({ disposition: "consumed" }),
      }, "jwt");

      // Then: the DO remains authoritative, but the failed projection is reported for retry.
      expect(response.status).toBe(500);
      expect(await controller.getState()).toMatchObject({ uncertainTokens: 0, confirmedTokens: 200 });
      expect(
        await env.DB.prepare("SELECT status, total_tokens, billing_class FROM requests WHERE request_id = ?")
          .bind(requestId)
          .first<{ status: string; total_tokens: number; billing_class: string | null }>(),
      ).toEqual({ status: "uncertain", total_tokens: 0, billing_class: null });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS admin_reserve_unknown_projection_failure").run();
    }

    const retry = await admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ disposition: "consumed" }),
    }, "jwt");

    expect(retry.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT status, total_tokens, billing_class FROM requests WHERE request_id = ?")
        .bind(requestId)
        .first<{ status: string; total_tokens: number; billing_class: string }>(),
    ).toEqual({ status: "completed", total_tokens: 200, billing_class: "free" });
  });

  it("returns not found for unknown admin routes after access is verified", async () => {
    expect((await admin("/admin/nope", undefined, "jwt")).status).toBe(404);
  });

  it("keeps client policy and model writes behind the guard", async () => {
    const row = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(TEST_CLIENT_ID).first<{ id: string }>();
    expect(row?.id).toBe(TEST_CLIENT_ID);
    expect((await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: "{}" })).status).toBe(401);
    expect((await admin("/admin/models/gpt-5", { method: "PUT", body: "{}" })).status).toBe(401);
  });

  it("rejects a foreign Origin before changing a client policy", async () => {
    const before = await env.DB.prepare("SELECT overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode FROM client_policies WHERE client_id = ?").bind(TEST_CLIENT_ID).first();
    const response = await foreignAdmin(`/admin/clients/${TEST_CLIENT_ID}/policy`, {
      method: "PUT",
      body: JSON.stringify({ overflow_mode: "PAID_SHARED", output_limit_mode: "CLAMP", max_paid_usd_day: 9, cache_enabled: true, tools_mode: "ALLOW" }),
    });

    await expectOriginNotAllowed(response);
    const after = await env.DB.prepare("SELECT overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode FROM client_policies WHERE client_id = ?").bind(TEST_CLIENT_ID).first();
    expect(after).toEqual(before);
  });

  it("rejects a foreign Origin before changing a model", async () => {
    const before = await env.DB.prepare("SELECT complimentary_pool, enabled, fallback_model FROM model_registry WHERE model = ?").bind("gpt-5").first();
    const response = await foreignAdmin("/admin/models/gpt-5", {
      method: "PUT",
      body: JSON.stringify({ complimentary_pool: "MINI", enabled: false, fallback_model: "gpt-5-mini" }),
    });

    await expectOriginNotAllowed(response);
    const after = await env.DB.prepare("SELECT complimentary_pool, enabled, fallback_model FROM model_registry WHERE model = ?").bind("gpt-5").first();
    expect(after).toEqual(before);
  });

  it("rejects a foreign Origin before running reconciliation", async () => {
    const day = "2026-11-08";
    const requestId = "admin-origin-reconcile";
    const controller = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await controller.reserve(requestId, 200, 200);
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, day, TEST_CLIENT_ID, "STANDARD", 200, 0, "uncertain", new Date().toISOString()).run();
    const beforeState = await controller.getState();
    const beforeProjection = await env.DB.prepare("SELECT status, total_tokens, billing_class, reconciliation_evidence FROM requests WHERE request_id = ?").bind(requestId).first();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    try {
      const response = await foreignAdmin("/admin/reconcile", { method: "POST", body: "{}" });
      await expectOriginNotAllowed(response);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(await controller.getState()).toEqual(beforeState);
    expect(await env.DB.prepare("SELECT status, total_tokens, billing_class, reconciliation_evidence FROM requests WHERE request_id = ?").bind(requestId).first()).toEqual(beforeProjection);
  });

  it("rejects a foreign Origin before reconciling a reserve-unknown request", async () => {
    const day = "2026-11-09";
    const requestId = "admin-origin-reserve-unknown";
    const controller = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await controller.reserve(requestId, 200, 200);
    await controller.markReserveOutcomeUnknown(requestId);
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, day, TEST_CLIENT_ID, "STANDARD", 200, 0, "uncertain", new Date().toISOString()).run();
    const beforeState = await controller.getState();
    const beforeProjection = await env.DB.prepare("SELECT status, total_tokens, billing_class, reconciliation_evidence FROM requests WHERE request_id = ?").bind(requestId).first();
    const response = await foreignAdmin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ disposition: "consumed", evidence: "blocked" }),
    });

    await expectOriginNotAllowed(response);
    expect(await controller.getState()).toEqual(beforeState);
    expect(await env.DB.prepare("SELECT status, total_tokens, billing_class, reconciliation_evidence FROM requests WHERE request_id = ?").bind(requestId).first()).toEqual(beforeProjection);
  });

  it("allows client policy writes with an Access JWT", async () => {
    const response = await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 5, cache_enabled: false, tools_mode: "REJECT" }) }, "jwt");
    expect(response.status).toBe(200);
  });

  it("rejects missing tools_mode in policy writes", async () => {
    const response = await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 0, cache_enabled: false }) }, "jwt");
    expect(response.status).toBe(400);
  });

  it("rejects invalid tools_mode values", async () => {
    const response = await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 0, cache_enabled: false, tools_mode: "MAYBE" }) }, "jwt");
    expect(response.status).toBe(400);
  });

  it("rejects other invalid write payloads without updating rows", async () => {
    const policyResponse = await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: -1, cache_enabled: false, tools_mode: "REJECT" }) }, "jwt");
    expect(policyResponse.status).toBe(400);
    const modelResponse = await admin("/admin/models/gpt-5", { method: "PUT", body: JSON.stringify({ complimentary_pool: "STANDARD", enabled: "yes", fallback_model: null }) }, "jwt");
    expect(modelResponse.status).toBe(400);
  });

  it("returns effective client policy values in the list", async () => {
    await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "PAID_SHARED", output_limit_mode: "CLAMP", max_paid_usd_day: 10, cache_enabled: true, tools_mode: "ALLOW" }) }, "jwt");
    const response = await admin("/admin/clients", undefined, "jwt");
    expect(response.status).toBe(200);
    const body = await response.json<{ clients: Array<{ id: string; overflow_mode: string; output_limit_mode: string; max_paid_usd_day: number; cache_enabled: boolean; tools_mode: string }> }>();
    const client = body.clients.find((c) => c.id === TEST_CLIENT_ID);
    expect(client).toMatchObject({ overflow_mode: "PAID_SHARED", output_limit_mode: "CLAMP", max_paid_usd_day: 10, cache_enabled: true, tools_mode: "ALLOW" });
  });

  it("returns default policy values for clients without a configured policy", async () => {
    await env.DB.prepare("DELETE FROM client_policies WHERE client_id = ?").bind(TEST_CLIENT_ID).run();
    const response = await admin("/admin/clients", undefined, "jwt");
    expect(response.status).toBe(200);
    const body = await response.json<{ clients: Array<{ id: string; overflow_mode: string; output_limit_mode: string; max_paid_usd_day: number; cache_enabled: boolean; tools_mode: string }> }>();
    const client = body.clients.find((c) => c.id === TEST_CLIENT_ID);
    expect(client).toMatchObject({ overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 0, cache_enabled: false, tools_mode: "REJECT" });
  });

  it("round-trips output_limit_mode from admin write through read-normalize", async () => {
    await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "REJECT", output_limit_mode: "CLAMP", max_paid_usd_day: 0, cache_enabled: false, tools_mode: "REJECT" }) }, "jwt");
    const list = await admin("/admin/clients", undefined, "jwt");
    const body = await list.json<{ clients: Array<{ id: string; output_limit_mode: string }> }>();
    expect(body.clients.find((c) => c.id === TEST_CLIENT_ID)?.output_limit_mode).toBe("CLAMP");
  });

  it("round-trips tools_mode from admin write through read-normalize", async () => {
    await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 0, cache_enabled: false, tools_mode: "ALLOW" }) }, "jwt");
    const list = await admin("/admin/clients", undefined, "jwt");
    const body = await list.json<{ clients: Array<{ id: string; tools_mode: string }> }>();
    expect(body.clients.find((c) => c.id === TEST_CLIENT_ID)?.tools_mode).toBe("ALLOW");
  });

  it("rejects invalid tools_mode values", async () => {
    const response = await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 0, cache_enabled: false, tools_mode: "MAYBE" }) }, "jwt");
    expect(response.status).toBe(400);
  });

  it("falls back invalid output_limit_mode to REJECT when reading", async () => {
    await env.DB.prepare("DELETE FROM client_policies WHERE client_id = ?").bind(TEST_CLIENT_ID).run();
    await env.DB.prepare("INSERT INTO client_policies (client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode) VALUES (?, ?, ?, ?, ?, ?)").bind(TEST_CLIENT_ID, "REJECT", "UNKNOWN", 0, 0, "REJECT").run();
    const response = await admin("/admin/clients", undefined, "jwt");
    const body = await response.json<{ clients: Array<{ id: string; output_limit_mode: string }> }>();
    expect(body.clients.find((c) => c.id === TEST_CLIENT_ID)?.output_limit_mode).toBe("REJECT");
  });
});
