#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { verifyPrepareContract } from "./verify-deno-prepare-contract.mjs";

const encoder = new TextEncoder();
const endpoint = "https://example.test/prepare";
const token = "secret-not-printed";
const bodyText = "body-not-printed";
const querySecret = "query-secret-not-printed";
const maxInputBytes = 1_048_576;
const outputBudget = 16;
const marker = "octg_prepare_0123456789abcdef0123456789abcdef";
const quotedMarker = encoder.encode(JSON.stringify(marker));

function encodeBase64Url(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function metadataHeader(outputMarker = marker, overrides = {}) {
  return encodeBase64Url({
    version: 1,
    model: "gpt-5",
    rawBodyBytes: 64,
    inputBytes: 16,
    inputTextBytes: 16,
    opaqueInputBytes: 0,
    messageCount: 1,
    estimatedInputTokens: 4,
    estimationPath: "exact_bpe",
    maxOutputTokens: outputBudget,
    stream: false,
    isToolUse: false,
    outputMarker,
    ...overrides,
  });
}

function response({ status = 200, headers = {}, body = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body,
  };
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function validBodyPrefix(outputMarker = marker) {
  return encoder.encode(
    `${'{"max_output_tokens":'}${JSON.stringify(outputMarker)},`,
  );
}

function trackedBody(chunks, { getReaderError, readError, cancelError } = {}) {
  let nextChunk = 0;
  let readCount = 0;
  let cancelCount = 0;
  let releaseCount = 0;
  const body = {
    getReader() {
      if (getReaderError !== undefined) throw getReaderError;
      return {
        async read() {
          readCount += 1;
          if (readError !== undefined) throw readError;
          const chunk = chunks[nextChunk];
          nextChunk += 1;
          return chunk === undefined
            ? { done: true, value: undefined }
            : { done: false, value: chunk };
        },
        async cancel() {
          cancelCount += 1;
          if (cancelError !== undefined) throw cancelError;
        },
        releaseLock() {
          releaseCount += 1;
        },
      };
    },
  };
  return {
    body,
    reads: () => readCount,
    cancellations: () => cancelCount,
    releases: () => releaseCount,
  };
}

function prepareResponse(body, outputMarker = marker, headers = {}) {
  return response({
    headers: {
      "x-octg-prepare-metadata": metadataHeader(outputMarker),
      ...headers,
    },
    body,
  });
}

function standardFetch(prepare, calls, prepareEndpoint = endpoint) {
  const healthEndpoint = new URL(prepareEndpoint);
  healthEndpoint.pathname = `${healthEndpoint.pathname.slice(0, -"prepare".length)}health`;
  return async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === healthEndpoint.toString()) return response();
    return prepare;
  };
}

async function assertCategory(operation, category, sensitiveValues = []) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, category);
    for (const sensitiveValue of sensitiveValues) {
      assert.equal(error.message.includes(sensitiveValue), false);
    }
    return true;
  });
}

test("probes health and prepare successfully and preserves a path prefix", async () => {
  for (const prepareEndpoint of [endpoint, "https://example.test/api/prepare"]) {
    const source = trackedBody([
      concatBytes(validBodyPrefix(), encoder.encode('"model":"gpt-5"}')),
    ]);
    const calls = [];

    const result = await verifyPrepareContract({
      endpoint: prepareEndpoint,
      token,
      maxInputBytes,
      fetchImpl: standardFetch(prepareResponse(source.body), calls, prepareEndpoint),
    });

    assert.equal(result, true);
    const expectedPrefix = prepareEndpoint.endsWith("/api/prepare")
      ? "https://example.test/api/health"
      : "https://example.test/health";
    assert.deepEqual(calls.map(({ url }) => url), [expectedPrefix, prepareEndpoint]);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[1].init.method, "POST");
    assert.equal(calls[1].init.headers.authorization, `Bearer ${token}`);
    assert.equal(calls[1].init.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(calls[1].init.body), {
      model: "gpt-5",
      input: "contract probe",
      max_output_tokens: outputBudget,
    });
    assert.equal(calls[1].init.body.includes(token), false);
    assert.equal(source.cancellations(), 1);
  }
});

