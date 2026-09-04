import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenizerNamespace } from "../src/tokenizer";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

const originalTokenizerBinding = Object.getOwnPropertyDescriptor(env, "TOKENIZER_CONTROLLER");
const originalDenoEndpoint = Object.getOwnPropertyDescriptor(env, "DENO_TOKENIZER_ENDPOINT");
const originalDenoAuthToken = Object.getOwnPropertyDescriptor(env, "DENO_TOKENIZER_AUTH_TOKEN");
const originalDenoThreshold = Object.getOwnPropertyDescriptor(env, "DENO_TOKENIZER_THRESHOLD_BYTES");
const originalDenoTimeout = Object.getOwnPropertyDescriptor(env, "DENO_TOKENIZER_TIMEOUT_MS");
const denoTokenizerUrl = "https://tokenizer.example/v1/tokenize";
const denoAuthToken = "deno-secret";

function restoreEnvProperty(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(env, name, descriptor);
  } else {
    Reflect.deleteProperty(env, name);
  }
}

function installTokenizer() {
  let tokenizeCalls = 0;
  const namespace: TokenizerNamespace<string> = {
    idFromName(name) {
      return name;
    },
    get(id) {
      return {
        tokenize(input) {
          tokenizeCalls += 1;
          return Promise.resolve({
            estimatedInputTokens: input.opaqueInputBytes + 7,
            estimationPath: "conservative_bytes",
          });
        },
      };
    },
  };
  Object.defineProperty(env, "TOKENIZER_CONTROLLER", { value: namespace, configurable: true });
  return () => tokenizeCalls;
}

function setDenoConfig(values: {
  endpoint?: string;
  authToken?: string;
  thresholdBytes?: string;
  timeoutMs?: string;
}) {
  Object.defineProperty(env, "DENO_TOKENIZER_ENDPOINT", {
    value: values.endpoint,
    configurable: true,
  });
  Object.defineProperty(env, "DENO_TOKENIZER_AUTH_TOKEN", {
    value: values.authToken,
    configurable: true,
  });
  Object.defineProperty(env, "DENO_TOKENIZER_THRESHOLD_BYTES", {
    value: values.thresholdBytes,
    configurable: true,
  });
  Object.defineProperty(env, "DENO_TOKENIZER_TIMEOUT_MS", {
    value: values.timeoutMs,
    configurable: true,
  });
}

function clearDenoConfig() {
  Reflect.deleteProperty(env, "DENO_TOKENIZER_ENDPOINT");
  Reflect.deleteProperty(env, "DENO_TOKENIZER_AUTH_TOKEN");
  Reflect.deleteProperty(env, "DENO_TOKENIZER_THRESHOLD_BYTES");
  Reflect.deleteProperty(env, "DENO_TOKENIZER_TIMEOUT_MS");
}

type DenoFailure =
  | { readonly kind: "timeout" }
  | { readonly kind: "network"; readonly error?: Error }
  | { readonly kind: "upstream_status"; readonly status: number }
  | { readonly kind: "malformed_response"; readonly body: string; readonly contentType?: string }
  | { readonly kind: "arithmetic" };

