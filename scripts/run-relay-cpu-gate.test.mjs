import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRelayCpuGate, generateCpuGateBearer, withPreviewSecretsFile, runFixtureLifecycle, recoverSharedOperation, runPreviewLifecycle, assertNoCredentialLeak } from "./run-relay-cpu-gate.mjs";

test("supports safe stage modes and does not retain bearer values", async () => {
  const result = await runRelayCpuGate({ mode: "stage1", adapters: { runSeries: async () => ({ status: 200 }) } });
  assert.equal(result.status, "BLOCKED");
  assert.equal(JSON.stringify(result.ledger).includes("synthetic-token"), false);
});

test("a semantically failed callback blocks the series instead of collecting replacements", async () => {
  let calls = 0;
  const result = await runRelayCpuGate({ mode: "stage1", adapters: {
    workerName: "worker", candidateVersionId: "candidate", sampleCount: 2,
    series: [{ invocationClass: "ingress", workloadClass: "baseline-small", concurrency: 1 }],
    callback: async () => ({ status: ++calls === 1 ? 500 : 200, scriptVersionId: "candidate" }),
  } });
  assert.equal(result.status, "BLOCKED");
  assert.equal(calls, 1);
  assert.equal(result.ledger.calls[0].success, false);
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
        return { status: 200, outcome: "allow", grantCredential: "secret-grant", scriptVersionId: "version-1" };
      },
      terminalize: async ({ requestId }) => ({ accepted: true, state: "settled", requestId }),
      proveTerminal: async () => ({ terminal: true }),
    },
  });
  assert.equal(result.status, "PASS");
  assert.equal(observed.length, 2);
  assert.equal(new Set(observed.map((call) => call.requestId)).size, 2);
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
      workerName: "candidate", candidateVersionId: "version-1",
      callback: async () => { calls += 1; return { status: 200, outcome: "completed", scriptVersionId: "version-1" }; },
    },
  });
  assert.equal(result.status, "PASS");
  assert.equal(calls, 500);
  assert.equal(result.ledger.calls.length, 500);
});

test("persists the measurement correlation ID returned by each HTTP callback", async () => {
  const result = await runRelayCpuGate({ mode: "stage1", adapters: {
    series: [{ invocationClass: "ingress", workloadClass: "baseline-small", concurrency: 1 }],
    workerName: "candidate",
    candidateVersionId: "version-1",
    sampleCount: 1,
    callback: async () => ({ status: 200, measurementId: "measurement-id-1", scriptVersionId: "version-1" }),
  } });

  assert.equal(result.status, "PASS");
  assert.equal(result.ledger.calls[0].measurementId, "measurement-id-1");
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

test("generates fresh base64url bearer and securely cleans only per-run Preview secret material", async () => {
  const token = generateCpuGateBearer();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const relaySecrets = {
    OCTG_RELAY_SERVICE_AUTH_TOKEN: "synthetic-preview-service-token",
    OCTG_RELAY_INGRESS_AUTH_TOKEN: "synthetic-preview-ingress-token",
    OCTG_RELAY_CONTEXT_HMAC_KEY: "synthetic-preview-hmac-key",
  };
  let observedMode;
  let observedDirectoryMode;
  let observedPath;
  await withPreviewSecretsFile({ token, relaySecrets, directoryParent: "/tmp", upload: async (path) => {
    const { statSync } = await import("node:fs");
    observedPath = path;
    observedMode = statSync(path).mode & 0o777;
    observedDirectoryMode = statSync(path.slice(0, path.lastIndexOf("/"))).mode & 0o777;
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: token });
  } });
  const { existsSync } = await import("node:fs");
  assert.equal(observedMode, 0o600);
  assert.equal(observedDirectoryMode, 0o700);
  assert.equal(existsSync(observedPath), false);
});

