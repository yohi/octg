import { env, SELF } from "cloudflare:test";
import { estimateInputTokens, MAX_NORMALIZED_INPUT_BYTES, safetyMargin } from "@octg/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMaxInputBytes } from "../src/proxy";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

beforeEach(async () => {
  await seedClient();
  vi.restoreAllMocks();
});

const stub = () => {
  const day = new Date().toISOString().slice(0, 10);
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
};
const request = () => SELF.fetch("https://octg.test/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
  body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 100 }),
});

describe("resolveMaxInputBytes", () => {
  it("defaults to one mebibyte", () => {
    expect(resolveMaxInputBytes(undefined)).toBe(1_048_576);
  });

  it.each([undefined, "", "0", "-1", "1.5", "not-a-number", "9007199254740992"])(
    "falls back to the default for invalid value %s",
    (configuredLimit) => {
      // Given: an unset, non-integer, non-positive, or unsafe input limit.
      // When: the Worker configuration boundary resolves it.
      const resolved = resolveMaxInputBytes(configuredLimit);

      // Then: the approved default is used.
      expect(resolved).toBe(MAX_NORMALIZED_INPUT_BYTES);
    },
  );

  it("preserves a configured positive safe integer", () => {
    // Given: a positive safe integer input limit.
    // When: the Worker configuration boundary resolves it.
    const resolved = resolveMaxInputBytes("2");

    // Then: the configured limit is preserved.
    expect(resolved).toBe(2);
  });
});

