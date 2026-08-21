import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MAX_BPE_WORK_UNITS,
  MAX_REQUEST_ID_BYTES,
  parseTokenizeRequest,
  type TokenizeRequest,
  type TokenizeResult,
} from "../src/contracts";

const controller = (name = "tokenizer:primary") => env.TOKENIZER_CONTROLLER.get(
  env.TOKENIZER_CONTROLLER.idFromName(name),
);

const validRequest: TokenizeRequest = {
  requestId: "req_controller",
  inputText: "Hello, world!",
  messageCount: 1,
  opaqueInputBytes: 0,
};
const WORK_LIMIT_INPUT_LENGTH = Math.floor(Math.sqrt(MAX_BPE_WORK_UNITS)) + 1;

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
      inputText: "x".repeat(WORK_LIMIT_INPUT_LENGTH),
    });

    expect(result).toEqual({ kind: "work_limit" });
  });

  it("rejects malformed requests at the input boundary", () => {
    expect(() => parseTokenizeRequest({
      ...validRequest,
      messageCount: -1,
    })).toThrow(TypeError);
  });

  it("does not persist request data in Durable Object storage", async () => {
    const tokenizer = controller("tokenizer:storage-absence");

    await tokenizer.tokenize({
      ...validRequest,
      requestId: "req_storage_absence",
      inputText: "storage must remain empty",
    });

    const stored = await runInDurableObject(
      tokenizer,
      (_instance, state) => state.storage.list(),
    );
    expect(stored.size).toBe(0);
  });
});
