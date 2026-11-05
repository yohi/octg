import { strict as assert } from "node:assert";
import { test } from "node:test";

const { requiredCapacityMatrix, evaluateCapacityPreflight } = await import("./relay-cpu-capacity.mjs");

const REQUIRED_METER_IDS = [
  "workers.requests.daily",
  "do.requests.daily",
  "do.duration.GB-s.daily",
  "do.rows_read.daily",
  "do.rows_written.daily",
  "do.storage.bytes.total",
  "d1.rows_read.daily",
  "d1.rows_written.daily",
  "d1.storage.bytes.total",
  "deno.inbound_requests.monthly",
  "deno.active_cpu.seconds.monthly",
  "deno.memory.GiB-h.monthly",
  "deno.egress.bytes.monthly",
  "deno.revision_storage.bytes.total",
];

const CANONICAL_UNITS = {
  "workers.requests.daily": "requests",
  "do.requests.daily": "requests",
  "do.duration.GB-s.daily": "GB-s",
  "do.rows_read.daily": "rows",
  "do.rows_written.daily": "rows",
  "do.storage.bytes.total": "bytes",
  "d1.rows_read.daily": "rows",
  "d1.rows_written.daily": "rows",
  "d1.storage.bytes.total": "bytes",
  "deno.inbound_requests.monthly": "requests",
  "deno.active_cpu.seconds.monthly": "seconds",
  "deno.memory.GiB-h.monthly": "GiB-h",
  "deno.egress.bytes.monthly": "bytes",
  "deno.revision_storage.bytes.total": "bytes",
};

const RESET_WINDOWS = {
  "workers.requests.daily": { kind: "utc_day", startUTC: "2026-11-03T00:00:00Z", endUTC: "2026-11-04T00:00:00Z" },
  "do.requests.daily": { kind: "utc_day", startUTC: "2026-11-03T00:00:00Z", endUTC: "2026-11-04T00:00:00Z" },
  "do.duration.GB-s.daily": { kind: "utc_day", startUTC: "2026-11-03T00:00:00Z", endUTC: "2026-11-04T00:00:00Z" },
  "do.rows_read.daily": { kind: "utc_day", startUTC: "2026-11-03T00:00:00Z", endUTC: "2026-11-04T00:00:00Z" },
  "do.rows_written.daily": { kind: "utc_day", startUTC: "2026-11-03T00:00:00Z", endUTC: "2026-11-04T00:00:00Z" },
  "do.storage.bytes.total": { kind: "nonresetting_stock", asOfUTC: "2026-11-03T00:00:00Z" },
  "d1.rows_read.daily": { kind: "utc_day", startUTC: "2026-11-03T00:00:00Z", endUTC: "2026-11-04T00:00:00Z" },
  "d1.rows_written.daily": { kind: "utc_day", startUTC: "2026-11-03T00:00:00Z", endUTC: "2026-11-04T00:00:00Z" },
  "d1.storage.bytes.total": { kind: "nonresetting_stock", asOfUTC: "2026-11-03T00:00:00Z" },
  "deno.inbound_requests.monthly": { kind: "billing_month", startUTC: "2026-11-01T00:00:00Z", endUTC: "2026-12-01T00:00:00Z" },
  "deno.active_cpu.seconds.monthly": { kind: "billing_month", startUTC: "2026-11-01T00:00:00Z", endUTC: "2026-12-01T00:00:00Z" },
  "deno.memory.GiB-h.monthly": { kind: "billing_month", startUTC: "2026-11-01T00:00:00Z", endUTC: "2026-12-01T00:00:00Z" },
  "deno.egress.bytes.monthly": { kind: "billing_month", startUTC: "2026-11-01T00:00:00Z", endUTC: "2026-12-01T00:00:00Z" },
  "deno.revision_storage.bytes.total": { kind: "nonresetting_stock", asOfUTC: "2026-11-03T00:00:00Z" },
};

const NOW_UTC = "2026-11-03T12:00:00.000Z";

