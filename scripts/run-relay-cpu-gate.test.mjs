import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runRelayCpuGate, generateCpuGateBearer, withPreviewSecretsFile, runFixtureLifecycle, recoverSharedOperation, runPreviewLifecycle, assertNoCredentialLeak } from "./run-relay-cpu-gate.mjs";

test("supports safe stage modes and does not retain bearer values", async () => {
  const result = await runRelayCpuGate({ mode: "stage1", adapters: { runSeries: async () => ({ status: 200 }) } });
  assert.equal(result.status, "PASS");
  assert.equal(JSON.stringify(result.ledger).includes("synthetic-token"), false);
});

test("runs runner-owned concurrent decision callbacks and terminalizes each grant before continuing", async () => {
  const observed = [];
  const result = await runRelayCpuGate({
    mode: "stage1",
    runId: "safe-run",
    adapters: {
      series: [{ invocationClass: "decision", workloadClass: "baseline-small", concurrency: 2 }],
      sampleCount: 2,
      workerName: "candidate",
      candidateVersionId: "version-1",
      createFixture: async () => ({ requestId: "fixture-1", grantCredential: "secret-grant" }),
      decisionContext: async ({ requestId }) => ({ contextToken: "secret-context", requestId }),
      callback: async ({ invocationClass, headers, requestId }) => {
        observed.push({ invocationClass, headers, requestId });
        return { status: 200, outcome: "allow", grantCredential: "secret-grant" };
      },
      terminalize: async ({ requestId }) => ({ accepted: true, state: "settled", requestId }),
      proveTerminal: async () => ({ terminal: true }),
    },
  });
  assert.equal(result.status, "PASS");
  assert.equal(observed.length, 2);
  assert.ok(observed.every((call) => call.headers["Cloudflare-Workers-Version-Overrides"] === 'candidate="version-1"'));
  assert.equal(JSON.stringify(result.ledger).includes("secret-context"), false);
  assert.equal(JSON.stringify(result.ledger).includes("secret-grant"), false);
});

test("executes exactly 500 successful callbacks for an injected series", async () => {
  let calls = 0;
  const result = await runRelayCpuGate({
    mode: "stage1",
    adapters: {
      series: [{ invocationClass: "ingress", workloadClass: "baseline-small", concurrency: 3 }],
      callback: async () => { calls += 1; return { status: 200, outcome: "completed" }; },
    },
  });
  assert.equal(result.status, "PASS");
  assert.equal(calls, 500);
  assert.equal(result.ledger.calls.length, 500);
});

