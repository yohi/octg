import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedClient, seedPolicy, TEST_CLIENT_ID, TEST_CLIENT_KEY } from "./seed";
import { invalidateConfigCaches } from "../src/policy";

beforeEach(async () => {
  await seedClient();
  vi.restoreAllMocks();
});

const todayStub = () => {
  const day = new Date().toISOString().slice(0, 10);
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
};

const authed = (body: unknown, key = TEST_CLIENT_KEY) =>
  SELF.fetch("https://octg.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

const authedResponses = (body: unknown, key = TEST_CLIENT_KEY) =>
  SELF.fetch("https://octg.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

describe("proxy pipeline", () => {
  it("settles actual usage and returns quota headers", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      id: "chatcmpl-1",
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const response = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 100 });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-OCTG-Pool")).toBe("standard");
    expect(response.headers.get("X-OCTG-Route")).toBe("free_shared");
    const state = await todayStub().getState();
    expect(state.confirmedTokens).toBe(150);
    expect(state.reservedTokens).toBe(0);
  });

  it("normalizes upstream output and sends AI Gateway controls", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    let upstreamHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      upstreamHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ usage: { total_tokens: 10 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const response = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_tokens: 200 });
    expect(response.status).toBe(200);
    expect(upstreamBody?.max_completion_tokens).toBeTypeOf("number");
    expect(upstreamBody?.max_tokens).toBeUndefined();
    expect(upstreamHeaders?.get("cf-aig-max-attempts")).toBe("2");
    expect(upstreamHeaders?.get("cf-aig-metadata")).toContain("client_test");
    expect(upstreamHeaders?.get("cf-aig-cache-key")).toBeNull();
    expect(upstreamHeaders?.get("cf-aig-authorization")).toBe("Bearer test-upstream-token");
    expect(upstreamHeaders?.get("cf-aig-collect-log-payload")).toBe("false");
    expect(upstreamHeaders?.get("authorization")).toBeNull();
    expect(upstreamHeaders?.get("Idempotency-Key")).toBeNull();
  });

  it("accepts Idempotency-Key while sending AI Gateway controls", async () => {
    let upstreamHeaders: Headers | undefined;
    let upstreamMetadata: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamHeaders = new Headers(init?.headers);
      upstreamMetadata = JSON.parse(upstreamHeaders.get("cf-aig-metadata") ?? "{}") as Record<string, unknown>;
      return new Response(JSON.stringify({ usage: { total_tokens: 10 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const response = await SELF.fetch("https://octg.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_CLIENT_KEY}`,
        "Idempotency-Key": "idem-test-1",
      },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(200);
    expect(upstreamHeaders?.get("cf-aig-max-attempts")).toBe("2");
    expect(upstreamHeaders?.get("cf-aig-authorization")).toBe("Bearer test-upstream-token");
    expect(upstreamHeaders?.get("Idempotency-Key")).toBe("idem-test-1");
    expect(upstreamMetadata?.idempotency_key).toBeUndefined();
  });

  it("forwards Idempotency-Key to Gateway B upstream", async () => {
    let upstreamHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ usage: { total_tokens: 10 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await SELF.fetch("https://octg.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_CLIENT_KEY}`,
        "Idempotency-Key": "idem-upstream-1",
      },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(200);
    expect(upstreamHeaders?.get("Idempotency-Key")).toBe("idem-upstream-1");
  });

  it("retries a released Idempotency-Key through upstream", async () => {
    let upstreamCallCount = 0;
    vi.stubGlobal("fetch", async () => {
      upstreamCallCount += 1;
      return new Response(JSON.stringify({ error: { code: "invalid_request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const request = {
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
    };
    const send = () => SELF.fetch("https://octg.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_CLIENT_KEY}`,
        "Idempotency-Key": "idem-released-retry-1",
      },
      body: JSON.stringify(request),
    });

    const first = await send();
    const second = await send();

    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    expect(upstreamCallCount).toBe(2);
  });

  it("rejects a completed duplicate Idempotency-Key without calling upstream again", async () => {
    // Given: an upstream response with billable usage and one idempotency key.
    let upstreamCallCount = 0;
    vi.stubGlobal("fetch", async () => {
      upstreamCallCount += 1;
      return new Response(JSON.stringify({
        id: "chatcmpl-idempotent",
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const request = {
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 100,
    };
    const send = () => SELF.fetch("https://octg.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_CLIENT_KEY}`,
        "Idempotency-Key": "idem-completed-duplicate-1",
      },
      body: JSON.stringify(request),
    });

    // When: the completed request is delivered again with the same key.
    const first = await send();
    const second = await send();

    // Then: only the first delivery reaches upstream and consumes quota.
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.headers.get("X-OCTG-Pool")).toBe("mini");
    expect(second.headers.get("X-OCTG-Route")).toBe("reject:duplicate_idempotency_key");
    const conflictRequestId = second.headers.get("X-OCTG-Request-Id");
    expect(await second.json()).toEqual({
      error: {
        message: "Duplicate Idempotency-Key.",
        type: "invalid_request_error",
        param: null,
        code: "duplicate_idempotency_key",
      },
      request_id: conflictRequestId,
    });
    expect(upstreamCallCount).toBe(1);
    const day = new Date().toISOString().slice(0, 10);
    const mini = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:MINI:${day}`));
    expect((await mini.getState()).confirmedTokens).toBe(150);
  });

  it("rejects tool requests by default before reservation", async () => {
    const unknown = await authed({ model: "gpt-99", messages: [{ role: "user", content: "hi" }] });
    expect(unknown.status).toBe(403);
    expect((await unknown.json()) as { error: { code: string } }).toMatchObject({ error: { code: "model_requires_paid" } });
    const tools = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(tools.status).toBe(403);
    expect((await tools.json()) as { error: { code: string } }).toMatchObject({ error: { code: "model_not_allowed" } });
  });

  it("allows tool requests when client policy toolsMode is ALLOW", async () => {
    await seedPolicy(TEST_CLIENT_ID, { toolsMode: "ALLOW" });
    invalidateConfigCaches();
    const stateBefore = await todayStub().getState();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      id: "chatcmpl-tool",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const response = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "test" } }] });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-OCTG-Pool")).toBe("standard");
    expect(response.headers.get("X-OCTG-Route")).toBe("free_shared");
    const state = await todayStub().getState();
    expect(state.confirmedTokens - stateBefore.confirmedTokens).toBe(15);
    expect(state.reservedTokens).toBe(0);
  });

  it("rejects non-text and conflicting max token requests", async () => {
    const image = await authed({ model: "gpt-5", messages: [{ role: "user", content: [{ type: "image_url" }] }] });
    expect(image.status).toBe(400);
    const conflict = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_tokens: 1, max_completion_tokens: 2 });
    expect(conflict.status).toBe(400);
    expect((await conflict.json()) as { error: { param: string } }).toMatchObject({ error: { param: "max_tokens" } });
  });

  it("supports CLAMP policy", async () => {
    await seedPolicy(TEST_CLIENT_ID, { outputLimitMode: "CLAMP" });
    invalidateConfigCaches();
    const state = todayStub();
    await state.reserve("seed-clamp", 900_000, 900_000);
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { max_completion_tokens: number };
      expect(body.max_completion_tokens).toBeLessThan(500_000);
      return new Response(JSON.stringify({ usage: { total_tokens: 10 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const response = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 500_000 });
    expect(response.status).toBe(200);
  });

  it("applies CLAMP policy stored via admin API end-to-end", async () => {
    await seedPolicy(TEST_CLIENT_ID, { outputLimitMode: "CLAMP" });
    invalidateConfigCaches();
    const state = todayStub();
    await state.reserve("seed-admin-clamp", 900_000, 900_000);
    let seenMaxCompletionTokens: number | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { max_completion_tokens: number };
      seenMaxCompletionTokens = body.max_completion_tokens;
      return new Response(JSON.stringify({ usage: { total_tokens: 10 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const response = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 500_000 });
    expect(response.status).toBe(200);
    expect(seenMaxCompletionTokens).toBeDefined();
    expect(seenMaxCompletionTokens).toBeLessThan(500_000);
    expect(seenMaxCompletionTokens).toBeGreaterThan(0);
  });

  it("supports the responses endpoint with usage settlement", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "resp-1",
        usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const response = await SELF.fetch("https://octg.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
      body: JSON.stringify({ model: "gpt-5", input: "hi", max_output_tokens: 10 }),
    });
    expect(response.status).toBe(200);
    expect(upstreamBody?.max_output_tokens).toBe(10);
    const body = (await response.json()) as { usage: { total_tokens: number } };
    expect(body.usage.total_tokens).toBe(10);
  });

  it("rejects composite Responses tool history before reservation when tools are not allowed", async () => {
    await seedPolicy(TEST_CLIENT_ID, { toolsMode: "REJECT" });
    invalidateConfigCaches();
    const before = await todayStub().getState();
    let upstreamCallCount = 0;
    vi.stubGlobal("fetch", async () => {
      upstreamCallCount += 1;
      return new Response(JSON.stringify({ usage: { total_tokens: 10 } }), { status: 200 });
    });

    const response = await authedResponses({
      model: "gpt-5",
      store: false,
      instructions: "instructions-marker",
      tools: [{ type: "function", name: "tool-name-marker", description: "schema-marker", parameters: { type: "object", properties: {} } }],
      tool_choice: { type: "function", name: "choice-marker" },
      input: [
        { role: "user", content: [{ type: "input_text", text: "user-marker" }] },
        { role: "assistant", content: [{ type: "output_text", text: "assistant-marker" }] },
        { type: "function_call", call_id: "call_1", name: "lookup-marker", arguments: "{\"city\":\"argument-marker\"}" },
        { type: "function_call_output", call_id: "call_1", output: "tool-output-marker" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "summary-marker" }], encrypted_content: "opaque-marker" },
      ],
      max_output_tokens: 64,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "model_not_allowed", param: "model" } });
    expect(upstreamCallCount).toBe(0);
    expect(await todayStub().getState()).toEqual(before);
  });

  it("forwards the complete allowed Responses tool history unchanged", async () => {
    await seedPolicy(TEST_CLIENT_ID, { toolsMode: "ALLOW" });
    invalidateConfigCaches();
    const originalBody = {
      model: "gpt-5",
      store: false,
      instructions: "instructions-marker",
      tools: [{ type: "function", name: "tool-name-marker", description: "schema-marker", parameters: { type: "object", properties: {} } }],
      tool_choice: { type: "function", name: "choice-marker" },
      input: [
        { role: "user", content: [{ type: "input_text", text: "user-marker" }] },
        { role: "assistant", content: [{ type: "output_text", text: "assistant-marker" }] },
        { type: "function_call", call_id: "call_1", name: "lookup-marker", arguments: "{\"city\":\"argument-marker\"}" },
        { type: "function_call_output", call_id: "call_1", output: "tool-output-marker" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "summary-marker" }], encrypted_content: "opaque-marker" },
      ],
      max_output_tokens: 64,
    };
    let upstreamBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ usage: { total_tokens: 10 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const before = await todayStub().getState();

    const response = await authedResponses(originalBody);

    expect(response.status).toBe(200);
    expect(upstreamBody).toEqual({ ...originalBody, max_output_tokens: 64 });
    const after = await todayStub().getState();
    expect(after.confirmedTokens).toBeGreaterThan(before.confirmedTokens);
    expect(after.reservedTokens).toBe(before.reservedTokens);
    expect(after.uncertainTokens).toBe(before.uncertainTokens);
  });

  it("rejects unsupported Responses tool output and external references before reservation", async () => {
    await seedPolicy(TEST_CLIENT_ID, { toolsMode: "ALLOW" });
    invalidateConfigCaches();
    const before = await todayStub().getState();
    let upstreamCallCount = 0;
    vi.stubGlobal("fetch", async () => {
      upstreamCallCount += 1;
      return new Response(JSON.stringify({ usage: { total_tokens: 10 } }), { status: 200 });
    });

    const imageResponse = await authedResponses({
      model: "gpt-5",
      input: [{ type: "function_call_output", call_id: "call_1", output: [{ type: "input_file", file_id: "file_1" }] }],
    });
    expect(imageResponse.status).toBe(400);
    expect(await imageResponse.json()).toMatchObject({ error: { code: "invalid_request", param: "input" } });

    for (const field of ["item_reference", "previous_response_id", "conversation"] as const) {
      const body = field === "item_reference"
        ? { model: "gpt-5", input: [{ type: "item_reference", id: "resp_123" }] }
        : { model: "gpt-5", input: "hello", [field]: "state_123" };
      const response = await authedResponses(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request", param: null } });
    }

    expect(upstreamCallCount).toBe(0);
    expect(await todayStub().getState()).toEqual(before);
  });
});
