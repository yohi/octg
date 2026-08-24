import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { callUpstream, UpstreamConfigError, type UpstreamTransport } from "../src/upstream";

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
