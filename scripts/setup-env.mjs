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
  if (value.length < 2 || value.at(-1) !== quote) {
    throw new TypeError(`invalid env file line: ${lineNumber}`);
  }
  return value.slice(1, -1);
}

export function parseSetupEnvFile(source) {
  const values = {};
  for (const [index, line] of source.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      const name = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1];
      if (SETUP_ENV_NAMES.has(name)) throw new TypeError(`invalid env file line: ${index + 1}`);
      continue;
    }
    if (!SETUP_ENV_NAMES.has(match[1])) continue;
    values[match[1]] = parseValue(match[2], index + 1);
  }
  return values;
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
  return environment[localName] || environment[legacyName] || defaultValue;
}

export function resolveDeployInputs(environment, currentConfig) {
  const definitions = [
    ["databaseId", "OCTG_DATABASE_ID", currentConfig.databaseId],
    ["upstream", "OCTG_UPSTREAM_BASE_URL", currentConfig.upstream],
    ["teamDomain", "ACCESS_TEAM_DOMAIN", currentConfig.teamDomain],
    ["audience", "ACCESS_AUD", currentConfig.audience],
  ];
  const values = {};
  const missing = [];
  for (const [property, name, currentValue] of definitions) {
    const candidate = environment[name] || currentValue || "";
    const value = /<[^>]+>/.test(candidate) ? "" : candidate;
    if (value === "") missing.push(name);
    else values[property] = value;
  }
  return { values, missing };
}
