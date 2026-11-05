import { requiredSeriesMatrix } from "./relay-cpu-workloads.mjs";
import { SUCCESS_SAMPLE_TARGET } from "./run-relay-cpu-gate.mjs";

/**
 * @typedef {Object} CapacityMatrixV1
 * @property {number} seriesCount
 * @property {number} successesPerSeries
 * @property {number} minimumSuccessfulCalls
 * @property {number} attemptEnvelope
 */

/**
 * @typedef {Object} CapacityEvidenceV1
 * @property {1} version
 * @property {'stage1'|'stage2'} stage
 * @property {'preview'|'production'} environment
 * @property {string} cloudflareAccountId
 * @property {string} denoOrganizationId
 * @property {string} sourceRevision
 * @property {string} workerName
 * @property {string} observedAtUTC
 * @property {string} expiresAtUTC
 * @property {string} budgetMethodRef
 * @property {{cloudflare:'free', deno:'free', providerEvidenceRefs:string[]}} freePlanEligibility
 * @property {{seriesCount:number, successesPerSeries:number, attemptEnvelope:number, fullRun:boolean}} matrix
 * @property {CapacityMeterV1[]} meters
 */

/**
 * @typedef {Object} CapacityMeterV1
 * @property {string} id
 * @property {string} scope
 * @property {string} unit
 * @property {{kind:'utc_day'|'billing_month'|'nonresetting_stock', startUTC?:string, endUTC?:string, asOfUTC?:string}} resetWindow
 * @property {number} verifiedFreeLimit
 * @property {number} consumedUsage
 * @property {number} normalForecast
 * @property {number} reserve
 * @property {number} gateBudget
 * @property {string} usageObservedAtUTC
 * @property {string} limitVerifiedAtUTC
 * @property {string} limitSourceUrl
 * @property {string} usageEvidenceRef
 * @property {string} normalForecastEvidenceRef
 * @property {string} budgetEvidenceRef
 * @property {string} reserveEvidenceRef
 * @property {string} [zeroIncrementJustificationRef]
 */

/**
 * @typedef {Object} ExecutionTargetV1
 * @property {1} version
 * @property {'stage1'|'stage2'} stage
 * @property {'preview'|'production'} environment
 * @property {string} cloudflareAccountId
 * @property {string} denoOrganizationId
 * @property {string} workerName
 * @property {string} sourceRevision
 * @property {Record<string, {kind:'utc_day'|'billing_month'|'nonresetting_stock', startUTC?:string, endUTC?:string, asOfUTC?:string}>} usagePeriods
 * @property {{cloudflare:'free', deno:'free'}} freePlanEligibility
 * @property {string} verifiedAtUTC
 * @property {string} operatorVerificationRef
 * @property {string[]} providerIdentityEvidenceRefs
 */

const REQUIRED_METER_IDS = Object.freeze([
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
]);

const CANONICAL_UNITS = Object.freeze({
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
});

const EXPECTED_RESET_KINDS = Object.freeze({
  "workers.requests.daily": "utc_day",
  "do.requests.daily": "utc_day",
  "do.duration.GB-s.daily": "utc_day",
  "do.rows_read.daily": "utc_day",
  "do.rows_written.daily": "utc_day",
  "do.storage.bytes.total": "nonresetting_stock",
  "d1.rows_read.daily": "utc_day",
  "d1.rows_written.daily": "utc_day",
  "d1.storage.bytes.total": "nonresetting_stock",
  "deno.inbound_requests.monthly": "billing_month",
  "deno.active_cpu.seconds.monthly": "billing_month",
  "deno.memory.GiB-h.monthly": "billing_month",
  "deno.egress.bytes.monthly": "billing_month",
  "deno.revision_storage.bytes.total": "nonresetting_stock",
});

const EVIDENCE_ONLY_KEYS = new Set(["meters", "matrix", "observedAtUTC", "expiresAtUTC", "budgetMethodRef"]);
const FRESHNESS_MINUTES = 15;
const FRESHNESS_MS = FRESHNESS_MINUTES * 60 * 1000;

/**
 * Returns the canonical capacity matrix derived from the 68-series workload matrix.
 * @returns {CapacityMatrixV1}
 */
