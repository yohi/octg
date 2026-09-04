import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildPreviewWorkerConfig } from "./preview-worker-config.mjs";

const baseConfig = {
  name: "octg-gateway",
  main: "src/index.ts",
  assets: { directory: "./public" },
  vars: {
    QUOTA_LIMIT_STANDARD: "1000000",
    QUOTA_LIMIT_MINI: "9950000",
    DENO_TOKENIZER_ENDPOINT: "https://production-tokenizer.example/tokenize",
    DENO_TOKENIZER_THRESHOLD_BYTES: "1",
    DENO_TOKENIZER_TIMEOUT_MS: "5000",
  },
  d1_databases: [{
    binding: "DB",
    database_name: "octg",
    database_id: "production-database-id",
    migrations_dir: "../../db/migrations",
  }],
};

const validOptions = {
  projectRoot: "/workspace",
  databaseId: "814c8fdb-dc9d-4a83-9065-001729ccd169",
  databaseName: "octg-gateway-preview-db",
  workerName: "octg-gateway-preview",
  upstreamBaseUrl: "https://gateway.example.test/openai",
  standardLimit: "0",
  miniLimit: "50000",
};

test("builds a DO-only Preview config without Deno values", () => {
  const config = buildPreviewWorkerConfig(baseConfig, validOptions);

  assert.equal(config.name, "octg-gateway-preview");
  assert.equal(config.vars.QUOTA_LIMIT_STANDARD, "0");
  assert.equal(config.vars.QUOTA_LIMIT_MINI, "50000");
  assert.equal(config.vars.OCTG_UPSTREAM_BASE_URL, "https://gateway.example.test/openai");
  assert.equal(config.vars.DENO_TOKENIZER_ENDPOINT, undefined);
  assert.equal(config.vars.DENO_TOKENIZER_THRESHOLD_BYTES, undefined);
  assert.equal(config.vars.DENO_TOKENIZER_TIMEOUT_MS, undefined);
  assert.equal(config.d1_databases[0].database_id, validOptions.databaseId);
  assert.notEqual(config, baseConfig);
  assert.equal(baseConfig.vars.DENO_TOKENIZER_ENDPOINT, "https://production-tokenizer.example/tokenize");
});

test("builds a Deno Preview config only from Preview values", () => {
  const config = buildPreviewWorkerConfig(baseConfig, {
    ...validOptions,
    deno: {
      endpoint: "https://preview-tokenizer.deno.dev/tokenize",
      thresholdBytes: "1",
      timeoutMs: "5000",
    },
  });

  assert.equal(config.vars.DENO_TOKENIZER_ENDPOINT, "https://preview-tokenizer.deno.dev/tokenize");
  assert.equal(config.vars.DENO_TOKENIZER_THRESHOLD_BYTES, "1");
  assert.equal(config.vars.DENO_TOKENIZER_TIMEOUT_MS, "5000");
  assert.equal(config.vars.DENO_TOKENIZER_AUTH_TOKEN, undefined);
  assert.equal(config.vars.DENO_TOKENIZER_ENDPOINT.includes("production"), false);
});

test("rejects non-HTTPS or invalid Preview Deno settings", () => {
  for (const deno of [
    { endpoint: "http://preview-tokenizer.deno.dev/tokenize", thresholdBytes: "1", timeoutMs: "5000" },
    { endpoint: "https://user:password@preview-tokenizer.deno.dev/tokenize", thresholdBytes: "1", timeoutMs: "5000" },
    { endpoint: "https://preview-tokenizer.deno.dev/tokenize", thresholdBytes: "0", timeoutMs: "5000" },
    { endpoint: "https://preview-tokenizer.deno.dev/tokenize", thresholdBytes: "1e3", timeoutMs: "5000" },
    { endpoint: "https://preview-tokenizer.deno.dev/tokenize", thresholdBytes: "1", timeoutMs: "0" },
  ]) {
    assert.throws(
      () => buildPreviewWorkerConfig(baseConfig, { ...validOptions, deno }),
      /Deno Preview/,
    );
  }
});

test("rejects a Preview Deno endpoint that is the Production endpoint", () => {
  assert.throws(
    () => buildPreviewWorkerConfig(baseConfig, {
      ...validOptions,
      deno: {
        endpoint: "https://production-tokenizer.example/tokenize",
        thresholdBytes: "1",
        timeoutMs: "5000",
      },
    }),
    /Production Deno endpoint/,
  );
});

test("rejects a Preview quota allocation over the provider ceiling", () => {
  assert.throws(
    () => buildPreviewWorkerConfig(baseConfig, {
      ...validOptions,
      miniLimit: "10000001",
    }),
    /quota allocation/,
  );
});
