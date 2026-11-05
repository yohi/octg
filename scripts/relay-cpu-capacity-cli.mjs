import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evaluateCapacityPreflight } from "./relay-cpu-capacity.mjs";

/**
 * Run the offline capacity preflight CLI.
 * @param {string[]} argv
 * @returns {Promise<0|1|2>}
 */
export async function runCapacityPreflightCli(argv = process.argv.slice(2)) {
  let evidencePath;
  let targetPath;
  let nowUTC;
  const allowed = new Set(["--evidence", "--target", "--now", "--help"]);
  const seen = new Set();
  for (const argument of argv) {
    const separatorIndex = argument.indexOf("=");
    if (separatorIndex <= 0) return emitMalformed("INVALID_CLI_ARGUMENT");
    const key = argument.slice(0, separatorIndex);
    const value = argument.slice(separatorIndex + 1);
    if (!allowed.has(key) || seen.has(key)) return emitMalformed("INVALID_CLI_ARGUMENT");
    seen.add(key);
    if (key === "--evidence") evidencePath = value;
    else if (key === "--target") targetPath = value;
    else if (key === "--now") nowUTC = value;
  }

  if (argv.includes("--help")) {
    console.log("Usage: node scripts/relay-cpu-capacity-cli.mjs --evidence=<path> --target=<path> --now=<ISO-UTC>");
    return 0;
  }

  if (!evidencePath || !targetPath || !nowUTC) {
    return emitMalformed("MISSING_CLI_ARGUMENT");
  }

  // Trust boundary: same file cannot be both evidence and independently verified target.
  if (evidencePath === targetPath) {
    return emitResult({ status: "PREFLIGHT_HOLD", reasons: ["TARGET_NOT_VERIFIED"] });
  }

  let evidenceText;
  let targetText;
  try {
    [evidenceText, targetText] = await Promise.all([readFile(evidencePath, "utf8"), readFile(targetPath, "utf8")]);
  } catch {
    return emitMalformed("IO_ERROR");
  }

  let evidence;
  let target;
  try {
    evidence = JSON.parse(evidenceText);
    target = JSON.parse(targetText);
  } catch {
    return emitMalformed("JSON_PARSE_ERROR");
  }

  const result = evaluateCapacityPreflight(evidence, target, nowUTC);
  return emitResult(result);
}

async function emitMalformed(reason) {
  const result = { status: "PREFLIGHT_HOLD", reasons: [reason] };
  console.log(JSON.stringify(result));
  return 1;
}

async function emitResult(result) {
  console.log(JSON.stringify(result));
  if (result.status === "PREFLIGHT_PASS") return 0;
  if (result.status === "PREFLIGHT_HOLD") return 2;
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runCapacityPreflightCli();
  } catch {
    process.exitCode = await emitMalformed("UNEXPECTED_ERROR");
  }
}
