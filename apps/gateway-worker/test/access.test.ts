import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyAccessJwt } from "../src/access";

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;
let rs384PrivateKey: CryptoKey;
let rs384PublicJwk: JsonWebKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey as CryptoKey;
  publicJwk = await exportJWK(pair.publicKey);
  const rs384Pair = await generateKeyPair("RS384");
  rs384PrivateKey = rs384Pair.privateKey as CryptoKey;
  rs384PublicJwk = await exportJWK(rs384Pair.publicKey);
  Object.assign(env, { ACCESS_JWT_PUBLIC_JWK: JSON.stringify({ keys: [publicJwk] }), ACCESS_AUD: "test-aud", ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com" });
});
const request = (token?: string) => new Request("https://octg.test/admin/quota", { headers: token ? { "cf-access-jwt-assertion": token } : {} });
const sign = (audience = "test-aud", expiration: string | number | null = "10m", issuer = "https://team.cloudflareaccess.com") => {
  const token = new SignJWT({ sub: "admin@example.com" }).setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience);
  return (expiration === null ? token : token.setExpirationTime(expiration)).sign(privateKey);
};

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
  it("rejects a token without an expiration claim", async () => {
    await expect(verifyAccessJwt(request(await sign("test-aud", null)), env, "r6")).resolves.toMatchObject({ status: 401 });
  });
  it("rejects tokens that do not use RS256", async () => {
    Object.assign(env, { ACCESS_JWT_PUBLIC_JWK: JSON.stringify({ keys: [rs384PublicJwk] }) });
    const token = await new SignJWT({ sub: "admin@example.com" }).setProtectedHeader({ alg: "RS384" }).setIssuer("https://team.cloudflareaccess.com").setAudience("test-aud").setExpirationTime("10m").sign(rs384PrivateKey);
    await expect(verifyAccessJwt(request(token), env, "r7")).resolves.toMatchObject({ status: 401 });
    Object.assign(env, { ACCESS_JWT_PUBLIC_JWK: JSON.stringify({ keys: [publicJwk] }) });
  });
});
