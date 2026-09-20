import { describe, expect, it } from "vitest";
import {
  preflightPreparedOutput,
  replaceOutputMarker,
  type PreparedOutputPreflight,
} from "../src/prepared-body";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

const MARKER = "octg_prepare_0123456789abcdef0123456789abcdef";
const QUOTED_MARKER = JSON.stringify(MARKER); // "octg_prepare_..." with quotes

function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

interface CountedSource {
  readonly body: ReadableStream<Uint8Array>;
  readonly reads: () => number;
  readonly cancellations: () => number;
}

function countedSource(chunks: readonly Uint8Array[], error?: Error): CountedSource {
  let nextChunk = 0;
  let readCount = 0;
  let cancellationCount = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        readCount += 1;
        if (error !== undefined) {
          controller.error(error);
          return;
        }
        const chunk = chunks[nextChunk];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        nextChunk += 1;
        controller.enqueue(chunk);
        if (nextChunk === chunks.length) controller.close();
      },
      cancel() {
        cancellationCount += 1;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    reads: () => readCount,
    cancellations: () => cancellationCount,
  };
}

const FIRST_PROPERTY_PREFIX = `{"max_output_tokens":`;

function firstProperty(marker: string): Uint8Array {
  return encode(`${FIRST_PROPERTY_PREFIX}${JSON.stringify(marker)},`);
}

function fullPreparedBody(marker: string): Uint8Array {
  return encode(`${FIRST_PROPERTY_PREFIX}${JSON.stringify(marker)},"model":"test"}`);
}

function markerForFirstPropertyCompletion(byteNumber: number): string {
  const markerLength = byteNumber - encode(FIRST_PROPERTY_PREFIX).byteLength - 3;
  return "m".repeat(markerLength);
}

