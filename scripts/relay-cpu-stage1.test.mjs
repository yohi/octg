import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runStage1Provisioned } from "./relay-cpu-stage1.mjs";

test("Stage 1 passes only an ephemeral per-run bearer to the candidate runner and always closes before deletion", async () => {
  const events = [];
  let ephemeral;
  const result = await runStage1Provisioned({ env: { OCTG_RELAY_SERVICE_AUTH_TOKEN: "service", OCTG_RELAY_CPU_GATE_AUTH_TOKEN: "old-token" },
    origin: "https://preview.example", workerName: "preview", model: "model", pool: "MINI", configPath: "preview.json", journalPath: "journal.json", ledgerPath: "ledger.json", sourceRevision: "a".repeat(40),
    deploymentFactory: async ({ env }) => {
      ephemeral = env.OCTG_RELAY_CPU_GATE_AUTH_TOKEN;
      return {
        uploadCandidate: async () => { events.push("upload"); return { versionId: "candidate" }; }, deployCandidate: async () => { events.push("deploy"); },
        observeCandidate: async () => ({ observed: true }),
        deleteVersionSecret: async () => { events.push("delete"); return { versionId: "secretless" }; }, setTraffic: async () => { events.push("traffic"); },
        verifyMetadata: async () => ({ secretAbsent: true, bindingsUnchanged: true, deployedPercent: 100 }), verifyExactVersion: async () => ({ status: 404 }),
      };
    },
    httpFactory: ({ env, candidateVersionId }) => {
      assert.equal(env.OCTG_RELAY_CPU_GATE_AUTH_TOKEN, ephemeral);
      assert.equal(candidateVersionId, "candidate");
      return { previewPreflight: async () => { events.push("preflight"); return { ready: true }; }, closeKnownGrants: async () => { events.push("grants-close"); return { closed: true }; } };
    },
    runGate: async ({ mode }) => { events.push(mode); return { status: "PASS", ledger: { calls: [] } }; },
  });
  assert.equal(result.status, "PASS");
  assert.match(ephemeral, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(ephemeral, "old-token");
  assert.deepEqual(events, ["upload", "deploy", "preflight", "stage1", "grants-close", "recover-operation", "delete", "traffic"]);
  assert.equal(JSON.stringify(result).includes(ephemeral), false);
});