test("blocks Stage 2 setup when the shared singleton is busy", async () => {
  let setupCalled = false;
  const result = await runRelayCpuGate({
    mode: "stage2-series",
    adapters: {
      preflightPassed: true,
      claimSlot: async () => ({ kind: "busy" }),
      closeOperation: async () => ({ idle: true }),
      callback: async () => { setupCalled = true; return { status: 200 }; },
    },
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(setupCalled, false);
});

test("generates fresh base64url bearer and securely cleans Preview secret material", async () => {
  const token = generateCpuGateBearer();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  let observedMode;
  let observedDirectoryMode;
  let observedPath;
  await withPreviewSecretsFile({ token, directoryParent: "/tmp", upload: async (path) => {
    const { statSync } = await import("node:fs");
    observedPath = path;
    observedMode = statSync(path).mode & 0o777;
    observedDirectoryMode = statSync(path.slice(0, path.lastIndexOf("/"))).mode & 0o777;
  } });
  const { existsSync } = await import("node:fs");
  assert.equal(observedMode, 0o600);
  assert.equal(observedDirectoryMode, 0o700);
  assert.equal(existsSync(observedPath), false);
});

test("runs fixture setup, fence, inspection and unused reconciliation before callbacks", async () => {
  const events = [];
  const outcome = await runFixtureLifecycle({ requestId: "fixture", adapters: {
    setup: async () => { events.push("setup"); return { kind: "created", operationId: "op" }; },
    setupFence: async () => { events.push("fence"); return { kind: "fenced" }; },
    inspectOperation: async () => { events.push("inspect"); return { kind: "unused" }; },
    reconcileUnused: async () => { events.push("reconcile"); return { kind: "reconciled" }; },
  } });
  assert.equal(outcome.kind, "ready");
  assert.deepEqual(events, ["setup", "fence", "inspect", "reconcile"]);
});

test("accepts terminal and no-op reconcile-unused outcomes after state inspection", async () => {
  for (const kind of ["terminal", "noop"]) {
    const outcome = await runFixtureLifecycle({ requestId: "fixture", adapters: {
      setup: async () => ({ kind: "created", operationId: "op" }),
      setupFence: async () => ({ kind: "fenced" }),
      inspectOperation: async () => ({ kind: "unused" }),
      reconcileUnused: async () => ({ kind }),
    } });
    assert.equal(outcome.kind, "ready");
  }
});

test("recovers an ambiguous setup acknowledgement through setup-fence before inspection", async () => {
  const events = [];
  const outcome = await runFixtureLifecycle({ requestId: "lost-ack", adapters: {
    setup: async () => { events.push("setup"); throw new Error("transport lost acknowledgement"); },
    setupFence: async ({ requestId, recover }) => { events.push(`fence:${requestId}:${recover}`); return { kind: "fenced", operationId: "recovered" }; },
    inspectOperation: async () => { events.push("inspect"); return { kind: "unused" }; },
    reconcileUnused: async () => ({ kind: "reconciled" }),
  } });
  assert.equal(outcome.kind, "ready");
  assert.equal(outcome.fixture.operationId, "recovered");
  assert.deepEqual(events, ["setup", "fence:lost-ack:true", "inspect"]);
});

test("blocks shared-slot recovery when its owner conflicts with the journal generation", async () => {
  const result = await recoverSharedOperation({ journal: [{ requestId: "owner", generation: 2 }], adapters: {
    readSharedSlot: async () => ({ kind: "owned", owner: { requestId: "owner", generation: 3 } }),
  } });
  assert.deepEqual(result, { kind: "blocked", reason: "journal-generation-mismatch" });
});

test("reconciles shared singleton owner before accepting local journal state", async () => {
  const events = [];
  const result = await recoverSharedOperation({ journal: [{ requestId: "stale", state: "active" }], adapters: {
    readSharedSlot: async () => { events.push("slot"); return { kind: "owned", owner: { requestId: "stale", generation: 4 } }; },
    inspectOperation: async () => { events.push("inspect"); return { kind: "active" }; },
    recoverOperation: async () => { events.push("recover"); return { kind: "terminal" }; },
    closeOperation: async () => { events.push("close"); return { idle: true }; },
  } });
  assert.equal(result.kind, "idle");
  assert.deepEqual(events, ["slot", "inspect", "recover", "close"]);
});

test("runs mocked Preview sequence and rolls back while always cleaning temporary secrets", async () => {
  const events = [];
  const result = await runPreviewLifecycle({ bearer: "cpu-secret", adapters: {
    createTempSecret: async ({ token }) => { assert.equal(token, "cpu-secret"); events.push("temp"); return { path: "fake/secrets.json" }; },
    uploadCandidate: async ({ path, secretName }) => { assert.equal(path, "fake/secrets.json"); assert.equal(secretName, "OCTG_RELAY_CPU_GATE_AUTH_TOKEN"); events.push("upload"); return { versionId: "candidate" }; },
    deployCandidate: async () => { events.push("deploy"); },
    observeCandidate: async () => { events.push("observe"); return { observed: true }; },
    uploadSecretless: async () => { events.push("secretless"); return { versionId: "secretless" }; },
    setTraffic: async ({ percent }) => { events.push(`traffic:${percent}`); },
    deleteVersionSecret: async () => { events.push("delete"); },
    verifyMetadata: async () => ({ secretAbsent: true, bindingsUnchanged: true }),
    verifyExactVersion: async () => { events.push("404"); return { status: 404 }; },
    rollback: async () => { events.push("rollback"); },
    cleanupTemp: async () => { events.push("cleanup"); },
  } });
  assert.equal(result.kind, "complete");
  assert.deepEqual(events, ["temp", "upload", "deploy", "observe", "secretless", "traffic:100", "delete", "404", "cleanup"]);
});

test("scans every credential output surface without exposing credential values", () => {
  const credentials = ["gate-bearer", "service-bearer", "hmac-key", "grant-token"];
  assert.throws(() => assertNoCredentialLeak({ credentials, surfaces: {
    stdout: "ok", stderr: "ok", config: "ok", argv: ["worker"], artifacts: ["artifact grant-token"],
  } }), /credential leak/);
  assert.doesNotThrow(() => assertNoCredentialLeak({ credentials, surfaces: {
    stdout: "ok", stderr: "ok", config: "ok", argv: ["worker"], artifacts: ["artifact"],
  } }));
});

test("runs a renewal callback against its setup fixture and proves terminal retry", async () => {
  const events = [];
  const result = await runRelayCpuGate({ mode: "stage1", adapters: {
    series: [{ invocationClass: "renewal_normal", workloadClass: "baseline-small", concurrency: 1 }], sampleCount: 1,
    createFixture: async () => ({ requestId: "renew-me", grantCredential: "grant-secret" }),
    callback: async (input) => { events.push(`callback:${input.requestId}`); return { status: 200, grantCredential: "next-grant" }; },
    terminalize: async () => { events.push("terminal"); return { accepted: true, state: "settled" }; },
    proveTerminal: async () => ({ terminal: true }),
    terminalizeFixture: async () => { events.push("fixture-terminal"); },
  } });
  assert.equal(result.status, "PASS");
  assert.deepEqual(events, ["callback:renew-me", "terminal", "fixture-terminal"]);
});

test("requires a fresh rejection proof before Stage 2 slot claim and binds it to the run", async () => {
  const events = [];
  const result = await runRelayCpuGate({ mode: "stage2-series", runId: "stage2", adapters: {
    readSharedSlot: async () => ({ kind: "idle" }),
    inspectOperation: async () => ({ kind: "absent" }),
    recoverOperation: async () => ({ kind: "fencedAbsent" }),
    runPreflight: async ({ runId, model }) => { events.push("preflight"); return { runId, model, outcome: "model_requires_paid", admissionCreated: false, grantCreated: false }; },
    claimSlot: async ({ runId }) => { events.push("claim"); return { kind: "claimed", requestId: "op", generation: 1, runId }; },
    closeOperation: async () => { events.push("close"); return { idle: true, targetTerminal: true, fencedAbsent: true }; },
    series: [], callback: async () => ({ status: 200 }),
  } });
  assert.equal(result.status, "PASS");
  assert.deepEqual(events, ["preflight", "claim", "close"]);
});

test("does not claim the Stage 2 singleton when rejection preflight creates an admission", async () => {
  let claimed = false;
  const result = await runRelayCpuGate({ mode: "stage2-series", runId: "reject-run", adapters: {
    readSharedSlot: async () => ({ kind: "idle" }), inspectOperation: async () => ({ kind: "absent" }),
    recoverOperation: async () => ({ kind: "fencedAbsent" }), closeOperation: async () => ({ idle: true }),
    runPreflight: async ({ runId, model }) => ({ runId, model, outcome: "model_requires_paid", admissionCreated: true, grantCreated: false }),
    claimSlot: async () => { claimed = true; return { kind: "claimed" }; },
  } });
  assert.equal(result.status, "BLOCKED");
  assert.equal(claimed, false);
});

test("Preview teardown failure rolls back candidate and still cleans temp material", async () => {
  const events = [];
  const result = await runPreviewLifecycle({ bearer: "gate", adapters: {
    createTempSecret: async () => ({ path: "secret-file" }),
    uploadCandidate: async () => ({ versionId: "v" }), deployCandidate: async () => { events.push("deploy"); },
    observeCandidate: async () => ({ observed: true }), uploadSecretless: async () => {}, setTraffic: async () => {},
    deleteVersionSecret: async () => {}, verifyExactVersion: async () => ({ status: 200 }),
    rollback: async () => { events.push("rollback"); }, cleanupTemp: async () => { events.push("cleanup"); },
  } });
  assert.equal(result.kind, "blocked");
  assert.deepEqual(events, ["deploy", "rollback", "cleanup"]);
});

test("runs measurement before Preview teardown and moves 100 percent traffic to secretless version", async () => {
  const events = [];
  await runPreviewLifecycle({ bearer: "gate", adapters: {
    createTempSecret: async () => ({ path: "secret-file" }), uploadCandidate: async () => ({ versionId: "candidate" }),
    deployCandidate: async () => {}, observeCandidate: async () => ({ observed: true }),
    uploadSecretless: async () => ({ versionId: "secretless" }),
    measure: async () => { events.push("measure"); },
    setTraffic: async ({ versionId, percent }) => { events.push(`traffic:${versionId}:${percent}`); },
    deleteVersionSecret: async ({ versionId }) => { events.push(`delete:${versionId}`); },
    verifyMetadata: async ({ versionId }) => ({ versionId, secretAbsent: true, bindingsUnchanged: true }),
    verifyExactVersion: async ({ versionId }) => ({ versionId, status: 404 }), rollback: async () => {},
    cleanupTemp: async () => { events.push("cleanup"); },
  } });
  assert.deepEqual(events, ["measure", "traffic:secretless:100", "delete:candidate", "cleanup"]);
});

test("closes fixture ownership after failed measurement before secret teardown", async () => {
  const events = [];
  const result = await runPreviewLifecycle({ bearer: "gate", adapters: {
    createTempSecret: async () => ({ path: "secret-file" }), uploadCandidate: async () => ({ versionId: "candidate" }),
    deployCandidate: async () => {}, observeCandidate: async () => ({ observed: true }),
    measure: async () => { events.push("measure"); throw new Error("measurement failed"); },
    beforeTeardown: async () => { events.push("close"); },
    uploadSecretless: async () => { events.push("secretless"); return { versionId: "secretless" }; },
    setTraffic: async () => {}, deleteVersionSecret: async () => { events.push("delete"); },
    verifyMetadata: async () => ({ secretAbsent: true, bindingsUnchanged: true }),
    verifyExactVersion: async () => ({ status: 404 }), rollback: async () => { events.push("rollback"); },
    cleanupTemp: async () => { events.push("cleanup"); },
  } });
  assert.equal(result.kind, "blocked");
  assert.deepEqual(events, ["measure", "close", "secretless", "delete", "rollback", "cleanup"]);
});

test("retries terminal callback until terminal proof and blocks if proof never arrives", async () => {
  let attempts = 0;
  const result = await runRelayCpuGate({ mode: "stage1", adapters: {
    series: [{ invocationClass: "decision", workloadClass: "baseline-small", concurrency: 1 }], sampleCount: 1,
    decisionContext: async () => ({ contextToken: "context" }),
    callback: async () => ({ status: 200, grantCredential: "grant" }),
    terminalize: async () => { attempts += 1; return attempts < 2 ? { accepted: false } : { accepted: true, state: "terminal" }; },
    proveTerminal: async () => ({ terminal: true }),
  } });
  assert.equal(attempts, 2);
  assert.equal(result.status, "PASS");
});

test("blocks when any supplied output artifact contains a credential sentinel", async () => {
  const result = await runRelayCpuGate({ mode: "stage1", adapters: {
    series: [{ invocationClass: "ingress", workloadClass: "baseline-small", concurrency: 1 }], sampleCount: 1,
    callback: async () => ({ status: 200 }),
    credentialSentinels: ["cpu-gate-secret", "service-secret", "hmac-secret", "grant-secret"],
    outputSurfaces: { stdout: "clean", stderr: "clean", config: "clean", argv: [], artifacts: ["grant-secret"] },
  } });
  assert.equal(result.status, "BLOCKED");
  assert.equal(JSON.stringify(result.ledger).includes("grant-secret"), false);
});
