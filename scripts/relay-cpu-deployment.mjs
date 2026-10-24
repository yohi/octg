import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { assertNoCredentialLeak } from "./relay-cpu-protection.mjs";

const SECRET = "OCTG_RELAY_CPU_GATE_AUTH_TOKEN";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROUTES = ["quota", "slot", "setup", "setup-fence", "decision-context", "operation-inspection", "reconcile-unused", "close-operation"];

async function readConfig(path) {
  const result = ts.parseConfigFileTextToJson(path, await readFile(path, "utf8"));
  if (result.error || !result.config) throw new Error("Preview config unavailable");
  return result.config;
}

function validateIsolation(config, production, name) {
  const database = config.d1_databases?.find((entry) => entry.binding === "DB");
  const productionIds = new Set((production.d1_databases ?? []).map((entry) => entry.database_id));
  const dos = config.durable_objects?.bindings;
  let relay;
  let productionRelay;
  try {
    relay = new URL(config.vars?.OCTG_RELAY_INGRESS_ENDPOINT);
    productionRelay = production.vars?.OCTG_RELAY_INGRESS_ENDPOINT ? new URL(production.vars.OCTG_RELAY_INGRESS_ENDPOINT) : undefined;
  } catch { throw new Error("Preview resource isolation not proven"); }
  if (!name || config.name !== name || config.name === production.name || config.vars?.OCTG_RELAY_ENVIRONMENT !== "preview"
    || !database?.database_id || productionIds.has(database.database_id) || !Array.isArray(dos) || dos.length === 0
    || dos.some((entry) => entry.namespace_id || entry.script_name || !entry.class_name)
    || relay.protocol !== "https:" || relay.username || relay.password || relay.href === productionRelay?.href
    || Object.keys(config.vars).some((key) => /(?:AUTH_TOKEN|HMAC_KEY|KEY_PEPPER|API_KEY|API_TOKEN)$/.test(key))) {
    throw new Error("Preview resource isolation not proven");
  }
}

function stableBindings(bindings) {
  return JSON.stringify(bindings.filter((binding) => binding.name !== SECRET).map((binding) =>
    Object.fromEntries(Object.entries(binding).sort(([a], [b]) => a.localeCompare(b))))
    .sort((a, b) => String(a.name).localeCompare(String(b.name))));
}

export async function createPreviewDeploymentAdapters(options) {
  const { configPath, workerName, env = process.env, fetchImpl = fetch } = options;
  const config = options.config ?? await readConfig(configPath);
  const production = options.productionConfig ?? await readConfig(fileURLToPath(new URL("../apps/gateway-worker/wrangler.jsonc", import.meta.url)));
  validateIsolation(config, production, workerName);
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Invalid Preview origin");
  const credentials = [env.OCTG_RELAY_CPU_GATE_AUTH_TOKEN, env.OCTG_RELAY_SERVICE_AUTH_TOKEN, env.CLOUDFLARE_API_TOKEN, env.OCTG_CANARY_CLIENT_KEY].filter(Boolean);
  const outputSurfaces = { config, commands: [], stdout: [], stderr: [] };
  const execute = options.commandImpl ?? (async (args) => {
    if (options.executeRemote !== true) throw new Error("Explicit deployment execution required");
    const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
    const result = spawnSync(process.execPath, [wrangler, ...args], { shell: false, encoding: "utf8", timeout: 120_000, maxBuffer: 4_194_304,
      env: { ...env, CI: "true", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
    if (result.error || result.status !== 0) throw new Error("Preview Wrangler command failed");
    return { stdout: result.stdout, stderr: result.stderr };
  });
  async function command(args) {
    const full = [...args, "--config", configPath];
    outputSurfaces.commands.push(full);
    assertNoCredentialLeak({ credentials, surfaces: outputSurfaces });
    const result = await execute(full);
    outputSurfaces.stdout.push(result.stdout ?? ""); outputSurfaces.stderr.push(result.stderr ?? "");
    assertNoCredentialLeak({ credentials, surfaces: outputSurfaces });
    return result.stdout ?? "";
  }
  async function version(id) {
    if (!new RegExp(`^${UUID}$`).test(id)) throw new Error("Invalid Preview version ID");
    const metadata = JSON.parse(await command(["versions", "view", id, "--json"]));
    if (metadata.id !== id || !Array.isArray(metadata.resources?.bindings)) throw new Error("Preview version metadata unavailable");
    return metadata;
  }
  async function deployedVersions() {
    const deployments = JSON.parse(await command(["deployments", "list", "--json"]));
    if (!Array.isArray(deployments) || !Array.isArray(deployments[0]?.versions)) throw new Error("Preview deployment metadata unavailable");
    return deployments[0].versions;
  }
  const percentage = (versions, id) => versions.length === 1 && versions[0].version_id === id ? versions[0].percentage : 0;
  return {
    outputSurfaces,
    uploadCandidate: async ({ secretsPath }) => {
      // Upload cannot introduce a migration. The already-deployed version must
      // expose every class requested by the isolated generated config.
      const deployed = await deployedVersions();
      const previous = await version(deployed[0]?.version_id);
      for (const binding of config.durable_objects.bindings) {
        if (!previous.resources.bindings.some((entry) => entry.type === "durable_object_namespace" && entry.class_name === binding.class_name)) throw new Error("Preview migration prerequisite missing");
      }
      const stdout = await command(["versions", "upload", "--strict", "--secrets-file", secretsPath]);
      const id = stdout.match(new RegExp(`Worker Version ID:\\s*(${UUID})`))?.[1];
      if (!id) throw new Error("Preview upload version ID unavailable");
      return { versionId: id };
    },
    deployCandidate: async ({ versionId }) => { await command(["versions", "deploy", `${versionId}@100%`, "--yes"]); },
    observeCandidate: async ({ versionId }) => ({ observed: percentage(await deployedVersions(), versionId) === 100 }),
    deleteVersionSecret: async ({ secretName }) => {
      if (secretName !== SECRET) throw new Error("Unexpected secret deletion");
      const stdout = await command(["versions", "secret", "delete", SECRET]);
      const id = stdout.match(new RegExp(`Created version (${UUID}) with deleted secret ${SECRET}`))?.[1];
      if (!id) throw new Error("Preview deletion version ID unavailable");
      return { versionId: id };
    },
    setTraffic: async ({ versionId, percent }) => {
      if (percent !== 100) throw new Error("Preview deployment requires 100 percent");
      await command(["versions", "deploy", `${versionId}@100%`, "--yes"]);
    },
    verifyMetadata: async ({ versionId, candidateVersionId }) => {
      const [after, before, deployed] = await Promise.all([version(versionId), version(candidateVersionId), deployedVersions()]);
      return { secretAbsent: !after.resources.bindings.some((entry) => entry.name === SECRET),
        bindingsUnchanged: stableBindings(before.resources.bindings) === stableBindings(after.resources.bindings), deployedPercent: percentage(deployed, versionId) };
    },
    verifyExactVersion: async ({ versionId }) => {
      for (const route of ROUTES) {
        const response = await fetchImpl(new URL(`/internal/relay/v1/cpu-gate/${route}`, origin), {
          method: ["quota", "slot"].includes(route) ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
          headers: { Authorization: `Bearer ${env[SECRET]}`, "Cloudflare-Workers-Version-Overrides": `${workerName}="${versionId}"` },
        });
        await response.body?.cancel();
        if (response.status !== 404 || response.headers.get("X-OCTG-Worker-Version") !== versionId) return { status: 503 };
      }
      return { status: 404 };
    },
  };
}
