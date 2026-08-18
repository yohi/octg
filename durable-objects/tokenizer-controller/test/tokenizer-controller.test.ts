import { env, runInDurableObject } from "cloudflare:test";
import { DurableObject } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { TokenizerController } from "../src/tokenizer-controller";
import golden from "./fixtures/tokenization-golden.json";

const stub = () => env.TOKENIZER_CONTROLLER.get(env.TOKENIZER_CONTROLLER.idFromName("tokenizer:primary"));

const freshStub = () =>
  env.TOKENIZER_CONTROLLER.get(
    env.TOKENIZER_CONTROLLER.idFromName(`tokenizer:${crypto.randomUUID()}`),
  );

function collectLogs(): { logs: unknown[]; spy: ReturnType<typeof vi.spyOn> } {
  const logs: unknown[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    logs.push(args.length === 1 ? args[0] : args);
  });
  return { logs, spy };
}

function findInitStarts(logs: unknown[]): unknown[] {
  return logs.filter((log) => {
    if (typeof log !== "object" || log === null) return false;
    return (
      "stage" in log &&
      log.stage === "tokenizer_init" &&
      "phase" in log &&
      log.phase === "start"
    );
  });
}

function findEncodeFallback(logs: unknown[]): unknown {
  return logs.find((log) => {
    if (typeof log !== "object" || log === null) return false;
    return (
      "stage" in log &&
      log.stage === "tokenizer_encode" &&
      "phase" in log &&
      log.phase === "finish" &&
      "outcome" in log &&
      log.outcome === "fallback"
    );
  });
}

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
    const { logs, spy } = collectLogs();
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

  it("emits tokenizer_init stage only on first call", async () => {
    const controller = freshStub();
    const { logs, spy } = collectLogs();
    try {
      await controller.estimate({
        requestId: "req_first",
        inputText: "hello",
        messageCount: 1,
        opaqueInputBytes: 0,
      });
      await controller.estimate({
        requestId: "req_second",
        inputText: "world",
        messageCount: 1,
        opaqueInputBytes: 0,
      });
    } finally {
      spy.mockRestore();
    }
    const initStages = findInitStarts(logs);
    expect(initStages).toHaveLength(1);
  });

  it("emits no tokenizer_init stage when encoding is already initialized", async () => {
    const controller = freshStub();
    // Warm up the encoding cache
    await controller.estimate({
      requestId: "req_warmup",
      inputText: "hello",
      messageCount: 1,
      opaqueInputBytes: 0,
    });

    const { logs, spy } = collectLogs();
    try {
      await controller.estimate({
        requestId: "req_cached",
        inputText: "world",
        messageCount: 1,
        opaqueInputBytes: 0,
      });
    } finally {
      spy.mockRestore();
    }
    const initStages = findInitStarts(logs);
    expect(initStages).toHaveLength(0);
  });

  it("includes failureCategory on encoding.encode failure", async () => {
    const controller = freshStub();
    const { logs, spy } = collectLogs();
    try {
      type TokenizerLike = Pick<TokenizerController, "estimate">;
      type MutableTokenizer = TokenizerLike & { encoding: { encode: (text: string) => number[] } };
      await runInDurableObject(
        controller as unknown as DurableObjectStub<DurableObject>,
        async (instance: unknown) => {
          const tokenizer = instance as TokenizerLike;
          // Force encoding initialization so the encode path is exercised
          await tokenizer.estimate({
            requestId: "req_init",
            inputText: "init",
            messageCount: 1,
            opaqueInputBytes: 0,
          });
          const mutable = instance as MutableTokenizer;
          const originalEncoding = mutable.encoding;
          mutable.encoding = {
            encode: () => {
              throw new Error("encode failure");
            },
          };
          try {
            await tokenizer.estimate({
              requestId: "req_encode_failure",
              inputText: "test",
              messageCount: 1,
              opaqueInputBytes: 0,
            });
          } finally {
            mutable.encoding = originalEncoding;
          }
        },
      );
    } finally {
      spy.mockRestore();
    }
    const encodeFinish = findEncodeFallback(logs);
    expect(encodeFinish).toBeDefined();
    expect(encodeFinish).toHaveProperty("failureCategory", "encoding_encode_failure");
  });
});

