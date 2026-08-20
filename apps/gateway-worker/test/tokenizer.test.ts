import { describe, expect, it } from "vitest";
import type { TokenizeRequest } from "@octg/tokenizer-controller";
import { tokenizeInput, type TokenizerNamespace } from "../src/tokenizer";

const request: TokenizeRequest = {
  requestId: "req_test",
  inputText: "Hello world",
  messageCount: 1,
  opaqueInputBytes: 0,
};

function namespaceWith(
  call: (input: TokenizeRequest) => Promise<unknown>,
): TokenizerNamespace<string> {
  return {
    idFromName: (name) => name,
    get: () => ({ tokenize: call }),
  };
}

describe("tokenizeInput", () => {
  it("returns a validated result from the tokenizer RPC", async () => {
    const outcome = await tokenizeInput(
      namespaceWith(async () => ({ estimatedInputTokens: 9, estimationPath: "exact_bpe" })),
      request,
    );

    expect(outcome).toEqual({
      kind: "resolved",
      result: { estimatedInputTokens: 9, estimationPath: "exact_bpe" },
    });
  });

  it("fails closed when object lookup throws", async () => {
    const namespace: TokenizerNamespace<string> = {
      idFromName: () => {
        throw new Error("binding missing");
      },
      get: () => ({ tokenize: async () => undefined }),
    };

    await expect(tokenizeInput(namespace, request)).resolves.toEqual({ kind: "unavailable" });
  });
});
