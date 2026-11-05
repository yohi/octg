import { createRelayCpuHttpAdapters } from "./relay-cpu-http.mjs";
import { runStage1Provisioned } from "./relay-cpu-stage1.mjs";
import { evaluateCapacityPreflight } from "./relay-cpu-capacity.mjs";

export async function executeCpuGateCli(argv, env, io) {
  const [mode = "stage1", ...options] = argv;
  const writeSummary = io.writeSummary ?? console.log;
  if (mode === "--help" || mode === "help") {
    writeSummary("gate:relay-cpu <stage1|stage2-preflight|stage2-series|recover-operation> --execute --origin=<https-origin> --worker-name=<name> --pool=<STANDARD|MINI> --journal=<path> --ledger=<path> --source-revision=<sha> --capacity-evidence=<path> --execution-target=<path> [--preview-config=<path> --model=<model>] [--script-version=<id>]");
    return 0;
  }
  if (!["stage1", "stage2-preflight", "stage2-series", "recover-operation"].includes(mode)) throw new TypeError("Unknown CPU-gate mode");
  const allowed = new Set(["--execute", "--origin", "--worker-name", "--script-version", "--pool", "--model", "--journal", "--ledger", "--source-revision", "--preview-config", "--capacity-evidence", "--execution-target"]);
  const pairs = {};
  for (const option of options) {
    const [key, ...parts] = option.split("=");
    if (!allowed.has(key) || key in pairs) throw new TypeError("Unknown or duplicate CPU-gate argument");
    if (key === "--execute" && parts.length > 0) throw new TypeError("Execution requires the bare --execute flag");
    pairs[key] = parts.join("=");
  }
  if (!("--execute" in pairs)) { writeSummary(JSON.stringify({ status: "BLOCKED", reason: "explicit execution required" })); return 2; }
  const isMeasuredMode = mode !== "recover-operation";
  const environment = mode === "stage1" ? "preview" : "production";
  const isValidSourceRevision = (sha) => typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha);
  if (isMeasuredMode) {
    if (!isValidSourceRevision(pairs["--source-revision"])) {
      throw new TypeError("Measurement requires exact source revision");
    }
    if (!pairs["--capacity-evidence"] || !pairs["--execution-target"]) {
      writeSummary(JSON.stringify({ status: "PREFLIGHT_HOLD", reasons: ["MISSING_CAPACITY_EVIDENCE", "MISSING_EXECUTION_TARGET"] }));
      return 2;
    }
  }
  if (mode === "stage2-series" && (!pairs["--journal"] || !pairs["--ledger"] || !isValidSourceRevision(pairs["--source-revision"]))) {
    throw new TypeError("Measurement requires journal, ledger and exact source revision");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  try {
    if (isMeasuredMode) {
      if (io.resolveVerifiedExecutionTarget === undefined) {
        writeSummary(JSON.stringify({ status: "PREFLIGHT_HOLD", reasons: ["UNVERIFIED_EXECUTION_TARGET"] }));
        return 2;
      }
      const verified = await io.resolveVerifiedExecutionTarget({
        mode, sourceRevision: pairs["--source-revision"], workerName: pairs["--worker-name"],
        scriptVersionId: pairs["--script-version"], environment, targetPath: pairs["--execution-target"],
        capacityEvidencePath: pairs["--capacity-evidence"],
      });
      if (verified === undefined) {
        writeSummary(JSON.stringify({ status: "PREFLIGHT_HOLD", reasons: ["UNVERIFIED_EXECUTION_TARGET"] }));
        return 2;
      }
      const nowUTC = typeof io.nowUTC === "function" ? io.nowUTC() : new Date().toISOString();
      const preflight = evaluateCapacityPreflight(verified.capacityEvidence, verified.target, nowUTC);
      if (preflight.status !== "PREFLIGHT_PASS") {
        writeSummary(JSON.stringify({ status: "PREFLIGHT_HOLD", reasons: preflight.reasons }));
        return 2;
      }
    }
    if (mode === "stage1") {
      const result = await runStage1Provisioned({ env, origin: pairs["--origin"], workerName: pairs["--worker-name"],
        pool: pairs["--pool"], model: pairs["--model"], journalPath: pairs["--journal"], ledgerPath: pairs["--ledger"],
        sourceRevision: pairs["--source-revision"], configPath: pairs["--preview-config"], executeRemote: true,
        fetchImpl: io.fetchImpl, commandImpl: io.commandImpl, runGate: io.runGate, signal: controller.signal,
        deploymentFactory: io.deploymentFactory, httpFactory: io.httpFactory });
      writeSummary(JSON.stringify({ status: result.status, cleanupVerified: result.cleanupVerified,
        versionId: result.versionId, secretlessVersion: result.secretlessVersion, callCount: result.ledger?.calls.length ?? 0 }));
      return result.status === "PASS" ? 0 : 2;
    }
    const adapters = createRelayCpuHttpAdapters({ origin: pairs["--origin"], workerName: pairs["--worker-name"],
      candidateVersionId: pairs["--script-version"], pool: pairs["--pool"], model: pairs["--model"], env, fetchImpl: io.fetchImpl });
    const result = await io.runGate({ mode, journalPath: pairs["--journal"], ledgerPath: pairs["--ledger"],
      sourceRevision: pairs["--source-revision"], signal: controller.signal, adapters });
    writeSummary(JSON.stringify({ status: result.status, runId: result.ledger.runId, callCount: result.ledger.calls.length }));
    return result.status === "PASS" ? 0 : 2;
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}
