import { describe, expect, it } from "vitest";
import { replaceOutputMarker } from "../src/prepared-body";

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
