import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const INVOCATIONS_QUERY_ID = "octg-relay-cpu-invocations-v1";
export const COMPLETENESS_QUERY_ID = "octg-relay-cpu-completeness-v1";
const ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";
const MAX_PAGES_PER_WINDOW = 1000;

function makeQuery(options, window, view, offset) {
  const parameters = { datasets: ["cloudflare-workers"], filters: [{ key: "$workers.scriptName", type: "string", operation: "eq", value: options.scriptName }, { key: "$workers.scriptVersion.id", type: "string", operation: "eq", value: options.expectedScriptVersionId }, { key: "$workers.executionModel", type: "string", operation: "eq", value: options.expectedExecutionModel }] };
  if (view === "calculations") parameters.calculations = [{ operator: "uniq", key: "$metadata.requestId", keyType: "string", alias: "platform_invocation_count" }];
  return { queryId: view === "invocations" ? INVOCATIONS_QUERY_ID : COMPLETENESS_QUERY_ID, view,
    timeframe: { from: window.windowStartMs, to: window.windowEndMs },
    ...(view === "invocations" ? { limit: 2000 } : { chartType: "aggregate", ignoreSeries: true }),
    ...(offset ? { offset, offsetDirection: "next" } : {}), parameters };
}

function eventTimestampOf(event) {
  const meta = event?.$metadata;
  const value = event?.timestamp ?? meta?.eventTimestampMs ?? meta?.timestamp;
  return typeof value === "number" ? value : undefined;
}

function withinWindow(timestampMs, window) {
  return timestampMs >= window.windowStartMs && timestampMs < window.windowEndMs;
}

function normalizedRouteOf(event) {
  const meta = event?.$metadata;
  const url = typeof meta?.url === "string" ? new URL(meta.url) : undefined;
  const trigger = typeof meta?.trigger === "string" ? new URL(meta.trigger, "https://local.invalid") : undefined;
  if (url && trigger && url.pathname !== trigger.pathname) throw new Error("Invocation route disagreement");
  const routeDiscriminator = url?.pathname ?? trigger?.pathname;
  if (!routeDiscriminator) throw new Error("Invocation route unavailable");
  return routeDiscriminator;
}

function eventFingerprint(event) {
  const meta = event?.$metadata;
  const workers = event?.$workers ?? {};
  return JSON.stringify({
    scriptName: typeof workers.scriptName === "string" ? workers.scriptName : null,
    scriptVersionId: typeof workers.scriptVersion?.id === "string" ? workers.scriptVersion.id : null,
    executionModel: typeof workers.executionModel === "string" ? workers.executionModel : null,
    eventType: typeof workers.eventType === "string" ? workers.eventType : null,
    outcome: typeof workers.outcome === "string" ? workers.outcome : null,
    cpuTimeMs: typeof workers.cpuTimeMs === "number" ? workers.cpuTimeMs : null,
    truncated: workers.truncated === true,
    url: typeof meta?.url === "string" ? meta.url : null,
    trigger: typeof meta?.trigger === "string" ? meta.trigger : null,
    eventTimestampMs: eventTimestampOf(event) ?? null,
    eventRequestId: meta?.requestId ?? null,
    workersRequestId: typeof workers.requestId === "string" ? workers.requestId : null,
  });
}

/**
 * Parses one invocation group into its normalized CPU record plus scope facts.
 * Exactly one distinct CPU-bearing event must exist per group; marker events
 * never become the CPU record; exact-duplicate event ids are de-duplicated
 * once per run while conflicting duplicates fail closed.
 */
