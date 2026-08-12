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
  const headers: Record<string, string> = { "content-type": "application/json" };
  const initHeaders = init?.headers;
  if (initHeaders) {
    for (const [key, value] of Object.entries(initHeaders)) {
      if (typeof value === "string") headers[key] = value;
    }
  }
  if (authenticated === "jwt") headers["cf-access-jwt-assertion"] = await token();
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
    const response = await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 5, cache_enabled: false }) }, "jwt");
    expect(response.status).toBe(200);
  });

  it("rejects invalid write payloads without updating rows", async () => {
    const policyResponse = await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: -1, cache_enabled: false }) }, "jwt");
    expect(policyResponse.status).toBe(400);
    const modelResponse = await admin("/admin/models/gpt-5", { method: "PUT", body: JSON.stringify({ complimentary_pool: "STANDARD", enabled: "yes", fallback_model: null }) }, "jwt");
    expect(modelResponse.status).toBe(400);
  });

  it("returns effective client policy values in the list", async () => {
    await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "PAID_SHARED", output_limit_mode: "CLAMP", max_paid_usd_day: 10, cache_enabled: true }) }, "jwt");
    const response = await admin("/admin/clients", undefined, "jwt");
    expect(response.status).toBe(200);
    const body = await response.json<{ clients: Array<{ id: string; overflow_mode: string; output_limit_mode: string; max_paid_usd_day: number; cache_enabled: boolean }> }>();
    const client = body.clients.find((c) => c.id === TEST_CLIENT_ID);
    expect(client).toMatchObject({ overflow_mode: "PAID_SHARED", output_limit_mode: "CLAMP", max_paid_usd_day: 10, cache_enabled: true });
  });

  it("returns default policy values for clients without a configured policy", async () => {
    await env.DB.prepare("DELETE FROM client_policies WHERE client_id = ?").bind(TEST_CLIENT_ID).run();
    const response = await admin("/admin/clients", undefined, "jwt");
    expect(response.status).toBe(200);
    const body = await response.json<{ clients: Array<{ id: string; overflow_mode: string; output_limit_mode: string; max_paid_usd_day: number; cache_enabled: boolean }> }>();
    const client = body.clients.find((c) => c.id === TEST_CLIENT_ID);
    expect(client).toMatchObject({ overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 0, cache_enabled: false });
  });
});
