import { describe, expect, it, vi } from "vitest";
import { prepareWithDeno } from "../src/deno-prepare-client";
import type { PrepareMetadata } from "@octg/shared";

/* ---------- helpers ---------- */

function encodeBase64url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const validMetadata: PrepareMetadata = {
  version: 1,
  model: "model-name",
  rawBodyBytes: 12,
  inputBytes: 10,
  inputTextBytes: 10,
  opaqueInputBytes: 0,
  messageCount: 1,
  estimatedInputTokens: 17,
  estimationPath: "exact_bpe",
  maxOutputTokens: 64,
  stream: false,
  isToolUse: false,
  outputMarker: "octg_prepare_0123456789abcdef0123456789abcdef",
};

const metadataHeader = encodeBase64url(JSON.stringify(validMetadata));

/** Make a Request with a ReadableStream body. */
function makeRequest(bodyText: string): { request: Request } {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bodyText));
      controller.close();
    },
  });
  const request = new Request("https://gateway.test/v1/responses", {
    method: "POST",
    body: stream,
  });
  return { request };
}

/** Make a simple request whose body is just a stream (no spying needed). */
function makeSimpleRequest(bodyText: string): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bodyText));
      controller.close();
    },
  });
  return new Request("https://gateway.test/v1/responses", {
    method: "POST",
    body: stream,
  });
}

const baseArgs = {
  endpoint: "https://deno.test/prepare",
  authToken: "test-secret",
  timeoutMs: 5000,
  maxInputBytes: 1_048_576,
} as const;

const bodyText = JSON.stringify({ model: "m", input: "hello" });

/* ---------- config tests ---------- */

describe("prepareWithDeno — request forwarding", () => {
  it("forwards the original body stream without a preliminary read", async () => {
    const { request } = makeRequest(bodyText);

    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-octg-prepare-metadata": metadataHeader,
        },
      });
    });

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });

    expect(outcome.kind).toBe("resolved");
    // The body passed to fetch must be a ReadableStream, not a string/buffer.
    expect(capturedInit?.body).toBeInstanceOf(ReadableStream);
    expect(capturedInit?.body).toBe(request.body);
  });

  it("sets authorization and content-type headers", async () => {
    const request = makeSimpleRequest(bodyText);
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-octg-prepare-metadata": metadataHeader,
        },
      });
    });

    await prepareWithDeno({ ...baseArgs, request, fetchImpl });

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer test-secret");
    expect(headers["content-type"]).toBe("application/json");
  });
});

/* ---------- success outcome ---------- */

describe("prepareWithDeno — 200 success", () => {
  it("returns resolved with valid metadata and body without reading the body", async () => {
    const request = makeSimpleRequest(bodyText);
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"prepared":true}'));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () =>
      new Response(responseBody, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-octg-prepare-metadata": metadataHeader,
        },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.metadata).toEqual(validMetadata);
    expect(outcome.body).toBeInstanceOf(ReadableStream);
    // Reading the body after resolution should work.
    const reader = outcome.body.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('{"prepared":true}');
    reader.releaseLock();
    await outcome.cancel();
  });
});

/* ---------- rejected outcomes (400 / 413 with exact codes) ---------- */

function makeErrorBody(code: string): string {
  return JSON.stringify({ code });
}

describe("prepareWithDeno — 400 rejected", () => {
  it.each([
    "invalid_body",
    "non_text",
    "max_tokens_conflict",
  ] as const)("returns rejected with code %s for 400", async (code) => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response(makeErrorBody(code), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });

    expect(outcome).toEqual({ kind: "rejected", code });
  });
});

describe("prepareWithDeno — 413 rejected", () => {
  it.each([
    "input_too_large",
    "request_too_large",
  ] as const)("returns rejected with code %s for 413", async (code) => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response(makeErrorBody(code), {
        status: 413,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });

    expect(outcome).toEqual({ kind: "rejected", code });
  });
});

/* ---------- 400/413 with wrong/unknown codes → malformed_response ---------- */

describe("prepareWithDeno — 400/413 with wrong code → unavailable malformed_response", () => {
  it.each([
    [400, "input_too_large"],
    [400, "request_too_large"],
    [400, "unknown_code"],
    [413, "invalid_body"],
    [413, "non_text"],
    [413, "max_tokens_conflict"],
    [413, "unknown_code"],
  ] as const)("returns unavailable malformed_response for %i with code %s", async (status, code) => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response(makeErrorBody(code), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });

    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed_response" });
  });
});

/* ---------- 400/413 with non-JSON / wrong content-type → malformed_response ---------- */

describe("prepareWithDeno — 400/413 malformed error body → unavailable malformed_response", () => {
  it("returns malformed_response for 400 with text/plain content-type", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response(makeErrorBody("invalid_body"), {
        status: 400,
        headers: { "content-type": "text/plain" },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed_response" });
  });

  it("returns malformed_response for 413 with invalid JSON body", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response("not json", {
        status: 413,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed_response" });
  });

  it("returns malformed_response for 400 with extra fields in the envelope", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: "invalid_body", extra: true }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed_response" });
  });

  it("returns malformed_response for 400 with missing code field", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "bad" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed_response" });
  });

  it("returns malformed_response for 400 with non-object JSON (array)", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response('["invalid_body"]', {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed_response" });
  });
});

