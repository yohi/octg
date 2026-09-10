import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { assertPreviewQuotaAllocation } from "./preview-quota-validator.mjs";

export const PREVIEW_DENO_VARIABLE_NAMES = Object.freeze([
  "DENO_TOKENIZER_ENDPOINT",
  "DENO_TOKENIZER_THRESHOLD_BYTES",
  "DENO_TOKENIZER_TIMEOUT_MS",
]);

const DENO_CONFIG_NAMES = Object.freeze([
  ...PREVIEW_DENO_VARIABLE_NAMES,
  "DENO_TOKENIZER_AUTH_TOKEN",
  "DENO_PREPARE_ENDPOINT",
  "DENO_PREPARE_THRESHOLD_BYTES",
]);

export function buildPreviewWorkerConfig(baseConfig, options) {
  if (baseConfig === null || typeof baseConfig !== "object") {
    throw new TypeError("Preview Worker configuration must be an object");
  }

  const config = structuredClone(baseConfig);
  const {
    projectRoot,
    databaseId,
    databaseName,
    workerName,
    upstreamBaseUrl,
    standardLimit,
    miniLimit,
    maxInputBytes,
    deno,
    prepare,
  } = options ?? {};

  requireNonEmpty("Preview database ID", databaseId);
  requireNonEmpty("Preview database name", databaseName);
  requireNonEmpty("Preview Worker name", workerName);
  requireNonEmpty("Preview upstream endpoint", upstreamBaseUrl);
  requireNonEmpty("Preview STANDARD quota", standardLimit);
  requireNonEmpty("Preview MINI quota", miniLimit);
  requireNonEmpty("Preview project root", projectRoot);
  requirePositiveSafeInteger("Preview input limit", maxInputBytes);

  const productionDatabase = Array.isArray(config.d1_databases)
    ? config.d1_databases.find((entry) => entry?.binding === "DB")
    : undefined;
  if (productionDatabase === undefined) {
    throw new Error("Expected a DB D1 binding in the base Worker configuration");
  }

  const productionEndpoint = config.vars?.DENO_TOKENIZER_ENDPOINT;
  const normalizedProductionPrepareEndpoint = typeof config.vars?.DENO_PREPARE_ENDPOINT === "string"
    ? normalizeEndpoint(config.vars.DENO_PREPARE_ENDPOINT)
    : undefined;
  const normalizedPrepare = normalizeOptionalPrepare(prepare);
  if (normalizedPrepare !== undefined && deno === undefined) {
    throw new TypeError("Deno Preview prepare configuration requires a tokenizer configuration");
  }

  assertPreviewQuotaAllocation({
    production: {
      STANDARD: Number(config.vars?.QUOTA_LIMIT_STANDARD),
      MINI: Number(config.vars?.QUOTA_LIMIT_MINI),
    },
    preview: {
      STANDARD: Number(standardLimit),
      MINI: Number(miniLimit),
    },
  });

  config.name = workerName;
  config.main = `${projectRoot}/apps/gateway-worker/src/index.ts`;
  config.assets = { ...config.assets, directory: `${projectRoot}/apps/gateway-worker/public` };
  config.vars = {
    ...config.vars,
    QUOTA_LIMIT_STANDARD: standardLimit,
    QUOTA_LIMIT_MINI: miniLimit,
    MAX_INPUT_BYTES: maxInputBytes.trim(),
    OCTG_UPSTREAM_BASE_URL: upstreamBaseUrl,
  };
  for (const name of DENO_CONFIG_NAMES) {
    delete config.vars[name];
  }
  delete config.triggers;
  config.d1_databases = [{
    ...productionDatabase,
    binding: "DB",
    database_id: databaseId,
    database_name: databaseName,
    migrations_dir: `${projectRoot}/db/migrations`,
    remote: true,
  }];

  if (deno !== undefined) {
    validatePreviewDenoConfig(deno, productionEndpoint, maxInputBytes);
    config.vars.DENO_TOKENIZER_ENDPOINT = deno.endpoint.trim();
    config.vars.DENO_TOKENIZER_THRESHOLD_BYTES = deno.thresholdBytes.trim();
    config.vars.DENO_TOKENIZER_TIMEOUT_MS = deno.timeoutMs.trim();
  }

  if (normalizedPrepare !== undefined) {
    validatePreviewPrepareConfig(normalizedPrepare, maxInputBytes, normalizedProductionPrepareEndpoint);
    config.vars.DENO_PREPARE_ENDPOINT = normalizedPrepare.endpoint.trim();
    config.vars.DENO_PREPARE_THRESHOLD_BYTES = normalizedPrepare.thresholdBytes.trim();
  }

  return config;
}

