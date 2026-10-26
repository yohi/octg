import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runStage1Provisioned } from "./relay-cpu-stage1.mjs";

test("Stage 1 passes only an ephemeral per-run bearer to the candidate runner and always closes before deletion", async () => {
  const events = [];
  let ephemeral;
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-token",
    OCTG_RELAY_SERVICE_AUTH_TOKEN: "service-token-0123456789abcdef0123456789ab",
    OCTG_RELAY_INGRESS_AUTH_TOKEN: "must-not-reach-runner-child",
    OCTG_RELAY_CONTEXT_HMAC_KEY: "must-not-reach-runner-child-either",
    OCTG_CANARY_CLIENT_KEY: "octg_sk_preview_synthetic",
    OCTG_RELAY_CPU_GATE_AUTH_TOKEN: "old-token",
  };
  const result = await runStage1Provisioned({ env,
    origin: "https://preview.example", workerName: "preview", model: "model", pool: "MINI", configPath: "preview.json", journalPath: "journal.json", ledgerPath: "ledger.json", sourceRevision: "a".repeat(40),
    deploymentFactory: async ({ env }) => {
      assert.equal(env.OCTG_RELAY_INGRESS_AUTH_TOKEN, undefined);
      assert.equal(env.OCTG_RELAY_CONTEXT_HMAC_KEY, undefined);
      ephemeral = env.OCTG_RELAY_CPU_GATE_AUTH_TOKEN;
      return {
        uploadCandidate: async ({ secretsPath }) => {
          const secrets = JSON.parse(await readFile(secretsPath, "utf8"));
          assert.deepEqual(secrets, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: ephemeral });
          events.push("upload"); return { versionId: "candidate" };
        }, deployCandidate: async () => { events.push("deploy"); },
        observeCandidate: async () => ({ observed: true }),
        deleteVersionSecret: async () => { events.push("delete"); return { versionId: "secretless" }; }, setTraffic: async () => { events.push("traffic"); },
        verifyMetadata: async () => ({ secretAbsent: true, bindingsUnchanged: true, deployedPercent: 100 }), verifyExactVersion: async () => ({ status: 404 }),
      };
    },
    httpFactory: ({ env, candidateVersionId }) => {
      assert.equal(env.OCTG_RELAY_INGRESS_AUTH_TOKEN, undefined);
      assert.equal(env.OCTG_RELAY_CONTEXT_HMAC_KEY, undefined);
      assert.equal(env.OCTG_RELAY_CPU_GATE_AUTH_TOKEN, ephemeral);
      assert.equal(candidateVersionId, "candidate");
      return { previewPreflight: async () => { events.push("preflight"); return { ready: true }; }, closeKnownGrants: async () => { events.push("grants-close"); return { closed: true }; } };
    },
    runGate: async ({ mode }) => { events.push(mode); return { status: "PASS", ledger: { calls: [] } }; },
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.cleanupVerified, true);
  assert.match(ephemeral, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(ephemeral, "old-token");
  assert.deepEqual(events, ["upload", "deploy", "preflight", "stage1", "grants-close", "recover-operation", "delete", "traffic"]);
  assert.equal(JSON.stringify(result).includes(ephemeral), false);
});

test("Stage 1 rejects missing Preview relay credentials before deployment starts", async () => {
  let deploymentStarted = false;
  await assert.rejects(runStage1Provisioned({
    env: {},
    origin: "https://preview.example",
    workerName: "preview",
    pool: "MINI",
    configPath: "preview.json",
    journalPath: "journal.json",
    ledgerPath: "ledger.json",
    sourceRevision: "a".repeat(40),
    deploymentFactory: async () => {
      deploymentStarted = true;
      throw new Error("deployment should not start");
    },
  }), /Preview Stage 1 environment is missing/);
  assert.equal(deploymentStarted, false);
});
