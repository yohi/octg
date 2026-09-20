/**
 * Byte-level marker replacement for prepared response bodies.
 *
 * Replaces exactly one quoted occurrence of the prepare marker with the
 * decimal output token count. Uses a streaming state machine that retains
 * only the longest suffix of each chunk that could begin the quoted marker,
 * emitting all other bytes immediately without buffering the full body.
 */

/** Concatenate two Uint8Arrays. */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * Check if `prefix` is a prefix of `bytes` at the byte level.
 * Returns the length of the matching prefix (0 if no match).
 */
function matchPrefix(bytes: Uint8Array, prefix: Uint8Array): number {
  const limit = Math.min(bytes.byteLength, prefix.byteLength);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] !== prefix[i]) return 0;
  }
  return limit;
}

/**
 * Check if `bytes` contains `needle` starting at `offset`.
 * `bytes` must be at least `offset + needle.length` long.
 */
function exactMatch(bytes: Uint8Array, offset: number, needle: Uint8Array): boolean {
  if (offset + needle.byteLength > bytes.byteLength) return false;
  for (let i = 0; i < needle.byteLength; i++) {
    if (bytes[offset + i] !== needle[i]) return false;
  }
  return true;
}

interface ReplaceChunkResult {
  /** Bytes to emit immediately (not part of a potential marker). */
  emitted: Uint8Array;
  /** Pending suffix bytes that could begin the quoted marker. */
  pending: Uint8Array;
  /** Number of replacements made in this chunk. */
  replacements: number;
}

/**
 * Process one combined buffer (pending + chunk) for quoted marker replacement.
 * Emits bytes that are definitely not part of the marker, retains the longest
 * suffix that could still begin the marker, and counts replacements.
 */
function replaceOneQuotedMarker(
  combined: Uint8Array,
  quotedMarker: Uint8Array,
  replacement: Uint8Array,
): ReplaceChunkResult {
  const emittedParts: Uint8Array[] = [];
  let replacements = 0;
  let i = 0;
  let batchStart = 0;

  while (i < combined.byteLength) {
    if (combined[i] !== quotedMarker[0]) {
      i++;
      continue;
    }

    // Try to find the full quoted marker starting at position i
    if (exactMatch(combined, i, quotedMarker)) {
      // Flush any batched non-matching bytes before the marker
      if (i > batchStart) emittedParts.push(combined.subarray(batchStart, i));
      emittedParts.push(replacement);
      replacements++;
      i += quotedMarker.byteLength;
      batchStart = i;
      continue;
    }

    // Check if a prefix of combined[i:] matches a prefix of quotedMarker.
    // If so, this position might be the start of the marker split across chunks.
    const prefixLen = matchPrefix(combined.subarray(i), quotedMarker);
    if (prefixLen > 0) {
      // Flush any batched non-matching bytes before the pending suffix
      if (i > batchStart) emittedParts.push(combined.subarray(batchStart, i));
      // The suffix from i is pending
      const pending = combined.subarray(i);
      return { emitted: flattenParts(emittedParts), pending, replacements };
    }

    // No match and no prefix match at position i — advance past this byte
    i++;
  }

  // Reached end of combined: flush any remaining batched bytes
  if (i > batchStart) emittedParts.push(combined.subarray(batchStart, i));

  return { emitted: flattenParts(emittedParts), pending: new Uint8Array(0), replacements };
}

/** Flatten an array of Uint8Array parts into a single Uint8Array. */
function flattenParts(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0]!;
  const totalLen = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export const PREPARED_BODY_PREFIX_BYTES = 512;

export type PreparedOutputPreflight =
  | {
      readonly kind: "ready";
      readonly body: ReadableStream<Uint8Array>;
      readonly cancel: () => Promise<void>;
    }
  | { readonly kind: "invalid" };

type FirstPropertyState =
  | "prefix"
  | "marker"
  | "after-marker"
  | "done"
  | "invalid";

interface FirstPropertyParser {
  state: FirstPropertyState;
  prefixOffset: number;
  markerOffset: number;
}

function assertNever(value: never): never {
  throw new Error(`unexpected prepared body parser state: ${value}`);
}

