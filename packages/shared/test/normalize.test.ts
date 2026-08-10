import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  normalizeChatCompletions,
  normalizeResponses,
} from "../src/index";

describe("normalizeChatCompletions", () => {
  it("flattens text content and prefers matching max_completion_tokens", () => {
    // Given: a multi-message text request with both compatible output limits.
    // When: it is normalized.
    // Then: text and the preferred completion limit are preserved.
    const result = normalizeChatCompletions({
      model: "gpt-5",
      messages: [
        { role: "system", content: "You are helpful." },
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: " world" },
          ],
        },
      ],
      max_tokens: 100,
      max_completion_tokens: 100,
      stream: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        endpoint: "chat",
        model: "gpt-5",
        inputText: "You are helpful.\nHello  world",
        messageCount: 2,
        maxOutputTokens: 100,
        stream: true,
        isToolUse: false,
      },
    });
  });

  it("uses the safe default maximum output when none is supplied", () => {
    // Given: a text chat request without an output limit.
    // When: it is normalized.
    // Then: a reservable default output limit is injected.
    const result = normalizeChatCompletions({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        endpoint: "chat",
        model: "gpt-5",
        inputText: "hi",
        messageCount: 1,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        stream: false,
        isToolUse: false,
      },
    });
  });

  it("rejects conflicting legacy and completion output limits", () => {
    // Given: two distinct chat output limits.
    // When: the request is normalized.
    // Then: it fails before reservation.
    expect(
      normalizeChatCompletions({
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        max_completion_tokens: 200,
      }),
    ).toEqual({ ok: false, error: "max_tokens_conflict" });
  });

  it("rejects malformed output limits instead of silently applying the default", () => {
    expect(
      normalizeChatCompletions({
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 0,
      }),
    ).toEqual({ ok: false, error: "invalid_body" });
  });

  it("rejects non-text chat content before token estimation", () => {
    // Given: a chat request containing an image part.
    // When: the request is normalized.
    // Then: the unsupported modality is rejected.
    expect(
      normalizeChatCompletions({
        model: "gpt-5",
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }],
          },
        ],
      }),
    ).toEqual({ ok: false, error: "non_text" });
  });

  it("marks chat requests with tool declarations as paid-only", () => {
    // Given: a chat request with an empty tools declaration.
    // When: it is normalized.
    // Then: the request retains the paid-only routing signal.
    const result = normalizeChatCompletions({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        endpoint: "chat",
        model: "gpt-5",
        inputText: "hi",
        messageCount: 1,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        stream: false,
        isToolUse: true,
      },
    });
  });

  it("rejects a missing model as an invalid body", () => {
    // Given: a chat body without a model.
    // When: it is normalized.
    // Then: the malformed body is rejected.
    expect(normalizeChatCompletions({ messages: [] })).toEqual({
      ok: false,
      error: "invalid_body",
    });
  });
});

describe("normalizeResponses", () => {
  it("accepts string input and max_output_tokens", () => {
    // Given: a text responses request with an explicit output limit.
    // When: it is normalized.
    // Then: its text and limit are ready for reservation.
    expect(
      normalizeResponses({ model: "gpt-5", input: "hello", max_output_tokens: 50 }),
    ).toEqual({
      ok: true,
      value: {
        endpoint: "responses",
        model: "gpt-5",
        inputText: "hello",
        messageCount: 1,
        maxOutputTokens: 50,
        stream: false,
        isToolUse: false,
      },
    });
  });

  it("rejects image and audio response content before token estimation", () => {
    // Given: response requests containing image and audio parts.
    // When: each request is normalized.
    // Then: unsupported modalities are rejected.
    expect(
      normalizeResponses({
        model: "gpt-5",
        input: [
          {
            role: "user",
            content: [{ type: "input_image", image_url: "https://x/y.png" }],
          },
        ],
      }),
    ).toEqual({ ok: false, error: "non_text" });
    expect(
      normalizeResponses({
        model: "gpt-5",
        input: [
          {
            role: "user",
            content: [{ type: "input_audio", input_audio: { data: "AA", format: "mp3" } }],
          },
        ],
      }),
    ).toEqual({ ok: false, error: "non_text" });
  });

  it("marks response function-call items as paid-only without stringifying input", () => {
    // Given: a response input sequence containing a function-call item.
    // When: it is normalized.
    // Then: tool routing is detected structurally.
    expect(
      normalizeResponses({
        model: "gpt-5",
        input: [
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "function_call", name: "lookup" },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        endpoint: "responses",
        model: "gpt-5",
        inputText: "hi",
        messageCount: 2,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        stream: false,
        isToolUse: true,
      },
    });
  });
});
