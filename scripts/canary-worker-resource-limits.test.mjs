#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { requestCanary } from "./canary-worker-resource-limits.mjs";

const canaryScript = fileURLToPath(new URL("./canary-worker-resource-limits.mjs", import.meta.url));
const payloadPath = fileURLToPath(new URL("../package.json", import.meta.url));

const request = {
  url: new URL("https://example.test/v1/chat/completions"),
  apiKey: "octg_sk_test",
  payload: "{}",
  concurrency: 1,
  ordinal: 0,
  requestTimeoutMs: 100,
};

test("waits for the response body before measuring duration", async () => {
  let bodyConsumed = false;
  const fetchImpl = async () => ({
    status: 200,
    headers: new Headers({ "X-OCTG-Request-Id": "req-body" }),
    arrayBuffer: async () => {
      bodyConsumed = true;
      return new ArrayBuffer(0);
    },
  });
  const now = () => (bodyConsumed ? 100 : 0);

  const result = await requestCanary({ ...request, fetchImpl, now });

  assert.equal(result.outcome, "response");
  assert.equal(result.durationMs, 100);
  assert.equal(bodyConsumed, true);
});

test("classifies an AbortError without relying on DOMException instanceof", async () => {
  const result = await requestCanary({
    ...request,
    fetchImpl: async () => {
      throw { name: "AbortError" };
    },
  });

  assert.equal(result.outcome, "timeout");
});

test("classifies non-abort failures as fetch errors", async () => {
  const result = await requestCanary({
    ...request,
    fetchImpl: async () => {
      throw new Error("connection failed");
    },
  });

  assert.equal(result.outcome, "fetch_error");
});

test("rejects concurrency config without baseline levels before issuing requests", () => {
  const result = spawnSync(process.execPath, [canaryScript], {
    env: {
      OCTG_CANARY_URL: "https://127.0.0.1:1/v1/chat/completions",
      OCTG_CANARY_ALLOWED_HOSTS: "127.0.0.1",
      OCTG_CANARY_CLIENT_KEY: "octg_sk_test",
      CANARY_PAYLOAD_PATH: payloadPath,
      CANARY_CONCURRENCY: "3",
      CANARY_REQUEST_TIMEOUT_MS: "100",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "octg.canary.config_error\n");
});
