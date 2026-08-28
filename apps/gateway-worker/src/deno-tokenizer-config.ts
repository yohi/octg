import { resolveMaxInputBytes } from "@octg/shared";

const MAX_TIMEOUT_MS = 2_147_483_647;

export type DenoTokenizerConfig =
  | { readonly kind: "disabled"; readonly maxInputBytes: number }
  | { readonly kind: "invalid"; readonly maxInputBytes: number }
  | {
      readonly kind: "enabled";
      readonly endpoint: string;
      readonly authToken: string;
      readonly thresholdBytes: number;
      readonly timeoutMs: number;
      readonly maxInputBytes: number;
    };

export function resolveDenoTokenizerConfig(env: {
  readonly MAX_INPUT_BYTES?: string;
  readonly DENO_TOKENIZER_ENDPOINT?: string;
  readonly DENO_TOKENIZER_AUTH_TOKEN?: string;
  readonly DENO_TOKENIZER_THRESHOLD_BYTES?: string;
  readonly DENO_TOKENIZER_TIMEOUT_MS?: string;
}): DenoTokenizerConfig {
  const maxInputBytes = resolveMaxInputBytes(env.MAX_INPUT_BYTES);
  const endpoint = env.DENO_TOKENIZER_ENDPOINT;
  const authToken = env.DENO_TOKENIZER_AUTH_TOKEN;
  const threshold = env.DENO_TOKENIZER_THRESHOLD_BYTES;
  const timeout = env.DENO_TOKENIZER_TIMEOUT_MS;

  if (endpoint === undefined && authToken === undefined && threshold === undefined && timeout === undefined) {
    return { kind: "disabled", maxInputBytes };
  }

  if (endpoint === undefined || authToken === undefined || threshold === undefined || timeout === undefined) {
    return { kind: "invalid", maxInputBytes };
  }

  const thresholdBytes = parseSafeInteger(threshold);
  const timeoutMs = parseSafeInteger(timeout);
  if (
    !isHttpsUrlWithoutCredentials(endpoint) ||
    authToken.trim().length === 0 ||
    thresholdBytes === undefined ||
    thresholdBytes <= 0 ||
    thresholdBytes > maxInputBytes ||
    timeoutMs === undefined ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    return { kind: "invalid", maxInputBytes };
  }

  return { kind: "enabled", endpoint, authToken, thresholdBytes, timeoutMs, maxInputBytes };
}

function isHttpsUrlWithoutCredentials(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function parseSafeInteger(value: string): number | undefined {
  if (value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
