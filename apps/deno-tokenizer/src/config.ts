import { resolveMaxInputBytes } from "@octg/shared";

export interface DenoTokenizerServiceConfig {
  readonly authToken: string;
  readonly maxInputBytes: number;
  readonly maxRawBodyBytes: number;
}

export function resolveServiceConfig(
  readEnv: (name: string) => string | undefined,
): DenoTokenizerServiceConfig {
  const authToken = readEnv("OCTG_TOKENIZER_AUTH_TOKEN");
  if (authToken === undefined || authToken.length === 0) {
    throw new TypeError("Invalid Deno tokenizer configuration.");
  }

  const maxInputBytesRaw = readEnv("MAX_INPUT_BYTES");
  const normalizedMaxInputBytes = maxInputBytesRaw?.trim();
  if (
    normalizedMaxInputBytes === undefined ||
    !/^\d+$/.test(normalizedMaxInputBytes) ||
    !Number.isSafeInteger(Number(normalizedMaxInputBytes)) ||
    Number(normalizedMaxInputBytes) <= 0
  ) {
    throw new TypeError("Invalid Deno tokenizer configuration.");
  }
  const maxInputBytes = resolveMaxInputBytes(maxInputBytesRaw);

  const expectedMaxInputBytesRaw = readEnv("OCTG_EXPECTED_MAX_INPUT_BYTES");
  if (expectedMaxInputBytesRaw === undefined) {
    throw new TypeError("Invalid Deno tokenizer configuration.");
  }
  const expectedMaxInputBytes = Number(expectedMaxInputBytesRaw);
  if (
    !Number.isSafeInteger(expectedMaxInputBytes) ||
    expectedMaxInputBytes !== maxInputBytes
  ) {
    throw new TypeError("Invalid Deno tokenizer configuration.");
  }

  return {
    authToken,
    maxInputBytes,
    maxRawBodyBytes: (6 * maxInputBytes) + 16,
  };
}
