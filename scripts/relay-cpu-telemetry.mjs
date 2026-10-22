import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const INVOCATIONS_QUERY_ID = "octg-relay-cpu-invocations-v1";
export const COMPLETENESS_QUERY_ID = "octg-relay-cpu-completeness-v1";
const ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";

function makeQuery(options, window, view, offset) {
  const parameters = { timeFilter: { from: new Date(window.windowStartMs).toISOString(), to: new Date(window.windowEndMs).toISOString() }, filters: [{ key: "$workers.scriptName", operation: "eq", value: options.scriptName }, { key: "$workers.scriptVersion.id", operation: "eq", value: options.expectedScriptVersionId }, { key: "$workers.executionModel", operation: "eq", value: options.expectedExecutionModel }] };
  if (view === "invocations") parameters.limit = 2000;
  if (offset) { parameters.offset = offset; parameters.offsetDirection = "next"; }
  if (view === "calculations") parameters.calculations = [{ operator: "uniq", key: "$metadata.requestId", keyType: "string", alias: "platform_invocation_count" }];
  return { queryId: view === "invocations" ? INVOCATIONS_QUERY_ID : COMPLETENESS_QUERY_ID, view, dataset: "cloudflare-workers", ...(view === "calculations" ? { chartType: "aggregate", ignoreSeries: true } : {}), parameters };
}

function getRecords(result) {
  const groups = result?.invocations;
  if (groups === null || typeof groups !== "object") throw new Error("Malformed invocations response");
  return Object.entries(groups).map(([requestId, events]) => {
    if (!Array.isArray(events)) throw new Error("Malformed invocation group");
    const cpuEvents = events.filter((event) => typeof event?.$workers?.cpuTimeMs === "number");
    const uniqueCpuEvents = new Map();
    for (const candidate of cpuEvents) {
      const candidateId = candidate.$metadata?.id;
      if (typeof candidateId !== "string") throw new Error("Invocation event ID unavailable");
      const prior = uniqueCpuEvents.get(candidateId);
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(candidate)) throw new Error("Conflicting duplicate CPU event");
      uniqueCpuEvents.set(candidateId, candidate);
    }
    if (uniqueCpuEvents.size !== 1) throw new Error("Invocation group must have exactly one CPU event");
    const event = [...uniqueCpuEvents.values()][0];
    const workers = event.$workers;
    const metadata = event.$metadata;
    const scriptVersionId = workers.scriptVersion?.id;
    const timestamp = metadata.eventTimestampMs ?? metadata.timestamp;
    if (typeof scriptVersionId !== "string" || typeof workers.scriptName !== "string" || typeof workers.outcome !== "string" || typeof workers.eventType !== "string" || typeof workers.executionModel !== "string" || typeof timestamp !== "number") throw new Error("Incomplete platform invocation");
    if (workers.truncated === true) throw new Error("Truncated platform invocation");
    const url = typeof metadata.url === "string" ? new URL(metadata.url) : undefined;
    const trigger = typeof metadata.trigger === "string" ? new URL(metadata.trigger, "https://local.invalid") : undefined;
    if (url && trigger && url.pathname !== trigger.pathname) throw new Error("Invocation route disagreement");
    const routeDiscriminator = url?.pathname ?? trigger?.pathname;
    if (!routeDiscriminator) throw new Error("Invocation route unavailable");
    const eventId = metadata.id;
    if (typeof eventId !== "string") throw new Error("Invocation event ID unavailable");
    const requestIds = [metadata.requestId, workers.requestId].filter((value) => typeof value === "string");
    if (requestIds.some((value) => value !== requestId)) throw new Error("Invocation request identity contradiction");
    return { eventId, requestId, eventTimestampMs: timestamp, scriptName: workers.scriptName, scriptVersionId, cpuTimeMs: workers.cpuTimeMs, outcome: workers.outcome, eventType: workers.eventType, routeDiscriminator, executionModel: workers.executionModel };
  });
}

async function queryTelemetry(options, query, fetchImpl) {
  const response = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(options.env.CLOUDFLARE_ACCOUNT_ID)}/workers/observability/telemetry/query`, { method: "POST", headers: { Authorization: `Bearer ${options.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(query) });
  if (!response.ok) throw new Error(`Workers Observability query failed (${response.status})`);
  const body = await response.json();
  if (body?.success !== true || body.result === undefined) throw new Error("Workers Observability returned an incomplete result");
  return body.result;
}

