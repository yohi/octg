import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_PREPARE_THRESHOLD_BYTES,
  formatProductionDenoConfigError,
  validateProductionDenoConfig,
} from "./production-deno-config.mjs";

const validatorPath = fileURLToPath(new URL("./production-deno-config.mjs", import.meta.url));

const completeProductionConfig = {
  MAX_INPUT_BYTES: "1048576",
  DENO_TOKENIZER_ENDPOINT: "https://tokenizer.example/tokenize",
  DENO_TOKENIZER_THRESHOLD_BYTES: "4096",
  DENO_TOKENIZER_TIMEOUT_MS: "5000",
  DENO_PREPARE_ENDPOINT: "https://prepare.example/prepare",
  DENO_PREPARE_THRESHOLD_BYTES: "1",
};

test("accepts an HTTPS endpoint and positive integer settings", () => {
  assert.deepEqual(validateProductionDenoConfig(completeProductionConfig), {
    valid: true,
    missing: [],
    invalid: [],
  });
});

test("requires the complete prepare pair in production", () => {
  const {
    DENO_PREPARE_ENDPOINT: _endpoint,
    DENO_PREPARE_THRESHOLD_BYTES: _threshold,
    ...withoutPrepare
  } = completeProductionConfig;

  assert.deepEqual(validateProductionDenoConfig(withoutPrepare), {
    valid: false,
    missing: ["DENO_PREPARE_ENDPOINT", "DENO_PREPARE_THRESHOLD_BYTES"],
    invalid: [],
  });
});

test("defines the canonical production prepare threshold as a string", () => {
  assert.equal(CANONICAL_PREPARE_THRESHOLD_BYTES, "1");
});

test("accepts only the canonical production prepare threshold", () => {
  assert.deepEqual(validateProductionDenoConfig({
    ...completeProductionConfig,
    DENO_PREPARE_THRESHOLD_BYTES: " 1 ",
  }), { valid: true, missing: [], invalid: [] });

  for (const threshold of ["0", "01", "1.0", "1e0", "700000", "1048576"]) {
    assert.deepEqual(validateProductionDenoConfig({
      ...completeProductionConfig,
      DENO_PREPARE_THRESHOLD_BYTES: threshold,
    }), {
      valid: false,
      missing: [],
      invalid: ["DENO_PREPARE_THRESHOLD_BYTES"],
    });
  }
});

test("reports every missing production variable by name", () => {
  assert.deepEqual(validateProductionDenoConfig({}), {
    valid: false,
    missing: [
      "DENO_TOKENIZER_ENDPOINT",
      "DENO_TOKENIZER_THRESHOLD_BYTES",
      "DENO_TOKENIZER_TIMEOUT_MS",
      "DENO_PREPARE_ENDPOINT",
      "DENO_PREPARE_THRESHOLD_BYTES",
      "MAX_INPUT_BYTES",
    ],
    invalid: [],
  });
});

test("reports absent and empty mandatory prepare members as missing", () => {
  for (const [overrides, missing] of [
    [{ DENO_PREPARE_THRESHOLD_BYTES: undefined }, ["DENO_PREPARE_THRESHOLD_BYTES"]],
    [{ DENO_PREPARE_ENDPOINT: undefined }, ["DENO_PREPARE_ENDPOINT"]],
    [{ DENO_PREPARE_ENDPOINT: "" }, ["DENO_PREPARE_ENDPOINT"]],
    [{ DENO_PREPARE_THRESHOLD_BYTES: "" }, ["DENO_PREPARE_THRESHOLD_BYTES"]],
  ]) {
    assert.deepEqual(validateProductionDenoConfig({
      ...completeProductionConfig,
      ...overrides,
    }), { valid: false, missing, invalid: [] });
  }
});

test("retains invalid reporting for non-empty partial prepare values", () => {
  assert.deepEqual(validateProductionDenoConfig({
    ...completeProductionConfig,
    DENO_PREPARE_ENDPOINT: "http://prepare.example/prepare",
    DENO_PREPARE_THRESHOLD_BYTES: undefined,
  }), {
    valid: false,
    missing: ["DENO_PREPARE_THRESHOLD_BYTES"],
    invalid: ["DENO_PREPARE_ENDPOINT"],
  });

  assert.deepEqual(validateProductionDenoConfig({
    ...completeProductionConfig,
    DENO_PREPARE_ENDPOINT: undefined,
    DENO_PREPARE_THRESHOLD_BYTES: "700000",
  }), {
    valid: false,
    missing: ["DENO_PREPARE_ENDPOINT"],
    invalid: ["DENO_PREPARE_THRESHOLD_BYTES"],
  });
});

