import { describe, expect, it } from "vitest";
import { classifyModel, hasToolUse, type RegistryEntry } from "../src/index";

const registry = new Map<string, RegistryEntry>([
  [
    "gpt-5",
    {
      model: "gpt-5",
      provider: "openai",
      complimentary_pool: "STANDARD",
      enabled: true,
      fallback_model: null,
      updated_at: "2026-08-09T00:00:00Z",
    },
  ],
  [
    "gpt-5-mini",
    {
      model: "gpt-5-mini",
      provider: "openai",
      complimentary_pool: "MINI",
      enabled: true,
      fallback_model: null,
      updated_at: "2026-08-09T00:00:00Z",
    },
  ],
  [
    "gpt-4o",
    {
      model: "gpt-4o",
      provider: "openai",
      complimentary_pool: "NONE",
      enabled: true,
      fallback_model: null,
      updated_at: "2026-08-09T00:00:00Z",
    },
  ],
  [
    "gpt-5-old",
    {
      model: "gpt-5-old",
      provider: "openai",
      complimentary_pool: "STANDARD",
      enabled: false,
      fallback_model: null,
      updated_at: "2026-08-09T00:00:00Z",
    },
  ],
]);

describe("classifyModel", () => {
  it("returns the configured complimentary pool for enabled registry models", () => {
    // Given: enabled STANDARD and MINI registry entries.
    // When: each model is classified.
    // Then: its configured complimentary pool is returned.
    expect(classifyModel("gpt-5", registry)).toBe("STANDARD");
    expect(classifyModel("gpt-5-mini", registry)).toBe("MINI");
  });

  it("returns NONE for an enabled paid-only registry model", () => {
    // Given: an enabled model with no complimentary pool.
    // When: it is classified.
    // Then: it remains paid-only.
    expect(classifyModel("gpt-4o", registry)).toBe("NONE");
  });

  it("returns NONE for an unknown model", () => {
    // Given: a model absent from the registry.
    // When: it is classified.
    // Then: unknown models fail closed to paid-only.
    expect(classifyModel("gpt-99-turbo", registry)).toBe("NONE");
  });

  it("returns NONE for a disabled model", () => {
    // Given: a registry model disabled by policy.
    // When: it is classified.
    // Then: it cannot use a complimentary pool.
    expect(classifyModel("gpt-5-old", registry)).toBe("NONE");
  });
});

describe("hasToolUse", () => {
  it("treats tools as paid-only when the key is present regardless of its value", () => {
    // Given: requests with present tools keys.
    // When: tool usage is detected.
    // Then: empty and undefined tool declarations are both paid-only.
    expect(hasToolUse({ model: "gpt-5", tools: [] })).toBe(true);
    expect(hasToolUse({ model: "gpt-5", tools: undefined })).toBe(true);
  });

  it("treats every legacy tool key as paid-only when present", () => {
    // Given: requests using each supported tool declaration key.
    // When: tool usage is detected.
    // Then: each request is marked paid-only.
    expect(hasToolUse({ tool_choice: "auto" })).toBe(true);
    expect(hasToolUse({ tool_choice: "none" })).toBe(true);
    expect(hasToolUse({ functions: [{ name: "f" }] })).toBe(true);
    expect(hasToolUse({ function_call: { name: "f" } })).toBe(true);
  });

  it("returns false when no tool declaration key is present", () => {
    // Given: ordinary chat and response requests.
    // When: tool usage is detected.
    // Then: neither is marked paid-only for tool use.
    expect(hasToolUse({ model: "gpt-5", messages: [] })).toBe(false);
    expect(hasToolUse({ model: "gpt-5", input: "hi" })).toBe(false);
  });
});
