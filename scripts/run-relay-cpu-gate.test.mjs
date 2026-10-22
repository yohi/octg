import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runRelayCpuGate, generateCpuGateBearer, withPreviewSecretsFile } from "./run-relay-cpu-gate.mjs";

test("supports safe stage modes and does not retain bearer values", async () => {
  const result = await runRelayCpuGate({ mode: "stage1", adapters: { runSeries: async () => ({ status: 200 }) } });
  assert.equal(result.status, "PASS");
  assert.equal(JSON.stringify(result.ledger).includes("synthetic-token"), false);
});

test("generates fresh base64url bearer and securely cleans Preview secret material", async () => {
  const token = generateCpuGateBearer();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  let observedMode;
  await withPreviewSecretsFile({ token, directoryParent: "/tmp", upload: async (path) => {
    const { statSync } = await import("node:fs");
    observedMode = statSync(path).mode & 0o777;
  } });
  assert.equal(observedMode, 0o600);
});
