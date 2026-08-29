import { describe, expect, it, vi } from "vitest";
import { tokenizeWithDeno, type DenoTokenizationOutcome } from "../src/deno-tokenizer-client";

const endpoint = "https://tokenizer.example/v1/tokenize";
const authToken = "test-secret";
const inputText = "hello";

const expectOutcome = async (
  promise: Promise<DenoTokenizationOutcome>,
  expected: DenoTokenizationOutcome,
): Promise<void> => {
  await expect(promise).resolves.toEqual(expected);
};

describe("tokenizeWithDeno", () => {
  it("sends only authorization, content-type, and the inputText body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ baseTokenCount: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await tokenizeWithDeno({ endpoint, authToken, timeoutMs: 1000, inputText, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as [RequestInfo | URL, RequestInit | undefined];
    const requestUrl = typeof call[0] === "string" ? call[0] : (call[0] as Request).url;
    expect(requestUrl).toBe(endpoint);
    const requestInit = call[1] as RequestInit;
    expect(requestInit.method).toBe("POST");
    const headers = new Headers(requestInit.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${authToken}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(requestInit.body).toBe(JSON.stringify({ inputText }));
    expect(headers.get("x-request-id")).toBeNull();
    expect(headers.get("x-quota-state")).toBeNull();
    expect(headers.get("x-policy")).toBeNull();
    expect(headers.get("x-openai-key")).toBeNull();
    expect(headers.get("x-client-key")).toBeNull();
  });

  it("resolves the exact base token count on success", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ baseTokenCount: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expectOutcome(
      tokenizeWithDeno({ endpoint, authToken, timeoutMs: 1000, inputText, fetchImpl }),
      { kind: "resolved", baseTokenCount: 7 },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports network failure on fetch rejection", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });

    await expectOutcome(
      tokenizeWithDeno({ endpoint, authToken, timeoutMs: 1000, inputText, fetchImpl }),
      { kind: "unavailable", failureCategory: "network" },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports upstream_status on non-2xx", async () => {
    let cancelled = false;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 500 }),
    );

    await expectOutcome(
      tokenizeWithDeno({ endpoint, authToken, timeoutMs: 1000, inputText, fetchImpl }),
      { kind: "unavailable", failureCategory: "upstream_status" },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
  });

  it("reports malformed_response on wrong content type", async () => {
    let cancelled = false;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    await expectOutcome(
      tokenizeWithDeno({ endpoint, authToken, timeoutMs: 1000, inputText, fetchImpl }),
      { kind: "unavailable", failureCategory: "malformed_response" },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
  });

  it("reports malformed_response on invalid JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expectOutcome(
      tokenizeWithDeno({ endpoint, authToken, timeoutMs: 1000, inputText, fetchImpl }),
      { kind: "unavailable", failureCategory: "malformed_response" },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports malformed_response when the response has extra fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ baseTokenCount: 7, extra: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expectOutcome(
      tokenizeWithDeno({ endpoint, authToken, timeoutMs: 1000, inputText, fetchImpl }),
      { kind: "unavailable", failureCategory: "malformed_response" },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports malformed_response when the response is missing baseTokenCount", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expectOutcome(
      tokenizeWithDeno({ endpoint, authToken, timeoutMs: 1000, inputText, fetchImpl }),
      { kind: "unavailable", failureCategory: "malformed_response" },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ] as const)("reports malformed_response on %s baseTokenCount", async (_name, baseTokenCount) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ baseTokenCount }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expectOutcome(
      tokenizeWithDeno({ endpoint, authToken, timeoutMs: 1000, inputText, fetchImpl }),
      { kind: "unavailable", failureCategory: "malformed_response" },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports malformed_response when the response body exceeds 1 KiB", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ baseTokenCount: 7, padding: "x".repeat(2048) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expectOutcome(
      tokenizeWithDeno({ endpoint, authToken, timeoutMs: 1000, inputText, fetchImpl }),
      { kind: "unavailable", failureCategory: "malformed_response" },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("times out a stalled 200 body and cancels the reader", async () => {
    vi.useFakeTimers();
    let resolveReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      resolveReadStarted = resolve;
    });
    let resolveBodyProcessingFinished!: () => void;
    const bodyProcessingFinished = new Promise<void>((resolve) => {
      resolveBodyProcessingFinished = resolve;
    });
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        resolveReadStarted();
        return new Promise<never>(() => {});
      },
      cancel() {
        cancelled = true;
        resolveBodyProcessingFinished();
      },
    });

    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(stalled, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcomePromise = tokenizeWithDeno({
      endpoint,
      authToken,
      timeoutMs: 50,
      inputText,
      fetchImpl,
    });

    await readStarted;
    await vi.advanceTimersByTimeAsync(60);
    await expect(outcomePromise).resolves.toEqual({
      kind: "unavailable",
      failureCategory: "timeout",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
    await expect(bodyProcessingFinished).resolves.toBeUndefined();

    vi.useRealTimers();
  });

  it("cancels the response body when timeout wins before headers are processed", async () => {
    vi.useFakeTimers();
    let resolveFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(() => {
      resolveFetchStarted?.();
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });
    const outcomePromise = tokenizeWithDeno({
      endpoint,
      authToken,
      timeoutMs: 50,
      inputText,
      fetchImpl,
    });

    await fetchStarted;
    await vi.advanceTimersByTimeAsync(60);
    await expect(outcomePromise).resolves.toEqual({
      kind: "unavailable",
      failureCategory: "timeout",
    });

    let cancelled = false;
    let resolveCancelled: (() => void) | undefined;
    const bodyCancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    const response = new Response(new ReadableStream({
      cancel() {
        cancelled = true;
        resolveCancelled?.();
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    resolveFetch?.(response);
    await bodyCancelled;
    expect(cancelled).toBe(true);

    vi.useRealTimers();
  });

  it("waits for a slow cancel before returning timeout", async () => {
    vi.useFakeTimers();
    let resolveReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      resolveReadStarted = resolve;
    });
    let resolveCancelFinished!: () => void;
    const cancelFinished = new Promise<void>((resolve) => {
      resolveCancelFinished = resolve;
    });
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        resolveReadStarted();
        return new Promise<never>(() => {});
      },
      cancel() {
        cancelled = true;
        return cancelFinished;
      },
    });

    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(stalled, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcomePromise = tokenizeWithDeno({
      endpoint,
      authToken,
      timeoutMs: 50,
      inputText,
      fetchImpl,
    });

    await readStarted;
    await vi.advanceTimersByTimeAsync(60);
    expect(cancelled).toBe(true);

    // The outcome must not resolve before the slow cancel finishes.
    let outcomeResolved = false;
    outcomePromise.then(() => {
      outcomeResolved = true;
    });
    await Promise.resolve();
    expect(outcomeResolved).toBe(false);

    resolveCancelFinished();
    await expect(outcomePromise).resolves.toEqual({
      kind: "unavailable",
      failureCategory: "timeout",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
