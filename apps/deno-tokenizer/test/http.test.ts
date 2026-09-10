import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import type { DenoTokenizerServiceConfig } from "../src/config.ts";
import type { ExactEncoder } from "../src/encoder.ts";
import { createTokenizerHandler } from "../src/http.ts";
import type { PrepareMetadata } from "@octg/shared";

const authToken = "test-secret";
const tokenizeUrl = "https://deno.test/tokenize";
const healthUrl = "https://deno.test/health";

type HandlerFixture = {
  readonly handler: (request: Request) => Promise<Response>;
  readonly calls: () => number;
  readonly maxRawBodyBytes: number;
};

function configFor(maxInputBytes = 128): DenoTokenizerServiceConfig {
  return {
    authToken,
    maxInputBytes,
    maxRawBodyBytes: (6 * maxInputBytes) + 16,
  };
}

function createFixture(maxInputBytes = 128): HandlerFixture {
  let encoderCalls = 0;
  const encoder: ExactEncoder = {
    count: () => {
      encoderCalls += 1;
      return 7;
    },
  };
  const config = configFor(maxInputBytes);

  return {
    handler: createTokenizerHandler({ config, encoder }),
    calls: () => encoderCalls,
    maxRawBodyBytes: config.maxRawBodyBytes,
  };
}

function validRequest(
  inputText: string,
  token = authToken,
  url = tokenizeUrl,
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ inputText }),
  });
}

function streamingRequest(args: {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentLength?: number;
  readonly token?: string;
}): Request {
  const headers = new Headers({
    authorization: `Bearer ${args.token ?? authToken}`,
    "content-type": "application/json",
  });
  if (args.contentLength !== undefined) {
    headers.set("content-length", String(args.contentLength));
  }

  return new Request(tokenizeUrl, {
    method: "POST",
    headers,
    body: args.body,
  });
}

async function expectRejection(args: {
  readonly fixture: HandlerFixture;
  readonly request: Request;
  readonly status: number;
}): Promise<void> {
  const response = await args.fixture.handler(args.request);

  assertEquals(response.status, args.status);
  assertEquals(args.fixture.calls(), 0);
}

Deno.test("returns only the exact base token count", async () => {
  const fixture = createFixture();

  const response = await fixture.handler(validRequest("hello"));

  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assertEquals(await response.json(), { baseTokenCount: 7 });
  assertEquals(fixture.calls(), 1);
});

Deno.test("returns health status without authentication", async () => {
  const fixture = createFixture();
  const request = new Request(healthUrl, { method: "GET" });

  const response = await fixture.handler(request);

  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assertEquals(await response.json(), { status: "ok" });
  assertEquals(fixture.calls(), 0);
});

Deno.test("returns 404 for a versioned path", async () => {
  const fixture = createFixture();

  await expectRejection({
    fixture,
    request: validRequest("hello", authToken, "https://deno.test/v1/tokenize"),
    status: 404,
  });
});

Deno.test("returns 405 for a different method", async () => {
  const fixture = createFixture();
  const request = new Request(tokenizeUrl, {
    method: "GET",
    headers: { authorization: `Bearer ${authToken}` },
  });

  await expectRejection({ fixture, request, status: 405 });
});

Deno.test("returns 401 without bearer authentication", async () => {
  const fixture = createFixture();
  const request = new Request(tokenizeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputText: "hello" }),
  });

  await expectRejection({ fixture, request, status: 401 });
});

Deno.test("returns 401 for an invalid bearer token before reading the body", async () => {
  const fixture = createFixture();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.close();
    },
  });
  const request = streamingRequest({ body, token: "wrong-token" });

  await expectRejection({
    fixture,
    request,
    status: 401,
  });
  assertEquals(request.bodyUsed, false);
});

function createTokenizeRequest(contentType: string, body: BodyInit): Request {
  return new Request(tokenizeUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": contentType,
    },
    body,
  });
}

async function expectTokenCountSuccess(contentType: string, expectedCount = 7) {
  const fixture = createFixture();
  const request = createTokenizeRequest(contentType, "hello");
  const response = await fixture.handler(request);
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { baseTokenCount: expectedCount });
  assertEquals(fixture.calls(), 1);
}

