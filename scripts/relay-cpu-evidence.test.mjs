import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCpuSeries } from "./relay-cpu-evidence.mjs";

/**
 * Canonical Task 4/plan series identity used by every test below. Values are
 * synthetic and non-secret; only the identity fields required by the plan's
 * exact series contract are included. One fixture = one series: every ledger
 * call and platform record belongs to a single invocationClass.
 */
const WINDOWS = [
  { windowStartMs: 100, windowEndMs: 200 },
  { windowStartMs: 200, windowEndMs: 300 },
];

function ledgerCall(overrides = {}) {
  return {
    stage: "stage1",
    invocationClass: "ingress",
    workloadClass: "baseline-small",
    concurrency: 2,
    candidateSourceRevision: "source-rev-1",
    callOrdinal: 1,
    timestampMs: 110,
    routeDiscriminator: "/v1/responses",
    status: 200,
    outcomeHint: "allow",
    ...overrides,
  };
}

function callRecord(overrides = {}) {
  return {
    eventId: "e1",
    requestId: "platform-id",
    eventTimestampMs: 110,
    scriptName: "worker",
    scriptVersionId: "v1",
    cpuTimeMs: 5,
    outcome: "ok",
    eventType: "cpu",
    routeDiscriminator: "/v1/responses",
    executionModel: "stateless",
    ...overrides,
  };
}

function baseExpected(overrides = {}) {
  return {
    stage: "stage1",
    scriptName: "worker",
    candidateScriptVersion: "v1",
    candidateSourceRevision: "source-rev-1",
    invocationClass: "ingress",
    workloadClass: "baseline-small",
    concurrency: 2,
    windows: WINDOWS,
    expectedSuccessfulInvocations: 2,
    calls: [
      ledgerCall({ callOrdinal: 1, timestampMs: 110, routeDiscriminator: "/v1/responses" }),
      ledgerCall({ callOrdinal: 2, timestampMs: 210, routeDiscriminator: "/v1/responses" }),
    ],
    ...overrides,
  };
}

function baseRecords() {
  return [
    callRecord({ eventId: "e1", eventTimestampMs: 110, routeDiscriminator: "/v1/responses", cpuTimeMs: 5 }),
    callRecord({ eventId: "e2", eventTimestampMs: 210, routeDiscriminator: "/v1/responses", cpuTimeMs: 4 }),
  ];
}

function windowMeta(overrides = {}) {
  return { windowStartMs: 100, windowEndMs: 200, paginationComplete: true, truncationObserved: false, sampleInterval: 1, platformInvocationCount: 1, ...overrides };
}

function baseMetadata(overrides = {}) {
  return {
    version: 1,
    samplingVerified: true,
    normalizedInvocationCount: 2,
    paginationComplete: true,
    truncationObserved: false,
    queryComplete: true,
    windows: [windowMeta(), windowMeta({ windowStartMs: 200, windowEndMs: 300 })],
    ...overrides,
  };
}

test("blocks a complete multi-window series below the minimum 500 successes", () => {
  const result = evaluateCpuSeries(baseRecords(), baseMetadata(), baseExpected());
  assert.equal(result.status, "BLOCKED");
});

test("rejects overlapping windows before evaluation", () => {
  const metadata = baseMetadata({ windows: [
    windowMeta({ windowEndMs: 250, platformInvocationCount: 2 }),
    windowMeta({ windowStartMs: 200, windowEndMs: 300, platformInvocationCount: 2 }),
  ] });
  assert.equal(evaluateCpuSeries(baseRecords(), metadata, baseExpected()).status, "BLOCKED");
});

test("blocks when a per-window platform calculation disagrees with the normalized window count", () => {
  const metadata = baseMetadata();
  metadata.windows[0] = { ...metadata.windows[0], platformInvocationCount: 2 };
  assert.equal(evaluateCpuSeries(baseRecords(), metadata, baseExpected()).status, "BLOCKED");
});

test("blocks when the global platform total disagrees with normalized or record counts", () => {
  const mismatched = baseMetadata({ normalizedInvocationCount: 1 });
  assert.equal(evaluateCpuSeries(baseRecords(), mismatched, baseExpected()).status, "BLOCKED");

  const missingRecord = baseRecords().slice(0, 1);
  assert.equal(evaluateCpuSeries(missingRecord, { ...baseMetadata(), normalizedInvocationCount: 1 }, baseExpected()).status, "BLOCKED");
});

