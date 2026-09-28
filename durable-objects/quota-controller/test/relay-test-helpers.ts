import { env } from "cloudflare:test";
import type { QuotaController } from "../src/quota-controller";
import type { RelayGrant, RelayGrantBinding } from "../src/relay-grant";

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const quotaController = (day: string): DurableObjectStub<QuotaController> =>
  env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));

export function requestId(seed: number): string {
  let body = "";
  for (let i = 0; i < 26; i += 1) body += ID_ALPHABET[(seed * 7 + i * 3) % 32];
  return `req_${body}`;
}

export function nonce(seed: number): string {
  return `n${String(seed)}`.padEnd(43, "x");
}

export function grantBinding(
  grant: RelayGrant,
  overrides: Partial<RelayGrantBinding> = {},
): RelayGrantBinding {
  return {
    requestId: grant.requestId,
    grantId: grant.grantId,
    leaseGeneration: grant.leaseGeneration,
    claims: {
      version: 1,
      audience: "octg-worker-relay",
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
    },
    ...overrides,
  };
}