function parseGroup(groupRequestId, rawEvents, scope) {
  if (!Array.isArray(rawEvents)) throw new Error("Malformed invocation group");
  let cpuRecord;
  const groupSeenIds = new Set();
  const truncated = [];
  let inScopeEvents = 0;
  for (const event of rawEvents) {
    const workers = event?.$workers;
    const meta = event?.$metadata;
    const timestamp = eventTimestampOf(event);
    const eventId = typeof meta?.id === "string" ? meta.id : undefined;
    if (!eventId) throw new Error("Platform event ID unavailable");
    if (eventId !== undefined) {
      const fingerprint = eventFingerprint(event);
      const prior = scope.globalEvents.get(eventId);
      if (prior === undefined) {
        scope.globalEvents.set(eventId, fingerprint);
      } else if (prior !== fingerprint) {
        throw new Error("Conflicting duplicate CPU event");
      }
      if (!scope.windowEvents.has(eventId)) { scope.windowEvents.add(eventId); scope.pageNewEvents += 1; }
    }
    if (!workers || typeof workers.scriptName !== "string" || typeof workers.scriptVersion?.id !== "string"
      || typeof workers.executionModel !== "string" || !Number.isSafeInteger(timestamp)) throw new Error("Incomplete platform invocation");
    if ([meta?.requestId, workers.requestId].some((id) => id !== undefined && id !== groupRequestId)) {
      throw new Error("Invocation request identity contradiction");
    }
    const inScope = workers?.scriptName === scope.scriptName
      && workers?.scriptVersion?.id === scope.expectedScriptVersionId
      && workers?.executionModel === scope.expectedExecutionModel
      && timestamp !== undefined
      && withinWindow(timestamp, scope.window);
    if (!inScope) continue;
    inScopeEvents += 1;
    if (workers.truncated === true) truncated.push(timestamp);
    if (workers.cpuTimeMs === undefined) continue;
    if (!Number.isFinite(workers.cpuTimeMs) || workers.cpuTimeMs < 0) throw new Error("Invalid platform CPU time");
    if (eventId !== undefined && groupSeenIds.has(eventId)) continue;
    if (eventId !== undefined) groupSeenIds.add(eventId);
    if (typeof workers.scriptVersion?.id !== "string" || typeof workers.scriptName !== "string" || typeof workers.outcome !== "string" || typeof workers.eventType !== "string" || typeof workers.executionModel !== "string" || typeof timestamp !== "number") throw new Error("Incomplete platform invocation");
    const previousCpuId = scope.groupCpuIds.get(groupRequestId);
    if (previousCpuId !== undefined && previousCpuId !== eventId) throw new Error("Conflicting CPU events across invocation pages");
    scope.groupCpuIds.set(groupRequestId, eventId);
    const routeDiscriminator = normalizedRouteOf(event);
    const requestIds = [meta?.requestId, workers.requestId].filter((value) => typeof value === "string");
    if (requestIds.some((value) => value !== groupRequestId)) throw new Error("Invocation request identity contradiction");
    if (groupSeenIds.size > 1) throw new Error("Invocation group must have exactly one CPU event");
    if (eventId !== undefined && scope.recordEventIds.has(eventId)) continue;
    if (eventId !== undefined) scope.recordEventIds.add(eventId);
    cpuRecord = {
      ...(eventId === undefined ? {} : { eventId }),
      requestId: groupRequestId,
      eventTimestampMs: timestamp,
      scriptName: workers.scriptName,
      scriptVersionId: workers.scriptVersion.id,
      cpuTimeMs: workers.cpuTimeMs,
      outcome: workers.outcome,
      eventType: workers.eventType,
      routeDiscriminator,
      executionModel: workers.executionModel,
    };
  }
  if (inScopeEvents > 0 && groupSeenIds.size === 0) throw new Error("Invocation group must have exactly one CPU event");
  return { record: cpuRecord, truncated };
}

async function queryTelemetry(options, query, fetchImpl) {
  const response = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(options.env.CLOUDFLARE_ACCOUNT_ID)}/workers/observability/telemetry/query`, { method: "POST", headers: { Authorization: `Bearer ${options.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(query) });
  if (!response.ok) throw new Error(`Workers Observability query failed (${response.status})`);
  const body = await response.json();
  if (body?.success !== true || body.result === undefined) throw new Error("Workers Observability returned an incomplete result");
  if (body.result.run?.status !== "COMPLETED" || !body.result.statistics
    || (body.result.statistics.abr_level ?? 1) !== 1) throw new Error("Workers Observability returned incomplete or sampled query data");
  return body.result;
}

function validateWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) throw new TypeError("Windows must be a non-empty array");
  for (const window of windows) {
    if (!Number.isSafeInteger(window?.windowStartMs) || !Number.isSafeInteger(window?.windowEndMs) || window.windowEndMs <= window.windowStartMs) {
      throw new TypeError("Telemetry windows must be half-open [windowStartMs, windowEndMs)");
    }
  }
  for (const index in windows) {
    const window = windows[index];
    for (const other of windows.slice(Number(index) + 1)) {
      if (other.windowStartMs < window.windowEndMs && window.windowStartMs < other.windowEndMs) {
        throw new TypeError("Telemetry windows must be non-overlapping");
      }
    }
  }
  return windows;
}