function consumeFirstPropertyByte(
  parser: FirstPropertyParser,
  byte: number,
  firstPropertyPrefix: Uint8Array,
  quotedMarker: Uint8Array,
): void {
  switch (parser.state) {
    case "prefix": {
      const expected = firstPropertyPrefix[parser.prefixOffset];
      if (expected === undefined || byte !== expected) {
        parser.state = "invalid";
        return;
      }
      parser.prefixOffset += 1;
      if (parser.prefixOffset === firstPropertyPrefix.byteLength) parser.state = "marker";
      return;
    }
    case "marker": {
      const expected = quotedMarker[parser.markerOffset];
      if (expected === undefined || byte !== expected) {
        parser.state = "invalid";
        return;
      }
      parser.markerOffset += 1;
      if (parser.markerOffset === quotedMarker.byteLength) parser.state = "after-marker";
      return;
    }
    case "after-marker":
      parser.state = byte === 0x2c ? "done" : "invalid";
      return;
    case "done":
      return;
    case "invalid":
      return;
    default:
      return assertNever(parser.state);
  }
}

function countExactOccurrences(bytes: Uint8Array, needle: Uint8Array): number {
  if (needle.byteLength === 0 || needle.byteLength > bytes.byteLength) return 0;
  let count = 0;
  for (let offset = 0; offset + needle.byteLength <= bytes.byteLength; offset += 1) {
    if (exactMatch(bytes, offset, needle)) count += 1;
  }
  return count;
}

function replaceExactOccurrence(
  bytes: Uint8Array,
  needle: Uint8Array,
  replacement: Uint8Array,
): Uint8Array {
  let matchOffset: number | undefined;
  for (let offset = 0; offset + needle.byteLength <= bytes.byteLength; offset += 1) {
    if (exactMatch(bytes, offset, needle)) {
      matchOffset = offset;
      break;
    }
  }
  if (matchOffset === undefined) return bytes;

  const before = bytes.subarray(0, matchOffset);
  const after = bytes.subarray(matchOffset + needle.byteLength);
  const result = new Uint8Array(before.byteLength + replacement.byteLength + after.byteLength);
  result.set(before, 0);
  result.set(replacement, before.byteLength);
  result.set(after, before.byteLength + replacement.byteLength);
  return result;
}

/**
 * Validate and prepare the bounded prefix of a Deno prepare response.
 *
 * The returned stream owns the source reader after a successful preflight.
 * Invalid prefixes release the reader without canceling the source so the
 * caller can perform the prepare request's single cancellation.
 */
