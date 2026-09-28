/**
 * Bounded upstream usage extraction and terminal reporting for the relay.
 *
 * `relayUpstreamResponse` forwards upstream bytes unchanged while inspecting a
 * bounded tail for Responses usage, reports terminal settle/uncertain exactly
 * once per response, and keeps the in-flight lease alive with renewal callbacks
 * from the relay configuration. Every ambiguous outcome (no trustworthy usage,
 * stream abort, client disconnect, renewal failure, callback failure) is
 * terminal `uncertain`; a post-activation reservation is never released here.
 * See the normative relay contract in
 * docs/superpowers/specs/2026-09-23-free-worker-deno-relay-design.md.
 *
 * allow: SIZE_OK — one mandated settlement seam (bounded extraction +
 * byte-preserving forwarding + exactly-once reporting); the task file list
 * fixes this module, so it cannot be split without violating the assignment.
 */

import { isRecord } from "@octg/shared";
import type { RelayTerminalOutcome, RelayTerminalV1 } from "@octg/shared";

const tailCapacityBytes = 32_768;
const usageNeedle = '"usage"';
const responseCompletedNeedle = "response.completed";
const eventStreamMediaType = "text/event-stream";
const jsonSeparator = ";";
/** Symmetric with the 1,048,576-byte ingress bound; over-cap fails closed. */
const maxNonStreamResponseBytes = 1_048_576;

/** Grant-bound coordination for one active upstream exchange. */
export interface RelayGrantSession {
  readonly grantId: string;
  readonly leaseGeneration: string;
  /** Extends the in-flight lease; rejects on definitive or ambiguous failure. */
  readonly renewLease: () => Promise<void>;
  /** Fixed renewal cadence from the relay configuration (30,000 ms). */
  readonly renewalIntervalMs: number;
}

export type RelayTerminalReporter = (report: RelayTerminalV1) => Promise<void>;

type DeliveryFailureReason = "read_failure" | "response_too_large";

/**
 * A 2xx upstream response could not be delivered faithfully after a bounded
 * read. The terminal report has already been sent; callers map the client
 * failure without a second terminal report.
 */
export class RelayUpstreamDeliveryError extends Error {
  readonly reason: DeliveryFailureReason;

  constructor(reason: DeliveryFailureReason) {
    super("upstream response could not be delivered");
    this.name = "RelayUpstreamDeliveryError";
    this.reason = reason;
  }
}

type BoundedReadResult =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly ok: false; readonly reason: DeliveryFailureReason };

interface LeaseRenewal {
  readonly start: () => void;
  readonly stop: () => void;
}

function isSafeTotalTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function findBraceOpen(event: string, colonIndex: number): number {
  const limit = Math.min(event.length, colonIndex + 20);
  for (let i = colonIndex + 1; i < limit; i++) {
    const code = event.codePointAt(i);
    if (code === 123) return i;
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
  }
  return -1;
}

