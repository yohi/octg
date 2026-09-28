/**
 * Relay environment resolution and credential adapters for the gateway
 * Worker (design "Runtime configuration and environment isolation").
 *
 * Pure configuration and authentication only: no routes, DO dispatch, or
 * grant lifecycle. The context HMAC key never leaves the Cloudflare side and
 * is never configured in Deno.
 */

import {
  compareRelayBearerConstantTime,
  decodeRelayContextHmacKey,
  RELAY_MAX_AUTHORIZATION_HEADER_BYTES,
  verifyRelayContext,
  verifyRelayGrantCredential,
} from "@octg/shared";
import type {
  RelayContextV1,
  RelayEnvironment,
  RelayGrantCredentialV1,
} from "@octg/shared";

const BEARER_PREFIX = "Bearer ";
const UTF8_ENCODER = new TextEncoder();

/** Worker relay bindings; the enable flag selects the resolution mode. */
export interface RelayEnvConfig {
  readonly OCTG_RELAY_ENABLED?: string;
  readonly OCTG_RELAY_ENVIRONMENT?: string;
  readonly OCTG_RELAY_INGRESS_ENDPOINT?: string;
  readonly OCTG_RELAY_INGRESS_AUTH_TOKEN?: string;
  readonly OCTG_RELAY_SERVICE_AUTH_TOKEN?: string;
  readonly OCTG_RELAY_CONTEXT_HMAC_KEY?: string;
}

export type RelayConfig =
  | { readonly kind: "disabled" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "enabled";
      readonly environment: RelayEnvironment;
      readonly ingressEndpoint: string;
      readonly ingressAuthToken: string;
      readonly serviceAuthToken: string;
      readonly contextHmacKey: Uint8Array;
    };

export type EnabledRelayConfig = Extract<RelayConfig, { readonly kind: "enabled" }>;

/**
 * Resolves the relay mode from the Worker environment. `OCTG_RELAY_ENABLED`
 * is exactly `true` to enable and `false` to disable; absent means disabled
 * and any other value is invalid. An enabled relay requires every binding to
 * be present and valid: partial or invalid configuration is invalid, never a
 * silent disable or legacy fallback.
 */
export function resolveRelayConfig(env: RelayEnvConfig): RelayConfig {
  const enabled = env.OCTG_RELAY_ENABLED;
  if (enabled === undefined || enabled === "false") return { kind: "disabled" };
  if (enabled !== "true") return { kind: "invalid" };

  const environment = parseRelayEnvironment(env.OCTG_RELAY_ENVIRONMENT);
  if (environment === undefined) return { kind: "invalid" };

  const endpoint = env.OCTG_RELAY_INGRESS_ENDPOINT;
  if (endpoint === undefined || !isRelayIngressEndpoint(endpoint)) return { kind: "invalid" };

  const ingressToken = env.OCTG_RELAY_INGRESS_AUTH_TOKEN;
  if (ingressToken === undefined || !isRelayServiceToken(ingressToken)) return { kind: "invalid" };

  const serviceToken = env.OCTG_RELAY_SERVICE_AUTH_TOKEN;
  if (serviceToken === undefined || !isRelayServiceToken(serviceToken)) return { kind: "invalid" };

  const encodedKey = env.OCTG_RELAY_CONTEXT_HMAC_KEY;
  const contextHmacKey = encodedKey === undefined ? undefined : decodeRelayContextHmacKey(encodedKey);
  if (contextHmacKey === undefined) return { kind: "invalid" };

  return {
    kind: "enabled",
    environment,
    ingressEndpoint: endpoint,
    ingressAuthToken: ingressToken,
    serviceAuthToken: serviceToken,
    contextHmacKey,
  };
}

function parseRelayEnvironment(value: string | undefined): RelayEnvironment | undefined {
  if (value === "preview" || value === "production") return value;
  return undefined;
}

/** HTTPS origin-only endpoint: no path beyond /, query, fragment, or userinfo. */
function isRelayIngressEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const pathOnly = url.pathname === "/" || url.pathname === "";
    const noExtras = url.username.length === 0 && url.password.length === 0 && url.search === "" && url.hash === "";
    return url.protocol === "https:" && pathOnly && noExtras;
  } catch {
    // URL parse failure IS the invalid-endpoint condition here.
    return false;
  }
}

/** 32-256 printable ASCII bytes without whitespace (design service tokens). */
function isRelayServiceToken(value: string): boolean {
  const bytes = UTF8_ENCODER.encode(value);
  if (bytes.byteLength < 32 || bytes.byteLength > 256) return false;
  for (const byte of bytes) {
    if (byte < 0x21 || byte > 0x7e) return false;
  }
  return true;
}

/** Extracts the token of an exact `Bearer <token>` Authorization header. */
export function parseRelayBearerAuthorization(
  headerValue: string | null | undefined,
): string | undefined {
  if (headerValue === null || headerValue === undefined) return undefined;
  if (headerValue.length > RELAY_MAX_AUTHORIZATION_HEADER_BYTES) return undefined;
  if (!headerValue.startsWith(BEARER_PREFIX)) return undefined;
  const token = headerValue.slice(BEARER_PREFIX.length);
  return token.length === 0 ? undefined : token;
}

/** Constant-time Deno → Worker service bearer check for relay callbacks. */
export function verifyRelayServiceAuth(
  headerValue: string | null | undefined,
  config: EnabledRelayConfig,
): boolean {
  const presented = parseRelayBearerAuthorization(headerValue);
  if (presented === undefined) return false;
  return compareRelayBearerConstantTime(config.serviceAuthToken, presented);
}

/** Verifies the `X-OCTG-Relay-Context` header of a decision callback. */
export async function verifyRelayContextHeader(
  headerValue: string | null | undefined,
  config: EnabledRelayConfig,
  nowMs: number,
): Promise<RelayContextV1 | undefined> {
  if (headerValue === null || headerValue === undefined) return undefined;
  return verifyRelayContext(headerValue, config.contextHmacKey, config.environment, nowMs);
}

/** Verifies the `X-OCTG-Relay-Grant` header of activation, renewal, and
 *  terminal callbacks. */
export async function verifyRelayGrantHeader(
  headerValue: string | null | undefined,
  config: EnabledRelayConfig,
  nowMs: number,
): Promise<RelayGrantCredentialV1 | undefined> {
  if (headerValue === null || headerValue === undefined) return undefined;
  return verifyRelayGrantCredential(headerValue, config.contextHmacKey, config.environment, nowMs);
}
