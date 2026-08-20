import { describe, expect, it } from "vitest";

type RawGlob = <Value>(
  patterns: readonly string[],
  options: { eager: true; import: "default"; query: "?raw" },
) => Record<string, Value>;

const productionSources = (import.meta as ImportMeta & { readonly glob: RawGlob }).glob<string>(
  ["../src/**/*.ts", "../../apps/gateway-worker/src/**/*.ts"],
  { eager: true, import: "default", query: "?raw" },
);

describe("Tokenizer dependency isolation", () => {
  it("keeps BPE ownership out of shared and Gateway production source", () => {
    const forbidden = [/js-tiktoken/, /getEncoding\(/, /encoding\.encode\(/];

    for (const [file, content] of Object.entries(productionSources)) {
      for (const pattern of forbidden) expect(content, file).not.toMatch(pattern);
    }
  });

  it("does not export estimateInputTokens from shared", async () => {
    const shared = await import("../src/index");
    expect(Object.hasOwn(shared, "estimateInputTokens")).toBe(false);
  });
});
