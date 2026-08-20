import { env, SELF } from "cloudflare:test";
import type { TokenizeRequest } from "@octg/tokenizer-controller";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

const inputText = "The quick brown fox jumps over the lazy dog.\n".repeat(7_400);

const controller = () => env.TOKENIZER_CONTROLLER.get(
  env.TOKENIZER_CONTROLLER.idFromName("tokenizer:primary"),
);

const gatewayRequest = () => SELF.fetch("https://octg.test/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
  body: JSON.stringify({
    model: "gpt-5",
    messages: [{ role: "user", content: inputText }],
    max_completion_tokens: 1,
  }),
});

function eventValues(calls: readonly unknown[][], name: string): Record<string, unknown>[] {
  return calls.flatMap(([value]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    return Reflect.get(value, "event") === name ? [value as Record<string, unknown>] : [];
  });
}

describe("74k tokenizer regression", () => {
  beforeEach(async () => {
    await seedClient();
  });

  it("returns the exact BPE count through the real Durable Object", async () => {
    const request: TokenizeRequest = {
      requestId: "req_tokenizer_74k_direct",
      inputText,
      messageCount: 1,
      opaqueInputBytes: 0,
    };

    await expect(controller().tokenize(request)).resolves.toEqual({
      estimatedInputTokens: 74_007,
      estimationPath: "exact_bpe",
    });
  }, 30_000);

  it("uses the real Durable Object before quota reservation", async () => {
    const tokenizerLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const resourceLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ usage: { total_tokens: 1 } }), { status: 200 }));

    const response = await gatewayRequest();

    const tokenizerEvents = eventValues(tokenizerLog.mock.calls, "octg.tokenizer_stage");
    const resourceEvents = eventValues(resourceLog.mock.calls, "octg.resource_stage");
    const tokenizeFinish = resourceEvents.findIndex((event) =>
      event.stage === "tokenize" && event.phase === "finish" && event.outcome === "success",
    );
    const reserveStart = resourceEvents.findIndex((event) =>
      event.stage === "quota_reserve" && event.phase === "start",
    );

    expect(response.status).toBe(200);
    expect(tokenizerEvents.length).toBeGreaterThan(0);
    expect(tokenizeFinish).toBeGreaterThanOrEqual(0);
    expect(reserveStart).toBeGreaterThan(tokenizeFinish);
  }, 30_000);
});
