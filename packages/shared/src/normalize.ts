import { hasToolUse } from "./classify";

export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface NormalizedRequest {
  endpoint: "chat" | "responses";
  model: string;
  inputText: string;
  messageCount: number;
  maxOutputTokens: number;
  stream: boolean;
  isToolUse: boolean;
}

export type NormalizeError = "non_text" | "max_tokens_conflict" | "invalid_body";
export type NormalizeResult =
  | { ok: true; value: NormalizedRequest }
  | { ok: false; error: NormalizeError };

const NON_TEXT_PART_TYPES = new Set([
  "image_url",
  "input_image",
  "input_audio",
  "input_file",
  "audio",
  "video",
  "file",
]);

type ContentWalk = { ok: true; text: string } | { ok: false };

function walkContent(content: unknown): ContentWalk {
  if (typeof content === "string") return { ok: true, text: content };
  if (!Array.isArray(content)) return { ok: false };
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) return { ok: false };
    const value = part as Record<string, unknown>;
    if (typeof value.type !== "string") return { ok: false };
    if (NON_TEXT_PART_TYPES.has(value.type)) return { ok: false };
    if (value.type !== "text" && value.type !== "input_text") return { ok: false };
    if (typeof value.text !== "string") return { ok: false };
    texts.push(value.text);
  }
  return { ok: true, text: texts.join(" ") };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  const parsed = positiveInteger(value);
  return parsed === undefined ? "invalid" : parsed;
}

export function normalizeChatCompletions(body: unknown): NormalizeResult {
  if (typeof body !== "object" || body === null) return { ok: false, error: "invalid_body" };
  const value = body as Record<string, unknown>;
  if (typeof value.model !== "string" || value.model.length === 0 || !Array.isArray(value.messages)) {
    return { ok: false, error: "invalid_body" };
  }

  const maxCompletion = optionalPositiveInteger(value.max_completion_tokens);
  const maxLegacy = optionalPositiveInteger(value.max_tokens);
  if (maxCompletion === "invalid" || maxLegacy === "invalid") {
    return { ok: false, error: "invalid_body" };
  }
  if (maxCompletion !== undefined && maxLegacy !== undefined && maxCompletion !== maxLegacy) {
    return { ok: false, error: "max_tokens_conflict" };
  }

  const texts: string[] = [];
  for (const message of value.messages) {
    if (typeof message !== "object" || message === null) return { ok: false, error: "invalid_body" };
    const content = walkContent((message as Record<string, unknown>).content);
    if (!content.ok) return { ok: false, error: "non_text" };
    texts.push(content.text);
  }

  return {
    ok: true,
    value: {
      endpoint: "chat",
      model: value.model,
      inputText: texts.join("\n"),
      messageCount: value.messages.length,
      maxOutputTokens: maxCompletion ?? maxLegacy ?? DEFAULT_MAX_OUTPUT_TOKENS,
      stream: value.stream === true,
      isToolUse: hasToolUse(value),
    },
  };
}

export function normalizeResponses(body: unknown): NormalizeResult {
  if (typeof body !== "object" || body === null) return { ok: false, error: "invalid_body" };
  const value = body as Record<string, unknown>;
  if (typeof value.model !== "string" || value.model.length === 0 || value.input === undefined) {
    return { ok: false, error: "invalid_body" };
  }

  let inputText: string;
  let messageCount: number;
  let isToolUse = false;
  if (typeof value.input === "string") {
    inputText = value.input;
    messageCount = 1;
  } else if (Array.isArray(value.input)) {
    const texts: string[] = [];
    for (const item of value.input) {
      if (typeof item !== "object" || item === null) return { ok: false, error: "invalid_body" };
      const entry = item as Record<string, unknown>;
      if (entry.type === "function_call" || entry.type === "function_call_output") {
        isToolUse = true;
        continue;
      }
      const content = walkContent(entry.content);
      if (!content.ok) return { ok: false, error: "non_text" };
      texts.push(content.text);
    }
    inputText = texts.join("\n");
    messageCount = value.input.length;
  } else {
    return { ok: false, error: "invalid_body" };
  }

  if (value.max_output_tokens !== undefined && positiveInteger(value.max_output_tokens) === undefined) {
    return { ok: false, error: "invalid_body" };
  }

  return {
    ok: true,
    value: {
      endpoint: "responses",
      model: value.model,
      inputText,
      messageCount,
      maxOutputTokens:
        value.max_output_tokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : positiveInteger(value.max_output_tokens) ?? 0,
      stream: value.stream === true,
      isToolUse: Array.isArray(value.input) ? isToolUse : false,
    },
  };
}
