import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyAccessJwt, verifyAccessJwtOrServiceToken } from "../src/access";

let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey as CryptoKey;
  Object.assign(env, { ACCESS_JWT_PUBLIC_JWK: JSON.stringify({ keys: [await exportJWK(pair.publicKey)] }), ACCESS_AUD: "test-aud", ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com" });
});
const request = (token?: string) => new Request("https://octg.test/admin/quota", { headers: token ? { "cf-access-jwt-assertion": token } : {} });
const sign = (audience = "test-aud", expiration: string | number = "10m", issuer = "https://team.cloudflareaccess.com") => new SignJWT({ sub: "admin@example.com" }).setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setExpirationTime(expiration).sign(privateKey);

describe("verifyAccessJwt", () => {
  it("rejects missing, expired, and wrong-audience tokens", async () => {
    await expect(verifyAccessJwt(request(), env, "r1")).resolves.toMatchObject({ status: 401 });
    await expect(verifyAccessJwt(request(await sign("test-aud", Math.floor((Date.now() - 60_000) / 1000))), env, "r2")).resolves.toMatchObject({ status: 401 });
    await expect(verifyAccessJwt(request(await sign("other-aud")), env, "r3")).resolves.toMatchObject({ status: 401 });
  });
  it("accepts a valid token", async () => {
    await expect(verifyAccessJwt(request(await sign()), env, "r4")).resolves.toBe(true);
  });
  it("rejects a token with the wrong issuer", async () => {
    await expect(verifyAccessJwt(request(await sign("test-aud", "10m", "https://wrong.example.com")), env, "r5")).resolves.toMatchObject({ status: 401 });
  });
});

describe("verifyAccessJwtOrServiceToken", () => {
  it("accepts a valid JWT", async () => {
    await expect(verifyAccessJwtOrServiceToken(request(await sign()), env, "r6")).resolves.toBe(true);
  });
  it("accepts an allowed Service Token client id", async () => {
    Object.assign(env, { ACCESS_ALLOWED_SERVICE_TOKEN_IDS: "allowed-token-id" });
    await expect(verifyAccessJwtOrServiceToken(new Request("https://octg.test/admin/quota", { headers: { "CF-Access-Client-Id": "allowed-token-id" } }), env, "r7")).resolves.toBe(true);
  });
  it("rejects a disallowed Service Token client id", async () => {
    Object.assign(env, { ACCESS_ALLOWED_SERVICE_TOKEN_IDS: "allowed-token-id" });
    await expect(verifyAccessJwtOrServiceToken(new Request("https://octg.test/admin/quota", { headers: { "CF-Access-Client-Id": "unknown-token-id" } }), env, "r8")).resolves.toMatchObject({ status: 401 });
  });
  it("rejects missing Service Token when no JWT", async () => {
    await expect(verifyAccessJwtOrServiceToken(request(), env, "r9")).resolves.toMatchObject({ status: 401 });
  });
  it("rejects an invalid JWT even when Service Token env is set", async () => {
    Object.assign(env, { ACCESS_ALLOWED_SERVICE_TOKEN_IDS: "allowed-token-id" });
    await expect(verifyAccessJwtOrServiceToken(request("bad-token"), env, "r10")).resolves.toMatchObject({ status: 401 });
  });
});
