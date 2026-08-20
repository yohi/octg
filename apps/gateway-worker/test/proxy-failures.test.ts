import { env, SELF } from "cloudflare:test";
import { MAX_INPUT_TEXT_BYTES } from "@octg/tokenizer-controller";
import {
  MAX_NORMALIZED_INPUT_BYTES,
  safetyMargin,
  type InFlightLease,
} from "@octg/shared";
import type { QuotaController } from "@octg/quota-controller";
import type { TokenizerController } from "@octg/tokenizer-controller";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  releaseInFlightBestEffort,
  resolveInFlightLeaseRenewalMs,
  resolveInFlightLeaseTtlMs,
  resolveMaxInputBytes,
} from "../src/proxy";
import { estimateRpcPayloadSize } from "../src/tokenizer";
import type { InFlightLeaseReleaser } from "../src/proxy";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

beforeEach(async () => {
  await seedClient();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

function jsonRequestByteSize(request: {
  readonly requestId: string;
  readonly inputText: string;
  readonly messageCount: number;
  readonly opaqueInputBytes: number;
}): number {
  return new TextEncoder().encode(JSON.stringify(request)).byteLength;
}

const MAX_TOKENIZATION_RPC_INPUT_BYTES = MAX_INPUT_TEXT_BYTES;
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

      // Then: the approved default is used, capped by the RPC ceiling.
      expect(resolved).toBe(Math.min(MAX_NORMALIZED_INPUT_BYTES, MAX_TOKENIZATION_RPC_INPUT_BYTES));
    },
  );

  it("preserves a configured positive safe integer", () => {
    // Given: a positive safe integer input limit.
    // When: the Worker configuration boundary resolves it.
    const resolved = resolveMaxInputBytes("2");

    // Then: The configured limit is preserved.
    expect(resolved).toBe(2);
  });

  it("caps resolved limit at the RPC serialization ceiling", () => {
    // Given: a configured limit larger than the 32 MiB RPC ceiling.
    // When: the Worker configuration boundary resolves it.
    const resolved = resolveMaxInputBytes(String(40 * 1024 * 1024));

    // Then: the value is clamped to the serialization-aware ceiling.
    expect(resolved).toBe(MAX_TOKENIZATION_RPC_INPUT_BYTES);
  });

  it("uses the configured limit exactly at the RPC ceiling", () => {
    // Given: a configured limit equal to the RPC ceiling.
    const resolved = resolveMaxInputBytes(String(MAX_TOKENIZATION_RPC_INPUT_BYTES));

    // Then: the configured value is preserved.
    expect(resolved).toBe(MAX_TOKENIZATION_RPC_INPUT_BYTES);
  });

  it("rejects one byte over the RPC ceiling", () => {
    // Given: a configured limit one byte above the RPC ceiling.
    const resolved = resolveMaxInputBytes(String(MAX_TOKENIZATION_RPC_INPUT_BYTES + 1));

    // Then: it is clamped to the ceiling.
    expect(resolved).toBe(MAX_TOKENIZATION_RPC_INPUT_BYTES);
  });

  it("guarantees a ceiling TokenizeRequest serializes below 32 MiB", () => {
    // Given: the largest inputs normalization can emit.
    const maxInputBytes = resolveMaxInputBytes(String(MAX_TOKENIZATION_RPC_INPUT_BYTES));
    const requestId = "req_0123456789ABCDEFGHJKMNPQRS"; // 29 characters, matching ULID format
    const messageCount = Number.MAX_SAFE_INTEGER; // worst-case decimal length
    const inputText = "a".repeat(maxInputBytes); // inputText occupies the entire ceiling
    const opaqueInputBytes = 0; // chat-style: all bytes are in inputText

    // When: the helper serializes the request.
    const size = jsonRequestByteSize({
      requestId,
      inputText,
      messageCount,
      opaqueInputBytes,
    });

    // Then: the serialized request stays strictly below 32 MiB.
    expect(size).toBeLessThan(32 * 1024 * 1024);
  });

  it("guarantees a split ceiling TokenizeRequest stays below 32 MiB under V8 UTF-16 worst case", () => {
    // Given: the largest normalized input, split between visible text and opaque bytes.
    const maxInputBytes = resolveMaxInputBytes(String(MAX_TOKENIZATION_RPC_INPUT_BYTES));
    const requestId = "req_0123456789ABCDEFGHJKMNPQRS";
    const messageCount = Number.MAX_SAFE_INTEGER;
    const opaqueInputBytes = 1;
    const inputText = "a".repeat(maxInputBytes - opaqueInputBytes);

    // When: the V8 worst-case payload size is estimated.
    const size = estimateRpcPayloadSize({
      requestId,
      inputText,
      messageCount,
      opaqueInputBytes,
    });

    // Then: the serialized request stays strictly below 32 MiB.
    expect(size).toBeLessThan(32 * 1024 * 1024);
  });

  it("guarantees a ceiling TokenizeRequest stays below 32 MiB under V8 UTF-16 worst case", () => {
    // Given: the largest ASCII input normalization can emit. In V8 serialization an
    // all-ASCII string may be encoded as UTF-16 (2 bytes/code unit), doubling the
    // wire size compared to its UTF-8 byte length.
    const maxInputBytes = resolveMaxInputBytes(String(MAX_TOKENIZATION_RPC_INPUT_BYTES));
    const requestId = "req_0123456789ABCDEFGHJKMNPQRS";
    const messageCount = Number.MAX_SAFE_INTEGER;
    const inputText = "a".repeat(maxInputBytes);
    const opaqueInputBytes = 0;

    // When: the V8 worst-case payload size is estimated.
    const size = estimateRpcPayloadSize({
      requestId,
      inputText,
      messageCount,
      opaqueInputBytes,
    });

    // Then: the estimated RPC payload stays strictly below 32 MiB.
    expect(size).toBeLessThan(32 * 1024 * 1024);
  });

  it("guarantees JSON-escaped input still serializes below 32 MiB", () => {
    // Given: a ceiling input where every character requires JSON escaping. Even
    // though actual DO RPC uses V8/Cap'n Proto (no escaping), this ensures the
    // JSON.stringify approximation used in earlier checks remains an upper bound.
    const maxInputBytes = resolveMaxInputBytes(String(MAX_TOKENIZATION_RPC_INPUT_BYTES));
    const requestId = "req_0123456789ABCDEFGHJKMNPQRS";
    const messageCount = Number.MAX_SAFE_INTEGER;
    const inputText = '\\"'.repeat(Math.floor(maxInputBytes / 2));
    const opaqueInputBytes = 0;

    // When: the request is serialized as JSON.
    const size = jsonRequestByteSize({
      requestId,
      inputText,
      messageCount,
      opaqueInputBytes,
    });

    // Then: the JSON representation stays strictly below 32 MiB.
    expect(size).toBeLessThan(32 * 1024 * 1024);
  });

  it("guarantees a ceiling TokenizeRequest with multibyte UTF-8 serializes below 32 MiB", () => {
    // Given: a ceiling input consisting of non-ASCII characters. UTF-8 byte length
    // differs from UTF-16 code unit count, so this checks the combined size bound.
    const maxInputBytes = resolveMaxInputBytes(String(MAX_TOKENIZATION_RPC_INPUT_BYTES));
    const requestId = "req_0123456789ABCDEFGHJKMNPQRS";
    const messageCount = Number.MAX_SAFE_INTEGER;
    // "あ" is 3 bytes in UTF-8 and 1 UTF-16 code unit.
    const inputText = "あ".repeat(Math.floor(maxInputBytes / 3));
    const opaqueInputBytes = 0;

    // When: the request is serialized as JSON and as V8 worst-case.
    const jsonSize = jsonRequestByteSize({
      requestId,
      inputText,
      messageCount,
      opaqueInputBytes,
    });
    const v8Size = estimateRpcPayloadSize({
      requestId,
      inputText,
      messageCount,
      opaqueInputBytes,
    });

    // Then: both estimates stay strictly below 32 MiB.
    expect(jsonSize).toBeLessThan(32 * 1024 * 1024);
    expect(v8Size).toBeLessThan(32 * 1024 * 1024);
  });

});

