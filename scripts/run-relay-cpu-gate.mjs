import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, mkdir, chmod } from "node:fs/promises";
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

export function assertNoCredentialLeak({ credentials, surfaces }) {
  const serialized = JSON.stringify(surfaces);
  if (credentials.some((credential) => typeof credential === "string" && credential.length > 0 && serialized.includes(credential))) {
    throw new Error("credential leak detected in output surfaces");
  }
}

export async function runFixtureLifecycle({ requestId, adapters }) {
  let setup;
  let ambiguous = false;
  try {
    setup = await adapters.setup({ requestId });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    ambiguous = true;
  }
  if (!ambiguous && (!setup || !["created", "ambiguous"].includes(setup.kind))) return { kind: "blocked", proof: setup?.kind ?? "missing" };
  ambiguous ||= setup?.kind === "ambiguous";
  const fence = await adapters.setupFence({ requestId, operationId: setup?.operationId, recover: ambiguous });
  if (!fence || fence.kind !== "fenced") return { kind: "blocked", proof: fence?.kind ?? "missing" };
  const operationId = fence.operationId ?? setup?.operationId;
  const inspection = await adapters.inspectOperation({ requestId, operationId });
  if (!inspection || inspection.kind !== "unused") return { kind: "blocked", proof: inspection?.kind ?? "missing" };
  const reconciliation = await adapters.reconcileUnused({ requestId, operationId });
  if (!reconciliation || !["reconciled", "terminal", "noop"].includes(reconciliation.kind)) {
    return { kind: "blocked", proof: reconciliation?.kind ?? "missing" };
  }
  return { kind: "ready", fixture: { ...setup, operationId, requestId } };
}

export async function recoverSharedOperation({ journal, adapters }) {
  const slot = await adapters.readSharedSlot();
  if (!slot || slot.kind === "unavailable") return { kind: "blocked", reason: "slot-unavailable" };
  if (slot.kind === "idle") return { kind: "idle" };
  if (slot.kind !== "owned" || !slot.owner) return { kind: "blocked", reason: "slot-busy" };
  const { owner } = slot;
  const local = journal.find((entry) => entry.requestId === owner.requestId);
  if (local && owner.generation !== undefined && local.generation !== undefined && local.generation !== owner.generation) {
    return { kind: "blocked", reason: "journal-generation-mismatch" };
  }
  const inspection = await adapters.inspectOperation({ requestId: owner.requestId, generation: owner.generation });
  if (!inspection || inspection.kind === "active") {
    const recovery = await adapters.recoverOperation({ owner, inspection });
    if (!recovery || !["terminal", "fencedAbsent"].includes(recovery.kind)) return { kind: "blocked", reason: "owner-not-terminal" };
  } else if (!(["terminal", "fencedAbsent", "absent"].includes(inspection.kind))) {
    return { kind: "blocked", reason: "owner-inspection-unknown" };
  }
  const closed = await adapters.closeOperation({ requestId: owner.requestId, generation: owner.generation });
  return closed?.idle === true ? { kind: "idle", owner } : { kind: "blocked", reason: "close-not-proven" };
}