test("rejects invalid endpoints without making a request", async () => {
  for (const invalidEndpoint of [
    "http://example.test/prepare",
    "https://user:password@example.test/prepare",
    "https://example.test/tokenize",
    "not-a-url",
  ]) {
    let calls = 0;
    await assertCategory(
      () => verifyPrepareContract({
        endpoint: invalidEndpoint,
        token,
        maxInputBytes,
        fetchImpl: async () => {
          calls += 1;
          return response();
        },
      }),
      "endpoint_invalid",
      [token, bodyText, querySecret],
    );
    assert.equal(calls, 0);
  }
});

test("maps a non-200 health response to health_status", async () => {
  const calls = [];
  await assertCategory(
    () => verifyPrepareContract({
      endpoint,
      token,
      maxInputBytes,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return response({ status: 503 });
      },
    }),
    "health_status",
    [token, bodyText, querySecret],
  );
  assert.equal(calls.length, 1);
});

test("maps health fetch rejection, timeout, and AbortError to health_unavailable", async () => {
  const failures = [
    new Error(`network failure ${token} ${bodyText} ${querySecret}`),
    new Error(`timeout ${token} ${bodyText} ${querySecret}`),
    new DOMException(`aborted ${token} ${bodyText} ${querySecret}`, "AbortError"),
  ];

  for (const failure of failures) {
    await assertCategory(
      () => verifyPrepareContract({
        endpoint: `${endpoint}?${querySecret}=1`,
        token,
        maxInputBytes,
        fetchImpl: async (_url, init) => {
          assert.equal(init.method, "GET");
          throw failure;
        },
      }),
      "health_unavailable",
      [token, bodyText, querySecret],
    );
  }
});

test("maps a non-200 prepare response to prepare_status", async () => {
  await assertCategory(
    () => verifyPrepareContract({
      endpoint,
      token,
      maxInputBytes,
      fetchImpl: async (url) => (
        String(url).endsWith("/health") ? response() : response({ status: 500 })
      ),
    }),
    "prepare_status",
    [token, bodyText, querySecret],
  );
});

test("maps prepare fetch rejection, timeout, and AbortError to prepare_unavailable", async () => {
  const failures = [
    new Error(`network failure ${token} ${bodyText} ${querySecret}`),
    new Error(`timeout ${token} ${bodyText} ${querySecret}`),
    new DOMException(`aborted ${token} ${bodyText} ${querySecret}`, "AbortError"),
  ];

  for (const failure of failures) {
    await assertCategory(
      () => verifyPrepareContract({
        endpoint: `${endpoint}?${querySecret}=1`,
        token,
        maxInputBytes,
        fetchImpl: async (url, init) => {
          if (String(url).endsWith("/health?" + querySecret + "=1")) return response();
          assert.equal(init.method, "POST");
          throw failure;
        },
      }),
      "prepare_unavailable",
      [token, bodyText, querySecret],
    );
  }
});

test("maps malformed or oversized metadata to metadata_invalid", async () => {
  for (const header of [
    undefined,
    "not-base64",
    encodeBase64Url({ outputMarker: "octg_prepare_not-a-marker" }),
    "a".repeat(4_097),
  ]) {
    const source = trackedBody([validBodyPrefix()]);
    await assertCategory(
      () => verifyPrepareContract({
        endpoint,
        token,
        maxInputBytes,
        fetchImpl: async (url) => {
          if (String(url).endsWith("/health")) return response();
          return response({
            headers: header === undefined ? {} : { "x-octg-prepare-metadata": header },
            body: source.body,
          });
        },
      }),
      "metadata_invalid",
      [token, bodyText, querySecret, marker],
    );
    assert.equal(source.reads(), 0);
  }
});

