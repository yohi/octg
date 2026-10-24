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
  for (const call of calls) {
    if (!Number.isSafeInteger(call?.callOrdinal) || call.callOrdinal < 1 || ordinals.has(call.callOrdinal)) return "invalid call ordinal";
    ordinals.add(call.callOrdinal);
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

function percentile99(records) {
  const values = [...records].map((record) => record.cpuTimeMs).sort((a, b) => a - b);
  return values[Math.ceil(values.length * 0.99) - 1] ?? 0;
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
  if (!Array.isArray(records) || records.some((record) => !record || !Number.isFinite(record.cpuTimeMs)
    || record.cpuTimeMs < 0 || !Number.isSafeInteger(record.eventTimestampMs)
    || !isNonEmptyString(record.eventId) || !isNonEmptyString(record.requestId)
    || !isNonEmptyString(record.outcome) || !isNonEmptyString(record.eventType))
    || new Set(records.map((record) => record.eventId)).size !== records.length) {
    return { status: "BLOCKED", reason: "invalid normalized platform records" };
  }
  const windows = metadata?.windows ?? [];
  if (windows.some((window, index) => windows.slice(index + 1).some((other) => window.windowStartMs < other.windowEndMs && other.windowStartMs < window.windowEndMs))) {
    return { status: "BLOCKED", reason: "overlapping windows" };
  }
  const routes = SERIES_ROUTES[expected?.invocationClass];
  if (routes === undefined) return { status: "BLOCKED", reason: "ambiguous invocation route" };
  const identityError = seriesIdentityError(expected);
  if (identityError !== undefined) return { status: "BLOCKED", reason: identityError };
  const ledgerError = ledgerIdentityError(expected, routes);
  if (ledgerError !== undefined) return { status: "BLOCKED", reason: ledgerError };
  if (!exactWindowIdentity(expected.windows, windows)) return { status: "BLOCKED", reason: "telemetry window identity mismatch" };

  const inScope = (records ?? []).filter((record) =>
    record.scriptVersionId === expected.candidateScriptVersion
    && record.scriptName === expected.scriptName
    && record.executionModel === "stateless"
    && routes.includes(record.routeDiscriminator)
    && windows.some((window) => withinWindow(record, window)));
  if (inScope.length !== (records ?? []).length) {
    return { status: "BLOCKED", reason: "telemetry record outside the expected series scope" };
  }

  const cpuViolation = inScope.some((record) => record.outcome === "exceededCpu")
    || inScope.some((record) => record.cpuTimeMs > CPU_GATE.maxMs) || percentile99(inScope) > CPU_GATE.p99MaxMs;
  if (cpuViolation) {
    return {
      status: "FAIL",
      cpuTimesMs: inScope.map((record) => record.cpuTimeMs),
      exceededCpu: inScope.filter((record) => record.outcome === "exceededCpu").length,
      p99: percentile99(inScope),
      max: Math.max(...inScope.map((record) => record.cpuTimeMs), 0),
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
      && inScope.filter((record) => withinWindow(record, window)).length === window.platformInvocationCount;
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
    && platformTotal === inScope.length
    && metadata?.normalizedInvocationCount === records?.length
    && metadata?.normalizedInvocationCount === assigned.length
    && assigned.length === expected.expectedSuccessfulInvocations
    && (expected.calls ?? []).length === assigned.length;
  if (!complete) {
    return { status: "BLOCKED", reason: "incomplete or mismatched telemetry", matchedInvocations: assigned.length };
  }

  const values = assigned.map((record) => record.cpuTimeMs).sort((a, b) => a - b);
  const p99 = values[Math.ceil(values.length * 0.99) - 1] ?? 0;
  const max = values.at(-1) ?? 0;
  if (p99 > CPU_GATE.p99MaxMs || max > CPU_GATE.maxMs) return { status: "FAIL", p99, max, exceededCpu: 0 };
  return { status: "PASS", p99, max, exceededCpu: 0, matchedInvocations: assigned.length };
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
