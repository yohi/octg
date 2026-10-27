import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createRelayCpuHttpAdapters } from "./relay-cpu-http.mjs";
import { runRelayCpuGate } from "./run-relay-cpu-gate.mjs";
import { requiredSeriesMatrix } from "./relay-cpu-workloads.mjs";

function fixtureWorker(mode) {
  const grants = new Map();
  let slot = { kind: "idle" };
  let generation = 0;
  let setupCount = 0;
  function inspect(grant) {
    return { kind: "fixture", cpuGateFixture: true, state: grant.state, requestState: grant.active ? "reserved" : grant.state === "settled" ? "settled" : "released",
      reservedTokens: 0, upperBoundTokens: 0, maxOutputTokens: 0, actualTokens: null, activeLease: grant.active };
  }
  function json(body, status = 200, headers = {}) {
    return Response.json(body, { status, headers: { "X-OCTG-Worker-Version": "candidate", ...headers } });
  }
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    assert.equal(init.headers["Cloudflare-Workers-Version-Overrides"], 'worker="candidate"');
    if (path.endsWith("/slot")) return json({ version: 1, slot });
    const body = JSON.parse(init.body);
    if (path.includes("/cpu-gate/")) {
      assert.equal(init.headers.Authorization, "Bearer control");
      const action = path.split("/").at(-1);
      assert.deepEqual(Object.keys(body).sort(), action === "close-operation" ? ["generation", "pool", "requestId", "version"] : ["pool", "requestId", "version"]);
      const grant = grants.get(body.requestId);
      switch (action) {
        case "decision-context": return json({ version: 1, requestId: body.requestId, contextToken: `context:${body.requestId}` });
        case "setup": {
          assert.equal(slot.kind, "idle");
          assert.equal(grant, undefined);
          setupCount += 1;
          const created = { requestId: body.requestId, state: "authorized", active: true, grantId: body.requestId, leaseGeneration: "lease" };
          grants.set(body.requestId, created);
          if (mode === "stage2-series") slot = { kind: "held", owner: { pool: body.pool, requestId: body.requestId }, generation: ++generation };
          return json({ version: 1, requestId: body.requestId, pool: body.pool, grantToken: `grant:${body.requestId}`,
            grantId: created.grantId, leaseGeneration: created.leaseGeneration, admissionUtcDay: "2026-10-24" });
        }
        case "setup-fence": return json({ version: 1, requestId: body.requestId, kind: grant ? "fixture" : "fenced", ...(grant ? { inspection: inspect(grant) } : {}) });
        case "operation-inspection": return grant ? json({ version: 1, kind: "fixture", inspection: inspect(grant) }) : json({ version: 1, kind: "absent" }, 404);
        case "reconcile-unused": {
          assert.ok(grant); grant.state = "reconciled_unused"; grant.active = false;
          return json({ version: 1, kind: "reconciled_unused" });
        }
        case "close-operation": {
          assert.equal(slot.owner.requestId, body.requestId);
          assert.equal(slot.owner.pool, body.pool);
          assert.equal(slot.generation, body.generation);
          assert.equal(grant.active, false);
          slot = { kind: "idle" };
          return json({ version: 1, kind: "closed" });
        }
        default: assert.fail("Unknown control action");
      }
    }
    if (path === "/v1/responses") {
      assert.equal(body.model, mode === "stage2-series" ? "octg-cpu-gate-reject-v1" : "gpt-test");
      assert.equal(init.headers.Authorization, "Bearer client");
      return mode === "stage2-series" ? json({ error: { code: "model_requires_paid" } }, 403) : json({ output: [] });
    }
    assert.equal(init.headers.Authorization, "Bearer service");
    if (path.endsWith("/decision")) {
      assert.equal(body.metadata.model, mode === "stage2-series" ? "octg-cpu-gate-reject-v1" : "gpt-test");
      const context = init.headers["X-OCTG-Relay-Context"];
      assert.ok(context.startsWith("context:"));
      if (mode === "stage2-series") return json({ version: 1, kind: "reject", code: "model_requires_paid", status: 403 });
      const requestId = context.slice("context:".length);
      assert.equal(grants.has(requestId), false, "each decision must have a fresh request identity");
      grants.set(requestId, { requestId, state: "authorized", active: true, grantId: requestId, leaseGeneration: "lease" });
      return json({ version: 1, kind: "allow", grantId: requestId, leaseGeneration: "lease" }, 200,
        { "X-OCTG-Relay-Grant": `grant:${requestId}` });
    }
    const grant = grants.get(body.grantId);
    assert.ok(grant);
    assert.equal(init.headers["X-OCTG-Relay-Grant"], `grant:${body.grantId}`);
    assert.equal(body.leaseGeneration, "lease");
    if (path.endsWith("/activation")) {
      const activated = grant.state === "authorized";
      if (activated) grant.state = "attempted";
      return json({ version: 1, activated, code: activated ? null : "grant_replayed" });
    }
    if (path.endsWith("/renewal")) {
      assert.equal(grant.state, "attempted", "renewal must have an activated fixture");
      return json({ version: 1, renewed: true, code: null });
    }
    assert.ok(path.endsWith("/terminal"));
    assert.deepEqual(Object.keys(body).sort(), ["grantId", "leaseGeneration", "outcome", "totalTokens", "version"]);
    const activated = ["attempted", "settled"].includes(grant.state);
    assert.equal(body.outcome, activated ? "settle" : "release");
    assert.equal(body.totalTokens, activated ? 0 : null);
    grant.active = false; grant.state = activated ? "settled" : "released";
    return json({ version: 1, accepted: true, state: grant.state, code: null });
  };
  return { fetchImpl, slot: () => slot, grants, setupCount: () => setupCount };
}

for (const mode of ["stage1", "stage2-series"]) {
for (const identity of requiredSeriesMatrix()) {
  test(`real HTTP adapters execute ${mode}/${identity.invocationClass}/${identity.workloadClass}/${identity.concurrency} without leaving a fixture`, async () => {
    const worker = fixtureWorker(mode);
    const adapters = createRelayCpuHttpAdapters({ origin: "https://preview.example", workerName: "worker", candidateVersionId: "candidate", pool: "MINI", model: "gpt-test",
      env: { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: "control", OCTG_RELAY_SERVICE_AUTH_TOKEN: "service", OCTG_CANARY_CLIENT_KEY: "client" }, fetchImpl: worker.fetchImpl });
    const result = await runRelayCpuGate({ mode, adapters: { ...adapters, sampleCount: 3, series: [identity] } });
    assert.equal(result.status, "PASS");
    assert.equal(result.ledger.calls.length, 3);
    assert.ok(result.ledger.calls.every((call) => call.success));
    assert.equal(worker.slot().kind, "idle");
    assert.ok([...worker.grants.values()].every((grant) => grant.active === false));
    assert.equal(worker.setupCount(), ["ingress", "decision"].includes(identity.invocationClass) ? 0
      : identity.invocationClass.endsWith("_replay") || identity.invocationClass === "renewal_normal" ? 1 : 3);
  });
}
}