test("preserves successful setup credentials without fencing the live fixture", async () => {
  const events = [];
  const outcome = await runFixtureLifecycle({ pool: "MINI", requestId: "fixture", adapters: {
    setup: async () => { events.push("setup"); return { version: 1, pool: "MINI", requestId: "fixture", grantToken: "grant", grantId: "op", leaseGeneration: "generation-1", admissionUtcDay: "2026-10-24" }; },
    setupFence: async () => { events.push("fence"); return { kind: "fenced" }; },
    inspectOperation: async () => { events.push("inspect"); return { kind: "unused" }; },
    reconcileUnused: async () => { events.push("reconcile"); return { kind: "reconciled" }; },
  } });
  assert.equal(outcome.kind, "ready");
  assert.deepEqual(events, ["setup"]);
});

test("rejects unsupported terminal and no-op reconciliation envelopes", async () => {
  for (const kind of ["terminal", "noop"]) {
    const outcome = await runFixtureLifecycle({ pool: "MINI", requestId: "fixture", adapters: {
      setup: async () => ({ kind: "created", operationId: "op" }),
      setupFence: async () => ({ kind: "fenced" }),
      inspectOperation: async () => ({ kind: "unused" }),
      reconcileUnused: async () => ({ kind }),
    } });
    assert.equal(outcome.kind, "blocked");
  }
});

test("recovers an ambiguous setup acknowledgement through setup-fence before inspection", async () => {
  const events = [];
  const outcome = await runFixtureLifecycle({ pool: "MINI", requestId: "lost-ack", adapters: {
    setup: async () => { events.push("setup"); throw new Error("transport lost acknowledgement"); },
    setupFence: async ({ requestId }) => { events.push(`fence:${requestId}`); return { version: 1, kind: "fenced" }; },
    inspectOperation: async () => { events.push("inspect"); return { version: 1, kind: "absent" }; },
    reconcileUnused: async () => ({ kind: "reconciled" }),
  } });
  assert.equal(outcome.kind, "closed");
  assert.deepEqual(events, ["setup", "fence:lost-ack", "inspect"]);
});

test("blocks shared-slot recovery when its owner conflicts with the journal generation", async () => {
  const result = await recoverSharedOperation({ journal: [{ requestId: "owner", generation: 2 }], adapters: {
    readSharedSlot: async () => ({ version: 1, slot: { kind: "held", owner: { requestId: "owner" }, generation: 3 } }),
  } });
  assert.deepEqual(result, { kind: "blocked", reason: "journal-generation-mismatch" });
});

test("reconciles shared singleton owner before accepting local journal state", async () => {
  const events = [];
  let closed = false;
  const result = await recoverSharedOperation({ journal: [{ pool: "MINI", requestId: "stale", state: "active" }], adapters: {
    readSharedSlot: async () => { events.push("slot"); return { version: 1, slot: closed ? { kind: "idle" } : { kind: "held", owner: { pool: "MINI", requestId: "stale" }, generation: 4 } }; },
    setupFence: async () => ({ version: 1, kind: "fenced" }),
    inspectOperation: async () => { events.push("inspect"); return { version: 1, kind: "absent" }; },
    closeOperation: async () => { events.push("close"); closed = true; return { version: 1, kind: "closed" }; },
  } });
  assert.equal(result.kind, "idle");
  assert.deepEqual(events, ["slot", "inspect", "close", "slot"]);
});

