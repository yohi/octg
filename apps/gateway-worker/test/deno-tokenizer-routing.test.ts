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

function stubFetch(options: {
  readonly onDenoRequest?: () => void;
  readonly onUpstreamRequest?: () => void;
  readonly upstreamTotalTokens?: number;
}) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === denoTokenizerUrl) {
      options.onDenoRequest?.();
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
  });
});