function normalizeOptionalPrepare(prepare) {
  if (prepare === undefined) return undefined;
  return prepare;
}

function validatePreviewDenoConfig(deno, productionEndpoint, maxInputBytes) {
  if (deno === null || typeof deno !== "object") {
    throw new TypeError("Deno Preview configuration must be an object");
  }

  const { endpoint, thresholdBytes, timeoutMs } = deno;
  requireHttpsEndpoint("Deno Preview endpoint", endpoint);
  const normalizedProductionEndpoint = typeof productionEndpoint === "string"
    ? normalizeEndpoint(productionEndpoint)
    : undefined;
  if (normalizedProductionEndpoint !== undefined &&
      new URL(endpoint.trim()).href === normalizedProductionEndpoint) {
    throw new Error("Production Deno endpoint must not be used in Preview configuration");
  }
  requirePositiveSafeInteger("Deno Preview threshold", thresholdBytes);
  requirePositiveSafeInteger("Deno Preview timeout", timeoutMs);
  if (Number(thresholdBytes.trim()) > Number(maxInputBytes.trim())) {
    throw new TypeError("Deno Preview threshold must not exceed Preview input limit");
  }
}

function validatePreviewPrepareConfig(prepare, maxInputBytes, normalizedProductionEndpoint) {
  if (prepare === null || typeof prepare !== "object") {
    throw new TypeError("Deno Preview prepare configuration must be an object");
  }

  const { endpoint, thresholdBytes } = prepare;
  requireHttpsEndpoint("Deno Preview prepare endpoint", endpoint);
  if (normalizedProductionEndpoint !== undefined &&
      new URL(endpoint.trim()).href === normalizedProductionEndpoint) {
    throw new Error("Production Deno prepare endpoint must not be used in Preview configuration");
  }
  requirePositiveSafeInteger("Deno Preview prepare threshold", thresholdBytes);
  if (Number(thresholdBytes.trim()) > Number(maxInputBytes.trim())) {
    throw new TypeError("Deno Preview prepare threshold must not exceed Preview input limit");
  }
}

function normalizeEndpoint(value) {
  try {
    return new URL(value.trim()).href;
  } catch {
    return undefined;
  }
}

function requireNonEmpty(label, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} is required`);
  }
}

function requireHttpsEndpoint(label, value) {
  requireNonEmpty(label, value);
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
      throw new Error();
    }
  } catch {
    throw new TypeError(`${label} must be an HTTPS URL without credentials`);
  }
}

function requirePositiveSafeInteger(label, value) {
  requireNonEmpty(label, value);
  if (!/^\d+$/.test(value.trim())) {
    throw new TypeError(`${label} must be a positive decimal integer`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive decimal integer`);
  }
}

function isMainModule() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const [sourcePath, outputPath, mode = "do"] = process.argv.slice(2);
  if (sourcePath === undefined || outputPath === undefined || !["do", "deno"].includes(mode)) {
    console.error("usage: node scripts/preview-worker-config.mjs <source> <output> [do|deno]");
    process.exitCode = 2;
  } else {
    const parsed = ts.parseConfigFileTextToJson(sourcePath, readFileSync(sourcePath, "utf8"));
    if (parsed.error) {
      throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
    }

    const config = buildPreviewWorkerConfig(parsed.config, {
      projectRoot: process.cwd(),
      databaseId: process.env.PREVIEW_DATABASE_ID,
      databaseName: process.env.PREVIEW_DATABASE_NAME,
      workerName: process.env.PREVIEW_WORKER_NAME,
      upstreamBaseUrl: process.env.PREVIEW_UPSTREAM_BASE_URL,
      standardLimit: process.env.PREVIEW_QUOTA_LIMIT_STANDARD,
      miniLimit: process.env.PREVIEW_QUOTA_LIMIT_MINI,
      maxInputBytes: process.env.PREVIEW_MAX_INPUT_BYTES,
      deno: mode === "deno"
        ? {
            endpoint: process.env.PREVIEW_DENO_TOKENIZER_ENDPOINT,
            thresholdBytes: process.env.PREVIEW_DENO_TOKENIZER_THRESHOLD_BYTES,
            timeoutMs: process.env.PREVIEW_DENO_TOKENIZER_TIMEOUT_MS,
          }
        : undefined,
      prepare: mode === "deno" && (
        process.env.PREVIEW_DENO_PREPARE_ENDPOINT !== undefined ||
        process.env.PREVIEW_DENO_PREPARE_THRESHOLD_BYTES !== undefined
      )
        ? {
            endpoint: process.env.PREVIEW_DENO_PREPARE_ENDPOINT,
            thresholdBytes: process.env.PREVIEW_DENO_PREPARE_THRESHOLD_BYTES,
          }
        : undefined,
    });
    writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
}