test("requires MAX_INPUT_BYTES even when the tokenizer group is complete", () => {
  const { MAX_INPUT_BYTES: _ignored, ...withoutInputLimit } = completeProductionConfig;

  assert.deepEqual(validateProductionDenoConfig(withoutInputLimit), {
    valid: false,
    missing: ["MAX_INPUT_BYTES"],
    invalid: [],
  });
});

test("rejects invalid prepare settings and an independently supplied expected limit", () => {
  for (const [name, value] of [
    ["DENO_PREPARE_ENDPOINT", "http://prepare.example/prepare"],
    ["DENO_PREPARE_ENDPOINT", "https://user:password@prepare.example/prepare"],
    ["DENO_PREPARE_THRESHOLD_BYTES", "0"],
    ["DENO_PREPARE_THRESHOLD_BYTES", "1048577"],
    ["OCTG_EXPECTED_MAX_INPUT_BYTES", "1048576"],
  ]) {
    const result = validateProductionDenoConfig({
      ...completeProductionConfig,
      DENO_PREPARE_ENDPOINT: "https://prepare.example/prepare",
      DENO_PREPARE_THRESHOLD_BYTES: "1",
      [name]: value,
    });
    assert.deepEqual(result, { valid: false, missing: [], invalid: [name] });
  }
});

test("requires one positive safe-integer canonical input limit", () => {
  for (const value of ["0", "1.5", "1e6", "9007199254740992"]) {
    const result = validateProductionDenoConfig({
      ...completeProductionConfig,
      MAX_INPUT_BYTES: value,
    });
    assert.deepEqual(result, { valid: false, missing: [], invalid: ["MAX_INPUT_BYTES"] });
  }
});

test("accepts only the canonical production input limit", () => {
  assert.deepEqual(validateProductionDenoConfig({
    ...completeProductionConfig,
    MAX_INPUT_BYTES: " 1048576 ",
  }), { valid: true, missing: [], invalid: [] });

  for (const inputLimit of ["1048575", "1048577", "1", "1048576.0"]) {
    assert.deepEqual(validateProductionDenoConfig({
      ...completeProductionConfig,
      MAX_INPUT_BYTES: inputLimit,
    }), { valid: false, missing: [], invalid: ["MAX_INPUT_BYTES"] });
  }
});

test("rejects non-HTTPS endpoints and URL credentials", () => {
  for (const endpoint of [
    "http://tokenizer.example/tokenize",
    "https://user:password@tokenizer.example/tokenize",
    "not-a-url",
  ]) {
    const result = validateProductionDenoConfig({
      ...completeProductionConfig,
      DENO_TOKENIZER_ENDPOINT: endpoint,
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
      ...completeProductionConfig,
      [name]: value,
    });
    assert.deepEqual(result, { valid: false, missing: [], invalid: [name] });
  }
});

