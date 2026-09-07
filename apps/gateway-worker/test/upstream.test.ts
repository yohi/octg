import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { buildUpstreamBody, callUpstream, UpstreamConfigError, type UpstreamTransport } from "../src/upstream";

describe("callUpstream", () => {
  const meta = {
    client_id: "client_test",
    pool: "mini",
    eligibility: "COMPLIMENTARY",
    route: "free_shared",
    request_id: "req_test",
  } as const;

  it("rejects a base URL without the OpenAI provider path before transport", async () => {
    const transport = vi.fn<UpstreamTransport>().mockResolvedValue(new Response());
    const invalidEnv = new Proxy(env, {
      get(target, property, receiver) {
        return property === "OCTG_UPSTREAM_BASE_URL"
          ? "https://aigw.invalid"
          : Reflect.get(target, property, receiver);
      },
    });

    await expect(
      callUpstream(
        invalidEnv,
        "/chat/completions",
        {},
        meta,
        null,
        undefined,
        transport,
      ),
    ).rejects.toBeInstanceOf(UpstreamConfigError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects an unset base URL as an upstream configuration error", async () => {
    const transport = vi.fn<UpstreamTransport>().mockResolvedValue(new Response());
    const invalidEnv = new Proxy(env, {
      get(target, property, receiver) {
        return property === "OCTG_UPSTREAM_BASE_URL"
          ? undefined
          : Reflect.get(target, property, receiver);
      },
    });

    await expect(
      callUpstream(
        invalidEnv,
        "/chat/completions",
        {},
        meta,
        null,
        undefined,
        transport,
      ),
    ).rejects.toBeInstanceOf(UpstreamConfigError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("appends the chat endpoint after the OpenAI provider path", async () => {
    let requestedUrl: string | undefined;
    const transport: UpstreamTransport = async (input) => {
      requestedUrl = String(input);
      return new Response();
    };

    await callUpstream(env, "/chat/completions", {}, meta, null, undefined, transport);

    expect(requestedUrl).toBe("https://aigw.invalid/openai/chat/completions");
  });
});

describe("buildUpstreamBody", () => {
  it("normalizes chat body in-place with max_completion_tokens and stream options", () => {
    const body: Record<string, unknown> = {
      model: "gpt-4o",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    };
    const result = buildUpstreamBody("chat", body, 2048);
    expect(result).toBe(body);
    expect(result.max_tokens).toBeUndefined();
    expect(result.max_completion_tokens).toBe(2048);
    expect(result.stream_options).toEqual({ include_usage: true });
  });

  it("does not add stream_options when stream is not true", () => {
    const body: Record<string, unknown> = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    };
    const result = buildUpstreamBody("chat", body, 1024);
    expect(result).toBe(body);
    expect(result.max_completion_tokens).toBe(1024);
    expect(result.stream_options).toBeUndefined();
  });

  it("normalizes responses body with max_output_tokens", () => {
    const body: Record<string, unknown> = {
      model: "gpt-4o",
      input: ["hi"],
    };
    const result = buildUpstreamBody("responses", body, 512);
    expect(result.max_output_tokens).toBe(512);
  });
});

