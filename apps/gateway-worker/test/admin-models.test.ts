import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { seedClient } from "./seed";

let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey as CryptoKey;
  Object.assign(env, { ACCESS_JWT_PUBLIC_JWK: JSON.stringify({ keys: [await exportJWK(pair.publicKey)] }), ACCESS_AUD: "test-aud", ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com" });
});
beforeEach(async () => seedClient());
const token = () => new SignJWT({ sub: "admin@example.com" }).setProtectedHeader({ alg: "RS256" }).setIssuer("https://team.cloudflareaccess.com").setAudience("test-aud").setExpirationTime("10m").sign(privateKey);
const admin = async (path: string) => {
  const headers = new Headers({ "content-type": "application/json", "cf-access-jwt-assertion": await token() });
  return SELF.fetch(`https://octg.test${path}`, { headers });
};

describe("admin models API", () => {
  it("returns model update timestamps in the model list", async () => {
    // Given: a seeded model registry and a valid Admin Access JWT.
    // When: the operator requests the model list.
    const response = await admin("/admin/models");

    // Then: each model includes the timestamp consumed by the dashboard.
    expect(response.status).toBe(200);
    const body = await response.json<{ models: Array<{ model: string; updated_at: string }> }>();
    expect(body.models.find((model) => model.model === "gpt-5")).toMatchObject({ updated_at: "2026-08-09T00:00:00Z" });
  });
});
