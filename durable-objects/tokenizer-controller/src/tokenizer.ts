import { getEncoding, type Tiktoken } from "js-tiktoken";

let encoding: Tiktoken | undefined;

export function estimateInputTokens(text: string, messageCount: number, opaqueInputBytes = 0): number {
  let base: number;
  try {
    encoding ??= getEncoding("o200k_base");
    base = encoding.encode(text).length;
  } catch {
    base = new TextEncoder().encode(text).length;
  }
  return base + opaqueInputBytes + 4 * messageCount + 3;
}
