import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import { errInvalidApiKey, type OctgHttpError } from "@octg/shared";
import type { Env } from "./index";

export async function verifyAccessJwt(request: Request, env: Env, requestId: string): Promise<true | OctgHttpError> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return errInvalidApiKey(requestId);
  try {
    const jwks = env.ACCESS_JWT_PUBLIC_JWK ? createLocalJWKSet(JSON.parse(env.ACCESS_JWT_PUBLIC_JWK)) : createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    await jwtVerify(token, jwks, { audience: env.ACCESS_AUD, issuer: env.ACCESS_TEAM_DOMAIN });
    return true;
  } catch {
    return errInvalidApiKey(requestId);
  }
}

export async function verifyAccessJwtOrServiceToken(request: Request, env: Env, requestId: string): Promise<true | OctgHttpError> {
  const jwtToken = request.headers.get("cf-access-jwt-assertion");
  if (jwtToken) {
    try {
      const jwks = env.ACCESS_JWT_PUBLIC_JWK ? createLocalJWKSet(JSON.parse(env.ACCESS_JWT_PUBLIC_JWK)) : createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
      await jwtVerify(jwtToken, jwks, { audience: env.ACCESS_AUD, issuer: env.ACCESS_TEAM_DOMAIN });
      return true;
    } catch {
      return errInvalidApiKey(requestId);
    }
  }
  const clientId = request.headers.get("CF-Access-Client-Id");
  if (!clientId) return errInvalidApiKey(requestId);
  const allowed = env.ACCESS_ALLOWED_SERVICE_TOKEN_IDS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (!allowed.includes(clientId)) return errInvalidApiKey(requestId);
  return true;
}
