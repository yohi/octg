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
  opaqueInputBytes: number;
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
const CHAT_CONTENT_TYPES = new Set(["text", "input_text"]);
const RESPONSE_INPUT_CONTENT_TYPES = new Set(["input_text", "text"]);
const RESPONSE_OUTPUT_CONTENT_TYPES = new Set(["output_text", "text"]);

type ContentWalk = { ok: true; text: string } | { ok: false; error: NormalizeError };

function walkContent(content: unknown, allowedTypes: ReadonlySet<string>, unknownError: NormalizeError): ContentWalk {
  if (typeof content === "string") return { ok: true, text: content };
  if (!Array.isArray(content)) return { ok: false, error: unknownError };
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) return { ok: false, error: unknownError };
    const value = part as Record<string, unknown>;
    if (typeof value.type !== "string") return { ok: false, error: unknownError };
    if (NON_TEXT_PART_TYPES.has(value.type)) return { ok: false, error: "non_text" };
    if (!allowedTypes.has(value.type)) return { ok: false, error: unknownError };
    if (typeof value.text !== "string") return { ok: false, error: unknownError };
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
    const content = walkContent((message as Record<string, unknown>).content, CHAT_CONTENT_TYPES, "non_text");
    if (!content.ok) return content;
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
      opaqueInputBytes: 0,
    },
  };
}

export function normalizeResponses(body: unknown): NormalizeResult {
  if (typeof body !== "object" || body === null) return { ok: false, error: "invalid_body" };
  const value = body as Record<string, unknown>;
  if (typeof value.model !== "string" || value.model.length === 0 || value.input === undefined) {
    return { ok: false, error: "invalid_body" };
  }
  if (
    "item_reference" in value ||
    (value.previous_response_id !== undefined && value.previous_response_id !== null) ||
    (value.conversation !== undefined && value.conversation !== null) ||
    (value.instructions !== undefined && value.instructions !== null && typeof value.instructions !== "string")
  ) {
    return { ok: false, error: "invalid_body" };
  }

  let inputText: string;
  let messageCount: number;
  let isToolUse = false;
  let opaqueInputBytes = 0;
  const texts: string[] = [];
  const appendSerialized = (field: unknown): NormalizeResult | null => {
    if (field === undefined || field === null) return null;
    try {
      const serialized = JSON.stringify(field);
      if (serialized !== undefined) texts.push(serialized);
      return null;
    } catch {
      return { ok: false, error: "invalid_body" };
    }
  };
  const walkResponseMessage = (entry: Record<string, unknown>): NormalizeResult | null => {
    const role = entry.role;
    if (role !== "assistant" && role !== "developer" && role !== "system" && role !== "user") {
      return { ok: false, error: "invalid_body" };
    }
    const content = entry.content;
    if (typeof content === "string") {
      texts.push(content);
      return null;
    }
    const allowed = role === "assistant" ? RESPONSE_OUTPUT_CONTENT_TYPES : RESPONSE_INPUT_CONTENT_TYPES;
    const walked = walkContent(content, allowed, "invalid_body");
    if (!walked.ok) return walked.error === "non_text" ? walked : { ok: false, error: "invalid_body" };
    texts.push(walked.text);
    return null;
  };
  const walkToolOutput = (output: unknown): NormalizeResult | null => {
    if (typeof output === "string") {
      texts.push(output);
      return null;
    }
    const walked = walkContent(output, RESPONSE_INPUT_CONTENT_TYPES, "invalid_body");
    if (!walked.ok) return walked.error === "non_text" ? walked : { ok: false, error: "invalid_body" };
    texts.push(walked.text);
    return null;
  };
  if (typeof value.input === "string") {
    texts.push(value.input);
    messageCount = 1;
  } else if (Array.isArray(value.input)) {
    for (const item of value.input) {
      if (typeof item !== "object" || item === null) return { ok: false, error: "invalid_body" };
      const entry = item as Record<string, unknown>;
      switch (entry.type) {
        case undefined:
        case "message": {
          const result = walkResponseMessage(entry);
          if (result) return result;
          break;
        }
        case "function_call":
          if (typeof entry.call_id !== "string" || typeof entry.name !== "string" || typeof entry.arguments !== "string") {
            return { ok: false, error: "invalid_body" };
          }
          isToolUse = true;
          texts.push(entry.call_id, entry.name, entry.arguments);
          break;
        case "function_call_output": {
          if (typeof entry.call_id !== "string") return { ok: false, error: "invalid_body" };
          isToolUse = true;
          texts.push(entry.call_id);
          const result = walkToolOutput(entry.output);
          if (result) return result;
          break;
        }
        case "reasoning": {
          if (!Array.isArray(entry.summary) || typeof entry.encrypted_content !== "string") {
            return { ok: false, error: "invalid_body" };
          }
          for (const summaryPart of entry.summary) {
            if (typeof summaryPart !== "object" || summaryPart === null) return { ok: false, error: "invalid_body" };
            const summary = summaryPart as Record<string, unknown>;
            if (typeof summary.type === "string" && NON_TEXT_PART_TYPES.has(summary.type)) {
              return { ok: false, error: "non_text" };
            }
            if (summary.type !== "summary_text" || typeof summary.text !== "string") {
              return { ok: false, error: "invalid_body" };
            }
            texts.push(summary.text);
          }
          opaqueInputBytes += new TextEncoder().encode(entry.encrypted_content).length;
          break;
        }
        default:
          return { ok: false, error: "invalid_body" };
      }
    }
    messageCount = value.input.length;
  } else {
    return { ok: false, error: "invalid_body" };
  }

  for (const field of [value.instructions, value.tools, value.tool_choice]) {
    const result = appendSerialized(field);
    if (result) return result;
  }
  inputText = texts.join("\n");

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
      isToolUse: hasToolUse(value) || isToolUse,
      opaqueInputBytes,
    },
  };
}
