import { pathToFileURL } from "node:url";

export const PRODUCTION_DENO_VARIABLE_NAMES = [
  "DENO_TOKENIZER_ENDPOINT",
  "DENO_TOKENIZER_THRESHOLD_BYTES",
  "DENO_TOKENIZER_TIMEOUT_MS",
];

export function validateProductionDenoConfig(environment) {
  const values = environment !== null && typeof environment === "object"
    ? environment
    : {};
  const missing = [];
  const invalid = [];

  for (const name of PRODUCTION_DENO_VARIABLE_NAMES) {
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
  ]) {
    if (!missing.includes(name) && !isPositiveSafeInteger(values[name])) {
      invalid.push(name);
    }
  }

  return {
    valid: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
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