test("runs the Preview versioned secret deletion sequence without another candidate upload", async () => {
  const events = [];
  const result = await runPreviewLifecycle({ bearer: "cpu-secret", adapters: {
    uploadCandidate: async ({ secretsPath, secretName }) => { assert.ok(secretsPath.endsWith("secrets.json")); assert.equal(secretName, "OCTG_RELAY_CPU_GATE_AUTH_TOKEN"); events.push("upload"); return { versionId: "candidate" }; },
    deployCandidate: async () => { events.push("deploy"); },
    observeCandidate: async () => { events.push("observe"); return { observed: true }; },
    preflight: async () => ({ ready: true }), beforeTeardown: async () => ({ closed: true }),
    setTraffic: async ({ percent }) => { events.push(`traffic:${percent}`); },
    deleteVersionSecret: async () => { events.push("delete"); return { versionId: "secretless" }; },
    verifyMetadata: async () => ({ secretAbsent: true, bindingsUnchanged: true, deployedPercent: 100 }),
    verifyExactVersion: async () => { events.push("404"); return { status: 404 }; },
  } });
  assert.equal(result.kind, "complete");
  assert.deepEqual(events, ["upload", "deploy", "observe", "delete", "traffic:100", "404"]);
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
    workerName: "candidate", candidateVersionId: "version-1",
    series: [{ invocationClass: "renewal_normal", workloadClass: "baseline-small", concurrency: 1 }], sampleCount: 1,
    createFixture: async () => ({ requestId: "renew-me", grantCredential: "grant-secret" }),
    callback: async (input) => { events.push(`callback:${input.requestId}`); return { status: 200, grantCredential: "next-grant", scriptVersionId: "version-1" }; },
    terminalize: async () => { events.push("terminal"); return { accepted: true, state: "settled" }; },
    proveTerminal: async () => ({ terminal: true }),
    terminalizeFixture: async () => { events.push("fixture-terminal"); return { accepted: true, state: "settled" }; },
  } });
  assert.equal(result.status, "PASS");
  assert.deepEqual(events, ["callback:renew-me", "terminal", "fixture-terminal"]);
});