describe("in-flight lease timing configuration", () => {
  it.each([
    [resolveInFlightLeaseTtlMs, 120_000],
    [resolveInFlightLeaseRenewalMs, 30_000],
  ] as const)("falls back to the safe default for invalid binding values", (resolveTiming, defaultMs) => {
    // Given: unset, non-integer, non-positive, and unsafe environment bindings.
    const invalidBindings = [undefined, "", "0", "-1", "1.5", "not-a-number", "9007199254740992"];

    // When: each binding crosses the Worker configuration boundary.
    const resolved = invalidBindings.map(resolveTiming);

    // Then: every invalid value resolves to the documented safe default.
    expect(resolved).toEqual(invalidBindings.map(() => defaultMs));
  });

  it("floors low TTL values at the headroom-protected minimum", () => {
    // Given: a TTL one millisecond below the 120-second safe minimum.
    // When: the Worker resolves the lease TTL configuration.
    const resolved = resolveInFlightLeaseTtlMs("119999");

    // Then: the lease retains scheduling and RPC headroom above upstream processing.
    expect(resolved).toBe(120_000);
  });

  it("caps oversized renewal intervals at the documented default", () => {
    // Given: a renewal interval larger than the safe default.
    const renewalMs = resolveInFlightLeaseRenewalMs("60000");

    // Then: streaming renews on the documented 30-second cadence.
    expect(renewalMs).toBe(30_000);
  });
});

