import type { DenoTokenizerServiceConfig } from "./config.ts";
import type { ExactEncoder } from "./encoder.ts";
import {
  estimatedInputTokensOf,
  normalizeResponses,
  normalizeResponsesUpstreamBody,
} from "@octg/shared";
import type {
  NormalizeError,
  PrepareErrorCode,
  PrepareMetadata,
} from "@octg/shared";

const jsonContentType = "application/json; charset=utf-8";
const prepareJsonContentType = "application/json";
const prepareMetadataHeader = "X-OCTG-Prepare-Metadata";
const maxMetadataHeaderBytes = 4096;
const markerHexBytes = 16;
const maxMarkerAttempts = 16;
const bearerPrefix = "Bearer ";
const sha256DigestBytes = 32;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type TokenizeInput = {
  readonly inputText: string;
};

function errorResponse(status: number): Response {
  return new Response(null, { status });
}

function successResponse(baseTokenCount: number): Response {
  return new Response(JSON.stringify({ baseTokenCount }), {
    headers: { "content-type": jsonContentType },
  });
}

function contentLengthResponse(
  request: Request,
  maxRawBodyBytes: number,
): Response | undefined {
  const contentLength = request.headers.get("content-length");
  if (contentLength === null) {
    return undefined;
  }
  if (!/^\d+$/.test(contentLength)) {
    return errorResponse(400);
  }

  const declaredBytes = Number(contentLength);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxRawBodyBytes) {
    return errorResponse(413);
  }
  return undefined;
}

async function boundedBody(
  request: Request,
  maxRawBodyBytes: number,
): Promise<Response | Uint8Array> {
  const declaredLengthError = contentLengthResponse(request, maxRawBodyBytes);
  if (declaredLengthError !== undefined) {
    return declaredLengthError;
  }

  if (request.body === null) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      bytesRead += chunk.value.byteLength;
      if (bytesRead > maxRawBodyBytes) {
        await reader.cancel();
        return errorResponse(413);
      }
      chunks.push(chunk.value);
    }
  } catch {
    return errorResponse(400);
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function tokenizeInputOf(value: unknown): TokenizeInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const propertyNames = Object.keys(value);
  if (propertyNames.length !== 1 || propertyNames[0] !== "inputText") {
    return undefined;
  }
  if (!("inputText" in value) || typeof value.inputText !== "string") {
    return undefined;
  }
  return { inputText: value.inputText };
}

function parseInput(rawBody: Uint8Array, mediaType?: string): TokenizeInput | undefined {
  let bodyText: string;
  try {
    bodyText = textDecoder.decode(rawBody);
  } catch {
    return undefined;
  }

  if (mediaType === "text/plain") {
    return { inputText: bodyText };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  return tokenizeInputOf(parsed);
}

interface ParsedContentType {
  readonly mediaType?: string;
  readonly charset?: string;
}

function parseContentType(request: Request): ParsedContentType {
  const contentType = request.headers.get("content-type");
  if (!contentType) return {};
  const parts = contentType.split(";").map((p) => p.trim());
  const mediaType = parts[0]?.toLowerCase();
  let charset: string | undefined;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const equalIndex = part.indexOf("=");
    if (equalIndex !== -1) {
      const key = part.slice(0, equalIndex).trim().toLowerCase();
      if (key === "charset") {
        let value = part.slice(equalIndex + 1).trim().toLowerCase();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1).trim();
        }
        charset = value;
      }
    }
  }
  return { mediaType, charset };
}

function acceptsPayload({ mediaType, charset }: ParsedContentType): boolean {
  if (mediaType === "application/json" || mediaType === "text/plain") {
    return charset === undefined || charset === "utf-8";
  }
  return false;
}

async function isAuthorized(
  authorization: string | null,
  expectedToken: string,
): Promise<boolean> {
  const authorizationValue = authorization ?? "";
  const hasBearerPrefix = authorizationValue.startsWith(bearerPrefix);
  const presentedToken = hasBearerPrefix
    ? authorizationValue.slice(bearerPrefix.length)
    : "";
  const [expectedDigest, presentedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", textEncoder.encode(expectedToken)),
    crypto.subtle.digest("SHA-256", textEncoder.encode(presentedToken)),
  ]);
  const expectedBytes = new Uint8Array(expectedDigest);
  const presentedBytes = new Uint8Array(presentedDigest);
  let difference = 0;
  for (let index = 0; index < sha256DigestBytes; index += 1) {
    difference |= expectedBytes[index] ^ presentedBytes[index];
  }
  return hasBearerPrefix && difference === 0;
}

type PrepareRawBodyResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "too_large" | "read_failure" };

function contentLengthValue(request: Request): string | null {
  return request.headers.get("content-length");
}

function isDeclaredOversize(contentLength: string, maxBytes: number): boolean {
  if (!/^\d+$/.test(contentLength)) {
    return false;
  }
  const declaredBytes = Number(contentLength);
  return Number.isSafeInteger(declaredBytes) && declaredBytes > maxBytes;
}

async function readBoundedRawBody(
  request: Request,
  maxBytes: number,
): Promise<PrepareRawBodyResult> {
  const contentLength = contentLengthValue(request);
  if (contentLength !== null && isDeclaredOversize(contentLength, maxBytes)) {
    if (request.body !== null) {
      await request.body.cancel();
    }
    return { ok: false, reason: "too_large" };
  }

  if (request.body === null) {
    return { ok: true, bytes: new Uint8Array() };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return { ok: false, reason: "read_failure" };
  }

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { ok: false, reason: "read_failure" };
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: body };
}