export async function fetchRelayCpuTelemetry(options) {
  const env = options.env ?? process.env;
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required in environment");
  const safeOptions = { ...options, env };
  const fetchImpl = options.fetchImpl ?? fetch;
  const allRecords = [];
  const windowMeta = [];
  let paginationComplete = true;
  let truncationObserved = false;
  for (const window of options.windows) {
    let offset;
    const seen = new Set();
    let pagesDone = false;
    while (!pagesDone) {
      const result = await queryTelemetry(safeOptions, makeQuery(safeOptions, window, "invocations", offset), fetchImpl);
      const records = getRecords(result);
      const entries = Object.values(result.invocations);
      const nextCursor = entries.flat().at(-1)?.$metadata?.id;
      allRecords.push(...records.filter((record) => record.eventTimestampMs >= window.windowStartMs && record.eventTimestampMs < window.windowEndMs && record.scriptName === options.scriptName && record.scriptVersionId === options.expectedScriptVersionId && record.executionModel === options.expectedExecutionModel));
      if (entries.length === 0) pagesDone = true;
      else if (typeof nextCursor !== "string" || seen.has(nextCursor)) throw new Error("Telemetry pagination cannot be proven complete");
      else { seen.add(nextCursor); offset = nextCursor; }
    }
    const result = await queryTelemetry(safeOptions, makeQuery(safeOptions, window, "calculations"), fetchImpl);
    const calc = result.calculations;
    const aggregate = Array.isArray(calc) ? calc : [];
    if (aggregate.length !== 1) throw new Error("Completeness aggregate unavailable");
    const value = aggregate[0].value;
    const interval = aggregate[0].sampleInterval;
    const normalized = allRecords.filter((record) => record.eventTimestampMs >= window.windowStartMs && record.eventTimestampMs < window.windowEndMs).length;
    const countValid = Number.isSafeInteger(value) && value >= 0;
    windowMeta.push({ ...window, paginationComplete: true, truncationObserved: false, sampleInterval: Number.isFinite(interval) ? interval : null, platformInvocationCount: countValid ? value : null });
    if (!countValid || interval !== 1 || value !== normalized) paginationComplete = paginationComplete && countValid;
  }
  const meta = { version: 1, samplingVerified: paginationComplete && windowMeta.every((item) => item.sampleInterval === 1 && item.platformInvocationCount !== null && item.platformInvocationCount === allRecords.filter((record) => record.eventTimestampMs >= item.windowStartMs && record.eventTimestampMs < item.windowEndMs).length), normalizedInvocationCount: allRecords.length, paginationComplete, truncationObserved, queryComplete: true, windows: windowMeta };
  await mkdir(dirname(options.outputPath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(options.metaOutputPath), { recursive: true, mode: 0o700 });
  await writeFile(options.outputPath, allRecords.map((record) => JSON.stringify(record)).join("\n") + (allRecords.length ? "\n" : ""), { mode: 0o600 });
  await writeFile(options.metaOutputPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  return { records: allRecords, meta };
}

export async function runTelemetryCli(argv = process.argv.slice(2)) {
  const args = Object.fromEntries(argv.map((item) => { const [key, ...value] = item.split("="); return [key, value.join("=")]; }));
  if ("--help" in args) { console.log("--script-name --script-version --execution-model=stateless --windows-json --out --meta-out"); return 0; }
  for (const name of ["--script-name", "--script-version", "--execution-model", "--windows-json", "--out", "--meta-out"]) if (!args[name]) throw new TypeError(`Missing ${name}`);
  if (args["--execution-model"] !== "stateless") throw new TypeError("execution model must be stateless");
  const windows = JSON.parse(await readFile(args["--windows-json"], "utf8"));
  const result = await fetchRelayCpuTelemetry({ scriptName: args["--script-name"], expectedScriptVersionId: args["--script-version"], expectedExecutionModel: "stateless", windows: windows.map(([windowStartMs, windowEndMs]) => ({ windowStartMs, windowEndMs })), outputPath: args["--out"], metaOutputPath: args["--meta-out"] });
  console.log(JSON.stringify({ normalizedInvocationCount: result.meta.normalizedInvocationCount, samplingVerified: result.meta.samplingVerified }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runTelemetryCli().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error instanceof Error ? error.message : "Telemetry failed"); process.exitCode = 1; });
