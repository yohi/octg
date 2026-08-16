import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
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

  it("returns not found for unknown admin routes after access is verified", async () => {
    expect((await admin("/admin/nope", undefined, "jwt")).status).toBe(404);
  });

  it("keeps client policy and model writes behind the guard", async () => {
    const row = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(TEST_CLIENT_ID).first<{ id: string }>();
    expect(row?.id).toBe(TEST_CLIENT_ID);
    expect((await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: "{}" })).status).toBe(401);
    expect((await admin("/admin/models/gpt-5", { method: "PUT", body: "{}" })).status).toBe(401);
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
