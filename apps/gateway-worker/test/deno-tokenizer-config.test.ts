import { describe, expect, it } from "vitest";
import { resolveDenoRuntimeConfig, resolveDenoTokenizerConfig } from "../src/deno-tokenizer-config";

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
    ["DENO_TOKENIZER_AUTH_TOKEN", { DENO_TOKENIZER_AUTH_TOKEN: "test-secret" }],
    ["DENO_TOKENIZER_ENDPOINT", { DENO_TOKENIZER_ENDPOINT: "https://tokenizer.example/v1/tokenize" }],
    ["DENO_TOKENIZER_THRESHOLD_BYTES", { DENO_TOKENIZER_THRESHOLD_BYTES: "512" }],
    ["DENO_TOKENIZER_TIMEOUT_MS", { DENO_TOKENIZER_TIMEOUT_MS: "3000" }],
  ] as const)("returns invalid when only %s is present without other Deno settings", (_name, environment) => {
    // Given: an environment where only one Deno setting exists (e.g. a residual secret after baseline deploy).
    const config = resolveDenoTokenizerConfig({ MAX_INPUT_BYTES: "1024", ...environment });

    // Then: it fails closed as invalid.
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

const runtimeTokenizerComplete = {
  MAX_INPUT_BYTES: "1048576",
  DENO_TOKENIZER_ENDPOINT: "https://deno.test/tokenize",
  DENO_TOKENIZER_AUTH_TOKEN: "token",
  DENO_TOKENIZER_THRESHOLD_BYTES: "700000",
  DENO_TOKENIZER_TIMEOUT_MS: "25000",
} as const;

const runtimePrepareComplete = {
  ...runtimeTokenizerComplete,
  DENO_PREPARE_ENDPOINT: "https://deno.test/prepare",
  DENO_PREPARE_THRESHOLD_BYTES: "700000",
} as const;

describe("resolveDenoRuntimeConfig", () => {
  it("returns legacy DO tokenizer + prepare disabled when all Deno values are absent", () => {
    const config = resolveDenoRuntimeConfig({});

    expect(config.tokenizer).toEqual({ kind: "disabled", maxInputBytes: 1_048_576 });
    expect(config.prepare).toEqual({ kind: "disabled", maxInputBytes: 1_048_576 });
  });

  it("returns legacy Deno tokenizer + prepare disabled when tokenizer is enabled and prepare pair is absent", () => {
    const config = resolveDenoRuntimeConfig(runtimeTokenizerComplete);

    expect(config.tokenizer.kind).toBe("enabled");
    expect(config.prepare).toEqual({ kind: "disabled", maxInputBytes: 1_048_576 });
  });

  it("returns legacy Deno tokenizer + prepare enabled when both groups are complete and valid", () => {
    const config = resolveDenoRuntimeConfig(runtimePrepareComplete);

    expect(config.tokenizer.kind).toBe("enabled");
    expect(config.prepare).toMatchObject({
      kind: "enabled",
      endpoint: "https://deno.test/prepare",
      authToken: "token",
      thresholdBytes: 700000,
      timeoutMs: 25000,
      maxInputBytes: 1_048_576,
    });
  });

  it("returns existing tokenizer configuration error when tokenizer group is partial/invalid (prepare any)", () => {
    const config = resolveDenoRuntimeConfig({
      ...runtimePrepareComplete,
      DENO_TOKENIZER_ENDPOINT: "http://deno.test/tokenize",
    });

    expect(config.tokenizer).toEqual({ kind: "invalid", maxInputBytes: 1_048_576 });
    expect(config.prepare).toEqual({ kind: "invalid", maxInputBytes: 1_048_576 });
  });

  it("returns legacy DO tokenizer + prepare configuration error when tokenizer is disabled and prepare pair is complete", () => {
    const config = resolveDenoRuntimeConfig({
      DENO_PREPARE_ENDPOINT: "https://deno.test/prepare",
      DENO_PREPARE_THRESHOLD_BYTES: "700000",
    });

    expect(config.tokenizer).toEqual({ kind: "disabled", maxInputBytes: 1_048_576 });
    expect(config.prepare).toEqual({ kind: "invalid", maxInputBytes: 1_048_576 });
  });

  it("returns legacy DO tokenizer + prepare configuration error when tokenizer is disabled and prepare pair is partial", () => {
    const config = resolveDenoRuntimeConfig({
      DENO_PREPARE_ENDPOINT: "https://deno.test/prepare",
    });

    expect(config.tokenizer).toEqual({ kind: "disabled", maxInputBytes: 1_048_576 });
    expect(config.prepare).toEqual({ kind: "invalid", maxInputBytes: 1_048_576 });
  });

  it("returns legacy Deno tokenizer + prepare configuration error when tokenizer is enabled and prepare pair is partial", () => {
    const config = resolveDenoRuntimeConfig({
      ...runtimeTokenizerComplete,
      DENO_PREPARE_ENDPOINT: "https://deno.test/prepare",
    });

    expect(config.tokenizer.kind).toBe("enabled");
    expect(config.prepare).toEqual({ kind: "invalid", maxInputBytes: 1_048_576 });
  });

  it("returns legacy Deno tokenizer + prepare configuration error when only DENO_PREPARE_THRESHOLD_BYTES is present (partial)", () => {
    const config = resolveDenoRuntimeConfig({
      ...runtimeTokenizerComplete,
      DENO_PREPARE_THRESHOLD_BYTES: "700000",
    });

    expect(config.tokenizer.kind).toBe("enabled");
    expect(config.prepare).toEqual({ kind: "invalid", maxInputBytes: 1_048_576 });
  });

  it("treats empty-string prepare placeholder as absent (disabled)", () => {
    const config = resolveDenoRuntimeConfig({
      ...runtimeTokenizerComplete,
      DENO_PREPARE_ENDPOINT: "",
      DENO_PREPARE_THRESHOLD_BYTES: "",
    });

    expect(config.tokenizer.kind).toBe("enabled");
    expect(config.prepare).toEqual({ kind: "disabled", maxInputBytes: 1_048_576 });
  });

  const invalidPrepareCases = [
    {
      name: "an HTTP endpoint",
      overrides: {
        DENO_PREPARE_ENDPOINT: "http://deno.test/prepare",
        DENO_PREPARE_THRESHOLD_BYTES: "700000",
      },
    },
    {
      name: "endpoint credentials",
      overrides: {
        DENO_PREPARE_ENDPOINT: "https://user:pass@deno.test/prepare",
        DENO_PREPARE_THRESHOLD_BYTES: "700000",
      },
    },
    {
      name: "a zero threshold",
      overrides: {
        DENO_PREPARE_ENDPOINT: "https://deno.test/prepare",
        DENO_PREPARE_THRESHOLD_BYTES: "0",
      },
    },
    {
      name: "a threshold above maxInputBytes",
      overrides: {
        DENO_PREPARE_ENDPOINT: "https://deno.test/prepare",
        DENO_PREPARE_THRESHOLD_BYTES: "1048577",
      },
    },
    {
      name: "a fractional threshold",
      overrides: {
        DENO_PREPARE_ENDPOINT: "https://deno.test/prepare",
        DENO_PREPARE_THRESHOLD_BYTES: "1.5",
      },
    },
    {
      name: "an unsafe integer threshold",
      overrides: {
        DENO_PREPARE_ENDPOINT: "https://deno.test/prepare",
        DENO_PREPARE_THRESHOLD_BYTES: "9007199254740992",
      },
    },
  ] as const;

  it.each(invalidPrepareCases)(
    "returns prepare invalid for $name",
    ({ overrides }) => {
      const config = resolveDenoRuntimeConfig({
        ...runtimeTokenizerComplete,
        ...overrides,
      });

      expect(config.tokenizer.kind).toBe("enabled");
      expect(config.prepare).toEqual({ kind: "invalid", maxInputBytes: 1_048_576 });
    },
  );

  it("allows prepare threshold at the resolved input limit", () => {
    const config = resolveDenoRuntimeConfig({
      ...runtimeTokenizerComplete,
      DENO_PREPARE_ENDPOINT: "https://deno.test/prepare",
      DENO_PREPARE_THRESHOLD_BYTES: "1048576",
    });

    expect(config.tokenizer.kind).toBe("enabled");
    expect(config.prepare).toMatchObject({ kind: "enabled", thresholdBytes: 1_048_576 });
  });

  it("reuses DENO_TOKENIZER_AUTH_TOKEN and DENO_TOKENIZER_TIMEOUT_MS for prepare", () => {
    const config = resolveDenoRuntimeConfig(runtimePrepareComplete);

    if (config.prepare.kind !== "enabled") {
      throw new Error("prepare must be enabled");
    }
    expect(config.prepare.authToken).toBe("token");
    expect(config.prepare.timeoutMs).toBe(25000);
    expect(config.prepare.endpoint).toBe("https://deno.test/prepare");
  });

  it("does not change the tokenizer configuration when prepare is invalid", () => {
    const config = resolveDenoRuntimeConfig({
      ...runtimeTokenizerComplete,
      DENO_PREPARE_ENDPOINT: "http://deno.test/prepare",
      DENO_PREPARE_THRESHOLD_BYTES: "700000",
    });

    expect(config.tokenizer).toEqual({
      kind: "enabled",
      endpoint: "https://deno.test/tokenize",
      authToken: "token",
      thresholdBytes: 700000,
      timeoutMs: 25000,
      maxInputBytes: 1_048_576,
    });
  });
});