export async function runPreviewLifecycle({ bearer, adapters }) {
  let candidateVersion;
  let secretlessVersion;
  let temp;
  let candidateDeployed = false;
  let failure;
  let ownershipClosed = false;
  try {
    temp = await adapters.createTempSecret({ token: bearer });
    const uploaded = await adapters.uploadCandidate({ path: temp.path, secretName: "OCTG_RELAY_CPU_GATE_AUTH_TOKEN" });
    candidateVersion = uploaded?.versionId;
    if (!candidateVersion) throw new Error("candidate version missing");
    await adapters.deployCandidate({ versionId: candidateVersion });
    candidateDeployed = true;
    const observed = await adapters.observeCandidate({ versionId: candidateVersion });
    if (observed?.observed !== true) throw new Error("candidate version observation failed");
    if (adapters.measure) {
      try { await adapters.measure({ versionId: candidateVersion }); } catch (error) {
        if (!(error instanceof Error)) throw error;
        failure = true;
      }
    }
    if (adapters.beforeTeardown) {
      ownershipClosed = true;
      try { await adapters.beforeTeardown(); } catch { failure = true; }
    }
    const secretless = await adapters.uploadSecretless({});
    secretlessVersion = secretless?.versionId;
    if (!secretlessVersion) throw new Error("secretless version missing");
    await adapters.setTraffic({ versionId: secretlessVersion, percent: 100 });
    await adapters.deleteVersionSecret({ versionId: candidateVersion, secretName: "OCTG_RELAY_CPU_GATE_AUTH_TOKEN" });
    if (!adapters.verifyMetadata) throw new Error("candidate secret metadata proof unavailable");
    const metadata = await adapters.verifyMetadata({ versionId: candidateVersion });
    if (metadata?.secretAbsent !== true || metadata?.bindingsUnchanged !== true) throw new Error("candidate secret metadata proof failed");
    const exactVersion = await adapters.verifyExactVersion({ versionId: candidateVersion });
    if (exactVersion?.status !== 404) throw new Error("exact version secret deletion was not verified");
  } catch {
    failure = true;
  } finally {
    if (adapters.beforeTeardown && !ownershipClosed) {
      ownershipClosed = true;
      try { await adapters.beforeTeardown(); } catch { failure = true; }
    }
    if (failure && candidateDeployed) {
      try { await adapters.rollback({ versionId: candidateVersion }); } catch { failure = true; }
    }
    if (temp) {
      try { await adapters.cleanupTemp({ path: temp.path }); } catch { failure = true; }
    }
  }
  return failure ? { kind: "blocked" } : { kind: "complete", versionId: candidateVersion, secretlessVersion };
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
      if (!adapters.createFixture && !adapters.setup) throw new Error("fixture adapter unavailable");
      const fixtureRequestId = ulid();
      fixture = adapters.setup && adapters.setupFence && adapters.inspectOperation && adapters.reconcileUnused
        ? (await runFixtureLifecycle({ requestId: fixtureRequestId, adapters: {
          setup: adapters.setup, setupFence: adapters.setupFence, inspectOperation: adapters.inspectOperation, reconcileUnused: adapters.reconcileUnused,
        } })).fixture
        : await adapters.createFixture?.({ requestId: fixtureRequestId, model, workload, invocationClass: identity.invocationClass });
      if (!fixture) throw new Error("fixture setup was not proven ready");
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
      let proof;
      for (let retry = 0; retry < 3; retry += 1) {
        try {
          const terminal = await adapters.terminalize({ requestId: fixture?.requestId ?? requestId, grantCredential, retry });
          if (terminal.accepted === true && terminal.state) { proof = terminal; break; }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
      }
      if (!proof || !adapters.proveTerminal || !(await adapters.proveTerminal({ requestId: fixture?.requestId ?? requestId, state: proof.state, grantCredential })).terminal) {
        throw new Error("grant terminal proof unavailable");
      }
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
  const scanOutputs = () => assertNoCredentialLeak({
    credentials: adapters.credentialSentinels ?? [],
    surfaces: adapters.outputSurfaces ?? {},
  });
  const blocked = () => {
    try { scanOutputs(); } catch { /* The ledger intentionally contains no adapter output. */ }
    return { status: "BLOCKED", ledger };
  };
  let journal;
  try { journal = adapters.journal ?? await loadJournal(journalPath); } catch { return blocked(); }
  if (mode === "recover-operation") {
    if (!adapters.readSharedSlot || !adapters.inspectOperation || !adapters.recoverOperation || !adapters.closeOperation) return blocked();
    const recovered = await recoverSharedOperation({ journal, adapters });
    if (recovered.kind !== "idle") return blocked();
    if (recovered.owner) operations.push(safeOperation({ ...recovered.owner, state: "closed", timestamps: [clock()] }));
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
    if (!adapters.readSharedSlot) return blocked();
    if (!adapters.inspectOperation || !adapters.recoverOperation || !adapters.closeOperation) return blocked();
    const recovery = await recoverSharedOperation({ journal, adapters });
    if (recovery.kind !== "idle") return blocked();
  }
  if (mode === "stage2-series") {
    if (!adapters.runPreflight || !adapters.claimSlot || !adapters.closeOperation) return blocked();
    const preflight = await adapters.runPreflight({ runId, model: "octg-cpu-gate-reject-v1", cpuGatePath: CPU_GATE_PATH, callbackPaths: CALLBACK_PATHS });
    if (preflight?.runId !== runId || preflight?.model !== "octg-cpu-gate-reject-v1" || preflight?.outcome !== "model_requires_paid" || preflight.admissionCreated !== false || preflight.grantCreated !== false) return blocked();
    const slot = await adapters.claimSlot({ requestId: ulid(), runId });
    if (slot.kind !== "claimed") return blocked();
    operations.push(safeOperation({ ...slot, state: "claimed", timestamps: [clock()] }));
    if (journalPath) await persistJournal(journalPath, operations);
  }
  if (mode !== "stage2-series" && adapters.readSharedSlot) {
    if (!adapters.inspectOperation || !adapters.recoverOperation || !adapters.closeOperation) return blocked();
    const recovery = await recoverSharedOperation({ journal, adapters });
    if (recovery.kind !== "idle") return blocked();
  }
  const previewLifecycle = adapters.previewLifecycle;
  if (!previewLifecycle && adapters.provisionPreview) {
    const bearer = generateCpuGateBearer();
    try {
      await adapters.provisionPreview({ bearer, run: (secretsPath) => adapters.uploadCandidate({ secretsPath, bearerEnv: "OCTG_RELAY_CPU_GATE_AUTH_TOKEN" }) });
    } catch { return blocked(); }
  }
  if (!adapters.callback && !adapters.runSeries) return blocked();
  const series = adapters.series ?? requiredSeriesMatrix();
  const closeStage2Slot = async () => {
    if (mode !== "stage2-series") return;
    const owner = operations[0];
    if (!owner) throw new Error("Stage 2 operation owner missing");
    const closed = await adapters.closeOperation({ requestId: owner.requestId, generation: owner.generation });
    if (closed.idle !== true || closed.targetTerminal !== true || closed.fencedAbsent !== true) throw new Error("Stage 2 close proof unavailable");
    owner.state = "closed";
  };
  const executeSeries = async () => {
    for (const identity of series) {
      if (adapters.runSeries) {
        const response = await adapters.runSeries({ ...identity, workload: buildWorkload(identity.workloadClass), model: mode === "stage2-series" ? "octg-cpu-gate-reject-v1" : buildWorkload(identity.workloadClass).model, overrideHeader: adapters.workerName && adapters.candidateVersionId ? `${adapters.workerName}="${adapters.candidateVersionId}"` : undefined });
        ledger.calls.push({ ...identity, callOrdinal: ledger.calls.length + 1, timestampMs: clock(), routeDiscriminator: identity.invocationClass === "ingress" ? "/v1/responses" : `/internal/relay/v1/${identity.invocationClass.split("_")[0]}`, status: response.status, outcomeHint: response.outcome ?? "unknown" });
      } else await runSeries(identity, adapters, ledger, { mode, journalPath, operations });
    }
  };
  if (previewLifecycle) {
    const preview = await runPreviewLifecycle({ bearer: generateCpuGateBearer(), adapters: { ...previewLifecycle, measure: executeSeries, beforeTeardown: closeStage2Slot } });
    if (preview.kind !== "complete") return blocked();
  } else {
    try { await executeSeries(); await closeStage2Slot(); } catch {
      try { await closeStage2Slot(); } catch { /* A failed close is reported only as BLOCKED. */ }
      return blocked();
    }
  }
  if (adapters.teardownPreview) {
    const teardown = await adapters.teardownPreview({ deleteVersionedSecret: true, uploadSecretlessAt100Percent: true, verifyMetadataSecretAbsent: true, verifyExactVersion404: true });
    if (teardown.secretDeleted !== true || teardown.secretlessPercent !== 100 || teardown.secretAbsent !== true || teardown.exactVersionStatus !== 404) return blocked();
  }
  if (journalPath) await persistJournal(journalPath, operations);
  try { scanOutputs(); } catch { return blocked(); }
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