test("binds rejection preflight to the run without inventing a separate slot claim route", async () => {
  const events = [];
  const result = await runRelayCpuGate({ mode: "stage2-series", runId: "stage2", adapters: {
    readSharedSlot: async () => ({ version: 1, slot: { kind: "idle" } }),
    inspectOperation: async () => ({ kind: "absent" }),
    recoverOperation: async () => ({ kind: "fencedAbsent" }),
    runPreflight: async ({ runId, model }) => { events.push("preflight"); return { runId, model, outcome: "model_requires_paid", admissionCreated: false, grantCreated: false }; },
    claimSlot: async () => { assert.fail("claim route does not exist; setup owns claim"); },
    closeOperation: async () => { events.push("close"); return { idle: true, targetTerminal: true, fencedAbsent: true }; },
    series: [], callback: async () => ({ status: 200 }),
  } });
  assert.equal(result.status, "PASS");
  assert.deepEqual(events, ["preflight"]);
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

test("Preview teardown failure reports BLOCKED without re-enabling the secret-bearing candidate", async () => {
  const events = [];
  const result = await runPreviewLifecycle({ bearer: "gate", adapters: {
    uploadCandidate: async () => ({ versionId: "v" }), deployCandidate: async () => { events.push("deploy"); },
    observeCandidate: async () => ({ observed: true }), preflight: async () => ({ ready: true }), beforeTeardown: async () => ({ closed: true }),
    deleteVersionSecret: async () => { events.push("delete"); return { versionId: "secretless" }; }, setTraffic: async () => {},
    verifyMetadata: async () => ({ secretAbsent: true, bindingsUnchanged: true, deployedPercent: 100 }), verifyExactVersion: async () => ({ status: 200 }),
    rollback: async () => { assert.fail("must not re-enable the candidate secret"); },
  } });
  assert.equal(result.kind, "blocked");
  assert.deepEqual(events, ["deploy", "delete"]);
});

test("runs measurement before Preview teardown and moves 100 percent traffic to secretless version", async () => {
  const events = [];
  await runPreviewLifecycle({ bearer: "gate", adapters: {
    uploadCandidate: async () => ({ versionId: "candidate" }),
    deployCandidate: async () => {}, observeCandidate: async () => ({ observed: true }),
    preflight: async () => ({ ready: true }), beforeTeardown: async () => ({ closed: true }),
    measure: async () => { events.push("measure"); },
    setTraffic: async ({ versionId, percent }) => { events.push(`traffic:${versionId}:${percent}`); },
    deleteVersionSecret: async ({ versionId }) => { events.push(`delete:${versionId}`); return { versionId: "secretless" }; },
    verifyMetadata: async ({ versionId }) => ({ versionId, secretAbsent: true, bindingsUnchanged: true, deployedPercent: 100 }),
    verifyExactVersion: async ({ versionId }) => ({ versionId, status: 404 }),
  } });
  assert.deepEqual(events, ["measure", "delete:candidate", "traffic:secretless:100"]);
});

test("closes fixture ownership after failed measurement before secret teardown", async () => {
  const events = [];
  const result = await runPreviewLifecycle({ bearer: "gate", adapters: {
    uploadCandidate: async () => ({ versionId: "candidate" }),
    deployCandidate: async () => {}, observeCandidate: async () => ({ observed: true }),
    preflight: async () => ({ ready: true }),
    measure: async () => { events.push("measure"); throw new Error("measurement failed"); },
    beforeTeardown: async () => { events.push("close"); return { closed: true }; },
    setTraffic: async () => {}, deleteVersionSecret: async () => { events.push("delete"); return { versionId: "secretless" }; },
    verifyMetadata: async () => ({ secretAbsent: true, bindingsUnchanged: true, deployedPercent: 100 }),
    verifyExactVersion: async () => ({ status: 404 }),
  } });
  assert.equal(result.kind, "blocked");
  assert.deepEqual(events, ["measure", "close", "delete"]);
});

test("retries terminal callback until terminal proof and blocks if proof never arrives", async () => {
  let attempts = 0;
  const result = await runRelayCpuGate({ mode: "stage1", adapters: {
    workerName: "candidate", candidateVersionId: "version-1",
    series: [{ invocationClass: "decision", workloadClass: "baseline-small", concurrency: 1 }], sampleCount: 1,
    decisionContext: async () => ({ contextToken: "context" }),
    callback: async () => ({ status: 200, grantCredential: "grant", scriptVersionId: "version-1" }),
    terminalize: async () => { attempts += 1; return attempts < 2 ? { accepted: false } : { accepted: true, state: "settled" }; },
    proveTerminal: async () => ({ terminal: true }),
  } });
  assert.equal(attempts, 2);
  assert.equal(result.status, "PASS");
});

test("replay batches retain one prepared fixture until all samples finish", async () => {
  const events = [];
  let fixtureCount = 0;
  const result = await runRelayCpuGate({ mode: "stage1", adapters: {
    workerName: "candidate", candidateVersionId: "version-1",
    series: [{ invocationClass: "activation_replay", workloadClass: "baseline-small", concurrency: 1 }], sampleCount: 2,
    createFixture: async () => { const requestId = `fixture-${++fixtureCount}`; events.push(`setup:${requestId}`); return { requestId, grantCredential: "synthetic-grant" }; },
    prepareFixture: async () => { events.push("prepare"); },
    callback: async ({ requestId }) => { events.push(`callback:${requestId}`); return { status: 200, scriptVersionId: "version-1" }; },
    terminalizeFixture: async ({ fixture }) => { events.push(`close:${fixture.requestId}`); return { accepted: true, state: "released" }; },
  } });
  assert.equal(result.status, "PASS");
  assert.equal(fixtureCount, 1);
  assert.deepEqual(events, ["setup:fixture-1", "prepare", "callback:fixture-1", "callback:fixture-1", "close:fixture-1"]);
});

test("missing fixture terminal acknowledgement prevents the next sample", async () => {
  let fixtures = 0;
  const result = await runRelayCpuGate({ mode: "stage1", adapters: {
    workerName: "candidate", candidateVersionId: "version-1",
    series: [{ invocationClass: "activation_normal", workloadClass: "baseline-small", concurrency: 1 }], sampleCount: 2,
    createFixture: async () => { fixtures += 1; return { requestId: "fixture", grantCredential: "grant" }; },
    callback: async () => ({ status: 200, scriptVersionId: "version-1" }), terminalizeFixture: async () => undefined,
  } });
  assert.equal(result.status, "BLOCKED");
  assert.equal(fixtures, 1);
});

test("rejects missing version override inputs or responses from another candidate", async () => {
  for (const candidateVersionId of [undefined, "candidate-version"]) {
    const result = await runRelayCpuGate({ adapters: {
      workerName: "worker", candidateVersionId, sampleCount: 1,
      series: [{ invocationClass: "ingress", workloadClass: "baseline-small", concurrency: 1 }],
      callback: async () => ({ status: 200, scriptVersionId: "wrong-version" }),
    } });
    assert.equal(result.status, "BLOCKED");
  }
});

test("journals fixture identity before admission and persists only safe terminal state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpu-journal-"));
  const journalPath = join(directory, "operations.json");
  try {
    let terminalized = false;
    const result = await runRelayCpuGate({ journalPath, adapters: {
      pool: "MINI", workerName: "worker", candidateVersionId: "v", sampleCount: 1,
      series: [{ invocationClass: "activation_normal", workloadClass: "baseline-small", concurrency: 1 }],
      setup: async ({ pool, requestId }) => {
        const journal = JSON.parse(await readFile(journalPath, "utf8"));
        assert.equal(journal.operations[0].requestId, requestId);
        assert.equal(journal.operations[0].state, "setup_pending");
        assert.ok(Number.isSafeInteger(journal.operations[0].createdAt));
        return { version: 1, pool, requestId, grantToken: "synthetic-secret", grantId: "g", leaseGeneration: "lease", admissionUtcDay: "2026-10-24" };
      },
      setupFence: async () => { assert.equal(terminalized, true, "successful setup not fenced before measurement"); return { version: 1, kind: "fixture" }; },
      inspectOperation: async () => ({ version: 1, kind: "fixture", inspection: { kind: "fixture", cpuGateFixture: true, state: "released", requestState: "released", activeLease: false } }),
      reconcileUnused: async () => { assert.fail("terminal fixture must not be reconciled again"); },
      callback: async () => ({ status: 200, scriptVersionId: "v" }),
      terminalizeFixture: async () => { terminalized = true; return { accepted: true, state: "released" }; },
    } });
    assert.equal(result.status, "PASS");
    const journal = await readFile(journalPath, "utf8");
    assert.equal(JSON.parse(journal).operations[0].state, "closed");
    assert.equal(journal.includes("synthetic-secret"), false);
    assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function fixtureServer({ failCallback = false, incompatible = false } = {}) {
  const events = [];
  let slot = { kind: "idle" };
  let generation = 0;
  const states = new Map();
  const terminal = { kind: "fixture", cpuGateFixture: true, state: "reconciled_unused", requestState: "released", actualTokens: null, activeLease: false };
  const adapters = {
    pool: "MINI", workerName: "worker", candidateVersionId: "v", sampleCount: 2,
    series: [{ invocationClass: "activation_normal", workloadClass: "baseline-small", concurrency: 1 }],
    readSharedSlot: async () => ({ version: 1, slot }),
    runPreflight: async ({ runId, model }) => ({ runId, model, outcome: "model_requires_paid", admissionCreated: false, grantCreated: false }),
    setup: async ({ pool, requestId }) => {
      events.push("setup");
      assert.equal(slot.kind, "idle", "previous singleton must be closed before another admission");
      slot = { kind: "held", owner: { pool, requestId }, generation: ++generation };
      states.set(requestId, { ...terminal, state: "authorized", requestState: "reserved", activeLease: true });
      return { version: 1, pool, requestId, grantToken: "synthetic-grant", grantId: "g", leaseGeneration: "lease", admissionUtcDay: "2026-10-24" };
    },
    setupFence: async ({ requestId }) => ({ version: 1, requestId, kind: incompatible ? "non_fixture" : "fixture", inspection: states.get(requestId) }),
    inspectOperation: async ({ requestId }) => ({ version: 1, kind: "fixture", inspection: states.get(requestId) }),
    reconcileUnused: async ({ requestId }) => { events.push("reconcile"); states.set(requestId, terminal); return { version: 1, kind: "reconciled_unused" }; },
    callback: async () => { events.push("callback"); if (failCallback) throw new Error("lost callback acknowledgement"); return { status: 200, scriptVersionId: "v" }; },
    terminalizeFixture: async ({ fixture }) => { events.push("terminal"); states.set(fixture.requestId, terminal); return { accepted: true, state: "released" }; },
    closeOperation: async (input) => {
      assert.deepEqual(input, { version: 1, ...slot.owner, generation: slot.generation });
      assert.equal(states.get(input.requestId).activeLease, false);
      events.push("close"); slot = { kind: "idle" }; return { version: 1, kind: "closed" };
    },
  };
  return { adapters, events, slot: () => slot };
}

test("closes each Stage 2 singleton before admitting the next measured fixture", async () => {
  const server = fixtureServer();
  const result = await runRelayCpuGate({ mode: "stage2-series", adapters: server.adapters });
  assert.equal(result.status, "PASS");
  assert.deepEqual(server.events, ["setup", "callback", "terminal", "close", "setup", "callback", "terminal", "close"]);
  assert.equal(server.slot().kind, "idle");
  assert.ok(result.ledger.operations.every((operation) => operation.state === "closed" && Number.isSafeInteger(operation.generation)));
});

test("failed callback is reconciled and its singleton is closed before reporting BLOCKED", async () => {
  const server = fixtureServer({ failCallback: true });
  const result = await runRelayCpuGate({ mode: "stage2-series", adapters: server.adapters });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(server.events, ["setup", "callback", "reconcile", "close"]);
  assert.equal(server.slot().kind, "idle");
  assert.equal(result.ledger.operations[0].state, "closed");
});

test("unprovable callback recovery retains slot ownership and never admits a replacement", async () => {
  const server = fixtureServer({ failCallback: true, incompatible: true });
  const result = await runRelayCpuGate({ mode: "stage2-series", adapters: server.adapters });
  assert.equal(result.status, "BLOCKED");
  assert.equal(server.slot().kind, "held");
  assert.deepEqual(server.events, ["setup", "callback"]);
  assert.notEqual(result.ledger.operations[0].state, "closed");
});

test("a failed concurrent callback waits for the other callbacks before reconciling", async () => {
  const server = fixtureServer();
  server.adapters.series[0] = { invocationClass: "renewal_normal", workloadClass: "baseline-small", concurrency: 2 };
  let calls = 0;
  server.adapters.callback = async () => {
    if (++calls === 1) throw new Error("first callback failed");
    await new Promise((resolve) => setImmediate(resolve));
    server.events.push("slow-callback-complete");
    return { status: 200, scriptVersionId: "v" };
  };
  const result = await runRelayCpuGate({ mode: "stage2-series", adapters: server.adapters });
  assert.equal(result.status, "BLOCKED");
  assert.equal(calls, 2);
  assert.ok(server.events.includes("slow-callback-complete"));
  assert.ok(server.events.indexOf("slow-callback-complete") < server.events.indexOf("reconcile"));
  assert.equal(server.slot().kind, "idle");
});

test("cleanup of stale runner A never fences a newer singleton owner B", async () => {
  const server = fixtureServer();
  const fenced = [];
  const fence = server.adapters.setupFence;
  server.adapters.setupFence = async (input) => { fenced.push(input.requestId); return fence(input); };
  server.adapters.callback = async () => {
    server.slot().owner = { pool: "STANDARD", requestId: "new-owner-B" };
    server.slot().generation += 1;
    throw new Error("runner A lost ownership");
  };
  const result = await runRelayCpuGate({ mode: "stage2-series", adapters: server.adapters });
  assert.equal(result.status, "BLOCKED");
  assert.equal(server.slot().owner.requestId, "new-owner-B");
  assert.deepEqual(fenced, []);
});

test("partial decision failure still terminalizes every grant that was received", async () => {
  for (const failure of ["transport", "version"]) {
    let callbacks = 0;
    const terminalized = [];
    const result = await runRelayCpuGate({ adapters: {
      workerName: "worker", candidateVersionId: "v", sampleCount: 2,
      series: [{ invocationClass: "decision", workloadClass: "baseline-small", concurrency: 2 }],
      decisionContext: async () => ({ contextToken: "context" }),
      callback: async () => {
        const call = ++callbacks;
        if (call === 1 && failure === "transport") throw new Error("transport failed");
        return { status: 200, scriptVersionId: call === 1 && failure === "version" ? "wrong" : "v", grantCredential: `grant-${call}` };
      },
      terminalize: async ({ grantCredential }) => { terminalized.push(grantCredential); return { accepted: true, state: "released" }; },
      proveTerminal: async () => ({ terminal: true }),
    } });
    assert.equal(result.status, "BLOCKED");
    assert.deepEqual(terminalized.sort(), failure === "transport" ? ["grant-2"] : ["grant-1", "grant-2"]);
  }
});

test("one unconfirmed decision terminal does not skip cleanup of the other grants", async () => {
  let callbacks = 0;
  const attempts = [];
  const result = await runRelayCpuGate({ adapters: {
    workerName: "worker", candidateVersionId: "v", sampleCount: 4,
    series: [{ invocationClass: "decision", workloadClass: "baseline-small", concurrency: 2 }],
    decisionContext: async () => ({ contextToken: "context" }),
    callback: async () => ({ status: 200, scriptVersionId: "v", grantCredential: `grant-${++callbacks}` }),
    terminalize: async ({ grantCredential }) => {
      attempts.push(grantCredential);
      return grantCredential === "grant-1" ? { accepted: false } : { accepted: true, state: "released" };
    },
    proveTerminal: async () => ({ terminal: true }),
  } });
  assert.equal(result.status, "BLOCKED");
  assert.equal(callbacks, 2);
  assert.deepEqual(attempts, ["grant-1", "grant-1", "grant-1", "grant-2"]);
});

test("normal grant terminal acknowledgement is authoritative without a CPU-gate inspection route", async () => {
  const result = await runRelayCpuGate({ adapters: {
    workerName: "worker", candidateVersionId: "v", sampleCount: 1,
    series: [{ invocationClass: "decision", workloadClass: "baseline-small", concurrency: 1 }],
    decisionContext: async () => ({ contextToken: "context" }),
    callback: async () => ({ status: 200, scriptVersionId: "v", grantCredential: "grant" }),
    terminalize: async () => ({ accepted: true, state: "released" }),
  } });
  assert.equal(result.status, "PASS");
});

test("recover-operation accepts actual control adapters without a fictional recover RPC", async () => {
  const server = fixtureServer();
  await server.adapters.setup({ pool: "MINI", requestId: "pending-operation" });
  const result = await runRelayCpuGate({ mode: "recover-operation", adapters: server.adapters });
  assert.equal(result.status, "PASS");
  assert.equal(server.slot().kind, "idle");
});

test("persists the authoritative singleton generation before issuing any callback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpu-slot-journal-"));
  const journalPath = join(directory, "operations.json");
  const server = fixtureServer();
  server.adapters.sampleCount = 1;
  server.adapters.callback = async () => {
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(journal.operations[0].generation, server.slot().generation);
    assert.equal(journal.operations[0].requestId, server.slot().owner.requestId);
    return { status: 200, scriptVersionId: "v" };
  };
  try {
    const result = await runRelayCpuGate({ mode: "stage2-series", journalPath, adapters: server.adapters });
    assert.equal(result.status, "PASS");
    assert.equal(JSON.parse(await readFile(journalPath, "utf8")).operations[0].state, "closed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("configured Preview model and lifecycle preparation are used before measured callbacks", async () => {
  const events = [];
  const result = await runRelayCpuGate({ adapters: {
    workerName: "worker", candidateVersionId: "v", model: "preview-model", sampleCount: 1,
    series: [{ invocationClass: "renewal_normal", workloadClass: "baseline-small", concurrency: 1 }],
    createFixture: async () => ({ requestId: "fixture", grantCredential: "grant" }),
    prepareFixture: async () => { events.push("prepare"); },
    callback: async (input) => { assert.equal(input.model, "preview-model"); events.push("measure"); return { status: 200, scriptVersionId: "v" }; },
    terminalizeFixture: async () => ({ accepted: true, state: "released" }),
  } });
  assert.equal(result.status, "PASS");
  assert.deepEqual(events, ["prepare", "measure"]);
});

test("semantic sample success counts an expected Stage 2 403 without rewriting its HTTP status", async () => {
  const server = fixtureServer();
  server.adapters.series = [{ invocationClass: "ingress", workloadClass: "baseline-small", concurrency: 1 }];
  server.adapters.sampleCount = 1;
  server.adapters.callback = async () => ({ status: 403, scriptVersionId: "v", outcome: "model_requires_paid" });
  server.adapters.isSuccessfulSample = (response) => response.status === 403 && response.outcome === "model_requires_paid";
  const result = await runRelayCpuGate({ mode: "stage2-series", adapters: server.adapters });
  assert.equal(result.status, "PASS");
  assert.equal(result.ledger.calls.length, 1);
  assert.equal(result.ledger.calls[0].status, 403);
  assert.equal(result.ledger.calls[0].success, true);
});

test("writes source-bound per-series ledgers with measurement windows excluding preparation and cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpu-series-ledger-"));
  const ledgerPath = join(directory, "run.json");
  let tick = 100;
  const result = await runRelayCpuGate({ ledgerPath, sourceRevision: "a".repeat(40), adapters: {
    workerName: "worker", candidateVersionId: "v", sampleCount: 1, clock: () => ++tick,
    series: [{ invocationClass: "renewal_normal", workloadClass: "baseline-small", concurrency: 1 }],
    createFixture: async () => { tick += 10; return { requestId: "fixture", grantCredential: "grant" }; },
    prepareFixture: async () => { tick += 10; },
    callback: async () => { tick += 10; return { status: 200, scriptVersionId: "v" }; },
    terminalizeFixture: async () => { tick += 10; return { accepted: true, state: "released" }; },
  } });
  try {
    assert.equal(result.status, "PASS");
    const run = JSON.parse(await readFile(ledgerPath, "utf8"));
    const series = JSON.parse(await readFile(`${ledgerPath}.1.json`, "utf8"));
    assert.equal(run.series.length, 1);
    assert.equal(series.candidateSourceRevision, "a".repeat(40));
    assert.equal(series.candidateScriptVersion, "v");
    assert.equal(series.expectedSuccessfulInvocations, 1);
    assert.equal(series.calls[0].candidateSourceRevision, series.candidateSourceRevision);
    assert.equal(series.calls[0].stage, "stage1");
    const window = series.windows[0];
    assert.ok(window.windowStartMs <= series.calls[0].timestampMs);
    assert.ok(series.calls[0].timestampMs < window.windowEndMs);
    assert.ok(window.windowEndMs < tick);
    assert.equal((await stat(`${ledgerPath}.1.json`)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(run).includes('"grant"'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a stalled measurement clock still terminalizes a received decision grant before BLOCKED", async () => {
  let closed = false;
  const result = await runRelayCpuGate({ adapters: {
    workerName: "worker", candidateVersionId: "v", clock: () => 100, sampleCount: 1,
    series: [{ invocationClass: "decision", workloadClass: "baseline-small", concurrency: 1 }],
    decisionContext: async () => ({ contextToken: "context" }),
    callback: async () => ({ status: 200, scriptVersionId: "v", grantCredential: "grant" }),
    terminalize: async () => { closed = true; return { accepted: true, state: "released" }; },
  } });
  assert.equal(result.status, "BLOCKED");
  assert.equal(closed, true);
});

test("cancellation drains the current sample and closes its slot without starting another fixture", async () => {
  const controller = new AbortController();
  const server = fixtureServer();
  server.adapters.callback = async () => {
    server.events.push("callback"); controller.abort(); return { status: 200, scriptVersionId: "v" };
  };
  const result = await runRelayCpuGate({ mode: "stage2-series", adapters: server.adapters, signal: controller.signal });
  assert.equal(result.status, "BLOCKED");
  assert.equal(server.slot().kind, "idle");
  assert.deepEqual(server.events, ["setup", "callback", "reconcile", "close"]);
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
