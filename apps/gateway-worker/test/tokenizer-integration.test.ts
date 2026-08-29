import { env, SELF } from "cloudflare:test";
import type { TokenizeRequest } from "@octg/tokenizer-controller";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenizerNamespace } from "../src/tokenizer";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

const originalTokenizerBinding = Object.getOwnPropertyDescriptor(env, "TOKENIZER_CONTROLLER");
const denoConfigNames = [
  "DENO_TOKENIZER_ENDPOINT",
  "DENO_TOKENIZER_AUTH_TOKEN",
  "DENO_TOKENIZER_THRESHOLD_BYTES",
  "DENO_TOKENIZER_TIMEOUT_MS",
] as const;
const originalDenoConfig = denoConfigNames.map((name) => [
  name,
  Object.getOwnPropertyDescriptor(env, name),
] as const);

const request = () => SELF.fetch("https://octg.test/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
  body: JSON.stringify({
    model: "gpt-5",
    messages: [{ role: "user", content: "hello" }],
    max_completion_tokens: 1,
  }),
});

interface Calls {
  readonly names: string[];
  readonly ids: string[];
  readonly requests: TokenizeRequest[];
}

function installTokenizer(result: unknown, rejected = false): Calls {
  const calls: Calls = { names: [], ids: [], requests: [] };
  const namespace: TokenizerNamespace<string> = {
    idFromName(name) {
      calls.names.push(name);
      return name;
    },
    get(id) {
      calls.ids.push(id);
      return {
        tokenize(input) {
          calls.requests.push(input);
          return rejected ? Promise.reject(new Error("rpc-secret-error")) : Promise.resolve(result);
        },
      };
    },
  };
  Object.defineProperty(env, "TOKENIZER_CONTROLLER", { value: namespace, configurable: true });
  return calls;
}

function installDenoConfig(): void {
  Object.defineProperty(env, "DENO_TOKENIZER_ENDPOINT", {
    value: "https://tokenizer.example/tokenize",
    configurable: true,
  });
  Object.defineProperty(env, "DENO_TOKENIZER_AUTH_TOKEN", {
    value: "test-secret",
    configurable: true,
  });
  Object.defineProperty(env, "DENO_TOKENIZER_THRESHOLD_BYTES", {
    value: "5",
    configurable: true,
  });
  Object.defineProperty(env, "DENO_TOKENIZER_TIMEOUT_MS", {
    value: "3000",
    configurable: true,
  });
}

function restoreDenoConfig(): void {
  for (const [name, descriptor] of originalDenoConfig) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(env, name);
    } else {
      Object.defineProperty(env, name, descriptor);
    }
  }
}

function quotaStub() {
  const day = new Date().toISOString().slice(0, 10);
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
}

function resourceEvents(consoleInfo: { mock: { calls: readonly unknown[][] } }): Record<string, unknown>[] {
  return consoleInfo.mock.calls.flatMap(([value]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const event = Reflect.get(value, "event");
    return event === "octg.resource_stage" ? [value as Record<string, unknown>] : [];
  });
}

