import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createPreviewDeploymentAdapters } from "./relay-cpu-deployment.mjs";

const candidate = "11111111-1111-4111-8111-111111111111";
const hardening = "22222222-2222-4222-8222-222222222222";
const baseline = "33333333-3333-4333-8333-333333333333";
const bindings = ["QuotaController", "RelayDecisionController", "TokenizerController"].map((class_name) => ({ type: "durable_object_namespace", name: class_name, class_name }));
const previewRelaySecrets = ["OCTG_KEY_PEPPER", "OCTG_UPSTREAM_API_TOKEN", "DENO_TOKENIZER_AUTH_TOKEN",
  "OCTG_RELAY_SERVICE_AUTH_TOKEN", "OCTG_RELAY_INGRESS_AUTH_TOKEN", "OCTG_RELAY_CONTEXT_HMAC_KEY"]
  .map((name) => ({ type: "secret_text", name }));
const config = { name: "gateway-preview", vars: { OCTG_RELAY_ENABLED: "true", OCTG_RELAY_ENVIRONMENT: "preview", OCTG_RELAY_INGRESS_ENDPOINT: "https://relay-preview.example" },
  d1_databases: [{ binding: "DB", database_id: "preview-db" }], durable_objects: { bindings: bindings.map(({ name, class_name }) => ({ name, class_name })) } };
const productionConfig = { name: "gateway", vars: { OCTG_RELAY_INGRESS_ENDPOINT: "https://relay.example" }, d1_databases: [{ database_id: "production-db" }] };

test("Preview deployment uses exact version commands and verifies deletion-produced binding metadata", async () => {
  const calls = [];
  let deployed = baseline;
  const adapters = await createPreviewDeploymentAdapters({ config, productionConfig, configPath: "preview.json", workerName: "gateway-preview", origin: "https://preview.example",
    env: { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: "synthetic-gate" },
    commandImpl: async (args) => {
      calls.push(args);
      if (args[0] === "deployments") return { stdout: JSON.stringify([{ versions: [{ version_id: deployed, percentage: 100 }] }]), stderr: "" };
      if (args[1] === "view") return { stdout: JSON.stringify({ id: args[2], resources: { bindings: args[2] === candidate
        ? [...bindings, ...previewRelaySecrets, { type: "secret_text", name: "OCTG_RELAY_CPU_GATE_AUTH_TOKEN" }]
        : [...bindings, ...previewRelaySecrets] } }), stderr: "" };
      if (args[1] === "upload") return { stdout: `Worker Version ID: ${candidate}`, stderr: "" };
      if (args[1] === "secret") return { stdout: `Success! Created version ${hardening} with deleted secret OCTG_RELAY_CPU_GATE_AUTH_TOKEN.`, stderr: "" };
      if (args[1] === "deploy") { deployed = args[2].split("@")[0]; return { stdout: "deployed", stderr: "" }; }
      throw new Error("Unexpected command");
    }, fetchImpl: async (_url, init) => {
      assert.equal(init.headers["Cloudflare-Workers-Version-Overrides"], `gateway-preview="${hardening}"`);
      return new Response(null, { status: 404, headers: { "X-OCTG-Worker-Version": hardening } });
    },
  });
  assert.equal((await adapters.uploadCandidate({ secretsPath: "protected/secrets.json" })).versionId, candidate);
  await adapters.deployCandidate({ versionId: candidate });
  assert.equal((await adapters.observeCandidate({ versionId: candidate })).observed, true);
  assert.equal((await adapters.deleteVersionSecret({ secretName: "OCTG_RELAY_CPU_GATE_AUTH_TOKEN" })).versionId, hardening);
  await adapters.setTraffic({ versionId: hardening, percent: 100 });
  assert.deepEqual(await adapters.verifyMetadata({ versionId: hardening, candidateVersionId: candidate }), { secretAbsent: true, bindingsUnchanged: true, deployedPercent: 100 });
  assert.equal((await adapters.verifyExactVersion({ versionId: hardening })).status, 404);
  const upload = calls.find((args) => args[1] === "upload");
  assert.ok(upload.includes("--strict"));
  assert.equal(upload[upload.indexOf("--secrets-file") + 1], "protected/secrets.json");
  assert.equal(JSON.stringify(calls).includes("synthetic-gate"), false);
  assert.deepEqual(previewRelaySecrets.map((binding) => binding.name), [
    "OCTG_KEY_PEPPER",
    "OCTG_UPSTREAM_API_TOKEN",
    "DENO_TOKENIZER_AUTH_TOKEN",
    "OCTG_RELAY_SERVICE_AUTH_TOKEN",
    "OCTG_RELAY_INGRESS_AUTH_TOKEN",
    "OCTG_RELAY_CONTEXT_HMAC_KEY",
  ]);
});