test("reports non-string values as invalid instead of throwing", () => {
  assert.deepEqual(validateProductionDenoConfig({
    ...completeProductionConfig,
    DENO_TOKENIZER_ENDPOINT: 123,
    DENO_TOKENIZER_THRESHOLD_BYTES: null,
    DENO_TOKENIZER_TIMEOUT_MS: true,
    MAX_INPUT_BYTES: false,
  }), {
    valid: false,
    missing: [],
    invalid: [
      "DENO_TOKENIZER_ENDPOINT",
      "DENO_TOKENIZER_THRESHOLD_BYTES",
      "DENO_TOKENIZER_TIMEOUT_MS",
      "MAX_INPUT_BYTES",
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
  delete environment.MAX_INPUT_BYTES;

  const result = spawnSync(process.execPath, [validatorPath], {
    env: environment,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /octg\.production_deno_config_error/);
  assert.match(
    result.stderr,
    /missing: DENO_TOKENIZER_ENDPOINT, DENO_TOKENIZER_THRESHOLD_BYTES, DENO_TOKENIZER_TIMEOUT_MS, DENO_PREPARE_ENDPOINT, DENO_PREPARE_THRESHOLD_BYTES, MAX_INPUT_BYTES/,
  );
  assert.doesNotMatch(result.stderr, /https|4096|5000|password/);
});

test("CLI treats an unset GitHub relay opt-in variable as absent", () => {
  const environment = {
    ...process.env,
    MAX_INPUT_BYTES: "1048576",
    DENO_TOKENIZER_ENDPOINT: "https://tokenizer.example/tokenize",
    DENO_TOKENIZER_THRESHOLD_BYTES: "4096",
    DENO_TOKENIZER_TIMEOUT_MS: "5000",
    DENO_PREPARE_ENDPOINT: "https://prepare.example/prepare",
    DENO_PREPARE_THRESHOLD_BYTES: "1",
    OCTG_RELAY_ENABLED: "",
  };

  const result = spawnSync(process.execPath, [validatorPath], {
    env: environment,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

const enabledRelayGroup = {
  OCTG_RELAY_ENVIRONMENT: "production",
  OCTG_RELAY_CALLBACK_ORIGIN: "https://worker.example/",
  OCTG_RELAY_GATEWAY_B_BASE_URL: "https://gateway-b.example/openai",
  OCTG_RELAY_MAX_REQUEST_DURATION_MS: "3600000",
  OCTG_RELAY_LEASE_TTL_MS: "120000",
  OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS: "30000",
};

test("treats an absent or false relay opt-in as disabled without relay variables", () => {
  assert.deepEqual(validateProductionDenoConfig(completeProductionConfig), {
    valid: true, missing: [], invalid: [],
  });
  assert.deepEqual(validateProductionDenoConfig({
    ...completeProductionConfig,
    OCTG_RELAY_ENABLED: "false",
  }), { valid: true, missing: [], invalid: [] });
  assert.deepEqual(validateProductionDenoConfig({
    ...completeProductionConfig,
    OCTG_RELAY_ENABLED: "",
  }), { valid: false, missing: [], invalid: ["OCTG_RELAY_ENABLED"] });
  assert.deepEqual(validateProductionDenoConfig({
    ...completeProductionConfig,
    OCTG_RELAY_ENABLED: "  \t ",
  }), { valid: false, missing: [], invalid: ["OCTG_RELAY_ENABLED"] });
});

test("rejects a relay opt-in value outside the exact true/false set", () => {
  for (const enabled of ["yes", "TRUE", "1", "true ", " true"]) {
    const result = validateProductionDenoConfig({
      ...completeProductionConfig,
      OCTG_RELAY_ENABLED: enabled,
    });
    assert.deepEqual(result, { valid: false, missing: [], invalid: ["OCTG_RELAY_ENABLED"] });
  }
});

test("requires the complete production relay group when the relay is enabled", () => {
  const result = validateProductionDenoConfig({
    ...completeProductionConfig,
    OCTG_RELAY_ENABLED: "true",
  });

  assert.deepEqual(result, {
    valid: false,
    missing: [
      "OCTG_RELAY_ENVIRONMENT",
      "OCTG_RELAY_CALLBACK_ORIGIN",
      "OCTG_RELAY_GATEWAY_B_BASE_URL",
      "OCTG_RELAY_MAX_REQUEST_DURATION_MS",
      "OCTG_RELAY_LEASE_TTL_MS",
      "OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS",
    ],
    invalid: [],
  });
});

test("accepts the canonical enabled production relay group", () => {
  assert.deepEqual(validateProductionDenoConfig({
    ...completeProductionConfig,
    OCTG_RELAY_ENABLED: "true",
    ...enabledRelayGroup,
  }), { valid: true, missing: [], invalid: [] });
});

test("accepts Cloudflare AI Gateway OpenAI URL paths for Gateway B", () => {
  assert.deepEqual(validateProductionDenoConfig({
    ...completeProductionConfig,
    OCTG_RELAY_ENABLED: "true",
    ...enabledRelayGroup,
    OCTG_RELAY_GATEWAY_B_BASE_URL: "https://gateway-b.example/v1/account-123/gateway-abc/openai",
  }), { valid: true, missing: [], invalid: [] });
});

test("rejects a preview environment and non-canonical relay values in production", () => {
  for (const [name, value] of [
    ["OCTG_RELAY_ENVIRONMENT", "preview"],
    ["OCTG_RELAY_CALLBACK_ORIGIN", "http://worker.example/"],
    ["OCTG_RELAY_CALLBACK_ORIGIN", "https://worker.example/internal"],
    ["OCTG_RELAY_CALLBACK_ORIGIN", "https://user:pass@worker.example/"],
    ["OCTG_RELAY_GATEWAY_B_BASE_URL", "https://gateway-b.example/v1/account-123/gateway-abc/openai?query=1"],
    ["OCTG_RELAY_GATEWAY_B_BASE_URL", "https://gateway-b.example/v1/account-123/gateway-abc/openai#fragment"],
    ["OCTG_RELAY_GATEWAY_B_BASE_URL", "https://gateway-b.example/openai/"],
    ["OCTG_RELAY_GATEWAY_B_BASE_URL", "http://gateway-b.example/v1/acct/gw/openai"],
    ["OCTG_RELAY_MAX_REQUEST_DURATION_MS", "3599999"],
    ["OCTG_RELAY_LEASE_TTL_MS", "60000"],
    ["OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS", "60000"],
  ]) {
    const result = validateProductionDenoConfig({
      ...completeProductionConfig,
      OCTG_RELAY_ENABLED: "true",
      ...enabledRelayGroup,
      [name]: value,
    });
    assert.deepEqual(result, { valid: false, missing: [], invalid: [name] });
  }
});