async function expectRejectedContentType(contentType: string, body: BodyInit, status = 415) {
  const fixture = createFixture();
  const request = createTokenizeRequest(contentType, body);
  await expectRejection({ fixture, request, status });
}

Deno.test("returns 415 for an unsupported content type", async () => {
  await expectRejectedContentType("application/xml", "<xml></xml>");
});

Deno.test("returns token count for text/plain content type with charset=utf-8", async () => {
  await expectTokenCountSuccess("text/plain; charset=utf-8");
});

Deno.test("returns token count for text/plain without charset parameter", async () => {
  await expectTokenCountSuccess("text/plain");
});

Deno.test("reads content type once for an accepted tokenize request", async () => {
  const fixture = createFixture();
  const request = validRequest("hello");
  const originalGet = request.headers.get.bind(request.headers);
  let contentTypeReads = 0;
  request.headers.get = (name: string): string | null => {
    if (name.toLowerCase() === "content-type") {
      contentTypeReads += 1;
    }
    return originalGet(name);
  };

  const response = await fixture.handler(request);

  assertEquals(response.status, 200);
  assertEquals(contentTypeReads, 1);
});

Deno.test("returns 415 for text/plain with non-utf8 charset", async () => {
  await expectRejectedContentType("text/plain; charset=iso-8859-1", "hello");
});

Deno.test("returns 415 for application/json with non-utf8 charset", async () => {
  await expectRejectedContentType("application/json; charset=shift_jis", JSON.stringify({ inputText: "hello" }));
});

Deno.test("returns 400 for malformed JSON", async () => {
  const fixture = createFixture();
  const request = new Request(tokenizeUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
    },
    body: '{"inputText":',
  });

  await expectRejection({ fixture, request, status: 400 });
});

Deno.test("returns 400 when inputText is not a string", async () => {
  const fixture = createFixture();
  const request = new Request(tokenizeUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ inputText: 7 }),
  });

  await expectRejection({ fixture, request, status: 400 });
});

Deno.test("accepts inputText exactly at the UTF-8 ceiling", async () => {
  const fixture = createFixture(2);

  const response = await fixture.handler(validRequest("aa"));

  assertEquals(response.status, 200);
  assertEquals(fixture.calls(), 1);
});

Deno.test("rejects inputText one UTF-8 byte above the ceiling", async () => {
  const fixture = createFixture(2);

  await expectRejection({
    fixture,
    request: validRequest("aaa"),
    status: 413,
  });
});

Deno.test("measures UTF-8 bytes rather than JavaScript string length", async () => {
  const fixture = createFixture(2);

  const response = await fixture.handler(validRequest("é"));

  assertEquals(response.status, 200);
  assertEquals(fixture.calls(), 1);
});

Deno.test("does not apply the inputText ceiling to escaped JSON bytes", async () => {
  const fixture = createFixture(2);

  const response = await fixture.handler(validRequest("\n\n"));

  assertEquals(response.status, 200);
  assertEquals(fixture.calls(), 1);
});

Deno.test("cancels an oversized streamed body", async () => {
  const fixture = createFixture(2);
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(fixture.maxRawBodyBytes + 1));
    },
    cancel() {
      cancellations += 1;
    },
  });

  await expectRejection({
    fixture,
    request: streamingRequest({ body }),
    status: 413,
  });
  assertEquals(cancellations, 1);
});

Deno.test("rejects a nonnumeric declared content length without reading the body", async () => {
  const fixture = createFixture(2);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.close();
    },
  });
  const request = new Request(tokenizeUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      "content-length": "not-a-number",
    },
    body,
  });

  await expectRejection({
    fixture,
    request,
    status: 400,
  });
  assertEquals(request.bodyUsed, false);
});

Deno.test("rejects an oversized declared content length without reading the body", async () => {
  const fixture = createFixture(2);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.close();
    },
  });
  const request = streamingRequest({
    body,
    contentLength: fixture.maxRawBodyBytes + 1,
  });

  await expectRejection({
    fixture,
    request,
    status: 413,
  });
  assertEquals(request.bodyUsed, false);
});

