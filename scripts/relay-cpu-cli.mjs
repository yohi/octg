import { createRelayCpuHttpAdapters } from "./relay-cpu-http.mjs";
import { runStage1Provisioned } from "./relay-cpu-stage1.mjs";
import { evaluateCapacityPreflight } from "./relay-cpu-capacity.mjs";

const VALID_MODES = ["stage1", "stage2-preflight", "stage2-series", "recover-operation"];
const ALLOWED_OPTIONS = ["--execute", "--origin", "--worker-name", "--script-version", "--pool", "--model", "--journal", "--ledger", "--source-revision", "--preview-config", "--capacity-evidence", "--execution-target"];

function parseOptions(options) {
  const pairs = {};
  const allowed = new Set(ALLOWED_OPTIONS);
  for (const option of options) {
    const [key, ...parts] = option.split("=");
    if (!allowed.has(key) || key in pairs) throw new TypeError("Unknown or duplicate CPU-gate argument");
    if (key === "--execute" && parts.length > 0) throw new TypeError("Execution requires the bare --execute flag");
    pairs[key] = parts.join("=");
  }
  return pairs;
}

function validateMeasuredMode(mode, pairs, writeSummary) {
  const validRevision = typeof pairs["--source-revision"] === "string" && /^[0-9a-f]{40}$/.test(pairs["--source-revision"]);
  if (mode !== "recover-operation" && !validRevision) throw new TypeError("Measurement requires exact source revision");
  if (mode !== "recover-operation" && (!pairs["--capacity-evidence"] || !pairs["--execution-target"])) {
    writeSummary(JSON.stringify({ status: "PREFLIGHT_HOLD", reasons: ["MISSING_CAPACITY_EVIDENCE", "MISSING_EXECUTION_TARGET"] }));
    return false;
  }
  if (mode === "stage2-series" && (!pairs["--journal"] || !pairs["--ledger"])) {
    throw new TypeError("Measurement requires journal, ledger and exact source revision");
  }
  return true;
}

async function verifyCapacity(mode, pairs, environment, io, writeSummary) {
  if (mode === "recover-operation") return true;
  if (io.resolveVerifiedExecutionTarget === undefined) {
    writeSummary(JSON.stringify({ status: "PREFLIGHT_HOLD", reasons: ["UNVERIFIED_EXECUTION_TARGET"] }));
    return false;
  }
  const verified = await io.resolveVerifiedExecutionTarget({
    mode, sourceRevision: pairs["--source-revision"], workerName: pairs["--worker-name"],
    scriptVersionId: pairs["--script-version"], environment, targetPath: pairs["--execution-target"],
    capacityEvidencePath: pairs["--capacity-evidence"],
  });
  if (verified === undefined) {
    writeSummary(JSON.stringify({ status: "PREFLIGHT_HOLD", reasons: ["UNVERIFIED_EXECUTION_TARGET"] }));
    return false;
  }
  const nowUTC = typeof io.nowUTC === "function" ? io.nowUTC() : new Date().toISOString();
  const preflight = evaluateCapacityPreflight(verified.capacityEvidence, verified.target, nowUTC);
  if (preflight.status === "PREFLIGHT_PASS") return true;
  writeSummary(JSON.stringify({ status: "PREFLIGHT_HOLD", reasons: preflight.reasons }));
  return false;
}

export async function executeCpuGateCli(argv, env, io) {
  const [mode = "stage1", ...options] = argv;
  const writeSummary = io.writeSummary ?? console.log;
  if (mode === "--help" || mode === "help") {
    writeSummary("gate:relay-cpu <stage1|stage2-preflight|stage2-series|recover-operation> --execute --origin=<https-origin> --worker-name=<name> --pool=<STANDARD|MINI> --journal=<path> --ledger=<path> --source-revision=<sha> --capacity-evidence=<path> --execution-target=<path> [--preview-config=<path> --model=<model>] [--script-version=<id>]");
    return 0;
  }
  if (!VALID_MODES.includes(mode)) throw new TypeError("Unknown CPU-gate mode");
  const pairs = parseOptions(options);
  if (!("--execute" in pairs)) { writeSummary(JSON.stringify({ status: "BLOCKED", reason: "explicit execution required" })); return 2; }
  const environment = mode === "stage1" ? "preview" : "production";
  if (!validateMeasuredMode(mode, pairs, writeSummary)) return 2;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  try {
    if (!await verifyCapacity(mode, pairs, environment, io, writeSummary)) return 2;
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
