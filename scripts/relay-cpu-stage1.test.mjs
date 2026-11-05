import { strict as assert } from "node:assert";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join } from "node:path";
import { executeCpuGateCli } from "./relay-cpu-cli.mjs";
import { createOperatorVerifiedTargetResolver } from "./relay-cpu-operator-trust.mjs";
import { runStage1Provisioned } from "./relay-cpu-stage1.mjs";
import { makeTrustRoot, baseResolverDeps, cleanupTrustRoot, SOURCE_REVISION, WORKER_NAME, CLOUDFLARE_ACCOUNT_ID, NOW_UTC } from "./relay-cpu-test-fixtures.mjs";

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

function baseEnv() {
  return {
    CLOUDFLARE_ACCOUNT_ID: CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-token",
    OCTG_RELAY_SERVICE_AUTH_TOKEN: "service-token-0123456789abcdef0123456789ab",
    OCTG_CANARY_CLIENT_KEY: "octg_sk_preview_synthetic",
  };
}

async function stage1TempFiles(tmpDir) {
  const configPath = join(tmpDir, "preview.json");
  const journalPath = join(tmpDir, "operations.json");
  const ledgerPath = join(tmpDir, "ledger.json");
  await writeFile(configPath, "{}", { mode: 0o600 });
  return { configPath, journalPath, ledgerPath };
}

test("stage1_valid_capacity_reaches_upload_and_measurement", async () => {
  const fixture = await makeTrustRoot({ stage: "stage1", environment: "preview" });
  const tmpDir = await mkdtemp(join(tmpdir(), "cpu-stage1-cli-"));
  const events = [];
  const summaries = [];
  let ephemeral;
  try {
    const { configPath, journalPath, ledgerPath } = await stage1TempFiles(tmpDir);
    const resolver = createOperatorVerifiedTargetResolver(baseResolverDeps(fixture));
    const exitCode = await executeCpuGateCli([
      "stage1", "--execute", "--origin=https://preview.example", `--worker-name=${WORKER_NAME}`,
      "--pool=MINI", "--model=preview-model", `--journal=${journalPath}`, `--ledger=${ledgerPath}`,
      `--source-revision=${SOURCE_REVISION}`, `--preview-config=${configPath}`,
      `--capacity-evidence=${fixture.evidencePath}`, `--execution-target=${fixture.targetPath}`,
    ], baseEnv(), {
      writeSummary: (msg) => summaries.push(JSON.parse(msg)),
      nowUTC: () => NOW_UTC,
      resolveVerifiedExecutionTarget: resolver,
      deploymentFactory: async ({ env }) => {
        ephemeral = env.OCTG_RELAY_CPU_GATE_AUTH_TOKEN;
        return {
          uploadCandidate: async ({ secretsPath }) => {
            const secrets = JSON.parse(await readFile(secretsPath, "utf8"));
            assert.deepEqual(secrets, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: ephemeral });
            events.push("upload"); return { versionId: "candidate" };
          },
          deployCandidate: async () => { events.push("deploy"); },
          observeCandidate: async () => ({ observed: true }),
          deleteVersionSecret: async () => { events.push("delete"); return { versionId: "secretless" }; },
          setTraffic: async () => { events.push("traffic"); },
          verifyMetadata: async () => ({ secretAbsent: true, bindingsUnchanged: true, deployedPercent: 100 }),
          verifyExactVersion: async () => ({ status: 404 }),
        };
      },
      httpFactory: ({ candidateVersionId }) => {
        assert.equal(candidateVersionId, "candidate");
        return {
          previewPreflight: async () => { events.push("preflight"); return { ready: true }; },
          closeKnownGrants: async () => { events.push("grants-close"); return { closed: true }; },
        };
      },
      runGate: async ({ mode }) => { events.push(mode); return { status: "PASS", ledger: { calls: [] } }; },
    });
    assert.equal(exitCode, 0);
    assert.equal(summaries.at(-1).status, "PASS");
    assert.deepEqual(events, ["upload", "deploy", "preflight", "stage1", "grants-close", "recover-operation", "delete", "traffic"]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await cleanupTrustRoot(fixture);
  }
});