async function parsePreparedBody(result: PreparedOutputPreflight): Promise<Record<string, unknown>> {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("expected a ready prepared body");
  const bytes = await drainStream(result.body);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

async function assertPreparedBody(result: PreparedOutputPreflight): Promise<void> {
  const parsed = await parsePreparedBody(result);
  expect(typeof parsed.max_output_tokens).toBe("number");
  expect(parsed.max_output_tokens).toBe(42);
}

describe("preflightPreparedOutput", () => {
  it("replaces the marker in a valid body and stops reading after the first property", async () => {
    const source = countedSource([firstProperty(MARKER), encode(`"model":"test"}`)]);

    const result = await preflightPreparedOutput(source.body, MARKER, 42);

    expect(result).toMatchObject({ kind: "ready" });
    expect(source.reads()).toBe(1);
    await assertPreparedBody(result);
  });

  it("accepts a first property that closes at byte 511", async () => {
    const marker = markerForFirstPropertyCompletion(511);
    const source = countedSource([firstProperty(marker), encode(`"model":"test"}`)]);

    const result = await preflightPreparedOutput(source.body, marker, 42);

    expect(result).toMatchObject({ kind: "ready" });
    expect(source.reads()).toBe(1);
    await assertPreparedBody(result);
  });

  it("accepts a first property that closes at byte 512", async () => {
    const marker = markerForFirstPropertyCompletion(512);
    const source = countedSource([firstProperty(marker), encode(`"model":"test"}`)]);

    const result = await preflightPreparedOutput(source.body, marker, 42);

    expect(result).toMatchObject({ kind: "ready" });
    expect(source.reads()).toBe(1);
    await assertPreparedBody(result);
  });

  it("rejects a first property that closes at byte 513 without reading later chunks", async () => {
    const marker = markerForFirstPropertyCompletion(513);
    const source = countedSource([firstProperty(marker), encode(`"model":"test"}`)]);

    const result = await preflightPreparedOutput(source.body, marker, 42);

    expect(result).toEqual({ kind: "invalid" });
    expect(source.reads()).toBe(1);
    expect(source.cancellations()).toBe(0);
  });

  it("rejects duplicate quoted markers retained in the prefix", async () => {
    const source = countedSource([
      encode(`${FIRST_PROPERTY_PREFIX}${JSON.stringify(MARKER)},"other":${JSON.stringify(MARKER)}}`),
    ]);

    const result = await preflightPreparedOutput(source.body, MARKER, 42);

    expect(result).toEqual({ kind: "invalid" });
    expect(source.cancellations()).toBe(0);
  });

  it("accepts a marker split across source chunks", async () => {
    const quotedMarker = JSON.stringify(MARKER);
    const split = Math.floor(quotedMarker.length / 2);
    const source = countedSource([
      encode(`${FIRST_PROPERTY_PREFIX}${quotedMarker.slice(0, split)}`),
      encode(`${quotedMarker.slice(split)},"model":"test"}`),
    ]);

    const result = await preflightPreparedOutput(source.body, MARKER, 42);

    expect(result).toMatchObject({ kind: "ready" });
    expect(source.reads()).toBe(2);
    await assertPreparedBody(result);
  });

  it("rejects a malformed first property and releases the source lock without canceling", async () => {
    const source = countedSource([encode(`{"other":${JSON.stringify(MARKER)},"model":"test"}`)]);

    const result = await preflightPreparedOutput(source.body, MARKER, 42);

    expect(result).toEqual({ kind: "invalid" });
    expect(source.cancellations()).toBe(0);
    const reader = source.body.getReader();
    reader.releaseLock();
  });

  it("propagates a source read error without canceling the source", async () => {
    const sourceError = new Error("source read failed");
    const source = countedSource([], sourceError);

    await expect(preflightPreparedOutput(source.body, MARKER, 42)).rejects.toThrow("source read failed");

    expect(source.cancellations()).toBe(0);
    const reader = source.body.getReader();
    reader.releaseLock();
  });

  it("preserves the unread tail from the same source chunk", async () => {
    const source = countedSource([fullPreparedBody(MARKER)]);

    const result = await preflightPreparedOutput(source.body, MARKER, 42);

    expect(result).toMatchObject({ kind: "ready" });
    expect(source.reads()).toBe(1);
    await assertPreparedBody(result);
  });

  it("does not read a later tail chunk until the replacement stream is consumed", async () => {
    const source = countedSource([firstProperty(MARKER), encode(`"model":"later"}`)]);

    const result = await preflightPreparedOutput(source.body, MARKER, 42);

    expect(result).toMatchObject({ kind: "ready" });
    expect(source.reads()).toBe(1);
    await assertPreparedBody(result);
    expect(source.reads()).toBe(2);
  });

  it("memoizes destination cancellation and releases the source reader", async () => {
    const source = countedSource([firstProperty(MARKER), encode(`"model":"test"}`)]);
    const result = await preflightPreparedOutput(source.body, MARKER, 42);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected a ready prepared body");
    await Promise.all([result.body.cancel(), result.cancel()]);
    await result.cancel();

    expect(source.cancellations()).toBe(1);
    const reader = source.body.getReader();
    reader.releaseLock();
  });

  it("releases the source reader lock when a ready body is canceled", async () => {
    const source = countedSource([firstProperty(MARKER)]);
    const result = await preflightPreparedOutput(source.body, MARKER, 42);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected a ready prepared body");
    await result.cancel();

    const reader = source.body.getReader();
    reader.releaseLock();
  });
});

describe("replaceOutputMarker", () => {
  it("replaces a single quoted marker in one chunk", async () => {
    const body = streamFromChunks([encode(`before ${QUOTED_MARKER} after`)]);
    const result = await drainStream(replaceOutputMarker(body, MARKER, 42));
    expect(new TextDecoder().decode(result)).toBe("before 42 after");
  });

  it("replaces the marker when each byte is split into a separate chunk", async () => {
    const fullBytes = encode(`before ${QUOTED_MARKER} after`);
    const chunks: Uint8Array[] = [];
    for (const byte of fullBytes) chunks.push(new Uint8Array([byte]));
    const body = streamFromChunks(chunks);
    const result = await drainStream(replaceOutputMarker(body, MARKER, 7));
    expect(new TextDecoder().decode(result)).toBe("before 7 after");
  });

  it("replaces the marker split at every possible boundary position", async () => {
    const prefix = "before ";
    const suffix = " after";
    const fullBytes = encode(prefix + QUOTED_MARKER + suffix);
    const markerOffset = encode(prefix).byteLength;
    const markerBytes = encode(QUOTED_MARKER);
    // Test every split point within the marker
    for (let split = 1; split < markerBytes.byteLength; split++) {
      const chunk1 = fullBytes.subarray(0, markerOffset + split);
      const chunk2 = fullBytes.subarray(markerOffset + split);
      const body = streamFromChunks([chunk1, chunk2]);
      const result = await drainStream(replaceOutputMarker(body, MARKER, 99));
      expect(new TextDecoder().decode(result)).toBe("before 99 after");
    }
  });

  it("preserves UTF-8 multibyte bytes around the marker", async () => {
    const prefix = encode("こんにちは ");
    const marker = encode(QUOTED_MARKER);
    const suffix = encode(" さようなら");
    const body = streamFromChunks([prefix, marker, suffix]);
    const result = await drainStream(replaceOutputMarker(body, MARKER, 128));
    expect(new TextDecoder().decode(result)).toBe("こんにちは 128 さようなら");
  });

  it("preserves UTF-8 bytes split across chunk boundaries adjacent to the marker", async () => {
    // Construct a body with a multibyte prefix, the marker, and a multibyte suffix,
    // split so that UTF-8 continuation bytes are immediately before and after the marker.
    const prefixStr = "て"; // 3-byte UTF-8
    const suffixStr = "す"; // 3-byte UTF-8
    const fullBytes = encode(prefixStr + QUOTED_MARKER + suffixStr);
    // Split at the exact byte before the marker
    const splitPoint = encode(prefixStr).byteLength;
    const chunk1 = fullBytes.subarray(0, splitPoint);
    const chunk2 = fullBytes.subarray(splitPoint);
    const body = streamFromChunks([chunk1, chunk2]);
    const result = await drainStream(replaceOutputMarker(body, MARKER, 256));
    expect(new TextDecoder().decode(result)).toBe("て256す");
  });

  it("throws on a missing marker at end of stream", async () => {
    const body = streamFromChunks([encode("no marker here")]);
    await expect(drainStream(replaceOutputMarker(body, MARKER, 42))).rejects.toThrow();
  });

  it("skips marker prefix slicing for bytes that cannot start the marker", async () => {
    let subarrayCalls = 0;
    class CountingBytes extends Uint8Array<ArrayBuffer> {
      override subarray(begin?: number, end?: number): Uint8Array<ArrayBuffer> {
        subarrayCalls += 1;
        return super.subarray(begin, end);
      }
    }
    const chunk = new CountingBytes(new ArrayBuffer(10_000));
    chunk.fill("x".charCodeAt(0));
    const body = streamFromChunks([chunk]);

    await expect(drainStream(replaceOutputMarker(body, MARKER, 42))).rejects.toThrow();
    expect(subarrayCalls).toBe(1);
  });

  it("throws on duplicate marker occurrences", async () => {
    const body = streamFromChunks([encode(`${QUOTED_MARKER} ${QUOTED_MARKER}`)]);
    await expect(drainStream(replaceOutputMarker(body, MARKER, 42))).rejects.toThrow();
  });

  it("replaces with a decimal output value selected independently from the original", async () => {
    const body = streamFromChunks([encode(QUOTED_MARKER)]);
    const result = await drainStream(replaceOutputMarker(body, MARKER, 4096));
    expect(new TextDecoder().decode(result)).toBe("4096");
  });

  it("emits bytes before the marker immediately without buffering the whole body", async () => {
    const prefix = "x".repeat(1000);
    const body = streamFromChunks([encode(prefix), encode(QUOTED_MARKER)]);
    const result = await drainStream(replaceOutputMarker(body, MARKER, 1));
    expect(new TextDecoder().decode(result)).toBe(prefix + "1");
  });

  it("reads at most one additional source chunk while the sink applies backpressure", async () => {
    const chunks = [
      encode("first "),
      encode("second "),
      encode("third "),
      encode("fourth "),
      encode(QUOTED_MARKER),
    ];
    let sourceReads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[sourceReads];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        sourceReads += 1;
        controller.enqueue(chunk);
        if (sourceReads === chunks.length) controller.close();
      },
    });
    const transformed = replaceOutputMarker(body, MARKER, 1);
    let writes = 0;
    let releaseFirstWrite: (() => void) | undefined;
    let firstWriteStartedResolve: (() => void) | undefined;
    const firstWriteStarted = new Promise<void>((resolve) => {
      firstWriteStartedResolve = resolve;
    });
    const sink = new WritableStream<Uint8Array>({
      write() {
        writes += 1;
        if (writes !== 1) return;
        firstWriteStartedResolve?.();
        return new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        });
      },
    });

    const pipePromise = transformed.pipeTo(sink);
    await firstWriteStarted;

    expect(sourceReads).toBeLessThanOrEqual(2);
    if (releaseFirstWrite === undefined) throw new Error("first sink write did not block");
    releaseFirstWrite();
    await pipePromise;
  });

  it("releases the input body lock when canceled before reading", async () => {
    const body = streamFromChunks([encode(QUOTED_MARKER)]);
    const transformed = replaceOutputMarker(body, MARKER, 1);

    await transformed.cancel();

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    expect(() => {
      reader = body.getReader();
    }).not.toThrow();
    reader?.releaseLock();
  });
});