export async function preflightPreparedOutput(
  body: ReadableStream<Uint8Array>,
  marker: string,
  outputTokens: number,
): Promise<PreparedOutputPreflight> {
  const reader = body.getReader();
  const encoder = new TextEncoder();
  const firstPropertyPrefix = encoder.encode('{"max_output_tokens":');
  const quotedMarker = encoder.encode(JSON.stringify(marker));
  const replacement = encoder.encode(String(outputTokens));
  const prefix = new Uint8Array(PREPARED_BODY_PREFIX_BYTES);
  const parser: FirstPropertyParser = {
    state: "prefix",
    prefixOffset: 0,
    markerOffset: 0,
  };
  let prefixLength = 0;
  let sameChunkTail: Uint8Array = new Uint8Array(0);
  let readerReleased = false;

  const releaseReader = (): void => {
    if (readerReleased) return;
    readerReleased = true;
    reader.releaseLock();
  };

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        releaseReader();
        return { kind: "invalid" };
      }

      const chunk = result.value;
      let chunkOffset = 0;
      while (chunkOffset < chunk.byteLength && parser.state !== "done") {
        if (prefixLength === PREPARED_BODY_PREFIX_BYTES) {
          releaseReader();
          return { kind: "invalid" };
        }
        const byte = chunk[chunkOffset];
        if (byte === undefined) {
          releaseReader();
          return { kind: "invalid" };
        }
        prefix[prefixLength] = byte;
        prefixLength += 1;
        chunkOffset += 1;
        consumeFirstPropertyByte(parser, byte, firstPropertyPrefix, quotedMarker);
        if (parser.state === "invalid") {
          releaseReader();
          return { kind: "invalid" };
        }
      }

      if (parser.state !== "done") {
        if (prefixLength === PREPARED_BODY_PREFIX_BYTES) {
          releaseReader();
          return { kind: "invalid" };
        }
        continue;
      }

      const retainedChunkBytes = Math.min(
        chunk.byteLength - chunkOffset,
        PREPARED_BODY_PREFIX_BYTES - prefixLength,
      );
      if (retainedChunkBytes > 0) {
        prefix.set(chunk.subarray(chunkOffset, chunkOffset + retainedChunkBytes), prefixLength);
        prefixLength += retainedChunkBytes;
        chunkOffset += retainedChunkBytes;
      }
      sameChunkTail = chunk.subarray(chunkOffset);
      break;
    }
  } catch (error) {
    releaseReader();
    throw error;
  }

  const retainedPrefix = prefix.subarray(0, prefixLength);
  if (countExactOccurrences(retainedPrefix, quotedMarker) !== 1) {
    releaseReader();
    return { kind: "invalid" };
  }
  const transformedPrefix = replaceExactOccurrence(retainedPrefix, quotedMarker, replacement);
  let sourceReader: ReadableStreamDefaultReader<Uint8Array> | undefined = reader;
  let cancellation: Promise<void> | undefined;
  let queuedPrefix: Uint8Array | undefined = transformedPrefix;
  let queuedTail: Uint8Array | undefined = sameChunkTail.byteLength === 0 ? undefined : sameChunkTail;
  let canceled = false;

  const cancelSource = (): Promise<void> => {
    if (cancellation !== undefined) return cancellation;
    const activeReader = sourceReader;
    if (activeReader === undefined) {
      cancellation = Promise.resolve();
      return cancellation;
    }
    canceled = true;
    sourceReader = undefined;
    cancellation = Promise.resolve()
      .then(() => activeReader.cancel())
      .catch(() => undefined)
      .finally(releaseReader);
    return cancellation;
  };

  const replacementBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (canceled) {
        controller.close();
        return;
      }
      if (queuedPrefix !== undefined) {
        const chunk = queuedPrefix;
        queuedPrefix = undefined;
        controller.enqueue(chunk);
        return;
      }
      if (queuedTail !== undefined) {
        const chunk = queuedTail;
        queuedTail = undefined;
        controller.enqueue(chunk);
        return;
      }

      const activeReader = sourceReader;
      if (activeReader === undefined) {
        controller.close();
        return;
      }
      try {
        const result = await activeReader.read();
        if (result.done) {
          sourceReader = undefined;
          releaseReader();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        if (sourceReader === activeReader) {
          sourceReader = undefined;
          releaseReader();
        }
        controller.error(error);
      }
    },
    cancel() {
      return cancelSource();
    },
  });

  return { kind: "ready", body: replacementBody, cancel: cancelSource };
}

/**
 * Replace exactly one quoted occurrence of the prepare marker in a stream
 * with the decimal output token count.
 *
 * @throws Error if zero or more than one quoted marker occurrences are found.
 */
export function replaceOutputMarker(
  body: ReadableStream<Uint8Array>,
  marker: string,
  outputTokens: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const quotedMarker = encoder.encode(JSON.stringify(marker));
  const replacement = encoder.encode(String(outputTokens));

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let pending: Uint8Array = new Uint8Array(0);
  let replacements = 0;

  const releaseReader = (activeReader: ReadableStreamDefaultReader<Uint8Array>): void => {
    if (reader !== activeReader) return;
    reader = undefined;
    activeReader.releaseLock();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = body.getReader();
    },
    async pull(controller) {
      const activeReader = reader;
      if (activeReader === undefined) {
        controller.error(new Error("replaceOutputMarker: source reader is unavailable"));
        return;
      }

      try {
        const chunk = await activeReader.read();
        if (chunk.done) {
          if (pending.byteLength > 0) {
            if (exactMatch(pending, 0, quotedMarker) && pending.byteLength === quotedMarker.byteLength) {
              controller.enqueue(replacement);
              replacements++;
            } else {
              controller.enqueue(pending);
            }
            pending = new Uint8Array(0);
          }
          releaseReader(activeReader);
          if (replacements !== 1) {
            controller.error(
              new Error(
                `replaceOutputMarker: expected exactly 1 marker occurrence, found ${replacements}`,
              ),
            );
            return;
          }
          controller.close();
          return;
        }

        const combined = concatBytes(pending, chunk.value);
        const result = replaceOneQuotedMarker(combined, quotedMarker, replacement);
        pending = result.pending;
        replacements += result.replacements;

        controller.enqueue(result.emitted);
      } catch (error) {
        releaseReader(activeReader);
        controller.error(error);
      }
    },
    async cancel() {
      const activeReader = reader;
      try {
        await activeReader?.cancel().catch(() => undefined);
      } finally {
        if (activeReader !== undefined) releaseReader(activeReader);
      }
    },
  });
}
