import { describe, expect, it } from "vitest";
import type { PrepareErrorCode, PrepareErrorBody, PrepareMetadata } from "../src/index";

describe("PrepareMetadata", () => {
  it("accepts a valid metadata object with the exact field set", () => {
    const metadata: PrepareMetadata = {
      version: 1,
      model: "model-name",
      rawBodyBytes: 12,
      inputBytes: 10,
      inputTextBytes: 10,
      opaqueInputBytes: 0,
      messageCount: 1,
      estimatedInputTokens: 17,
      estimationPath: "exact_bpe",
      maxOutputTokens: 64,
      stream: false,
      isToolUse: false,
      outputMarker: "octg_prepare_0123456789abcdef0123456789abcdef",
    };
    expect(metadata.version).toBe(1);
    expect(metadata.model).toBe("model-name");
    expect(metadata.rawBodyBytes).toBe(12);
    expect(metadata.inputBytes).toBe(10);
    expect(metadata.inputTextBytes).toBe(10);
    expect(metadata.opaqueInputBytes).toBe(0);
    expect(metadata.messageCount).toBe(1);
    expect(metadata.estimatedInputTokens).toBe(17);
    expect(metadata.estimationPath).toBe("exact_bpe");
    expect(metadata.maxOutputTokens).toBe(64);
    expect(metadata.stream).toBe(false);
    expect(metadata.isToolUse).toBe(false);
    expect(metadata.outputMarker).toBe("octg_prepare_0123456789abcdef0123456789abcdef");
  });
});

describe("PrepareErrorCode", () => {
  it("covers all five error codes", () => {
    const codes: PrepareErrorCode[] = [
      "invalid_body",
      "non_text",
      "max_tokens_conflict",
      "input_too_large",
      "request_too_large",
    ];
    expect(codes).toHaveLength(5);
  });
});

describe("PrepareErrorBody", () => {
  it("has a code field of PrepareErrorCode type", () => {
    const body: PrepareErrorBody = { code: "invalid_body" };
    expect(body.code).toBe("invalid_body");
  });
});