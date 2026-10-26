import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createRequestId } from "./relay-cpu-request-id.mjs";
import { buildWorkload } from "./relay-cpu-workloads.mjs";
const { get_encoding } = createRequire(import.meta.url)("tiktoken");

const PREFIX = "/internal/relay/v1/cpu-gate/";
const MEASUREMENT_ID_QUERY = "octg_cpu_gate_measurement_id";
const ACTIONS = new Set(["decision", "activation", "renewal", "terminal"]);
let encoding;

// Only the controlled synthetic workload shapes are accepted here.
function decisionMetadata(workload, model) {
  const texts = [];
  const input = typeof workload.input === "string" ? [{ role: "user", content: workload.input }] : workload.input;
  if (!Array.isArray(input)) throw new TypeError("Unsupported synthetic workload");
  let isToolUse = false;
  for (const item of input) {
    if (item.type === "function_call") {
      texts.push(item.call_id, item.name, item.arguments); isToolUse = true;
    } else if (item.type === "function_call_output") {
      texts.push(item.call_id, item.output); isToolUse = true;
    } else if (["system", "developer", "user", "assistant"].includes(item.role) && typeof item.content === "string") {
      texts.push(item.content);
    } else throw new TypeError("Unsupported synthetic workload");
  }
  if (texts.some((text) => typeof text !== "string")) throw new TypeError("Unsupported synthetic workload");
  const inputText = texts.join("\n");
  encoding ??= get_encoding("o200k_base");
  return { model, estimatedInputTokens: encoding.encode(inputText).length + input.length * 4 + 3,
    maxOutputTokens: workload.max_output_tokens ?? 16, inputBytes: Buffer.byteLength(inputText),
    rawBodyBytes: Buffer.byteLength(JSON.stringify({ ...workload, model })), isToolUse, stream: workload.stream === true };
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing control response");
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65_536) { await reader.cancel(); throw new Error("Oversized control response"); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

export function createRelayCpuHttpAdapters(options) {
  const { env = process.env, fetchImpl = fetch, workerName, candidateVersionId, pool, model } = options;
  let origin;
  try { origin = new URL(options.origin); } catch { throw new TypeError("Invalid CPU-gate HTTP configuration"); }
  const controlToken = env.OCTG_RELAY_CPU_GATE_AUTH_TOKEN;
  const serviceToken = env.OCTG_RELAY_SERVICE_AUTH_TOKEN;
  const clientKey = env.OCTG_CANARY_CLIENT_KEY;
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || !controlToken || !serviceToken || controlToken === serviceToken || !workerName || !candidateVersionId
    || /["\r\n]/.test(workerName + candidateVersionId) || !["STANDARD", "MINI"].includes(pool)) {
    throw new TypeError("Invalid CPU-gate HTTP configuration");
  }
  const override = `${workerName}="${candidateVersionId}"`;
  const grants = new Map(); // Credentials and references remain in process memory only.
  let uncertainCallback = false;
  async function request(path, { token, body, headers = {}, discardBody = false, measurementId } = {}) {
    try {
      const url = new URL(path, origin);
      if (measurementId !== undefined) url.searchParams.set(MEASUREMENT_ID_QUERY, measurementId);
      const response = await fetchImpl(url, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
        headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), "Cloudflare-Workers-Version-Overrides": override,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (discardBody) {
        if (response.body) for await (const chunk of response.body) { void chunk; }
        return { status: response.status, scriptVersionId: response.headers.get("X-OCTG-Worker-Version"), outcome: "completed",
          ...(measurementId === undefined ? {} : { measurementId }) };
      }
      const value = await boundedJson(response);
      return { status: response.status, scriptVersionId: response.headers.get("X-OCTG-Worker-Version"),
        grantCredential: response.headers.get("X-OCTG-Relay-Grant"), body: value,
        ...(measurementId === undefined ? {} : { measurementId }) };
    } catch { throw new Error("CPU-gate HTTP request failed"); }
  }
  function remember(token, reference) {
    if (typeof token === "string" && token && typeof reference?.grantId === "string" && typeof reference?.leaseGeneration === "string") grants.set(token, { grantId: reference.grantId, leaseGeneration: reference.leaseGeneration });
  }
  async function control(action, input) {
    const body = action === "slot" ? undefined : { version: 1, pool: input?.pool ?? pool, requestId: input?.requestId,
      ...(action === "close-operation" ? { generation: input?.generation } : {}) };
    const response = await request(PREFIX + action, { token: controlToken, body });
    if (response.status === 200 && action === "setup") remember(response.body.grantToken, response.body);
    if (response.status !== 200 && !response.body?.error && !["absent", "pending_ambiguous", "setup_failed_compensated"].includes(response.body?.kind)) {
      throw new Error("Unexpected CPU-gate control response");
    }
    return response.body;
  }
  async function callbackRequest(input) {
    const measurementId = randomUUID();
    if (input.invocationClass === "ingress") {
      if (!clientKey) throw new Error("Client credential unavailable");
      const rejectOnly = input.model === "octg-cpu-gate-reject-v1";
      const response = await request("/v1/responses", { token: clientKey, body: { ...input.workload, model: input.model }, discardBody: !rejectOnly, measurementId });
      return rejectOnly
        ? { status: response.status, scriptVersionId: response.scriptVersionId, outcome: response.body?.error?.code ?? "unknown", measurementId }
        : response;
    }
    if (!ACTIONS.has(input.invocationClass)) throw new Error("Unknown callback action");
    let body;
    if (input.invocationClass === "decision") body = { version: 1, metadata: decisionMetadata(input.workload, input.model) };
    else {
      const reference = grants.get(input.grantCredential);
      if (!reference) throw new Error("Grant reference unavailable");
      body = { version: 1, grantId: reference.grantId, leaseGeneration: reference.leaseGeneration,
        ...(input.invocationClass === "terminal" ? { outcome: reference.activated ? "settle" : "release", totalTokens: reference.activated ? 0 : null } : {}) };
    }
    const response = await request(`/internal/relay/v1/${input.invocationClass}`, { token: serviceToken, body,
      headers: { ...input.headers, ...(input.grantCredential ? { "X-OCTG-Relay-Grant": input.grantCredential } : {}) }, measurementId });
    remember(response.grantCredential, response.body);
    if (input.invocationClass === "activation" && response.status === 200 && response.body?.activated === true) {
      grants.get(input.grantCredential).activated = true;
    }
    if (input.invocationClass === "terminal" && response.status === 200 && response.body?.accepted === true
      && ["released", "settled", "reconciled_unused", "reconciled_consumed"].includes(response.body.state)) {
      const reference = grants.get(input.grantCredential);
      if (reference) reference.terminalConfirmed = true;
    }
    return { ...response.body, status: response.status, scriptVersionId: response.scriptVersionId,
      measurementId,
      ...(response.grantCredential ? { grantCredential: response.grantCredential } : {}) };
  }
  async function callback(input) {
    try { return await callbackRequest(input); } catch {
      uncertainCallback = true;
      throw new Error("CPU-gate callback acknowledgement unavailable");
    }
  }
  const adapters = {
    workerName, candidateVersionId, pool, model,
    setup: (input) => control("setup", input), setupFence: (input) => control("setup-fence", input),
    inspectOperation: (input) => control("operation-inspection", input), reconcileUnused: (input) => control("reconcile-unused", input),
    closeOperation: (input) => control("close-operation", input), readSharedSlot: () => control("slot"),
    decisionContext: (input) => control("decision-context", input), callback,
    terminalize: ({ grantCredential }) => callback({ invocationClass: "terminal", grantCredential }),
    terminalizeFixture: ({ fixture }) => callback({ invocationClass: "terminal", grantCredential: fixture.grantCredential }),
    closeKnownGrants: async () => {
      let closed = true;
      for (const [grantCredential, reference] of grants) {
        if (reference.terminalConfirmed) continue;
        let confirmed = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try { await adapters.terminalize({ grantCredential }); if (reference.terminalConfirmed) { confirmed = true; break; } }
          catch { /* Retain this credential and continue cleanup of other grants. */ }
        }
        if (!confirmed) closed = false;
      }
      return { closed: closed && !uncertainCallback };
    },
    prepareFixture: async ({ fixture, invocationClass }) => {
      if (["renewal_normal", "activation_replay", "terminal_normal", "terminal_replay"].includes(invocationClass)) {
        const activated = await callback({ invocationClass: "activation", grantCredential: fixture.grantCredential });
        if (activated.status !== 200 || activated.scriptVersionId !== candidateVersionId || activated.activated !== true) throw new Error("Fixture activation failed");
      }
      if (invocationClass === "terminal_replay") {
        const terminal = await adapters.terminalizeFixture({ fixture });
        if (terminal.status !== 200 || terminal.scriptVersionId !== candidateVersionId || terminal.accepted !== true || !["released", "settled"].includes(terminal.state)) throw new Error("Fixture terminal preparation failed");
      }
    },
    isSuccessfulSample: (response, identity, mode) => {
      if (response.scriptVersionId !== candidateVersionId) return false;
      switch (identity.invocationClass) {
        case "ingress": return mode === "stage2-series" ? response.status === 403 && response.outcome === "model_requires_paid" : response.status >= 200 && response.status < 300;
        case "decision": return response.status === 200 && (mode === "stage2-series" ? response.kind === "reject" && response.code === "model_requires_paid" : response.kind === "allow" && typeof response.grantCredential === "string");
        case "activation_normal": return response.status === 200 && response.activated === true;
        case "activation_replay": return response.status === 200 && response.activated === false && response.code === "grant_replayed";
        case "renewal_normal": return response.status === 200 && response.renewed === true;
        case "terminal_normal":
        case "terminal_replay": return response.status === 200 && response.accepted === true && ["settled", "released", "reconciled_consumed", "reconciled_unused"].includes(response.state);
        default: return false;
      }
    },
    previewPreflight: async () => {
      const requestId = createRequestId();
      const body = { version: 1, pool, requestId };
      for (const token of [undefined, "invalid-cpu-gate-preflight", serviceToken]) {
        const probe = await request(PREFIX + "decision-context", { token, body, discardBody: true });
        if (probe.status !== 401) throw new Error("Preview auth separation not proven");
      }
      if (!clientKey || !model) throw new Error("Preview client/model unavailable");
      const registry = await request("/v1/models", { token: clientKey });
      if (registry.status !== 200 || !Array.isArray(registry.body?.data) || !registry.body.data.some((entry) => entry.id === model)) throw new Error("Preview model unavailable");
      const context = await control("decision-context", { requestId });
      if (context?.requestId !== requestId || !context.contextToken) throw new Error("Preview context unavailable");
      const decision = await callback({ invocationClass: "decision", model, workload: buildWorkload("baseline-small"), headers: { "X-OCTG-Relay-Context": context.contextToken } });
      let closed = false;
      if (decision.grantCredential) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const terminal = await adapters.terminalize({ grantCredential: decision.grantCredential });
            if (terminal.status === 200 && terminal.accepted === true && ["settled", "released"].includes(terminal.state)) { closed = true; break; }
          } catch { /* Retry the same credential, never create a replacement. */ }
        }
      }
      if (!closed || decision.status !== 200 || decision.kind !== "allow" || decision.quota?.pool !== pool || decision.scriptVersionId !== candidateVersionId) throw new Error("Preview normal admission/cleanup not proven");
      return { ready: true };
    },
    runPreflight: async ({ runId, model: rejectModel }) => {
      if (rejectModel !== "octg-cpu-gate-reject-v1") throw new Error("Invalid reject-model preflight");
      const requestId = createRequestId();
      const context = await control("decision-context", { requestId });
      if (!context?.contextToken) throw new Error("Preflight context unavailable");
      const response = await callback({ invocationClass: "decision", model: rejectModel, workload: buildWorkload("baseline-small"),
        headers: { "X-OCTG-Relay-Context": context.contextToken } });
      if (response.grantCredential) {
        await adapters.terminalize({ grantCredential: response.grantCredential });
        throw new Error("Reject-model preflight unexpectedly admitted a grant");
      }
      if (response.status !== 200 || response.scriptVersionId !== candidateVersionId || response.kind !== "reject" || response.code !== "model_requires_paid") {
        throw new Error("Reject-model preflight failed");
      }
      return { runId, model: rejectModel, outcome: "model_requires_paid", admissionCreated: false, grantCreated: false };
    },
  };
  return adapters;
}
