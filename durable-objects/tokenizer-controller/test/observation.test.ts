import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitTokenizerStage,
  type TokenizerStageEvent,
} from "../src/observation";

describe("emitTokenizerStage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs only the allowlisted fields", () => {
    const event = Object.assign(
      {
        event: "octg.tokenizer_stage" as const,
        requestId: "req_observation",
        revisionId: "revision_test",
        stage: "tokenizer_encode" as const,
        phase: "finish" as const,
        durationMs: 12,
        outcome: "fallback" as const,
        byteCount: 32,
        tokenCount: 12,
        estimationPath: "conservative_bytes" as const,
        failureCategory: "encoding_encode" as const,
      } satisfies TokenizerStageEvent,
      {
        inputText: "secret prompt",
        authorization: "Bearer secret",
        errorMessage: "raw encoder failure",
        tokenArray: [1, 2, 3],
      },
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    emitTokenizerStage(event);

    expect(log).toHaveBeenCalledWith({
      event: "octg.tokenizer_stage",
      requestId: "req_observation",
      revisionId: "revision_test",
      stage: "tokenizer_encode",
      phase: "finish",
      durationMs: 12,
      outcome: "fallback",
      byteCount: 32,
      tokenCount: 12,
      estimationPath: "conservative_bytes",
      failureCategory: "encoding_encode",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret prompt");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Bearer secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("raw encoder failure");
  });

  it("does not propagate logging failure", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("logger unavailable");
    });

    expect(() => emitTokenizerStage({
      event: "octg.tokenizer_stage",
      requestId: "req_log_failure",
      revisionId: "revision_test",
      stage: "tokenizer_init",
      phase: "start",
    })).not.toThrow();
  });

  it.each(["tokenizer_init", "tokenizer_encode"] as const)(
    "accepts only the supported stage %s",
    (stage) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      emitTokenizerStage({
        event: "octg.tokenizer_stage",
        requestId: "req_stage",
        revisionId: "revision_test",
        stage,
        phase: "start",
      });

      expect(log).toHaveBeenCalledTimes(1);
    },
  );
});
