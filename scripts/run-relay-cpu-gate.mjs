import { randomUUID } from "node:crypto";
import { writeFile, readFile, mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { buildWorkload, requiredSeriesMatrix } from "./relay-cpu-workloads.mjs";
import { runFixtureLifecycle, recoverSharedOperation, closeOwnedOperation } from "./relay-cpu-operation.mjs";
import { executeCpuGateCli } from "./relay-cpu-cli.mjs";
import { createRequestId as ulid } from "./relay-cpu-request-id.mjs";
import { assertNoCredentialLeak } from "./relay-cpu-protection.mjs";
export { generateCpuGateBearer, withPreviewSecretsFile, assertNoCredentialLeak } from "./relay-cpu-protection.mjs";
export { runPreviewLifecycle } from "./relay-cpu-preview.mjs";
export { runFixtureLifecycle, recoverSharedOperation } from "./relay-cpu-operation.mjs";

const CPU_GATE_PATH = "/internal/relay/v1/cpu-gate";
const CALLBACK_PATHS = Object.freeze(["/internal/relay/v1/decision", "/internal/relay/v1/activation", "/internal/relay/v1/renewal", "/internal/relay/v1/terminal"]);
const SUCCESS_SAMPLE_TARGET = 500;
const now = () => Date.now();

function safeOperation(operation) {
  return { pool: operation.pool, requestId: operation.requestId, state: operation.state,
    createdAt: operation.createdAt, lastTransitionAt: operation.lastTransitionAt, generation: operation.generation ?? null };
}
async function persistJournal(path, operations) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ version: 1, operations: operations.map(safeOperation) })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function loadJournal(path) {
  if (!path) return [];
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.operations)) throw new Error("operation journal invalid");
    return parsed.operations.map((operation) => safeOperation(operation));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new Error("operation journal unavailable");
  }
}

async function invoke(callback, input, ledger, identity, route, clock, isSuccessfulSample) {
  const timestampMs = clock();
  const callOrdinal = (ledger.issuedCalls ?? 0) + 1;
  ledger.issuedCalls = callOrdinal;
  const response = await callback(input);
  const success = isSuccessfulSample(response);
  const { windows, ...callIdentity } = identity;
  ledger.calls.push({ ...callIdentity, callOrdinal, timestampMs, routeDiscriminator: route, status: response.status, success, outcomeHint: response.outcome ?? "unknown", ...(input.requestId ? { requestId: input.requestId } : {}) });
  return response;
}