function prepareError(status: 400 | 413, code: PrepareErrorCode): Response {
  return new Response(JSON.stringify({ code }), {
    status,
    headers: { "content-type": prepareJsonContentType },
  });
}

function prepareInternalFailure(): Response {
  return new Response(null, { status: 500 });
}

function generateMarker(): string {
  const bytes = new Uint8Array(markerHexBytes);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `octg_prepare_${hex}`;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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

function acceptsPreparePayload({ mediaType, charset }: ParsedContentType): boolean {
  if (mediaType === "application/json") {
    return charset === undefined || charset === "utf-8";
  }
  return false;
}

function mapNormalizeError(error: NormalizeError): PrepareErrorCode {
  return error;
}

async function handlePrepare(
  request: Request,
  config: DenoTokenizerServiceConfig,
  encoder: ExactEncoder,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(405);
  }
  if (
    !await isAuthorized(
      request.headers.get("authorization"),
      config.authToken,
    )
  ) {
    return errorResponse(401);
  }
  const contentType = parseContentType(request);
  if (!acceptsPreparePayload(contentType)) {
    return errorResponse(415);
  }

  const rawBody = await readBoundedRawBody(request, config.maxInputBytes);
  if (!rawBody.ok) {
    if (rawBody.reason === "read_failure") {
      return prepareInternalFailure();
    }
    return prepareError(413, "request_too_large");
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(rawBody.bytes));
  } catch {
    return prepareError(400, "invalid_body");
  }

  const normalized = normalizeResponses(parsedBody, config.maxInputBytes);
  if (!normalized.ok) {
    return prepareError(
      normalized.error === "input_too_large" ? 413 : 400,
      mapNormalizeError(normalized.error),
    );
  }

  let estimatedInputTokens: number;
  try {
    const baseTokenCount = encoder.count(normalized.value.inputText);
    estimatedInputTokens = estimatedInputTokensOf({
      baseTokenCount,
      messageCount: normalized.value.messageCount,
      opaqueInputBytes: normalized.value.opaqueInputBytes,
    });
  } catch {
    return prepareInternalFailure();
  }

  const upstreamBody = normalizeResponsesUpstreamBody(
    parsedBody as Record<string, unknown>,
  );

  let outputMarker = "";
  let serialized = "";
  for (let attempt = 0; attempt < maxMarkerAttempts; attempt += 1) {
    const candidate = generateMarker();
    const candidateBody = { ...upstreamBody, max_output_tokens: candidate };
    const candidateSerialized = JSON.stringify(candidateBody);
    const markerJson = JSON.stringify(candidate);
    if (countOccurrences(candidateSerialized, markerJson) === 1) {
      outputMarker = candidate;
      serialized = candidateSerialized;
      break;
    }
  }
  if (outputMarker === "") {
    return prepareInternalFailure();
  }

  const metadata: PrepareMetadata = {
    version: 1,
    model: normalized.value.model,
    rawBodyBytes: rawBody.bytes.byteLength,
    inputBytes: normalized.value.inputBytes,
    inputTextBytes: normalized.value.inputTextBytes,
    opaqueInputBytes: normalized.value.opaqueInputBytes,
    messageCount: normalized.value.messageCount,
    estimatedInputTokens,
    estimationPath: "exact_bpe",
    maxOutputTokens: normalized.value.maxOutputTokens,
    stream: normalized.value.stream,
    isToolUse: normalized.value.isToolUse,
    outputMarker,
  };

  const metadataJson = JSON.stringify(metadata);
  const metadataHeader = base64urlEncode(textEncoder.encode(metadataJson));
  if (metadataHeader.length > maxMetadataHeaderBytes) {
    return prepareInternalFailure();
  }

  return new Response(serialized, {
    status: 200,
    headers: {
      "content-type": prepareJsonContentType,
      [prepareMetadataHeader]: metadataHeader,
    },
  });
}

export function createTokenizerHandler(args: {
  readonly config: DenoTokenizerServiceConfig;
  readonly encoder: ExactEncoder;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return errorResponse(405);
      }
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "content-type": jsonContentType },
      });
    }
    if (url.pathname === "/prepare") {
      return handlePrepare(request, args.config, args.encoder);
    }
    if (url.pathname !== "/tokenize") {
      return errorResponse(404);
    }
    if (request.method !== "POST") {
      return errorResponse(405);
    }
    if (
      !await isAuthorized(
        request.headers.get("authorization"),
        args.config.authToken,
      )
    ) {
      return errorResponse(401);
    }
    const contentType = parseContentType(request);
    if (!acceptsPayload(contentType)) {
      return errorResponse(415);
    }

    const rawBody = await boundedBody(request, args.config.maxRawBodyBytes);
    if (rawBody instanceof Response) {
      return rawBody;
    }
    const input = parseInput(rawBody, contentType.mediaType);
    if (input === undefined) {
      return errorResponse(400);
    }
    if (
      textEncoder.encode(input.inputText).byteLength > args.config.maxInputBytes
    ) {
      return errorResponse(413);
    }

    try {
      return successResponse(args.encoder.count(input.inputText));
    } catch {
      // Encoder details, including input-derived exception text, must not escape.
      return errorResponse(500);
    }
  };
}
