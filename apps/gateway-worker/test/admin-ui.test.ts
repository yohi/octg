import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey as CryptoKey;
  Object.assign(env, {
    ACCESS_JWT_PUBLIC_JWK: JSON.stringify({ keys: [await exportJWK(pair.publicKey)] }),
    ACCESS_AUD: "test-aud",
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
  });
});
const token = () => new SignJWT({ sub: "admin@example.com" })
  .setProtectedHeader({ alg: "RS256" })
  .setIssuer("https://team.cloudflareaccess.com")
  .setAudience("test-aud")
  .setExpirationTime("10m")
  .sign(privateKey);

describe("admin UI route", () => {
  it("rejects /admin/ui/ without an Access JWT", async () => {
    expect((await SELF.fetch("https://octg.test/admin/ui/")).status).toBe(401);
  });

  it("serves the authenticated dashboard entrypoint", async () => {
    const response = await SELF.fetch("https://octg.test/admin/ui/", {
      headers: { "cf-access-jwt-assertion": await token() },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("serves an authenticated non-entry asset as text/plain in the test double", async () => {
    const response = await SELF.fetch("https://octg.test/admin/ui/app.js", {
      headers: { "cf-access-jwt-assertion": await token() },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("asset");
  });

  it("keeps an authenticated unknown admin API route as JSON 404", async () => {
    const response = await SELF.fetch("https://octg.test/admin/unknown", {
      headers: { "cf-access-jwt-assertion": await token() },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