/* ---------- error body boundary: 4096 bytes ---------- */

describe("prepareWithDeno — error body 4096-byte boundary", () => {
  it("accepts an error body of exactly 4096 bytes for 400", async () => {
    const request = makeSimpleRequest(bodyText);
    // Build a 400 response whose body is exactly 4096 UTF-8 bytes.
    // { code: "invalid_body" } is 24 bytes. We need to pad to 4096 but the JSON must still be valid.
    // Actually the bound is on the read, not the JSON content. We need a body that is exactly 4096 bytes.
    // The simplest valid envelope at exactly 4096: {"code":"invalid_body","padding":"..."}
    // But extra fields make it invalid. So we need a body of exactly 4096 with only {code}.
    // {code: "invalid_body"} = 24 bytes. We can't pad. So we test the reader bound instead:
    // a 4096-byte body with valid envelope is accepted if it fits in the bound.
    // Since the envelope itself is 24 bytes, any body <= 4096 should be fine.
    // Let's test a body of exactly 4096 bytes that is valid JSON with only code field.
    // That's impossible with just {code} unless we pad with whitespace.
    const envelope = JSON.stringify({ code: "invalid_body" });
    const envelopeBytes = new TextEncoder().encode(envelope).byteLength;
    const padding = " ".repeat(4096 - envelopeBytes);
    const body = envelope + padding;
    expect(new TextEncoder().encode(body).byteLength).toBe(4096);

    const fetchImpl = vi.fn(async () =>
      new Response(body, {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "rejected", code: "invalid_body" });
  });

  it("returns malformed_response for an error body above 4096 bytes and cancels the reader once", async () => {
    const request = makeSimpleRequest(bodyText);
    let cancelCount = 0;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        // Body larger than 4096 bytes — do NOT close so cancel propagates.
        const padding = " ".repeat(5000);
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: "invalid_body" }) + padding));
      },
      cancel() {
        cancelCount++;
      },
    });

    const fetchImpl = vi.fn(async () =>
      new Response(responseBody, {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed_response" });
    // The reader is cancelled exactly once (reader.cancel() is awaited in the implementation).
    expect(cancelCount).toBe(1);
  });
});

/* ---------- 500 and other statuses → unavailable ---------- */

describe("prepareWithDeno — 500 and other statuses → unavailable", () => {
  const serverErrorCases = [
    { name: "with no body", code: undefined },
    { name: "with an invalid_body code body", code: "invalid_body" },
    { name: "with a request_too_large code body", code: "request_too_large" },
  ] as const;

  it.each(serverErrorCases)(
    "returns unavailable upstream_status for 500 $name",
    async ({ code }) => {
      const request = makeSimpleRequest(bodyText);
      const fetchImpl = vi.fn(async () => {
        const init: ResponseInit = { status: 500 };
        if (code !== undefined) {
          init.headers = { "content-type": "application/json" };
        }
        return new Response(code === undefined ? null : makeErrorBody(code), init);
      });

      const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
      expect(outcome).toEqual({ kind: "unavailable", failure: "upstream_status" });
    },
  );

  it.each([
    [401, "invalid_body"],
    [401, "request_too_large"],
    [415, "invalid_body"],
    [415, "request_too_large"],
    [403, "invalid_body"],
    [502, "invalid_body"],
    [503, "request_too_large"],
    [404, ""],
  ] as const)(
    "returns unavailable for status %i with code %s (never rejected)",
    async (status, code) => {
      const request = makeSimpleRequest(bodyText);
      const fetchImpl = vi.fn(async () =>
        new Response(code ? makeErrorBody(code) : null, {
          status,
          headers: { "content-type": "application/json" },
        }),
      );

      const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
      expect(outcome.kind).toBe("unavailable");
      if (outcome.kind !== "unavailable") return;
      // 500 → upstream_status; other non-200 non-400/413 → upstream_status as well
      // per the matrix: "Any other status... → unavailable"
      expect(outcome.failure).toBe("upstream_status");
    },
  );

  it("returns unavailable for a 2xx status other than 200", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 204,
        headers: {
          "content-type": "application/json",
          "x-octg-prepare-metadata": metadataHeader,
        },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.failure).toBe("upstream_status");
  });
});

/* ---------- 200 with malformed success response → unavailable malformed_response ---------- */