export function requiredCapacityMatrix() {
  const series = requiredSeriesMatrix();
  const seriesCount = series.length;
  const successesPerSeries = SUCCESS_SAMPLE_TARGET;
  const minimumSuccessfulCalls = seriesCount * successesPerSeries;
  const attemptEnvelope = seriesCount * successesPerSeries * 5;
  return Object.freeze({
    seriesCount,
    successesPerSeries,
    minimumSuccessfulCalls,
    attemptEnvelope,
  });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseIsoUTC(iso) {
  if (!isNonEmptyString(iso)) return undefined;
  const date = new Date(iso);
  const time = date.getTime();
  return Number.isNaN(time) ? undefined : time;
}

function isValidStage(value) {
  return value === "stage1" || value === "stage2";
}

function isValidEnvironment(value) {
  return value === "preview" || value === "production";
}

function isValidHexSha40(value) {
  return typeof value === "string" && value.length === 40 && /^[0-9a-f]+$/.test(value);
}

function windowIdentity(a, b) {
  if (!isObject(a) || !isObject(b)) return false;
  if (a.kind !== b.kind) return false;
  if (a.startUTC !== b.startUTC) return false;
  if (a.endUTC !== b.endUTC) return false;
  if (a.asOfUTC !== b.asOfUTC) return false;
  return true;
}

function isFresh(iso, nowMs) {
  const ms = parseIsoUTC(iso);
  if (ms === undefined) return false;
  if (ms > nowMs) return false;
  return nowMs - ms <= FRESHNESS_MS;
}

function isValidExpiresAtUTC(iso, referenceMs) {
  const ms = parseIsoUTC(iso);
  if (ms === undefined) return false;
  // expiresAtUTC must be strictly after reference and within 15 minutes of it.
  if (ms <= referenceMs) return false;
  if (ms > referenceMs + FRESHNESS_MS) return false;
  return true;
}

function isValidExpiresAtUTCAfter(iso, referenceMs) {
  const ms = parseIsoUTC(iso);
  if (ms === undefined) return false;
  if (ms <= referenceMs) return false;
  if (ms > referenceMs + FRESHNESS_MS) return false;
  return true;
}


function identityReason(label) {
  switch (label) {
    case "cloudflareAccountId": return "CROSS_ACCOUNT";
    case "denoOrganizationId": return "CROSS_ACCOUNT";
    case "environment": return "CROSS_ENVIRONMENT";
    case "sourceRevision": return "WRONG_REVISION";
    default: return "TARGET_MISMATCH";
  }
}

/**
 * Evaluates capacity preflight for a verified execution target.
 * @param {CapacityEvidenceV1} evidence
 * @param {ExecutionTargetV1} target
 * @param {string} nowUTC
 * @returns {{status:'PREFLIGHT_PASS'|'PREFLIGHT_HOLD', reasons:string[]}}
 */
export function evaluateCapacityPreflight(evidence, target, nowUTC) {
  const reasons = [];

  const nowMs = parseIsoUTC(nowUTC);
  if (nowMs === undefined) {
    return { status: "PREFLIGHT_HOLD", reasons: ["MALFORMED_NOW"] };
  }

  if (!isObject(evidence) || evidence.version !== 1) {
    return { status: "PREFLIGHT_HOLD", reasons: ["INVALID_EVIDENCE"] };
  }
  if (!isObject(target) || target.version !== 1) {
    return { status: "PREFLIGHT_HOLD", reasons: ["INVALID_TARGET"] };
  }

  // Trust boundary: target must not carry evidence-only fields.
  for (const key of Object.keys(target)) {
    if (EVIDENCE_ONLY_KEYS.has(key)) {
      return { status: "PREFLIGHT_HOLD", reasons: ["TARGET_NOT_VERIFIED"] };
    }
  }

  // Structural identity match.
  const identityKeys = ["stage", "environment", "cloudflareAccountId", "denoOrganizationId", "workerName", "sourceRevision"];
  for (const key of identityKeys) {
    const ev = evidence[key];
    const tv = target[key];
    if (key === "stage" && !isValidStage(ev)) {
      reasons.push("INVALID_EVIDENCE");
      continue;
    }
    if (key === "environment" && !isValidEnvironment(ev)) {
      reasons.push("INVALID_EVIDENCE");
      continue;
    }
    if (key === "sourceRevision" && !isValidHexSha40(ev)) {
      reasons.push("INVALID_EVIDENCE");
      continue;
    }
    if (ev !== tv) {
      reasons.push(identityReason(key));
    }
  }

  // Target structural completeness.
  if (!isValidStage(target.stage) || !isValidEnvironment(target.environment)
    || !isNonEmptyString(target.cloudflareAccountId) || !isNonEmptyString(target.denoOrganizationId)
    || !isNonEmptyString(target.workerName) || !isValidHexSha40(target.sourceRevision)) {
    reasons.push("INVALID_TARGET");
  }

  // Free plan eligibility.
  if (!isObject(evidence.freePlanEligibility)
    || evidence.freePlanEligibility.cloudflare !== "free"
    || evidence.freePlanEligibility.deno !== "free"
    || !Array.isArray(evidence.freePlanEligibility.providerEvidenceRefs)
    || evidence.freePlanEligibility.providerEvidenceRefs.length === 0
    || evidence.freePlanEligibility.providerEvidenceRefs.some((ref) => !isNonEmptyString(ref))) {
    reasons.push("FREE_PLAN_NOT_PROVEN");
  }
  if (!isObject(target.freePlanEligibility)
    || target.freePlanEligibility.cloudflare !== "free"
    || target.freePlanEligibility.deno !== "free") {
    reasons.push("FREE_PLAN_NOT_PROVEN");
  }

  // Matrix exact match.
  const requiredMatrix = requiredCapacityMatrix();
  if (!isObject(evidence.matrix)
    || evidence.matrix.seriesCount !== requiredMatrix.seriesCount
    || evidence.matrix.successesPerSeries !== requiredMatrix.successesPerSeries
    || evidence.matrix.attemptEnvelope !== requiredMatrix.attemptEnvelope
    || evidence.matrix.fullRun !== true) {
    reasons.push("MATRIX_MISMATCH");
  }

  // Top-level evidence refs.
  if (!isNonEmptyString(evidence.budgetMethodRef)) {
    reasons.push("MISSING_EVIDENCE_REF");
  }

  // Evidence and target observation timestamps must not be in the future.
  const observedMs = parseIsoUTC(evidence.observedAtUTC);
  const targetVerifiedMs = parseIsoUTC(target.verifiedAtUTC);
  if (observedMs === undefined || observedMs > nowMs) {
    reasons.push("EXPIRED_EVIDENCE");
  }
  if (targetVerifiedMs === undefined || targetVerifiedMs > nowMs) {
    reasons.push("EXPIRED_EVIDENCE");
  }
  // Evidence expires after now and within 15 minutes of now (freshness requirement).
  if (!isValidExpiresAtUTC(evidence.expiresAtUTC, nowMs)) {
    reasons.push("EXPIRED_EVIDENCE");
  }

  // Target must have been verified within the last 15 minutes.
  if (!isFresh(target.verifiedAtUTC, nowMs)) {
    reasons.push("EXPIRED_EVIDENCE");
  }

  // Target verification references.
  if (!isNonEmptyString(target.operatorVerificationRef)
    || !Array.isArray(target.providerIdentityEvidenceRefs)
    || target.providerIdentityEvidenceRefs.length === 0
    || target.providerIdentityEvidenceRefs.some((ref) => !isNonEmptyString(ref))) {
    reasons.push("TARGET_NOT_VERIFIED");
  }

  // Required meters: all 14 IDs must be present; extra meters are allowed.
  let missingMeter = false;
  let loopCompleted = false;
  const seen = new Set();
  if (!Array.isArray(evidence.meters)) {
    missingMeter = true;
  } else {
    for (const meter of evidence.meters) {
      if (!isObject(meter) || !isNonEmptyString(meter.id) || seen.has(meter.id)) {
        missingMeter = true;
        break;
      }
      seen.add(meter.id);
      const expectedUnit = CANONICAL_UNITS[meter.id];
      const expectedKind = EXPECTED_RESET_KINDS[meter.id];
      const expectedScope = meter.id.startsWith("deno.") ? `deno:${target.denoOrganizationId}` : `cloudflare:${target.cloudflareAccountId}`;
      if (expectedUnit === undefined || expectedKind === undefined) {
        // Unknown meter: still validate structural contract for active-limit extras.
        if (!isObject(meter.resetWindow)
          || !isNonEmptyString(meter.scope)
          || !isNonEmptyString(meter.unit)) {
          reasons.push("METER_SCOPE_MISMATCH");
          break;
        }
        // Extra meters must also have complete evidence refs.
        if (!isNonEmptyString(meter.limitSourceUrl)
          || !isNonEmptyString(meter.usageEvidenceRef)
          || !isNonEmptyString(meter.normalForecastEvidenceRef)
          || !isNonEmptyString(meter.budgetEvidenceRef)
          || !isNonEmptyString(meter.reserveEvidenceRef)) {
          reasons.push("MISSING_EVIDENCE_REF");
          break;
        }
      } else {
        if (meter.unit !== expectedUnit || meter.scope !== expectedScope) {
          reasons.push("METER_SCOPE_MISMATCH");
          break;
        }
        if (!isObject(meter.resetWindow) || meter.resetWindow.kind !== expectedKind) {
          reasons.push("USAGE_PERIOD_MISMATCH");
          break;
        }
      }

      // Validate target usage period exists and matches for this meter.
      const targetPeriod = target.usagePeriods?.[meter.id];
      if (!isObject(targetPeriod) || !windowIdentity(meter.resetWindow, targetPeriod)) {
        reasons.push("USAGE_PERIOD_MISMATCH");
        break;
      }

      // Freshness of meter timestamps.
      if (!isFresh(meter.usageObservedAtUTC, nowMs) || !isFresh(meter.limitVerifiedAtUTC, nowMs)) {
        reasons.push("EXPIRED_EVIDENCE");
        break;
      }

      // Per-meter evidence refs.
      if (!isNonEmptyString(meter.limitSourceUrl)
        || !isNonEmptyString(meter.usageEvidenceRef)
        || !isNonEmptyString(meter.normalForecastEvidenceRef)
        || !isNonEmptyString(meter.budgetEvidenceRef)
        || !isNonEmptyString(meter.reserveEvidenceRef)) {
        reasons.push("MISSING_EVIDENCE_REF");
        break;
      }

      // Numeric contract: L - U - N - R >= B, unknown/non-finite/negative = HOLD.
      const L = meter.verifiedFreeLimit;
      const U = meter.consumedUsage;
      const N = meter.normalForecast;
      const R = meter.reserve;
      const B = meter.gateBudget;
      if (!isNonNegativeFinite(L) || !isNonNegativeFinite(U) || !isNonNegativeFinite(N) || !isNonNegativeFinite(R) || !isNonNegativeFinite(B)) {
        reasons.push("INSUFFICIENT_CAPACITY");
        break;
      }
      if (L - U - N - R < B) {
        reasons.push("INSUFFICIENT_CAPACITY");
        break;
      }

      // Explicit zero requires justification when any substantive value is zero and not authoritative.
      const hasZero = L === 0 || U === 0 || N === 0 || R === 0 || B === 0;
      if (hasZero && !isNonEmptyString(meter.zeroIncrementJustificationRef)) {
        reasons.push("MISSING_ZERO_JUSTIFICATION");
        break;
      }
    }
    loopCompleted = !missingMeter && reasons.length === 0;
  }
  if (missingMeter || (loopCompleted && !REQUIRED_METER_IDS.every((id) => seen.has(id)))) {
    reasons.push("MISSING_METER");
  }

  if (reasons.length > 0) {
    // Deduplicate while preserving order.
    const unique = [];
    for (const reason of reasons) {
      if (!unique.includes(reason)) unique.push(reason);
    }
    return { status: "PREFLIGHT_HOLD", reasons: unique };
  }
  return { status: "PREFLIGHT_PASS", reasons: [] };
}
