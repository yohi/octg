import { describe, expect, it, vi } from "vitest";
import { readJsonBody } from "../src/request-body";

const encoder = new TextEncoder();

function encoded(body: string): Uint8Array<ArrayBuffer> {
  const source = encoder.encode(body);
  const result = new Uint8Array(source.byteLength);
  result.set(source);
  return result;
}

function jsonWithByteLength(byteLength: number): string {
  if (byteLength < 2) throw new RangeError("byteLength must fit a JSON string");
  return JSON.stringify("a".repeat(byteLength - 2));
}

function requestWithBody(body: string, contentLength?: number): Pick<Request, "body" | "headers" | "text"> {
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return {
    headers,
    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(encoded(body));
        controller.close();
      },
    }),
    text: async () => body,
  };
}

describe("readJsonBody", () => {
  it("uses native text for an in-bound declared body", async () => {
    let readerCalled = false;
    const request = {
      headers: new Headers({ "content-length": "8" }),
      body: {
        getReader() {
          readerCalled = true;
          throw new Error("bounded reader should not run");
        },
      },
      text: async () => "{\"ok\":1}",
    } as unknown as Pick<Request, "headers" | "body" | "text">;

    const result = await readJsonBody(request, 1_048_576);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toEqual({ ok: 1 });
      expect(result.metrics.rawBodyBytesSource).toBe("declared_content_length");
      expect(result.metrics.rawBodyBytes).toBe(8);
    }
    expect(readerCalled).toBe(false);
  });

  it("returns invalid_json for invalid native text", async () => {
    const result = await readJsonBody({
      headers: new Headers({ "content-length": "1" }),
      body: new ReadableStream(),
      text: async () => "{",
    }, 32);

    expect(result).toMatchObject({
      ok: false,
      reason: "invalid_json",
      metrics: {
        rawBodyBytes: 1,
        rawBodyBytesSource: "declared_content_length",
        declaredContentLength: 1,
        measuredRawBodyBytes: null,
        truncated: false,
      },
    });
  });

  it("propagates native text rejection without reading the body", async () => {
    let readerCalled = false;
    const error = new Error("text failed");
    const result = readJsonBody({
      headers: new Headers({ "content-length": "8" }),
      body: {
        getReader() {
          readerCalled = true;
          throw new Error("reader should not run");
        },
      } as unknown as ReadableStream,
      text: async () => Promise.reject(error),
    }, 32);

    await expect(result).rejects.toBe(error);
    expect(readerCalled).toBe(false);
  });

  it("uses the bounded reader fallback for malformed content length", async () => {
    let readerCalled = false;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(encoded("{}"));
        controller.close();
      },
    });
    const request = {
      headers: new Headers({ "content-length": "abc" }),
      body: {
        getReader() {
          readerCalled = true;
          return body.getReader();
        },
      },
      text: async () => "should not run",
    } as unknown as Pick<Request, "headers" | "body" | "text">;

    const result = await readJsonBody(request, 32);

    expect(result).toMatchObject({
      ok: true,
      body: {},
      metrics: {
        rawBodyBytes: 2,
        rawBodyBytesSource: "measured",
        declaredContentLength: null,
        measuredRawBodyBytes: 2,
      },
    });
    expect(readerCalled).toBe(true);
  });

  it("separates native body-read and parse timings", async () => {
    const now = vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(130)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(207);
    try {
      const result = await readJsonBody({
        headers: new Headers({ "content-length": "2" }),
        body: new ReadableStream(),
        text: async () => "{}",
      }, 32);

      expect(result).toMatchObject({
        ok: true,
        metrics: { bodyReadMs: 30, parseMs: 7 },
      });
    } finally {
      now.mockRestore();
    }
  });

  it("returns exact UTF-8 metrics for a valid JSON body", async () => {
    const body = JSON.stringify({ message: "あ" });
    const result = await readJsonBody(requestWithBody(body), encoder.encode(body).byteLength);

    expect(result).toMatchObject({
      ok: true,
      body: { message: "あ" },
      rawText: body,
      metrics: {
        rawBodyBytes: encoder.encode(body).byteLength,
        rawBodyBytesSource: "measured",
        declaredContentLength: null,
        measuredRawBodyBytes: encoder.encode(body).byteLength,
        truncated: false,
      },
    });
    if (result.ok) {
      expect(result.metrics.bodyReadMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.parseMs).toBeGreaterThanOrEqual(0);
    }
  });

  it.each([false, true])("accepts body at limit with content-length present=%s", async (hasContentLength) => {
    const limit = 32;
    const body = jsonWithByteLength(limit);
    const result = await readJsonBody(
      requestWithBody(body, hasContentLength ? limit : undefined),
      limit,
    );

    expect(result.ok).toBe(true);
    expect(result.metrics).toMatchObject({
      rawBodyBytes: limit,
      rawBodyBytesSource: hasContentLength ? "declared_content_length" : "measured",
      declaredContentLength: hasContentLength ? limit : null,
      measuredRawBodyBytes: hasContentLength ? null : limit,
      truncated: false,
    });
  });

  it.each([false, true])("accepts body below limit with content-length present=%s", async (hasContentLength) => {
    const limit = 32;
    const body = jsonWithByteLength(limit - 1);
    const result = await readJsonBody(
      requestWithBody(body, hasContentLength ? limit - 1 : undefined),
      limit,
    );

    expect(result.ok).toBe(true);
    expect(result.metrics.rawBodyBytes).toBe(limit - 1);
    expect(result.metrics.rawBodyBytesSource).toBe(
      hasContentLength ? "declared_content_length" : "measured",
    );
    expect(result.metrics.truncated).toBe(false);
  });

  it("rejects a declared body over the limit before reading it", async () => {
    let readCalled = false;
    let canceled = false;
    const body = {
      getReader() {
        readCalled = true;
        throw new Error("body must not be read");
      },
      cancel() {
        canceled = true;
        return Promise.resolve();
      },
    } as unknown as ReadableStream<Uint8Array<ArrayBuffer>>;
    const result = await readJsonBody({ headers: new Headers({ "content-length": "33" }), body, text: async () => "" }, 32);

    expect(result).toEqual({
      ok: false,
      reason: "too_large",
      metrics: expect.objectContaining({
        rawBodyBytes: 33,
        rawBodyBytesSource: "declared_content_length",
        declaredContentLength: 33,
        measuredRawBodyBytes: null,
        truncated: true,
      }),
    });
    expect(readCalled).toBe(false);
    expect(canceled).toBe(true);
  });

  it("cancels and reports a partial measurement for streamed overflow", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(encoded(jsonWithByteLength(33)));
      },
      cancel() {
        canceled = true;
      },
    });
    const result = await readJsonBody({ headers: new Headers(), body, text: async () => "" }, 32);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected streamed overflow");
    expect(result.reason).toBe("too_large");
    expect(result.metrics).toMatchObject({
      rawBodyBytes: 33,
      rawBodyBytesSource: "measured_partial",
      declaredContentLength: null,
      measuredRawBodyBytes: 33,
      truncated: true,
    });
    expect(canceled).toBe(true);
  });

  it("returns the oversized result when stream cancellation rejects", async () => {
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(encoded(jsonWithByteLength(33)));
      },
      cancel() {
        return Promise.reject(new Error("cancel failed"));
      },
    });

    const result = await readJsonBody({ headers: new Headers(), body, text: async () => "" }, 32);

    expect(result).toMatchObject({
      ok: false,
      reason: "too_large",
      metrics: {
        rawBodyBytes: 33,
        rawBodyBytesSource: "measured_partial",
        measuredRawBodyBytes: 33,
        truncated: true,
      },
    });
  });

  it("returns measured metrics for invalid JSON", async () => {
    const body = "{";
    const result = await readJsonBody(requestWithBody(body), 32);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid JSON");
    expect(result.reason).toBe("invalid_json");
    expect(result.metrics).toMatchObject({
      rawBodyBytes: 1,
      rawBodyBytesSource: "measured",
      measuredRawBodyBytes: 1,
      truncated: false,
    });
  });
});
