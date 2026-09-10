import type { PrepareErrorCode } from "@octg/shared";
import { parsePrepareMetadata, type PrepareOutcome } from "./prepare-contract";

const ERROR_BODY_MAX_BYTES = 4096;
const PREPARE_METADATA_HEADER = "x-octg-prepare-metadata";

/** Allowed 400 codes. */
const CODES_400: readonly PrepareErrorCode[] = ["invalid_body", "non_text", "max_tokens_conflict"];
/** Allowed 413 codes. */
const CODES_413: readonly PrepareErrorCode[] = ["input_too_large", "request_too_large"];

export interface PrepareWithDenoArgs {
  readonly endpoint: string;
  readonly authToken: string;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly request: Request;
  readonly fetchImpl?: typeof fetch;
  readonly onTimeout?: () => void;
}

/**
 * Call the Deno `/prepare` endpoint, forwarding the original request body stream.
 *
 * The timeout remains active until a resolved body closes or `cancel()` runs.
 * HTTP status is classified before any error body is parsed. Only exact
 * `400`/code and `413`/code combinations map to `rejected`; everything else
 * non-200 maps to `unavailable`. A successful `200` requires the expected
 * `application/json` media type, a bounded valid metadata header, and a
 * non-null body — the body is returned without being read.
 */
export async function prepareWithDeno(args: PrepareWithDenoArgs): Promise<PrepareOutcome> {
  const { endpoint, authToken, timeoutMs, maxInputBytes, request } = args;
  const fetchImpl = args.fetchImpl ?? fetch;

  const controller = new AbortController();
  let response: Response | undefined;
  let resolved = false;
  let cancelled = false;
  let timeoutFired = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let cancelResolvedBody: (() => Promise<void>) | undefined;

  const cancelResponseBody = async (): Promise<void> => {
    const body = response?.body;
    if (body === null || body === undefined) return;
    await body.cancel().catch(() => undefined);
  };

  const clearTimeout_ = (): void => {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };

  // Set up the timeout. It fires before resolution (→ unavailable: timeout)
  // or after resolution if the body doesn't close in time (→ onTimeout callback).
  timeoutHandle = setTimeout(() => {
    timeoutFired = true;
    controller.abort();
    if (!resolved) {
      void cancelResponseBody();
      // Pre-resolution timeout — outcome is handled in the catch block.
    } else {
      void cancelResolvedBody?.();
      // Post-resolution timeout — invoke local lifecycle callback.
      args.onTimeout?.();
    }
  }, timeoutMs);

  // Execute the fetch, forwarding the original body stream.
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
      },
      body: request.body,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout_();
    if (timeoutFired) {
      return { kind: "unavailable", failure: "timeout" };
    }
    // Network failure (including abort that wasn't our timeout).
    if (error instanceof DOMException && error.name === "AbortError") {
      return { kind: "unavailable", failure: "timeout" };
    }
    return { kind: "unavailable", failure: "network" };
  }

  if (timeoutFired) {
    clearTimeout_();
    await cancelResponseBody();
    return { kind: "unavailable", failure: "timeout" };
  }

  // The response arrived. Now classify by HTTP status.
  const status = response.status;

  // --- 400 / 413: bounded error envelope ---
  if (status === 400 || status === 413) {
    const allowedCodes = status === 400 ? CODES_400 : CODES_413;
    const outcome = await classifyErrorEnvelope(response, allowedCodes);
    clearTimeout_();
    // Cancel the response body since we've consumed or are done with it.
    await cancelResponseBody();
    return outcome;
  }

  // --- 200: success ---
  if (status === 200) {
    const outcome = classifySuccessResponse(response, maxInputBytes);
    if (outcome.kind === "resolved") {
      // Wrap the body so normal close clears the timer, while timeout after
      // resolution keeps the resolved body in its terminal-failure path.
      const wrapped = wrapResolvedBody(response.body as ReadableStream<Uint8Array>, () => clearTimeout_());
      cancelResolvedBody = wrapped.cancel;
      resolved = true;

      const cancel = async (): Promise<void> => {
        if (cancelled) return;
        cancelled = true;
        clearTimeout_();
        controller.abort();
        await wrapped.cancel();
      };

      return {
        kind: "resolved",
        metadata: outcome.metadata,
        body: wrapped.body,
        cancel,
      };
    }
    // unavailable (malformed_response)
    clearTimeout_();
    await cancelResponseBody();
    return outcome;
  }

  // --- 500 and all other statuses: upstream_status (no body parse) ---
  clearTimeout_();
  await cancelResponseBody();
  return { kind: "unavailable", failure: "upstream_status" };
}

