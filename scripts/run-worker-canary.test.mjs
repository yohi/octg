#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  buildCanaryPayload,
  formatConfigError,
  loadEnvironment,
  parseEnvFile,
  resolveCanaryConfig,
} from "./run-worker-canary.mjs";

test("parses canary KEY=value and export KEY=value without executing shell syntax", () => {
  const values = parseEnvFile([
    "# optional local file",
    'export OCTG_CANARY_URL="https://example.test/v1/chat/completions"',
    "OCTG_CANARY_CLIENT_KEY='octg_sk_test'",
    "CANARY_CONCURRENCY=1,2",
    "UNTRUSTED=$(printf secret)",
  ].join("\n"));

  assert.deepEqual(values, {
    OCTG_CANARY_URL: "https://example.test/v1/chat/completions",
    OCTG_CANARY_CLIENT_KEY: "octg_sk_test",
    CANARY_CONCURRENCY: "1,2",
  });
});

test("ignores malformed assignments for unrelated tools", () => {
  const values = parseEnvFile([
    'GRAFANA_TOKEN="unterminated',
    "OCTG_CANARY_URL=https://example.test/v1/chat/completions",
    "OCTG_CANARY_CLIENT_KEY=octg_sk_test",
  ].join("\n"));

  assert.deepEqual(values, {
    OCTG_CANARY_URL: "https://example.test/v1/chat/completions",
    OCTG_CANARY_CLIENT_KEY: "octg_sk_test",
  });
});

test("derives the exact allowed host and safe defaults", () => {
  const config = resolveCanaryConfig({
    OCTG_CANARY_URL: "https://example.test/v1/chat/completions",
    OCTG_CANARY_CLIENT_KEY: "octg_sk_test",
  });

  assert.equal(config.allowedHosts, "example.test");
  assert.equal(config.concurrency, "1,2");
  assert.equal(config.timeoutMs, 120_000);
  assert.equal(config.payloadPath, undefined);
});

test("does not require admin.env when process environment is complete", async () => {
  const env = {
    OCTG_CANARY_URL: "https://example.test/v1/chat/completions",
    OCTG_CANARY_CLIENT_KEY: "octg_sk_test",
  };

  assert.deepEqual(await loadEnvironment(undefined, env, "/tmp/octg-missing-admin-env"), env);
});

test("reports missing names without exposing environment values", () => {
  assert.throws(
    () => resolveCanaryConfig({ OCTG_CANARY_CLIENT_KEY: "octg_sk_secret" }),
    (error) => {
      assert.equal(formatConfigError(error), "missing: OCTG_CANARY_URL");
      assert.equal(formatConfigError(error).includes("octg_sk_secret"), false);
      return true;
    },
  );
});

test("builds the documented 74k payload without reading a fixture file", () => {
  const payload = JSON.parse(buildCanaryPayload());

  assert.equal(payload.model, "gpt-5");
  assert.equal(payload.max_completion_tokens, 16);
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].content, "The quick brown fox jumps over the lazy dog.\n".repeat(7_400));
});

test("rejects a URL whose host is not in the exact allow-list", () => {
  assert.throws(
    () => resolveCanaryConfig({
      OCTG_CANARY_URL: "https://example.test/v1/chat/completions",
      OCTG_CANARY_ALLOWED_HOSTS: "other.example.test",
      OCTG_CANARY_CLIENT_KEY: "octg_sk_test",
    }),
    /OCTG_CANARY_ALLOWED_HOSTS/,
  );
});