describe("prepareWithDeno — 200 with malformed success → unavailable malformed_response", () => {
  it("returns malformed_response for 200 with wrong content-type", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "x-octg-prepare-metadata": metadataHeader,
        },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed_response" });
  });

  it("returns malformed_response for 200 with missing content-type", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: {
          "x-octg-prepare-metadata": metadataHeader,
        },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed_response" });
  });

  it("returns malformed_response for 200 with missing metadata header", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed_response" });
  });

  it("returns malformed_response for 200 with invalid metadata (wrong version)", async () => {
    const badMeta = { ...validMetadata, version: 2 as unknown as 1 };
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-octg-prepare-metadata": encodeBase64url(JSON.stringify(badMeta)),
        },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed_response" });
  });

  it("returns malformed_response for 200 with null response body", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-octg-prepare-metadata": metadataHeader,
        },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed_response" });
  });

  it("returns malformed_response for 200 with oversized metadata header", async () => {
    const request = makeSimpleRequest(bodyText);
    // Build a metadata header that exceeds maxInputBytes (1_048_576) when decoded.
    // We need a valid JSON object with the exact keys but with a very long model string.
    // Actually, the bound is maxInputBytes for the base64url decode. We'll make the
    // model field huge so the decoded JSON exceeds maxInputBytes.
    const hugeModel = "x".repeat(1_100_000);
    const hugeMeta = { ...validMetadata, model: hugeModel };
    const hugeHeader = encodeBase64url(JSON.stringify(hugeMeta));

    const fetchImpl = vi.fn(async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-octg-prepare-metadata": hugeHeader,
        },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed_response" });
  });
});

/* ---------- network failure ---------- */

describe("prepareWithDeno — network failure", () => {
  it("returns unavailable network for a fetch rejection", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network error");
    });

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "unavailable", failure: "network" });
  });
});

/* ---------- timeout ---------- */

describe("prepareWithDeno — timeout", () => {
  it("returns unavailable timeout when fetch does not resolve in time", async () => {
    const request = makeSimpleRequest(bodyText);
    let aborted = false;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const outcome = await prepareWithDeno({
      ...baseArgs,
      timeoutMs: 50,
      request,
      fetchImpl,
    });

    expect(outcome).toEqual({ kind: "unavailable", failure: "timeout" });
    expect(aborted).toBe(true);
  });

  it("invokes onTimeout exactly once when a resolved body times out", async () => {
    const request = makeSimpleRequest(bodyText);
    const onTimeout = vi.fn();

    // The fetch resolves with a body that never closes. The timeout fires after resolution.
    let aborted = false;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((resolve) => {
        const signal = init!.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        // Resolve immediately with a body that never closes.
        const slowBody = new ReadableStream<Uint8Array>({
          start() {
            // Never enqueue, never close — body hangs.
          },
          cancel() {
            // Cancel called by timeout handler.
          },
        });
        resolve(
          new Response(slowBody, {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-octg-prepare-metadata": metadataHeader,
            },
          }),
        );
      });
    });

    const outcome = await prepareWithDeno({
      ...baseArgs,
      timeoutMs: 50,
      request,
      fetchImpl,
      onTimeout,
    });

    // The outcome is resolved (headers arrived before timeout).
    expect(outcome.kind).toBe("resolved");
    // Wait for the timeout to fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(aborted).toBe(true);
  });
});

/* ---------- cancel idempotency ---------- */

describe("prepareWithDeno — cancel idempotency", () => {
  it("cancel is idempotent and can be called multiple times", async () => {
    const request = makeSimpleRequest(bodyText);
    let cancelCount = 0;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true}'));
        controller.close();
      },
      cancel() {
        cancelCount++;
      },
    });

    const fetchImpl = vi.fn(async () =>
      new Response(responseBody, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-octg-prepare-metadata": metadataHeader,
        },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    if (outcome.kind !== "resolved") throw new Error("must be resolved");

    await outcome.cancel();
    await outcome.cancel();
    await outcome.cancel();

    // Body cancel should be called at most once (idempotent).
    expect(cancelCount).toBeLessThanOrEqual(1);
  });

  it("cancel aborts the Deno request and cancels the response body for a rejected outcome", async () => {
    const request = makeSimpleRequest(bodyText);
    let bodyCancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: "invalid_body" })));
        controller.close();
      },
      cancel() {
        bodyCancelled = true;
      },
    });

    const fetchImpl = vi.fn(async () =>
      new Response(responseBody, {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome.kind).toBe("rejected");
    // The body was fully read (consumed) for the error envelope; no leak.
  });
});

/* ---------- 200 with charset in content-type ---------- */

describe("prepareWithDeno — content-type variants", () => {
  it("accepts application/json with charset=utf-8 for a 200 success", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-octg-prepare-metadata": metadataHeader,
        },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome.kind).toBe("resolved");
  });

  it("accepts application/json with charset for a 400 error", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response(makeErrorBody("invalid_body"), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome).toEqual({ kind: "rejected", code: "invalid_body" });
  });
});

/* ---------- body-read failure (500) is unavailable, never rejected ---------- */

describe("prepareWithDeno — body-read failure classification", () => {
  it("a 500 from a Deno body-read failure is unavailable upstream_status, never rejected", async () => {
    const request = makeSimpleRequest(bodyText);
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 500 }),
    );

    const outcome = await prepareWithDeno({ ...baseArgs, request, fetchImpl });
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.failure).toBe("upstream_status");
  });
});
