import { describe, expect, it } from "vitest";
import { signRelayContext, signRelayGrantCredential } from "@octg/shared";
import type { RelayContextV1, RelayGrantCredentialV1 } from "@octg/shared";
import {
  parseRelayBearerAuthorization,
  resolveRelayConfig,
  verifyRelayContextHeader,
  verifyRelayGrantHeader,
  verifyRelayServiceAuth,
} from "../src/relay-auth";

const ISSUED_AT_MS = 1_000_000_000_000;
const HMAC_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const HMAC_KEY_ENCODED = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

const VALID_ENV = {
  OCTG_RELAY_ENABLED: "true",
  OCTG_RELAY_ENVIRONMENT: "preview",
  OCTG_RELAY_INGRESS_ENDPOINT: "https://relay.example/",
  OCTG_RELAY_INGRESS_AUTH_TOKEN: "i".repeat(32),
  OCTG_RELAY_SERVICE_AUTH_TOKEN: "s".repeat(32),
  OCTG_RELAY_CONTEXT_HMAC_KEY: HMAC_KEY_ENCODED,
} as const;

const CONTEXT: RelayContextV1 = {
  version: 1,
  audience: "octg-deno-relay",
  environment: "preview",
  route: "responses",
  requestId: "req_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  clientId: "client-1",
  idempotencyKeyHash: null,
  nonce: "bQ".repeat(21) + "b",
  issuedAtMs: ISSUED_AT_MS,
  expiresAtMs: ISSUED_AT_MS + 60_000,
};

const GRANT: RelayGrantCredentialV1 = {
  version: 1,
  audience: "octg-worker-relay",
  environment: "preview",
  route: "responses",
  requestId: "req_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  grantId: "0f0e5d1c-2b3a-4c5d-6e7f-8a9b0c1d2e3f",
  nonce: "bQ".repeat(21) + "b",
  clientId: "client-1",
  idempotencyKeyHash: "a".repeat(64),
  model: "openai/gpt-test",
  pool: "STANDARD",
  admissionUtcDay: "2026-09-27",
  leaseGeneration: "9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d",
  issuedAtMs: ISSUED_AT_MS,
  expiresAtMs: ISSUED_AT_MS + 3_900_000,
};

