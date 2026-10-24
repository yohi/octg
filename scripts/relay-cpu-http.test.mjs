import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createRelayCpuHttpAdapters } from "./relay-cpu-http.mjs";
import { runCpuGateCli } from "./run-relay-cpu-gate.mjs";

const options = { origin: "https://preview.example", workerName: "preview", candidateVersionId: "candidate", pool: "MINI", model: "gpt-test" };
const env = { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: "control-token", OCTG_RELAY_SERVICE_AUTH_TOKEN: "service-token", OCTG_CANARY_CLIENT_KEY: "client-token" };

test("control adapters send exact Worker bodies with independent control authorization", async () => {
  const calls = [];
  const adapters = createRelayCpuHttpAdapters({ ...options, env, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ version: 1, kind: "fenced" });
  } });
  await adapters.setupFence({ requestId: "req_test", pool: "MINI", model: "must-not-be-sent" });
  await adapters.closeOperation({ pool: "MINI", requestId: "req_test", generation: 4 });
  assert.deepEqual(JSON.parse(calls[0].init.body), { version: 1, pool: "MINI", requestId: "req_test" });
  assert.deepEqual(JSON.parse(calls[1].init.body), { version: 1, pool: "MINI", requestId: "req_test", generation: 4 });
  assert.ok(calls.every(({ init }) => init.headers.Authorization === "Bearer control-token"));
  assert.ok(calls.every(({ init }) => init.headers["Cloudflare-Workers-Version-Overrides"] === 'preview="candidate"'));
  assert.ok(calls.every(({ init }) => init.redirect === "error"));
});

test("decision grant references remain in memory for authenticated terminal cleanup", async () => {
  const calls = [];
  const adapters = createRelayCpuHttpAdapters({ ...options, env, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return String(url).endsWith("decision")
      ? Response.json({ version: 1, kind: "allow", grantId: "grant-id", leaseGeneration: "lease" }, { headers: { "X-OCTG-Relay-Grant": "opaque-grant", "X-OCTG-Worker-Version": "candidate" } })
      : Response.json({ version: 1, accepted: true, state: "released", code: null }, { headers: { "X-OCTG-Worker-Version": "candidate" } });
  } });
  const response = await adapters.callback({ invocationClass: "decision", model: "gpt-test", headers: { "X-OCTG-Relay-Context": "opaque-context" }, workload: { model: "gpt-test", input: [{ role: "user", content: "Synthetic." }], stream: false } });
  assert.equal(response.grantCredential, "opaque-grant");
  assert.equal(response.scriptVersionId, "candidate");
  assert.equal((await adapters.terminalize({ grantCredential: response.grantCredential })).accepted, true);
  assert.equal((await adapters.terminalize({ grantCredential: response.grantCredential })).accepted, true);
  assert.equal(calls[0].init.headers.Authorization, "Bearer service-token");
  assert.equal(calls[1].init.headers["X-OCTG-Relay-Grant"], "opaque-grant");
  assert.deepEqual(JSON.parse(calls[1].init.body), { version: 1, grantId: "grant-id", leaseGeneration: "lease", outcome: "release", totalTokens: null });
  assert.deepEqual(JSON.parse(calls[2].init.body), JSON.parse(calls[1].init.body));
  const metadata = JSON.parse(calls[0].init.body).metadata;
  assert.equal(metadata.model, "gpt-test");
  assert.ok(metadata.estimatedInputTokens > 0);
  assert.ok(metadata.inputBytes > 0);
});

test("ingress uses only client authorization and discards the response body", async () => {
  const adapters = createRelayCpuHttpAdapters({ ...options, env, fetchImpl: async (_url, init) => {
    assert.equal(init.headers.Authorization, "Bearer client-token");
    return new Response("synthetic body", { headers: { "X-OCTG-Worker-Version": "candidate" } });
  } });
  const response = await adapters.callback({ invocationClass: "ingress", model: "gpt-test", workload: { input: "synthetic" } });
  assert.deepEqual(response, { status: 200, scriptVersionId: "candidate", outcome: "completed" });
});

