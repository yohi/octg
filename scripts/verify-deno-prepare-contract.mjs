#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PREPARE_BODY_INSPECTION_BYTES = 512;

const MAX_METADATA_HEADER_BYTES = 4_096;
const REQUEST_TIMEOUT_MS = 10_000;
const PROBE_OUTPUT_BUDGET = 16;
const PREPARE_METADATA_HEADER = "x-octg-prepare-metadata";
const MARKER_PATTERN = /^octg_prepare_[0-9a-f]{32}$/;
const encoder = new TextEncoder();
const PROBE_BODY = JSON.stringify({
  model: "gpt-5",
  input: "contract probe",
  max_output_tokens: PROBE_OUTPUT_BUDGET,
});

const STABLE_CATEGORIES = new Set([
  "endpoint_invalid",
  "health_status",
  "prepare_status",
  "health_unavailable",
  "prepare_unavailable",
  "metadata_invalid",
  "body_layout_invalid",
  "body_too_large",
  "body_read_failed",
]);

function probeFailure(category) {
  const error = new Error(category);
  error.name = "DenoPrepareContractError";
  error.code = category;
  return error;
}

function isProbeFailure(error) {
  return error instanceof Error && error.name === "DenoPrepareContractError";
}

function parseEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw probeFailure("endpoint_invalid");
  }

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw probeFailure("endpoint_invalid");
  }

  if (
    url.protocol !== "https:" ||
    url.username.length !== 0 ||
    url.password.length !== 0
  ) {
    throw probeFailure("endpoint_invalid");
  }

  const finalSlash = url.pathname.lastIndexOf("/");
  if (finalSlash < 0 || url.pathname.slice(finalSlash + 1) !== "prepare") {
    throw probeFailure("endpoint_invalid");
  }

  const pathPrefix = url.pathname.slice(0, finalSlash);
  url.pathname = pathPrefix === "" ? "/health" : `${pathPrefix}/health`;
  return { prepareUrl: endpoint, healthUrl: url.toString() };
}

function validateArguments(args) {
  if (args === null || typeof args !== "object") {
    throw probeFailure("endpoint_invalid");
  }

  const { endpoint, token, maxInputBytes, fetchImpl } = args;
  const urls = parseEndpoint(endpoint);
  if (typeof token !== "string" || token.length === 0) {
    throw probeFailure("endpoint_invalid");
  }
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw probeFailure("endpoint_invalid");
  }
  if (encoder.encode(PROBE_BODY).byteLength > maxInputBytes) {
    throw probeFailure("endpoint_invalid");
  }

  const fetcher = fetchImpl ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw probeFailure("endpoint_invalid");
  }

  return { ...urls, token, fetcher };
}

