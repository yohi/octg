import { env, SELF } from "cloudflare:test";
import type { PrepareMetadata } from "@octg/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

const PREPARE_BINDINGS = [
  "DENO_TOKENIZER_ENDPOINT",
  "DENO_TOKENIZER_AUTH_TOKEN",
  "DENO_TOKENIZER_THRESHOLD_BYTES",
  "DENO_TOKENIZER_TIMEOUT_MS",
  "DENO_PREPARE_ENDPOINT",
  "DENO_PREPARE_THRESHOLD_BYTES",
] as const;

const metadata: PrepareMetadata = {
  version: 1,
  model: "gpt-5",
  rawBodyBytes: 2048,
  inputBytes: 2000,
  inputTextBytes: 2000,
  opaqueInputBytes: 0,
  messageCount: 1,
  estimatedInputTokens: 17,
  estimationPath: "exact_bpe",
  maxOutputTokens: 64,
  stream: false,
  isToolUse: false,
  outputMarker: "octg_prepare_0123456789abcdef0123456789abcdef",
};

const originalBindings = new Map<string, PropertyDescriptor | undefined>();

function encodeBase64url(input: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(input)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function configurePrepare(): void {
  for (const name of PREPARE_BINDINGS) originalBindings.set(name, Object.getOwnPropertyDescriptor(env, name));
  Object.defineProperties(env, {
    DENO_TOKENIZER_ENDPOINT: { value: "https://deno.test/tokenize", configurable: true },
    DENO_TOKENIZER_AUTH_TOKEN: { value: "test-token", configurable: true },
    DENO_TOKENIZER_THRESHOLD_BYTES: { value: "1", configurable: true },
    DENO_TOKENIZER_TIMEOUT_MS: { value: "1000", configurable: true },
    DENO_PREPARE_ENDPOINT: { value: "https://deno.test/prepare", configurable: true },
    DENO_PREPARE_THRESHOLD_BYTES: { value: "1", configurable: true },
  });
}

function restorePrepare(): void {
  for (const name of PREPARE_BINDINGS) {
    const descriptor = originalBindings.get(name);
    if (descriptor === undefined) Reflect.deleteProperty(env, name);
    else Object.defineProperty(env, name, descriptor);
  }
  originalBindings.clear();
}

function disableTokenizerForLegacyRoute(): void {
  for (const name of PREPARE_BINDINGS.slice(0, 4)) Reflect.deleteProperty(env, name);
}

function responsesRequest(headers: HeadersInit = {}): Promise<Response> {
  return SELF.fetch("https://octg.test/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TEST_CLIENT_KEY}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ model: "gpt-5", input: "input is intentionally not parsed by the Worker", max_output_tokens: 9 }),
  });
}

function preparedResponse(body = JSON.stringify({ max_output_tokens: metadata.outputMarker })): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-octg-prepare-metadata": encodeBase64url(JSON.stringify(metadata)),
    },
  });
}

function preparedStreamResponse(
  preparedMetadata: PrepareMetadata,
  body: ReadableStream<Uint8Array>,
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-octg-prepare-metadata": encodeBase64url(JSON.stringify(preparedMetadata)),
    },
  });
}

function standardQuota() {
  const day = new Date().toISOString().slice(0, 10);
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
}

beforeEach(async () => {
  await seedClient();
  configurePrepare();
  vi.restoreAllMocks();
});

