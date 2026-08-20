import { describe, expect, it } from "vitest";
import { TokenizerEstimator, type TokenizerEstimatorContext } from "../src/estimator";
import type { TokenizeRequest } from "../src/contracts";
import goldenFixture from "./fixtures/tokenization-golden.json";

const requestFor = (inputText: string, messageCount = 1, opaqueInputBytes = 0): TokenizeRequest => ({
  requestId: "req_estimator",
  inputText,
  messageCount,
  opaqueInputBytes,
});

const contextFor = (events: unknown[] = []): TokenizerEstimatorContext => ({
  requestId: "req_estimator",
  revisionId: "revision_test",
  emit: (event) => events.push(event),
});

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

  it("keeps initialized encoding after an Error from encode", () => {
    let encodeCalls = 0;
    let factoryCalls = 0;
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

    const fallback = estimator.estimate(requestFor("first"), contextFor());
    const exact = estimator.estimate(requestFor("second"), contextFor());

    expect(fallback.estimationPath).toBe("conservative_bytes");
    expect(exact).toEqual({ estimatedInputTokens: 9, estimationPath: "exact_bpe" });
    expect(factoryCalls).toBe(1);
  });

  it("adds opaque bytes exactly once", () => {
    const estimator = new TokenizerEstimator(() => ({ encode: () => [1, 2] }));

    expect(estimator.estimate(requestFor("hello", 2, 11), contextFor())).toEqual({
      estimatedInputTokens: 24,
      estimationPath: "exact_bpe",
    });
  });

  it("throws when safe-integer arithmetic overflows", () => {
    const estimator = new TokenizerEstimator(() => ({ encode: () => [] }));

    expect(() => estimator.estimate(
      requestFor("hello", Number.MAX_SAFE_INTEGER),
      contextFor(),
    )).toThrow(RangeError);
  });

  it("propagates non-Error encoding failures", () => {
    const failure = { kind: "encoder_failure" };
    const estimator = new TokenizerEstimator(() => {
      throw failure;
    });
    let caught: unknown;

    try {
      estimator.estimate(requestFor("hello"), contextFor());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
  });
});
