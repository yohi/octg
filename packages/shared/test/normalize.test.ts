import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_NORMALIZED_INPUT_BYTES,
  normalizeChatCompletions,
  normalizeResponses,
} from "../src/index";

describe("MAX_NORMALIZED_INPUT_BYTES", () => {
  it("defaults to one mebibyte for OpenCode-compatible request histories", () => {
    expect(MAX_NORMALIZED_INPUT_BYTES).toBe(1_048_576);
  });
});

describe("normalizeChatCompletions", () => {
  it.each([
    ["abc", 3],
    ["あ", 3],
  ])("reports normalized Chat input %s as %i UTF-8 bytes", (content, expectedBytes) => {
    // Given: Chat input with a hand-checked UTF-8 byte length.
    // When: the request is normalized at the exact byte boundary.
    const result = normalizeChatCompletions(
      { model: "gpt-5", messages: [{ role: "user", content }] },
      expectedBytes,
    );

    // Then: its byte count is exposed without rejecting the request.
    expect(result).toMatchObject({ ok: true, value: { inputBytes: expectedBytes } });
  });

  it("rejects multi-byte Chat input above the configured byte limit", () => {
    // Given: one Japanese character encoded as three UTF-8 bytes.
    // When: the configured input limit is only two bytes.
    const result = normalizeChatCompletions(
      { model: "gpt-5", messages: [{ role: "user", content: "あ" }] },
      2,
    );

    // Then: normalization rejects it before token estimation.
    expect(result).toEqual({ ok: false, error: "input_too_large" });
  });

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
        inputTextBytes: 29,
        inputBytes: 29,
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
        inputTextBytes: 2,
        inputBytes: 2,
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
        inputText: "hi\n[]",
        inputTextBytes: 5,
        inputBytes: 5,
        messageCount: 1,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        stream: false,
        isToolUse: true,
        opaqueInputBytes: 0,
      },
    });
  });

  it("rejects Chat tool declarations when their schema exceeds the input budget", () => {
    const result = normalizeChatCompletions(
      {
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "lookup", description: "schema" } }],
      },
      2,
    );

    expect(result).toEqual({ ok: false, error: "input_too_large" });
  });

  it("meters message-level tool calls against the input budget", () => {
    const result = normalizeChatCompletions(
      {
        model: "gpt-5",
        messages: [{
          role: "assistant",
          content: "",
          tool_calls: [{ type: "function", function: { name: "lookup", arguments: "x" } }],
        }],
      },
      2,
    );

    expect(result).toEqual({ ok: false, error: "input_too_large" });
  });

  it("classifies message-level tool history as tool use", () => {
    const result = normalizeChatCompletions({
      model: "gpt-5",
      messages: [{ role: "tool", content: "result", tool_call_id: "call_1" }],
    });

    expect(result).toMatchObject({ ok: true, value: { isToolUse: true } });
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
  it("separates visible text bytes from opaque reasoning bytes", () => {
    // Given: visible summary text and opaque encrypted reasoning state.
    const body = {
      model: "gpt-5",
      input: [{ type: "reasoning", summary: [{ type: "summary_text", text: "x" }], encrypted_content: "秘密" }],
    };

    // When: the Responses request is normalized.
    const result = normalizeResponses(body);

    // Then: total input bytes are the text bytes plus opaque bytes, exposed separately.
    expect(result).toMatchObject({
      ok: true,
      value: { inputTextBytes: 1, inputBytes: 7, opaqueInputBytes: 6 },
    });
  });

  it("includes opaque Responses bytes in the normalized input byte count", () => {
    // Given: one UTF-8 text byte plus six opaque UTF-8 bytes for encrypted content.
    const body = {
      model: "gpt-5",
      input: [{ type: "reasoning", summary: [{ type: "summary_text", text: "x" }], encrypted_content: "秘密" }],
    };

    // When: the request is normalized at the seven-byte total boundary.
    const result = normalizeResponses(body, 7);

    // Then: the text and opaque bytes are both reported.
    expect(result).toMatchObject({ ok: true, value: { inputBytes: 7, opaqueInputBytes: 6 } });
  });

  it("rejects Responses input when text and opaque bytes exceed the configured limit", () => {
    // Given: one UTF-8 text byte plus six opaque UTF-8 bytes for encrypted content.
    const body = {
      model: "gpt-5",
      input: [{ type: "reasoning", summary: [{ type: "summary_text", text: "x" }], encrypted_content: "秘密" }],
    };

    // When: the seven-byte total is normalized with a six-byte limit.
    const result = normalizeResponses(body, 6);

    // Then: normalization rejects it before token estimation.
    expect(result).toEqual({ ok: false, error: "input_too_large" });
  });

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
        inputTextBytes: 5,
        inputBytes: 5,
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
        inputTextBytes: 13,
        inputBytes: 13,
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
        inputTextBytes: 5,
        inputBytes: 5,
        messageCount: 1,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        stream: false,
        isToolUse: true,
        opaqueInputBytes: 0,
      },
    });
  });

  it("does not include null metadata in the normalized input text", () => {
    expect(
      normalizeResponses({
        model: "gpt-5",
        input: "hello",
        instructions: null,
        tools: null,
        tool_choice: null,
      }),
    ).toMatchObject({
      ok: true,
      value: { inputText: "hello" },
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
          { type: "function_call", call_id: "call_id-with-a-long-unique-value-1234567890", name: "lookup", arguments: "{}" },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        endpoint: "responses",
        model: "gpt-5",
        inputText: "hi\ncall_id-with-a-long-unique-value-1234567890\nlookup\n{}",
        inputTextBytes: 56,
        inputBytes: 56,
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
        { type: "function_call", call_id: "call_id-marker", name: "lookup-marker", arguments: "{\"city\":\"argument-marker\"}" },
        {
          type: "function_call_output",
          call_id: "call_id-output-marker",
          output: [
            { type: "input_text", text: "tool-output-array-marker-1" },
            { type: "input_text", text: "tool-output-array-marker-2" },
          ],
        },
        { type: "function_call_output", call_id: "call_id-string-output-marker", output: "tool-output-marker" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "summary-marker" }], encrypted_content: "opaque-marker" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "summary-marker-2" }], encrypted_content: "opaque-marker-2" },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        endpoint: "responses",
        inputText: expect.stringContaining("tool-output-marker"),
        messageCount: 7,
        isToolUse: true,
        opaqueInputBytes: 28,
      },
    });
    if (result.ok) {
      for (const marker of [
        "user-marker",
        "assistant-marker",
        "lookup-marker",
        "call_id-marker",
        "argument-marker",
        "call_id-output-marker",
        "tool-output-array-marker-1",
        "tool-output-array-marker-2",
        "call_id-string-output-marker",
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

  it("accepts SDK text parts for every supported message role", () => {
    const result = normalizeResponses({
      model: "gpt-5.6-luna",
      input: [
        { role: "user", content: [{ type: "text", text: "user-text" }] },
        { role: "developer", content: [{ type: "text", text: "developer-text" }] },
        { role: "system", content: [{ type: "text", text: "system-text" }] },
        { role: "assistant", content: [{ type: "text", text: "assistant-text" }] },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        inputText: "user-text\ndeveloper-text\nsystem-text\nassistant-text",
        messageCount: 4,
      },
    });
  });

  it("accepts top-level reasoning configuration without changing input accounting", () => {
    const result = normalizeResponses({
      model: "gpt-5.6-luna",
      reasoning: { effort: "medium" },
      input: "reasoning-config-marker",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        inputText: "reasoning-config-marker",
        opaqueInputBytes: 0,
      },
    });
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
    expect(normalizeResponses({ model: "gpt-5", previous_response_id: null, conversation: null, input: "hello" })).toMatchObject({
      ok: true,
      value: { inputText: "hello" },
    });
    expect(normalizeResponses({ model: "gpt-5", instructions: [{ type: "input_image", image_url: "https://example.invalid/a.png" }], input: "hello" })).toEqual({
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