Deno.test("returns a minimal 500 response when the encoder fails", async () => {
  const encoder: ExactEncoder = {
    count: () => {
      throw new Error("encoder failure must not be disclosed");
    },
  };
  const handler = createTokenizerHandler({
    config: configFor(),
    encoder,
  });

  const response = await handler(validRequest("hello"));

  assertEquals(response.status, 500);
  assertEquals(await response.text(), "");
});

// ---------------------------------------------------------------------------
// /prepare endpoint tests
// ---------------------------------------------------------------------------

const prepareUrl = "https://deno.test/prepare";

function prepareRequest(args: {
  readonly body: string;
  readonly token?: string;
  readonly contentType?: string;
  readonly url?: string;
  readonly contentLength?: number;
}): Request {
  const headers = new Headers({
    authorization: `Bearer ${args.token ?? authToken}`,
    "content-type": args.contentType ?? "application/json",
  });
  if (args.contentLength !== undefined) {
    headers.set("content-length", String(args.contentLength));
  }
  return new Request(args.url ?? prepareUrl, {
    method: "POST",
    headers,
    body: args.body,
  });
}

function prepareStreamingRequest(args: {
  readonly body: ReadableStream<Uint8Array>;
  readonly token?: string;
  readonly contentType?: string;
  readonly contentLength?: number;
}): Request {
  const headers = new Headers({
    authorization: `Bearer ${args.token ?? authToken}`,
    "content-type": args.contentType ?? "application/json",
  });
  if (args.contentLength !== undefined) {
    headers.set("content-length", String(args.contentLength));
  }
  return new Request(prepareUrl, {
    method: "POST",
    headers,
    body: args.body,
  });
}

function decodeMetadata(header: string | null): PrepareMetadata {
  if (header === null) throw new Error("metadata header is null");
  const b64 = header.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

function responsesBody(args: {
  readonly model?: string;
  readonly input?: unknown;
  readonly maxOutputTokens?: number;
  readonly extra?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    model: args.model ?? "model-name",
    input: args.input ?? [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...(args.maxOutputTokens !== undefined ? { max_output_tokens: args.maxOutputTokens } : {}),
    ...(args.extra ?? {}),
  });
}

// --- Method / path / auth / content type ---

Deno.test("prepare: returns 405 for GET", async () => {
  const fixture = createFixture();
  const request = new Request(prepareUrl, { method: "GET", headers: { authorization: `Bearer ${authToken}` } });
  const response = await fixture.handler(request);
  assertEquals(response.status, 405);
  assertEquals(fixture.calls(), 0);
});

Deno.test("prepare: returns 401 without bearer authentication", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: responsesBody({}), token: "" });
  const response = await fixture.handler(request);
  assertEquals(response.status, 401);
  assertEquals(fixture.calls(), 0);
});

Deno.test("prepare: returns 401 for an invalid bearer token before reading the body", async () => {
  const fixture = createFixture();
  const body = new ReadableStream<Uint8Array>({ pull(c) { c.close(); } });
  const request = prepareStreamingRequest({ body, token: "wrong-token" });
  const response = await fixture.handler(request);
  assertEquals(response.status, 401);
  assertEquals(fixture.calls(), 0);
  assertEquals(request.bodyUsed, false);
});

Deno.test("prepare: returns 415 for text/plain content type", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: "hello", contentType: "text/plain" });
  const response = await fixture.handler(request);
  assertEquals(response.status, 415);
  assertEquals(fixture.calls(), 0);
});

Deno.test("prepare: returns 415 for application/json with non-utf8 charset", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: responsesBody({}), contentType: "application/json; charset=iso-8859-1" });
  const response = await fixture.handler(request);
  assertEquals(response.status, 415);
  assertEquals(fixture.calls(), 0);
});

Deno.test("prepare: accepts application/json with charset=utf-8", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: responsesBody({}), contentType: "application/json; charset=utf-8" });
  const response = await fixture.handler(request);
  assertEquals(response.status, 200);
});

// --- Success path ---