test("stage1_hold_bypasses_upload_deploy_measure", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cpu-stage1-hold-"));
  const events = [];
  const summaries = [];
  try {
    const { configPath, journalPath, ledgerPath } = await stage1TempFiles(tmpDir);
    const exitCode = await executeCpuGateCli([
      "stage1", "--execute", "--origin=https://preview.example", `--worker-name=${WORKER_NAME}`,
      "--pool=MINI", "--model=preview-model", `--journal=${journalPath}`, `--ledger=${ledgerPath}`,
      `--source-revision=${SOURCE_REVISION}`, `--preview-config=${configPath}`,
      "--capacity-evidence=/tmp/missing-evidence.json", "--execution-target=/tmp/missing-target.json",
    ], baseEnv(), {
      writeSummary: (msg) => summaries.push(JSON.parse(msg)),
      nowUTC: () => NOW_UTC,
      resolveVerifiedExecutionTarget: async () => undefined,
      deploymentFactory: async () => { events.push("deploymentFactory"); throw new Error("must not start"); },
      httpFactory: () => { events.push("httpFactory"); throw new Error("must not start"); },
      runGate: async () => { events.push("runGate"); throw new Error("must not run"); },
      fetchImpl: async () => { throw new Error("must not fetch"); },
      commandImpl: async () => { throw new Error("must not command"); },
    });
    assert.equal(exitCode, 2);
    assert.equal(summaries.at(-1).status, "PREFLIGHT_HOLD");
    assert.ok(summaries.at(-1).reasons.includes("UNVERIFIED_EXECUTION_TARGET"));
    assert.deepEqual(events, []);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("stage1_failed_measurement_cleanup_still_runs", async () => {
  const fixture = await makeTrustRoot({ stage: "stage1", environment: "preview" });
  const tmpDir = await mkdtemp(join(tmpdir(), "cpu-stage1-cleanup-"));
  const events = [];
  const summaries = [];
  try {
    const { configPath, journalPath, ledgerPath } = await stage1TempFiles(tmpDir);
    const resolver = createOperatorVerifiedTargetResolver(baseResolverDeps(fixture));
    const exitCode = await executeCpuGateCli([
      "stage1", "--execute", "--origin=https://preview.example", `--worker-name=${WORKER_NAME}`,
      "--pool=MINI", "--model=preview-model", `--journal=${journalPath}`, `--ledger=${ledgerPath}`,
      `--source-revision=${SOURCE_REVISION}`, `--preview-config=${configPath}`,
      `--capacity-evidence=${fixture.evidencePath}`, `--execution-target=${fixture.targetPath}`,
    ], baseEnv(), {
      writeSummary: (msg) => summaries.push(JSON.parse(msg)),
      nowUTC: () => NOW_UTC,
      resolveVerifiedExecutionTarget: resolver,
      deploymentFactory: async () => {
        return {
          uploadCandidate: async () => { events.push("upload"); return { versionId: "candidate" }; },
          deployCandidate: async () => { events.push("deploy"); },
          observeCandidate: async () => ({ observed: true }),
          deleteVersionSecret: async () => { events.push("delete"); return { versionId: "secretless" }; },
          setTraffic: async () => { events.push("traffic"); },
          verifyMetadata: async () => ({ secretAbsent: true, bindingsUnchanged: true, deployedPercent: 100 }),
          verifyExactVersion: async () => ({ status: 404 }),
        };
      },
      httpFactory: () => ({
        previewPreflight: async () => { events.push("preflight"); return { ready: true }; },
        closeKnownGrants: async () => { events.push("grants-close"); return { closed: true }; },
      }),
      runGate: async ({ mode }) => {
        events.push(mode);
        return { status: mode === "stage1" ? "BLOCKED" : "PASS", ledger: { calls: [] } };
      },
    });
    assert.equal(exitCode, 2);
    assert.equal(summaries.at(-1).status, "BLOCKED");
    assert.deepEqual(events, ["upload", "deploy", "preflight", "stage1", "grants-close", "recover-operation", "delete", "traffic"]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await cleanupTrustRoot(fixture);
  }
});

test("measured CLI binds mode to environment before any remote action", async () => {
  for (const [mode, environment] of [["stage1", "preview"], ["stage2-preflight", "production"], ["stage2-series", "production"]]) {
    // Given an unverified target and remote spies.
    const calls = [];
    let resolved;
    const summaries = [];
    // When the measured mode resolves its target.
    const code = await executeCpuGateCli([mode, "--execute", `--source-revision=${SOURCE_REVISION}`,
      "--worker-name=worker", "--script-version=candidate", "--capacity-evidence=evidence", "--execution-target=target",
      "--journal=journal", "--ledger=ledger"], {}, {
      writeSummary: (line) => summaries.push(JSON.parse(line)),
      resolveVerifiedExecutionTarget: async (args) => { resolved = args; return undefined; },
      fetchImpl: async () => calls.push("fetch"), commandImpl: async () => calls.push("command"), runGate: async () => calls.push("gate"),
    });
    // Then no remote surface was reached and both paths retain their binding.
    assert.equal(code, 2);
    assert.deepEqual(resolved, { mode, environment, sourceRevision: SOURCE_REVISION, workerName: "worker",
      scriptVersionId: "candidate", targetPath: "target", capacityEvidencePath: "evidence" });
    assert.deepEqual(summaries, [{ status: "PREFLIGHT_HOLD", reasons: ["UNVERIFIED_EXECUTION_TARGET"] }]);
    assert.deepEqual(calls, []);
  }
});

test("stage1_missing_resolver_holds_before_provisioning", async () => {
  const calls = [];
  const summaries = [];
  const code = await executeCpuGateCli(["stage1", "--execute", `--source-revision=${SOURCE_REVISION}`,
    "--capacity-evidence=evidence", "--execution-target=target", "--preview-config=config", "--journal=journal", "--ledger=ledger"], baseEnv(), {
    writeSummary: (line) => summaries.push(JSON.parse(line)),
    deploymentFactory: async () => { calls.push("deployment"); throw new Error("must not provision"); },
    runGate: async () => calls.push("gate"), fetchImpl: async () => calls.push("fetch"), commandImpl: async () => calls.push("command"),
  });
  assert.equal(code, 2);
  assert.deepEqual(summaries, [{ status: "PREFLIGHT_HOLD", reasons: ["UNVERIFIED_EXECUTION_TARGET"] }]);
  assert.deepEqual(calls, []);
});

test("stage1_capacity_evaluator_blocks_missing_meter_before_any_remote_call", async () => {
  const fixture = await makeTrustRoot();
  try {
    const capacityEvidence = { ...fixture.evidence, meters: fixture.evidence.meters.filter(({ id }) => id !== "do.rows_written.daily") };
    const summaries = [];
    const calls = [];
    const code = await executeCpuGateCli(["stage1", "--execute", `--source-revision=${SOURCE_REVISION}`,
      "--capacity-evidence=evidence", "--execution-target=target"], {}, {
      nowUTC: () => NOW_UTC, writeSummary: (line) => summaries.push(JSON.parse(line)),
      resolveVerifiedExecutionTarget: async () => ({ target: fixture.target, capacityEvidence }),
      deploymentFactory: async () => calls.push("deployment"), fetchImpl: async () => calls.push("fetch"),
      commandImpl: async () => calls.push("command"), runGate: async () => calls.push("gate"),
    });
    assert.equal(code, 2);
    assert.equal(summaries[0].status, "PREFLIGHT_HOLD");
    assert.ok(summaries[0].reasons.length > 0);
    assert.deepEqual(calls, []);
  } finally { await cleanupTrustRoot(fixture); }
});

test("measured CLI preserves TypeError for malformed source revision", async () => {
  for (const mode of ["stage1", "stage2-preflight", "stage2-series"]) {
    for (const revision of [undefined, "short", "f".repeat(41)]) {
      const calls = [];
      await assert.rejects(executeCpuGateCli([mode, "--execute", ...(revision ? [`--source-revision=${revision}`] : [])], {}, {
        writeSummary: () => {}, resolveVerifiedExecutionTarget: async () => calls.push("resolve"),
        fetchImpl: async () => calls.push("fetch"), commandImpl: async () => calls.push("command"), runGate: async () => calls.push("gate"),
      }), TypeError);
      assert.deepEqual(calls, []);
    }
  }
});

test("stage1_requires_both_evidence_paths_without_remote_calls", async () => {
  for (const flags of [["--capacity-evidence=evidence"], ["--execution-target=target"], []]) {
    const calls = [];
    const summaries = [];
    const code = await executeCpuGateCli(["stage1", "--execute", `--source-revision=${SOURCE_REVISION}`, ...flags], {}, {
      writeSummary: (line) => summaries.push(JSON.parse(line)), resolveVerifiedExecutionTarget: async () => calls.push("resolve"),
      fetchImpl: async () => calls.push("fetch"), commandImpl: async () => calls.push("command"), runGate: async () => calls.push("gate"),
    });
    assert.equal(code, 2);
    assert.equal(summaries[0].status, "PREFLIGHT_HOLD");
    assert.deepEqual(calls, []);
  }
});