async function runSeries(identity, adapters, ledger, options) {
  if (!adapters.workerName || !adapters.candidateVersionId) throw new Error("candidate override identity required");
  const { mode, journalPath, operations, signal } = options;
  const workload = buildWorkload(identity.workloadClass);
  const model = mode === "stage2-series" ? "octg-cpu-gate-reject-v1" : adapters.model ?? workload.model;
  const isSuccessfulSample = (response) => adapters.isSuccessfulSample
    ? adapters.isSuccessfulSample(response, identity, mode) : response.status >= 200 && response.status < 300;
  const overrideHeader = adapters.workerName && adapters.candidateVersionId ? `${adapters.workerName}="${adapters.candidateVersionId}"` : undefined;
  const header = overrideHeader ? { "Cloudflare-Workers-Version-Overrides": overrideHeader } : {};
  const totalTarget = adapters.sampleCount ?? SUCCESS_SAMPLE_TARGET;
  let successes = 0;
  let attempts = 0;
  let fixture;
  let operation;
  let prepared = false;
  let seriesComplete = false;
  const retainFixture = identity.invocationClass.endsWith("_replay") || identity.invocationClass === "renewal_normal";
  const closeFixture = async (terminalize = true) => {
    try {
      if (fixture && (terminalize || !adapters.setup)) {
        if (!adapters.terminalizeFixture) throw new Error("fixture terminal adapter unavailable");
        const terminal = await adapters.terminalizeFixture({ fixture });
        if (terminal?.accepted !== true || !["settled", "released", "reconciled_consumed", "reconciled_unused"].includes(terminal.state)) throw new Error("fixture terminal proof unavailable");
        if (operation) { operation.state = "target_terminal"; operation.lastTransitionAt = (adapters.clock ?? now)(); }
      }
    } finally {
      if (operation && adapters.setup) {
        const closed = await closeOwnedOperation({ operation, adapters, requireSlot: mode === "stage2-series" });
        operation.lastTransitionAt = (adapters.clock ?? now)();
        if (journalPath) await persistJournal(journalPath, operations);
        if (closed.kind !== "closed") throw new Error("fixture closure not proven");
      } else if (operation?.state === "target_terminal") operation.state = "closed";
    }
    fixture = undefined; operation = undefined; prepared = false;
  };
  const route = identity.invocationClass === "ingress" ? "/v1/responses" : `/internal/relay/v1/${identity.invocationClass.split("_")[0]}`;
  try {
  while (successes < totalTarget && attempts < totalTarget * 5) {
    signal?.throwIfAborted();
    const batchSize = Math.min(identity.concurrency, totalTarget - successes);
    if (!fixture && identity.invocationClass !== "ingress" && identity.invocationClass !== "decision") {
      if (!adapters.createFixture && !adapters.setup) throw new Error("fixture adapter unavailable");
      const fixtureRequestId = ulid();
      const createdAt = (adapters.clock ?? now)();
      operation = { pool: adapters.pool, requestId: fixtureRequestId, state: "setup_pending", createdAt, lastTransitionAt: createdAt };
      operations.push(operation);
      if (journalPath) await persistJournal(journalPath, operations);
      fixture = adapters.setup && adapters.setupFence && adapters.inspectOperation && adapters.reconcileUnused
        ? (await runFixtureLifecycle({ pool: adapters.pool, requestId: fixtureRequestId, adapters: {
          setup: adapters.setup, setupFence: adapters.setupFence, inspectOperation: adapters.inspectOperation, reconcileUnused: adapters.reconcileUnused,
        } })).fixture
        : await adapters.createFixture?.({ requestId: fixtureRequestId, model, workload, invocationClass: identity.invocationClass });
      if (!fixture) throw new Error("fixture setup was not proven ready");
      if (mode === "stage2-series") {
        const envelope = await adapters.readSharedSlot();
        const slot = envelope?.version === 1 ? envelope.slot : undefined;
        if (!slot || slot.kind !== "held" || slot.owner?.pool !== operation.pool
          || slot.owner?.requestId !== operation.requestId || !Number.isSafeInteger(slot.generation) || slot.generation < 1) {
          throw new Error("fixture singleton ownership not proven");
        }
        operation.generation = slot.generation;
      }
      operation.state = "active";
      operation.lastTransitionAt = (adapters.clock ?? now)();
      if (journalPath) await persistJournal(journalPath, operations);
    }
    if (fixture && !prepared && adapters.prepareFixture) {
      await adapters.prepareFixture({ fixture, invocationClass: identity.invocationClass });
      prepared = true;
    }
    const callbackName = identity.invocationClass.startsWith("activation") ? "activation" : identity.invocationClass.startsWith("renewal") ? "renewal" : identity.invocationClass.startsWith("terminal") ? "terminal" : identity.invocationClass;
    const inputs = [];
    for (let index = 0; index < batchSize; index += 1) {
      const requestId = callbackName === "decision" ? ulid() : fixture?.requestId;
      let contextToken;
      if (callbackName === "decision") {
        const context = await adapters.decisionContext({ requestId, model, workload, controlPath: CPU_GATE_PATH });
        if (!context?.contextToken) throw new Error("decision context unavailable");
        contextToken = context.contextToken;
      }
      inputs.push({ invocationClass: callbackName, requestId, model, workload, expectedVersionId: adapters.candidateVersionId,
        headers: { ...header, ...(contextToken ? { "X-OCTG-Relay-Context": contextToken } : {}) }, grantCredential: fixture?.grantCredential });
    }
    // Drain every in-flight callback before recovery can fence or reconcile it.
    const clock = adapters.clock ?? now;
    const windowStartMs = clock();
    const outcomes = await Promise.allSettled(inputs.map((input) => invoke(adapters.callback, input, ledger, identity, route, adapters.clock ?? now, isSuccessfulSample)));
    let windowEndMs = clock();
    for (let attempt = 0; windowEndMs <= windowStartMs && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      windowEndMs = clock();
    }
    const clockValid = windowEndMs > windowStartMs;
    if (clockValid) identity.windows.push({ windowStartMs, windowEndMs });
    const responses = outcomes.filter((outcome) => outcome.status === "fulfilled").map((outcome) => outcome.value);
    const batchFailed = signal?.aborted || !clockValid || outcomes.some((outcome) => outcome.status === "rejected")
      || responses.some((response) => response.scriptVersionId !== adapters.candidateVersionId || !isSuccessfulSample(response));
    attempts += responses.length;
    successes += responses.filter(isSuccessfulSample).length;
    const grants = new Map(outcomes.flatMap((outcome, index) => outcome.status === "fulfilled" && typeof outcome.value.grantCredential === "string"
      ? [[outcome.value.grantCredential, inputs[index].requestId]] : []));
    let allGrantsTerminal = true;
    for (const [grantCredential, requestId] of grants) {
      if (!adapters.terminalize) throw new Error("terminal adapter unavailable");
      let proof;
      for (let retry = 0; retry < 3; retry += 1) {
        try {
          const terminal = await adapters.terminalize({ requestId, grantCredential, retry });
          if (terminal.accepted === true && ["settled", "released", "reconciled_consumed", "reconciled_unused"].includes(terminal.state)) {
            if (adapters.proveTerminal && !(await adapters.proveTerminal({ requestId, state: terminal.state, grantCredential }))?.terminal) continue;
            proof = terminal;
            break;
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
      }
      if (!proof) allGrantsTerminal = false;
    }
    if (!allGrantsTerminal) throw new Error("grant terminal proof unavailable");
    if (batchFailed) throw new Error("measured callback failed or observed Worker version mismatch");
    if (!retainFixture) await closeFixture();
    if (journalPath) await persistJournal(journalPath, operations);
  }
  seriesComplete = true;
  } finally { await closeFixture(seriesComplete); }
  if (successes !== totalTarget) throw new Error("successful invocation target not reached");
  return { status: 200, outcome: "completed" };
}

export async function runRelayCpuGate({ mode = "stage1", adapters = {}, journalPath, ledgerPath, sourceRevision, signal, runId = randomUUID() }) {
  if (!["stage1", "stage2-preflight", "stage2-series", "recover-operation"].includes(mode)) throw new TypeError("Unknown relay CPU gate mode");
  const ledger = { version: 1, runId, mode, operations: [], calls: [], series: [] };
  const operations = ledger.operations;
  const scanOutputs = () => assertNoCredentialLeak({
    credentials: adapters.credentialSentinels ?? [],
    surfaces: adapters.outputSurfaces ?? {},
  });
  const blocked = () => {
    try { scanOutputs(); } catch { /* The ledger intentionally contains no adapter output. */ }
    return { status: "BLOCKED", ledger };
  };
  let journal;
  if (adapters.readSharedSlot) {
    const recovery = await recoverSharedOperation({ loadJournal: async () => adapters.journal ?? await loadJournal(journalPath), adapters });
    if (recovery.kind !== "idle") return blocked();
    journal = recovery.operations;
  } else {
    if (["stage2-series", "recover-operation"].includes(mode)) return blocked();
    try { journal = adapters.journal ?? await loadJournal(journalPath); } catch { return blocked(); }
    if (journal.some((operation) => operation.state !== "closed")) return blocked();
  }
  if (mode === "recover-operation") {
    if (!adapters.readSharedSlot || !adapters.inspectOperation || !adapters.setupFence || !adapters.closeOperation) return blocked();
    operations.push(...journal.map(safeOperation));
    if (journalPath) await persistJournal(journalPath, operations);
    try { scanOutputs(); } catch { return blocked(); }
    return { status: "PASS", ledger };
  }
  if (mode === "stage2-preflight") {
    if (!adapters.runPreflight) return blocked();
    const preflight = await adapters.runPreflight({ model: "octg-cpu-gate-reject-v1", cpuGatePath: CPU_GATE_PATH, callbackPaths: CALLBACK_PATHS });
    if (preflight?.outcome !== "model_requires_paid" || preflight.admissionCreated === true || preflight.grantCreated === true) return blocked();
    try { scanOutputs(); } catch { return blocked(); }
    return { status: "PASS", ledger };
  }
  if (mode === "stage2-series") {
    if (!adapters.runPreflight || !adapters.closeOperation) return blocked();
    const preflight = await adapters.runPreflight({ runId, model: "octg-cpu-gate-reject-v1", cpuGatePath: CPU_GATE_PATH, callbackPaths: CALLBACK_PATHS });
    if (preflight?.runId !== runId || preflight?.model !== "octg-cpu-gate-reject-v1" || preflight?.outcome !== "model_requires_paid" || preflight.admissionCreated !== false || preflight.grantCreated !== false) return blocked();
  }
  if (!adapters.callback) return blocked();
  const series = adapters.series ?? requiredSeriesMatrix();
  const closeStage2Slot = async () => {
    if (mode !== "stage2-series") return;
    for (const operation of operations) {
      if (operation.state === "closed") continue;
      const closed = await closeOwnedOperation({ operation, adapters, requireSlot: true });
      if (journalPath) await persistJournal(journalPath, operations);
      if (closed.kind !== "closed") throw new Error("Stage 2 close proof unavailable");
    }
    const slot = await adapters.readSharedSlot();
    if (slot?.version !== 1 || slot.slot?.kind !== "idle") throw new Error("Stage 2 slot is not idle");
  };
  const executeSeries = async () => {
    for (const identity of series) {
      const seriesLedger = { ...identity, stage: mode, scriptName: adapters.workerName,
        candidateScriptVersion: adapters.candidateVersionId, candidateSourceRevision: sourceRevision,
        windows: [] };
      const offset = ledger.calls.length;
      ledger.series.push(seriesLedger);
      try { await runSeries(seriesLedger, adapters, ledger, { mode, journalPath, operations, signal }); }
      finally {
        seriesLedger.calls = ledger.calls.slice(offset).map(({ windows, ...call }) => call);
        seriesLedger.expectedSuccessfulInvocations = seriesLedger.calls.filter((call) => call.success).length;
        if (ledgerPath) {
          await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 });
          const path = `${ledgerPath}.${ledger.series.length}.json`;
          await writeFile(path, `${JSON.stringify(seriesLedger)}\n`, { mode: 0o600 });
          await chmod(path, 0o600);
          await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
          await chmod(ledgerPath, 0o600);
        }
      }
    }
  };
  try { await executeSeries(); await closeStage2Slot(); } catch {
    try { await closeStage2Slot(); } catch { /* A failed close is reported only as BLOCKED. */ }
    return blocked();
  }
  if (journalPath) await persistJournal(journalPath, operations);
  try { scanOutputs(); } catch { return blocked(); }
  return { status: "PASS", ledger };
}

export async function runCpuGateCli(argv = process.argv.slice(2), env = process.env, io = {}) {
  return executeCpuGateCli(argv, env, { ...io, runGate: runRelayCpuGate });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCpuGateCli().then((code) => { process.exitCode = code; }).catch(() => { console.error("CPU gate failed"); process.exitCode = 1; });