afterEach(() => {
  restorePrepare();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("prepare routing", () => {
  it("uses the resolved prepared body for a Responses request and settles the reservation", async () => {
    // Given: a prepare-enabled Responses request and a Deno result with validated metadata.
    const calls: string[] = [];
    const resourceInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const day = new Date().toISOString().slice(0, 10);
    const quota = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    const before = await quota.getState();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "https://deno.test/prepare") {
        calls.push("prepare");
        return preparedResponse();
      }
      calls.push("upstream");
      expect(await new Response(init?.body).text()).toContain("64");
      return new Response(JSON.stringify({ usage: { total_tokens: 21 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);

    // When: the request crosses the real Worker route.
    const response = await responsesRequest();

    // Then: prepare precedes the one upstream attempt and the proxy returns its settled response.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ usage: { total_tokens: 21 } });
    expect(calls).toEqual(["prepare", "upstream"]);
    const after = await quota.getState();
    expect(after.confirmedTokens - before.confirmedTokens).toBe(21);
    expect(after.reservedTokens).toBe(before.reservedTokens);
    const prepareFinishes = resourceInfo.mock.calls
      .map(([event]) => event)
      .filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null)
      .filter((event) => event.stage === "prepare" && event.phase === "finish");
    expect(prepareFinishes).toEqual([expect.objectContaining({
      outcome: "success",
      rawBodyBytes: metadata.rawBodyBytes,
      inputBytes: metadata.inputBytes,
      inputTextBytes: metadata.inputTextBytes,
      opaqueInputBytes: metadata.opaqueInputBytes,
      estimationPath: "exact_bpe",
      tokenizationProvider: "deno",
      quotaReserved: true,
      upstreamReached: false,
    })]);
  });

  it("maps a rejected prepare response without reserving or contacting upstream", async () => {
    // Given: Deno rejects the raw Responses body as non-text.
    const resourceInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("https://deno.test/prepare");
      return new Response(JSON.stringify({ code: "non_text" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);

    // When: the request is proxied.
    const response = await responsesRequest();

    // Then: the public validation error comes directly from prepare.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request", message: "Non-text input is not supported in the MVP." },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const prepareFinishes = resourceInfo.mock.calls
      .map(([event]) => event)
      .filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null)
      .filter((event) => event.stage === "prepare" && event.phase === "finish");
    expect(prepareFinishes).toEqual([expect.objectContaining({ outcome: "rejected" })]);
  });

  it("fails closed before dispatch when the Responses prepare configuration is incomplete", async () => {
    // Given: the shared tokenizer configuration is valid but the prepare pair is incomplete.
    Reflect.deleteProperty(env, "DENO_PREPARE_THRESHOLD_BYTES");
    const fetchImpl = vi.fn<typeof fetch>();
    const resourceInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchImpl);

    // When: a Responses request reaches the Worker.
    const response = await responsesRequest();

    // Then: configuration failure does not fall back to parsing, tokenization, or upstream.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    const resourceEvents = resourceInfo.mock.calls
      .map(([event]) => event)
      .filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null);
    expect(resourceEvents).toContainEqual(expect.objectContaining({
      stage: "prepare",
      phase: "finish",
      outcome: "exception",
    }));
    expect(resourceEvents).not.toContainEqual(expect.objectContaining({ stage: "body_read" }));
  });

  it("maps an unavailable prepare response to the internal error without upstream fallback", async () => {
    // Given: Deno cannot prepare the request.
    const resourceInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("https://deno.test/prepare");
      return new Response(null, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    // When: the request is proxied.
    const response = await responsesRequest();

    // Then: the proxy fails closed rather than using tokenization fallback.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const prepareFinishes = resourceInfo.mock.calls
      .map(([event]) => event)
      .filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null)
      .filter((event) => event.stage === "prepare" && event.phase === "finish");
    expect(prepareFinishes).toEqual([expect.objectContaining({ outcome: "exception" })]);
  });

  it("cancels a resolved body before returning a model rejection", async () => {
    let cancelCount = 0;
    const preparedBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCount += 1;
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("https://deno.test/prepare");
      return preparedStreamResponse({ ...metadata, model: "paid-only-model" }, preparedBody);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const response = await responsesRequest();

    expect(response.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cancelCount).toBe(1);
  });

  it("cancels a resolved body after tool-policy rejection without upstream contact", async () => {
    let cancelCount = 0;
    const preparedBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCount += 1;
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("https://deno.test/prepare");
      return preparedStreamResponse({ ...metadata, isToolUse: true }, preparedBody);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const response = await responsesRequest();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "model_not_allowed" } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cancelCount).toBe(1);
  });

  it("releases the resolved reservation when upstream configuration fails before transport", async () => {
    const originalToken = Object.getOwnPropertyDescriptor(env, "OCTG_UPSTREAM_API_TOKEN");
    let cancelCount = 0;
    const preparedBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCount += 1;
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("https://deno.test/prepare");
      return preparedStreamResponse(metadata, preparedBody);
    });
    vi.stubGlobal("fetch", fetchImpl);
    Object.defineProperty(env, "OCTG_UPSTREAM_API_TOKEN", { value: "", configurable: true });
    const quota = standardQuota();
    const before = await quota.getState();

    try {
      const response = await responsesRequest();

      expect(response.status).toBe(500);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(cancelCount).toBe(1);
      const after = await quota.getState();
      expect(after.reservedTokens).toBe(before.reservedTokens);
      expect(after.uncertainTokens).toBe(before.uncertainTokens);
    } finally {
      if (originalToken === undefined) Reflect.deleteProperty(env, "OCTG_UPSTREAM_API_TOKEN");
      else Object.defineProperty(env, "OCTG_UPSTREAM_API_TOKEN", originalToken);
    }
  });

  it("marks the reservation uncertain when the resolved body is missing its marker", async () => {
    const quota = standardQuota();
    const before = await quota.getState();
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === "https://deno.test/prepare") {
        calls.push("prepare");
        return preparedResponse(JSON.stringify({ max_output_tokens: 64 }));
      }
      calls.push("upstream");
      await new Response(init?.body).text();
      return new Response(JSON.stringify({ usage: { total_tokens: 21 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const response = await responsesRequest();

    expect(response.status).toBe(500);
    expect(calls).toEqual(["prepare", "upstream"]);
    const after = await quota.getState();
    expect(after.reservedTokens).toBe(before.reservedTokens);
    expect(after.uncertainTokens).toBeGreaterThan(before.uncertainTokens);
  });

  it("marks the reservation uncertain when the resolved body repeats its marker", async () => {
    const quota = standardQuota();
    const before = await quota.getState();
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === "https://deno.test/prepare") {
        calls.push("prepare");
        return preparedResponse(JSON.stringify({
          max_output_tokens: metadata.outputMarker,
          duplicate: metadata.outputMarker,
        }));
      }
      calls.push("upstream");
      await new Response(init?.body).text();
      return new Response(JSON.stringify({ usage: { total_tokens: 21 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const response = await responsesRequest();

    expect(response.status).toBe(500);
    expect(calls).toEqual(["prepare", "upstream"]);
    const after = await quota.getState();
    expect(after.reservedTokens).toBe(before.reservedTokens);
    expect(after.uncertainTokens).toBeGreaterThan(before.uncertainTokens);
  });

  it("marks the reservation uncertain when transport throws after it starts", async () => {
    const quota = standardQuota();
    const before = await quota.getState();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === "https://deno.test/prepare") return preparedResponse();
      throw new TypeError("upstream transport failed");
    });
    vi.stubGlobal("fetch", fetchImpl);

    const response = await responsesRequest();

    expect(response.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const after = await quota.getState();
    expect(after.reservedTokens).toBe(before.reservedTokens);
    expect(after.uncertainTokens).toBeGreaterThan(before.uncertainTokens);
  });

  it("uses the legacy Responses path below the prepare threshold", async () => {
    Object.defineProperty(env, "DENO_PREPARE_THRESHOLD_BYTES", { value: "10000", configurable: true });
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://deno.test/tokenize") {
        calls.push("tokenize");
        return new Response(JSON.stringify({ baseTokenCount: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      calls.push("upstream");
      return new Response(JSON.stringify({ usage: { total_tokens: 9 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const response = await responsesRequest();

    expect(response.status).toBe(200);
    expect(calls).toEqual(["tokenize", "upstream"]);
  });

  it("uses the legacy Responses path for a malformed declared content length", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://deno.test/tokenize") {
        calls.push("tokenize");
        return new Response(JSON.stringify({ baseTokenCount: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      calls.push("upstream");
      return new Response(JSON.stringify({ usage: { total_tokens: 9 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const response = await responsesRequest({ "content-length": "not-a-number" });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["tokenize", "upstream"]);
  });

  it("cancels a declared oversized Responses body before contacting Deno", async () => {
    const bodyCancel = vi.spyOn(ReadableStream.prototype, "cancel");
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    const response = await responsesRequest({ "content-length": "1048577" });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "request_too_large" } });
    expect(bodyCancel).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps Chat Completions on the legacy path when prepare is enabled", async () => {
    // Given: prepare is configured but the endpoint is Chat Completions.
    disableTokenizerForLegacyRoute();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).not.toBe("https://deno.test/prepare");
      return new Response(JSON.stringify({ usage: { total_tokens: 7 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);

    // When: Chat Completions is requested.
    const response = await SELF.fetch("https://octg.test/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_CLIENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hello" }] }),
    });

    // Then: its existing normalization and upstream behavior remains intact.
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
