#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { requestCanary } from "./canary-worker-resource-limits.mjs";

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