function findUsageColon(event: string, searchStart: number): number {
  let stringStart = -1;
  let escaped = false;
  for (let i = searchStart; i < event.length; i++) {
    const code = event.codePointAt(i);
    if (stringStart === -1) {
      if (code === 34) stringStart = i;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (code === 92) {
      escaped = true;
      continue;
    }
    if (code !== 34) continue;

    if (i - stringStart === 6 && event.startsWith("usage", stringStart + 1)) {
      let colonIndex = i + 1;
      while (colonIndex < event.length) {
        const colonCode = event.codePointAt(colonIndex);
        if (colonCode !== 32 && colonCode !== 9 && colonCode !== 10 && colonCode !== 13) {
          if (colonCode === 58) return colonIndex;
          break;
        }
        colonIndex++;
      }
    }
    stringStart = -1;
  }
  return -1;
}

function findMatchingBraceClose(event: string, braceOpen: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceOpen; i < event.length; i++) {
    const code = event.codePointAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (code === 92) {
        escaped = true;
      } else if (code === 34) {
        inString = false;
      }
      continue;
    }
    if (code === 34) {
      inString = true;
      continue;
    }
    if (code === 123) {
      depth++;
    } else if (code === 125) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Scans a bounded text window for a `"usage":{...}` snippet whose
 * `total_tokens` is a safe non-negative integer; the last match wins.
 */
function extractUsageTotalTokens(text: string): number | undefined {
  let searchStart = 0;
  while (searchStart < text.length) {
    const colonIndex = findUsageColon(text, searchStart);
    if (colonIndex === -1) break;
    searchStart = colonIndex + 1;

    const braceOpen = findBraceOpen(text, colonIndex);
    if (braceOpen === -1) continue;

    const braceClose = findMatchingBraceClose(text, braceOpen);
    if (braceClose === -1) continue;

    try {
      const parsed: unknown = JSON.parse(text.slice(braceOpen, braceClose + 1));
      if (isRecord(parsed) && isSafeTotalTokens(parsed.total_tokens)) {
        return parsed.total_tokens;
      }
    } catch {
      // Not a complete usage object; keep scanning the window.
    }
  }
  return undefined;
}

/**
 * Scans a decoded tail window event by event (SSE splits on blank lines,
 * accepting both `\\n\\n` and `\\r\\n\\r\\n`). The snippet scanner relies on
 * quote pairing from a clean boundary, so a scan that starts mid-string would
 * desynchronize; each event restarts it. The last complete usage snippet in
 * the window wins.
 */
function extractUsageFromTailText(text: string): number | undefined {
  const events = text.split(/\r?\n\r?\n/);
  let found: number | undefined;
  for (const event of events) {
    if (!event.includes(usageNeedle) && !event.includes(responseCompletedNeedle)) continue;
    const extracted = extractUsageTotalTokens(event);
    if (extracted !== undefined) found = extracted;
  }
  return found;
}

function bytesIncludesAscii(bytes: Uint8Array, needle: string): boolean {
  const first = needle.codePointAt(0);
  if (first === undefined) return false;
  const len = bytes.byteLength;
  const nlen = needle.length;
  if (len < nlen) return false;
  for (let i = 0; i <= len - nlen; i++) {
    if (bytes[i] === first) {
      let match = true;
      for (let j = 1; j < nlen; j++) {
        const expected = needle.codePointAt(j);
        if (expected === undefined || bytes[i + j] !== expected) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
  }
  return false;
}

function mightContainUsage(bytes: Uint8Array): boolean {
  return bytesIncludesAscii(bytes, usageNeedle) || bytesIncludesAscii(bytes, responseCompletedNeedle);
}

/** Bounded sliding window over the most recent stream bytes. */
class RingTailBuffer {
  // Builder/accumulator: the buffer exists to be mutated by write().
  private readonly buffer: Uint8Array;
  private readonly capacity: number;
  private writeIndex = 0;
  private totalBytes = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Uint8Array(capacity);
  }

  write(chunk: Uint8Array): void {
    const len = chunk.byteLength;
    if (len === 0) return;
    this.totalBytes += len;

    if (len >= this.capacity) {
      this.buffer.set(chunk.subarray(len - this.capacity), 0);
      this.writeIndex = 0;
      return;
    }

    const firstPart = Math.min(len, this.capacity - this.writeIndex);
    this.buffer.set(chunk.subarray(0, firstPart), this.writeIndex);
    if (len > firstPart) {
      const secondPart = len - firstPart;
      this.buffer.set(chunk.subarray(firstPart, len), 0);
      this.writeIndex = secondPart;
    } else {
      this.writeIndex = (this.writeIndex + len) % this.capacity;
    }
  }

  getTail(): Uint8Array {
    if (this.totalBytes === 0) {
      return new Uint8Array(0);
    }
    if (this.totalBytes < this.capacity) {
      return this.buffer.slice(0, this.totalBytes);
    }
    const result = new Uint8Array(this.capacity);
    const firstPart = this.capacity - this.writeIndex;
    result.set(this.buffer.subarray(this.writeIndex), 0);
    result.set(this.buffer.subarray(0, this.writeIndex), firstPart);
    return result;
  }
}

/**
 * Decodes a byte tail starting from the first valid UTF-8 sequence boundary.
 * Skips leading continuation bytes (0x80-0xBF) and invalid leading bytes
 * (0xC0-0xC1, 0xF5-0xFF) so that a truncated multi-byte character at the start
 * of the bounded window does not produce a U+FFFD replacement character.
 */
function decodeTailBytes(bytes: Uint8Array): string {
  let start = 0;
  while (start < bytes.length) {
    const byte = bytes[start];
    if (byte === undefined) break;
    if (byte < 0x80 || (byte >= 0xC2 && byte <= 0xF4)) break;
    start++;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start));
}

function forwardedUpstreamHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();
  const contentType = upstreamHeaders.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  return headers;
}

function isEventStreamContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(jsonSeparator)[0];
  return mediaType !== undefined && mediaType.trim().toLowerCase() === eventStreamMediaType;
}

/**
 * Fixed-cadence lease renewal. Each successful `renewLease` extends the lease
 * by the configured TTL inside the Worker; a rejected renewal invokes
 * `onFailure` at most once and never retries.
 */
