export interface ReadJsonBodyMetrics {
  readonly rawBodyBytes: number;
  readonly rawBodyBytesSource: "measured" | "declared_content_length" | "measured_partial";
  readonly declaredContentLength: number | null;
  readonly measuredRawBodyBytes: number | null;
  readonly truncated: boolean;
  readonly bodyReadMs: number;
  readonly parseMs: number;
}

export type ReadJsonBodyResult =
  | { readonly ok: true; readonly body: unknown; readonly metrics: ReadJsonBodyMetrics }
  | {
      readonly ok: false;
      readonly reason: "invalid_json" | "too_large";
      readonly metrics: ReadJsonBodyMetrics;
    };

function elapsedSince(start: number): number {
  return Math.max(0, performance.now() - start);
}

function declaredContentLengthOf(request: Pick<Request, "headers" | "body">): number | null {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function readJsonBody(
  request: Pick<Request, "headers" | "body">,
  maxBytes: number,
): Promise<ReadJsonBodyResult> {
  const declaredContentLength = declaredContentLengthOf(request);
  if (declaredContentLength !== null && declaredContentLength > maxBytes) {
    return {
      ok: false,
      reason: "too_large",
      metrics: {
        rawBodyBytes: declaredContentLength,
        rawBodyBytesSource: "declared_content_length",
        declaredContentLength,
        measuredRawBodyBytes: null,
        truncated: true,
        bodyReadMs: 0,
        parseMs: 0,
      },
    };
  }

  if (!request.body) {
    return {
      ok: false,
      reason: "invalid_json",
      metrics: {
        rawBodyBytes: 0,
        rawBodyBytesSource: "measured",
        declaredContentLength,
        measuredRawBodyBytes: 0,
        truncated: false,
        bodyReadMs: 0,
        parseMs: 0,
      },
    };
  }

  const bodyReadStartedAt = performance.now();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return {
        ok: false,
        reason: "too_large",
        metrics: {
          rawBodyBytes: length,
          rawBodyBytesSource: "measured_partial",
          declaredContentLength,
          measuredRawBodyBytes: length,
          truncated: true,
          bodyReadMs: elapsedSince(bodyReadStartedAt),
          parseMs: 0,
        },
      };
    }
    chunks.push(chunk.value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const bodyReadMs = elapsedSince(bodyReadStartedAt);
  const parseStartedAt = performance.now();
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return {
      ok: true,
      body,
      metrics: {
        rawBodyBytes: length,
        rawBodyBytesSource: "measured",
        declaredContentLength,
        measuredRawBodyBytes: length,
        truncated: false,
        bodyReadMs,
        parseMs: elapsedSince(parseStartedAt),
      },
    };
  } catch {
    return {
      ok: false,
      reason: "invalid_json",
      metrics: {
        rawBodyBytes: length,
        rawBodyBytesSource: "measured",
        declaredContentLength,
        measuredRawBodyBytes: length,
        truncated: false,
        bodyReadMs,
        parseMs: elapsedSince(parseStartedAt),
      },
    };
  }
}
