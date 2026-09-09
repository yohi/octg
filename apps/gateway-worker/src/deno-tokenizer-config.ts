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

export type DenoPrepareConfig =
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

export interface DenoRuntimeConfig {
  readonly tokenizer: DenoTokenizerConfig;
  readonly prepare: DenoPrepareConfig;
}

export function resolveDenoRuntimeConfig(env: {
  readonly MAX_INPUT_BYTES?: string;
  readonly DENO_TOKENIZER_ENDPOINT?: string;
  readonly DENO_TOKENIZER_AUTH_TOKEN?: string;
  readonly DENO_TOKENIZER_THRESHOLD_BYTES?: string;
  readonly DENO_TOKENIZER_TIMEOUT_MS?: string;
  readonly DENO_PREPARE_ENDPOINT?: string;
  readonly DENO_PREPARE_THRESHOLD_BYTES?: string;
}): DenoRuntimeConfig {
  const tokenizer = resolveDenoTokenizerConfig(env);
  const maxInputBytes = resolveMaxInputBytes(env.MAX_INPUT_BYTES);

  const prepareEndpoint = env.DENO_PREPARE_ENDPOINT;
  const prepareThreshold = env.DENO_PREPARE_THRESHOLD_BYTES;

  // Normalize empty-string placeholders to absent.
  const hasEndpoint = prepareEndpoint !== undefined && prepareEndpoint.trim().length > 0;
  const hasThreshold = prepareThreshold !== undefined && prepareThreshold.trim().length > 0;

  // Both prepare settings absent → disabled.
  if (!hasEndpoint && !hasThreshold) {
    return { tokenizer, prepare: { kind: "disabled", maxInputBytes } };
  }

  // If the tokenizer group is partial/invalid, its error is authoritative for both routes.
  // But the brief says: if tokenizer group is partial/invalid, the existing tokenizer
  // configuration error remains authoritative for both routes. So prepare is invalid too.
  if (tokenizer.kind === "invalid") {
    return { tokenizer, prepare: { kind: "invalid", maxInputBytes } };
  }

  // At this point tokenizer is either disabled or enabled.
  // Prepare pair is complete or partial/invalid.
  // A complete pair requires both endpoint and threshold present and valid.
  // If tokenizer is disabled but prepare pair is present (complete or partial), it's
  // a prepare configuration error (invalid) — Chat Completions stays on legacy DO tokenizer.
  // If tokenizer is enabled and prepare pair is complete+valid, prepare is enabled.
  // If tokenizer is enabled and prepare pair is partial or invalid, prepare is invalid
  // (Responses-only error, Chat Completions unchanged).

  // Partial pair (one present, one absent) → invalid.
  if (hasEndpoint !== hasThreshold) {
    return { tokenizer, prepare: { kind: "invalid", maxInputBytes } };
  }

  // Both present — validate.
  const prepareThresholdBytes = parseSafeInteger(prepareThreshold!);
  if (
    !isHttpsUrlWithoutCredentials(prepareEndpoint!) ||
    prepareThresholdBytes === undefined ||
    prepareThresholdBytes <= 0 ||
    prepareThresholdBytes > maxInputBytes
  ) {
    return { tokenizer, prepare: { kind: "invalid", maxInputBytes } };
  }

  // Complete and valid. Reuse tokenizer authToken and timeout.
  // But if tokenizer is disabled, there's no authToken/timeout to reuse.
  // The brief says prepare is enabled only when the existing tokenizer group is enabled
  // and both prepare settings are present and valid.
  // If tokenizer is disabled, prepare cannot be enabled even with a complete valid pair.
  if (tokenizer.kind !== "enabled") {
    return { tokenizer, prepare: { kind: "invalid", maxInputBytes } };
  }

  return {
    tokenizer,
    prepare: {
      kind: "enabled",
      endpoint: prepareEndpoint!,
      authToken: tokenizer.authToken,
      thresholdBytes: prepareThresholdBytes!,
      timeoutMs: tokenizer.timeoutMs,
      maxInputBytes,
    },
  };
}