function meter(id, overrides = {}) {
  const scope = id.startsWith("deno.") ? "deno:deno-org-1" : "cloudflare:cf-account-1";
  return {
    id,
    scope,
    unit: CANONICAL_UNITS[id],
    resetWindow: RESET_WINDOWS[id],
    verifiedFreeLimit: 100000,
    consumedUsage: 0,
    normalForecast: 0,
    reserve: 0,
    gateBudget: 100,
    usageObservedAtUTC: "2026-11-03T11:55:00.000Z",
    limitVerifiedAtUTC: "2026-11-03T11:55:00.000Z",
    limitSourceUrl: "https://example.com/limit",
    usageEvidenceRef: "ref:usage",
    normalForecastEvidenceRef: "ref:forecast",
    budgetEvidenceRef: "ref:budget",
    reserveEvidenceRef: "ref:reserve",
    zeroIncrementJustificationRef: "ref:zero-justification",
    ...overrides,
  };
}

function baseEvidence(overrides = {}) {
  return {
    version: 1,
    stage: "stage1",
    environment: "preview",
    cloudflareAccountId: "cf-account-1",
    denoOrganizationId: "deno-org-1",
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    workerName: "octg-gateway",
    observedAtUTC: "2026-11-03T11:55:00.000Z",
    expiresAtUTC: "2026-11-03T12:14:00.000Z",
    budgetMethodRef: "ref:method",
    freePlanEligibility: { cloudflare: "free", deno: "free", providerEvidenceRefs: ["ref:cf-free", "ref:deno-free"] },
    matrix: { seriesCount: 68, successesPerSeries: 500, attemptEnvelope: 170000, fullRun: true },
    meters: REQUIRED_METER_IDS.map((id) => meter(id)),
    ...overrides,
  };
}

function baseTarget(overrides = {}) {
  const usagePeriods = {};
  for (const id of REQUIRED_METER_IDS) {
    usagePeriods[id] = RESET_WINDOWS[id];
  }
  return {
    version: 1,
    stage: "stage1",
    environment: "preview",
    cloudflareAccountId: "cf-account-1",
    denoOrganizationId: "deno-org-1",
    workerName: "octg-gateway",
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    usagePeriods,
    freePlanEligibility: { cloudflare: "free", deno: "free" },
    verifiedAtUTC: "2026-11-03T11:55:00.000Z",
    operatorVerificationRef: "ref:operator-verification",
    providerIdentityEvidenceRefs: ["ref:provider-identity"],
    ...overrides,
  };
}

function assertHold(result, expectedReason) {
  assert.equal(result.status, "PREFLIGHT_HOLD", `expected HOLD but got ${result.status} with reasons ${JSON.stringify(result.reasons)}`);
  assert.ok(result.reasons.length > 0, "expected at least one reason code");
  if (expectedReason !== undefined) {
    assert.ok(result.reasons.includes(expectedReason), `expected reason ${expectedReason} in ${JSON.stringify(result.reasons)}`);
  }
  for (const reason of result.reasons) {
    assert.ok(typeof reason === "string" && reason.length > 0, "reason code must be a non-empty string");
  }
}

function assertPass(result) {
  assert.equal(result.status, "PREFLIGHT_PASS", `expected PASS but got ${result.status} with reasons ${JSON.stringify(result.reasons)}`);
  assert.deepEqual(result.reasons, []);
}

test("matrix_has_68_series_34000_minimum_and_170000_attempt_envelope", () => {
  const matrix = requiredCapacityMatrix();
  assert.equal(matrix.seriesCount, 68);
  assert.equal(matrix.successesPerSeries, 500);
  assert.equal(matrix.minimumSuccessfulCalls, 34000);
  assert.equal(matrix.attemptEnvelope, 170000);
});

test("missing_do_rows_read_or_write_holds", () => {
  const evidence = baseEvidence();
  evidence.meters = evidence.meters.filter((m) => m.id !== "do.rows_read.daily" && m.id !== "do.rows_written.daily");
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC), "MISSING_METER");
});

test("missing_d1_rows_read_or_write_holds", () => {
  const evidence = baseEvidence();
  evidence.meters = evidence.meters.filter((m) => m.id !== "d1.rows_read.daily" && m.id !== "d1.rows_written.daily");
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC), "MISSING_METER");
});

