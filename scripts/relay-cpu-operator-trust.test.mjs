import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  readAndVerifyProtectedFile,
  createOperatorVerifiedTargetResolver,
  resolveTrustedOperatorRuntimeDependencies,
} = await import("./relay-cpu-operator-trust.mjs");
import {
  makeTrustRoot,
  baseResolverDeps,
  baseCapacityEvidence,
  baseExecutionTarget,
  SOURCE_REVISION,
  NOW_UTC,
  sha256,
} from "./relay-cpu-test-fixtures.mjs";

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
