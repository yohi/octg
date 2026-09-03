#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { writeClientKey } from "./write-client-key.mjs";

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

const tempDir = mkdtempSync(`${tmpdir()}/octg-seed-test-`);
try {
  const keyPath = `${tempDir}/client-key`;
  writeClientKey(keyPath, "octg_sk_generated_test");
  assert.equal(readFileSync(keyPath, "utf8"), "octg_sk_generated_test\n");
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);

  const targetPath = `${tempDir}/target-key`;
  const symlinkPath = `${tempDir}/client-key-link`;
  writeClientKey(targetPath, "octg_sk_original_test");
  symlinkSync(targetPath, symlinkPath);
  assert.throws(() => writeClientKey(symlinkPath, "octg_sk_replacement"));
  assert.equal(readFileSync(targetPath, "utf8"), "octg_sk_original_test\n");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const keyWriteIndex = remoteSource.indexOf("writeClientKey(keyOutputFile, clientKey);");
const remoteRegistrationIndex = remoteSource.indexOf('run(node, [wrangler, "d1", "execute"');
assert.ok(keyWriteIndex >= 0);
assert.ok(remoteRegistrationIndex >= 0);
assert.ok(keyWriteIndex < remoteRegistrationIndex);
assert.match(
  remoteSource,
  /catch \(error\) \{[\s\S]*?rmSync\(keyOutputFile, \{ force: true \}\)[\s\S]*?throw error;/,
);

console.log("seed-client tools mode propagation: ok");