function stubFetch(options: {
  readonly onDenoRequest?: () => void;
  readonly onUpstreamRequest?: () => void;
  readonly upstreamTotalTokens?: number;
  readonly denoFailure?: DenoFailure;
}) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === denoTokenizerUrl) {
      options.onDenoRequest?.();
      if (options.denoFailure !== undefined) {
        const failure = options.denoFailure;
        switch (failure.kind) {
          case "timeout":
            return new Promise<never>((_, reject) => {
              setTimeout(() => reject(new DOMException("The operation was aborted.", "AbortError")), 10_000);
            });
          case "network":
            throw failure.error ?? new TypeError("fetch failed");
          case "upstream_status":
            return new Response("unavailable", {
              status: failure.status,
              headers: { "content-type": "text/plain" },
            });
          case "malformed_response":
            return new Response(failure.body, {
              status: 200,
              headers: { "content-type": failure.contentType ?? "application/json" },
            });
          case "arithmetic":
            // MAX_SAFE_INTEGER is accepted by parseBaseTokenCount but overflows estimatedInputTokensOf.
            return new Response(JSON.stringify({ baseTokenCount: Number.MAX_SAFE_INTEGER }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          default:
            throw new Error("unexpected deno failure kind");
        }
      }
      return new Response(JSON.stringify({ baseTokenCount: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    options.onUpstreamRequest?.();
    return new Response(JSON.stringify({ usage: { total_tokens: options.upstreamTotalTokens ?? 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("Deno tokenizer routing", () => {
  beforeEach(async () => {
    await seedClient();
    clearDenoConfig();
  });

  afterEach(() => {
    if (originalTokenizerBinding) {
      Object.defineProperty(env, "TOKENIZER_CONTROLLER", originalTokenizerBinding);
    } else {
      Reflect.deleteProperty(env, "TOKENIZER_CONTROLLER");
    }
    restoreEnvProperty("DENO_TOKENIZER_ENDPOINT", originalDenoEndpoint);
    restoreEnvProperty("DENO_TOKENIZER_AUTH_TOKEN", originalDenoAuthToken);
    restoreEnvProperty("DENO_TOKENIZER_THRESHOLD_BYTES", originalDenoThreshold);
    restoreEnvProperty("DENO_TOKENIZER_TIMEOUT_MS", originalDenoTimeout);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["chat", "aa", 3, 1, 0],
    ["responses", "aa", 3, 1, 0],
    ["chat", "a", 1, 0, 1],
    ["responses", "a", 1, 0, 1],
  ] as const)(
    "routes %s input '%s' at threshold %i: do=%i, deno=%i",
    async (endpoint, content, threshold, expectedDoCalls, expectedDenoCalls) => {
      const doCalls = installTokenizer();
      let denoCalls = 0;
      stubFetch({ onDenoRequest: () => { denoCalls += 1; } });
      setDenoConfig({
        endpoint: denoTokenizerUrl,
        authToken: denoAuthToken,
        thresholdBytes: String(threshold),
        timeoutMs: "1000",
      });

      const url = endpoint === "chat" ? "v1/chat/completions" : "v1/responses";
      const body =
        endpoint === "chat"
          ? { model: "gpt-5", messages: [{ role: "user", content }], max_completion_tokens: 1 }
          : { model: "gpt-5", input: [{ role: "user", content }], max_output_tokens: 1 };

      const response = await SELF.fetch(`https://octg.test/${url}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(200);
      expect(doCalls()).toBe(expectedDoCalls);
      expect(denoCalls).toBe(expectedDenoCalls);
    },
  );

  it("uses exact BPE estimate from Deno result", async () => {
    const doCalls = installTokenizer();
    let denoCallCount = 0;
    stubFetch({
      onDenoRequest: () => { denoCallCount += 1; },
      upstreamTotalTokens: 5,
    });
    setDenoConfig({
      endpoint: denoTokenizerUrl,
      authToken: denoAuthToken,
      thresholdBytes: "1",
      timeoutMs: "1000",
    });

    const response = await SELF.fetch("https://octg.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: 1,
      }),
    });

    expect(response.status).toBe(200);
    expect(denoCallCount).toBe(1);
    expect(doCalls()).toBe(0);
  });

  it("keeps DO path when Deno config is disabled", async () => {
    const doCalls = installTokenizer();
    let denoCalls = 0;
    stubFetch({ onDenoRequest: () => { denoCalls += 1; } });
    clearDenoConfig();

    const response = await SELF.fetch("https://octg.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: 1,
      }),
    });

    expect(response.status).toBe(200);
    expect(doCalls()).toBe(1);
    expect(denoCalls).toBe(0);
  });

  it("fails authenticated requests for invalid Deno config and emits a configuration resource stage event", async () => {
    installTokenizer();
    let denoCalls = 0;
    let upstreamCalls = 0;
    stubFetch({
      onDenoRequest: () => { denoCalls += 1; },
      onUpstreamRequest: () => { upstreamCalls += 1; },
    });
    setDenoConfig({
      endpoint: denoTokenizerUrl,
      authToken: denoAuthToken,
      // missing timeout and threshold => invalid
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await SELF.fetch("https://octg.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: 1,
      }),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "internal_error" } });
    expect(denoCalls).toBe(0);
    expect(upstreamCalls).toBe(0);
    const quotaStub = env.QUOTA_CONTROLLER.get(
      env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${new Date().toISOString().slice(0, 10)}`),
    );
    const state = await quotaStub.getState();
    const stageEvents = info.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => typeof arg === "object" && arg !== null && arg.event === "octg.resource_stage");
    expect(stageEvents).toHaveLength(2);
    const startEvents = stageEvents.filter((arg) => arg.phase === "start");
    const finishEvents = stageEvents.filter((arg) => arg.phase === "finish");
    expect(startEvents).toHaveLength(1);
    expect(finishEvents).toHaveLength(1);
    expect(startEvents[0]).toMatchObject({
      stage: "tokenize",
      phase: "start",
    });
    const finishEvent = finishEvents[0];
    expect(finishEvent).toMatchObject({
      stage: "tokenize",
      phase: "finish",
      outcome: "exception",
      route: "error:tokenizer_unavailable",
      tokenizationProvider: "deno",
      tokenizationFailureCategory: "configuration",
      quotaReserved: false,
      upstreamReached: false,
    });
    expect(finishEvent).not.toHaveProperty("inputBytes");
    expect(finishEvent).not.toHaveProperty("inputTextBytes");
    expect(finishEvent).not.toHaveProperty("opaqueInputBytes");

    // Keep `state` in scope for consistency with the failure-matrix tests below.
    expect(state).toBeDefined();
  });

  it("fails authenticated requests when only DENO_TOKENIZER_AUTH_TOKEN is present (residual secret)", async () => {
    installTokenizer();
    let denoCalls = 0;
    let upstreamCalls = 0;
    stubFetch({
      onDenoRequest: () => { denoCalls += 1; },
      onUpstreamRequest: () => { upstreamCalls += 1; },
    });
    setDenoConfig({
      authToken: denoAuthToken,
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await SELF.fetch("https://octg.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: 1,
      }),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "internal_error" } });
    expect(denoCalls).toBe(0);
    expect(upstreamCalls).toBe(0);

    const stageEvents = info.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => typeof arg === "object" && arg !== null && arg.event === "octg.resource_stage");
    const finishEvents = stageEvents.filter((arg) => arg.phase === "finish" && arg.stage === "tokenize");
    expect(finishEvents).toHaveLength(1);
    expect(finishEvents[0]).toMatchObject({
      stage: "tokenize",
      phase: "finish",
      outcome: "exception",
      route: "error:tokenizer_unavailable",
      tokenizationProvider: "deno",
      tokenizationFailureCategory: "configuration",
      quotaReserved: false,
      upstreamReached: false,
    });
  });

  it.each([
    ["timeout", { kind: "timeout" } as const, "timeout"],
    ["network", { kind: "network" } as const, "network"],
    ["upstream_status", { kind: "upstream_status", status: 503 } as const, "upstream_status"],
    ["malformed_response", { kind: "malformed_response", body: "not json" } as const, "malformed_response"],
    ["arithmetic", { kind: "arithmetic" } as const, "arithmetic"],
  ] as const)(
    "fails closed for Deno %s with one fetch, zero DO calls, unchanged quota, and no reserve/upstream",
    async (_label, failure, expectedCategory) => {
      const doCalls = installTokenizer();
      let denoCalls = 0;
      let upstreamCalls = 0;
      const utcDay = new Date().toISOString().slice(0, 10);
      const quotaId = `quota:STANDARD:${utcDay}`;
      const beforeQuota = await env.QUOTA_CONTROLLER.get(
        env.QUOTA_CONTROLLER.idFromName(quotaId),
      ).getState();
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

      stubFetch({
        onDenoRequest: () => { denoCalls += 1; },
        onUpstreamRequest: () => { upstreamCalls += 1; },
        denoFailure: failure,
      });
      setDenoConfig({
        endpoint: denoTokenizerUrl,
        authToken: denoAuthToken,
        thresholdBytes: "1",
        timeoutMs: "1000",
      });

      const response = await SELF.fetch("https://octg.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
        body: JSON.stringify({
          model: "gpt-5",
          messages: [{ role: "user", content: "hello" }],
          max_completion_tokens: 1,
        }),
      });

      expect(response.status).toBe(500);
      expect((await response.json())).toMatchObject({ error: { code: "internal_error" } });
      expect(denoCalls).toBe(1);
      expect(doCalls()).toBe(0);
      expect(upstreamCalls).toBe(0);

      const afterQuota = await env.QUOTA_CONTROLLER.get(
        env.QUOTA_CONTROLLER.idFromName(quotaId),
      ).getState();
      expect(afterQuota.requestCount).toBe(beforeQuota.requestCount);
      expect(afterQuota.reservedTokens).toBe(beforeQuota.reservedTokens);
      expect(afterQuota.confirmedTokens).toBe(beforeQuota.confirmedTokens);
      expect(afterQuota.uncertainTokens).toBe(beforeQuota.uncertainTokens);

      const stageEvents = info.mock.calls
        .map(([arg]) => arg)
        .filter((arg) => typeof arg === "object" && arg !== null && arg.event === "octg.resource_stage");
      expect(stageEvents.some((event) => event.stage === "quota_reserve" || event.stage === "upstream")).toBe(false);

      const finishEvents = stageEvents.filter((arg) => arg.phase === "finish" && arg.stage === "tokenize");
      expect(finishEvents).toHaveLength(1);
      expect(finishEvents[0]).toMatchObject({
        stage: "tokenize",
        phase: "finish",
        outcome: "exception",
        route: "error:tokenizer_unavailable",
        tokenizationProvider: "deno",
        tokenizationFailureCategory: expectedCategory,
        quotaReserved: false,
        upstreamReached: false,
      });
    },
  );
});
