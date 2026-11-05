import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_PATH = new URL("./relay-cpu-capacity-cli.mjs", import.meta.url).pathname;
import { baseCapacityEvidence as baseEvidence, baseExecutionTarget as baseTarget, NOW_UTC } from "./relay-cpu-test-fixtures.mjs";

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