test("blocks on an unassigned in-scope record instead of passing over it", () => {
  const records = [
    ...baseRecords(),
    callRecord({ eventId: "e3", eventTimestampMs: 105, routeDiscriminator: "/v1/responses", cpuTimeMs: 1 }),
  ];
  const metadata = baseMetadata({ normalizedInvocationCount: 3, windows: [
    windowMeta({ platformInvocationCount: 2 }),
    windowMeta({ windowStartMs: 200, windowEndMs: 300 }),
  ] });
  const result = evaluateCpuSeries(records, metadata, baseExpected());
  assert.equal(result.status, "BLOCKED");
});

test("fails on a direct CPU violation even when telemetry completeness is broken", () => {
  const records = [
    callRecord({ eventId: "e1", eventTimestampMs: 110, routeDiscriminator: "/v1/responses", cpuTimeMs: 9 }),
    callRecord({ eventId: "e2", eventTimestampMs: 210, routeDiscriminator: "/v1/responses" }),
  ];
  const result = evaluateCpuSeries(records, { ...baseMetadata(), samplingVerified: false }, baseExpected());
  assert.equal(result.status, "FAIL");
  assert.equal(result.max, 9);
});

test("fails on exceededCpu markers without application finish markers", () => {
  const records = [
    callRecord({ eventId: "e1", eventTimestampMs: 110, routeDiscriminator: "/v1/responses", outcome: "exceededCpu", cpuTimeMs: 1 }),
    callRecord({ eventId: "e2", eventTimestampMs: 210, routeDiscriminator: "/v1/responses" }),
  ];
  const result = evaluateCpuSeries(records, baseMetadata(), baseExpected());
  assert.equal(result.status, "FAIL");
  assert.equal(result.exceededCpu, 1);
});

test("fails when p99 exceeds 5ms but max stays within 7ms", () => {
  const records = [
    callRecord({ eventId: "e1", eventTimestampMs: 110, routeDiscriminator: "/v1/responses", cpuTimeMs: 2 }),
    callRecord({ eventId: "e2", eventTimestampMs: 210, routeDiscriminator: "/v1/responses", cpuTimeMs: 6 }),
  ];
  const result = evaluateCpuSeries(records, baseMetadata(), baseExpected());
  assert.equal(result.status, "FAIL");
  assert.equal(result.p99, 6);
  assert.equal(result.max, 6);
});

test("blocks on incomplete sampling, pagination, truncation or query flags", () => {
  for (const [key, value] of [["samplingVerified", false], ["paginationComplete", false], ["truncationObserved", true], ["queryComplete", false]]) {
    assert.equal(evaluateCpuSeries(baseRecords(), baseMetadata({ [key]: value }), baseExpected()).status, "BLOCKED");
  }
});

test("blocks on non-unit sample intervals or missing platform counts", () => {
  const metadata = baseMetadata();
  metadata.windows[0] = { ...metadata.windows[0], sampleInterval: 2 };
  assert.equal(evaluateCpuSeries(baseRecords(), metadata, baseExpected()).status, "BLOCKED");

  const empty = baseMetadata();
  empty.windows[0] = { ...empty.windows[0], platformInvocationCount: null };
  assert.equal(evaluateCpuSeries(baseRecords(), empty, baseExpected()).status, "BLOCKED");
});

test("blocks when the metadata window identity differs from the expected series windows", () => {
  const metadata = baseMetadata({ windows: [
    windowMeta({ windowStartMs: 90, windowEndMs: 200 }),
    windowMeta({ windowStartMs: 200, windowEndMs: 300 }),
  ] });
  assert.equal(evaluateCpuSeries(baseRecords(), metadata, baseExpected()).status, "BLOCKED");
});

