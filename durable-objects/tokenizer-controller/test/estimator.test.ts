import { describe, expect, it } from "vitest";
import { TokenizerEstimator, type TokenizerEstimatorContext } from "../src/estimator";
import { MAX_BPE_WORK_UNITS, type TokenizeRequest } from "../src/contracts";
import type { TokenizerStageEvent } from "../src/observation";
import goldenFixture from "./fixtures/tokenization-golden.json";

const requestFor = (inputText: string, messageCount = 1, opaqueInputBytes = 0): TokenizeRequest => ({
  requestId: "req_estimator",
  inputText,
  messageCount,
  opaqueInputBytes,
});

const contextFor = (events: TokenizerStageEvent[] = []): TokenizerEstimatorContext => ({
  requestId: "req_estimator",
  revisionId: "revision_test",
  emit: (event) => events.push(event),
});
const WORK_LIMIT_INPUT_LENGTH = Math.floor(Math.sqrt(MAX_BPE_WORK_UNITS)) + 1;

describe("TokenizerEstimator", () => {
  it.each(goldenFixture.cases)("matches golden BPE parity for $name", (testCase) => {
    const inputText = testCase.repeat === undefined
      ? testCase.inputText
      : testCase.inputText.repeat(testCase.repeat);
    const estimator = new TokenizerEstimator();
    const result = estimator.estimate(
      requestFor(inputText, testCase.messageCount, testCase.opaqueInputBytes),
      contextFor(),
    );

    expect(result).toEqual({
      estimatedInputTokens: testCase.expected,
      estimationPath: "exact_bpe",
    });
  });

  it("initializes the encoding once across successful requests", () => {
    let factoryCalls = 0;
    const estimator = new TokenizerEstimator(() => {
      factoryCalls += 1;
      return { encode: () => [1, 2, 3] };
    });

    estimator.estimate(requestFor("first"), contextFor());
    estimator.estimate(requestFor("second"), contextFor());

    expect(factoryCalls).toBe(1);
  });

  it("retries encoding initialization after an Error", () => {
    let factoryCalls = 0;
    const estimator = new TokenizerEstimator(() => {
      factoryCalls += 1;
      if (factoryCalls === 1) throw new Error("initialization failure");
      return { encode: () => [1] };
    });

    const fallback = estimator.estimate(requestFor("first"), contextFor());
    const exact = estimator.estimate(requestFor("second"), contextFor());

    expect(fallback.estimationPath).toBe("conservative_bytes");
    expect(exact).toEqual({ estimatedInputTokens: 8, estimationPath: "exact_bpe" });
    expect(factoryCalls).toBe(2);
  });

  it("emits an initialization fallback event with conservative details", () => {
    const events: TokenizerStageEvent[] = [];
    const estimator = new TokenizerEstimator(() => {
      throw new Error("initialization failure");
    });

    const result = estimator.estimate(requestFor("hello"), contextFor(events));

    expect(result).toEqual({
      estimatedInputTokens: 12,
      estimationPath: "conservative_bytes",
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      event: "octg.tokenizer_stage",
      requestId: "req_estimator",
      revisionId: "revision_test",
      stage: "tokenizer_init",
      phase: "start",
    });
    expect(events[1]).toEqual(expect.objectContaining({
      event: "octg.tokenizer_stage",
      requestId: "req_estimator",
      revisionId: "revision_test",
      stage: "tokenizer_init",
      phase: "finish",
      outcome: "fallback",
      byteCount: 5,
      tokenCount: 12,
      estimationPath: "conservative_bytes",
      failureCategory: "encoding_init",
      durationMs: expect.any(Number),
    }));
  });

  it("keeps initialized encoding after an Error from encode", () => {
    let encodeCalls = 0;
    let factoryCalls = 0;
    const events: TokenizerStageEvent[] = [];
    const estimator = new TokenizerEstimator(() => {
      factoryCalls += 1;
      return {
        encode: () => {
          encodeCalls += 1;
          if (encodeCalls === 1) throw new Error("encode failure");
          return [1, 2];
        },
      };
    });

    const fallback = estimator.estimate(requestFor("first"), contextFor(events));
    const exact = estimator.estimate(requestFor("second"), contextFor());

    expect(fallback.estimationPath).toBe("conservative_bytes");
    expect(exact).toEqual({ estimatedInputTokens: 9, estimationPath: "exact_bpe" });
    expect(factoryCalls).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({
        stage: "tokenizer_init",
        phase: "start",
      }),
      expect.objectContaining({
        stage: "tokenizer_init",
        phase: "finish",
        outcome: "success",
      }),
      expect.objectContaining({
        stage: "tokenizer_encode",
        phase: "start",
      }),
      expect.objectContaining({
        stage: "tokenizer_encode",
        phase: "finish",
        outcome: "fallback",
        byteCount: 5,
        tokenCount: 12,
        estimationPath: "conservative_bytes",
        failureCategory: "encoding_encode",
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it("adds opaque bytes exactly once", () => {
    const estimator = new TokenizerEstimator(() => ({ encode: () => [1, 2] }));

    expect(estimator.estimate(requestFor("hello", 2, 11), contextFor())).toEqual({
      estimatedInputTokens: 24,
      estimationPath: "exact_bpe",
    });
  });

  it("rejects oversized BPE work without invoking the encoder", () => {
    let encodeCalls = 0;
    const events: TokenizerStageEvent[] = [];
    const estimator = new TokenizerEstimator(() => ({
      encode: () => {
        encodeCalls += 1;
        return [1];
      },
    }));

    expect(() => estimator.estimate(
      requestFor("x".repeat(WORK_LIMIT_INPUT_LENGTH)),
      contextFor(events),
    )).toThrow(
      "Tokenizer BPE work limit exceeded.",
    );
    expect(encodeCalls).toBe(0);
    expect(events).toEqual([
      expect.objectContaining({
        stage: "tokenizer_init",
        phase: "start",
      }),
      expect.objectContaining({
        stage: "tokenizer_init",
        phase: "finish",
        outcome: "success",
      }),
      expect.objectContaining({
        stage: "tokenizer_encode",
        phase: "start",
      }),
      expect.objectContaining({
        stage: "tokenizer_encode",
        phase: "finish",
        outcome: "exception",
        failureCategory: "work_limit",
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it("rejects the original o200k Unicode boundary input", () => {
    let encodeCalls = 0;
    const estimator = new TokenizerEstimator(() => ({
      encode: () => {
        encodeCalls += 1;
        return [1];
      },
    }));
    const inputText = "  𐀀".repeat(2_785_280);

    expect(() => estimator.estimate(requestFor(inputText), contextFor())).toThrow(
      "Tokenizer BPE work limit exceeded.",
    );
    expect(encodeCalls).toBe(0);
  }, 15_000);

  it("rejects punctuation followed by newlines when the combined BPE piece exceeds the work limit", () => {
    let encodeCalls = 0;
    const estimator = new TokenizerEstimator(() => ({
      encode: () => {
        encodeCalls += 1;
        return [1];
      },
    }));

    expect(() => estimator.estimate(requestFor(`${"!".repeat(5_000)}${"\n".repeat(5_000)}`), contextFor())).toThrow(
      "Tokenizer BPE work limit exceeded.",
    );
    expect(encodeCalls).toBe(0);
  });

  it("rejects contraction suffixes that keep a single BPE piece above the work limit", () => {
    let encodeCalls = 0;
    const estimator = new TokenizerEstimator(() => ({
      encode: () => {
        encodeCalls += 1;
        return [1];
      },
    }));

    expect(() => estimator.estimate(requestFor(`${"a".repeat(8_191)}'s`), contextFor())).toThrow(
      "Tokenizer BPE work limit exceeded.",
    );
    expect(encodeCalls).toBe(0);
  });

  it("rejects leading optional prefixes that belong to a large letter BPE piece", () => {
    let encodeCalls = 0;
    const estimator = new TokenizerEstimator(() => ({
      encode: () => {
        encodeCalls += 1;
        return [1];
      },
    }));

    const inputText = (`'${"a".repeat(5_792)}1`).repeat(2);
    expect(() => estimator.estimate(requestFor(inputText), contextFor())).toThrow(
      "Tokenizer BPE work limit exceeded.",
    );
    expect(encodeCalls).toBe(0);
  });

  it("allows compact punctuation-rich input above eight KiB when BPE chunks stay bounded", () => {
    const inputText = JSON.stringify(Array.from({ length: 200 }, (_, index) => ({
      type: "function",
      function: { name: `lookup_${index}`, parameters: { type: "object" } },
    })));
    expect(new TextEncoder().encode(inputText).byteLength).toBeGreaterThan(8 * 1024);

    const estimator = new TokenizerEstimator(() => ({ encode: () => [1] }));

    expect(estimator.estimate(requestFor(inputText), contextFor())).toEqual({
      estimatedInputTokens: 8,
      estimationPath: "exact_bpe",
    });
  });

  it("allows alternating-case letters when exact BPE pieces stay bounded", () => {
    const inputText = "Aa".repeat(WORK_LIMIT_INPUT_LENGTH);
    expect(new TextEncoder().encode(inputText).byteLength).toBeGreaterThan(8 * 1024);

    const estimator = new TokenizerEstimator(() => ({ encode: () => [1] }));

    expect(estimator.estimate(requestFor(inputText), contextFor())).toEqual({
      estimatedInputTokens: 8,
      estimationPath: "exact_bpe",
    });
  });

  it("throws when safe-integer arithmetic overflows", () => {
    const events: TokenizerStageEvent[] = [];
    const estimator = new TokenizerEstimator(() => ({ encode: () => [] }));

    expect(() => estimator.estimate(
      requestFor("hello", Number.MAX_SAFE_INTEGER),
      contextFor(events),
    )).toThrow(RangeError);
    expect(events).toEqual([
      expect.objectContaining({
        stage: "tokenizer_init",
        phase: "start",
      }),
      expect.objectContaining({
        stage: "tokenizer_init",
        phase: "finish",
        outcome: "success",
      }),
      expect.objectContaining({
        stage: "tokenizer_encode",
        phase: "start",
      }),
      expect.objectContaining({
        stage: "tokenizer_encode",
        phase: "finish",
        outcome: "exception",
        failureCategory: "arithmetic",
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it("propagates non-Error encoding failures", () => {
    const failure = { kind: "encoder_failure" };
    const events: TokenizerStageEvent[] = [];
    const estimator = new TokenizerEstimator(() => {
      throw failure;
    });
    let caught: unknown;

    try {
      estimator.estimate(requestFor("hello"), contextFor(events));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(events).toEqual([
      expect.objectContaining({
        stage: "tokenizer_init",
        phase: "start",
      }),
      expect.objectContaining({
        stage: "tokenizer_init",
        phase: "finish",
        outcome: "exception",
        failureCategory: "encoding_init",
        durationMs: expect.any(Number),
      }),
    ]);
  });
});
