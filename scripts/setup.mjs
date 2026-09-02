#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  mergeSetupEnvironment,
  parseSetupEnvFile,
  resolveLocalValue,
} from "./setup-env.mjs";
import {
  DEPLOY_CONFIG_NAMES,
  DEPLOY_SECRET_NAMES,
  buildCloudflareEnv,
  resolveDeployConfig,
  validateProvidedDeploySecrets,
} from "./setup-deploy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const config = "apps/gateway-worker/wrangler.jsonc";
const node = process.execPath;
const wrangler = `${root}/node_modules/wrangler/bin/wrangler.js`;
const args = process.argv.slice(2);
const mode = args[0];
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const envFileOption = args.find((arg) => arg.startsWith("--env-file="));
const envFile = envFileOption?.slice("--env-file=".length);

const usage = `使い方:
  npm run setup:local [-- --env-file=.env] [--force]
  npm run setup:deploy [-- --env-file=.env] [--dry-run]

setup:local   .dev.vars、ローカル D1、開発用クライアントを準備します。
setup:deploy  本番用 vars と Secrets を設定し、D1 migration と deploy を実行します。

注意: 本番用の Secret 値はコマンドライン引数へ置かず、環境変数または wrangler の入力へ渡します。`;

if (!mode || args.includes("--help") || args.includes("-h")) {
  console.log(usage);
  process.exit(0);
}

if (!new Set(["local", "deploy"]).has(mode)) {
  console.error(`不明なセットアップ種別です: ${mode}\n\n${usage}`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: options.input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
    input: options.input,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`コマンドが失敗しました: ${command} ${commandArgs.join(" ")}`);
  }
}

function replaceJsoncValue(source, key, value) {
  const pattern = new RegExp(String.raw`("${key}"\s*:\s*)"[^"]*"`);
  if (!pattern.test(source)) {
    throw new Error(`${config} に ${key} がありません`);
  }
  const replacement = JSON.stringify(value);
  return source.replace(pattern, (_match, prefix) => prefix + replacement);
}

function updateConfig(values) {
  let source = readFileSync(`${root}/${config}`, "utf8");
  for (const [key, value] of Object.entries(values)) {
    source = replaceJsoncValue(source, key, value);
  }
  writeFileSync(`${root}/${config}`, source);
}

