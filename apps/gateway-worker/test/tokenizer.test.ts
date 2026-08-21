import { describe, expect, it } from "vitest";
import type { TokenizeRequest } from "@octg/tokenizer-controller";
import { tokenizeInput, type TokenizerNamespace } from "../src/tokenizer";

const request: TokenizeRequest = {
  requestId: "req_test",
  inputText: "Hello world",
  messageCount: 1,
  opaqueInputBytes: 0,
};

describe("tokenizeInput", () => {
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
