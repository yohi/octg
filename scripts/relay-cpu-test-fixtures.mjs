import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readAndVerifyProtectedFile } from "./relay-cpu-operator-trust.mjs";

export const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";
export const OTHER_REVISION = "ffffffffffffffffffffffffffffffffffffffff";
export const NOW_UTC = "2026-11-03T12:00:00.000Z";
export const WORKER_NAME = "octg-gateway";
export const CLOUDFLARE_ACCOUNT_ID = "cf-account-1";
export const DENO_ORGANIZATION_ID = "deno-org-1";

export const REQUIRED_METER_IDS = [
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

const UNITS = {
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

const RESET_KINDS = {
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
};

function resetWindow(id) {
  if (RESET_KINDS[id] === "utc_day") {
    return { kind: "utc_day", startUTC: "2026-11-03T00:00:00Z", endUTC: "2026-11-04T00:00:00Z" };
  }
  if (RESET_KINDS[id] === "billing_month") {
    return { kind: "billing_month", startUTC: "2026-11-01T00:00:00Z", endUTC: "2026-12-01T00:00:00Z" };
  }
  return { kind: "nonresetting_stock", asOfUTC: "2026-11-03T00:00:00Z" };
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function meter(id) {
  const scope = id.startsWith("deno.") ? `deno:${DENO_ORGANIZATION_ID}` : `cloudflare:${CLOUDFLARE_ACCOUNT_ID}`;
  return {
    id,
    scope,
    unit: UNITS[id],
    resetWindow: resetWindow(id),
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
  };
}

export function baseCapacityEvidence(stage = "stage1", environment = "preview") {
  return {
    version: 1,
    stage,
    environment,
    cloudflareAccountId: CLOUDFLARE_ACCOUNT_ID,
    denoOrganizationId: DENO_ORGANIZATION_ID,
    sourceRevision: SOURCE_REVISION,
    workerName: WORKER_NAME,
    observedAtUTC: "2026-11-03T11:55:00.000Z",
    expiresAtUTC: "2026-11-03T12:14:00.000Z",
    budgetMethodRef: "ref:method",
    freePlanEligibility: { cloudflare: "free", deno: "free", providerEvidenceRefs: ["ref:cf-free", "ref:deno-free"] },
    matrix: { seriesCount: 68, successesPerSeries: 500, attemptEnvelope: 170000, fullRun: true },
    meters: REQUIRED_METER_IDS.map((id) => meter(id)),
  };
}

export function baseExecutionTarget(stage = "stage1", environment = "preview") {
  const usagePeriods = {};
  for (const id of REQUIRED_METER_IDS) usagePeriods[id] = resetWindow(id);
  return {
    version: 1,
    stage,
    environment,
    cloudflareAccountId: CLOUDFLARE_ACCOUNT_ID,
    denoOrganizationId: DENO_ORGANIZATION_ID,
    workerName: WORKER_NAME,
    sourceRevision: SOURCE_REVISION,
    usagePeriods,
    freePlanEligibility: { cloudflare: "free", deno: "free" },
    verifiedAtUTC: "2026-11-03T11:55:00.000Z",
    operatorVerificationRef: "ref:operator-verification",
    providerIdentityEvidenceRefs: ["ref:provider-identity"],
  };
}

export async function makeTrustRoot(overrides = {}) {
  const stage = overrides.stage ?? "stage1";
  const environment = overrides.environment ?? "preview";
  const root = await mkdtemp(join(tmpdir(), "cpu-trust-"));
  const operatorUid = process.getuid ? process.getuid() : 1000;
  await mkdir(join(root, "approved"), { mode: 0o700, recursive: true });
  const recordId = overrides.recordId ?? "record-1";
  const sessionDir = join(root, "approved", recordId);
  await mkdir(sessionDir, { mode: 0o700 });

  const target = baseExecutionTarget(stage, environment);
  if (overrides.target) Object.assign(target, overrides.target);
  const targetText = JSON.stringify(target);
  const targetPath = join(sessionDir, "target.json");
  await writeFile(targetPath, targetText, { mode: 0o600 });

  const evidence = baseCapacityEvidence(stage, environment);
  if (overrides.evidence) Object.assign(evidence, overrides.evidence);
  const evidenceText = JSON.stringify(evidence);
  const evidencePath = join(sessionDir, "evidence.json");
  await writeFile(evidencePath, evidenceText, { mode: 0o600 });

  const proofEntries = [];
  const proofKinds = [
    "git_commit",
    "worker_config",
    "cloudflare_account",
    "cloudflare_free_plan",
    "cloudflare_usage",
    "deno_organization",
    "deno_free_plan",
    "deno_usage",
  ];
  const proofFiles = await Promise.all(proofKinds.map(async (kind) => {
    const proofText = `proof:${kind}`;
    const proofPath = join(sessionDir, `${kind}.txt`);
    await writeFile(proofPath, proofText, { mode: 0o600 });
    return {
      kind,
      sourceKind: "operator_verified_console",
      sourceRef: `${kind}.txt`,
      snapshotSha256: sha256(proofText),
      observedAtUTC: "2026-11-03T11:55:00.000Z",
      checkedIdentity: kind,
      verificationMethod: "console",
    };
  }));
  proofEntries.push(...proofFiles);

  const targetSha256 = sha256(targetText);
  const evidenceSha256 = sha256(evidenceText);
  const usagePeriodsSha256 = sha256(JSON.stringify(target.usagePeriods));
  const record = {
    schemaVersion: 1,
    recordId,
    operatorId: "operator-1",
    reviewedAtUTC: "2026-11-03T11:55:00.000Z",
    expiresAtUTC: "2026-11-03T12:14:00.000Z",
    targetSha256,
    capacityEvidenceSha256: evidenceSha256,
    target: {
      cloudflareAccountId: target.cloudflareAccountId,
      denoOrganizationId: target.denoOrganizationId,
      environment: target.environment,
      workerName: target.workerName,
      stage: target.stage,
      sourceRevision: target.sourceRevision,
      usagePeriodsSha256,
      freePlans: { cloudflare: "free", deno: "free" },
    },
    proofEntries,
    operatorDecision: "VERIFIED_FOR_CAPACITY_PREFLIGHT",
  };
  const recordText = JSON.stringify(record);
  const recordPath = join(sessionDir, "trust-record.json");
  await writeFile(recordPath, recordText, { mode: 0o600 });
  const recordSha256 = sha256(recordText);

  return {
    root,
    sessionDir,
    recordId,
    recordPath,
    targetPath,
    evidencePath,
    recordSha256,
    targetSha256,
    evidenceSha256,
    operatorUid,
    record,
    target,
    evidence,
  };
}
export function baseResolverDeps(fixture, overrides = {}) {
  const trustedOperatorSession = {
    operatorUid: fixture.operatorUid,
    approvedTrustRecordSha256: fixture.recordSha256,
    trustRootPath: join(fixture.root, "approved"),
    interactiveApprovalVerified: true,
    ...overrides.trustedOperatorSession,
  };
  return {
    readAndVerifyProtectedFile: overrides.readAndVerifyProtectedFile ?? readAndVerifyProtectedFile,
    trustedOperatorSession,
    gitHead: overrides.gitHead ?? (async () => SOURCE_REVISION),
    actualWorkerConfig: overrides.actualWorkerConfig ?? (async () => ({
      workerName: WORKER_NAME,
      environment: fixture.target.environment,
      cloudflareAccountId: CLOUDFLARE_ACCOUNT_ID,
    })),
    nowUTC: overrides.nowUTC ?? (() => NOW_UTC),
  };
}

export async function cleanupTrustRoot(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}