/* ---------- helpers ---------- */

function wrapResolvedBody(
  original: ReadableStream<Uint8Array>,
  onClose: () => void,
): { readonly body: ReadableStream<Uint8Array>; readonly cancel: () => Promise<void> } {
  const reader = original.getReader();
  let closed = false;
  let cancelPromise: Promise<void> | undefined;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    onClose();
  };

  const cancel = (): Promise<void> => {
    if (cancelPromise !== undefined) return cancelPromise;
    cleanup();
    cancelPromise = Promise.resolve()
      .then(() => reader.cancel())
      .catch(() => undefined)
      .finally(() => {
        try {
          reader.releaseLock();
        } catch {
          // already released
        }
      });
    return cancelPromise;
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          reader.releaseLock();
          controller.close();
          return;
        }
        controller.enqueue(value!);
      } catch (error) {
        cleanup();
        reader.releaseLock();
        controller.error(error);
      }
    },
    cancel,
  });

  return { body, cancel };
}

/**
 * Classify a 200 success response.
 * Requires: application/json media type, bounded valid metadata header, non-null body.
 * Does NOT consume the body.
 */
function classifySuccessResponse(
  response: Response,
  maxInputBytes: number,
):
  | { kind: "resolved"; metadata: NonNullable<ReturnType<typeof parsePrepareMetadata>> }
  | { kind: "unavailable"; failure: "malformed_response" } {
  // Check media type: application/json with optional charset.
  const contentType = response.headers.get("content-type");
  if (!isApplicationJson(contentType)) {
    return { kind: "unavailable", failure: "malformed_response" };
  }

  // Check metadata header.
  const metadataHeader = response.headers.get(PREPARE_METADATA_HEADER);
  const metadata = parsePrepareMetadata(metadataHeader, maxInputBytes);
  if (metadata === undefined) {
    return { kind: "unavailable", failure: "malformed_response" };
  }

  // Check non-null body.
  if (response.body === null) {
    return { kind: "unavailable", failure: "malformed_response" };
  }

  return { kind: "resolved", metadata };
}

/**
 * Read a bounded error envelope for 400/413 and classify it.
 * Expects a `application/json` object with exactly one `code` field matching
 * the allowed codes for the status. Reader rejection, invalid JSON, wrong/unknown
 * code, wrong content type, or measured oversize → malformed_response.
 * Measured oversize cancels the active reader exactly once.
 */
async function classifyErrorEnvelope(
  response: Response,
  allowedCodes: readonly PrepareErrorCode[],
): Promise<PrepareOutcome> {
  if (!isApplicationJson(response.headers.get("content-type"))) {
    return { kind: "unavailable", failure: "malformed_response" };
  }

  const body = response.body;
  if (body === null) {
    return { kind: "unavailable", failure: "malformed_response" };
  }

  const bytes = await readBoundedErrorBody(body);
  if (bytes === undefined) {
    return { kind: "unavailable", failure: "malformed_response" };
  }

  const code = parseAllowedErrorCode(bytes, allowedCodes);
  if (code === undefined) {
    return { kind: "unavailable", failure: "malformed_response" };
  }

  return { kind: "rejected", code };
}

async function readBoundedErrorBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array | undefined> {
  const reader = body.getReader();
  let totalBytes = 0;
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      totalBytes += value.byteLength;
      if (totalBytes > ERROR_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }

  return concatUint8Arrays(chunks);
}

function parseAllowedErrorCode(
  bytes: Uint8Array,
  allowedCodes: readonly PrepareErrorCode[],
): PrepareErrorCode | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "code") {
    return undefined;
  }

  const code = record.code;
  if (typeof code !== "string" || !allowedCodes.includes(code as PrepareErrorCode)) {
    return undefined;
  }
  return code as PrepareErrorCode;
}

/** Check if a content-type is `application/json` with optional `charset` parameter. */
function isApplicationJson(contentType: string | null): boolean {
  if (contentType === null) return false;
  const parts = contentType.split(";").map((p) => p.trim().toLowerCase());
  if (parts[0] !== "application/json") return false;
  // Allow optional charset=utf-8 only.
  for (const part of parts.slice(1)) {
    if (!part?.startsWith("charset=")) return false;
  }
  return true;
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
