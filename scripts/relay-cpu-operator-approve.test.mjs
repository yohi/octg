import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);
const CLI_PATH = new URL("./relay-cpu-operator-approve.mjs", import.meta.url).pathname;

const { runOperatorApproveCli } = await import("./relay-cpu-operator-approve.mjs");

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return { exitCode: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("approve_cli_holds_in_non_interactive_mode", async () => {
  const { exitCode, stdout } = await runCli(["--record=/tmp/trust-record.json"]);
  assert.equal(exitCode, 2);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "PREFLIGHT_HOLD");
});

test("approve_cli_prints_help_in_non_interactive_mode", async () => {
  const { exitCode, stdout, stderr } = await runCli(["--help"]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /Usage: node scripts\/relay-cpu-operator-approve\.mjs/);
  assert.equal(stderr.trim(), "");
});

test("approve_cli_reports_missing_record_path_in_tty", async () => {
  let readCount = 0;
  let output = "";
  const originalLog = console.log;
  console.log = (line) => { output = line; };
  try {
    const exitCode = await runOperatorApproveCli([], {
      isTTY: true,
      readAndVerifyProtectedFile: async () => { readCount += 1; return undefined; },
    });
    assert.equal(exitCode, 1);
    assert.equal(readCount, 0);
    const result = JSON.parse(output);
    assert.equal(result.status, "PREFLIGHT_HOLD");
    assert.deepEqual(result.reasons, ["MISSING_RECORD_PATH"]);
  } finally {
    console.log = originalLog;
  }
});

test("approve_cli_accepts_matching_digest_in_injected_interactive_session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpu-approve-"));
  const recordPath = join(directory, "trust-record.json");
  const recordText = '{"schemaVersion":1,"recordId":"record-1"}';
  await writeFile(recordPath, recordText, { mode: 0o600 });
  try {
    const expectedDigest = createHash("sha256").update(recordText, "utf8").digest("hex");
    let promptCount = 0;
    const exitCode = await runOperatorApproveCli([`--record=${recordPath}`], {
      isTTY: true,
      question: async () => {
        promptCount += 1;
        return expectedDigest;
      },
      approvedDigest: expectedDigest,
      readAndVerifyProtectedFile: async (path) => ({
        bytes: new TextEncoder().encode(recordText),
        beforeRead: { isFile: true, isSymlink: false, uid: 1000, mode: 0o600 },
        afterRead: { isFile: true, isSymlink: false, uid: 1000, mode: 0o600 },
        fileIdentity: { device: "1", inode: "1" },
      }),
    });
    assert.equal(exitCode, 0);
    assert.equal(promptCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("approve_cli_holds_on_digest_mismatch_in_injected_interactive_session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpu-approve-"));
  const recordPath = join(directory, "trust-record.json");
  const recordText = '{"schemaVersion":1,"recordId":"record-1"}';
  await writeFile(recordPath, recordText, { mode: 0o600 });
  try {
    const exitCode = await runOperatorApproveCli([`--record=${recordPath}`], {
      isTTY: true,
      question: async () => "0".repeat(64),
      approvedDigest: "6f55bc3f65f0b74a7f2296eeff0e6d55e7e67c2e20e1f0f8b8f7b7d5d4f3e2a1",
      readAndVerifyProtectedFile: async (path) => ({
        bytes: new TextEncoder().encode(recordText),
        beforeRead: { isFile: true, isSymlink: false, uid: 1000, mode: 0o600 },
        afterRead: { isFile: true, isSymlink: false, uid: 1000, mode: 0o600 },
        fileIdentity: { device: "1", inode: "1" },
      }),
    });
    assert.equal(exitCode, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