test("blocks on identity drift between the expected series and the ledger calls", () => {
  for (const mutate of [
    (call) => ({ ...call, stage: "stage2-series" }),
    (call) => ({ ...call, candidateSourceRevision: "other-rev" }),
    (call) => ({ ...call, workloadClass: "baseline-large" }),
    (call) => ({ ...call, concurrency: 3 }),
    (call) => ({ ...call, invocationClass: "decision" }),
    (call) => ({ ...call, routeDiscriminator: "/v1/chat/completions" }),
    (call) => ({ ...call, callOrdinal: undefined, timestampMs: undefined }),
  ]) {
    const expected = baseExpected();
    expected.calls = expected.calls.map((call, index) => (index === 0 ? mutate(call) : call));
    assert.equal(evaluateCpuSeries(baseRecords(), baseMetadata(), expected).status, "BLOCKED");
  }
});

test("blocks when the expected series identity is incomplete", () => {
  for (const key of ["stage", "scriptName", "candidateScriptVersion", "candidateSourceRevision", "invocationClass", "workloadClass", "concurrency", "windows"]) {
    const expected = baseExpected();
    delete expected[key];
    assert.equal(evaluateCpuSeries(baseRecords(), baseMetadata(), expected).status, "BLOCKED");
  }
});

test("blocks on records with unexpected script name, execution model or version", () => {
  const records = [
    callRecord({ eventId: "e1", scriptName: "other-worker", eventTimestampMs: 110 }),
    callRecord({ eventId: "e2", eventTimestampMs: 210, routeDiscriminator: "/v1/responses" }),
  ];
  assert.equal(evaluateCpuSeries(records, baseMetadata(), baseExpected()).status, "BLOCKED");

  const modelDrift = baseRecords();
  modelDrift[0] = callRecord({ eventTimestampMs: 110, executionModel: "durableObject" });
  assert.equal(evaluateCpuSeries(modelDrift, baseMetadata(), baseExpected()).status, "BLOCKED");
});

test("matches concurrent callbacks by ordinal route and timestamp tolerance", () => {
  const expected = baseExpected({
    invocationClass: "decision",
    calls: [
      ledgerCall({ invocationClass: "decision", concurrency: 2, callOrdinal: 1, timestampMs: 110, routeDiscriminator: "/internal/relay/v1/decision" }),
      ledgerCall({ invocationClass: "decision", concurrency: 2, callOrdinal: 2, timestampMs: 112, routeDiscriminator: "/internal/relay/v1/decision" }),
    ],
  });
  const records = [
    callRecord({ eventId: "p1", eventTimestampMs: 112, routeDiscriminator: "/internal/relay/v1/decision" }),
    callRecord({ eventId: "p2", eventTimestampMs: 113, routeDiscriminator: "/internal/relay/v1/decision", cpuTimeMs: 5 }),
  ];
  const result = evaluateCpuSeries(records, { ...baseMetadata(), windows: [
    windowMeta({ platformInvocationCount: 2 }),
    windowMeta({ windowStartMs: 200, windowEndMs: 300, platformInvocationCount: 0 }),
  ] }, expected);
  assert.equal(result.status, "BLOCKED");
});

function completeSeries() {
  const records = Array.from({ length: 500 }, (_, index) => callRecord({
    eventId: `event-${index}`, eventTimestampMs: index < 250 ? 110 : 210,
  }));
  const expected = baseExpected({ expectedSuccessfulInvocations: 500, calls: records.map((record, index) =>
    ledgerCall({ callOrdinal: index + 1, timestampMs: record.eventTimestampMs })) });
  const metadata = baseMetadata({ normalizedInvocationCount: 500, windows: [
    windowMeta({ platformInvocationCount: 250 }),
    windowMeta({ windowStartMs: 200, windowEndMs: 300, platformInvocationCount: 250 }),
  ] });
  return { records, expected, metadata };
}

test("passes 500 successes across disjoint windows without requiring domain request IDs", () => {
  const { records, metadata, expected } = completeSeries();
  assert.equal(evaluateCpuSeries(records, metadata, expected).status, "PASS");
});

