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

const canaryConfig = {
  OCTG_CANARY_URL: "https://127.0.0.1:1/v1/chat/completions",
  OCTG_CANARY_ALLOWED_HOSTS: "127.0.0.1",
  OCTG_CANARY_CLIENT_KEY: "octg_sk_test",
  CANARY_PAYLOAD_PATH: payloadPath,
  CANARY_CONCURRENCY: "1,2",
  CANARY_REQUEST_TIMEOUT_MS: "100",
};

const runCanary = (overrides) => spawnSync(process.execPath, [canaryScript], {
  env: { ...canaryConfig, ...overrides },
  encoding: "utf8",
});

const assertConfigError = (result) => {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "octg.canary.config_error\n");
};

test("waits for the response body before measuring duration", async () => {
  let bodyConsumed = false;
  const fetchImpl = async () => ({
    status: 200,
    headers: new Headers({ "X-OCTG-Request-Id": "req-body" }),
    body: {
      getReader: () => ({
        read: async () => {
          bodyConsumed = true;
          return { done: true };
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  });
  const now = () => (bodyConsumed ? 100 : 0);

  const result = await requestCanary({ ...request, fetchImpl, now });

  assert.equal(result.outcome, "response");
  assert.equal(result.durationMs, 100);
  assert.equal(bodyConsumed, true);
});

test("cancels oversized response bodies without parsing their metadata", async () => {
  let cancelled = false;
  let reads = 0;
  const metadata = JSON.stringify({
    error: {
      type: "invalid_request_error",
      code: "invalid_request",
      param: "model",
    },
  });
  const responseText = `${metadata}${" ".repeat((16 * 1024) - metadata.length)}x`;
  const result = await requestCanary({
    ...request,
    fetchImpl: async () => ({
      status: 400,
      headers: new Headers({
        "X-OCTG-Route": "free_shared",
        "X-OCTG-Worker-Version": "version-123",
      }),
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return { done: false, value: new TextEncoder().encode(responseText) };
          },
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => {},
        }),
      },
    }),
  });

  assert.equal(result.outcome, "response");
  assert.equal(result.route, "free_shared");
  assert.equal(result.workerVersion, "version-123");
  assert.equal(result.responseErrorType, null);
  assert.equal(result.responseErrorCode, null);
  assert.equal(result.responseErrorParam, null);
  assert.equal(reads, 1);
  assert.equal(cancelled, true);
});

test("reports safe response metadata without exposing the error message", async () => {
  const sensitiveMessage = "upstream private detail: user=secret@example.test";
  const responseBody = JSON.stringify({
    error: {
      type: "invalid_request_error",
      code: "invalid_request",
      param: "model",
      message: sensitiveMessage,
    },
  });
  const result = await requestCanary({
    ...request,
    fetchImpl: async () => ({
      status: 400,
      headers: new Headers({
        "X-OCTG-Request-Id": "req_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "X-OCTG-Route": "free_shared",
        "X-OCTG-Worker-Version": "version-123",
      }),
      body: new Response(responseBody).body,
    }),
  });

  assert.equal(result.status, 400);
  assert.equal(result.route, "free_shared");
  assert.equal(result.workerVersion, "version-123");
  assert.equal(result.responseErrorType, "invalid_request_error");
  assert.equal(result.responseErrorCode, "invalid_request");
  assert.equal(result.responseErrorParam, "model");
  assert.equal(JSON.stringify(result).includes(sensitiveMessage), false);
});

test("omits credential-shaped response metadata", async () => {
  const credentialShapedValue = "octg_sk_test_secret_value";
  const result = await requestCanary({
    ...request,
    fetchImpl: async () => ({
      status: 400,
      headers: new Headers({
        "X-OCTG-Request-Id": "req_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "X-OCTG-Route": credentialShapedValue,
        "X-OCTG-Worker-Version": credentialShapedValue,
      }),
      body: new Response(JSON.stringify({
        error: {
          type: credentialShapedValue,
          code: credentialShapedValue,
          param: credentialShapedValue,
        },
      })).body,
    }),
  });

  assert.equal(result.route, null);
  assert.equal(result.workerVersion, null);
  assert.equal(result.responseErrorType, null);
  assert.equal(result.responseErrorCode, null);
  assert.equal(result.responseErrorParam, null);
  assert.equal(JSON.stringify(result).includes(credentialShapedValue), false);
});

