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
        opaqueInputBytes: 0,
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
        opaqueInputBytes: 0,
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
        opaqueInputBytes: 0,
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
        opaqueInputBytes: 0,
      },
    });
  });

  it("does not classify literal function_call text as tool use", () => {
    expect(normalizeResponses({ model: "gpt-5", input: "function_call" })).toEqual({
      ok: true,
      value: {
        endpoint: "responses",
        model: "gpt-5",
        inputText: "function_call",
        messageCount: 1,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        stream: false,
        isToolUse: false,
        opaqueInputBytes: 0,
      },
    });
  });

  it("marks top-level response tool declarations as paid-only", () => {
    expect(normalizeResponses({ model: "gpt-5", input: "hi", tools: [] })).toEqual({
      ok: true,
      value: {
        endpoint: "responses",
        model: "gpt-5",
        inputText: "hi\n[]",
        messageCount: 1,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        stream: false,
        isToolUse: true,
        opaqueInputBytes: 0,
      },
    });
  });

  it.each([0, -1, 1.5, "50"]) (
    "rejects explicitly invalid max_output_tokens: %s",
    (maxOutputTokens) => {
      expect(normalizeResponses({ model: "gpt-5", input: "hello", max_output_tokens: maxOutputTokens })).toEqual({
        ok: false,
        error: "invalid_body",
      });
    },
  );

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
          { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        endpoint: "responses",
        model: "gpt-5",
        inputText: "hi\nlookup\n{}",
        messageCount: 2,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        stream: false,
        isToolUse: true,
        opaqueInputBytes: 0,
      },
    });
  });

  it("accepts role-aware text history and meters tool and reasoning fields", () => {
    const result = normalizeResponses({
      model: "gpt-5.6-luna",
      instructions: "instructions-marker",
      tools: [{ type: "function", name: "tool-name-marker", description: "schema-marker", parameters: { type: "object", properties: {} } }],
      tool_choice: { type: "function", name: "choice-marker" },
      input: [
        { role: "user", content: [{ type: "input_text", text: "user-marker" }] },
        { role: "assistant", content: [{ type: "output_text", text: "assistant-marker" }] },
        { type: "function_call", call_id: "call_1", name: "lookup-marker", arguments: "{\"city\":\"argument-marker\"}" },
        { type: "function_call_output", call_id: "call_1", output: "tool-output-marker" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "summary-marker" }], encrypted_content: "opaque-marker" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "summary-marker-2" }], encrypted_content: "opaque-marker-2" },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        endpoint: "responses",
        inputText: expect.stringContaining("tool-output-marker"),
        messageCount: 6,
        isToolUse: true,
        opaqueInputBytes: 28,
      },
    });
    if (result.ok) {
      for (const marker of [
        "user-marker",
        "assistant-marker",
        "lookup-marker",
        "argument-marker",
        "tool-output-marker",
        "summary-marker",
        "summary-marker-2",
        "instructions-marker",
        "tool-name-marker",
        "schema-marker",
        "choice-marker",
      ]) {
        expect(result.value.inputText).toContain(marker);
      }
    }
  });

  it("rejects output_text for non-assistant messages", () => {
    expect(
      normalizeResponses({
        model: "gpt-5.6-luna",
        input: [{ role: "user", content: [{ type: "output_text", text: "not-input" }] }],
      }),
    ).toEqual({ ok: false, error: "invalid_body" });
  });

  it("rejects unmeterable references and multimodal tool output", () => {
    expect(normalizeResponses({ model: "gpt-5", input: [{ type: "item_reference", id: "resp_123" }] })).toEqual({
      ok: false,
      error: "invalid_body",
    });
    expect(normalizeResponses({ model: "gpt-5", previous_response_id: "resp_123", input: "hello" })).toEqual({
      ok: false,
      error: "invalid_body",
    });
    expect(normalizeResponses({ model: "gpt-5", conversation: "conv_123", input: "hello" })).toEqual({
      ok: false,
      error: "invalid_body",
    });
    expect(
      normalizeResponses({
        model: "gpt-5",
        input: [{ type: "function_call_output", call_id: "call_1", output: [{ type: "input_image", image_url: "https://example.invalid/a.png" }] }],
      }),
    ).toEqual({ ok: false, error: "non_text" });
    expect(
      normalizeResponses({
        model: "gpt-5",
        input: [{ type: "unknown_item", content: [{ type: "input_text", text: "must-not-pass" }] }],
      }),
    ).toEqual({ ok: false, error: "invalid_body" });
    expect(
      normalizeResponses({
        model: "gpt-5",
        input: [{ type: "reasoning", summary: [{ type: "input_image", image_url: "https://example.invalid/a.png" }], encrypted_content: "opaque" }],
      }),
    ).toEqual({ ok: false, error: "non_text" });
  });
});
