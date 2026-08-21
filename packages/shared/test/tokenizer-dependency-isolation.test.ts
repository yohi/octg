import { describe, expect, it } from "vitest";

type RawGlob = <Value>(
  patterns: readonly string[],
  options: { eager: true; import: "default"; query: "?raw" },
) => Record<string, Value>;

const gatewaySources = (import.meta as ImportMeta & { readonly glob: RawGlob }).glob<string>(
  [
    "../src/**/*.ts",
    "../../../apps/gateway-worker/src/**/*.ts",
  ],
  { eager: true, import: "default", query: "?raw" },
);
const tokenizerSources = (import.meta as ImportMeta & { readonly glob: RawGlob }).glob<string>(
  ["../../../durable-objects/tokenizer-controller/src/**/*.ts"],
  { eager: true, import: "default", query: "?raw" },
);

describe("Tokenizer dependency isolation", () => {
  it("keeps BPE ownership out of shared and Gateway production source", () => {
    const forbidden = [/from ["']js-tiktoken["']/, /getEncoding\(/, /encoding\.encode\(/];

    for (const [file, content] of Object.entries(gatewaySources)) {
      for (const pattern of forbidden) expect(content, file).not.toMatch(pattern);
    }
  });

  it("uses the lite tokenizer entrypoint for the isolated BPE owner", () => {
    const source = Object.values(tokenizerSources).join("\n");

    expect(source).not.toMatch(/from ["']js-tiktoken["']/);
    expect(source).not.toMatch(/from ["']tiktoken["']/);
    expect(source).toMatch(/from ["']tiktoken\/lite(?:\/init)?["']/);
  });

  it("does not export estimateInputTokens from shared", async () => {
    const shared = await import("../src/index");
    expect(Object.hasOwn(shared, "estimateInputTokens")).toBe(false);
  });
});
