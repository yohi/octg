#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnvFile as parseEnvironmentFile } from "./parse-env-file.mjs";

export const DEFAULT_CANARY_CONCURRENCY = "1,2";
export const DEFAULT_CANARY_TIMEOUT_MS = 120_000;
export const DEFAULT_CANARY_ENV_FILE = "admin.env";

const MAX_CANARY_CONCURRENCY = 64;
const MAX_CANARY_TIMEOUT_MS = 2_147_483_647;
const CANARY_ENV_NAMES = new Set([
  "OCTG_CANARY_URL",
  "OCTG_CANARY_ALLOWED_HOSTS",
  "OCTG_CANARY_CLIENT_KEY",
  "CANARY_PAYLOAD_PATH",
  "CANARY_CONCURRENCY",
  "CANARY_REQUEST_TIMEOUT_MS",
]);
const canaryScript = fileURLToPath(new URL("./canary-worker-resource-limits.mjs", import.meta.url));
const defaultInputText = "The quick brown fox jumps over the lazy dog.\n".repeat(7_400);

export class CanaryConfigError extends TypeError {}

export function parseEnvFile(source) {
  return parseEnvironmentFile(
    source,
    CANARY_ENV_NAMES,
    (rawValue, lineNumber) => {
      let value = rawValue.trim();
      const quote = value[0];
      if (quote === "'" || quote === '"') {
        if (value.length < 2 || value.at(-1) !== quote) {
          throw new CanaryConfigError(`invalid env file line: ${lineNumber}`);
        }
        value = value.slice(1, -1);
      }
      return value;
    },
    (lineNumber) => new CanaryConfigError(`invalid env file line: ${lineNumber}`),
  );
}

function positiveIntegers(name, raw) {
  const values = raw.split(",").map((value) => Number(value.trim()));
  if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > MAX_CANARY_CONCURRENCY)) {
    throw new CanaryConfigError(`invalid: ${name}`);
  }
  return values;
}

export function resolveCanaryConfig(env, overrides = {}) {
  const missing = ["OCTG_CANARY_URL", "OCTG_CANARY_CLIENT_KEY"]
    .filter((name) => typeof env[name] !== "string" || env[name].length === 0);
  if (missing.length > 0) throw new CanaryConfigError(`missing: ${missing.join(", ")}`);

  let url;
  try {
    url = new URL(env.OCTG_CANARY_URL);
  } catch {
    throw new CanaryConfigError("invalid: OCTG_CANARY_URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new CanaryConfigError("invalid: OCTG_CANARY_URL");
  }

  const allowedHosts = (env.OCTG_CANARY_ALLOWED_HOSTS || url.hostname)
    .split(",")
    .map((host) => host.trim().toLowerCase());
  if (allowedHosts.length === 0 || allowedHosts.some((host) => host === "" || host.includes("*"))) {
    throw new CanaryConfigError("invalid: OCTG_CANARY_ALLOWED_HOSTS");
  }
  if (!new Set(allowedHosts).has(url.hostname.toLowerCase())) {
    throw new CanaryConfigError("invalid: OCTG_CANARY_ALLOWED_HOSTS");
  }

  const concurrency = overrides.concurrency ?? env.CANARY_CONCURRENCY ?? DEFAULT_CANARY_CONCURRENCY;
  const concurrencyValues = positiveIntegers("CANARY_CONCURRENCY", concurrency);
  if (!concurrencyValues.includes(1) || !concurrencyValues.includes(2)) {
    throw new CanaryConfigError("CANARY_CONCURRENCY must include 1 and 2");
  }

  const timeoutRaw = String(overrides.timeoutMs ?? env.CANARY_REQUEST_TIMEOUT_MS ?? DEFAULT_CANARY_TIMEOUT_MS);
  const timeoutMs = Number(timeoutRaw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_CANARY_TIMEOUT_MS) {
    throw new CanaryConfigError("invalid: CANARY_REQUEST_TIMEOUT_MS");
  }

  return {
    url: url.toString(),
    allowedHosts: allowedHosts.join(","),
    apiKey: env.OCTG_CANARY_CLIENT_KEY,
    concurrency: concurrencyValues.join(","),
    timeoutMs,
    payloadPath: overrides.payloadPath ?? env.CANARY_PAYLOAD_PATH,
  };
}

export function buildCanaryPayload() {
  return JSON.stringify({
    model: "gpt-5",
    messages: [{ role: "user", content: defaultInputText }],
    max_completion_tokens: 16,
  });
}

export function formatConfigError(error) {
  return error instanceof CanaryConfigError ? error.message : "invalid canary configuration";
}

function parseArgs(args) {
  const options = {};
  for (const arg of args) {
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    const match = arg.match(/^--(env-file|concurrency|timeout-ms|payload-path)=(.*)$/);
    if (!match || match[2] === "") throw new CanaryConfigError("invalid command option");
    const name = { "env-file": "envFile", concurrency: "concurrency", "timeout-ms": "timeoutMs", "payload-path": "payloadPath" }[match[1]];
    options[name] = match[2];
  }
  return options;
}

export async function loadEnvironment(envFile, baseEnv, cwd = process.cwd()) {
  const path = envFile === undefined ? resolve(cwd, DEFAULT_CANARY_ENV_FILE) : resolve(cwd, envFile);
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (envFile === undefined && error?.code === "ENOENT") return { ...baseEnv };
    throw new CanaryConfigError("cannot read canary env file");
  }
  return { ...parseEnvFile(source), ...baseEnv };
}

