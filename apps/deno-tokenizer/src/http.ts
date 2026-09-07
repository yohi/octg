import type { DenoTokenizerServiceConfig } from "./config.ts";
import type { ExactEncoder } from "./encoder.ts";

const jsonContentType = "application/json; charset=utf-8";
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

function acceptsPayload(request: Request): boolean {
  const { mediaType, charset } = parseContentType(request);
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
    if (!acceptsPayload(request)) {
      return errorResponse(415);
    }

    const rawBody = await boundedBody(request, args.config.maxRawBodyBytes);
    if (rawBody instanceof Response) {
      return rawBody;
    }
    const contentType = parseContentType(request);
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
