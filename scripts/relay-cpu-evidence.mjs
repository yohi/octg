export const CPU_GATE = Object.freeze({ p99MaxMs: 5, maxMs: 7, exceededCpu: 0 });

export function evaluateCpuSeries(records, metadata, expected) {
  const windows = metadata?.windows ?? [];
  if (windows.some((window, index) => windows.slice(index + 1).some((other) => window.windowStartMs < other.windowEndMs && other.windowStartMs < window.windowEndMs))) return { status: "BLOCKED", reason: "overlapping windows" };
  const routes = routeFor(expected.invocationClass);
  if (routes === undefined) return { status: "BLOCKED", reason: "ambiguous invocation route" };
  const assigned = [];
  const used = new Set();
  for (const call of expected.calls ?? []) {
    const window = windows.find((item) => call.timestampMs >= item.windowStartMs && call.timestampMs < item.windowEndMs);
    const record = records.find((item, index) => !used.has(index) && item.scriptVersionId === expected.candidateScriptVersion && routes.includes(item.routeDiscriminator) && call.routeDiscriminator === item.routeDiscriminator && Math.abs(item.eventTimestampMs - call.timestampMs) <= (expected.timestampToleranceMs ?? 1000) && (!window || (item.eventTimestampMs >= window.windowStartMs && item.eventTimestampMs < window.windowEndMs)));
    if (record) { const index = records.indexOf(record); used.add(index); assigned.push(record); }
  }
  const allDirect = records.filter((record) => record.scriptVersionId === expected.candidateScriptVersion && routes.includes(record.routeDiscriminator) && windows.some((window) => record.eventTimestampMs >= window.windowStartMs && record.eventTimestampMs < window.windowEndMs));
  const cpuViolation = allDirect.some((record) => record.outcome === "exceededCpu") || allDirect.some((record) => record.cpuTimeMs > CPU_GATE.maxMs);
  if (cpuViolation) return { status: "FAIL", cpuTimesMs: allDirect.map((record) => record.cpuTimeMs), exceededCpu: allDirect.filter((record) => record.outcome === "exceededCpu").length };
  const complete = metadata?.queryComplete === true && metadata?.samplingVerified === true && metadata?.paginationComplete === true && metadata?.truncationObserved === false && windows.every((window) => window.sampleInterval === 1 && window.platformInvocationCount === metadata.normalizedInvocationCount) && assigned.length === (expected.calls ?? []).length && assigned.length === expected.expectedSuccessfulInvocations;
  if (!complete || assigned.some((record) => record.scriptVersionId !== expected.candidateScriptVersion)) return { status: "BLOCKED", reason: "incomplete or mismatched telemetry", matchedInvocations: assigned.length };
  const values = assigned.map((record) => record.cpuTimeMs).sort((a, b) => a - b);
  const p99 = values[Math.ceil(values.length * 0.99) - 1] ?? 0;
  const max = values.at(-1) ?? 0;
  if (p99 > CPU_GATE.p99MaxMs || max > CPU_GATE.maxMs) return { status: "FAIL", p99, max, exceededCpu: 0 };
  return { status: "PASS", p99, max, exceededCpu: 0, matchedInvocations: assigned.length };
}

function routeFor(invocationClass) {
  switch (invocationClass) {
    case "ingress": return ["/v1/responses"];
    case "decision": return ["/internal/relay/v1/decision"];
    case "activation_normal": case "activation_replay": return ["/internal/relay/v1/activation"];
    case "renewal_normal": return ["/internal/relay/v1/renewal"];
    case "terminal_normal": case "terminal_replay": return ["/internal/relay/v1/terminal"];
    default: return undefined;
  }
}
