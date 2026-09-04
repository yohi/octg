import { readFileSync, writeFileSync } from "node:fs";
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
    deno,
  } = options ?? {};

  requireNonEmpty("Preview database ID", databaseId);
  requireNonEmpty("Preview database name", databaseName);
  requireNonEmpty("Preview Worker name", workerName);
  requireNonEmpty("Preview upstream endpoint", upstreamBaseUrl);
  requireNonEmpty("Preview STANDARD quota", standardLimit);
  requireNonEmpty("Preview MINI quota", miniLimit);
  requireNonEmpty("Preview project root", projectRoot);

  const productionDatabase = Array.isArray(config.d1_databases)
    ? config.d1_databases.find((entry) => entry?.binding === "DB")
    : undefined;
  if (productionDatabase === undefined) {
    throw new Error("Expected a DB D1 binding in the base Worker configuration");
  }

  const productionEndpoint = config.vars?.DENO_TOKENIZER_ENDPOINT;

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
    OCTG_UPSTREAM_BASE_URL: upstreamBaseUrl,
  };
  for (const name of DENO_CONFIG_NAMES) {
    delete config.vars[name];
  }
  config.d1_databases = [{
    ...productionDatabase,
    binding: "DB",
    database_id: databaseId,
    database_name: databaseName,
    migrations_dir: `${projectRoot}/db/migrations`,
    remote: true,
  }];

  if (deno !== undefined) {
    validatePreviewDenoConfig(deno, productionEndpoint);
    config.vars.DENO_TOKENIZER_ENDPOINT = deno.endpoint.trim();
    config.vars.DENO_TOKENIZER_THRESHOLD_BYTES = deno.thresholdBytes.trim();
    config.vars.DENO_TOKENIZER_TIMEOUT_MS = deno.timeoutMs.trim();
  }

  return config;
}

function validatePreviewDenoConfig(deno, productionEndpoint) {
  if (deno === null || typeof deno !== "object") {
    throw new TypeError("Deno Preview configuration must be an object");
  }

  const { endpoint, thresholdBytes, timeoutMs } = deno;
  requireHttpsEndpoint("Deno Preview endpoint", endpoint);
  if (typeof productionEndpoint === "string" && endpoint.trim() === productionEndpoint.trim()) {
    throw new Error("Production Deno endpoint must not be used in Preview configuration");
  }
  requirePositiveSafeInteger("Deno Preview threshold", thresholdBytes);
  requirePositiveSafeInteger("Deno Preview timeout", timeoutMs);
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
  return process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
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
      deno: mode === "deno"
        ? {
            endpoint: process.env.PREVIEW_DENO_TOKENIZER_ENDPOINT,
            thresholdBytes: process.env.PREVIEW_DENO_TOKENIZER_THRESHOLD_BYTES,
            timeoutMs: process.env.PREVIEW_DENO_TOKENIZER_TIMEOUT_MS,
          }
        : undefined,
    });
    writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
}