describe("Tokenizer RPC proxy integration", () => {
  beforeEach(async () => {
    await seedClient();
  });

  afterEach(() => {
    if (originalTokenizerBinding) {
      Object.defineProperty(env, "TOKENIZER_CONTROLLER", originalTokenizerBinding);
    } else {
      Reflect.deleteProperty(env, "TOKENIZER_CONTROLLER");
    }
    restoreDenoConfig();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    null,
    {},
    { estimatedInputTokens: 1, estimationPath: "unknown" },
    { estimatedInputTokens: Number.NaN, estimationPath: "exact_bpe" },
    { estimatedInputTokens: Number.POSITIVE_INFINITY, estimationPath: "exact_bpe" },
    { estimatedInputTokens: -1, estimationPath: "exact_bpe" },
    { estimatedInputTokens: 1.5, estimationPath: "exact_bpe" },
    { estimatedInputTokens: Number.MAX_SAFE_INTEGER + 1, estimationPath: "exact_bpe" },
  ])("returns a generic 500 and skips quota for malformed result %#", async (result) => {
    const calls = installTokenizer(result);
    const before = await quotaStub().getState();
    let upstreamCalls = 0;
    vi.stubGlobal("fetch", async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ usage: { total_tokens: 1 } }), { status: 200 });
    });
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await request();
    const after = await quotaStub().getState();
    const body = await response.json();
    const events = resourceEvents(consoleInfo);
    const serializedEvents = JSON.stringify(events);

    expect(response.status).toBe(500);
    expect(response.headers.get("X-OCTG-Route")).toBe("error:internal_error");
    expect(response.headers.get("X-OCTG-Quota-Remaining")).toBe(String(before.remaining));
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(body).toMatchObject({
      error: {
        message: "An internal error occurred.",
        type: "api_error",
        code: "internal_error",
      },
    });
    expect(calls.names).toEqual(["tokenizer:primary"]);
    expect(calls.ids).toEqual(["tokenizer:primary"]);
    expect(calls.requests).toHaveLength(1);
    expect(upstreamCalls).toBe(0);
    expect(after).toMatchObject({
      requestCount: before.requestCount,
      reservedTokens: before.reservedTokens,
      confirmedTokens: before.confirmedTokens,
      uncertainTokens: before.uncertainTokens,
    });
    expect(events).toContainEqual(expect.objectContaining({
      stage: "tokenize",
      phase: "finish",
      outcome: "exception",
      route: "error:tokenizer_unavailable",
      quotaReserved: false,
      upstreamReached: false,
    }));
    expect(events.some((event) => event.stage === "quota_reserve" || event.stage === "upstream")).toBe(false);
    expect(serializedEvents).not.toContain("hello");
    expect(serializedEvents).not.toContain(TEST_CLIENT_KEY);
    expect(serializedEvents).not.toContain("rpc-secret-error");
  });

  it("maps a rejected tokenizer RPC to one fail-closed attempt", async () => {
    const calls = installTokenizer(undefined, true);
    const before = await quotaStub().getState();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ usage: { total_tokens: 1 } }), { status: 200 }));

    const response = await request();
    const after = await quotaStub().getState();

    expect(response.status).toBe(500);
    expect(response.headers.get("X-OCTG-Route")).toBe("error:internal_error");
    expect(calls.names).toHaveLength(1);
    expect(calls.ids).toHaveLength(1);
    expect(calls.requests).toHaveLength(1);
    expect(after.requestCount).toBe(before.requestCount);
  });

  it("keeps the real tokenizer binding in the success path", async () => {
    if (originalTokenizerBinding?.value === undefined) throw new Error("Tokenizer binding is unavailable");
    const before = await quotaStub().getState();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ usage: { total_tokens: 1 } }), { status: 200 }));

    const response = await request();

    expect(response.status).toBe(200);
    expect((await response.json())).toMatchObject({ usage: { total_tokens: 1 } });
    expect((await quotaStub().getState()).confirmedTokens - before.confirmedTokens).toBe(1);
  });

  it("routes an input at the configured threshold to Deno", async () => {
    installDenoConfig();
    const calls = installTokenizer({
      estimatedInputTokens: 999,
      estimationPath: "exact_bpe",
    });
    let denoCalls = 0;
    let upstreamCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input) === "https://tokenizer.example/tokenize") {
        denoCalls += 1;
        return new Response(JSON.stringify({ baseTokenCount: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      upstreamCalls += 1;
      return new Response(JSON.stringify({ usage: { total_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await request();

    expect(response.status).toBe(200);
    expect(denoCalls).toBe(1);
    expect(upstreamCalls).toBe(1);
    expect(calls.requests).toHaveLength(0);
  });
});
