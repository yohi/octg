import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, mkdir, stat, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

const {
  readAndVerifyProtectedFile,
  createOperatorVerifiedTargetResolver,
  resolveTrustedOperatorRuntimeDependencies,
} = await import("./relay-cpu-operator-trust.mjs");

const NOW_UTC = "2026-11-03T12:00:00.000Z";
const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";

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

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function meter(id) {
  const scope = id.startsWith("deno.") ? "deno:deno-org-1" : "cloudflare:cf-account-1";
  let resetWindow;
  if (RESET_KINDS[id] === "utc_day") resetWindow = { kind: "utc_day", startUTC: "2026-11-03T00:00:00Z", endUTC: "2026-11-04T00:00:00Z" };
  else if (RESET_KINDS[id] === "billing_month") resetWindow = { kind: "billing_month", startUTC: "2026-11-01T00:00:00Z", endUTC: "2026-12-01T00:00:00Z" };
  else resetWindow = { kind: "nonresetting_stock", asOfUTC: "2026-11-03T00:00:00Z" };
  return {
    id,
    scope,
    unit: UNITS[id],
    resetWindow,
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

function baseCapacityEvidence() {
  const usagePeriods = {};
  for (const id of REQUIRED_METER_IDS) usagePeriods[id] = meter(id).resetWindow;
  return {
    version: 1,
    stage: "stage1",
    environment: "preview",
    cloudflareAccountId: "cf-account-1",
    denoOrganizationId: "deno-org-1",
    sourceRevision: SOURCE_REVISION,
    workerName: "octg-gateway",
    observedAtUTC: "2026-11-03T11:55:00.000Z",
    expiresAtUTC: "2026-11-03T12:14:00.000Z",
    budgetMethodRef: "ref:method",
    freePlanEligibility: { cloudflare: "free", deno: "free", providerEvidenceRefs: ["ref:cf-free", "ref:deno-free"] },
    matrix: { seriesCount: 68, successesPerSeries: 500, attemptEnvelope: 170000, fullRun: true },
    meters: REQUIRED_METER_IDS.map((id) => meter(id)),
  };
}

function baseExecutionTarget() {
  const usagePeriods = {};
  for (const id of REQUIRED_METER_IDS) usagePeriods[id] = meter(id).resetWindow;
  return {
    version: 1,
    stage: "stage1",
    environment: "preview",
    cloudflareAccountId: "cf-account-1",
    denoOrganizationId: "deno-org-1",
    workerName: "octg-gateway",
    sourceRevision: SOURCE_REVISION,
    usagePeriods,
    freePlanEligibility: { cloudflare: "free", deno: "free" },
    verifiedAtUTC: "2026-11-03T11:55:00.000Z",
    operatorVerificationRef: "ref:operator-verification",
    providerIdentityEvidenceRefs: ["ref:provider-identity"],
  };
}

async function makeTrustRoot(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "cpu-trust-"));
  const operatorUid = process.getuid ? process.getuid() : 1000;
  await mkdir(join(root, "approved"), { mode: 0o700, recursive: true });
  const recordId = overrides.recordId ?? "record-1";
  const sessionDir = join(root, "approved", recordId);
  await mkdir(sessionDir, { mode: 0o700 });

  const target = baseExecutionTarget();
  const targetText = JSON.stringify(target);
  const targetPath = join(sessionDir, "target.json");
  await writeFile(targetPath, targetText, { mode: 0o600 });

  const evidence = baseCapacityEvidence();
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
  for (const kind of proofKinds) {
    const proofText = `proof:${kind}`;
    const proofPath = join(sessionDir, `${kind}.txt`);
    await writeFile(proofPath, proofText, { mode: 0o600 });
    proofEntries.push({
      kind,
      sourceKind: "operator_verified_console",
      sourceRef: `${kind}.txt`,
      snapshotSha256: sha256(proofText),
      observedAtUTC: "2026-11-03T11:55:00.000Z",
      checkedIdentity: kind,
      verificationMethod: "console",
    });
  }

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

function baseResolverDeps(fixture, overrides = {}) {
  return {
    readAndVerifyProtectedFile,
    trustedOperatorSession: {
      operatorUid: fixture.operatorUid,
      approvedTrustRecordSha256: fixture.recordSha256,
      trustRootPath: join(fixture.root, "approved"),
      interactiveApprovalVerified: true,
      ...overrides.trustedOperatorSession,
    },
    gitHead: async () => SOURCE_REVISION,
    actualWorkerConfig: async () => ({
      workerName: "octg-gateway",
      environment: "preview",
      cloudflareAccountId: "cf-account-1",
    }),
    nowUTC: () => NOW_UTC,
    ...overrides,
  };
}

test("readAndVerifyProtectedFile returns a verified snapshot for a regular file", async () => {
  const fixture = await makeTrustRoot();
  try {
    const snapshot = await readAndVerifyProtectedFile(fixture.recordPath, fixture.operatorUid);
    assert.ok(snapshot);
    assert.equal(new TextDecoder().decode(snapshot.bytes), await (await import("node:fs/promises")).readFile(fixture.recordPath, "utf8"));
    assert.equal(snapshot.beforeRead.uid, fixture.operatorUid);
    assert.equal(snapshot.afterRead.uid, fixture.operatorUid);
    assert.equal(snapshot.fileIdentity.device, snapshot.beforeRead.device);
    assert.equal(snapshot.fileIdentity.inode, snapshot.beforeRead.inode);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("trust_root_symlink_or_writable_parent_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    const symlinkRoot = await mkdtemp(join(tmpdir(), "cpu-trust-symlink-"));
    const symlinkSession = join(symlinkRoot, fixture.recordId);
    await symlink(fixture.sessionDir, symlinkSession);
    const resolver = createOperatorVerifiedTargetResolver({
      ...baseResolverDeps(fixture),
      trustedOperatorSession: {
        operatorUid: fixture.operatorUid,
        approvedTrustRecordSha256: fixture.recordSha256,
        trustRootPath: symlinkRoot,
        interactiveApprovalVerified: true,
      },
    });
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: join(symlinkSession, "target.json"),
      capacityEvidencePath: join(symlinkSession, "evidence.json"),
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("record_wrong_uid_or_file_mode_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    await chmod(fixture.recordPath, 0o644);
    const resolver = createOperatorVerifiedTargetResolver(baseResolverDeps(fixture));
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("operator_session_digest_missing_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    const resolver = createOperatorVerifiedTargetResolver({
      ...baseResolverDeps(fixture),
      trustedOperatorSession: {
        operatorUid: fixture.operatorUid,
        approvedTrustRecordSha256: "",
        trustRootPath: join(fixture.root, "approved"),
        interactiveApprovalVerified: false,
      },
    });
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("operator_session_digest_mismatch_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    const resolver = createOperatorVerifiedTargetResolver({
      ...baseResolverDeps(fixture),
      trustedOperatorSession: {
        operatorUid: fixture.operatorUid,
        approvedTrustRecordSha256: "0".repeat(64),
        trustRootPath: join(fixture.root, "approved"),
        interactiveApprovalVerified: true,
      },
    });
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("provider_snapshot_hash_mismatch_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    const proofPath = join(fixture.sessionDir, "git_commit.txt");
    await writeFile(proofPath, "tampered", { mode: 0o600 });
    const resolver = createOperatorVerifiedTargetResolver(baseResolverDeps(fixture));
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unreadable_protected_provider_snapshot_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    const proofPath = join(fixture.sessionDir, "git_commit.txt");
    await rm(proofPath);
    const resolver = createOperatorVerifiedTargetResolver(baseResolverDeps(fixture));
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cloudflare_account_and_deno_org_proof_disagree_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    const resolver = createOperatorVerifiedTargetResolver({
      ...baseResolverDeps(fixture),
      actualWorkerConfig: async () => ({
        workerName: "octg-gateway",
        environment: "preview",
        cloudflareAccountId: "cf-account-other",
      }),
    });
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("git_commit_does_not_match_checkout_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    const resolver = createOperatorVerifiedTargetResolver({
      ...baseResolverDeps(fixture),
      gitHead: async () => "ffffffffffffffffffffffffffffffffffffffff",
    });
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("capacity_evidence_digest_mismatch_or_file_tamper_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    await writeFile(fixture.evidencePath, "{\"tampered\":true}", { mode: 0o600 });
    const resolver = createOperatorVerifiedTargetResolver(baseResolverDeps(fixture));
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("capacity_evidence_replaced_during_read_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    const resolver = createOperatorVerifiedTargetResolver({
      ...baseResolverDeps(fixture),
      readAndVerifyProtectedFile: async () => undefined,
    });
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("capacity_evidence_from_other_operator_session_holds", async () => {
  const fixtureA = await makeTrustRoot({ recordId: "record-a" });
  const fixtureB = await makeTrustRoot({ recordId: "record-b" });
  try {
    const resolver = createOperatorVerifiedTargetResolver(baseResolverDeps(fixtureA));
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixtureA.targetPath,
      capacityEvidencePath: fixtureB.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixtureA.root, { recursive: true, force: true });
    await rm(fixtureB.root, { recursive: true, force: true });
  }
});

test("capacity_evidence_or_proof_expired_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    const resolver = createOperatorVerifiedTargetResolver({
      ...baseResolverDeps(fixture),
      nowUTC: () => "2026-11-03T13:00:00.000Z",
    });
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unverifiable_free_plan_or_expired_usage_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    const evidence = JSON.parse(await (await import("node:fs/promises")).readFile(fixture.evidencePath, "utf8"));
    evidence.freePlanEligibility.providerEvidenceRefs = [];
    evidence.meters = evidence.meters.map((m) => ({ ...m, usageObservedAtUTC: "2026-11-03T10:00:00.000Z" }));
    const evidenceText = JSON.stringify(evidence);
    await writeFile(fixture.evidencePath, evidenceText, { mode: 0o600 });
    const newRecord = { ...fixture.record, capacityEvidenceSha256: sha256(evidenceText) };
    await writeFile(fixture.recordPath, JSON.stringify(newRecord), { mode: 0o600 });
    const resolver = createOperatorVerifiedTargetResolver({
      ...baseResolverDeps(fixture),
      trustedOperatorSession: {
        operatorUid: fixture.operatorUid,
        approvedTrustRecordSha256: sha256(JSON.stringify(newRecord)),
        trustRootPath: join(fixture.root, "approved"),
        interactiveApprovalVerified: true,
      },
    });
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("untrusted_target_not_derived_from_approved_record_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    const otherTarget = baseExecutionTarget();
    otherTarget.workerName = "other-worker";
    const otherTargetPath = join(fixture.sessionDir, "other-target.json");
    await writeFile(otherTargetPath, JSON.stringify(otherTarget), { mode: 0o600 });
    const resolver = createOperatorVerifiedTargetResolver(baseResolverDeps(fixture));
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: otherTargetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("approved_target_with_unapproved_capacity_evidence_swap_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    const otherEvidence = baseCapacityEvidence();
    otherEvidence.cloudflareAccountId = "cf-account-other";
    const otherEvidencePath = join(fixture.sessionDir, "other-evidence.json");
    await writeFile(otherEvidencePath, JSON.stringify(otherEvidence), { mode: 0o600 });
    const resolver = createOperatorVerifiedTargetResolver(baseResolverDeps(fixture));
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: otherEvidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("two_matching_unapproved_jsons_hold", async () => {
  const fixture = await makeTrustRoot();
  try {
    const unapprovedRecord = { ...fixture.record, operatorDecision: "UNAPPROVED" };
    await writeFile(fixture.recordPath, JSON.stringify(unapprovedRecord), { mode: 0o600 });
    const resolver = createOperatorVerifiedTargetResolver({
      ...baseResolverDeps(fixture),
      trustedOperatorSession: {
        operatorUid: fixture.operatorUid,
        approvedTrustRecordSha256: sha256(JSON.stringify(unapprovedRecord)),
        trustRootPath: join(fixture.root, "approved"),
        interactiveApprovalVerified: true,
      },
    });
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("operator_ref_string_without_resolvable_proof_holds", async () => {
  const fixture = await makeTrustRoot();
  try {
    const record = JSON.parse(await (await import("node:fs/promises")).readFile(fixture.recordPath, "utf8"));
    record.proofEntries[0].sourceRef = "missing.txt";
    const recordText = JSON.stringify(record);
    await writeFile(fixture.recordPath, recordText, { mode: 0o600 });
    const resolver = createOperatorVerifiedTargetResolver({
      ...baseResolverDeps(fixture),
      trustedOperatorSession: {
        operatorUid: fixture.operatorUid,
        approvedTrustRecordSha256: sha256(recordText),
        trustRootPath: join(fixture.root, "approved"),
        interactiveApprovalVerified: true,
      },
    });
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.equal(result, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("capacity_evidence_actual_bytes_including_newline_hash_checked", async () => {
  const fixture = await makeTrustRoot();
  try {
    const evidenceText = await (await import("node:fs/promises")).readFile(fixture.evidencePath, "utf8");
    const expectedHash = sha256(evidenceText);
    assert.equal(fixture.evidenceSha256, expectedHash);
    const resolver = createOperatorVerifiedTargetResolver(baseResolverDeps(fixture));
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.ok(result);
    assert.equal(result.capacityEvidenceSha256, expectedHash);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("capacity_evidence_verified_snapshot_is_exactly_evaluator_input", async () => {
  const fixture = await makeTrustRoot();
  try {
    const resolver = createOperatorVerifiedTargetResolver(baseResolverDeps(fixture));
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.ok(result);
    assert.equal(result.trustRecordId, fixture.recordId);
    assert.equal(result.capacityEvidence.version, 1);
    assert.equal(result.capacityEvidence.cloudflareAccountId, "cf-account-1");
    assert.equal(result.target.workerName, "octg-gateway");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verified_trust_record_and_independent_evidence_accepts_target", async () => {
  const fixture = await makeTrustRoot();
  try {
    const resolver = createOperatorVerifiedTargetResolver(baseResolverDeps(fixture));
    const result = await resolver({
      mode: "stage1",
      sourceRevision: SOURCE_REVISION,
      workerName: "octg-gateway",
      environment: "preview",
      targetPath: fixture.targetPath,
      capacityEvidencePath: fixture.evidencePath,
    });
    assert.ok(result);
    assert.equal(result.capacityEvidenceSha256, fixture.evidenceSha256);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
