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
