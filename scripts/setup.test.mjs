import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

function createProject({ devVars } = {}) {
  const root = mkdtempSync(join(tmpdir(), "octg-setup-test-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "apps/gateway-worker"), { recursive: true });
  mkdirSync(join(root, "node_modules/wrangler/bin"), { recursive: true });
  for (const file of ["setup.mjs", "setup-env.mjs", "setup-deploy.mjs", "parse-env-file.mjs", "seed-client.mjs"]) {
    copyFileSync(join(sourceRoot, "scripts", file), join(root, "scripts", file));
  }
  copyFileSync(
    join(sourceRoot, "apps/gateway-worker/wrangler.jsonc"),
    join(root, "apps/gateway-worker/wrangler.jsonc"),
  );
  writeFileSync(
    join(root, "node_modules/wrangler/bin/wrangler.js"),
    `require("node:fs").appendFileSync(process.env.OCTG_WRANGLER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
  );
  if (devVars !== undefined) writeFileSync(join(root, "apps/gateway-worker/.dev.vars"), devVars);
  return root;
}

function runSetup(root, mode, args = [], environment = {}) {
  return spawnSync(process.execPath, [join(root, "scripts/setup.mjs"), mode, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

function localEnvironment(logPath) {
  return { OCTG_WRANGLER_LOG: logPath, OCTG_LOCAL_CLIENT_KEY: "" };
}

test("checked-in Wrangler config leaves Deno tokenizer disabled", () => {
  const source = readFileSync(join(sourceRoot, "apps/gateway-worker/wrangler.jsonc"), "utf8");

  for (const name of [
    "DENO_TOKENIZER_ENDPOINT",
    "DENO_TOKENIZER_AUTH_TOKEN",
    "DENO_TOKENIZER_THRESHOLD_BYTES",
    "DENO_TOKENIZER_TIMEOUT_MS",
  ]) {
    assert.doesNotMatch(source, new RegExp(`"${name}"\\s*:`));
  }
});

test("refuses to overwrite an existing .dev.vars without --force", (t) => {
  const root = createProject({ devVars: "keep-me\n" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logPath = join(root, "wrangler.log");
  writeFileSync(logPath, "");

  const result = runSetup(root, "local", [], localEnvironment(logPath));

  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(root, "apps/gateway-worker/.dev.vars"), "utf8"), "keep-me\n");
  assert.equal(result.stderr.includes("--force"), true);
  assert.equal(readFileSync(logPath, "utf8"), "");
});

test("--force overwrites .dev.vars and generates a client key when none is provided", (t) => {
  const root = createProject({ devVars: "old-value\n" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logPath = join(root, "wrangler.log");

  const result = runSetup(root, "local", ["--force"], localEnvironment(logPath));
  const vars = readFileSync(join(root, "apps/gateway-worker/.dev.vars"), "utf8");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(vars.includes("old-value"), false);
  assert.match(result.stdout, /開発用 API キー: octg_sk_local_[0-9a-f]{36}/);
  const wranglerCalls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(wranglerCalls.length, 2);
  assert.deepEqual(wranglerCalls[0], [
    "d1",
    "migrations",
    "apply",
    "octg",
    "--local",
    "--config",
    "apps/gateway-worker/wrangler.jsonc",
  ]);
  assert.equal(wranglerCalls[1][0], "d1");
  assert.equal(wranglerCalls[1][1], "execute");
  assert.equal(wranglerCalls[1][2], "octg");
  assert.equal(wranglerCalls[1][3], "--local");
  assert.equal(wranglerCalls[1][4], "--file");
  assert.match(wranglerCalls[1][5], /\/octg-seed-[^/]+\/seed\.sql$/);
  assert.deepEqual(wranglerCalls[1].slice(6), [
    "--config",
    "apps/gateway-worker/wrangler.jsonc",
  ]);
});

test("deploy --dry-run does not modify wrangler.jsonc or invoke wrangler", (t) => {
  const root = createProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logPath = join(root, "wrangler.log");
  writeFileSync(logPath, "");
  const configPath = join(root, "apps/gateway-worker/wrangler.jsonc");
  const originalConfig = readFileSync(configPath, "utf8");

  const result = runSetup(root, "deploy", ["--dry-run"], {
    OCTG_WRANGLER_LOG: logPath,
    CLOUDFLARE_ACCOUNT_ID: "account-test",
    OCTG_DATABASE_ID: "database-test",
    OCTG_UPSTREAM_BASE_URL: "https://gateway.example/openai",
    ACCESS_TEAM_DOMAIN: "https://team.example",
    ACCESS_AUD: "audience-test",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(configPath, "utf8"), originalConfig);
  assert.equal(readFileSync(logPath, "utf8"), "");
});
