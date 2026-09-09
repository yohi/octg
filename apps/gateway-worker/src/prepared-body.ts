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

  while (i <= combined.byteLength) {
    // Try to find the full quoted marker starting at position i
    if (exactMatch(combined, i, quotedMarker)) {
      emittedParts.push(replacement);
      replacements++;
      i += quotedMarker.byteLength;
      continue;
    }

    // Check if a prefix of combined[i:] matches a prefix of quotedMarker.
    // If so, this position might be the start of the marker split across chunks.
    if (i < combined.byteLength) {
      const prefixLen = matchPrefix(combined.subarray(i), quotedMarker);
      if (prefixLen > 0) {
        // The bytes from i to i+prefixLen could be the start of the marker.
        // Everything before i is safe to emit.
        // The suffix from i is pending.
        break;
      }
    }

    // No match and no prefix match at position i — emit this byte and advance.
    if (i < combined.byteLength) {
      emittedParts.push(combined.subarray(i, i + 1));
    }
    i++;
  }

  // If we broke out of the loop due to a prefix match, the pending bytes are combined[i:].
  // If we reached the end (i > combined.byteLength), pending is empty.
  const pending = i < combined.byteLength ? combined.subarray(i) : new Uint8Array(0);

  let emitted: Uint8Array;
  if (emittedParts.length === 0) {
    emitted = new Uint8Array(0);
  } else if (emittedParts.length === 1) {
    emitted = emittedParts[0]!;
  } else {
    const totalLen = emittedParts.reduce((sum, p) => sum + p.byteLength, 0);
    emitted = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of emittedParts) {
      emitted.set(part, offset);
      offset += part.byteLength;
    }
  }

  return { emitted, pending, replacements };
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

  let pending: Uint8Array = new Uint8Array(0);
  let replacements = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const reader = body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            // Flush: check pending bytes for a complete marker match
            if (pending.byteLength > 0) {
              if (exactMatch(pending, 0, quotedMarker) && pending.byteLength === quotedMarker.byteLength) {
                controller.enqueue(replacement);
                replacements++;
              } else {
                // Pending bytes are not a complete marker — emit them
                controller.enqueue(pending);
              }
              pending = new Uint8Array(0);
            }
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

          if (result.emitted.byteLength > 0) {
            controller.enqueue(result.emitted);
          }
        }
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel() {
      body.cancel().catch(() => undefined);
    },
  });
}