async function prompt(question, defaultValue) {
  const rl = createInterface({ input, output });
  const answer = await rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ""}: `);
  rl.close();
  return answer.trim() || defaultValue;
}

function loadSetupEnvironment() {
  const path = envFile ? resolve(root, envFile) : `${root}/.env`;
  if (!existsSync(path)) {
    if (envFile) throw new Error(`${path} がありません`);
    return mergeSetupEnvironment({}, process.env);
  }
  return mergeSetupEnvironment(parseSetupEnvFile(readFileSync(path, "utf8")), process.env);
}

function setupLocal(environment) {
  const varsPath = `${root}/apps/gateway-worker/.dev.vars`;
  if (existsSync(varsPath) && !force) {
    throw new Error(`${varsPath} は既に存在します。既存値を保護するため中断しました。上書きする場合は --force を付けてください。`);
  }

  const pepper = resolveLocalValue(environment, "OCTG_LOCAL_KEY_PEPPER", "OCTG_KEY_PEPPER", "dev-pepper");
  const upstream = resolveLocalValue(environment, "OCTG_LOCAL_UPSTREAM_BASE_URL", "OCTG_UPSTREAM_BASE_URL", "https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/openai");
  const upstreamToken = resolveLocalValue(environment, "OCTG_LOCAL_UPSTREAM_API_TOKEN", "OCTG_UPSTREAM_API_TOKEN", "dev-token");
  const usageApiKey = resolveLocalValue(environment, "OCTG_LOCAL_OPENAI_USAGE_API_KEY", "OPENAI_USAGE_API_KEY", "dev-usage-key");
  const clientId = resolveLocalValue(environment, "OCTG_LOCAL_CLIENT_ID", "OCTG_CLIENT_ID", "client_demo");
  const clientName = resolveLocalValue(environment, "OCTG_LOCAL_CLIENT_NAME", "OCTG_CLIENT_NAME", "Demo");
  const clientKey = resolveLocalValue(environment, "OCTG_LOCAL_CLIENT_KEY", "OCTG_CLIENT_KEY", `octg_sk_local_${randomBytes(18).toString("hex")}`);
  const clientToolsMode = resolveLocalValue(environment, "OCTG_LOCAL_CLIENT_TOOLS_MODE", "OCTG_CLIENT_TOOLS_MODE", "REJECT") === "ALLOW" ? "ALLOW" : "REJECT";
  const vars = [
    `OCTG_KEY_PEPPER=${pepper}`,
    `OCTG_UPSTREAM_BASE_URL=${upstream}`,
    `OCTG_UPSTREAM_API_TOKEN=${upstreamToken}`,
    `OPENAI_USAGE_API_KEY=${usageApiKey}`,
    "",
  ].join("\n");

  writeFileSync(varsPath, vars, { mode: 0o600 });
  run(node, [wrangler, "d1", "migrations", "apply", "octg", "--local", "--config", config]);

  const tempDir = mkdtempSync(`${tmpdir()}/octg-seed-`);
  const sqlPath = `${tempDir}/seed.sql`;
  try {
    const seed = spawnSync(node, [`${root}/scripts/seed-client.mjs`, clientId, clientName, clientKey, clientToolsMode], {
      cwd: root,
      env: { ...process.env, OCTG_KEY_PEPPER: pepper },
      encoding: "utf8",
    });
    if (seed.status !== 0) throw new Error("開発用クライアント SQL の生成に失敗しました");
    writeFileSync(sqlPath, seed.stdout, { mode: 0o600 });
    run(node, [wrangler, "d1", "execute", "octg", "--local", "--file", sqlPath, "--config", config]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`\nローカルセットアップが完了しました。開発用 API キー: ${clientKey}`);
  console.log("次に npm run dev -w apps/gateway-worker を実行してください。");
}

function currentDeployConfig() {
  const source = readFileSync(`${root}/${config}`, "utf8");
  const valueOf = (key) => source.match(new RegExp(String.raw`"${key}"\s*:\s*"([^"]*)"`))?.[1] || "";
  return {
    accountId: valueOf("account_id"),
    databaseId: valueOf("database_id"),
    upstream: valueOf("OCTG_UPSTREAM_BASE_URL"),
    teamDomain: valueOf("ACCESS_TEAM_DOMAIN"),
    audience: valueOf("ACCESS_AUD"),
  };
}

function putDeploySecrets(environment, accountId) {
  const cloudflareEnv = buildCloudflareEnv(environment, accountId);
  for (const secret of DEPLOY_SECRET_NAMES) {
    const value = environment[secret];
    run(node, [wrangler, "secret", "put", secret, "--config", config], {
      input: value ? `${value}\n` : undefined,
      env: cloudflareEnv,
    });
  }
  return cloudflareEnv;
}

async function setupDeploy(environment) {
  console.log("本番環境の設定を開始します。Cloudflare にログイン済みであることを確認してください。\n");
  validateProvidedDeploySecrets(environment);
  const values = await resolveDeployConfig(environment, currentDeployConfig(), prompt);

  if (dryRun) {
    console.log("dry-run: wrangler.jsoncのvars更新、Secret登録、D1 migration、Worker deployを省略しました。");
    console.log(`dry-run: 対象設定 ${Object.values(DEPLOY_CONFIG_NAMES).join(", ")}`);
    return;
  }

  updateConfig({
    database_id: values.databaseId,
    OCTG_UPSTREAM_BASE_URL: values.upstream,
    ACCESS_TEAM_DOMAIN: values.teamDomain,
    ACCESS_AUD: values.audience,
  });

  const cloudflareEnv = putDeploySecrets(environment, values.accountId);
  run(node, [wrangler, "d1", "migrations", "apply", "octg", "--remote", "--config", config], { env: cloudflareEnv });
  run(node, [wrangler, "deploy", "--config", config], { env: cloudflareEnv });
  console.log("\n本番セットアップが完了しました。");
  console.log("クライアントキーは seed:client で発行してください。");
}

try {
  const environment = loadSetupEnvironment();
  if (mode === "local") {
    setupLocal(environment);
  } else {
    await setupDeploy(environment);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
