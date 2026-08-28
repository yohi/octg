import { assertEquals } from "jsr:@std/assert@1";
import type { DenoTokenizerServiceConfig } from "../src/config.ts";
import type { ExactEncoder } from "../src/encoder.ts";
import { createTokenizerHandler } from "../src/http.ts";

const authToken = "test-secret";
const tokenizeUrl = "https://deno.test/v1/tokenize";

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

Deno.test("returns 404 for a different path", async () => {
  const fixture = createFixture();

  await expectRejection({
    fixture,
    request: validRequest("hello", authToken, "https://deno.test/not-tokenize"),
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

Deno.test("returns 415 for a non-JSON content type", async () => {
  const fixture = createFixture();
  const request = new Request(tokenizeUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "text/plain",
    },
    body: "hello",
  });

  await expectRejection({ fixture, request, status: 415 });
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