export async function fetchRelayCpuTelemetry(options) {
  const env = options.env ?? process.env;
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required in environment");
  if (options.expectedExecutionModel !== "stateless" || !options.scriptName || !options.expectedScriptVersionId) throw new TypeError("Exact stateless Worker identity required");
  const windows = validateWindows(options.windows);
  const safeOptions = { ...options, env };
  const fetchImpl = options.fetchImpl ?? fetch;
  const allRecords = [];
  const windowMeta = [];
  const globalEvents = new Map();
  const recordEventIds = new Set();
  const groupCpuIds = new Map();
  let paginationComplete = true;
  let truncationObserved = false;
  for (const window of windows) {
    const scope = { scriptName: options.scriptName, expectedScriptVersionId: options.expectedScriptVersionId, expectedExecutionModel: options.expectedExecutionModel, window, globalEvents, recordEventIds, groupCpuIds, windowEvents: new Set(), pageNewEvents: 0 };
    const records = [];
    const truncatedTimestamps = [];
    let offset;
    let windowPaginationComplete = false;
    const seenCursors = new Set();
    for (let page = 0; page < MAX_PAGES_PER_WINDOW; page += 1) {
      scope.pageNewEvents = 0;
      const result = await queryTelemetry(safeOptions, makeQuery(safeOptions, window, "invocations", offset), fetchImpl);
      const groups = result?.invocations;
      if (groups === null || typeof groups !== "object" || Array.isArray(groups)) throw new Error("Malformed invocations response");
      const flat = Object.values(groups).flat();
      for (const [groupRequestId, rawEvents] of Object.entries(groups)) {
        const { record, truncated } = parseGroup(groupRequestId, rawEvents, scope);
        if (record) records.push(record);
        truncatedTimestamps.push(...truncated);
      }
      if (flat.length === 0) { windowPaginationComplete = true; break; }
      const cursor = flat.at(-1)?.$metadata?.id;
      if (typeof cursor !== "string" || seenCursors.has(cursor)) {
        windowPaginationComplete = false;
        break;
      }
      if (scope.pageNewEvents === 0) { windowPaginationComplete = true; break; }
      seenCursors.add(cursor);
      offset = cursor;
    }
    allRecords.push(...records);
    const result = await queryTelemetry(safeOptions, makeQuery(safeOptions, window, "calculations"), fetchImpl);
    const calc = result?.calculations;
    const aggregate = Array.isArray(calc) ? calc : [];
    const values = aggregate.length === 1 && aggregate[0].alias === "platform_invocation_count" ? aggregate[0].aggregates : undefined;
    const count = Array.isArray(values) && values.length === 1 ? values[0] : undefined;
    const valid = Number.isSafeInteger(count?.value) && count.value >= 0;
    const value = valid ? count.value : null;
    const interval = Number.isFinite(count?.sampleInterval) ? count.sampleInterval : null;
    const truncatedHere = truncatedTimestamps.filter((timestamp) => withinWindow(timestamp, window)).length > 0;
    windowMeta.push({
      windowStartMs: window.windowStartMs,
      windowEndMs: window.windowEndMs,
      paginationComplete: windowPaginationComplete,
      truncationObserved: truncatedHere,
      sampleInterval: interval,
      platformInvocationCount: value,
    });
    paginationComplete = paginationComplete && windowPaginationComplete;
    truncationObserved = truncationObserved || truncatedHere;
  }
  const normalizedCountInWindow = (window) => allRecords.filter((record) => record.eventTimestampMs >= window.windowStartMs && record.eventTimestampMs < window.windowEndMs).length;
  const samplingVerified = paginationComplete && truncationObserved === false && windowMeta.every((window) => window.sampleInterval === 1 && window.platformInvocationCount !== null && window.platformInvocationCount === normalizedCountInWindow(window));
  const meta = {
    version: 1,
    samplingVerified,
    normalizedInvocationCount: allRecords.length,
    paginationComplete,
    truncationObserved,
    queryComplete: paginationComplete && windowMeta.every((window) => window.platformInvocationCount !== null),
    windows: windowMeta,
  };
  if (options.outputPath || options.metaOutputPath) await persistProtectedExports(options, allRecords, meta);
  return { records: allRecords, meta };
}


async function persistProtectedExports(options, allRecords, meta) {
  if (options.outputPath) {
    await mkdir(dirname(options.outputPath), { recursive: true, mode: 0o700 });
    await writeFile(options.outputPath, allRecords.map((record) => JSON.stringify(record)).join("\n") + (allRecords.length ? "\n" : ""), { mode: 0o600 });
    await chmod(options.outputPath, 0o600);
  }
  if (options.metaOutputPath) {
    await mkdir(dirname(options.metaOutputPath), { recursive: true, mode: 0o700 });
    await writeFile(options.metaOutputPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    await chmod(options.metaOutputPath, 0o600);
  }
}

export async function runTelemetryCli(argv = process.argv.slice(2)) {
  const args = Object.fromEntries(argv.map((item) => { const [key, ...value] = item.split("="); return [key, value.join("=")]; }));
  const allowed = new Set(["--help", "--script-name", "--script-version", "--execution-model", "--windows-json", "--out", "--meta-out"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) throw new TypeError("Unknown telemetry argument");
  if ("--help" in args) { console.log("--script-name --script-version --execution-model=stateless --windows-json --out --meta-out"); return 0; }
  for (const name of ["--script-name", "--script-version", "--execution-model", "--windows-json", "--out", "--meta-out"]) if (!args[name]) throw new TypeError(`Missing ${name}`);
  if (args["--execution-model"] !== "stateless") throw new TypeError("execution model must be stateless");
  const windows = JSON.parse(await readFile(args["--windows-json"], "utf8"));
  const result = await fetchRelayCpuTelemetry({ scriptName: args["--script-name"], expectedScriptVersionId: args["--script-version"], expectedExecutionModel: "stateless", windows: windows.map(([windowStartMs, windowEndMs]) => ({ windowStartMs, windowEndMs })), outputPath: args["--out"], metaOutputPath: args["--meta-out"] });
  console.log(JSON.stringify({ normalizedInvocationCount: result.meta.normalizedInvocationCount, samplingVerified: result.meta.samplingVerified }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runTelemetryCli().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error instanceof Error ? error.message : "Telemetry failed"); process.exitCode = 1; });