describe("resolveRelayConfig", () => {
  it("returns disabled when OCTG_RELAY_ENABLED is absent", () => {
    // Given: an environment without the relay enable flag.
    // When: the relay configuration is resolved.
    // Then: the relay stays disabled.
    expect(resolveRelayConfig({})).toEqual({ kind: "disabled" });
  });

  it("keeps the relay disabled when stray relay values exist without the enable flag", () => {
    // Given: residual relay bindings but no enable flag.
    const environment = { OCTG_RELAY_SERVICE_AUTH_TOKEN: "s".repeat(32) };
    // When: the relay configuration is resolved.
    // Then: the relay stays disabled.
    expect(resolveRelayConfig(environment)).toEqual({ kind: "disabled" });
  });

  it("returns disabled when OCTG_RELAY_ENABLED is exactly false", () => {
    // Given: the relay explicitly disabled alongside complete relay values.
    const environment = { ...VALID_ENV, OCTG_RELAY_ENABLED: "false" };
    // When: the relay configuration is resolved.
    // Then: the relay stays disabled.
    expect(resolveRelayConfig(environment)).toEqual({ kind: "disabled" });
  });

  it("returns enabled with the decoded key for a complete valid configuration", () => {
    // Given: every relay binding present and valid.
    // When: the relay configuration is resolved.
    // Then: the enabled configuration retains validated values and key bytes.
    expect(resolveRelayConfig(VALID_ENV)).toEqual({
      kind: "enabled",
      environment: "preview",
      ingressEndpoint: "https://relay.example/",
      ingressAuthToken: "i".repeat(32),
      serviceAuthToken: "s".repeat(32),
      contextHmacKey: HMAC_KEY,
    });
  });

  it.each([
    ["OCTG_RELAY_ENVIRONMENT", {
      OCTG_RELAY_INGRESS_ENDPOINT: VALID_ENV.OCTG_RELAY_INGRESS_ENDPOINT,
      OCTG_RELAY_INGRESS_AUTH_TOKEN: VALID_ENV.OCTG_RELAY_INGRESS_AUTH_TOKEN,
      OCTG_RELAY_SERVICE_AUTH_TOKEN: VALID_ENV.OCTG_RELAY_SERVICE_AUTH_TOKEN,
      OCTG_RELAY_CONTEXT_HMAC_KEY: VALID_ENV.OCTG_RELAY_CONTEXT_HMAC_KEY,
    }],
    ["OCTG_RELAY_INGRESS_ENDPOINT", {
      OCTG_RELAY_ENVIRONMENT: VALID_ENV.OCTG_RELAY_ENVIRONMENT,
      OCTG_RELAY_INGRESS_AUTH_TOKEN: VALID_ENV.OCTG_RELAY_INGRESS_AUTH_TOKEN,
      OCTG_RELAY_SERVICE_AUTH_TOKEN: VALID_ENV.OCTG_RELAY_SERVICE_AUTH_TOKEN,
      OCTG_RELAY_CONTEXT_HMAC_KEY: VALID_ENV.OCTG_RELAY_CONTEXT_HMAC_KEY,
    }],
    ["OCTG_RELAY_INGRESS_AUTH_TOKEN", {
      OCTG_RELAY_ENVIRONMENT: VALID_ENV.OCTG_RELAY_ENVIRONMENT,
      OCTG_RELAY_INGRESS_ENDPOINT: VALID_ENV.OCTG_RELAY_INGRESS_ENDPOINT,
      OCTG_RELAY_SERVICE_AUTH_TOKEN: VALID_ENV.OCTG_RELAY_SERVICE_AUTH_TOKEN,
      OCTG_RELAY_CONTEXT_HMAC_KEY: VALID_ENV.OCTG_RELAY_CONTEXT_HMAC_KEY,
    }],
    ["OCTG_RELAY_SERVICE_AUTH_TOKEN", {
      OCTG_RELAY_ENVIRONMENT: VALID_ENV.OCTG_RELAY_ENVIRONMENT,
      OCTG_RELAY_INGRESS_ENDPOINT: VALID_ENV.OCTG_RELAY_INGRESS_ENDPOINT,
      OCTG_RELAY_INGRESS_AUTH_TOKEN: VALID_ENV.OCTG_RELAY_INGRESS_AUTH_TOKEN,
      OCTG_RELAY_CONTEXT_HMAC_KEY: VALID_ENV.OCTG_RELAY_CONTEXT_HMAC_KEY,
    }],
    ["OCTG_RELAY_CONTEXT_HMAC_KEY", {
      OCTG_RELAY_ENVIRONMENT: VALID_ENV.OCTG_RELAY_ENVIRONMENT,
      OCTG_RELAY_INGRESS_ENDPOINT: VALID_ENV.OCTG_RELAY_INGRESS_ENDPOINT,
      OCTG_RELAY_INGRESS_AUTH_TOKEN: VALID_ENV.OCTG_RELAY_INGRESS_AUTH_TOKEN,
      OCTG_RELAY_SERVICE_AUTH_TOKEN: VALID_ENV.OCTG_RELAY_SERVICE_AUTH_TOKEN,
    }],
  ] as const)("returns invalid, not disabled, when %s is missing", (_name, environment) => {
    // Given: an enabled relay configuration with one missing binding.
    // When: the relay configuration is resolved.
    // Then: it fails closed as invalid.
    expect(resolveRelayConfig({ OCTG_RELAY_ENABLED: "true", ...environment })).toEqual({ kind: "invalid" });
  });

  it.each([
    ["an uppercase flag", "TRUE"],
    ["a numeric flag", "1"],
    ["an empty flag", ""],
  ] as const)("returns invalid for %s of OCTG_RELAY_ENABLED", (_name, enabled) => {
    // Given: an enable flag that is neither true nor false.
    // When: the relay configuration is resolved.
    // Then: it fails closed as invalid.
    expect(resolveRelayConfig({ ...VALID_ENV, OCTG_RELAY_ENABLED: enabled })).toEqual({ kind: "invalid" });
  });

  it.each([
    ["an unknown environment", "staging"],
    ["a mixed-case environment", "Preview"],
    ["an empty environment", ""],
  ] as const)("returns invalid for %s", (_name, environmentValue) => {
    // Given: an enabled relay configuration with an unusable environment.
    // When: the relay configuration is resolved.
    // Then: it fails closed as invalid.
    expect(resolveRelayConfig({ ...VALID_ENV, OCTG_RELAY_ENVIRONMENT: environmentValue })).toEqual({
      kind: "invalid",
    });
  });

  it.each([
    ["an HTTP endpoint", "http://relay.example/"],
    ["an endpoint with credentials", "https://user:password@relay.example/"],
    ["an endpoint with a path", "https://relay.example/relay/v1/responses"],
    ["an endpoint with a query", "https://relay.example/?x=1"],
    ["an endpoint with a fragment", "https://relay.example/#x"],
    ["a non-URL endpoint", "not-a-url"],
    ["an empty endpoint", ""],
  ] as const)("returns invalid for %s", (_name, endpoint) => {
    // Given: an enabled relay configuration with an unusable ingress endpoint.
    // When: the relay configuration is resolved.
    // Then: it fails closed as invalid.
    expect(resolveRelayConfig({ ...VALID_ENV, OCTG_RELAY_INGRESS_ENDPOINT: endpoint })).toEqual({
      kind: "invalid",
    });
  });

  it.each([
    ["a token below 32 bytes", "i".repeat(31)],
    ["a token above 256 bytes", "i".repeat(257)],
    ["a token with whitespace", `${"i".repeat(16)} ${"i".repeat(15)}`],
    ["a non-ASCII token", "i".repeat(31) + "é"],
    ["an empty token", ""],
  ] as const)("returns invalid for %s as OCTG_RELAY_INGRESS_AUTH_TOKEN", (_name, token) => {
    // Given: an enabled relay configuration with an unusable service token.
    // When: the relay configuration is resolved.
    // Then: it fails closed as invalid.
    expect(resolveRelayConfig({ ...VALID_ENV, OCTG_RELAY_INGRESS_AUTH_TOKEN: token })).toEqual({
      kind: "invalid",
    });
  });

  it("returns invalid for a non-printable OCTG_RELAY_SERVICE_AUTH_TOKEN", () => {
    // Given: a service token containing a control character.
    const environment = { ...VALID_ENV, OCTG_RELAY_SERVICE_AUTH_TOKEN: `${"s".repeat(16)}\t${"s".repeat(15)}` };
    // When: the relay configuration is resolved.
    // Then: it fails closed as invalid.
    expect(resolveRelayConfig(environment)).toEqual({ kind: "invalid" });
  });

  it.each([
    ["a truncated key", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh"],
    ["a padded key", `${HMAC_KEY_ENCODED}=`],
    ["a key with invalid characters", `${HMAC_KEY_ENCODED.slice(0, 10)}+${HMAC_KEY_ENCODED.slice(11)}`],
    ["an empty key", ""],
  ] as const)("returns invalid for %s as OCTG_RELAY_CONTEXT_HMAC_KEY", (_name, key) => {
    // Given: an enabled relay configuration with an unusable HMAC key.
    // When: the relay configuration is resolved.
    // Then: it fails closed as invalid.
    expect(resolveRelayConfig({ ...VALID_ENV, OCTG_RELAY_CONTEXT_HMAC_KEY: key })).toEqual({
      kind: "invalid",
    });
  });
});

describe("parseRelayBearerAuthorization", () => {
  it("extracts the token of an exact Bearer header", () => {
    // Given: a Bearer Authorization header within the byte bound.
    // When: the credential is extracted.
    // Then: only the token value is returned.
    expect(parseRelayBearerAuthorization(`Bearer ${"s".repeat(32)}`)).toBe("s".repeat(32));
  });

  it.each([
    ["an absent header", undefined],
    ["a null header", null],
    ["an empty header", ""],
    ["a lowercase scheme", `bearer ${"s".repeat(32)}`],
    ["a bare token without scheme", "s".repeat(32)],
    ["an empty token", "Bearer "],
    ["a header above 263 bytes", `Bearer ${"s".repeat(257)}`],
  ] as const)("rejects %s", (_name, headerValue) => {
    // Given: an Authorization header value that is not an exact Bearer credential.
    // When: the credential is extracted.
    // Then: extraction fails.
    expect(parseRelayBearerAuthorization(headerValue)).toBeUndefined();
  });
});

describe("verifyRelayServiceAuth", () => {
  it("accepts the configured service token", () => {
    // Given: an enabled relay configuration and its own service bearer header.
    const config = resolveRelayConfig(VALID_ENV);
    if (config.kind !== "enabled") throw new Error("fixture configuration must resolve to enabled");
    // When: Deno presents the exact service token.
    // Then: the callback is authenticated.
    expect(verifyRelayServiceAuth(`Bearer ${config.serviceAuthToken}`, config)).toBe(true);
  });

  it.each([
    ["a wrong token", `Bearer ${"x".repeat(32)}`],
    ["an absent header", undefined],
    ["a non-Bearer header", "s".repeat(32)],
  ] as const)("rejects %s", (_name, headerValue) => {
    // Given: an enabled relay configuration.
    const config = resolveRelayConfig(VALID_ENV);
    if (config.kind !== "enabled") throw new Error("fixture configuration must resolve to enabled");
    // When: the presented credential does not match the configured secret.
    // Then: the callback is not authenticated.
    expect(verifyRelayServiceAuth(headerValue, config)).toBe(false);
  });
});

describe("verifyRelayContextHeader", () => {
  it("verifies a signed context from the decision callback header", async () => {
    // Given: an enabled configuration and a context signed with its key.
    const config = resolveRelayConfig(VALID_ENV);
    if (config.kind !== "enabled") throw new Error("fixture configuration must resolve to enabled");
    const token = await signRelayContext(CONTEXT, config.contextHmacKey);
    // When: the context header is verified at the issue time.
    const verified = await verifyRelayContextHeader(token, config, ISSUED_AT_MS);
    // Then: the verified claims are returned.
    expect(verified).toEqual(CONTEXT);
  });

  it.each([
    ["an absent header", undefined],
    ["a production context", { ...CONTEXT, environment: "production" }],
  ] as const)("rejects %s against a preview configuration", async (_name, context) => {
    // Given: an enabled preview configuration.
    const config = resolveRelayConfig(VALID_ENV);
    if (config.kind !== "enabled") throw new Error("fixture configuration must resolve to enabled");
    const token = context === undefined ? undefined : await signRelayContext(context, config.contextHmacKey);
    // When: the context header is missing or belongs to another environment.
    // Then: verification fails.
    expect(await verifyRelayContextHeader(token, config, ISSUED_AT_MS)).toBeUndefined();
  });
});

describe("verifyRelayGrantHeader", () => {
  it("verifies a signed grant from the callback header", async () => {
    // Given: an enabled configuration and a grant signed with its key.
    const config = resolveRelayConfig(VALID_ENV);
    if (config.kind !== "enabled") throw new Error("fixture configuration must resolve to enabled");
    const token = await signRelayGrantCredential(GRANT, config.contextHmacKey);
    // When: the grant header is verified at the issue time.
    const verified = await verifyRelayGrantHeader(token, config, ISSUED_AT_MS);
    // Then: the verified claims are returned.
    expect(verified).toEqual(GRANT);
  });

  it("rejects an absent grant header", async () => {
    // Given: an enabled configuration without a grant header.
    const config = resolveRelayConfig(VALID_ENV);
    if (config.kind !== "enabled") throw new Error("fixture configuration must resolve to enabled");
    // When: the grant header is verified.
    // Then: verification fails.
    expect(await verifyRelayGrantHeader(undefined, config, ISSUED_AT_MS)).toBeUndefined();
  });
});
