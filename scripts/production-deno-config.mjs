import { pathToFileURL } from "node:url";

export const PRODUCTION_DENO_VARIABLE_NAMES = [
  "DENO_TOKENIZER_ENDPOINT",
  "DENO_TOKENIZER_THRESHOLD_BYTES",
  "DENO_TOKENIZER_TIMEOUT_MS",
];

export const PRODUCTION_PREPARE_VARIABLE_NAMES = [
  "DENO_PREPARE_ENDPOINT",
  "DENO_PREPARE_THRESHOLD_BYTES",
];

export const PRODUCTION_INPUT_LIMIT_VARIABLE_NAME = "MAX_INPUT_BYTES";

export const CANONICAL_PREPARE_THRESHOLD_BYTES = "1";

export const PRODUCTION_RELAY_VARIABLE_NAMES = [
  "OCTG_RELAY_ENVIRONMENT",
  "OCTG_RELAY_CALLBACK_ORIGIN",
  "OCTG_RELAY_GATEWAY_B_BASE_URL",
  "OCTG_RELAY_MAX_REQUEST_DURATION_MS",
  "OCTG_RELAY_LEASE_TTL_MS",
  "OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS",
];

export const CANONICAL_RELAY_ENVIRONMENT = "production";
export const CANONICAL_RELAY_MAX_REQUEST_DURATION_MS = "3600000";
export const CANONICAL_RELAY_LEASE_TTL_MS = "120000";
export const CANONICAL_RELAY_LEASE_RENEWAL_INTERVAL_MS = "30000";

export function validateProductionDenoConfig(environment) {
  const values = environment !== null && typeof environment === "object"
    ? environment
    : {};
  const missing = [];
  const invalid = [];

  for (const name of [
    ...PRODUCTION_DENO_VARIABLE_NAMES,
    ...PRODUCTION_PREPARE_VARIABLE_NAMES,
    PRODUCTION_INPUT_LIMIT_VARIABLE_NAME,
  ]) {
    const value = values[name];
    if (isMissingValue(value)) {
      missing.push(name);
    }
  }

  if (!missing.includes("DENO_TOKENIZER_ENDPOINT") &&
      !isValidHttpsEndpoint(values.DENO_TOKENIZER_ENDPOINT)) {
    invalid.push("DENO_TOKENIZER_ENDPOINT");
  }

  for (const name of [
    "DENO_TOKENIZER_THRESHOLD_BYTES",
    "DENO_TOKENIZER_TIMEOUT_MS",
    PRODUCTION_INPUT_LIMIT_VARIABLE_NAME,
  ]) {
    if (!missing.includes(name) && !isPositiveSafeInteger(values[name])) {
      invalid.push(name);
    }
  }

  const inputLimit = values[PRODUCTION_INPUT_LIMIT_VARIABLE_NAME];
  if (
    !missing.includes(PRODUCTION_INPUT_LIMIT_VARIABLE_NAME) &&
    (typeof inputLimit !== "string" || inputLimit.trim() !== "1048576")
  ) {
    invalid.push(PRODUCTION_INPUT_LIMIT_VARIABLE_NAME);
  }

  const prepareEndpoint = values.DENO_PREPARE_ENDPOINT;
  const prepareThreshold = values.DENO_PREPARE_THRESHOLD_BYTES;
  if (!missing.includes("DENO_PREPARE_ENDPOINT") && !isValidHttpsEndpoint(prepareEndpoint)) {
    invalid.push("DENO_PREPARE_ENDPOINT");
  }
  if (
    !missing.includes("DENO_PREPARE_THRESHOLD_BYTES") &&
    (typeof prepareThreshold !== "string" || prepareThreshold.trim() !== CANONICAL_PREPARE_THRESHOLD_BYTES)
  ) {
    invalid.push("DENO_PREPARE_THRESHOLD_BYTES");
  }

  if (Object.prototype.hasOwnProperty.call(values, "OCTG_EXPECTED_MAX_INPUT_BYTES")) {
    invalid.push("OCTG_EXPECTED_MAX_INPUT_BYTES");
  }

  validateProductionRelayOptIn(values, missing, invalid);

  return {
    valid: missing.length === 0 && invalid.length === 0,
    missing,
    invalid: [...new Set(invalid)],
  };
}