describe("proxy failure paths", () => {
  it("rejects a saturated pool before upstream contact without consuming quota", async () => {
    const controller = stub();
    expect(await controller.acquireInFlight("occupied-one", 2)).toEqual({ ok: true });
    expect(await controller.acquireInFlight("occupied-two", 2)).toEqual({ ok: true });
    try {
      const before = await controller.getState();
      let upstreamCallCount = 0;
      vi.stubGlobal("fetch", async () => {
        upstreamCallCount += 1;
        return new Response(JSON.stringify({ usage: { total_tokens: 1 } }), { status: 200 });
      });

      const response = await request();

      expect(response.status).toBe(429);
      expect(response.headers.get("X-OCTG-Route")).toBe("reject:worker_concurrency");
      expect(await response.json()).toMatchObject({ error: { code: "worker_concurrency_exceeded" } });
      expect(upstreamCallCount).toBe(0);
      expect(await controller.getState()).toMatchObject({
        reservedTokens: before.reservedTokens,
        confirmedTokens: before.confirmedTokens,
        uncertainTokens: before.uncertainTokens,
      });
    } finally {
      await controller.releaseInFlight("occupied-one");
      await controller.releaseInFlight("occupied-two");
    }
  });

  it("rejects an oversized raw body before JSON parsing", async () => {
    const original = Object.getOwnPropertyDescriptor(env, "MAX_INPUT_BYTES");
    Object.defineProperty(env, "MAX_INPUT_BYTES", { value: "2", configurable: true });
    const before = await stub().getState();
    let upstreamCallCount = 0;
    vi.stubGlobal("fetch", async () => {
      upstreamCallCount += 1;
      return new Response(JSON.stringify({ usage: { total_tokens: 1 } }), { status: 200 });
    });

    try {
      const response = await SELF.fetch("https://octg.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
        body: "abc",
      });

      expect(response.status).toBe(413);
      expect(response.headers.get("X-OCTG-Route")).toBe("reject:request_too_large");
      expect(upstreamCallCount).toBe(0);
      expect(await stub().getState()).toMatchObject({
        requestCount: before.requestCount,
        reservedTokens: before.reservedTokens,
      });
    } finally {
      if (original) Object.defineProperty(env, "MAX_INPUT_BYTES", original);
      else Reflect.deleteProperty(env, "MAX_INPUT_BYTES");
    }
  });

  it.each([
    ["Chat", "/v1/chat/completions", { model: "gpt-5", messages: [{ role: "user", content: "あ" }] }],
    ["Responses", "/v1/responses", { model: "gpt-5", input: "あ" }],
  ] as const)("rejects oversized %s input before quota reservation or upstream fetch", async (_name, path, body) => {
    // Given: an authenticated request whose three UTF-8 input bytes exceed a two-byte limit.
    const original = Object.getOwnPropertyDescriptor(env, "MAX_INPUT_BYTES");
    Object.defineProperty(env, "MAX_INPUT_BYTES", { value: "2", configurable: true });
    const before = await stub().getState();
    let upstreamCallCount = 0;
    vi.stubGlobal("fetch", async () => {
      upstreamCallCount += 1;
      return new Response(JSON.stringify({ usage: { total_tokens: 1 } }), { status: 200 });
    });

    try {
      // When: the request crosses the Worker HTTP boundary.
      const response = await SELF.fetch(`https://octg.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
        body: JSON.stringify(body),
      });

      // Then: the existing 413 contract is returned without consuming quota or reaching upstream.
      expect(response.status).toBe(413);
      expect(response.headers.get("X-OCTG-Route")).toBe("reject:request_too_large");
      expect(await response.json()).toMatchObject({ error: { code: "request_too_large" } });
      expect(upstreamCallCount).toBe(0);
      expect(await stub().getState()).toMatchObject({
        confirmedTokens: before.confirmedTokens,
        reservedTokens: before.reservedTokens,
        uncertainTokens: before.uncertainTokens,
        requestCount: before.requestCount,
        remaining: before.remaining,
      });
    } finally {
      if (original) Object.defineProperty(env, "MAX_INPUT_BYTES", original);
      else Reflect.deleteProperty(env, "MAX_INPUT_BYTES");
    }
  });

  it("counts Responses opaque reasoning bytes once in the reservation", async () => {
    // Given: a Responses request with visible summary text and encrypted reasoning state.
    const before = await stub().getState();
    const inputText = "visible-summary";
    const opaqueInputBytes = new TextEncoder().encode("秘密状態").byteLength;
    const maxOutputTokens = 10;
    const estimatedInput = estimateInputTokens(inputText, 1, opaqueInputBytes);
    const margin = safetyMargin(estimatedInput, before.remaining / before.limit);
    const expectedReservation = estimatedInput + maxOutputTokens + margin;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "upstream" } }), { status: 500 }));

    // When: the request passes through normalization, estimation, and reservation.
    const response = await SELF.fetch("https://octg.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
      body: JSON.stringify({
        model: "gpt-5",
        input: [{ type: "reasoning", summary: [{ type: "summary_text", text: inputText }], encrypted_content: "秘密状態" }],
        max_output_tokens: maxOutputTokens,
      }),
    });

    // Then: the uncertain reservation contains the opaque bytes exactly once.
    const after = await stub().getState();
    expect(response.status).toBe(500);
    expect(after.uncertainTokens - before.uncertainTokens).toBe(expectedReservation);
  });

  it("marks upstream 5xx as uncertain and passes through the body", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "upstream" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }));
    const response = await request();
    expect(response.status).toBe(500);
    expect((await stub().getState()).uncertainTokens).toBeGreaterThan(0);
  });

  it("releases a reservation for upstream 4xx other than timeout and rate limit", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "invalid_request" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    const before = await stub().getState();
    const response = await request();
    const after = await stub().getState();
    expect(response.status).toBe(400);
    expect(after.reservedTokens).toBe(before.reservedTokens);
    expect(after.uncertainTokens).toBe(before.uncertainTokens);
  });

  it("marks network failure as uncertain", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    const response = await request();
    expect(response.status).toBe(500);
    expect((await stub().getState()).uncertainTokens).toBeGreaterThan(0);
  });

  it("releases a reservation when upstream configuration is missing", async () => {
    const original = env.OCTG_UPSTREAM_API_TOKEN;
    Object.defineProperty(env, "OCTG_UPSTREAM_API_TOKEN", { value: "", configurable: true });
    const before = await stub().getState();
    const response = await request();
    Object.defineProperty(env, "OCTG_UPSTREAM_API_TOKEN", { value: original, configurable: true });
    expect(response.status).toBe(500);
    const after = await stub().getState();
    expect(after.reservedTokens).toBe(before.reservedTokens);
  });

  it("marks a successful response without usage as uncertain", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "missing-usage" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const response = await request();
    expect(response.status).toBe(200);
    expect((await stub().getState()).uncertainTokens).toBeGreaterThan(0);
  });

  it("persists the reservation amount for reconciliation", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "missing-usage" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await request();
    const row = await env.DB.prepare("SELECT reserved_tokens, status FROM requests ORDER BY started_at DESC LIMIT 1").first<{ reserved_tokens: number; status: string }>();
    expect(row?.reserved_tokens).toBeGreaterThan(0);
    expect(row?.status).toBe("uncertain");
  });
});
