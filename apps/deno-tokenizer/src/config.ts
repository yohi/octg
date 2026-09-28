import { RELAY_MAX_INGRESS_BODY_BYTES, resolveMaxInputBytes } from "@octg/shared";
import type { RelayEnvironment } from "@octg/shared";

export interface DenoTokenizerServiceConfig {
  readonly authToken: string;
  readonly maxInputBytes: number;
  readonly maxRawBodyBytes: number;
}

/**
 * Exact required Deno relay key set (design section "Runtime configuration and
 * environment isolation"). Missing, partial, or invalid settings fail startup;
 * they never disable authentication or checks.
 */
export interface RelayServiceConfig {
  readonly environment: RelayEnvironment;
  readonly callbackOrigin: string;
  readonly serviceAuthToken: string;
  readonly ingressAuthToken: string;
  readonly gatewayBBaseUrl: string;
  readonly gatewayBToken: string;
  readonly maxInputBytes: number;
  readonly maxRequestDurationMs: number;
  readonly leaseTtlMs: number;
  readonly leaseRenewalIntervalMs: number;
}

const relayServiceTokenPattern = /^[!-~]{32,256}$/;
const relayPlainTokenPattern = /^[!-~]+$/;
const relayMaxRequestDurationMs = 3_600_000;
const relayLeaseTtlMs = 120_000;
const relayLeaseRenewalIntervalMs = 30_000;
const relayMaxInputBytesRaw = "1048576";

function invalidRelayConfig(): TypeError {
  return new TypeError("Invalid Deno relay configuration.");
}

function requireRelayEnv(
  readEnv: (name: string) => string | undefined,
  name: string,
): string {
  const value = readEnv(name);
  if (value === undefined || value.length === 0) {
    throw invalidRelayConfig();
  }
  return value;
}

function requireExactMs(
  readEnv: (name: string) => string | undefined,
  name: string,
  expectedMs: number,
): number {
  const raw = requireRelayEnv(readEnv, name);
  if (!/^\d+$/.test(raw) || Number(raw) !== expectedMs) {
    throw invalidRelayConfig();
  }
  return expectedMs;
}

/** Origin-only HTTPS URL: no path beyond /, query, fragment, or userinfo. */
function resolveCallbackOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidRelayConfig();
  }
  const pathOnly = url.pathname === "/" || url.pathname === "";
  const noExtras = url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  if (url.protocol !== "https:" || !pathOnly || !noExtras) {
    throw invalidRelayConfig();
  }
  return url.origin;
}

/** Fixed HTTPS Gateway B "/openai" base URL; never client-supplied. */
function resolveGatewayBBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidRelayConfig();
  }
  const noExtras = url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  if (url.protocol !== "https:" || !noExtras || url.pathname !== "/openai") {
    throw invalidRelayConfig();
  }
  return raw;
}

export function resolveRelayConfig(
  readEnv: (name: string) => string | undefined,
): RelayServiceConfig {
  const environmentRaw = requireRelayEnv(readEnv, "OCTG_RELAY_ENVIRONMENT");
  if (environmentRaw !== "preview" && environmentRaw !== "production") {
    throw invalidRelayConfig();
  }
  const serviceAuthToken = requireRelayEnv(readEnv, "OCTG_RELAY_SERVICE_AUTH_TOKEN");
  const ingressAuthToken = requireRelayEnv(readEnv, "OCTG_RELAY_INGRESS_AUTH_TOKEN");
  if (!relayServiceTokenPattern.test(serviceAuthToken)) {
    throw invalidRelayConfig();
  }
  if (!relayServiceTokenPattern.test(ingressAuthToken)) {
    throw invalidRelayConfig();
  }
  const gatewayBToken = requireRelayEnv(readEnv, "OCTG_RELAY_GATEWAY_B_TOKEN");
  if (!relayPlainTokenPattern.test(gatewayBToken)) {
    throw invalidRelayConfig();
  }
  const maxInputBytesRaw = requireRelayEnv(readEnv, "MAX_INPUT_BYTES");
  if (maxInputBytesRaw !== relayMaxInputBytesRaw) {
    throw invalidRelayConfig();
  }
  const maxInputBytes = resolveMaxInputBytes(maxInputBytesRaw);
  if (maxInputBytes !== RELAY_MAX_INGRESS_BODY_BYTES) {
    throw invalidRelayConfig();
  }

  return {
    environment: environmentRaw,
    callbackOrigin: resolveCallbackOrigin(
      requireRelayEnv(readEnv, "OCTG_RELAY_CALLBACK_ORIGIN"),
    ),
    serviceAuthToken,
    ingressAuthToken,
    gatewayBBaseUrl: resolveGatewayBBaseUrl(
      requireRelayEnv(readEnv, "OCTG_RELAY_GATEWAY_B_BASE_URL"),
    ),
    gatewayBToken,
    maxInputBytes,
    maxRequestDurationMs: requireExactMs(
      readEnv,
      "OCTG_RELAY_MAX_REQUEST_DURATION_MS",
      relayMaxRequestDurationMs,
    ),
    leaseTtlMs: requireExactMs(readEnv, "OCTG_RELAY_LEASE_TTL_MS", relayLeaseTtlMs),
    leaseRenewalIntervalMs: requireExactMs(
      readEnv,
      "OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS",
      relayLeaseRenewalIntervalMs,
    ),
  };
}

export function resolveServiceConfig(
  readEnv: (name: string) => string | undefined,
): DenoTokenizerServiceConfig {
  const authToken = readEnv("OCTG_TOKENIZER_AUTH_TOKEN");
  if (authToken === undefined || authToken.length === 0) {
    throw new TypeError("Invalid Deno tokenizer configuration.");
  }

  const maxInputBytesRaw = readEnv("MAX_INPUT_BYTES");
  const normalizedMaxInputBytes = maxInputBytesRaw?.trim();
  if (
    normalizedMaxInputBytes === undefined ||
    !/^\d+$/.test(normalizedMaxInputBytes) ||
    !Number.isSafeInteger(Number(normalizedMaxInputBytes)) ||
    Number(normalizedMaxInputBytes) <= 0
  ) {
    throw new TypeError("Invalid Deno tokenizer configuration.");
  }
  const maxInputBytes = resolveMaxInputBytes(maxInputBytesRaw);

  const expectedMaxInputBytesRaw = readEnv("OCTG_EXPECTED_MAX_INPUT_BYTES");
  if (expectedMaxInputBytesRaw === undefined) {
    throw new TypeError("Invalid Deno tokenizer configuration.");
  }
  const expectedMaxInputBytes = Number(expectedMaxInputBytesRaw);
  if (
    !Number.isSafeInteger(expectedMaxInputBytes) ||
    expectedMaxInputBytes !== maxInputBytes
  ) {
    throw new TypeError("Invalid Deno tokenizer configuration.");
  }

  return {
    authToken,
    maxInputBytes,
    maxRawBodyBytes: (6 * maxInputBytes) + 16,
  };
}
