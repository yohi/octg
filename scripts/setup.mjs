#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const config = "apps/gateway-worker/wrangler.jsonc";
const node = process.execPath;
const wrangler = `${root}/node_modules/wrangler/bin/wrangler.js`;
const args = process.argv.slice(2);
const mode = args[0];
const force = args.includes("--force");

const usage = `使い方:
  npm run setup:local [-- --force]
  npm run setup:deploy

setup:local   .dev.vars、ローカル D1、開発用クライアントを準備します。
setup:deploy  本番用 vars と Secrets を設定し、D1 migration と deploy を実行します。

注意: 本番用の Secret 値はこのスクリプトに保存せず、wrangler の入力プロンプトへ直接入力します。`;

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
    stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
    input: options.input,
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

function validateDeployValue(name, value) {
  if (!value.trim() || /<[^>]+>/.test(value)) {
    throw new Error(`${name} は実際の設定値を入力してください（空値や <...> プレースホルダーは使用できません）`);
  }
}

async function prompt(question, defaultValue) {
  const rl = createInterface({ input, output });
  const answer = await rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ""}: `);
  rl.close();
  return answer.trim() || defaultValue;
}

async function setupLocal() {
  const varsPath = `${root}/apps/gateway-worker/.dev.vars`;
  if (existsSync(varsPath) && !force) {
    throw new Error(`${varsPath} は既に存在します。既存値を保護するため中断しました。上書きする場合は --force を付けてください。`);
  }

  const pepper = process.env.OCTG_KEY_PEPPER || "dev-pepper";
  const upstream = process.env.OCTG_UPSTREAM_BASE_URL || "https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/openai";
  const clientId = process.env.OCTG_CLIENT_ID || "client_demo";
  const clientName = process.env.OCTG_CLIENT_NAME || "Demo";
  const clientKey = process.env.OCTG_CLIENT_KEY || `octg_sk_local_${randomBytes(18).toString("hex")}`;
  const clientToolsMode = process.env.OCTG_CLIENT_TOOLS_MODE === "ALLOW" ? "ALLOW" : "REJECT";
  const vars = [
    `OCTG_KEY_PEPPER=${pepper}`,
    `OCTG_UPSTREAM_BASE_URL=${upstream}`,
    "OCTG_UPSTREAM_API_TOKEN=dev-token",
    "OPENAI_USAGE_API_KEY=dev-usage-key",
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

async function setupDeploy() {
  console.log("本番環境の設定を開始します。Cloudflare にログイン済みであることを確認してください。\n");
  const databaseId = await prompt("D1 database_id", "");
  const upstream = await prompt("OCTG_UPSTREAM_BASE_URL", "");
  const teamDomain = await prompt("ACCESS_TEAM_DOMAIN", "");
  const audience = await prompt("ACCESS_AUD", "");
  if (!databaseId) {
    throw new Error("D1 database_id は必須です");
  }
  validateDeployValue("OCTG_UPSTREAM_BASE_URL", upstream);
  validateDeployValue("ACCESS_TEAM_DOMAIN", teamDomain);
  validateDeployValue("ACCESS_AUD", audience);

  updateConfig({
    database_id: databaseId,
    OCTG_UPSTREAM_BASE_URL: upstream,
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUD: audience,
  });

  for (const secret of ["OCTG_KEY_PEPPER", "OCTG_UPSTREAM_API_TOKEN", "OPENAI_USAGE_API_KEY"]) {
    run(node, [wrangler, "secret", "put", secret, "--config", config]);
  }
  run(node, [wrangler, "d1", "migrations", "apply", "octg", "--remote", "--config", config]);
  run(node, [wrangler, "deploy", "--config", config]);
  console.log("\n本番セットアップが完了しました。");
  console.log("クライアントキーは seed:client で発行してください。");
}

try {
  await (mode === "local" ? setupLocal() : setupDeploy());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