test("missing_do_or_d1_storage_holds", () => {
  const evidence = baseEvidence();
  evidence.meters = evidence.meters.filter((m) => m.id !== "do.storage.bytes.total" && m.id !== "d1.storage.bytes.total");
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC), "MISSING_METER");
});

test("row_read_at_limit_with_positive_budget_holds", () => {
  const evidence = baseEvidence();
  evidence.meters = evidence.meters.map((m) =>
    m.id === "do.rows_read.daily" ? { ...m, verifiedFreeLimit: 1000, consumedUsage: 1000, normalForecast: 0, reserve: 0, gateBudget: 1 } : m,
  );
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC), "INSUFFICIENT_CAPACITY");
});

test("row_write_at_limit_with_positive_budget_holds", () => {
  const evidence = baseEvidence();
  evidence.meters = evidence.meters.map((m) =>
    m.id === "do.rows_written.daily" ? { ...m, verifiedFreeLimit: 1000, consumedUsage: 1000, normalForecast: 0, reserve: 0, gateBudget: 1 } : m,
  );
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC), "INSUFFICIENT_CAPACITY");
});

test("row_read_exact_balance_passes", () => {
  const evidence = baseEvidence();
  evidence.meters = evidence.meters.map((m) =>
    m.id === "do.rows_read.daily" ? { ...m, verifiedFreeLimit: 1000, consumedUsage: 500, normalForecast: 200, reserve: 100, gateBudget: 200 } : m,
  );
  assertPass(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC));
});

test("row_write_exact_balance_passes", () => {
  const evidence = baseEvidence();
  evidence.meters = evidence.meters.map((m) =>
    m.id === "do.rows_written.daily" ? { ...m, verifiedFreeLimit: 1000, consumedUsage: 500, normalForecast: 200, reserve: 100, gateBudget: 200 } : m,
  );
  assertPass(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC));
});

test("missing_usage_or_fixture_cost_holds", () => {
  const evidence = baseEvidence();
  evidence.meters = evidence.meters.map((m) =>
    m.id === "workers.requests.daily" ? { ...m, consumedUsage: undefined, gateBudget: undefined } : m,
  );
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC), "INSUFFICIENT_CAPACITY");
});

test("cross_cloudflare_account_holds", () => {
  const target = baseTarget({ cloudflareAccountId: "cf-account-other" });
  assertHold(evaluateCapacityPreflight(baseEvidence(), target, NOW_UTC), "CROSS_ACCOUNT");
});

test("cross_deno_organization_holds", () => {
  const target = baseTarget({ denoOrganizationId: "deno-org-other" });
  assertHold(evaluateCapacityPreflight(baseEvidence(), target, NOW_UTC), "CROSS_ACCOUNT");
});

test("cross_environment_holds", () => {
  const target = baseTarget({ environment: "production" });
  assertHold(evaluateCapacityPreflight(baseEvidence(), target, NOW_UTC), "CROSS_ENVIRONMENT");
});

test("wrong_revision_holds", () => {
  const target = baseTarget({ sourceRevision: "ffffffffffffffffffffffffffffffffffffffff" });
  assertHold(evaluateCapacityPreflight(baseEvidence(), target, NOW_UTC), "WRONG_REVISION");
});

test("expired_evidence_holds", () => {
  const evidence = baseEvidence({ expiresAtUTC: "2026-11-03T11:59:00.000Z" });
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), "2026-11-03T12:00:00.000Z"), "EXPIRED_EVIDENCE");
});

test("wrong_stage_or_worker_holds", () => {
  const target = baseTarget({ stage: "stage2", workerName: "other-worker" });
  assertHold(evaluateCapacityPreflight(baseEvidence(), target, NOW_UTC), "TARGET_MISMATCH");
});

test("usage_period_mismatch_holds", () => {
  const target = baseTarget();
  target.usagePeriods["workers.requests.daily"] = { kind: "billing_month", startUTC: "2026-11-01T00:00:00Z", endUTC: "2026-12-01T00:00:00Z" };
  assertHold(evaluateCapacityPreflight(baseEvidence(), target, NOW_UTC), "USAGE_PERIOD_MISMATCH");
});

