#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const seedClient = `${root}/scripts/seed-client.mjs`;
const remoteSource = readFileSync(`${root}/scripts/seed-client-remote.mjs`, "utf8");

assert.match(remoteSource, /replace\(\/-\(\[a-z\]\)\//);
assert.match(remoteSource, /args\.toolsMode \?\? process\.env\.OCTG_CLIENT_TOOLS_MODE/);

function seed(toolsMode) {
  const result = spawnSync(process.execPath, [seedClient, "demo", "Demo", "octg_sk_test", toolsMode], {
    env: { ...process.env, OCTG_KEY_PEPPER: "test-pepper" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

assert.match(seed("ALLOW"), /tools_mode\) VALUES \([^\n]*, 'ALLOW'\)/);
assert.match(seed("REJECT"), /tools_mode\) VALUES \([^\n]*, 'REJECT'\)/);
console.log("seed-client tools mode propagation: ok");
