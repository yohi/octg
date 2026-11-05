import { open, lstat, readFile, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, basename, resolve as resolvePath, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { evaluateCapacityPreflight } from "./relay-cpu-capacity.mjs";

/**
 * @typedef {Object} ProtectedFileSnapshotV1
 * @property {Uint8Array} bytes
 * @property {{device:string, inode:string}} fileIdentity
 * @property {{isFile:boolean, isSymlink:boolean, uid:number, mode:number, device:string, inode:string, size:number, mtimeNs:string, ctimeNs:string}} beforeRead
 * @property {{isFile:boolean, isSymlink:boolean, uid:number, mode:number, device:string, inode:string, size:number, mtimeNs:string, ctimeNs:string}} afterRead
 */

const REQUIRED_PROOF_KINDS = new Set([
  "git_commit",
  "worker_config",
  "cloudflare_account",
  "cloudflare_free_plan",
  "cloudflare_usage",
  "deno_organization",
  "deno_free_plan",
  "deno_usage",
]);

const FRESHNESS_MS = 15 * 60 * 1000;
const VALID_MODES = new Set(["stage1", "stage2-preflight", "stage2-series"]);

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseIsoUTC(iso) {
  if (typeof iso !== "string" || iso.length === 0) return undefined;
  const date = new Date(iso);
  const time = date.getTime();
  return Number.isNaN(time) ? undefined : time;
}

function isFresh(iso, nowMs) {
  const ms = parseIsoUTC(iso);
  if (ms === undefined) return false;
  if (ms > nowMs) return false;
  return nowMs - ms <= FRESHNESS_MS;
}

function statsToSnapshot(stats) {
  const uid = typeof stats.uid === "bigint" ? Number(stats.uid) : stats.uid;
  const mode = typeof stats.mode === "bigint" ? Number(stats.mode) : stats.mode;
  return {
    isFile: stats.isFile(),
    isSymlink: stats.isSymbolicLink(),
    uid,
    mode,
    device: String(stats.dev),
    inode: String(stats.ino),
    size: typeof stats.size === "bigint" ? Number(stats.size) : stats.size,
    mtimeNs: typeof stats.mtimeNs === "bigint" ? stats.mtimeNs.toString() : String(stats.mtimeNs),
    ctimeNs: typeof stats.ctimeNs === "bigint" ? stats.ctimeNs.toString() : String(stats.ctimeNs),
  };
}

function hasProtectedPermissions(stats, expectedUid) {
  return stats.isFile() && !stats.isSymbolicLink() && (stats.mode & 0o777) === 0o600
    && (expectedUid === undefined || stats.uid === expectedUid);
}

function hasProtectedSnapshot(snapshot, expectedUid) {
  return snapshot.isFile && !snapshot.isSymlink && (snapshot.mode & 0o777) === 0o600
    && (expectedUid === undefined || snapshot.uid === expectedUid);
}

function isStableSnapshot(beforeRead, afterRead) {
  return beforeRead.isFile && !beforeRead.isSymlink && afterRead.isFile && !afterRead.isSymlink
    && beforeRead.device === afterRead.device && beforeRead.inode === afterRead.inode
    && beforeRead.size === afterRead.size && beforeRead.mtimeNs === afterRead.mtimeNs
    && beforeRead.ctimeNs === afterRead.ctimeNs && beforeRead.uid === afterRead.uid
    && beforeRead.mode === afterRead.mode;
}

/**
 * Read a protected file using a single FD and before/after stat.
 * Returns undefined if the file is a symlink, not a regular file, not owned by
 * the expected UID, has insecure permissions, or changes during read.
 * @param {string} filePath
 * @param {number} [expectedUid]
 * @returns {Promise<ProtectedFileSnapshotV1 | undefined>}
 */
export async function readAndVerifyProtectedFile(filePath, expectedUid) {
  if (!isAbsolute(filePath)) return undefined;

  let parentStats;
  try {
    parentStats = await lstat(dirname(filePath));
  } catch {
    return undefined;
  }
  if (!parentStats.isDirectory() || (parentStats.mode & 0o022) !== 0) return undefined; // no group/other write
  if (expectedUid !== undefined && parentStats.uid !== expectedUid) return undefined;

  let pathStats;
  try {
    pathStats = await lstat(filePath);
  } catch {
    return undefined;
  }
  if (!hasProtectedPermissions(pathStats, expectedUid)) return undefined;

  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }

  try {
    const beforeRead = statsToSnapshot(await handle.stat({ bigint: true }));
    if (!hasProtectedSnapshot(beforeRead, expectedUid)) return undefined;

    const bytes = new Uint8Array(await readFile(handle));

    const afterRead = statsToSnapshot(await handle.stat({ bigint: true }));
    if (!hasProtectedSnapshot(afterRead, expectedUid)
      || !isStableSnapshot(beforeRead, afterRead)) return undefined;

    return {
      bytes,
      fileIdentity: { device: beforeRead.device, inode: beforeRead.inode },
      beforeRead,
      afterRead,
    };
  } finally {
    await handle.close();
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isValidHex64(value) {
  return typeof value === "string" && value.length === 64 && /^[0-9a-f]+$/.test(value);
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

function identityMatches(a, b) {
  return a.cloudflareAccountId === b.cloudflareAccountId
    && a.denoOrganizationId === b.denoOrganizationId
    && a.environment === b.environment
    && a.workerName === b.workerName
    && a.sourceRevision === b.sourceRevision;
}

function isWithinTrustRoot(filePath, trustRootPath) {
  if (!isAbsolute(filePath) || !isAbsolute(trustRootPath)) return false;
  const realRoot = resolvePath(trustRootPath);
  const realFile = resolvePath(filePath);
  return realFile.startsWith(`${realRoot}/`) || realFile === realRoot;
}

function isValidSourceKind(value) {
  return value === "authenticated_provider_read" || value === "operator_verified_console" || value === "local_git" || value === "local_config";
}

async function loadApprovedRecord(args, deps, trustRootPath, operatorUid, approvedTrustRecordSha256, interactiveApprovalVerified) {
  if (!isObject(args) || !isNonEmptyString(args.mode) || !VALID_MODES.has(args.mode)
    || !isValidHexSha40(args.sourceRevision) || !isNonEmptyString(args.workerName)
    || !isValidEnvironment(args.environment) || !isNonEmptyString(args.targetPath)
    || !isNonEmptyString(args.capacityEvidencePath)) return undefined;
  if (!isWithinTrustRoot(args.targetPath, trustRootPath) || !isWithinTrustRoot(args.capacityEvidencePath, trustRootPath)) return undefined;
  const targetSession = dirname(resolvePath(args.targetPath));
  if (dirname(resolvePath(args.capacityEvidencePath)) !== targetSession
    || dirname(targetSession) !== resolvePath(trustRootPath)) return undefined;
  const recordId = basename(targetSession);
  if (!isNonEmptyString(recordId)) return undefined;
  const snapshot = await deps.readAndVerifyProtectedFile(resolvePath(targetSession, "trust-record.json"), operatorUid);
  if (snapshot === undefined) return undefined;
  if (!isValidHex64(approvedTrustRecordSha256) || sha256Bytes(snapshot.bytes) !== approvedTrustRecordSha256
    || !interactiveApprovalVerified) return undefined;
  let record;
  try {
    record = JSON.parse(new TextDecoder().decode(snapshot.bytes));
  } catch {
    return undefined;
  }
  if (!isObject(record) || record.schemaVersion !== 1 || record.recordId !== recordId
    || !isNonEmptyString(record.operatorId) || record.operatorDecision !== "VERIFIED_FOR_CAPACITY_PREFLIGHT"
    || !isObject(record.target) || !Array.isArray(record.proofEntries)) return undefined;
  const recordTarget = record.target;
  if (!isValidEnvironment(recordTarget.environment) || !isNonEmptyString(recordTarget.cloudflareAccountId)
    || !isNonEmptyString(recordTarget.denoOrganizationId) || !isNonEmptyString(recordTarget.workerName)
    || !isValidStage(recordTarget.stage) || !isValidHexSha40(recordTarget.sourceRevision)
    || !isObject(recordTarget.freePlans) || recordTarget.freePlans.cloudflare !== "free"
    || recordTarget.freePlans.deno !== "free" || !isNonEmptyString(recordTarget.usagePeriodsSha256)) return undefined;
  const nowMs = parseIsoUTC(deps.nowUTC());
  const expiresAtMs = parseIsoUTC(record.expiresAtUTC);
  if (nowMs === undefined || !isFresh(record.reviewedAtUTC, nowMs)
    || expiresAtMs === undefined || expiresAtMs <= nowMs) return undefined;
  return { args, record, recordId, recordTarget, targetSession, nowMs };
}

async function loadApprovedInputs(context, deps, operatorUid) {
  const { args, record, recordTarget } = context;
  const targetSnapshot = await deps.readAndVerifyProtectedFile(args.targetPath, operatorUid);
  if (targetSnapshot === undefined || !isValidHex64(record.targetSha256)
    || sha256Bytes(targetSnapshot.bytes) !== record.targetSha256) return undefined;
  let target;
  try {
    target = JSON.parse(new TextDecoder().decode(targetSnapshot.bytes));
  } catch {
    return undefined;
  }
  if (!isObject(target) || target.version !== 1 || !identityMatches(target, recordTarget)
    || target.stage !== recordTarget.stage
    || target.stage !== (args.mode === "stage1" ? "stage1" : "stage2")
    || target.workerName !== args.workerName || target.environment !== args.environment
    || sha256Bytes(new TextEncoder().encode(JSON.stringify(target.usagePeriods))) !== recordTarget.usagePeriodsSha256) return undefined;
  const evidenceSnapshot = await deps.readAndVerifyProtectedFile(args.capacityEvidencePath, operatorUid);
  if (evidenceSnapshot === undefined || !isValidHex64(record.capacityEvidenceSha256)
    || sha256Bytes(evidenceSnapshot.bytes) !== record.capacityEvidenceSha256) return undefined;
  let capacityEvidence;
  try {
    capacityEvidence = JSON.parse(new TextDecoder().decode(evidenceSnapshot.bytes));
  } catch {
    return undefined;
  }
  if (!isObject(capacityEvidence) || capacityEvidence.version !== 1 || !identityMatches(capacityEvidence, recordTarget)
    || capacityEvidence.stage !== target.stage) return undefined;
  return { target, capacityEvidence, capacityEvidenceSha256: record.capacityEvidenceSha256 };
}

async function verifyProofEntries(entries, targetSession, operatorUid, nowMs, readFile) {
  const seen = new Set();
  for (const entry of entries) {
    if (!isObject(entry) || !REQUIRED_PROOF_KINDS.has(entry.kind) || !isValidSourceKind(entry.sourceKind)
      || !isNonEmptyString(entry.sourceRef) || isAbsolute(entry.sourceRef) || !isValidHex64(entry.snapshotSha256)
      || !isNonEmptyString(entry.observedAtUTC) || !isNonEmptyString(entry.checkedIdentity)
      || !isNonEmptyString(entry.verificationMethod) || seen.has(entry.kind) || !isFresh(entry.observedAtUTC, nowMs)) return false;
    seen.add(entry.kind);
    const proofPath = resolvePath(targetSession, entry.sourceRef);
    if (dirname(proofPath) !== targetSession) return false;
    const proofSnapshot = await readFile(proofPath, operatorUid);
    if (proofSnapshot === undefined || sha256Bytes(proofSnapshot.bytes) !== entry.snapshotSha256) return false;
  }
  return seen.size === REQUIRED_PROOF_KINDS.size;
}

/**
 * Create an Operator-verified target resolver.
 * @param {Object} deps
 * @param {(path:string, expectedUid?:number) => Promise<ProtectedFileSnapshotV1|undefined>} deps.readAndVerifyProtectedFile
 * @param {{operatorUid:number, approvedTrustRecordSha256:string, trustRootPath:string, interactiveApprovalVerified:boolean}} deps.trustedOperatorSession
 * @param {() => Promise<string>} deps.gitHead
 * @param {() => Promise<{workerName:string, environment:'preview'|'production', cloudflareAccountId:string}>} deps.actualWorkerConfig
 * @param {() => string} deps.nowUTC
 * @returns {(args: {mode:'stage1'|'stage2-preflight'|'stage2-series', sourceRevision:string, workerName:string, scriptVersionId?:string, environment:'preview'|'production', targetPath:string, capacityEvidencePath:string}) => Promise<{target:Object, capacityEvidence:Object, capacityEvidenceSha256:string, trustRecordId:string} | undefined>}
 */
export function createOperatorVerifiedTargetResolver(deps) {
  const { readAndVerifyProtectedFile: readFile } = deps;
  const { operatorUid, approvedTrustRecordSha256, trustRootPath, interactiveApprovalVerified } = deps.trustedOperatorSession;

  return async (args) => {
    const context = await loadApprovedRecord(args, deps, trustRootPath, operatorUid, approvedTrustRecordSha256, interactiveApprovalVerified);
    if (!context) return undefined;
    const inputs = await loadApprovedInputs(context, deps, operatorUid);
    if (!inputs) return undefined;
    const gitHead = await deps.gitHead();
    if (!isValidHexSha40(gitHead) || gitHead !== context.recordTarget.sourceRevision || gitHead !== args.sourceRevision) return undefined;

    const workerConfig = await deps.actualWorkerConfig();
    if (!isObject(workerConfig)
      || workerConfig.workerName !== context.recordTarget.workerName
      || workerConfig.environment !== context.recordTarget.environment
      || workerConfig.cloudflareAccountId !== context.recordTarget.cloudflareAccountId) {
      return undefined;
    }
    if (!await verifyProofEntries(context.record.proofEntries, context.targetSession, operatorUid, context.nowMs, readFile)) return undefined;

    // Capacity preflight must pass on the verified bytes.
    const preflight = evaluateCapacityPreflight(inputs.capacityEvidence, inputs.target, deps.nowUTC());
    if (preflight.status !== "PREFLIGHT_PASS") return undefined;

    return {
      ...inputs,
      trustRecordId: context.recordId,
    };
  };
}

/**
 * Resolve runtime dependencies for an Operator-verified session.
 * Prompts the Operator for the approved Trust Record SHA-256 when running in an
 * interactive TTY. Returns undefined otherwise.
 * @returns {Promise<Object|undefined>}
 */
export async function resolveTrustedOperatorRuntimeDependencies() {
  const trustRootPath = resolvePath(homedir(), ".local/state/octg/cpu-gate/approved");
  const operatorUid = process.getuid ? process.getuid() : 0;

  if (!process.stdin?.isTTY || !process.stdout?.isTTY) {
    return undefined;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let digest;
    try {
      digest = await rl.question("Enter approved Trust Record SHA-256 (64 lowercase hex): ");
    } catch {
      return undefined;
    }
    if (!isValidHex64(digest.trim())) return undefined;
    return {
      readAndVerifyProtectedFile,
      trustedOperatorSession: {
        operatorUid,
        approvedTrustRecordSha256: digest.trim(),
        trustRootPath,
        interactiveApprovalVerified: true,
      },
      gitHead: async () => {
        throw new Error("gitHead must be injected by caller");
      },
      actualWorkerConfig: async () => {
        throw new Error("actualWorkerConfig must be injected by caller");
      },
      nowUTC: () => new Date().toISOString(),
    };
  } finally {
    rl.close();
  }
}
