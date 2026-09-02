import { hasPlaceholder, resolveDeployInputs } from "./setup-env.mjs";

export const DEPLOY_CONFIG_NAMES = Object.freeze({
  accountId: "CLOUDFLARE_ACCOUNT_ID",
  databaseId: "OCTG_DATABASE_ID",
  upstream: "OCTG_UPSTREAM_BASE_URL",
  teamDomain: "ACCESS_TEAM_DOMAIN",
  audience: "ACCESS_AUD",
});

export const DEPLOY_SECRET_NAMES = Object.freeze([
  "OCTG_KEY_PEPPER",
  "OCTG_UPSTREAM_API_TOKEN",
  "OPENAI_USAGE_API_KEY",
]);

const DEPLOY_INPUT_SECRET_NAMES = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  ...DEPLOY_SECRET_NAMES,
]);

export function validateDeployValue(name, value) {
  if (!value.trim() || hasPlaceholder(value)) {
    throw new Error(`${name} は実際の設定値を入力してください（空値や <...> プレースホルダーは使用できません）`);
  }
}

export function validateProvidedDeploySecrets(environment) {
  for (const name of DEPLOY_INPUT_SECRET_NAMES) {
    if (environment[name]) validateDeployValue(name, environment[name]);
  }
}

export async function resolveDeployConfig(environment, currentConfig, prompt) {
  const resolved = resolveDeployInputs(environment, currentConfig);
  const values = { ...resolved.values };
  const propertyByName = new Map(
    Object.entries(DEPLOY_CONFIG_NAMES).map(([property, name]) => [name, property]),
  );

  for (const name of resolved.missing) {
    const property = propertyByName.get(name);
    if (property === undefined) throw new Error(`未対応の設定値です: ${name}`);
    values[property] = await prompt(name, "");
  }
  for (const [property, name] of Object.entries(DEPLOY_CONFIG_NAMES)) {
    validateDeployValue(name, values[property]);
  }
  return values;
}

export function buildCloudflareEnv(environment, accountId) {
  return {
    ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
    ...(environment.CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: environment.CLOUDFLARE_API_TOKEN } : {}),
  };
}