test("maps a malformed first-property body and duplicate marker to body_layout_invalid", async () => {
  const malformedBodies = [
    encoder.encode(`{"model":"gpt-5","max_output_tokens":${JSON.stringify(marker)}}`),
    concatBytes(validBodyPrefix(), encoder.encode(`"other":${JSON.stringify(marker)}}`)),
  ];

  for (const bytes of malformedBodies) {
    const source = trackedBody([bytes]);
    await assertCategory(
      () => verifyPrepareContract({
        endpoint,
        token,
        maxInputBytes,
        fetchImpl: standardFetch(prepareResponse(source.body), [], endpoint),
      }),
      "body_layout_invalid",
      [token, bodyText, querySecret, marker],
    );
    assert.equal(source.cancellations(), 1);
  }
});

test("maps getReader and response-reader failures to body_read_failed", async () => {
  const getReaderSource = trackedBody([], {
    getReaderError: new Error(`getReader failed ${token} ${bodyText}`),
  });
  await assertCategory(
    () => verifyPrepareContract({
      endpoint,
      token,
      maxInputBytes,
      fetchImpl: standardFetch(prepareResponse(getReaderSource.body), [], endpoint),
    }),
    "body_read_failed",
    [token, bodyText, querySecret, marker],
  );

  const readSource = trackedBody([], {
    readError: new Error(`read failed ${token} ${bodyText}`),
  });
  await assertCategory(
    () => verifyPrepareContract({
      endpoint,
      token,
      maxInputBytes,
      fetchImpl: standardFetch(prepareResponse(readSource.body), [], endpoint),
    }),
    "body_read_failed",
    [token, bodyText, querySecret, marker],
  );
  assert.equal(readSource.cancellations(), 1);
});

test("cancels a response whose quoted marker completes at byte 513 without scanning its opaque suffix", async () => {
  const firstPrefix = validBodyPrefix();
  const secondMarkerStart = 513 - quotedMarker.byteLength;
  const fillerLength = secondMarkerStart - firstPrefix.byteLength;
  assert.ok(fillerLength > 0);

  class BoundedChunk extends Uint8Array {
    subarray(start, end) {
      assert.equal(start, 0);
      assert.equal(end, 512);
      return super.subarray(start, end);
    }
  }

  const chunk = new BoundedChunk(concatBytes(
    firstPrefix,
    new Uint8Array(fillerLength).fill(0x20),
    quotedMarker,
    encoder.encode(`opaque-${bodyText}`),
  ));
  const source = trackedBody([chunk]);
  const calls = [];

  const result = await verifyPrepareContract({
    endpoint,
    token,
    maxInputBytes,
    fetchImpl: standardFetch(prepareResponse(source.body), calls, endpoint),
  });

  assert.equal(result, true);
  assert.equal(source.reads(), 1);
  assert.equal(source.cancellations(), 1);
  assert.equal(calls.length, 2);
});

test("maps a reader cancellation failure to body_read_failed after successful validation", async () => {
  const source = trackedBody([concatBytes(validBodyPrefix(), encoder.encode('"model":"gpt-5"}'))], {
    cancelError: new Error(`cancel failed ${token} ${bodyText}`),
  });
  await assertCategory(
    () => verifyPrepareContract({
      endpoint,
      token,
      maxInputBytes,
      fetchImpl: standardFetch(prepareResponse(source.body), [], endpoint),
    }),
    "body_read_failed",
    [token, bodyText, querySecret, marker],
  );
  assert.equal(source.cancellations(), 1);
});

test("maps a quoted marker that cannot complete within 512 bytes to body_too_large", async () => {
  const markerWithoutClosingQuote = encoder.encode(
    `${'{"max_output_tokens":'}${JSON.stringify(marker).slice(0, -1)}`,
  );
  const delayedClosingQuote = concatBytes(
    markerWithoutClosingQuote,
    new Uint8Array(512 - markerWithoutClosingQuote.byteLength).fill(0x20),
    encoder.encode('","model":"gpt-5"}'),
  );
  const source = trackedBody([delayedClosingQuote]);

  await assertCategory(
    () => verifyPrepareContract({
      endpoint,
      token,
      maxInputBytes,
      fetchImpl: standardFetch(prepareResponse(source.body), [], endpoint),
    }),
    "body_too_large",
    [token, bodyText, querySecret, marker],
  );
  assert.equal(source.cancellations(), 1);
});
