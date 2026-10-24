import { generateCpuGateBearer, assertNoCredentialLeak } from "./relay-cpu-protection.mjs";
import { runPreviewLifecycle } from "./relay-cpu-preview.mjs";
import { createPreviewDeploymentAdapters } from "./relay-cpu-deployment.mjs";
import { createRelayCpuHttpAdapters } from "./relay-cpu-http.mjs";

export async function runStage1Provisioned(options) {
  if (!options.configPath || !options.journalPath || !options.ledgerPath || !/^[0-9a-f]{40}$/.test(options.sourceRevision ?? "")) {
    throw new TypeError("Preview config, journal, ledger and exact source revision required");
  }
  const bearer = generateCpuGateBearer();
  const env = { ...options.env, OCTG_RELAY_CPU_GATE_AUTH_TOKEN: bearer };
  const deployment = await (options.deploymentFactory ?? createPreviewDeploymentAdapters)({ ...options, env });
  let http;
  let measured;
  const outcome = await runPreviewLifecycle({ bearer, adapters: {
    ...deployment,
    preflight: async ({ versionId }) => {
      http = (options.httpFactory ?? createRelayCpuHttpAdapters)({ ...options, env, candidateVersionId: versionId });
      return http.previewPreflight();
    },
    measure: async () => {
      measured = await options.runGate({ mode: "stage1", adapters: http, journalPath: options.journalPath,
        ledgerPath: options.ledgerPath, sourceRevision: options.sourceRevision, signal: options.signal });
      if (measured.status !== "PASS") throw new Error("Preview measurement incomplete");
    },
    beforeTeardown: async () => {
      if (!http) return { closed: true }; // Preflight has not created any operation.
      const grants = await http.closeKnownGrants();
      const recovered = await options.runGate({ mode: "recover-operation", adapters: http, journalPath: options.journalPath });
      return { closed: grants.closed === true && recovered.status === "PASS" };
    },
  } });
  let clean = true;
  try {
    assertNoCredentialLeak({ credentials: [bearer, env.OCTG_RELAY_SERVICE_AUTH_TOKEN, env.OCTG_CANARY_CLIENT_KEY, env.CLOUDFLARE_API_TOKEN],
      surfaces: { deployment: deployment.outputSurfaces, ledger: measured?.ledger } });
  } catch { clean = false; }
  return { status: outcome.kind === "complete" && measured?.status === "PASS" && clean ? "PASS" : "BLOCKED",
    ...outcome, ...(measured ? { ledger: measured.ledger } : {}) };
}