test("free_plan_not_proven_holds", () => {
  const evidence = baseEvidence({ freePlanEligibility: { cloudflare: "free", deno: "free", providerEvidenceRefs: [] } });
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC), "FREE_PLAN_NOT_PROVEN");
});

test("operator_verification_missing_holds", () => {
  const target = baseTarget({ operatorVerificationRef: "", providerIdentityEvidenceRefs: [] });
  assertHold(evaluateCapacityPreflight(baseEvidence(), target, NOW_UTC), "TARGET_NOT_VERIFIED");
});

test("two_self_consistent_jsons_without_external_proof_hold", () => {
  const target = baseTarget({ operatorVerificationRef: "", providerIdentityEvidenceRefs: [] });
  assertHold(evaluateCapacityPreflight(baseEvidence(), target, NOW_UTC), "TARGET_NOT_VERIFIED");
});

test("target_file_same_as_capacity_file_holds", () => {
  const evidence = baseEvidence();
  const target = JSON.parse(JSON.stringify(evidence));
  delete target.meters;
  delete target.matrix;
  delete target.observedAtUTC;
  delete target.expiresAtUTC;
  delete target.budgetMethodRef;
  assertHold(evaluateCapacityPreflight(evidence, target, NOW_UTC), "TARGET_NOT_VERIFIED");
});

test("normal_complete_meters_pass", () => {
  assertPass(evaluateCapacityPreflight(baseEvidence(), baseTarget(), NOW_UTC));
});

test("malformed_now_is_malformed", () => {
  assertHold(evaluateCapacityPreflight(baseEvidence(), baseTarget(), "garbage"), "MALFORMED_NOW");
});

test("missing_budget_method_ref_holds", () => {
  const evidence = baseEvidence({ budgetMethodRef: "" });
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC), "MISSING_EVIDENCE_REF");
});

test("missing_meter_evidence_ref_holds", () => {
  const evidence = baseEvidence();
  evidence.meters = evidence.meters.map((m) => m.id === "workers.requests.daily" ? { ...m, limitSourceUrl: "" } : m);
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC), "MISSING_EVIDENCE_REF");
});

test("missing_zero_justification_holds", () => {
  const evidence = baseEvidence();
  evidence.meters = evidence.meters.map((m) => m.id === "workers.requests.daily" ? { ...m, gateBudget: 0, zeroIncrementJustificationRef: "" } : m,
  );
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC), "MISSING_ZERO_JUSTIFICATION");
});

test("extra_active_limit_meter_with_full_contract_passes", () => {
  const evidence = baseEvidence();
  evidence.meters.push({
    id: "extra.active_limit.daily",
    scope: "cloudflare:cf-account-1",
    unit: "requests",
    resetWindow: { kind: "utc_day", startUTC: "2026-11-03T00:00:00Z", endUTC: "2026-11-04T00:00:00Z" },
    verifiedFreeLimit: 1000,
    consumedUsage: 0,
    normalForecast: 0,
    reserve: 0,
    gateBudget: 1,
    usageObservedAtUTC: "2026-11-03T11:55:00.000Z",
    limitVerifiedAtUTC: "2026-11-03T11:55:00.000Z",
    limitSourceUrl: "https://example.com/extra",
    usageEvidenceRef: "ref:extra-usage",
    normalForecastEvidenceRef: "ref:extra-forecast",
    budgetEvidenceRef: "ref:extra-budget",
    reserveEvidenceRef: "ref:extra-reserve",
    zeroIncrementJustificationRef: "ref:extra-zero",
  });
  const target = baseTarget();
  target.usagePeriods["extra.active_limit.daily"] = { kind: "utc_day", startUTC: "2026-11-03T00:00:00Z", endUTC: "2026-11-04T00:00:00Z" };
  assertPass(evaluateCapacityPreflight(evidence, target, NOW_UTC));
});

test("future_evidence_observedAt_holds", () => {
  const evidence = baseEvidence({ observedAtUTC: "2026-11-03T13:00:00.000Z" });
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC), "EXPIRED_EVIDENCE");
});

test("expiresAtUTC_too_far_in_future_holds", () => {
  const evidence = baseEvidence({ expiresAtUTC: "2026-11-03T13:00:00.000Z" });
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC), "EXPIRED_EVIDENCE");
});