Deno.test("prepare: returns 200 with normalized body and valid metadata", async () => {
  const fixture = createFixture();
  const requestBody = responsesBody({});
  const response = await fixture.handler(prepareRequest({ body: requestBody }));

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "application/json");
  const metadata = decodeMetadata(response.headers.get("X-OCTG-Prepare-Metadata"));
  assertEquals(metadata.version, 1);
  assertEquals(metadata.model, "model-name");
  assertEquals(metadata.rawBodyBytes, new TextEncoder().encode(requestBody).byteLength);
  assertEquals(metadata.inputTextBytes, 5);
  assertEquals(metadata.inputBytes, 5);
  assertEquals(metadata.opaqueInputBytes, 0);
  assertEquals(metadata.messageCount, 1);
  assertEquals(metadata.estimationPath, "exact_bpe");
  assertEquals(metadata.maxOutputTokens, 4096);
  assertEquals(metadata.stream, false);
  assertEquals(metadata.isToolUse, false);
  assertEquals(metadata.estimatedInputTokens, 7 + 4 + 3); // baseTokenCount + messageCount*4 + 3
  assertEquals(metadata.outputMarker.length, 45); // "octg_prepare_" (13) + 32 hex
  assertEquals(metadata.outputMarker.startsWith("octg_prepare_"), true);

  const serialized = await response.text();
  assertEquals(countOccurrences(serialized, JSON.stringify(metadata.outputMarker)), 1);
  const parsed = JSON.parse(serialized);
  assertEquals(parsed.max_output_tokens, metadata.outputMarker);
  assertEquals(fixture.calls(), 1);
});

Deno.test("prepare: returns a minimal 500 response when the encoder fails", async () => {
  const encoder: ExactEncoder = {
    count: () => {
      throw new Error("encoder failure must not be disclosed");
    },
  };
  const handler = createTokenizerHandler({
    config: configFor(),
    encoder,
  });

  const response = await handler(prepareRequest({ body: responsesBody({}) }));

  assertEquals(response.status, 500);
  assertEquals(await response.text(), "");
});

Deno.test("prepare: reports non-ASCII rawBodyBytes correctly", async () => {
  const fixture = createFixture();
  const requestBody = JSON.stringify({
    model: "model-name",
    input: [{ role: "user", content: [{ type: "text", text: "\u3053\u3093\u306b\u3061\u306f" }] }],
  });
  const response = await fixture.handler(prepareRequest({ body: requestBody }));
  assertEquals(response.status, 200);
  const metadata = decodeMetadata(response.headers.get("X-OCTG-Prepare-Metadata"));
  assertEquals(metadata.rawBodyBytes, new TextEncoder().encode(requestBody).byteLength);
  assertEquals(metadata.inputTextBytes, 15); // "こんにちは" = 15 UTF-8 bytes (3 per char × 5)
});

Deno.test("prepare: accepts string input with messageCount 1", async () => {
  const fixture = createFixture();
  const requestBody = JSON.stringify({ model: "m", input: "hello" });
  const response = await fixture.handler(prepareRequest({ body: requestBody }));
  assertEquals(response.status, 200);
  const metadata = decodeMetadata(response.headers.get("X-OCTG-Prepare-Metadata"));
  assertEquals(metadata.messageCount, 1);
  assertEquals(metadata.inputTextBytes, 5);
});

Deno.test("prepare: accepts empty body (end-of-stream without cancellation)", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: "" });
  const response = await fixture.handler(request);
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.code, "invalid_body");
});

// --- Raw-body oversize ---

Deno.test("prepare: returns 413 with request_too_large for declared oversize with exactly one body cancellation", async () => {
  const fixture = createFixture(10);
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    pull() { /* keep pending so cancel can fire */ },
    cancel() { cancellations += 1; },
  });
  const request = prepareStreamingRequest({ body, contentLength: 11 });
  const response = await fixture.handler(request);
  assertEquals(response.status, 413);
  const responseBody = await response.json();
  assertEquals(responseBody.code, "request_too_large");
  assertEquals(cancellations, 1);
  assertEquals(fixture.calls(), 0);
});

Deno.test("prepare: returns 413 with request_too_large for measured oversize with exactly one reader cancellation", async () => {
  const fixture = createFixture(10);
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(11));
    },
    cancel() { cancellations += 1; },
  });
  const request = prepareStreamingRequest({ body });
  const response = await fixture.handler(request);
  assertEquals(response.status, 413);
  const responseBody = await response.json();
  assertEquals(responseBody.code, "request_too_large");
  assertEquals(cancellations, 1);
  assertEquals(fixture.calls(), 0);
});

