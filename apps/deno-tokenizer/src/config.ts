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

  const maxInputBytes = resolveMaxInputBytes(readEnv("MAX_INPUT_BYTES"));
  return {
    authToken,
    maxInputBytes,
    maxRawBodyBytes: (6 * maxInputBytes) + 16,
  };
}
