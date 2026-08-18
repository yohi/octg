import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { TokenizerController } from "../src/tokenizer-controller";
import golden from "./fixtures/tokenization-golden.json";

const stub = () => env.TOKENIZER_CONTROLLER.get(env.TOKENIZER_CONTROLLER.idFromName("tokenizer:primary"));

describe("TokenizerController", () => {
  it.each(golden.cases)(
    "returns exact BPE parity for $inputText",
    async ({ inputText, messageCount, opaqueInputBytes, expectedTokens }) => {
      const controller = stub();
      const outcome = await controller.estimate({
        requestId: "req_test",
        inputText,
        messageCount,
        opaqueInputBytes,
      });
      expect(outcome).toEqual({
        kind: "resolved",
        result: { estimatedInputTokens: expectedTokens, estimationPath: "exact_bpe" },
      });
    },
  );

  it("returns unavailable for an invalid request", async () => {
    const controller = stub();
    const outcome = await controller.estimate({
      requestId: "",
      inputText: "hello",
      messageCount: 1,
      opaqueInputBytes: 0,
    });
    expect(outcome).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable when the result is not a safe integer", async () => {
    const controller = stub();
    const outcome = await controller.estimate({
      requestId: "req_overflow",
      inputText: "hello",
      messageCount: Number.MAX_SAFE_INTEGER,
      opaqueInputBytes: 0,
    });
    expect(outcome).toEqual({ kind: "unavailable" });
  });

  it("does not log the input text", async () => {
    const controller = stub();
    const logs: unknown[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((value) => {
      logs.push(value);
    });
    try {
      await controller.estimate({
        requestId: "req_privacy",
        inputText: "secret input text",
        messageCount: 1,
        opaqueInputBytes: 0,
      });
    } finally {
      spy.mockRestore();
    }
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("secret input text");
  });
});