test("exposes only ULID-shaped OCTG request IDs", async () => {
  const validRequestId = "req_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  for (const [header, expectedRequestId] of [
    [validRequestId, validRequestId],
    ["req_body", null],
    [null, null],
  ]) {
    const result = await requestCanary({
      ...request,
      fetchImpl: async () => ({
        status: 200,
        headers: new Headers(header === null ? {} : { "X-OCTG-Request-Id": header }),
        body: null,
      }),
    });

    assert.equal(result.requestId, expectedRequestId);
  }
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

test("reports safe error metadata without exposing thrown error details", async () => {
  const result = await requestCanary({
    ...request,
    fetchImpl: async () => {
      throw {
        name: "TypeError",
        code: "ERR_NETWORK",
        message: "https://user:secret@example.test/private",
      };
    },
  });

  assert.equal(result.outcome, "fetch_error");
  assert.equal(result.errorName, "TypeError");
  assert.equal(result.errorCode, "ERR_NETWORK");
  assert.equal("message" in result, false);
  assert.equal(JSON.stringify(result).includes("user:secret"), false);
});

test("omits unsafe metadata from arbitrary thrown values", async () => {
  const sensitiveValue = "https://user:secret@example.test/private";
  const result = await requestCanary({
    ...request,
    fetchImpl: async () => {
      throw {
        name: sensitiveValue,
        code: "not a safe code",
        message: sensitiveValue,
      };
    },
  });

  assert.equal(result.outcome, "fetch_error");
  assert.equal(result.errorName, null);
  assert.equal(result.errorCode, null);
  assert.equal(JSON.stringify(result).includes(sensitiveValue), false);
});

test("omits unknown credential-shaped error metadata", async () => {
  const credentialShapedValue = "AKIAEXAMPLEMARKER123";
  const result = await requestCanary({
    ...request,
    fetchImpl: async () => {
      throw {
        name: credentialShapedValue,
        code: credentialShapedValue,
        message: credentialShapedValue,
      };
    },
  });

  assert.equal(result.outcome, "fetch_error");
  assert.equal(result.errorName, null);
  assert.equal(result.errorCode, null);
  assert.equal(JSON.stringify(result).includes(credentialShapedValue), false);
});

test("keeps timeout metadata absent", async () => {
  const result = await requestCanary({
    ...request,
    fetchImpl: async () => {
      throw { name: "AbortError", code: "ERR_ABORTED", message: "sensitive" };
    },
  });

  assert.equal(result.outcome, "timeout");
  assert.equal(result.errorName, null);
  assert.equal(result.errorCode, null);
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

test("rejects concurrency values above the bounded canary fan-out", () => {
  const result = spawnSync(process.execPath, [canaryScript], {
    env: {
      OCTG_CANARY_URL: "https://127.0.0.1:1/v1/chat/completions",
      OCTG_CANARY_ALLOWED_HOSTS: "127.0.0.1",
      OCTG_CANARY_CLIENT_KEY: "octg_sk_test",
      CANARY_PAYLOAD_PATH: payloadPath,
      CANARY_CONCURRENCY: "1,2,65",
      CANARY_REQUEST_TIMEOUT_MS: "100",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "octg.canary.config_error\n");
});

test("rejects request timeouts above the Node timer maximum", () => {
  const result = spawnSync(process.execPath, [canaryScript], {
    env: {
      OCTG_CANARY_URL: "https://127.0.0.1:1/v1/chat/completions",
      OCTG_CANARY_ALLOWED_HOSTS: "127.0.0.1",
      OCTG_CANARY_CLIENT_KEY: "octg_sk_test",
      CANARY_PAYLOAD_PATH: payloadPath,
      CANARY_CONCURRENCY: "1,2",
      CANARY_REQUEST_TIMEOUT_MS: "2147483648",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "octg.canary.config_error\n");
});

test("rejects non-HTTPS canary URLs", () => {
  assertConfigError(runCanary({
    OCTG_CANARY_URL: "http://127.0.0.1:1/v1/chat/completions",
  }));
});

test("rejects canary URLs outside the exact host allowlist", () => {
  assertConfigError(runCanary({
    OCTG_CANARY_URL: "https://not-allowed.example/v1/chat/completions",
  }));
});

test("rejects canary URLs with embedded credentials", () => {
  assertConfigError(runCanary({
    OCTG_CANARY_URL: "https://user:secret@127.0.0.1:1/v1/chat/completions",
  }));
});

test("rejects wildcard canary host allowlists", () => {
  assertConfigError(runCanary({
    OCTG_CANARY_ALLOWED_HOSTS: "*.example.com",
  }));
});