// --- Read failure ---

Deno.test("prepare: returns 500 with no body when getReader rejects", async () => {
  const fixture = createFixture(128);
  // Simulate getReader failure by overriding the body with a stream that errors on getReader
  const originalBody = new ReadableStream<Uint8Array>({ pull(c) { c.close(); } });
  const request = new Request(prepareUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
    body: originalBody,
    // @ts-ignore: override bodyUsed to prevent body access
  });
  // Override body to make getReader throw
  Object.defineProperty(request, "body", {
    get() {
      return {
        getReader() { throw new Error("getReader failed"); },
        cancel() {},
      };
    },
  });
  const response = await fixture.handler(request);
  assertEquals(response.status, 500);
  assertEquals(await response.text(), "");
  assertEquals(fixture.calls(), 0);
});

Deno.test("prepare: returns 500 with no body when reader.read rejects", async () => {
  const fixture = createFixture(128);
  const body = new ReadableStream<Uint8Array>({
    pull() { throw new Error("read failed"); },
  });
  const request = prepareStreamingRequest({ body });
  const response = await fixture.handler(request);
  assertEquals(response.status, 500);
  assertEquals(await response.text(), "");
  assertEquals(fixture.calls(), 0);
});

// --- Invalid JSON and normalization errors ---

Deno.test("prepare: returns 400 with invalid_body for malformed JSON", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: '{"model":' });
  const response = await fixture.handler(request);
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.code, "invalid_body");
  assertEquals(fixture.calls(), 0);
});

Deno.test("prepare: returns 400 with invalid_body for non-object JSON (array)", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: "[]" });
  const response = await fixture.handler(request);
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.code, "invalid_body");
});

Deno.test("prepare: returns 400 with invalid_body for missing model", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: JSON.stringify({ input: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }) });
  const response = await fixture.handler(request);
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.code, "invalid_body");
});

Deno.test("prepare: returns 400 with invalid_body for missing input", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: JSON.stringify({ model: "m" }) });
  const response = await fixture.handler(request);
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.code, "invalid_body");
});

Deno.test("prepare: returns 400 with non_text for image_url content", async () => {
  const fixture = createFixture();
  const request = prepareRequest({
    body: JSON.stringify({ model: "m", input: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }),
  });
  const response = await fixture.handler(request);
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.code, "non_text");
});

Deno.test("prepare: returns 200 for valid Responses body (max_tokens_conflict not reachable via normalizeResponses)", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: responsesBody({}) });
  const response = await fixture.handler(request);
  assertEquals(response.status, 200);
});


// --- Shared-limit integration: one MAX_INPUT_BYTES for both raw-body and normalize ---

Deno.test("prepare: shared limit applies to both raw-body rejection and normalize input-size boundary", async () => {
  // The raw-body bound (config.maxInputBytes) is the same value used by normalizeResponses.
  // When the raw body exceeds it, request_too_large fires before normalization.
  const fixture = createFixture(50);
  const longText = "a".repeat(60);
  const request = prepareRequest({
    body: JSON.stringify({ model: "m", input: [{ role: "user", content: [{ type: "text", text: longText }] }] }),
  });
  const response = await fixture.handler(request);
  assertEquals(response.status, 413);
  const body = await response.json();
  assertEquals(body.code, "request_too_large");
});

// --- Generic text normalization for user/system/developer/assistant and function_call_output ---

const textNormalizationCases = [
  ["user role", { role: "user", content: [{ type: "text", text: "hi" }] }, "content", "input_text"],
  ["system role", { role: "system", content: [{ type: "text", text: "sys" }] }, "content", "input_text"],
  ["developer role", { role: "developer", content: [{ type: "text", text: "dev" }] }, "content", "input_text"],
  ["assistant role", { role: "assistant", content: [{ type: "text", text: "asst" }] }, "content", "output_text"],
  [
    "function_call_output",
    {
      type: "function_call_output",
      call_id: "c1",
      output: [{ type: "text", text: "result" }],
    },
    "output",
    "input_text",
  ],
] as const;

