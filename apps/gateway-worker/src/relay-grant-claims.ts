import { RELAY_GRANT_AUDIENCE } from "@octg/shared";
import type { RelayGrantCredentialV1 } from "@octg/shared";
import type { RelayGrant } from "../../../durable-objects/quota-controller/src/relay-grant";

export function relayGrantClaimsOf(grant: RelayGrant): RelayGrantCredentialV1 {
  return {
    version: 1,
    audience: RELAY_GRANT_AUDIENCE,
    environment: grant.environment,
    route: "responses",
    requestId: grant.requestId,
    grantId: grant.grantId,
    nonce: grant.nonce,
    clientId: grant.clientId,
    idempotencyKeyHash: grant.idempotencyKeyHash,
    model: grant.model,
    pool: grant.pool,
    admissionUtcDay: grant.admissionUtcDay,
    leaseGeneration: grant.leaseGeneration,
    issuedAtMs: grant.issuedAtMs,
    expiresAtMs: grant.credentialExpiresAtMs,
  };
}
