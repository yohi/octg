import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyAccessJwt } from "../src/access";

let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey as CryptoKey;
  Object.assign(env, { ACCESS_JWT_PUBLIC_JWK: JSON.stringify({ keys: [await exportJWK(pair.publicKey)] }), ACCESS_AUD: "test-aud" });
});
const request = (token?: string) => new Request("https://octg.test/admin/quota", { headers: token ? { "cf-access-jwt-assertion": token } : {} });
const sign = (audience = "test-aud", expiration: string | number = "10m") => new SignJWT({ sub: "admin@example.com" }).setProtectedHeader({ alg: "RS256" }).setIssuer("https://team.cloudflareaccess.com").setAudience(audience).setExpirationTime(expiration).sign(privateKey);

describe("verifyAccessJwt", () => {
  it("rejects missing, expired, and wrong-audience tokens", async () => {
    await expect(verifyAccessJwt(request(), env, "r1")).resolves.toMatchObject({ status: 401 });
    await expect(verifyAccessJwt(request(await sign("test-aud", Math.floor((Date.now() - 60_000) / 1000))), env, "r2")).resolves.toMatchObject({ status: 401 });
    await expect(verifyAccessJwt(request(await sign("other-aud")), env, "r3")).resolves.toMatchObject({ status: 401 });
  });
  it("accepts a valid token", async () => {
    await expect(verifyAccessJwt(request(await sign()), env, "r4")).resolves.toBe(true);
  });
});