test("unsafe origins, reused credentials and upstream errors fail without credential details", async () => {
  assert.throws(() => createRelayCpuHttpAdapters({ ...options, origin: "http://example", env }), /configuration/);
  assert.throws(() => createRelayCpuHttpAdapters({ ...options, env: { ...env, OCTG_RELAY_SERVICE_AUTH_TOKEN: "control-token" } }), /configuration/);
  const adapters = createRelayCpuHttpAdapters({ ...options, env, fetchImpl: async () => { throw new Error("service-token"); } });
  await assert.rejects(adapters.readSharedSlot(), (error) => !error.message.includes("service-token"));
});

test("recover-operation CLI uses real HTTP adapters and emits only safe summary fields", async () => {
  const calls = [];
  const summaries = [];
  const code = await runCpuGateCli(["recover-operation", "--execute", "--origin=https://preview.example", "--worker-name=preview", "--script-version=candidate", "--pool=MINI"], env, {
    fetchImpl: async (url) => { calls.push(String(url)); return Response.json({ version: 1, slot: { kind: "idle" } }); },
    writeSummary: (summary) => summaries.push(summary),
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith("/cpu-gate/slot"));
  assert.equal(JSON.parse(summaries[0]).status, "PASS");
  assert.equal(summaries[0].includes("control-token"), false);
});

test("CLI rejects credential arguments and requires explicit execution before HTTP calls", async () => {
  const calls = [];
  const io = { fetchImpl: async () => { calls.push("fetch"); throw new Error("unexpected"); }, writeSummary: () => {} };
  await assert.rejects(runCpuGateCli(["recover-operation", "--token=synthetic"], env, io), /Unknown/);
  assert.equal(await runCpuGateCli(["recover-operation"], env, io), 2);
  assert.deepEqual(calls, []);
});

test("Stage 2 preflight uses Cloudflare-signed context and a reject-only callback", async () => {
  const calls = [];
  const adapters = createRelayCpuHttpAdapters({ ...options, env, fetchImpl: async (url, init) => {
    calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body), headers: init.headers });
    return String(url).endsWith("decision-context")
      ? Response.json({ version: 1, requestId: JSON.parse(init.body).requestId, contextToken: "opaque-context" })
      : Response.json({ version: 1, kind: "reject", code: "model_requires_paid", status: 403 }, { headers: { "X-OCTG-Worker-Version": "candidate" } });
  } });
  const proof = await adapters.runPreflight({ runId: "run", model: "octg-cpu-gate-reject-v1" });
  assert.equal(proof.outcome, "model_requires_paid");
  assert.equal(proof.admissionCreated, false);
  assert.equal(proof.runId, "run");
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["pool", "requestId", "version"]);
  assert.equal(calls[1].body.metadata.model, "octg-cpu-gate-reject-v1");
  assert.equal(calls[1].headers["X-OCTG-Relay-Context"], "opaque-context");
});

test("Preview preflight proves auth separation, registry membership and pool before terminal cleanup", async () => {
  const calls = [];
  const adapters = createRelayCpuHttpAdapters({ ...options, env, fetchImpl: async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/v1/models") return Response.json({ data: [{ id: "gpt-test" }] });
    if (path.endsWith("decision-context")) {
      if (init.headers.Authorization !== "Bearer control-token") return new Response(null, { status: 401 });
      return Response.json({ version: 1, requestId: JSON.parse(init.body).requestId, contextToken: "opaque-context" });
    }
    if (path.endsWith("decision")) return Response.json({ version: 1, kind: "allow", grantId: "g", leaseGeneration: "lease", quota: { pool: "MINI" } }, {
      headers: { "X-OCTG-Relay-Grant": "opaque-grant", "X-OCTG-Worker-Version": "candidate" },
    });
    return Response.json({ version: 1, accepted: true, state: "released" }, { headers: { "X-OCTG-Worker-Version": "candidate" } });
  } });
  assert.deepEqual(await adapters.previewPreflight(), { ready: true });
  assert.equal(calls.filter((path) => path.endsWith("decision-context")).length, 4);
  assert.equal(calls.at(-1), "/internal/relay/v1/terminal");
});

