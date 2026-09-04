import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatProductionDenoConfigError,
  validateProductionDenoConfig,
} from "./production-deno-config.mjs";

const validatorPath = fileURLToPath(new URL("./production-deno-config.mjs", import.meta.url));

test("accepts an HTTPS endpoint and positive integer settings", () => {
  assert.deepEqual(validateProductionDenoConfig({
    DENO_TOKENIZER_ENDPOINT: "https://tokenizer.example/tokenize",
    DENO_TOKENIZER_THRESHOLD_BYTES: "4096",
    DENO_TOKENIZER_TIMEOUT_MS: "5000",
  }), { valid: true, missing: [], invalid: [] });
});

test("reports every missing required variable by name", () => {
  assert.deepEqual(validateProductionDenoConfig({}), {
    valid: false,
    missing: [
      "DENO_TOKENIZER_ENDPOINT",
      "DENO_TOKENIZER_THRESHOLD_BYTES",
      "DENO_TOKENIZER_TIMEOUT_MS",
    ],
    invalid: [],
  });
});

test("rejects non-HTTPS endpoints and URL credentials", () => {
  for (const endpoint of [
    "http://tokenizer.example/tokenize",
    "https://user:password@tokenizer.example/tokenize",
    "not-a-url",
  ]) {
    const result = validateProductionDenoConfig({
      DENO_TOKENIZER_ENDPOINT: endpoint,
      DENO_TOKENIZER_THRESHOLD_BYTES: "4096",
      DENO_TOKENIZER_TIMEOUT_MS: "5000",
    });
    assert.deepEqual(result, {
      valid: false,
      missing: [],
      invalid: ["DENO_TOKENIZER_ENDPOINT"],
    });
  }
});

test("rejects zero, non-decimal, and unsafe numeric settings", () => {
  for (const [name, value] of [
    ["DENO_TOKENIZER_THRESHOLD_BYTES", "0"],
    ["DENO_TOKENIZER_THRESHOLD_BYTES", "1e3"],
    ["DENO_TOKENIZER_TIMEOUT_MS", "0"],
    ["DENO_TOKENIZER_TIMEOUT_MS", "9007199254740992"],
  ]) {
    const result = validateProductionDenoConfig({
      DENO_TOKENIZER_ENDPOINT: "https://tokenizer.example/tokenize",
      DENO_TOKENIZER_THRESHOLD_BYTES: "4096",
      DENO_TOKENIZER_TIMEOUT_MS: "5000",
      [name]: value,
    });
    assert.deepEqual(result, { valid: false, missing: [], invalid: [name] });
  }
});

test("reports non-string values as invalid instead of throwing", () => {
  assert.deepEqual(validateProductionDenoConfig({
    DENO_TOKENIZER_ENDPOINT: 123,
    DENO_TOKENIZER_THRESHOLD_BYTES: null,
    DENO_TOKENIZER_TIMEOUT_MS: true,
  }), {
    valid: false,
    missing: [],
    invalid: [
      "DENO_TOKENIZER_ENDPOINT",
      "DENO_TOKENIZER_THRESHOLD_BYTES",
      "DENO_TOKENIZER_TIMEOUT_MS",
    ],
  });
});

test("formats errors without including any setting value", () => {
  const message = formatProductionDenoConfigError({
    valid: false,
    missing: ["DENO_TOKENIZER_TIMEOUT_MS"],
    invalid: ["DENO_TOKENIZER_ENDPOINT"],
  });
  assert.match(message, /DENO_TOKENIZER_TIMEOUT_MS/);
  assert.match(message, /DENO_TOKENIZER_ENDPOINT/);
  assert.doesNotMatch(message, /tokenizer\.example|5000|password/);
});

test("CLI exits with a value-free error when required variables are missing", () => {
  const environment = { ...process.env };
  delete environment.DENO_TOKENIZER_ENDPOINT;
  delete environment.DENO_TOKENIZER_THRESHOLD_BYTES;
  delete environment.DENO_TOKENIZER_TIMEOUT_MS;

  const result = spawnSync(process.execPath, [validatorPath], {
    env: environment,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /octg\.production_deno_config_error/);
  assert.match(result.stderr, /missing: DENO_TOKENIZER_ENDPOINT, DENO_TOKENIZER_THRESHOLD_BYTES, DENO_TOKENIZER_TIMEOUT_MS/);
  assert.doesNotMatch(result.stderr, /https|4096|5000|password/);
});
