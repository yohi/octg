import { describe, expect, it, vi } from "vitest";
import type { TokenizerController } from "@octg/tokenizer-controller";
import { tokenize, type TokenizeClientRequest } from "../src/tokenizer";
import type { Env } from "../src/index";

const baseRequest: TokenizeClientRequest = {
  requestId: "req_test",
  inputText: "Hello world",
  messageCount: 1,
  opaqueInputBytes: 0,
};

function envWithEstimate(result: unknown): Env {
  return {
    TOKENIZER_CONTROLLER: {
      idFromName: () => ({ name: "tokenizer:primary" } as DurableObjectId),
      get: () =>
        ({
          estimate: vi.fn().mockResolvedValue(result),
        } as unknown as DurableObjectStub<TokenizerController>),
    },
  } as unknown as Env;
}

function envWithRejectedEstimate(error: Error): Env {
  return {
    TOKENIZER_CONTROLLER: {
      idFromName: () => ({ name: "tokenizer:primary" } as DurableObjectId),
      get: () =>
        ({
          estimate: vi.fn().mockRejectedValue(error),
        } as unknown as DurableObjectStub<TokenizerController>),
    },
  } as unknown as Env;
}

describe("tokenize", () => {
  it("returns resolved result on successful RPC", async () => {
    const env = envWithEstimate({
      kind: "resolved",
      result: { estimatedInputTokens: 9, estimationPath: "exact_bpe" },
    });
    const outcome = await tokenize(env, baseRequest);
    expect(outcome).toEqual({
      kind: "resolved",
      result: { estimatedInputTokens: 9, estimationPath: "exact_bpe" },
    });
  });

  it("returns unavailable when the outcome kind is not resolved", async () => {
    const env = envWithEstimate({
      kind: "unavailable",
    });
    const outcome = await tokenize(env, baseRequest);
    expect(outcome).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable when the RPC throws", async () => {
    const env = envWithRejectedEstimate(new Error("DO unavailable"));
    const outcome = await tokenize(env, baseRequest);
    expect(outcome).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable when the result shape is invalid", async () => {
    const env = envWithEstimate({
      kind: "resolved",
      result: {
        estimatedInputTokens: -1,
        estimationPath: "exact_bpe",
      },
    });
    const outcome = await tokenize(env, baseRequest);
    expect(outcome).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable when the estimation path is unknown", async () => {
    const env = envWithEstimate({
      kind: "resolved",
      result: {
        estimatedInputTokens: 9,
        estimationPath: "unknown_path",
      },
    });
    const outcome = await tokenize(env, baseRequest);
    expect(outcome).toEqual({ kind: "unavailable" });
  });
});
