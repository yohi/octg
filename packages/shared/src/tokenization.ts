import { MAX_NORMALIZED_INPUT_BYTES } from "./normalize.ts";

export const MAX_INPUT_TEXT_BYTES = 16 * 1024 * 1024 - 65_536;

export function resolveMaxInputBytes(
  configured: string | undefined,
): number {
  const parsed = Number(configured);
  const resolved = Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : MAX_NORMALIZED_INPUT_BYTES;
  return Math.min(resolved, MAX_INPUT_TEXT_BYTES);
}

export function estimatedInputTokensOf(args: {
  readonly baseTokenCount: number;
  readonly messageCount: number;
  readonly opaqueInputBytes: number;
}): number {
  const { baseTokenCount, messageCount, opaqueInputBytes } = args;
  const messageOverhead = messageCount * 4;
  const estimated = baseTokenCount + opaqueInputBytes + messageOverhead + 3;
  if (
    !Number.isSafeInteger(baseTokenCount) ||
    baseTokenCount < 0 ||
    !Number.isSafeInteger(messageCount) ||
    messageCount < 0 ||
    !Number.isSafeInteger(opaqueInputBytes) ||
    opaqueInputBytes < 0 ||
    !Number.isSafeInteger(messageOverhead) ||
    !Number.isSafeInteger(estimated) ||
    estimated < 0
  ) {
    throw new RangeError("Tokenizer arithmetic overflow.");
  }
  return estimated;
}
