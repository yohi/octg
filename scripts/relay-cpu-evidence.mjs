import { readFile, writeFile, chmod } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const CPU_GATE = Object.freeze({ p99MaxMs: 5, maxMs: 7, exceededCpu: 0 });

const SERIES_ROUTES = Object.freeze({
  ingress: ["/v1/responses"],
  decision: ["/internal/relay/v1/decision"],
  activation_normal: ["/internal/relay/v1/activation"],
  activation_replay: ["/internal/relay/v1/activation"],
  renewal_normal: ["/internal/relay/v1/renewal"],
  terminal_normal: ["/internal/relay/v1/terminal"],
  terminal_replay: ["/internal/relay/v1/terminal"],
});

const STAGES = new Set(["stage1", "stage2-series"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isMeasurementId(value) {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function exactWindowIdentity(expectedWindows, windows) {
  if (!Array.isArray(expectedWindows) || expectedWindows.length === 0) return false;
  if (!Array.isArray(windows) || expectedWindows.length !== windows.length) return false;
  return expectedWindows.every((window, index) => {
    const actual = windows[index];
    return actual !== undefined
      && actual.windowStartMs === window.windowStartMs
      && actual.windowEndMs === window.windowEndMs;
  });
}

function seriesIdentityError(expected) {
  const identity = expected ?? {};
  for (const key of ["scriptName", "candidateScriptVersion", "candidateSourceRevision", "invocationClass", "workloadClass"]) {
    if (!isNonEmptyString(identity[key])) return `incomplete series identity (${key})`;
  }
  if (!STAGES.has(identity.stage)) return "incomplete series identity (stage)";
  if (!Number.isSafeInteger(identity.concurrency) || identity.concurrency < 1) return "incomplete series identity (concurrency)";
  return undefined;
}

function ledgerIdentityError(expected, routes) {
  const calls = expected.calls ?? [];
  if (calls.length === 0) return "ledger has no recorded measurement calls";
  const ordinals = new Set();
  const measurementIds = new Set();
  for (const call of calls) {
    if (!Number.isSafeInteger(call?.callOrdinal) || call.callOrdinal < 1 || ordinals.has(call.callOrdinal)) return "invalid call ordinal";
    ordinals.add(call.callOrdinal);
    if (!isMeasurementId(call?.measurementId) || measurementIds.has(call.measurementId)) return "invalid measurement correlation ID";
    measurementIds.add(call.measurementId);
    if (call?.stage !== expected.stage) return "ledger call stage drift";
    if (call?.invocationClass !== expected.invocationClass) return "ledger call invocation class drift";
    if (call?.workloadClass !== expected.workloadClass) return "ledger call workload drift";
    if (call?.concurrency !== expected.concurrency) return "ledger call concurrency drift";
    if (call?.candidateSourceRevision !== expected.candidateSourceRevision) return "ledger call source revision drift";
    if (!SERIES_ROUTES[expected.invocationClass].includes(call?.routeDiscriminator) || !routes.includes(call?.routeDiscriminator)) {
      return "ledger call route drift";
    }
    if (!Number.isSafeInteger(call?.timestampMs)) return "ledger call timestamp missing";
  }
  return undefined;
}

function cpuDistribution(records) {
  const values = records.map((record) => record.cpuTimeMs).sort((a, b) => a - b);
  const percentile = (ratio) => values[Math.ceil(values.length * ratio) - 1] ?? 0;
  return {
    p50: percentile(0.5),
    p90: percentile(0.9),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: values.at(-1) ?? 0,
  };
}

function successfulCall(call, expected) {
  if (!Number.isInteger(call.status) || call.success === false) return false;
  if (call.status >= 200 && call.status < 300) return true;
  return expected.stage === "stage2-series" && expected.invocationClass === "ingress"
    && call.status === 403 && call.success === true && call.outcomeHint === "model_requires_paid";
}

function withinWindow(record, window) {
  return record.eventTimestampMs >= window.windowStartMs && record.eventTimestampMs < window.windowEndMs;
}

function correlatedAssignments(records, windows, expected) {
  const remaining = new Set([...records].sort((a, b) => a.eventTimestampMs - b.eventTimestampMs || a.eventId.localeCompare(b.eventId)));
  const assigned = [];
  const tolerance = expected.timestampToleranceMs ?? 1000;
  for (const call of [...expected.calls].sort((a, b) => a.callOrdinal - b.callOrdinal)) {
    let candidate;
    for (const record of remaining) {
      if (record.routeDiscriminator !== call.routeDiscriminator) continue;
      if (record.measurementId !== call.measurementId) continue;
      const window = windows.find((item) => withinWindow(record, item));
      if (window === undefined) continue;
      const distance = Math.abs(record.eventTimestampMs - call.timestampMs);
      if (distance > tolerance) continue;
      if (distance <= tolerance) { candidate = record; break; }
    }
    if (candidate !== undefined) { remaining.delete(candidate); assigned.push(candidate); }
  }
  return { assigned, unassigned: [...remaining] };
}

export function evaluateCpuSeries(records, metadata, expected) {
  if (!Array.isArray(records)) {
    return { status: "BLOCKED", reason: "invalid normalized platform records" };
  }
  const routes = SERIES_ROUTES[expected?.invocationClass];
  const siblingRoutes = new Set(Object.values(SERIES_ROUTES).flat().filter((route) => !routes?.includes(route)));
  if (records.some((record) => !record || !Number.isFinite(record.cpuTimeMs)
    || record.cpuTimeMs < 0 || !Number.isSafeInteger(record.eventTimestampMs)
    || !isNonEmptyString(record.eventId) || !isNonEmptyString(record.requestId)
    || (!isMeasurementId(record.measurementId) && !siblingRoutes.has(record.routeDiscriminator))
    || !isNonEmptyString(record.outcome) || !isNonEmptyString(record.eventType))
    || new Set(records.map((record) => record.eventId)).size !== records.length) {
    return { status: "BLOCKED", reason: "invalid normalized platform records" };
  }
  const targetRecords = records.filter((record) => routes?.includes(record.routeDiscriminator));
  if (targetRecords.some((record) => !isMeasurementId(record.measurementId))
    || new Set(targetRecords.map((record) => record.measurementId)).size !== targetRecords.length) {
    return { status: "BLOCKED", reason: "invalid normalized platform records" };
  }
  const windows = metadata?.windows ?? [];
  if (windows.some((window, index) => windows.slice(index + 1).some((other) => window.windowStartMs < other.windowEndMs && other.windowStartMs < window.windowEndMs))) {
    return { status: "BLOCKED", reason: "overlapping windows" };
  }
  if (routes === undefined) return { status: "BLOCKED", reason: "ambiguous invocation route" };
  const identityError = seriesIdentityError(expected);
  if (identityError !== undefined) return { status: "BLOCKED", reason: identityError };
  const ledgerError = ledgerIdentityError(expected, routes);
  if (ledgerError !== undefined) return { status: "BLOCKED", reason: ledgerError };
  if (!exactWindowIdentity(expected.windows, windows)) return { status: "BLOCKED", reason: "telemetry window identity mismatch" };

  const expectedScope = (record) => record.scriptVersionId === expected.candidateScriptVersion
    && record.scriptName === expected.scriptName
    && record.executionModel === "stateless"
    && windows.some((window) => withinWindow(record, window));
  const unknownRoute = records.some((record) => !routes.includes(record.routeDiscriminator)
    && !siblingRoutes.has(record.routeDiscriminator));
  if (unknownRoute || records.some((record) => !expectedScope(record))) {
    return { status: "BLOCKED", reason: "telemetry record outside the expected series scope" };
  }
  const inScope = (records ?? []).filter((record) =>
    record.scriptVersionId === expected.candidateScriptVersion
    && record.scriptName === expected.scriptName
    && record.executionModel === "stateless"
    && routes.includes(record.routeDiscriminator)
    && windows.some((window) => withinWindow(record, window)));
  const distribution = cpuDistribution(inScope);
  const cpuViolation = inScope.some((record) => record.outcome === "exceededCpu")
    || distribution.max > CPU_GATE.maxMs || distribution.p99 > CPU_GATE.p99MaxMs;
  if (cpuViolation) {
    return {
      status: "FAIL",
      cpuTimesMs: inScope.map((record) => record.cpuTimeMs),
      exceededCpu: inScope.filter((record) => record.outcome === "exceededCpu").length,
      ...distribution,
    };
  }

  if (!Number.isSafeInteger(expected.expectedSuccessfulInvocations) || expected.expectedSuccessfulInvocations < 500
    || expected.calls.filter((call) => successfulCall(call, expected)).length < 500) {
    return { status: "BLOCKED", reason: "fewer than 500 successful invocations" };
  }
  if (expected.calls.some((call) => !successfulCall(call, expected))) {
    return { status: "BLOCKED", reason: "unsuccessful measurement call" };
  }

  const { assigned, unassigned } = correlatedAssignments(inScope, windows, expected);
  if (unassigned.length > 0) {
    return { status: "BLOCKED", reason: "unassigned in-scope telemetry records", matchedInvocations: assigned.length };
  }

  const windowCountMatch = windows.every((window) => {
    return Number.isSafeInteger(window.platformInvocationCount) && window.platformInvocationCount >= 0
      && records.filter((record) => withinWindow(record, window)).length === window.platformInvocationCount;
  });
  const windowsComplete = windows.every((window) => window.paginationComplete === true && window.truncationObserved === false
    && window.sampleInterval === 1 && Number.isSafeInteger(window.platformInvocationCount) && window.platformInvocationCount >= 0);
  const platformTotal = windows.reduce((sum, window) => sum + (Number.isSafeInteger(window.platformInvocationCount) ? window.platformInvocationCount : 0), 0);
  const complete = metadata?.queryComplete === true
    && metadata?.samplingVerified === true
    && metadata?.paginationComplete === true
    && metadata?.truncationObserved === false
    && windowsComplete
    && windowCountMatch
    && platformTotal === records.length
    && metadata?.normalizedInvocationCount === records?.length
    && targetRecords.length === assigned.length
    && assigned.length === expected.expectedSuccessfulInvocations
    && (expected.calls ?? []).length === assigned.length;
  if (!complete) {
    return { status: "BLOCKED", reason: "incomplete or mismatched telemetry", matchedInvocations: assigned.length };
  }

  if (distribution.p99 > CPU_GATE.p99MaxMs || distribution.max > CPU_GATE.maxMs) {
    return { status: "FAIL", ...distribution, exceededCpu: 0 };
  }
  return { status: "PASS", ...distribution, exceededCpu: 0, matchedInvocations: assigned.length };
}

export async function runEvidenceCli(argv = process.argv.slice(2)) {
  const allowed = new Set(["--ledger", "--telemetry", "--telemetry-meta", "--out", "--help"]);
  const args = {};
  for (const argument of argv) {
    const [key, ...parts] = argument.split("=");
    if (!allowed.has(key) || key in args) throw new TypeError("Unknown or duplicate evidence argument");
    args[key] = parts.join("=");
  }
  if ("--help" in args) { console.log("--ledger --telemetry --telemetry-meta --out"); return 0; }
  for (const key of ["--ledger", "--telemetry", "--telemetry-meta", "--out"]) if (!args[key]) throw new TypeError(`Missing ${key}`);
  const expected = JSON.parse(await readFile(args["--ledger"], "utf8"));
  const metadata = JSON.parse(await readFile(args["--telemetry-meta"], "utf8"));
  const records = (await readFile(args["--telemetry"], "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const result = evaluateCpuSeries(records, metadata, expected);
  await writeFile(args["--out"], `${JSON.stringify(result)}\n`, { mode: 0o600 });
  await chmod(args["--out"], 0o600);
  return result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEvidenceCli().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("CPU evidence evaluation failed"); process.exitCode = 2;
  });
}