function createLeaseRenewal(session: RelayGrantSession, onFailure: () => void): LeaseRenewal {
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let stopped = false;
  return {
    start: () => {
      if (timer !== undefined || stopped) return;
      timer = setInterval(() => {
        if (inFlight || stopped) return;
        inFlight = true;
        session.renewLease().catch(() => {
          // The rejection reason is never logged; failure conservatively keeps
          // the reservation for reconciliation.
          if (!stopped) onFailure();
        }).finally(() => {
          inFlight = false;
        });
      }, session.renewalIntervalMs);
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

async function readBoundedBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<BoundedReadResult> {
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maxNonStreamResponseBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "response_too_large" };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { ok: false, reason: "read_failure" };
  }
  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

type TerminalReportSink = (outcome: RelayTerminalOutcome, totalTokens: number | null) => Promise<void>;

/** One upstream exchange: the response being forwarded plus its coordination channels. */
interface RelayForwarding {
  readonly response: Response;
  readonly responseHeaders: Headers;
  readonly reportOnce: TerminalReportSink;
  readonly session: RelayGrantSession;
}

function forwardEventStream(
  forwarding: RelayForwarding,
  source: ReadableStream<Uint8Array>,
): Response {
  const { response, responseHeaders, reportOnce, session } = forwarding;
  const reader = source.getReader();
  const tail = new RingTailBuffer(tailCapacityBytes);
  let usage: number | undefined;
  let finalized = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  function parseTail(text: string): void {
    const extracted = extractUsageFromTailText(text);
    if (extracted !== undefined) usage = extracted;
  }

  function finalize(outcome: RelayTerminalOutcome, totalTokens: number | null): void {
    if (finalized) return;
    finalized = true;
    renewal.stop();
    void reportOnce(outcome, totalTokens);
  }

  function abortAfterRenewalFailure(): void {
    finalize("uncertain", null);
    // Stop new upstream work: cancel the source, then error the client stream
    // instead of fabricating a second HTTP response after headers.
    void reader.cancel().catch(() => undefined);
    controller?.error(new Error("relay lease renewal failed"));
  }

  const renewal = createLeaseRenewal(session, abortAfterRenewalFailure);

  const forwarded = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    async pull(c) {
      try {
        const chunk = await reader.read();
        // A failure or disconnect finalized the stream while this read was
        // pending; the controller is already closed or errored.
        if (finalized) return;
        if (chunk.done) {
          if (usage === undefined) parseTail(decodeTailBytes(tail.getTail()));
          finalize(usage === undefined ? "uncertain" : "settle", usage ?? null);
          c.close();
          return;
        }
        c.enqueue(chunk.value);
        tail.write(chunk.value);
        if (usage === undefined && mightContainUsage(chunk.value)) parseTail(decodeTailBytes(tail.getTail()));
      } catch (error) {
        if (finalized) return;
        finalize("uncertain", null);
        c.error(error instanceof Error ? error : new Error("upstream stream failed"));
      }
    },
    cancel() {
      // A client disconnect is never proof of zero usage; post-activation
      // termination is uncertain, never release.
      finalize("uncertain", null);
      void reader.cancel().catch(() => undefined);
    },
  });

  renewal.start();
  return new Response(forwarded, { status: response.status, headers: responseHeaders });
}

async function forwardBoundedBody(forwarding: RelayForwarding): Promise<Response> {
  const { response, responseHeaders, reportOnce, session } = forwarding;
  const source = response.body;
  if (source === null) {
    await reportOnce("uncertain", null);
    return new Response(null, { status: response.status, headers: responseHeaders });
  }

  const reader = source.getReader();
  let renewalFailed = false;
  const renewal = createLeaseRenewal(session, () => {
    renewalFailed = true;
    void reader.cancel().catch(() => undefined);
  });

  renewal.start();
  try {
    const read = await readBoundedBytes(reader);
    if (!read.ok || renewalFailed) {
      await reportOnce("uncertain", null);
      throw new RelayUpstreamDeliveryError(read.ok ? "read_failure" : read.reason);
    }
    const usage = extractUsageTotalTokens(new TextDecoder().decode(read.bytes));
    await reportOnce(usage === undefined ? "uncertain" : "settle", usage ?? null);
    return new Response(read.bytes, { status: response.status, headers: responseHeaders });
  } finally {
    renewal.stop();
  }
}

/**
 * Relays an upstream response to the client while reporting terminal usage.
 *
 * Non-2xx responses are passed through unchanged after one terminal uncertain
 * report. 2xx event streams forward bytes one chunk at a time (never
 * full-buffered), inspect a bounded tail for fragmented SSE usage, and report
 * once on completion, disconnect, or upstream failure. Other 2xx bodies are
 * read with a bounded cap, reported before the response is returned, and
 * re-emitted byte-exactly; failures throw {@link RelayUpstreamDeliveryError}
 * after the terminal uncertain report so callers can map the client error.
 */
export async function relayUpstreamResponse(
  response: Response,
  onTerminal: RelayTerminalReporter,
  session: RelayGrantSession,
): Promise<Response> {
  const responseHeaders = forwardedUpstreamHeaders(response.headers);
  let reported = false;

  const reportOnce: TerminalReportSink = (outcome, totalTokens) => {
    if (reported) return Promise.resolve();
    reported = true;
    const report: RelayTerminalV1 = {
      version: 1,
      grantId: session.grantId,
      leaseGeneration: session.leaseGeneration,
      outcome,
      totalTokens,
    };
    return onTerminal(report).catch(() => {
      // Terminal callback delivery is best-effort: a failed report leaves the
      // conservative DO reservation to reconciliation. Never retried locally.
    });
  };

  if (response.status < 200 || response.status >= 300) {
    await reportOnce("uncertain", null);
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }

  const forwarding: RelayForwarding = {
    response,
    responseHeaders,
    reportOnce,
    session,
  };
  const body = response.body;
  if (isEventStreamContentType(response.headers.get("content-type")) && body !== null) {
    return forwardEventStream(forwarding, body);
  }
  return forwardBoundedBody(forwarding);
}
