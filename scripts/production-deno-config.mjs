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

export function validateProductionDenoConfig(environment) {
  const values = environment !== null && typeof environment === "object"
    ? environment
    : {};
  const missing = [];
  const invalid = [];

  for (const name of [...PRODUCTION_DENO_VARIABLE_NAMES, PRODUCTION_INPUT_LIMIT_VARIABLE_NAME]) {
    const value = values[name];
    if (value === undefined || (typeof value === "string" && value.trim() === "")) {
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

  const prepareEndpoint = values.DENO_PREPARE_ENDPOINT;
  const prepareThreshold = values.DENO_PREPARE_THRESHOLD_BYTES;
  const hasPrepareEndpoint = isPresent(prepareEndpoint);
  const hasPrepareThreshold = isPresent(prepareThreshold);
  const hasPrepareValue = prepareEndpoint !== undefined || prepareThreshold !== undefined;
  const emptyPrepareNames = [
    isEmptyString(prepareEndpoint) ? "DENO_PREPARE_ENDPOINT" : undefined,
    isEmptyString(prepareThreshold) ? "DENO_PREPARE_THRESHOLD_BYTES" : undefined,
  ].filter((name) => name !== undefined);
  if (emptyPrepareNames.length > 0) {
    invalid.push(...emptyPrepareNames);
  } else if (hasPrepareValue && hasPrepareEndpoint !== hasPrepareThreshold) {
    invalid.push(hasPrepareEndpoint
      ? "DENO_PREPARE_ENDPOINT"
      : "DENO_PREPARE_THRESHOLD_BYTES");
  } else if (hasPrepareEndpoint && hasPrepareThreshold) {
    if (!isValidHttpsEndpoint(prepareEndpoint)) invalid.push("DENO_PREPARE_ENDPOINT");
    if (!isPositiveSafeInteger(prepareThreshold)) {
      invalid.push("DENO_PREPARE_THRESHOLD_BYTES");
    } else if (
      isPositiveSafeInteger(values.MAX_INPUT_BYTES) &&
      Number(prepareThreshold.trim()) > Number(values.MAX_INPUT_BYTES.trim())
    ) {
      invalid.push("DENO_PREPARE_THRESHOLD_BYTES");
    }
  }

  if (Object.prototype.hasOwnProperty.call(values, "OCTG_EXPECTED_MAX_INPUT_BYTES")) {
    invalid.push("OCTG_EXPECTED_MAX_INPUT_BYTES");
  }

  return {
    valid: missing.length === 0 && invalid.length === 0,
    missing,
    invalid: [...new Set(invalid)],
  };
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

function isPresent(value) {
  return value !== undefined && !isEmptyString(value);
}

function isEmptyString(value) {
  return typeof value === "string" && value.trim() === "";
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
  const result = validateProductionDenoConfig(process.env);
  if (!result.valid) {
    console.error(formatProductionDenoConfigError(result));
    process.exitCode = 1;
  }
}
