import { strict as assert } from "node:assert";
import { readFile, stat, access } from "node:fs/promises";
import { test } from "node:test";
import { runPreviewLifecycle } from "./run-relay-cpu-gate.mjs";

function previewAdapters(events) {
  return {
    uploadCandidate: async () => { events.push("upload"); return { versionId: "candidate" }; },
    deployCandidate: async () => { events.push("deploy"); },
    observeCandidate: async () => ({ observed: true }),
    preflight: async () => { events.push("preflight"); return { ready: true }; },
    measure: async () => { events.push("measure"); },
    beforeTeardown: async () => { events.push("close"); return { closed: true }; },
    deleteVersionSecret: async () => { events.push("delete"); return { versionId: "secretless" }; },
    setTraffic: async ({ versionId, percent }) => { assert.equal(versionId, "secretless"); assert.equal(percent, 100); events.push("traffic"); },
    verifyMetadata: async ({ versionId }) => { assert.equal(versionId, "secretless"); return { secretAbsent: true, bindingsUnchanged: true, deployedPercent: 100 }; },
    verifyExactVersion: async ({ versionId }) => { assert.equal(versionId, "secretless"); events.push("404"); return { status: 404 }; },
  };
}

test("Preview uploads only the ephemeral bearer and deploys the deletion-produced version", async () => {
  const events = [];
  const adapters = previewAdapters(events);
  let path;
  const relaySecrets = {
    OCTG_RELAY_SERVICE_AUTH_TOKEN: "synthetic-preview-service-token",
    OCTG_RELAY_INGRESS_AUTH_TOKEN: "synthetic-preview-ingress-token",
    OCTG_RELAY_CONTEXT_HMAC_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
  adapters.uploadCandidate = async ({ secretsPath }) => {
    path = secretsPath;
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(new URL(".", `file://${path}`))).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      OCTG_RELAY_CPU_GATE_AUTH_TOKEN: "synthetic-gate",
    });
    events.push("upload"); return { versionId: "candidate" };
  };
  const result = await runPreviewLifecycle({ bearer: "synthetic-gate", relaySecrets, adapters });
  assert.equal(result.kind, "complete");
  assert.equal(result.cleanupVerified, true);
  assert.deepEqual(events, ["upload", "deploy", "preflight", "measure", "close", "delete", "traffic", "404"]);
  await assert.rejects(access(path));
});

test("failed preflight still closes operations and tears down its uploaded secret", async () => {
  const events = [];
  const adapters = previewAdapters(events);
  adapters.preflight = async () => { events.push("preflight"); return { ready: false }; };
  const result = await runPreviewLifecycle({ bearer: "synthetic-gate", adapters });
  assert.equal(result.kind, "blocked");
  assert.equal(result.cleanupVerified, true);
  assert.deepEqual(events, ["upload", "deploy", "preflight", "close", "delete", "traffic", "404"]);
  assert.equal(result.versionId, "candidate");
});

test("unproven operation closure retains the secret binding for recovery and reports safe IDs", async () => {
  const events = [];
  const adapters = previewAdapters(events);
  adapters.beforeTeardown = async () => { events.push("close"); return { closed: false }; };
  const result = await runPreviewLifecycle({ bearer: "synthetic-gate", adapters });
  assert.equal(result.kind, "blocked");
  assert.equal(result.cleanupVerified, false);
  assert.equal(result.versionId, "candidate");
  assert.equal(events.includes("delete"), false);
  assert.equal(JSON.stringify(result).includes("synthetic-gate"), false);
});
