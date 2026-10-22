import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildWorkload, requiredSeriesMatrix } from "./relay-cpu-workloads.mjs";

const CPU_GATE_PATH = "/internal/relay/v1/cpu-gate";
const CALLBACK_PATHS = Object.freeze(["/internal/relay/v1/decision", "/internal/relay/v1/activation", "/internal/relay/v1/renewal", "/internal/relay/v1/terminal"]);

export function generateCpuGateBearer() { return randomBytes(32).toString("base64url"); }

export async function withPreviewSecretsFile({ token, directoryParent = tmpdir(), upload }) {
  const directory = await mkdtemp(join(directoryParent, "octg-preview-cpu-gate-"));
  try {
    const secretsPath = join(directory, "secrets.json");
    await writeFile(secretsPath, JSON.stringify({ OCTG_RELAY_CPU_GATE_AUTH_TOKEN: token }), { mode: 0o600 });
    return await upload(secretsPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runRelayCpuGate({ mode = "stage1", adapters = {}, journalPath, runId = randomUUID() }) {
  if (!["stage1", "stage2-preflight", "stage2-series", "recover-operation"].includes(mode)) throw new TypeError("Unknown relay CPU gate mode");
  const ledger = { version: 1, runId, mode, operations: [], calls: [] };
  if (mode === "recover-operation") {
    if (!adapters.recoverOperation) return { status: "BLOCKED", ledger };
    const recovered = await adapters.recoverOperation();
    ledger.operations.push({ operationId: recovered.operationId ?? runId, state: recovered.state ?? "unknown" });
    if (journalPath) await writeSafeJournal(journalPath, ledger.operations);
    return { status: recovered.complete === true ? "PASS" : "BLOCKED", ledger };
  }
  if (!adapters.runSeries) return { status: "BLOCKED", ledger };
  if (mode === "stage2-preflight") {
    const preflight = await adapters.runPreflight?.({ model: "octg-cpu-gate-reject-v1", cpuGatePath: CPU_GATE_PATH, callbackPaths: CALLBACK_PATHS });
    if (preflight?.outcome !== "model_requires_paid" || preflight?.admissionCreated === true) return { status: "BLOCKED", ledger };
    return { status: "PASS", ledger };
  }
  if (mode === "stage2-series" && !adapters.preflightPassed) return { status: "BLOCKED", ledger };
  const series = mode === "stage1" ? requiredSeriesMatrix() : adapters.series ?? [];
  for (const identity of series) {
    const workload = buildWorkload(identity.workloadClass);
    const response = await adapters.runSeries({ ...identity, workload, model: mode === "stage2-series" ? "octg-cpu-gate-reject-v1" : workload.model, overrideHeader: adapters.workerName && adapters.candidateVersionId ? `${adapters.workerName}="${adapters.candidateVersionId}"` : undefined });
    ledger.calls.push({ ...identity, callOrdinal: ledger.calls.length + 1, timestampMs: adapters.clock?.() ?? Date.now(), routeDiscriminator: identity.invocationClass === "ingress" ? "/v1/responses" : `/internal/relay/v1/${identity.invocationClass.split("_")[0]}`, status: response.status, outcomeHint: response.outcome ?? "unknown" });
  }
  if (journalPath) await writeSafeJournal(journalPath, ledger.operations);
  return { status: "PASS", ledger };
}

async function writeSafeJournal(path, operations) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ version: 1, operations })}\n`, { mode: 0o600 });
}

export async function runCpuGateCli(argv = process.argv.slice(2), env = process.env) {
  const [mode = "stage1", ...options] = argv;
  const pairs = Object.fromEntries(options.map((value) => { const [key, ...rest] = value.split("="); return [key, rest.join("=")]; }));
  if (mode === "--help" || mode === "help") { console.log("gate:relay-cpu <stage1|stage2-preflight|stage2-series|recover-operation>"); return 0; }
  const journalPath = pairs["--journal"];
  const result = await runRelayCpuGate({ mode, journalPath, adapters: { preflightPassed: env.OCTG_RELAY_CPU_GATE_PREFLIGHT === "passed" } });
  console.log(JSON.stringify({ status: result.status, runId: result.ledger.runId, callCount: result.ledger.calls.length }));
  return result.status === "PASS" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCpuGateCli().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error instanceof Error ? error.message : "CPU gate failed"); process.exitCode = 1; });
