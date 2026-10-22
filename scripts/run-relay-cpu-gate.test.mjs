import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runRelayCpuGate, generateCpuGateBearer, withPreviewSecretsFile } from "./run-relay-cpu-gate.mjs";

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
