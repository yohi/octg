import { describe, expect, it } from "vitest";
import { parsePrepareMetadata } from "../src/prepare-contract";
import type { PrepareMetadata } from "@octg/shared";

const validMetadata: PrepareMetadata = {
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

/** Base64url-encode a string (Worker-compatible, no Node Buffer). */
function encodeBase64url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeMetadataHeader(metadata: PrepareMetadata): string {
  return encodeBase64url(JSON.stringify(metadata));
}

describe("parsePrepareMetadata", () => {
  it("decodes a valid metadata header", () => {
    const encoded = encodeMetadataHeader(validMetadata);
    expect(parsePrepareMetadata(encoded, 1_048_576)).toEqual(validMetadata);
  });

  it("accepts opaque input bytes with correct semantic relationship", () => {
    const metadata: PrepareMetadata = {
      ...validMetadata,
      inputBytes: 20,
      inputTextBytes: 15,
      opaqueInputBytes: 5,
    };
    expect(parsePrepareMetadata(encodeMetadataHeader(metadata), 1_048_576)).toEqual(metadata);
  });

  it("accepts a non-ASCII model name in the header boundary", () => {
    const metadata: PrepareMetadata = {
      ...validMetadata,
      model: "モデル-123",
    };
    expect(parsePrepareMetadata(encodeMetadataHeader(metadata), 1_048_576)).toEqual(metadata);
  });

  it("returns undefined for a null header value", () => {
    expect(parsePrepareMetadata(null, 1_048_576)).toBeUndefined();
  });

  it("returns undefined for an empty header value", () => {
    expect(parsePrepareMetadata("", 1_048_576)).toBeUndefined();
  });

  it("returns undefined when the base64url payload exceeds the byte bound", () => {
    const encoded = encodeMetadataHeader(validMetadata);
    expect(parsePrepareMetadata(encoded, 10)).toBeUndefined();
  });

  it("returns undefined for invalid base64url", () => {
    expect(parsePrepareMetadata("!!!not-base64url!!!", 1_048_576)).toBeUndefined();
  });

  it("returns undefined for non-JSON base64url", () => {
    expect(parsePrepareMetadata(encodeBase64url("not json"), 1_048_576)).toBeUndefined();
  });

  it("returns undefined for a JSON value that is not an object", () => {
    expect(parsePrepareMetadata(encodeBase64url("[1,2,3]"), 1_048_576)).toBeUndefined();
    expect(parsePrepareMetadata(encodeBase64url("42"), 1_048_576)).toBeUndefined();
  });

  it("returns undefined for a missing field", () => {
    const partial = { ...validMetadata } as Record<string, unknown>;
    delete partial.model;
    expect(parsePrepareMetadata(encodeBase64url(JSON.stringify(partial)), 1_048_576)).toBeUndefined();
  });

  it("returns undefined for an extra field", () => {
    const extra = { ...validMetadata, extraField: true };
    expect(parsePrepareMetadata(encodeBase64url(JSON.stringify(extra)), 1_048_576)).toBeUndefined();
  });

  it("returns undefined for wrong version", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, version: 2 as unknown as 1 })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for non-number version", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, version: "1" as unknown as 1 })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for empty model", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, model: "" })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for non-string model", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, model: 42 as unknown as string })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a negative byte field", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, rawBodyBytes: -1 })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for an unsafe-integer byte field", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, inputBytes: Number.MAX_SAFE_INTEGER + 1 })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a non-integer byte field", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, inputBytes: 10.5 })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a non-number byte field", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, rawBodyBytes: "12" as unknown as number })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for maxOutputTokens of zero", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, maxOutputTokens: 0 })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a negative maxOutputTokens", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, maxOutputTokens: -1 })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for an unsafe-integer maxOutputTokens", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a non-number maxOutputTokens", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, maxOutputTokens: "64" as unknown as number })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for an invalid estimationPath", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, estimationPath: "approximate" as unknown as "exact_bpe" })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a non-string estimationPath", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, estimationPath: 1 as unknown as "exact_bpe" })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a non-boolean stream", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, stream: 1 as unknown as boolean })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a non-boolean isToolUse", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, isToolUse: "false" as unknown as boolean })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a malformed outputMarker", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, outputMarker: "invalid_marker" })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a non-string outputMarker", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, outputMarker: 42 as unknown as string })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for invalid inputBytes semantic relationship", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, inputBytes: 11 })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined when inputTextBytes exceeds inputBytes", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, inputBytes: 10, inputTextBytes: 15, opaqueInputBytes: 0 })),
        1_048_576,
      ),
    ).toBeUndefined();
  });

  it("returns undefined when opaqueInputBytes exceeds inputBytes", () => {
    expect(
      parsePrepareMetadata(
        encodeBase64url(JSON.stringify({ ...validMetadata, inputBytes: 10, inputTextBytes: 0, opaqueInputBytes: 15 })),
        1_048_576,
      ),
    ).toBeUndefined();
  });
});