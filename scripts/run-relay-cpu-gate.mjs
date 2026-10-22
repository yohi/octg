import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildWorkload, requiredSeriesMatrix } from "./relay-cpu-workloads.mjs";

const CPU_GATE_PATH = "/internal/relay/v1/cpu-gate";
const CALLBACK_PATHS = Object.freeze(["/internal/relay/v1/decision", "/internal/relay/v1/activation", "/internal/relay/v1/renewal", "/internal/relay/v1/terminal"]);
const SUCCESS_SAMPLE_TARGET = 500;
const now = () => Date.now();

export function generateCpuGateBearer() { return randomBytes(32).toString("base64url"); }

export async function withPreviewSecretsFile({ token, directoryParent = tmpdir(), upload }) {
  const directory = await mkdtemp(join(directoryParent, "octg-preview-cpu-gate-"));
  try {
    await chmod(directory, 0o700);
    const secretsPath = join(directory, "secrets.json");
    await writeFile(secretsPath, JSON.stringify({ OCTG_RELAY_CPU_GATE_AUTH_TOKEN: token }), { mode: 0o600 });
    return await upload(secretsPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function ulid() {
  const time = BigInt(now());
  let timestamp = "";
  for (let index = 0; index < 10; index += 1) timestamp = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number((time >> BigInt((9 - index) * 5)) & 31n)] + timestamp;
  let random = BigInt(`0x${randomBytes(10).toString("hex")}`);
  let entropy = "";
  for (let index = 0; index < 16; index += 1) { entropy = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number(random & 31n)] + entropy; random >>= 5n; }
  return `req_${timestamp}${entropy}`;
}

function safeOperation(operation) {
  return { pool: operation.pool, requestId: operation.requestId, state: operation.state, timestamps: operation.timestamps ?? [], generation: operation.generation ?? null };
}
async function persistJournal(path, operations) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ version: 1, operations: operations.map(safeOperation) })}\n`, { mode: 0o600 });
}

async function invoke(callback, input, ledger, identity, route, clock) {
  const timestampMs = clock();
  const response = await callback(input);
  ledger.calls.push({ ...identity, callOrdinal: ledger.calls.length + 1, timestampMs, routeDiscriminator: route, status: response.status, outcomeHint: response.outcome ?? "unknown", ...(input.requestId ? { requestId: input.requestId } : {}) });
  return response;
}

async function runSeries(identity, adapters, ledger, options) {
  const { mode, journalPath, operations } = options;
  const workload = buildWorkload(identity.workloadClass);
  const model = mode === "stage2-series" ? "octg-cpu-gate-reject-v1" : workload.model;
  const overrideHeader = adapters.workerName && adapters.candidateVersionId ? `${adapters.workerName}="${adapters.candidateVersionId}"` : undefined;
  const header = overrideHeader ? { "Cloudflare-Workers-Version-Overrides": overrideHeader } : {};
  const totalTarget = adapters.sampleCount ?? SUCCESS_SAMPLE_TARGET;
  let successes = 0;
  let attempts = 0;
  const route = identity.invocationClass === "ingress" ? "/v1/responses" : `/internal/relay/v1/${identity.invocationClass.split("_")[0]}`;
  let replayFixture;
  while (successes < totalTarget && attempts < totalTarget * 5) {
    const batchSize = Math.min(identity.concurrency, totalTarget - successes);
    const requestId = identity.invocationClass === "decision" ? ulid() : undefined;
    let fixture = replayFixture;
    if (identity.invocationClass !== "ingress" && identity.invocationClass !== "decision" && !identity.invocationClass.endsWith("_replay")) {
      if (!adapters.createFixture) throw new Error("fixture adapter unavailable");
      fixture = await adapters.createFixture({ requestId: ulid(), model, workload, invocationClass: identity.invocationClass });
    }
    if (identity.invocationClass.endsWith("_replay") || identity.invocationClass === "renewal_normal" || identity.invocationClass === "decision") {
      if (!fixture) {
        fixture = identity.invocationClass === "decision"
          ? { requestId }
          : await adapters.createFixture?.({ requestId: ulid(), model, workload, invocationClass: identity.invocationClass });
        if (!fixture) throw new Error("fixture adapter unavailable");
        replayFixture = fixture;
      }
    }
    let contextToken;
    if (identity.invocationClass === "decision") {
      const context = await adapters.decisionContext({ requestId, model, workload, controlPath: CPU_GATE_PATH });
      if (!context?.contextToken) throw new Error("decision context unavailable");
      contextToken = context.contextToken;
    }
    const callbackName = identity.invocationClass.startsWith("activation") ? "activation" : identity.invocationClass.startsWith("renewal") ? "renewal" : identity.invocationClass.startsWith("terminal") ? "terminal" : identity.invocationClass;
    const input = { invocationClass: callbackName, requestId: fixture?.requestId ?? requestId, model, workload, headers: { ...header, ...(contextToken ? { "X-OCTG-Relay-Context": contextToken } : {}) }, grantCredential: fixture?.grantCredential };
    if (callbackName === "ingress") input.headers = header;
    const responses = await Promise.all(Array.from({ length: batchSize }, () => invoke(adapters.callback, input, ledger, identity, route, adapters.clock ?? now)));
    attempts += responses.length;
    successes += responses.filter((response) => response.status >= 200 && response.status < 300).length;
    const grants = responses.map((response) => response.grantCredential).filter((credential) => typeof credential === "string");
    for (const grantCredential of grants) {
      if (!adapters.terminalize) throw new Error("terminal adapter unavailable");
      const terminal = await adapters.terminalize({ requestId: fixture?.requestId ?? requestId, grantCredential });
      if (terminal.accepted !== true || !terminal.state) throw new Error("grant terminal proof unavailable");
    }
    if (fixture && identity.invocationClass.endsWith("_replay")) replayFixture = fixture;
    if (fixture && !identity.invocationClass.endsWith("_replay") && adapters.terminalizeFixture) await adapters.terminalizeFixture({ fixture });
    if (journalPath) await persistJournal(journalPath, operations);
  }
  if (successes !== totalTarget) throw new Error("successful invocation target not reached");
  return { status: 200, outcome: "completed" };
}

export async function runRelayCpuGate({ mode = "stage1", adapters = {}, journalPath, runId = randomUUID() }) {
  if (!["stage1", "stage2-preflight", "stage2-series", "recover-operation"].includes(mode)) throw new TypeError("Unknown relay CPU gate mode");
  const ledger = { version: 1, runId, mode, operations: [], calls: [] };
  const operations = ledger.operations;
  const clock = adapters.clock ?? now;
  const blocked = () => ({ status: "BLOCKED", ledger });
  if (mode === "recover-operation") {
    if (!adapters.claimSlot || !adapters.recoverOwner || !adapters.closeOperation) return blocked();
    const slot = await adapters.claimSlot({ inspectOnly: true });
    if (slot.kind === "unavailable" || slot.kind === "busy") return blocked();
    const owner = slot.owner ?? await adapters.recoverOwner();
    if (!owner) return { status: "PASS", ledger };
    const recovered = await adapters.recoverOwner({ owner, requestId: owner.requestId });
    operations.push(safeOperation({ ...owner, state: recovered.state, timestamps: [clock()], generation: owner.generation }));
    if (!recovered.terminal && !recovered.fencedAbsent) return blocked();
    const closed = await adapters.closeOperation({ requestId: owner.requestId, generation: owner.generation });
    if (closed.idle !== true) return blocked();
    if (journalPath) await persistJournal(journalPath, operations);
    return { status: "PASS", ledger };
  }
  if (mode === "stage2-preflight") {
    if (!adapters.runPreflight) return blocked();
    const preflight = await adapters.runPreflight({ model: "octg-cpu-gate-reject-v1", cpuGatePath: CPU_GATE_PATH, callbackPaths: CALLBACK_PATHS });
    if (preflight?.outcome !== "model_requires_paid" || preflight.admissionCreated === true || preflight.grantCreated === true) return blocked();
    return { status: "PASS", ledger };
  }
  if (mode === "stage2-series") {
    if (!adapters.preflightPassed || !adapters.claimSlot || !adapters.closeOperation) return blocked();
    const slot = await adapters.claimSlot({ requestId: ulid(), runId });
    if (slot.kind !== "claimed") return blocked();
    operations.push(safeOperation({ ...slot, state: "claimed", timestamps: [clock()] }));
    if (journalPath) await persistJournal(journalPath, operations);
  }
  if (adapters.provisionPreview) {
    const bearer = generateCpuGateBearer();
    try {
      await adapters.provisionPreview({ bearer, run: (secretsPath) => adapters.uploadCandidate({ secretsPath, bearerEnv: "OCTG_RELAY_CPU_GATE_AUTH_TOKEN" }) });
    } catch { return blocked(); }
  }
  if (!adapters.callback && !adapters.runSeries) return blocked();
  const series = adapters.series ?? requiredSeriesMatrix();
  try {
    for (const identity of series) {
      if (adapters.runSeries) {
        const response = await adapters.runSeries({ ...identity, workload: buildWorkload(identity.workloadClass), model: mode === "stage2-series" ? "octg-cpu-gate-reject-v1" : buildWorkload(identity.workloadClass).model, overrideHeader: adapters.workerName && adapters.candidateVersionId ? `${adapters.workerName}="${adapters.candidateVersionId}"` : undefined });
        ledger.calls.push({ ...identity, callOrdinal: ledger.calls.length + 1, timestampMs: clock(), routeDiscriminator: identity.invocationClass === "ingress" ? "/v1/responses" : `/internal/relay/v1/${identity.invocationClass.split("_")[0]}`, status: response.status, outcomeHint: response.outcome ?? "unknown" });
      } else await runSeries(identity, adapters, ledger, { mode, journalPath, operations });
    }
  } catch { return blocked(); }
  if (mode === "stage2-series") {
    const closed = await adapters.closeOperation({ requestId: operations[0].requestId, generation: operations[0].generation });
    if (closed.idle !== true) return blocked();
    operations[0].state = "closed";
  }
  if (adapters.teardownPreview) {
    const teardown = await adapters.teardownPreview({ deleteVersionedSecret: true, uploadSecretlessAt100Percent: true, verifyMetadataSecretAbsent: true, verifyExactVersion404: true });
    if (teardown.secretDeleted !== true || teardown.secretlessPercent !== 100 || teardown.secretAbsent !== true || teardown.exactVersionStatus !== 404) return blocked();
  }
  if (journalPath) await persistJournal(journalPath, operations);
  return { status: "PASS", ledger };
}

export async function runCpuGateCli(argv = process.argv.slice(2), env = process.env) {
  const [mode = "stage1", ...options] = argv;
  const pairs = Object.fromEntries(options.map((value) => { const [key, ...rest] = value.split("="); return [key, rest.join("=")]; }));
  if (mode === "--help" || mode === "help") { console.log("gate:relay-cpu <stage1|stage2-preflight|stage2-series|recover-operation>"); return 0; }
  const result = await runRelayCpuGate({ mode, journalPath: pairs["--journal"], adapters: { preflightPassed: env.OCTG_RELAY_CPU_GATE_PREFLIGHT === "passed" } });
  console.log(JSON.stringify({ status: result.status, runId: result.ledger.runId, callCount: result.ledger.calls.length }));
  return result.status === "PASS" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCpuGateCli().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error instanceof Error ? error.message : "CPU gate failed"); process.exitCode = 1; });