test("Preview disabled control returns BLOCKED before any normal decision or measurement", async () => {
  const paths = [];
  const adapters = createRelayCpuHttpAdapters({ ...options, env, fetchImpl: async (url) => {
    paths.push(new URL(url).pathname);
    return new Response(null, { status: 404 });
  } });
  await assert.rejects(adapters.previewPreflight());
  assert.equal(paths.some((path) => path.endsWith("/decision")), false);
});

test("lifecycle preparation activates renewal/replay fixtures outside measured callbacks", async () => {
  const paths = [];
  const adapters = createRelayCpuHttpAdapters({ ...options, env, fetchImpl: async (url, init) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path.endsWith("setup")) return Response.json({ version: 1, pool: "MINI", requestId: JSON.parse(init.body).requestId, grantToken: "grant", grantId: "g", leaseGeneration: "lease", admissionUtcDay: "2026-10-24" });
    return Response.json({ version: 1, activated: true, code: null }, { headers: { "X-OCTG-Worker-Version": "candidate" } });
  } });
  const fixture = await adapters.setup({ requestId: "req_fixture" });
  await adapters.prepareFixture({ fixture: { ...fixture, grantCredential: fixture.grantToken }, invocationClass: "renewal_normal" });
  assert.equal(paths.at(-1), "/internal/relay/v1/activation");
});

test("Stage 2 ingress recognizes the exact paid-model rejection as a successful gate sample", async () => {
  const adapters = createRelayCpuHttpAdapters({ ...options, env, fetchImpl: async () => Response.json({ error: { code: "model_requires_paid" } }, {
    status: 403, headers: { "X-OCTG-Worker-Version": "candidate" },
  }) });
  const response = await adapters.callback({ invocationClass: "ingress", model: "octg-cpu-gate-reject-v1", workload: { input: "synthetic" } });
  assert.equal(adapters.isSuccessfulSample(response, { invocationClass: "ingress" }, "stage2-series"), true);
  assert.equal(response.status, 403);
  assert.equal(response.outcome, "model_requires_paid");
});

test("normal and replay terminal preparation activates then settles zero tokens", async () => {
  for (const invocationClass of ["terminal_normal", "terminal_replay"]) {
    const events = [];
    const adapters = createRelayCpuHttpAdapters({ ...options, env, fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(init.body);
      if (path.endsWith("setup")) return Response.json({ version: 1, pool: "MINI", requestId: body.requestId,
        grantToken: "grant", grantId: "g", leaseGeneration: "lease", admissionUtcDay: "2026-10-24" });
      events.push(path.split("/").at(-1));
      if (path.endsWith("activation")) return Response.json({ activated: true }, { headers: { "X-OCTG-Worker-Version": "candidate" } });
      assert.equal(body.outcome, "settle");
      assert.equal(body.totalTokens, 0);
      return Response.json({ accepted: true, state: "settled" }, { headers: { "X-OCTG-Worker-Version": "candidate" } });
    } });
    const created = await adapters.setup({ requestId: "fixture" });
    const fixture = { ...created, grantCredential: created.grantToken };
    await adapters.prepareFixture({ fixture, invocationClass });
    assert.deepEqual(events, invocationClass === "terminal_replay" ? ["activation", "terminal"] : ["activation"]);
    const terminal = await adapters.callback({ invocationClass: "terminal", grantCredential: fixture.grantCredential });
    assert.equal(terminal.state, "settled");
  }
});
