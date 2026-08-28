import { describe, expect, it } from "vitest";
import { resolveDenoTokenizerConfig } from "../src/deno-tokenizer-config";

const complete = {
  MAX_INPUT_BYTES: "1024",
  DENO_TOKENIZER_ENDPOINT: "https://tokenizer.example/v1/tokenize",
  DENO_TOKENIZER_AUTH_TOKEN: "test-secret",
  DENO_TOKENIZER_THRESHOLD_BYTES: "512",
  DENO_TOKENIZER_TIMEOUT_MS: "3000",
} as const;

describe("resolveDenoTokenizerConfig", () => {
  it("returns disabled when all Deno tokenizer values are absent", () => {
    // Given: no Deno tokenizer integration values.
    const environment = {};

    // When: the optional configuration is resolved.
    const config = resolveDenoTokenizerConfig(environment);

    // Then: the integration remains disabled with the shared default input limit.
    expect(config).toEqual({ kind: "disabled", maxInputBytes: 1_048_576 });
  });

  it("keeps the integration disabled when only MAX_INPUT_BYTES is invalid", () => {
    // Given: an invalid general input limit but no Deno integration values.
    const environment = { MAX_INPUT_BYTES: "invalid" };

    // When: the optional configuration is resolved.
    const config = resolveDenoTokenizerConfig(environment);

    // Then: MAX_INPUT_BYTES falls back independently without enabling the integration.
    expect(config).toEqual({ kind: "disabled", maxInputBytes: 1_048_576 });
  });

  it("returns enabled for a complete valid configuration", () => {
    // Given: every Deno tokenizer value is valid.
    const environment = complete;

    // When: the optional configuration is resolved.
    const config = resolveDenoTokenizerConfig(environment);

    // Then: the resolved configuration retains the validated values.
    expect(config).toEqual({
      kind: "enabled",
      endpoint: "https://tokenizer.example/v1/tokenize",
      authToken: "test-secret",
      thresholdBytes: 512,
      timeoutMs: 3000,
      maxInputBytes: 1024,
    });
  });

  it.each([
    ["DENO_TOKENIZER_ENDPOINT", {
      MAX_INPUT_BYTES: "1024",
      DENO_TOKENIZER_AUTH_TOKEN: "test-secret",
      DENO_TOKENIZER_THRESHOLD_BYTES: "512",
      DENO_TOKENIZER_TIMEOUT_MS: "3000",
    }],
    ["DENO_TOKENIZER_AUTH_TOKEN", {
      MAX_INPUT_BYTES: "1024",
      DENO_TOKENIZER_ENDPOINT: "https://tokenizer.example/v1/tokenize",
      DENO_TOKENIZER_THRESHOLD_BYTES: "512",
      DENO_TOKENIZER_TIMEOUT_MS: "3000",
    }],
    ["DENO_TOKENIZER_THRESHOLD_BYTES", {
      MAX_INPUT_BYTES: "1024",
      DENO_TOKENIZER_ENDPOINT: "https://tokenizer.example/v1/tokenize",
      DENO_TOKENIZER_AUTH_TOKEN: "test-secret",
      DENO_TOKENIZER_TIMEOUT_MS: "3000",
    }],
    ["DENO_TOKENIZER_TIMEOUT_MS", {
      MAX_INPUT_BYTES: "1024",
      DENO_TOKENIZER_ENDPOINT: "https://tokenizer.example/v1/tokenize",
      DENO_TOKENIZER_AUTH_TOKEN: "test-secret",
      DENO_TOKENIZER_THRESHOLD_BYTES: "512",
    }],
  ] as const)("returns invalid when %s is absent", (_name, environment) => {
    // Given: an integration configuration with one missing required value.

    // When: the optional configuration is resolved.
    const config = resolveDenoTokenizerConfig(environment);

    // Then: it fails closed while preserving the independently resolved limit.
    expect(config).toEqual({ kind: "invalid", maxInputBytes: 1024 });
  });

  it.each([
    ["an HTTP endpoint", { ...complete, DENO_TOKENIZER_ENDPOINT: "http://tokenizer.example/v1/tokenize" }],
    ["endpoint credentials", { ...complete, DENO_TOKENIZER_ENDPOINT: "https://user:password@tokenizer.example/v1/tokenize" }],
    ["an empty endpoint", { ...complete, DENO_TOKENIZER_ENDPOINT: "" }],
    ["an empty auth token", { ...complete, DENO_TOKENIZER_AUTH_TOKEN: "" }],
    ["an empty threshold", { ...complete, DENO_TOKENIZER_THRESHOLD_BYTES: "" }],
    ["a zero threshold", { ...complete, DENO_TOKENIZER_THRESHOLD_BYTES: "0" }],
    ["a threshold above max input bytes", { ...complete, DENO_TOKENIZER_THRESHOLD_BYTES: "1025" }],
    ["a fractional threshold", { ...complete, DENO_TOKENIZER_THRESHOLD_BYTES: "1.5" }],
    ["an unsafe threshold", { ...complete, DENO_TOKENIZER_THRESHOLD_BYTES: "9007199254740992" }],
    ["an empty timeout", { ...complete, DENO_TOKENIZER_TIMEOUT_MS: "" }],
    ["a fractional timeout", { ...complete, DENO_TOKENIZER_TIMEOUT_MS: "1.5" }],
    ["an unsafe timeout", { ...complete, DENO_TOKENIZER_TIMEOUT_MS: "9007199254740992" }],
    ["a timeout above the platform limit", { ...complete, DENO_TOKENIZER_TIMEOUT_MS: "2147483648" }],
    ["a zero timeout", { ...complete, DENO_TOKENIZER_TIMEOUT_MS: "0" }],
  ] as const)("returns invalid for %s", (_description, environment) => {
    // Given: every integration value is present but one is invalid.

    // When: the optional configuration is resolved.
    const config = resolveDenoTokenizerConfig(environment);

    // Then: it fails closed without exposing configuration details.
    expect(config).toEqual({ kind: "invalid", maxInputBytes: 1024 });
  });

  it("allows threshold bytes at the resolved input limit", () => {
    // Given: a threshold exactly at the resolved input limit.
    const environment = { ...complete, DENO_TOKENIZER_THRESHOLD_BYTES: "1024" };

    // When: the optional configuration is resolved.
    const config = resolveDenoTokenizerConfig(environment);

    // Then: the inclusive threshold boundary is enabled.
    expect(config).toMatchObject({ kind: "enabled", thresholdBytes: 1024, maxInputBytes: 1024 });
  });
});