async function fetchWithCategory(fetcher, url, init, category) {
  const controller = new AbortController();
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(probeFailure(category));
    }, REQUEST_TIMEOUT_MS);
  });

  try {
    let request;
    try {
      request = fetcher(url, { ...init, signal: controller.signal });
    } catch {
      throw probeFailure(category);
    }
    try {
      return await Promise.race([Promise.resolve(request), timeout]);
    } catch {
      throw probeFailure(category);
    }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function responseStatus(response) {
  try {
    return typeof response?.status === "number" ? response.status : undefined;
  } catch {
    return undefined;
  }
}

async function cancelResponseBody(response) {
  let body;
  try {
    body = response?.body;
  } catch {
    return;
  }
  if (body === null || body === undefined || typeof body.cancel !== "function") return;
  try {
    await body.cancel();
  } catch {
    // A status or metadata failure must not expose a response-body error.
  }
}

function headerValue(response, name) {
  try {
    const value = response?.headers?.get(name);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function decodeBase64Url(value) {
  if (
    value.length === 0 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return undefined;
  }

  let base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  while (base64.length % 4 !== 0) base64 += "=";

  let binary;
  try {
    binary = atob(base64);
  } catch {
    return undefined;
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function readPrepareMarker(response) {
  const encoded = headerValue(response, PREPARE_METADATA_HEADER);
  if (
    encoded === undefined ||
    encoded.length === 0 ||
    encoded.length > MAX_METADATA_HEADER_BYTES
  ) {
    return undefined;
  }

  const decoded = decodeBase64Url(encoded);
  if (decoded === undefined || decoded.byteLength > MAX_METADATA_HEADER_BYTES) {
    return undefined;
  }

  let metadata;
  try {
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch {
    return undefined;
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    typeof metadata.outputMarker !== "string" ||
    !MARKER_PATTERN.test(metadata.outputMarker)
  ) {
    return undefined;
  }
  return metadata.outputMarker;
}

function bytesEqual(bytes, offset, expected) {
  if (offset < 0 || offset + expected.byteLength > bytes.byteLength) return false;
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (bytes[offset + index] !== expected[index]) return false;
  }
  return true;
}

function bytesStartWith(bytes, expected) {
  return bytesEqual(bytes, 0, expected);
}

function countExactOccurrences(bytes, needle) {
  let count = 0;
  for (let offset = 0; offset + needle.byteLength <= bytes.byteLength; offset += 1) {
    if (bytesEqual(bytes, offset, needle)) count += 1;
  }
  return count;
}

function replaceExactOccurrence(bytes, needle, replacement) {
  let matchOffset = -1;
  for (let offset = 0; offset + needle.byteLength <= bytes.byteLength; offset += 1) {
    if (bytesEqual(bytes, offset, needle)) {
      matchOffset = offset;
      break;
    }
  }
  if (matchOffset < 0) return undefined;

  const result = new Uint8Array(
    bytes.byteLength - needle.byteLength + replacement.byteLength,
  );
  result.set(bytes.subarray(0, matchOffset), 0);
  result.set(replacement, matchOffset);
  result.set(
    bytes.subarray(matchOffset + needle.byteLength),
    matchOffset + replacement.byteLength,
  );
  return result;
}

function validateInspectedPrefix(prefix, marker, bounded) {
  const firstProperty = encoder.encode('{"max_output_tokens":');
  const quotedMarker = encoder.encode(JSON.stringify(marker));
  const expectedPrefix = new Uint8Array(
    firstProperty.byteLength + quotedMarker.byteLength + 1,
  );
  expectedPrefix.set(firstProperty, 0);
  expectedPrefix.set(quotedMarker, firstProperty.byteLength);
  expectedPrefix[firstProperty.byteLength + quotedMarker.byteLength] = 0x2c;

  const markerWithoutClosingQuote = quotedMarker.subarray(0, quotedMarker.byteLength - 1);
  const expectedMarkerStart = new Uint8Array(
    firstProperty.byteLength + markerWithoutClosingQuote.byteLength,
  );
  expectedMarkerStart.set(firstProperty, 0);
  expectedMarkerStart.set(markerWithoutClosingQuote, firstProperty.byteLength);

  if (!bytesStartWith(prefix, expectedPrefix)) {
    if (
      bounded &&
      prefix.byteLength >= expectedMarkerStart.byteLength &&
      bytesStartWith(prefix, expectedMarkerStart)
    ) {
      return "body_too_large";
    }
    return "body_layout_invalid";
  }

  if (countExactOccurrences(prefix, quotedMarker) !== 1) {
    return "body_layout_invalid";
  }

  const replacement = encoder.encode(String(PROBE_OUTPUT_BUDGET));
  const transformed = replaceExactOccurrence(prefix, quotedMarker, replacement);
  if (transformed === undefined) return "body_layout_invalid";

  const expectedNumericPrefix = new Uint8Array(
    firstProperty.byteLength + replacement.byteLength + 1,
  );
  expectedNumericPrefix.set(firstProperty, 0);
  expectedNumericPrefix.set(replacement, firstProperty.byteLength);
  expectedNumericPrefix[firstProperty.byteLength + replacement.byteLength] = 0x2c;
  return bytesStartWith(transformed, expectedNumericPrefix) ? true : "body_layout_invalid";
}

async function inspectResponseBody(body, marker) {
  let reader;
  try {
    reader = body?.getReader();
  } catch {
    throw probeFailure("body_read_failed");
  }
  if (
    reader === null ||
    typeof reader !== "object" ||
    typeof reader.read !== "function" ||
    typeof reader.cancel !== "function"
  ) {
    throw probeFailure("body_read_failed");
  }

  let cancellation;
  let cancelFailed = false;
  const cancelOnce = () => {
    if (cancellation !== undefined) return cancellation;
    cancellation = Promise.resolve()
      .then(() => reader.cancel())
      .catch(() => {
        cancelFailed = true;
        return undefined;
      });
    return cancellation;
  };

  let validationError;
  try {
    const prefix = new Uint8Array(PREPARE_BODY_INSPECTION_BYTES);
    let prefixLength = 0;
    let bounded = false;

    while (prefixLength < PREPARE_BODY_INSPECTION_BYTES) {
      let result;
      try {
        result = await reader.read();
      } catch {
        throw probeFailure("body_read_failed");
      }
      if (result === null || typeof result !== "object" || typeof result.done !== "boolean") {
        throw probeFailure("body_read_failed");
      }
      if (result.done) break;

      const chunk = result.value;
      if (!(chunk instanceof Uint8Array)) {
        throw probeFailure("body_read_failed");
      }

      const remaining = PREPARE_BODY_INSPECTION_BYTES - prefixLength;
      const inspectedLength = Math.min(chunk.byteLength, remaining);
      if (inspectedLength > 0) {
        prefix.set(chunk.subarray(0, inspectedLength), prefixLength);
        prefixLength += inspectedLength;
      }
      if (chunk.byteLength > inspectedLength || prefixLength === PREPARE_BODY_INSPECTION_BYTES) {
        bounded = true;
        break;
      }
    }

    const inspected = prefix.subarray(0, prefixLength);
    const result = validateInspectedPrefix(inspected, marker, bounded);
    if (result !== true) throw probeFailure(result);
  } catch (error) {
    validationError = isProbeFailure(error) ? error : probeFailure("body_read_failed");
  }

  await cancelOnce();
  try {
    reader.releaseLock?.();
  } catch {
    // Releasing a completed reader must not change the stable result category.
  }

  if (validationError !== undefined) throw validationError;
  if (cancelFailed) throw probeFailure("body_read_failed");
  return true;
}

export async function verifyPrepareContract(args) {
  const config = validateArguments(args);

  const healthResponse = await fetchWithCategory(
    config.fetcher,
    config.healthUrl,
    { method: "GET", headers: { accept: "application/json" } },
    "health_unavailable",
  );
  if (responseStatus(healthResponse) !== 200) {
    await cancelResponseBody(healthResponse);
    throw probeFailure("health_status");
  }
  await cancelResponseBody(healthResponse);

  const prepareResponseResult = await fetchWithCategory(
    config.fetcher,
    config.prepareUrl,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: PROBE_BODY,
    },
    "prepare_unavailable",
  );
  if (responseStatus(prepareResponseResult) !== 200) {
    await cancelResponseBody(prepareResponseResult);
    throw probeFailure("prepare_status");
  }

  const marker = readPrepareMarker(prepareResponseResult);
  if (marker === undefined) {
    await cancelResponseBody(prepareResponseResult);
    throw probeFailure("metadata_invalid");
  }

  if (prepareResponseResult.body === null || prepareResponseResult.body === undefined) {
    throw probeFailure("body_read_failed");
  }
  return inspectResponseBody(prepareResponseResult.body, marker);
}

async function main() {
  await verifyPrepareContract({
    endpoint: process.env.DENO_PREPARE_ENDPOINT,
    token: process.env.DENO_TOKENIZER_AUTH_TOKEN,
    maxInputBytes: Number(process.env.MAX_INPUT_BYTES),
  });
  console.log("octg.deno_prepare_contract_ok");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const category = isProbeFailure(error) && STABLE_CATEGORIES.has(error.code)
      ? error.code
      : "endpoint_invalid";
    console.error(`octg.deno_prepare_contract_error: ${category}`);
    process.exitCode = 1;
  }
}