function isMissingValue(value) {
  return value === undefined || (typeof value === "string" && value.trim() === "");
}

/**
 * Relay opt-in contract (SPEC.md section 19.1): `OCTG_RELAY_ENABLED` is exactly
 * "true" or "false"; absent means disabled. Enabling requires the complete
 * production relay variable group with pinned canonical values. Relay Secrets
 * are never visible to this validator and stay out of scope here.
 */
function validateProductionRelayOptIn(values, missing, invalid) {
  const enabled = values.OCTG_RELAY_ENABLED;
  if (!isRelayOptedIn(enabled, invalid)) return;

  collectMissingRelayVariables(values, missing);
  validateRelayEndpointFormats(values, missing, invalid);
  validateCanonicalRelayDurations(values, missing, invalid);
}

function isRelayOptedIn(enabled, invalid) {
  if (enabled === undefined || enabled === "false") return false;
  if (enabled === "true") return true;
  invalid.push("OCTG_RELAY_ENABLED");
  return false;
}

function collectMissingRelayVariables(values, missing) {
  for (const name of PRODUCTION_RELAY_VARIABLE_NAMES) {
    if (isMissingValue(values[name])) missing.push(name);
  }
}

function validateRelayEndpointFormats(values, missing, invalid) {
  if (!missing.includes("OCTG_RELAY_ENVIRONMENT") &&
      values.OCTG_RELAY_ENVIRONMENT !== CANONICAL_RELAY_ENVIRONMENT) {
    invalid.push("OCTG_RELAY_ENVIRONMENT");
  }
  if (!missing.includes("OCTG_RELAY_CALLBACK_ORIGIN") &&
      !isHttpsOrigin(values.OCTG_RELAY_CALLBACK_ORIGIN)) {
    invalid.push("OCTG_RELAY_CALLBACK_ORIGIN");
  }
  if (!missing.includes("OCTG_RELAY_GATEWAY_B_BASE_URL") &&
      !isGatewayBOpenAIBaseUrl(values.OCTG_RELAY_GATEWAY_B_BASE_URL)) {
    invalid.push("OCTG_RELAY_GATEWAY_B_BASE_URL");
  }
}

function validateCanonicalRelayDurations(values, missing, invalid) {
  const canonicalValues = new Map([
    ["OCTG_RELAY_MAX_REQUEST_DURATION_MS", CANONICAL_RELAY_MAX_REQUEST_DURATION_MS],
    ["OCTG_RELAY_LEASE_TTL_MS", CANONICAL_RELAY_LEASE_TTL_MS],
    ["OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS", CANONICAL_RELAY_LEASE_RENEWAL_INTERVAL_MS],
  ]);
  for (const [name, canonical] of canonicalValues) {
    if (!missing.includes(name) && values[name] !== canonical) {
      invalid.push(name);
    }
  }
}

function isHttpsOrigin(value) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0 &&
      (url.pathname === "/" || url.pathname === "") && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function isGatewayBOpenAIBaseUrl(value) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0 &&
      (/^\/v1\/[^/]+\/[^/]+\/openai$/.test(url.pathname) || url.pathname === "/openai") &&
      url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

export function formatProductionDenoConfigError(result) {
  const lines = ["octg.production_deno_config_error"];
  if (result.missing.length > 0) lines.push(`missing: ${result.missing.join(", ")}`);
  if (result.invalid.length > 0) lines.push(`invalid: ${result.invalid.join(", ")}`);
  return lines.join("\n");
}

function isValidHttpsEndpoint(value) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function isPositiveSafeInteger(value) {
  if (typeof value !== "string") return false;
  if (!/^\d+$/.test(value.trim())) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function isMainModule() {
  return process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const environment = { ...process.env };
  if (environment.OCTG_RELAY_ENABLED === "") delete environment.OCTG_RELAY_ENABLED;
  const result = validateProductionDenoConfig(environment);
  if (!result.valid) {
    console.error(formatProductionDenoConfigError(result));
    process.exitCode = 1;
  }
}