describe("proxy failure paths", () => {
  it("uses the acquired lease generation for outer error cleanup", async () => {
    // Given: outer cleanup owns a generation-bearing lease and a narrow RPC releaser.
    const releaseInFlight = vi.fn<InFlightLeaseReleaser["releaseInFlight"]>().mockResolvedValue({
      ok: true,
      released: true,
    });
    const controller = {
      releaseInFlight,
    } satisfies InFlightLeaseReleaser;
    const lease = {
      requestId: "req_outer_cleanup",
      generation: "lease-generation",
      expiresAtMs: 123_456,
    } satisfies InFlightLease;

    // When: the outer cleanup helper releases its owned lease.
    await releaseInFlightBestEffort(controller, lease);

    // Then: the release call carries the exact owned generation.
    expect(releaseInFlight).toHaveBeenCalledWith("req_outer_cleanup", "lease-generation");
  });

  it("continues quota and upstream flow when the D1 audit insert fails", async () => {
    const prepare = env.DB.prepare.bind(env.DB);
    const insertFailure = {
      bind: vi.fn(() => insertFailure),
      run: vi.fn().mockRejectedValue(new Error("D1 unavailable")),
    } as unknown as D1PreparedStatement;
    vi.spyOn(env.DB, "prepare").mockImplementation((query) =>
      query.startsWith("INSERT INTO requests") ? insertFailure : prepare(query));
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ usage: { total_tokens: 7 } }), { status: 200 }));
    const before = await stub().getState();

    const response = await request();
    const after = await stub().getState();

    expect(response.status).toBe(200);
    expect(after.confirmedTokens - before.confirmedTokens).toBe(7);
  });

  it("keeps Durable Object settlement authoritative when D1 completion fails", async () => {
    const prepare = env.DB.prepare.bind(env.DB);
    const completionFailure = {
      bind: vi.fn(() => completionFailure),
      run: vi.fn().mockRejectedValue(new Error("D1 unavailable")),
    } as unknown as D1PreparedStatement;
    vi.spyOn(env.DB, "prepare").mockImplementation((query) =>
      query.startsWith("UPDATE requests SET status") ? completionFailure : prepare(query));
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ usage: { total_tokens: 11 } }), { status: 200 }));
    const before = await stub().getState();

    const response = await request();
    const after = await stub().getState();

    expect(response.status).toBe(200);
    expect(after.confirmedTokens - before.confirmedTokens).toBe(11);
    expect(after.reservedTokens).toBe(before.reservedTokens);
  });

  it("propagates a Worker-generated ULID request ID", async () => {
    // Given: an unauthenticated request sent through the Worker entrypoint.
    // When: the Worker rejects the request before proxy processing.
    const response = await SELF.fetch("https://octg.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    // Then: every response representation uses the same Worker-generated ULID request ID.
    const requestId = response.headers.get("X-OCTG-Request-Id");
    const body = await response.json() as { request_id: string };
    expect(requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.request_id).toBe(requestId);
  });

  it("rejects a saturated pool before upstream contact without consuming quota", async () => {
    const controller = stub();
    const firstLease = await controller.acquireInFlight("occupied-one", 2);
    const secondLease = await controller.acquireInFlight("occupied-two", 2);
    expect(firstLease).toMatchObject({ ok: true, lease: { requestId: "occupied-one" } });
    expect(secondLease).toMatchObject({ ok: true, lease: { requestId: "occupied-two" } });
    if (!firstLease.ok || !secondLease.ok) {
      throw new TypeError("Expected both in-flight leases to be acquired.");
    }
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
      await controller.releaseInFlight("occupied-one", firstLease.lease.generation);
      await controller.releaseInFlight("occupied-two", secondLease.lease.generation);
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
    const visibleSummaryTokens = 2;
    const estimatedInput = visibleSummaryTokens + opaqueInputBytes + 4 + 3;
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

  it("fails closed with a tokenizer-specific resource route when tokenization is unavailable", async () => {
    const tokenizer = {
      tokenize: vi.fn().mockResolvedValue(undefined),
    } as unknown as DurableObjectStub<TokenizerController>;
    vi.spyOn(env.TOKENIZER_CONTROLLER, "get").mockReturnValue(tokenizer);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let upstreamCallCount = 0;
    vi.stubGlobal("fetch", async () => {
      upstreamCallCount += 1;
      return new Response(JSON.stringify({ usage: { total_tokens: 1 } }), { status: 200 });
    });
    const before = await stub().getState();

    const response = await request();
    const after = await stub().getState();
    const resourceEvents = info.mock.calls
      .map(([event]) => event)
      .filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null);

    expect(response.status).toBe(500);
    expect(response.headers.get("X-OCTG-Route")).toBe("error:internal_error");
    expect(tokenizer.tokenize).toHaveBeenCalledTimes(1);
    expect(upstreamCallCount).toBe(0);
    expect(after).toMatchObject({
      reservedTokens: before.reservedTokens,
      requestCount: before.requestCount,
    });
    expect(resourceEvents).toContainEqual(expect.objectContaining({
      stage: "tokenize",
      phase: "finish",
      outcome: "exception",
      route: "error:tokenizer_unavailable",
      quotaReserved: false,
      upstreamReached: false,
    }));
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

  it("fails closed on two unknown reserve outcomes without release or upstream contact", async () => {
    const realController = stub();
    const before = await realController.getState();
    const reserve = vi.fn().mockRejectedValue(new TypeError("reserve transport failure"));
    const release = vi.fn();
    const markReserveOutcomeUnknown = vi.fn().mockResolvedValue({ ok: false, reason: "unknown_request" });
    const controller = {
      getState: vi.fn().mockResolvedValue(before),
      reserve,
      release,
      markReserveOutcomeUnknown,
    } as unknown as DurableObjectStub<QuotaController>;
    vi.spyOn(env.QUOTA_CONTROLLER, "get").mockReturnValue(controller);
    let upstreamCallCount = 0;
    vi.stubGlobal("fetch", async () => {
      upstreamCallCount += 1;
      return new Response(JSON.stringify({ usage: { total_tokens: 1 } }), { status: 200 });
    });

    const response = await request();
    const body = (await response.json()) as { request_id: string };

    expect(response.status).toBe(500);
    expect(response.headers.get("X-OCTG-Request-Id")).toBe(body.request_id);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(markReserveOutcomeUnknown).toHaveBeenCalledWith(expect.stringMatching(/^req_/));
    expect(release).not.toHaveBeenCalled();
    expect(upstreamCallCount).toBe(0);
  });

  it("returns 500 without repeating an unknown-reserve mark when its RPC rejects", async () => {
    // Given: both reserve attempts have indeterminate transport outcomes and the mark RPC rejects.
    const before = await stub().getState();
    const reserve = vi.fn().mockRejectedValue(new TypeError("reserve transport failure"));
    const release = vi.fn();
    const markReserveOutcomeUnknown = vi.fn().mockRejectedValue(new TypeError("mark transport failure"));
    const controller = {
      getState: vi.fn().mockResolvedValue(before),
      reserve,
      release,
      markReserveOutcomeUnknown,
    } as unknown as DurableObjectStub<QuotaController>;
    vi.spyOn(env.QUOTA_CONTROLLER, "get").mockReturnValue(controller);
    let upstreamCallCount = 0;
    vi.stubGlobal("fetch", async () => {
      upstreamCallCount += 1;
      return new Response(JSON.stringify({ usage: { total_tokens: 1 } }), { status: 200 });
    });

    // When: the request crosses the Worker boundary.
    const response = await request();

    // Then: the original fail-closed response is retained without replaying the failed mark.
    expect(response.status).toBe(500);
    expect(markReserveOutcomeUnknown).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(upstreamCallCount).toBe(0);
  });
});
