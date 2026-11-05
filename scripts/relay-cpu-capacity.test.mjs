import { strict as assert } from "node:assert";
import { test } from "node:test";

const { requiredCapacityMatrix, evaluateCapacityPreflight } = await import("./relay-cpu-capacity.mjs");
import { baseCapacityEvidence, baseExecutionTarget, NOW_UTC } from "./relay-cpu-test-fixtures.mjs";

const baseEvidence = (overrides = {}) => ({ ...baseCapacityEvidence(), ...overrides });
const baseTarget = (overrides = {}) => ({ ...baseExecutionTarget(), ...overrides });

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

function assertMissingMeters(ids) {
  const evidence = baseEvidence();
  evidence.meters = evidence.meters.filter(({ id }) => !ids.includes(id));
  assertHold(evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC), "MISSING_METER");
}

function assertMeterCapacity(id, values, expectation) {
  const evidence = baseEvidence();
  evidence.meters = evidence.meters.map((meter) => meter.id === id ? { ...meter, ...values } : meter);
  const result = evaluateCapacityPreflight(evidence, baseTarget(), NOW_UTC);
  if (expectation === "pass") assertPass(result);
  else assertHold(result, expectation);
}

test("matrix_has_68_series_34000_minimum_and_170000_attempt_envelope", () => {
  const matrix = requiredCapacityMatrix();
  assert.equal(matrix.seriesCount, 68);
  assert.equal(matrix.successesPerSeries, 500);
  assert.equal(matrix.minimumSuccessfulCalls, 34000);
  assert.equal(matrix.attemptEnvelope, 170000);
});

test("missing_do_rows_read_or_write_holds", () => {
  assertMissingMeters(["do.rows_read.daily", "do.rows_written.daily"]);
});

test("missing_d1_rows_read_or_write_holds", () => {
  assertMissingMeters(["d1.rows_read.daily", "d1.rows_written.daily"]);
});

test("missing_do_or_d1_storage_holds", () => {
  assertMissingMeters(["do.storage.bytes.total", "d1.storage.bytes.total"]);
});

test("row_read_at_limit_with_positive_budget_holds", () => {
  assertMeterCapacity("do.rows_read.daily", { verifiedFreeLimit: 1000, consumedUsage: 1000, normalForecast: 0, reserve: 0, gateBudget: 1 }, "INSUFFICIENT_CAPACITY");
});

test("row_write_at_limit_with_positive_budget_holds", () => {
  assertMeterCapacity("do.rows_written.daily", { verifiedFreeLimit: 1000, consumedUsage: 1000, normalForecast: 0, reserve: 0, gateBudget: 1 }, "INSUFFICIENT_CAPACITY");
});

test("row_read_exact_balance_passes", () => {
  assertMeterCapacity("do.rows_read.daily", { verifiedFreeLimit: 1000, consumedUsage: 500, normalForecast: 200, reserve: 100, gateBudget: 200 }, "pass");
});

test("row_write_exact_balance_passes", () => {
  assertMeterCapacity("do.rows_written.daily", { verifiedFreeLimit: 1000, consumedUsage: 500, normalForecast: 200, reserve: 100, gateBudget: 200 }, "pass");
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
