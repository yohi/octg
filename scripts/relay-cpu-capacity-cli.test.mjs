import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_PATH = new URL("./relay-cpu-capacity-cli.mjs", import.meta.url).pathname;

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

const NOW_UTC = "2026-11-03T12:00:00.000Z";

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

function baseEvidence(overrides = {}) {
  const usagePeriods = {};
  for (const id of REQUIRED_METER_IDS) usagePeriods[id] = meter(id).resetWindow;
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

function baseTarget() {
  const usagePeriods = {};
  for (const id of REQUIRED_METER_IDS) usagePeriods[id] = meter(id).resetWindow;
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
  };
}

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return { exitCode: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function makeTempFiles(evidence, target) {
  const directory = await mkdtemp(join(tmpdir(), "cpu-capacity-cli-"));
  const evidencePath = join(directory, "evidence.json");
  const targetPath = target === undefined ? evidencePath : join(directory, "target.json");
  await writeFile(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
  if (target !== undefined) {
    await writeFile(targetPath, JSON.stringify(target), { mode: 0o600 });
  }
  return { directory, evidencePath, targetPath };
}

test("cli_passes_with_valid_evidence_and_target", async () => {
  const { directory, evidencePath, targetPath } = await makeTempFiles(baseEvidence(), baseTarget());
  try {
    const { stdout, stderr, exitCode } = await runCli([`--evidence=${evidencePath}`, `--target=${targetPath}`, `--now=${NOW_UTC}`]);
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "PREFLIGHT_PASS");
    assert.equal(stderr.trim(), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cli_holds_on_insufficient_capacity", async () => {
  const evidence = baseEvidence();
  evidence.meters = evidence.meters.map((m) =>
    m.id === "workers.requests.daily" ? { ...m, verifiedFreeLimit: 50, consumedUsage: 0, normalForecast: 0, reserve: 0, gateBudget: 100 } : m,
  );
  const { directory, evidencePath, targetPath } = await makeTempFiles(evidence, baseTarget());
  try {
    const { stdout, stderr, exitCode } = await runCli([`--evidence=${evidencePath}`, `--target=${targetPath}`, `--now=${NOW_UTC}`]);
    assert.equal(exitCode, 2);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "PREFLIGHT_HOLD");
    assert.ok(result.reasons.includes("INSUFFICIENT_CAPACITY"));
    assert.equal(stderr.trim(), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cli_holds_when_evidence_and_target_are_same_file", async () => {
  const evidence = baseEvidence();
  const { directory, evidencePath } = await makeTempFiles(evidence);
  try {
    const { stdout, exitCode } = await runCli([`--evidence=${evidencePath}`, `--target=${evidencePath}`, `--now=${NOW_UTC}`]);
    assert.equal(exitCode, 2);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "PREFLIGHT_HOLD");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cli_exits_malformed_on_missing_arguments", async () => {
  const { exitCode, stdout } = await runCli(["--target=/tmp/target.json", `--now=${NOW_UTC}`]);
  assert.equal(exitCode, 1);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "PREFLIGHT_HOLD");
});

test("cli_exits_malformed_on_unreadable_evidence_file", async () => {
  const { directory, targetPath } = await makeTempFiles(baseTarget());
  try {
    const { exitCode, stdout } = await runCli([`--evidence=${join(directory, "missing.json")}`, `--target=${targetPath}`, `--now=${NOW_UTC}`]);
    assert.equal(exitCode, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "PREFLIGHT_HOLD");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
