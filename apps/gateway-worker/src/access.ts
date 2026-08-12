import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import { errInvalidApiKey, type OctgHttpError } from "@octg/shared";
import type { Env } from "./index";

export async function verifyAccessJwt(request: Request, env: Env, requestId: string): Promise<true | OctgHttpError> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return errInvalidApiKey(requestId);
  try {
    const jwks = env.ACCESS_JWT_PUBLIC_JWK ? createLocalJWKSet(JSON.parse(env.ACCESS_JWT_PUBLIC_JWK)) : createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      audience: env.ACCESS_AUD,
      issuer: env.ACCESS_TEAM_DOMAIN,
      requiredClaims: ["exp"],
    });
    if (typeof payload.exp !== "number") return errInvalidApiKey(requestId);
    return true;
  } catch {
    return errInvalidApiKey(requestId);
  }
}