test("Preview candidate upload stops before mutation when a persistent Worker secret is missing", async () => {
  const calls = [];
  const incompleteBindings = [...bindings, ...previewRelaySecrets.filter((binding) => binding.name !== "OCTG_UPSTREAM_API_TOKEN")];
  const adapters = await createPreviewDeploymentAdapters({
    config,
    productionConfig,
    configPath: "preview.json",
    workerName: "gateway-preview",
    origin: "https://preview.example",
    env: { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: "synthetic-gate" },
    commandImpl: async (args) => {
      calls.push(args);
      if (args[0] === "deployments") return { stdout: JSON.stringify([{ versions: [{ version_id: baseline, percentage: 100 }] }]), stderr: "" };
      if (args[1] === "view") return { stdout: JSON.stringify({ id: baseline, resources: { bindings: incompleteBindings } }), stderr: "" };
      assert.fail("candidate upload must not run without persistent Preview Worker secrets");
    },
  });

  await assert.rejects(adapters.uploadCandidate({ secretsPath: "protected/secrets.json" }), /Preview secret prerequisite missing/);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [["deployments", "list"], ["versions", "view"]]);
});

test("secretless verification detects a persistent Preview relay secret binding loss", async () => {
  const adapters = await createPreviewDeploymentAdapters({
    config,
    productionConfig,
    configPath: "preview.json",
    workerName: "gateway-preview",
    origin: "https://preview.example",
    env: { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: "synthetic-gate" },
    commandImpl: async (args) => {
      if (args[0] === "deployments") {
        return { stdout: JSON.stringify([{ versions: [{ version_id: hardening, percentage: 100 }] }]), stderr: "" };
      }
      if (args[1] === "view") {
        const persistent = args[2] === candidate
          ? previewRelaySecrets
          : previewRelaySecrets.filter((binding) => binding.name !== "OCTG_RELAY_CONTEXT_HMAC_KEY");
        return { stdout: JSON.stringify({ id: args[2], resources: { bindings: [...bindings, ...persistent] } }), stderr: "" };
      }
      assert.fail("metadata verification must not mutate Preview resources");
    },
  });

  assert.deepEqual(await adapters.verifyMetadata({ versionId: hardening, candidateVersionId: candidate }), {
    secretAbsent: true,
    bindingsUnchanged: false,
    deployedPercent: 100,
  });
});

test("Production reuse or secret-bearing config fails before running any command", async () => {
  for (const unsafe of [{ ...config, name: productionConfig.name }, { ...config, d1_databases: productionConfig.d1_databases },
    { ...config, vars: { ...config.vars, OCTG_RELAY_SERVICE_AUTH_TOKEN: "sentinel" } },
    { ...config, vars: { ...config.vars, OCTG_RELAY_ENABLED: "false" } },
    { ...config, vars: { ...config.vars, OCTG_RELAY_INGRESS_ENDPOINT: "HTTPS://RELAY.EXAMPLE:443/relay/v1/responses" } }]) {
    await assert.rejects(createPreviewDeploymentAdapters({ config: unsafe, productionConfig, configPath: "preview.json", workerName: unsafe.name,
      origin: "https://preview.example", commandImpl: async () => { assert.fail("unsafe config must not execute"); }, env: {} }), /isolation/);
  }
});

test("redacts Preview ingress and context credentials from Wrangler output", async () => {
  const ingressSecret = "synthetic-preview-ingress-token";
  const hmacSecret = "synthetic-preview-context-key";
  const adapters = await createPreviewDeploymentAdapters({
    config,
    productionConfig,
    configPath: "preview.json",
    workerName: "gateway-preview",
    origin: "https://preview.example",
    env: { OCTG_RELAY_INGRESS_AUTH_TOKEN: ingressSecret, OCTG_RELAY_CONTEXT_HMAC_KEY: hmacSecret },
    commandImpl: async () => ({ stdout: JSON.stringify({
      deployments: [{ versions: [{ version_id: baseline, percentage: 100 }] }],
      diagnostic: `${ingressSecret} ${hmacSecret}`,
    }), stderr: "" }),
  });
  await assert.rejects(adapters.uploadCandidate({ secretsPath: "protected/secrets.json" }), /credential leak detected/);
});