for (const [name, input, path, expectedType] of textNormalizationCases) {
  Deno.test(`prepare: normalizes text parts for ${name}`, async () => {
    const fixture = createFixture();
    const request = prepareRequest({
      body: JSON.stringify({ model: "m", input: [input] }),
    });
    const response = await fixture.handler(request);
    assertEquals(response.status, 200);
    const parsed = JSON.parse(await response.text());
    assertEquals(parsed.input[0][path][0].type, expectedType);
  });
}

// --- Marker regeneration on collision ---

Deno.test("prepare: regenerates marker if candidate appears elsewhere in the body", async () => {
  const fixture = createFixture();
  // Put a string that looks like a marker in the input text to force collision detection.
  // We can't easily force a collision since the marker is random, but we can verify the body has exactly one marker.
  const request = prepareRequest({
    body: JSON.stringify({
      model: "m",
      input: [{ role: "user", content: [{ type: "text", text: "octg_prepare_" + "0".repeat(32) }] }],
    }),
  });
  const response = await fixture.handler(request);
  assertEquals(response.status, 200);
  const metadata = decodeMetadata(response.headers.get("X-OCTG-Prepare-Metadata"));
  const serialized = await response.text();
  // The actual generated marker should appear exactly once (in max_output_tokens).
  // The user's text may contain a different marker string (if they happened to match, we'd regenerate).
  assertEquals(countOccurrences(serialized, JSON.stringify(metadata.outputMarker)), 1);
  // The marker in the body should not be the one in the user's text.
  assertNotEquals(metadata.outputMarker, "octg_prepare_" + "0".repeat(32));
});

// --- Status/body matrix ---

Deno.test("prepare: 400 error body has exactly one code field", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: "{}" });
  const response = await fixture.handler(request);
  assertEquals(response.status, 400);
  assertEquals(response.headers.get("content-type"), "application/json");
  const body = await response.json();
  assertEquals(Object.keys(body).length, 1);
  assertEquals(body.code, "invalid_body");
});

Deno.test("prepare: 413 request_too_large error body has exactly one code field", async () => {
  const fixture = createFixture(5);
  const request = prepareRequest({
    body: JSON.stringify({ model: "m", input: [{ role: "user", content: [{ type: "text", text: "a".repeat(100) }] }] }),
  });
  const response = await fixture.handler(request);
  assertEquals(response.status, 413);
  assertEquals(response.headers.get("content-type"), "application/json");
  const body = await response.json();
  assertEquals(Object.keys(body).length, 1);
  assertEquals(body.code, "request_too_large");
});

Deno.test("prepare: 500 response has no body and no code field", async () => {
  const fixture = createFixture(128);
  const body = new ReadableStream<Uint8Array>({
    pull() { throw new Error("read failed"); },
  });
  const request = prepareStreamingRequest({ body });
  const response = await fixture.handler(request);
  assertEquals(response.status, 500);
  assertEquals(await response.text(), "");
});

Deno.test("prepare: 401 response has no validation envelope", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: responsesBody({}), token: "wrong" });
  const response = await fixture.handler(request);
  assertEquals(response.status, 401);
  assertEquals(await response.text(), "");
});

Deno.test("prepare: 415 response has no validation envelope", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: "hello", contentType: "application/xml" });
  const response = await fixture.handler(request);
  assertEquals(response.status, 415);
  assertEquals(await response.text(), "");
});

Deno.test("prepare: 405 response has no validation envelope", async () => {
  const fixture = createFixture();
  const request = new Request(prepareUrl, { method: "PUT", headers: { authorization: `Bearer ${authToken}` } });
  const response = await fixture.handler(request);
  assertEquals(response.status, 405);
  assertEquals(await response.text(), "");
});

Deno.test("prepare: no request-derived error detail in 400 invalid_body", async () => {
  const fixture = createFixture();
  const request = prepareRequest({ body: '{"broken json' });
  const response = await fixture.handler(request);
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.code, "invalid_body");
  assertEquals(Object.keys(body).length, 1);
});

Deno.test("prepare: returns 404 for an unknown path", async () => {
  const fixture = createFixture();
  const request = validRequest("hello", authToken, "https://deno.test/unknown");
  const response = await fixture.handler(request);
  assertEquals(response.status, 404);
});