async function payloadFile(config) {
  if (config.payloadPath !== undefined) {
    const path = resolve(process.cwd(), config.payloadPath);
    try {
      JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new CanaryConfigError("invalid: CANARY_PAYLOAD_PATH");
    }
    return { path, directory: undefined };
  }
  const directory = await mkdtemp(join(tmpdir(), "octg-worker-canary-"));
  const path = join(directory, "payload.json");
  await writeFile(path, buildCanaryPayload(), { encoding: "utf8", mode: 0o600 });
  return { path, directory };
}

function runCanary(config, payloadPath) {
  const childEnv = {
    PATH: process.env.PATH ?? "",
    ...(process.env.NODE_OPTIONS === undefined ? {} : { NODE_OPTIONS: process.env.NODE_OPTIONS }),
    OCTG_CANARY_URL: config.url,
    OCTG_CANARY_ALLOWED_HOSTS: config.allowedHosts,
    OCTG_CANARY_CLIENT_KEY: config.apiKey,
    CANARY_PAYLOAD_PATH: payloadPath,
    CANARY_CONCURRENCY: config.concurrency,
    CANARY_REQUEST_TIMEOUT_MS: String(config.timeoutMs),
  };
  return new Promise((resolveCode) => {
    const child = spawn(process.execPath, [canaryScript], { cwd: process.cwd(), env: childEnv, stdio: "inherit" });
    child.once("error", () => resolveCode(1));
    child.once("exit", (code) => resolveCode(typeof code === "number" ? code : 1));
  });
}

export async function main(args = process.argv.slice(2), baseEnv = process.env) {
  const options = parseArgs(args);
  if (options.help) {
    console.log("Usage: npm run canary:worker -- [--env-file=PATH] [--concurrency=1,2,PEAK] [--timeout-ms=MS] [--payload-path=PATH]");
    return 0;
  }
  const env = await loadEnvironment(options.envFile, baseEnv);
  const config = resolveCanaryConfig(env, options);
  const payload = await payloadFile(config);
  try {
    return await runCanary(config, payload.path);
  } finally {
    if (payload.directory !== undefined) await rm(payload.directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error("octg.canary.config_error");
    console.error(formatConfigError(error));
    process.exitCode = 1;
  }
}