test("blocks invalid CPU numbers, duplicate event IDs, failed calls and duplicate ordinals", () => {
  for (const mutate of [
    ({ records }) => { records[0].cpuTimeMs = NaN; },
    ({ records }) => { records[0].cpuTimeMs = -1; },
    ({ records }) => { records[0].eventId = records[1].eventId; },
    ({ expected }) => { expected.calls[0].status = 500; },
    ({ expected }) => { expected.calls[0].callOrdinal = 2; },
  ]) {
    const fixture = completeSeries();
    mutate(fixture);
    assert.equal(evaluateCpuSeries(fixture.records, fixture.metadata, fixture.expected).status, "BLOCKED");
  }
});

test("fails observed p99 violations even when sampling completeness is unavailable", () => {
  const { records, metadata, expected } = completeSeries();
  records.forEach((record) => { record.cpuTimeMs = 6; });
  metadata.samplingVerified = false;
  assert.equal(evaluateCpuSeries(records, metadata, expected).status, "FAIL");
});

test("complete 500-record series blocks sampling drift, missing records and invalid ordinals", () => {
  for (const mutate of [
    ({ metadata }) => { metadata.windows[0].sampleInterval = 2; },
    ({ metadata }) => { metadata.windows[0].paginationComplete = false; },
    ({ metadata }) => { metadata.windows[0].platformInvocationCount = 249; },
    ({ records }) => { records.pop(); },
    ({ expected }) => { expected.calls[0].timestampMs = 99999; },
    ({ expected }) => { expected.calls[0].callOrdinal = undefined; },
  ]) {
    const fixture = completeSeries();
    mutate(fixture);
    assert.equal(evaluateCpuSeries(fixture.records, fixture.metadata, fixture.expected).status, "BLOCKED");
  }
});

test("Stage 2 ingress counts only the proven paid-model 403 rejection as successful", () => {
  const { records, metadata, expected } = completeSeries();
  expected.stage = "stage2-series";
  expected.calls = expected.calls.map((call) => ({ ...call, stage: expected.stage, status: 403, success: true, outcomeHint: "model_requires_paid" }));
  assert.equal(evaluateCpuSeries(records, metadata, expected).status, "PASS");
  expected.calls[0].outcomeHint = "invalid_context";
  assert.equal(evaluateCpuSeries(records, metadata, expected).status, "BLOCKED");
});

test("evidence CLI reads protected ledger and normalized JSONL and writes its verdict", async () => {
  const { runEvidenceCli } = await import("./relay-cpu-evidence.mjs");
  assert.equal(typeof runEvidenceCli, "function");
  const directory = await mkdtemp(join(tmpdir(), "cpu-evidence-"));
  try {
    const { records, metadata, expected } = completeSeries();
    const ledger = join(directory, "ledger.json"), telemetry = join(directory, "records.jsonl"), meta = join(directory, "meta.json"), output = join(directory, "summary.json");
    await writeFile(ledger, JSON.stringify(expected), { mode: 0o600 });
    await writeFile(telemetry, records.map((record) => JSON.stringify(record)).join("\n"), { mode: 0o600 });
    await writeFile(meta, JSON.stringify(metadata), { mode: 0o600 });
    assert.equal(await runEvidenceCli([`--ledger=${ledger}`, `--telemetry=${telemetry}`, `--telemetry-meta=${meta}`, `--out=${output}`]), 0);
    assert.equal(JSON.parse(await readFile(output, "utf8")).status, "PASS");
    assert.equal((await stat(output)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("blocks when a callback timestamp falls outside the tolerance and window", () => {
  const records = [
    callRecord({ eventId: "p1", eventTimestampMs: 112 + 2000, routeDiscriminator: "/internal/relay/v1/decision" }),
  ];
  const expected = baseExpected({
    invocationClass: "decision",
    windows: [{ windowStartMs: 2100, windowEndMs: 3200 }],
    calls: [
      ledgerCall({ invocationClass: "decision", concurrency: 1, callOrdinal: 1, timestampMs: 112, routeDiscriminator: "/internal/relay/v1/decision" }),
    ],
    expectedSuccessfulInvocations: 1,
  });
  const metadata = baseMetadata({
    normalizedInvocationCount: 1,
    windows: [{ windowStartMs: 2100, windowEndMs: 3200, paginationComplete: true, truncationObserved: false, sampleInterval: 1, platformInvocationCount: 1 }],
  });
  assert.equal(evaluateCpuSeries(records, metadata, expected).status, "BLOCKED");
});
