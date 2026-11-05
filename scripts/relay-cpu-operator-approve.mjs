import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { readAndVerifyProtectedFile } from "./relay-cpu-operator-trust.mjs";
import { createHash } from "node:crypto";

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isValidHex64(value) {
  return typeof value === "string" && value.length === 64 && /^[0-9a-f]+$/.test(value);
}

function emitResult(result) {
  console.log(JSON.stringify(result));
}

function parseArguments(argv) {
  const allowed = new Set(["--record", "--help"]);
  const seen = new Set();
  let recordPath;
  for (const argument of argv) {
    const separatorIndex = argument.indexOf("=");
    if (separatorIndex <= 0) return { error: "INVALID_CLI_ARGUMENT" };
    const key = argument.slice(0, separatorIndex);
    if (!allowed.has(key) || seen.has(key)) return { error: "INVALID_CLI_ARGUMENT" };
    seen.add(key);
    if (key === "--record") recordPath = argument.slice(separatorIndex + 1);
  }
  return { recordPath };
}

/**
 * Run the interactive Operator approval CLI.
 * @param {string[]} argv
 * @param {Object} [injected]
 * @param {boolean} [injected.isTTY]
 * @param {(prompt:string) => Promise<string>} [injected.question]
 * @param {string} [injected.approvedDigest]
 * @param {(path:string) => Promise<Object|undefined>} [injected.readAndVerifyProtectedFile]
 * @returns {Promise<0|1|2>}
 */
export async function runOperatorApproveCli(
  argv = process.argv.slice(2),
  injected = {},
) {
  const isTTY = injected.isTTY ?? (process.stdin?.isTTY && process.stdout?.isTTY);
  const readFile = injected.readAndVerifyProtectedFile ?? readAndVerifyProtectedFile;

  if (!isTTY) {
    emitResult({ status: "PREFLIGHT_HOLD", reasons: ["OPERATOR_NOT_CONFIRMED"] });
    return 2;
  }

  const parsed = parseArguments(argv);
  if (parsed.error) {
    emitResult({ status: "PREFLIGHT_HOLD", reasons: [parsed.error] });
    return 1;
  }
  const { recordPath } = parsed;

  if (argv.includes("--help")) {
    console.log("Usage: node scripts/relay-cpu-operator-approve.mjs --record=<path>");
    return 0;
  }

  if (!recordPath) {
    emitResult({ status: "PREFLIGHT_HOLD", reasons: ["MISSING_RECORD_PATH"] });
    return 1;
  }

  const snapshot = await readFile(recordPath);
  if (snapshot === undefined) {
    emitResult({ status: "PREFLIGHT_HOLD", reasons: ["IO_ERROR"] });
    return 1;
  }

  const digest = sha256Bytes(snapshot.bytes);
  if (!isValidHex64(digest)) {
    emitResult({ status: "PREFLIGHT_HOLD", reasons: ["HASH_MISMATCH"] });
    return 1;
  }

  let operatorInput;
  if (injected.question !== undefined) {
    operatorInput = await injected.question(`Confirm Trust Record SHA-256 ${digest}: `);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      operatorInput = await rl.question(`Confirm Trust Record SHA-256 ${digest}: `);
    } finally {
      rl.close();
    }
  }

  const trimmed = operatorInput?.trim() ?? "";
  if (!isValidHex64(trimmed) || trimmed !== digest) {
    emitResult({ status: "PREFLIGHT_HOLD", reasons: ["OPERATOR_NOT_CONFIRMED"] });
    return 2;
  }

  if (injected.approvedDigest !== undefined && trimmed !== injected.approvedDigest) {
    emitResult({ status: "PREFLIGHT_HOLD", reasons: ["APPROVAL_SESSION_MISMATCH"] });
    return 2;
  }

  emitResult({ status: "PREFLIGHT_PASS", reasons: [], trustRecordSha256: digest });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runOperatorApproveCli();
  } catch {
    emitResult({ status: "PREFLIGHT_HOLD", reasons: ["UNEXPECTED_ERROR"] });
    process.exitCode = 1;
  }
}
