export type DenoTokenizationFailure =
  | "timeout"
  | "network"
  | "upstream_status"
  | "malformed_response";

export type DenoTokenizationOutcome =
  | { readonly kind: "resolved"; readonly baseTokenCount: number }
  | {
      readonly kind: "unavailable";
      readonly failureCategory: DenoTokenizationFailure;
    };

const MAX_RESPONSE_BYTES = 1024;

export async function tokenizeWithDeno(args: {
  readonly endpoint: string;
  readonly authToken: string;
  readonly timeoutMs: number;
  readonly inputText: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<DenoTokenizationOutcome> {
  const fetcher = args.fetchImpl ?? fetch;
  const controller = new AbortController();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timedOut = false;
  let timeoutResolve: ((outcome: DenoTokenizationOutcome) => void) | undefined;
  let cancelPromise: Promise<void> | undefined;

  const timeoutPromise = new Promise<DenoTokenizationOutcome>((resolve) => {
    timeoutResolve = resolve;
  });

  const startCancel = (): Promise<void> => {
    if (cancelPromise === undefined) {
      cancelPromise = activeReader?.cancel().catch(() => undefined) ?? Promise.resolve();
    }
    return cancelPromise;
  };

  const settleTimeout = async (): Promise<void> => {
    timedOut = true;
    controller.abort();
    await startCancel();
    timeoutResolve?.({ kind: "unavailable", failureCategory: "timeout" });
  };

  timeoutHandle = setTimeout(() => {
    void settleTimeout();
  }, args.timeoutMs);

  const runPromise = (async (): Promise<DenoTokenizationOutcome> => {
    try {
      const response = await fetcher(args.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${args.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ inputText: args.inputText }),
        redirect: "error",
        signal: controller.signal,
      });

      if (timedOut) {
        await startCancel();
        await response.body?.cancel().catch(() => undefined);
        return { kind: "unavailable", failureCategory: "timeout" };
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "unavailable", failureCategory: "upstream_status" };
      }

      if (!isJsonContentType(response.headers.get("content-type"))) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "unavailable", failureCategory: "malformed_response" };
      }

      activeReader = response.body?.getReader();
      const readResult = await readBoundedJson(activeReader, MAX_RESPONSE_BYTES);
      if (timedOut) {
        await startCancel();
        return { kind: "unavailable", failureCategory: "timeout" };
      }
      if (!readResult.ok) {
        return { kind: "unavailable", failureCategory: "malformed_response" };
      }

      const baseTokenCount = parseBaseTokenCount(readResult.value);
      if (baseTokenCount === undefined) {
        return { kind: "unavailable", failureCategory: "malformed_response" };
      }

      return { kind: "resolved", baseTokenCount };
    } catch {
      if (timedOut || controller.signal.aborted) {
        await startCancel();
        return { kind: "unavailable", failureCategory: "timeout" };
      }
      return { kind: "unavailable", failureCategory: "network" };
    }
  })();

  const outcome = await Promise.race([runPromise, timeoutPromise]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  return outcome;
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const [mediaType] = value.split(";");
  if (mediaType === undefined) return false;
  return mediaType.trim().toLowerCase() === "application/json";
}

type BoundedReadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "malformed_response" };

async function readBoundedJson(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  maxBytes: number,
): Promise<BoundedReadResult> {
  if (reader === undefined) {
    return { ok: false, reason: "malformed_response" };
  }

  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "malformed_response" };
      }
      chunks.push(chunk.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "malformed_response" };
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, reason: "malformed_response" };
  }
}

function parseBaseTokenCount(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "baseTokenCount") {
    return undefined;
  }
  const baseTokenCount = record.baseTokenCount;
  if (
    typeof baseTokenCount !== "number" ||
    !Number.isSafeInteger(baseTokenCount) ||
    baseTokenCount < 0
  ) {
    return undefined;
  }
  return baseTokenCount;
}
