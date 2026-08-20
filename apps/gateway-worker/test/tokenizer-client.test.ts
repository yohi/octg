import { describe, expect, it } from "vitest";
import {
  estimateRpcPayloadSize,
  tokenizeInput,
  type TokenizerNamespace,
} from "../src/tokenizer";
import type { TokenizeRequest } from "@octg/tokenizer-controller";

const baseRequest: TokenizeRequest = {
  requestId: "req_client",
  inputText: "hello",
  messageCount: 1,
  opaqueInputBytes: 0,
};

interface Calls {
  readonly names: string[];
  readonly ids: string[];
  readonly requests: TokenizeRequest[];
}

function namespaceWith(result: unknown, rejected = false, failure?: unknown): {
  readonly namespace: TokenizerNamespace<string>;
  readonly calls: Calls;
} {
  const calls: Calls = { names: [], ids: [], requests: [] };
  const namespace: TokenizerNamespace<string> = {
    idFromName(name) {
      calls.names.push(name);
      return name;
    },
    get(id) {
      calls.ids.push(id);
      return {
        tokenize(request) {
          calls.requests.push(request);
          return rejected
            ? Promise.reject(failure ?? new Error("RPC unavailable"))
            : Promise.resolve(result);
        },
      };
    },
  };
  return { namespace, calls };
}

describe("tokenizeInput", () => {
  it("uses the fixed object name and makes one RPC attempt", async () => {
    const { namespace, calls } = namespaceWith({
      estimatedInputTokens: 9,
      estimationPath: "exact_bpe",
    });

    const outcome = await tokenizeInput(namespace, baseRequest);

    expect(outcome).toEqual({
      kind: "resolved",
      result: { estimatedInputTokens: 9, estimationPath: "exact_bpe" },
    });
    expect(calls.names).toEqual(["tokenizer:primary"]);
    expect(calls.ids).toEqual(["tokenizer:primary"]);
    expect(calls.requests).toEqual([baseRequest]);
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
  ])("rejects malformed result %#", async (result) => {
    const { namespace } = namespaceWith(result);

    await expect(tokenizeInput(namespace, baseRequest)).resolves.toEqual({ kind: "unavailable" });
  });

  it("converts a rejected RPC to unavailable without retrying", async () => {
    const { namespace, calls } = namespaceWith(undefined, true);

    await expect(tokenizeInput(namespace, baseRequest)).resolves.toEqual({ kind: "unavailable" });
    expect(calls.names).toHaveLength(1);
    expect(calls.ids).toHaveLength(1);
    expect(calls.requests).toHaveLength(1);
  });

  it("classifies a typed tokenizer work-limit RPC result as request_too_large", async () => {
    const { namespace, calls } = namespaceWith({ kind: "work_limit" });

    await expect(tokenizeInput(namespace, baseRequest)).resolves.toEqual({ kind: "request_too_large" });
    expect(calls.requests).toHaveLength(1);
  });

  it("fails closed before resolving a stub when the RPC payload reaches 32 MiB", async () => {
    const { namespace, calls } = namespaceWith({
      estimatedInputTokens: 1,
      estimationPath: "exact_bpe",
    });
    const request: TokenizeRequest = {
      ...baseRequest,
      inputText: "x".repeat(16 * 1024 * 1024),
    };

    expect(estimateRpcPayloadSize(request)).toBeGreaterThanOrEqual(32 * 1024 * 1024);
    await expect(tokenizeInput(namespace, request)).resolves.toEqual({ kind: "unavailable" });
    expect(calls.names).toHaveLength(0);
    expect(calls.ids).toHaveLength(0);
    expect(calls.requests).toHaveLength(0);
  });

  it("fails closed before resolving a stub for oversized UTF-8 input", async () => {
    const { namespace, calls } = namespaceWith({
      estimatedInputTokens: 1,
      estimationPath: "exact_bpe",
    });
    const request: TokenizeRequest = {
      ...baseRequest,
      inputText: "x".repeat(16 * 1024 * 1024 - 65_535),
    };

    await expect(tokenizeInput(namespace, request)).resolves.toEqual({ kind: "unavailable" });
    expect(calls.names).toHaveLength(0);
  });
});
