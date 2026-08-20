import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_ID_BYTES,
  type TokenizeRequest,
  type TokenizeResult,
} from "../src/index";

const controller = (name = "tokenizer:primary") => env.TOKENIZER_CONTROLLER.get(
  env.TOKENIZER_CONTROLLER.idFromName(name),
);

const validRequest: TokenizeRequest = {
  requestId: "req_controller",
  inputText: "Hello, world!",
  messageCount: 1,
  opaqueInputBytes: 0,
};

describe("TokenizerController Durable Object", () => {
  it("returns an exact result for a valid request over RPC", async () => {
    const result = await controller().tokenize(validRequest);

    expect(result).toEqual({
      estimatedInputTokens: 11,
      estimationPath: "exact_bpe",
    } satisfies TokenizeResult);
  });

  it("accepts requestId at the exact UTF-8 byte boundary", async () => {
    const accepted = await controller().tokenize({
      ...validRequest,
      requestId: "r".repeat(MAX_REQUEST_ID_BYTES),
      inputText: "",
    });
    expect(accepted).toEqual({ estimatedInputTokens: 7, estimationPath: "exact_bpe" });
  });

  it("returns a typed work-limit result over RPC", async () => {
    const result = await controller("tokenizer:work-limit").tokenize({
      ...validRequest,
      requestId: "req_work_limit",
      inputText: "x".repeat(16_384),
    });

    expect(result).toEqual({ kind: "work_limit" });
  });

  it("does not persist request data in Durable Object storage", async () => {
    const tokenizer = controller("tokenizer:storage-absence");

    await tokenizer.tokenize({
      ...validRequest,
      requestId: "req_storage_absence",
      inputText: "storage must remain empty",
    });

    const stored = await runInDurableObject(
      tokenizer as unknown as DurableObjectStub,
      (_instance, state) => state.storage.list(),
    );
    expect(stored.size).toBe(0);
  });
});
