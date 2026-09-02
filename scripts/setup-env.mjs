import { parseEnvFile } from "./parse-env-file.mjs";

const SETUP_ENV_NAMES = new Set([
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "OCTG_DATABASE_ID",
  "OCTG_DATABASE_NAME",
  "OCTG_UPSTREAM_BASE_URL",
  "OCTG_UPSTREAM_API_TOKEN",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
  "OCTG_KEY_PEPPER",
  "OPENAI_USAGE_API_KEY",
  "OCTG_CLIENT_ID",
  "OCTG_CLIENT_NAME",
  "OCTG_CLIENT_KEY",
  "OCTG_CLIENT_TOOLS_MODE",
  "OCTG_LOCAL_KEY_PEPPER",
  "OCTG_LOCAL_UPSTREAM_BASE_URL",
  "OCTG_LOCAL_UPSTREAM_API_TOKEN",
  "OCTG_LOCAL_OPENAI_USAGE_API_KEY",
  "OCTG_LOCAL_CLIENT_ID",
  "OCTG_LOCAL_CLIENT_NAME",
  "OCTG_LOCAL_CLIENT_KEY",
  "OCTG_LOCAL_CLIENT_TOOLS_MODE",
  "CLOUDFLARE_PREVIEW_ACCOUNT_ID",
  "CLOUDFLARE_PREVIEW_API_TOKEN",
  "OCTG_PREVIEW_UPSTREAM_API_TOKEN",
  "OCTG_PREVIEW_KEY_PEPPER",
  "OCTG_PREVIEW_DATABASE_ID",
  "OCTG_PREVIEW_DATABASE_NAME",
  "OCTG_PREVIEW_WORKER_NAME",
  "OCTG_PREVIEW_UPSTREAM_BASE_URL",
  "OCTG_PREVIEW_BASE_URL",
  "OCTG_PREVIEW_QUOTA_LIMIT_STANDARD",
  "OCTG_PREVIEW_QUOTA_LIMIT_MINI",
  "OCTG_PREVIEW_CLIENT_ID",
  "OCTG_PREVIEW_CLIENT_NAME",
  "OCTG_PREVIEW_CLIENT_KEY",
  "GITHUB_REPOSITORY",
  "SMOKE_MODEL",
  "DENO_DEPLOY_ORG",
  "DENO_DEPLOY_APP",
  "DENO_DEPLOY_TOKEN",
  "DENO_TOKENIZER_ENDPOINT",
  "DENO_TOKENIZER_AUTH_TOKEN",
  "DENO_TOKENIZER_THRESHOLD_BYTES",
  "DENO_TOKENIZER_TIMEOUT_MS",
  "OCTG_CANARY_URL",
  "OCTG_CANARY_ALLOWED_HOSTS",
  "OCTG_CANARY_CLIENT_KEY",
  "CANARY_PAYLOAD_PATH",
  "CANARY_CONCURRENCY",
  "CANARY_REQUEST_TIMEOUT_MS",
  "OCTG_CF_ACCOUNT_ID",
  "OCTG_CF_GATEWAY_ID",
  "OCTG_CF_API_TOKEN",
]);

function parseValue(rawValue, lineNumber) {
  const value = rawValue.trim();
  if (value === "") return "";

  const quote = value[0];
  if (quote !== "'" && quote !== '"') return value;
  const closingQuote = value.indexOf(quote, 1);
  if (closingQuote !== value.length - 1) {
    throw new TypeError(`invalid env file line: ${lineNumber}`);
  }
  return value.slice(1, closingQuote);
}

export function parseSetupEnvFile(source) {
  return parseEnvFile(
    source,
    SETUP_ENV_NAMES,
    parseValue,
    (lineNumber) => new TypeError(`invalid env file line: ${lineNumber}`),
  );
}

export function mergeSetupEnvironment(fileEnvironment, processEnvironment, defaults = {}) {
  const merged = {};
  for (const name of SETUP_ENV_NAMES) {
    const value = processEnvironment[name] ?? fileEnvironment[name] ?? defaults[name];
    if (value !== undefined) merged[name] = value;
  }
  return merged;
}

export function resolveLocalValue(environment, localName, legacyName, defaultValue) {
  for (const value of [environment[localName], environment[legacyName], defaultValue]) {
    if (typeof value === "string" && value.trim() !== "" && !hasPlaceholder(value)) return value;
  }
  return "";
}

export function hasPlaceholder(value) {
  let opening = value.indexOf("<");
  while (opening !== -1) {
    const closing = value.indexOf(">", opening + 1);
    if (closing > opening + 1) return true;
    opening = value.indexOf("<", opening + 1);
  }
  return false;
}

export function resolveDeployInputs(environment, currentConfig) {
  const definitions = [
    ["accountId", "CLOUDFLARE_ACCOUNT_ID", currentConfig.accountId],
    ["databaseId", "OCTG_DATABASE_ID", currentConfig.databaseId],
    ["upstream", "OCTG_UPSTREAM_BASE_URL", currentConfig.upstream],
    ["teamDomain", "ACCESS_TEAM_DOMAIN", currentConfig.teamDomain],
    ["audience", "ACCESS_AUD", currentConfig.audience],
  ];
  const values = {};
  const missing = [];
  for (const [property, name, currentValue] of definitions) {
    const value = [environment[name], currentValue]
      .map((candidate) => String(candidate ?? "").trim())
      .find((candidate) => candidate !== "" && !hasPlaceholder(candidate)) ?? "";
    if (value === "") missing.push(name);
    else values[property] = value;
  }
  return { values, missing };
}
