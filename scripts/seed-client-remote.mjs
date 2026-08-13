#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const config = "apps/gateway-worker/wrangler.jsonc";
const node = process.execPath;
const wrangler = `${root}/node_modules/wrangler/bin/wrangler.js`;
const args = process.argv.slice(2).reduce((acc, arg) => {
  const match = arg.match(/^--([-\w]+)=(.*)$/);
  if (match) acc[match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = match[2];
  return acc;
}, {});

const id = args.id || process.env.OCTG_CLIENT_ID;
const name = args.name || process.env.OCTG_CLIENT_NAME;
const rawKey = args.key || process.env.OCTG_CLIENT_KEY;

function normalizeToolsMode(value) {
  return value === "ALLOW" ? "ALLOW" : "REJECT";
}

const toolsMode = normalizeToolsMode(args.toolsMode ?? process.env.OCTG_CLIENT_TOOLS_MODE);

if (!process.env.OCTG_KEY_PEPPER || !id || !name) {
  console.error("usage: OCTG_KEY_PEPPER=... npm run seed:client:remote -- --id=<id> --name=<name> [--key=octg_sk_...] [--tools-mode=REJECT|ALLOW]");
  console.error("  --name にスペースを含む場合は OCTG_CLIENT_NAME=\"...\" 環境変数を使用してください");
  process.exit(1);
}

const clientKey = rawKey || `octg_sk_remote_${randomBytes(18).toString("hex")}`;
if (!clientKey.startsWith("octg_sk_")) {
  console.error("raw key must start with octg_sk_");
  process.exit(1);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`コマンドが失敗しました: ${command} ${commandArgs.join(" ")}`);
  }
}

const tempDir = mkdtempSync(`${tmpdir()}/octg-seed-`);
const sqlPath = `${tempDir}/seed.sql`;
try {
  const seed = spawnSync(node, [`${root}/scripts/seed-client.mjs`, id, name, clientKey, toolsMode], {
    cwd: root,
    env: { ...process.env, OCTG_KEY_PEPPER: process.env.OCTG_KEY_PEPPER },
    encoding: "utf8",
  });
  if (seed.status !== 0) {
    console.error(seed.stderr);
    process.exit(1);
  }
  writeFileSync(sqlPath, seed.stdout, { mode: 0o600 });
  run(node, [wrangler, "d1", "execute", "octg", "--remote", "--file", sqlPath, "--config", config]);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n本番クライアントを登録しました: ${clientKey}`);
console.log("このキーを利用者に渡してください。");
