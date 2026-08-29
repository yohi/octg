import { describe, expect, it, vi } from "vitest";
import { routeTokenization } from "../src/tokenization-routing";
import type { TokenizerNamespace } from "../src/tokenizer";

const request = {
  requestId: "req_route",
  inputText: "hello",
  inputTextBytes: 5,
  messageCount: 1,
  opaqueInputBytes: 11,
} as const;

const enabledConfig = {
  kind: "enabled",
  endpoint: "https://tokenizer.example/tokenize",
  authToken: "test-secret",
  thresholdBytes: 5,
  timeoutMs: 3000,
  maxInputBytes: 1024,
} as const;

function namespaceWith(result: unknown): {
  readonly namespace: TokenizerNamespace<string>;
  readonly getCallCount: () => number;
} {
  let calls = 0;
  return {
    namespace: {
      idFromName(name) {
        expect(name).toBe("tokenizer:primary");
        return name;
      },
      get() {
        return {
          tokenize() {
            calls += 1;
            return Promise.resolve(result);
          },
        };
      },
    },
    getCallCount() {
      return calls;
    },
  };
}

describe("routeTokenization", () => {
  it("uses Deno at and above the configured threshold", async () => {
    const { namespace, getCallCount } = namespaceWith({ estimatedInputTokens: 999 });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ baseTokenCount: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await routeTokenization({
      config: enabledConfig,
      namespace,
      request,
      fetchImpl,
    });

    expect(outcome).toEqual({
      kind: "resolved",
      provider: "deno",
      result: { estimatedInputTokens: 20, estimationPath: "exact_bpe" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getCallCount()).toBe(0);
  });

  it("uses the Durable Object below the configured threshold", async () => {
    const { namespace, getCallCount } = namespaceWith({
      estimatedInputTokens: 9,
      estimationPath: "exact_bpe",
    });
    const fetchImpl = vi.fn<typeof fetch>();

    const outcome = await routeTokenization({
      config: { ...enabledConfig, thresholdBytes: 6 },
      namespace,
      request,
      fetchImpl,
    });

    expect(outcome).toEqual({
      kind: "resolved",
      provider: "cloudflare_do",
      result: { estimatedInputTokens: 9, estimationPath: "exact_bpe" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getCallCount()).toBe(1);
  });
});
