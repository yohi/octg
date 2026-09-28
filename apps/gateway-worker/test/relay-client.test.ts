import { env, SELF } from "cloudflare:test";
import {
  RELAY_CONTEXT_AUDIENCE,
  RELAY_MAX_CONTEXT_LIFETIME_MS,
  RELAY_NONCE_PATTERN,
  signRelayContext,
  verifyRelayContext,
} from "@octg/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRelayIngressContext,
  callDenoRelay,
  relayIdempotencyKeyHash,
} from "../src/relay-client";
import type { EnabledRelayConfig } from "../src/relay-auth";
import { seedClient, TEST_CLIENT_ID, TEST_CLIENT_KEY } from "./seed";

const INGRESS_ENDPOINT = "https://deno-relay.test/";
const INGRESS_TOKEN = "ingress-token-0123456789abcdef0123456789ab";
const SERVICE_TOKEN = "service-token-0123456789abcdef0123456789ab";
// 43 base64url characters decoding to exactly 32 zero bytes (test-only key).
const HMAC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const RELAY_BINDINGS = [
  "OCTG_RELAY_ENABLED",
  "OCTG_RELAY_ENVIRONMENT",
  "OCTG_RELAY_INGRESS_ENDPOINT",
  "OCTG_RELAY_INGRESS_AUTH_TOKEN",
  "OCTG_RELAY_SERVICE_AUTH_TOKEN",
  "OCTG_RELAY_CONTEXT_HMAC_KEY",
] as const;

const enabledRelayConfig: EnabledRelayConfig = {
  kind: "enabled",
  environment: "preview",
  ingressEndpoint: INGRESS_ENDPOINT,
  ingressAuthToken: INGRESS_TOKEN,
  serviceAuthToken: SERVICE_TOKEN,
  contextHmacKey: new Uint8Array(32),
};

const originalBindings = new Map<string, PropertyDescriptor | undefined>();

function encodeBase64Url(input: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(input)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64UrlToJson(value: string): unknown {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function configureRelay(): void {
  for (const name of RELAY_BINDINGS) originalBindings.set(name, Object.getOwnPropertyDescriptor(env, name));
  Object.defineProperties(env, {
    OCTG_RELAY_ENABLED: { value: "true", configurable: true },
    OCTG_RELAY_ENVIRONMENT: { value: "preview", configurable: true },
    OCTG_RELAY_INGRESS_ENDPOINT: { value: INGRESS_ENDPOINT, configurable: true },
    OCTG_RELAY_INGRESS_AUTH_TOKEN: { value: INGRESS_TOKEN, configurable: true },
    OCTG_RELAY_SERVICE_AUTH_TOKEN: { value: SERVICE_TOKEN, configurable: true },
    OCTG_RELAY_CONTEXT_HMAC_KEY: { value: HMAC_KEY, configurable: true },
  });
}

function disableRelay(): void {
  for (const name of RELAY_BINDINGS) Reflect.deleteProperty(env, name);
}

function restoreRelay(): void {
  for (const name of RELAY_BINDINGS) {
    const descriptor = originalBindings.get(name);
    if (descriptor === undefined) Reflect.deleteProperty(env, name);
    else Object.defineProperty(env, name, descriptor);
  }
  originalBindings.clear();
}

interface IngressCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly bodyBytes: number;
  readonly bodyText: string;
}

interface IngressStub {
  readonly ingressCalls: IngressCall[];
  readonly upstreamUrls: string[];
}

function stubDenoIngress(
  respond: (call: IngressCall, context: Record<string, unknown>) => Response | Promise<Response>,
): IngressStub {
  const ingressCalls: IngressCall[] = [];
  const upstreamUrls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url !== INGRESS_ENDPOINT) {
      upstreamUrls.push(url);
      return new Response(JSON.stringify({ error: { message: "unexpected upstream call" } }), { status: 500 });
    }
    const received = init?.body === null || init?.body === undefined
      ? new Uint8Array(0)
      : new Uint8Array(await new Response(init.body).arrayBuffer());
    const headers = new Headers(init?.headers);
    const contextToken = headers.get("x-octg-relay-context") ?? "";
    const payloadSegment = contextToken.split(".")[0];
    const context = payloadSegment === undefined
      ? {}
      : decodeBase64UrlToJson(payloadSegment) as Record<string, unknown>;
    const call: IngressCall = {
      url,
      init: init ?? {},
      bodyBytes: received.byteLength,
      bodyText: new TextDecoder().decode(received),
    };
    ingressCalls.push(call);
    return await respond(call, context);
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { ingressCalls, upstreamUrls };
}

function contextOf(call: IngressCall): Record<string, unknown> {
  const headers = new Headers(call.init.headers);
  const contextToken = headers.get("x-octg-relay-context") ?? "";
  const payloadSegment = contextToken.split(".")[0];
  if (payloadSegment === undefined) throw new Error("ingress call has no context token");
  return decodeBase64UrlToJson(payloadSegment) as Record<string, unknown>;
}

function metaHeaderValue(context: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  const requestId = typeof context.requestId === "string" ? context.requestId : "req_UNKNOWNREQUESTIDFORMAT00";
  const meta = {
    version: 1,
    requestId,
    pool: "STANDARD",
    limit: 100,
    used: 10,
    remaining: 90,
    resetAt: `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
    route: "responses",
    ...overrides,
  };
  return encodeBase64Url(JSON.stringify(meta));
}

function relaySuccess(init: { readonly body?: BodyInit; readonly contentType?: string; readonly meta?: string }): Response {
  return new Response(init.body ?? JSON.stringify({ id: "resp_1", usage: { total_tokens: 3 } }), {
    status: 200,
    headers: {
      "content-type": init.contentType ?? "application/json",
      ...(init.meta === undefined ? {} : { "x-octg-relay-response-meta": init.meta }),
    },
  });
}

function relayEnvelope(status: number, code: string): Response {
  return new Response(JSON.stringify({ version: 1, error: { code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function responsesRequest(headers: HeadersInit = {}, body?: BodyInit): Promise<Response> {
  return SELF.fetch("https://octg.test/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TEST_CLIENT_KEY}`,
      "content-type": "application/json",
      ...headers,
    },
    body: body ?? JSON.stringify({ model: "gpt-5", input: "input is intentionally not parsed by the Worker", max_output_tokens: 9 }),
  });
}

function oneMibStream(): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(65_536).fill(120);
  let chunksSent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunksSent >= 16) {
        controller.close();
        return;
      }
      chunksSent += 1;
      controller.enqueue(chunk);
    },
  });
}

const ONE_MIB = 1_048_576;

beforeEach(async () => {
  await seedClient();
  vi.restoreAllMocks();
});

afterEach(() => {
  restoreRelay();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("callDenoRelay ingress forwarding", () => {
  it("sends the original body exactly once as the same stream with exact ingress headers", async () => {
    // Given: a client request with credentials and headers that must not leak.
    const request = new Request("https://octg.test/v1/responses", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${TEST_CLIENT_KEY}`,
        "content-type": "application/json",
        "idempotency-key": "key-123",
        "cookie": "secret=yes",
      },
      body: JSON.stringify({ model: "gpt-5", input: "text" }),
    });
    const observed: { readonly url: string; readonly init: RequestInit }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      observed.push({ url: String(input), init: init ?? {} });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    // When: the ingress call is made.
    const relayed = await callDenoRelay(request, "context-token", enabledRelayConfig);

    // Then: the same stream instance is forwarded once with exactly the ingress headers.
    expect(relayed.status).toBe(200);
    expect(observed.length).toBe(1);
    const call = observed[0];
    expect(call?.url).toBe(INGRESS_ENDPOINT);
    expect(call?.init.body).toBe(request.body);
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${INGRESS_TOKEN}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-octg-relay-context")).toBe("context-token");
    expect(headers.get("idempotency-key")).toBe("key-123");
    // Exact-set equality also proves no client header (e.g. cookie) leaked.
    const seen = new Map<string, string>();
    headers.forEach((value, name) => {
      seen.set(name.toLowerCase(), value);
    });
    expect([...seen].sort(([a], [b]) => (a < b ? -1 : 1))).toEqual([
      ["authorization", `Bearer ${INGRESS_TOKEN}`],
      ["content-type", "application/json"],
      ["idempotency-key", "key-123"],
      ["x-octg-relay-context", "context-token"],
    ]);
  });

  it("omits an empty Idempotency-Key from the ingress headers", async () => {
    // Given: a request whose Idempotency-Key is empty (no effective key).
    const request = new Request("https://octg.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "" },
      body: "{}",
    });
    const observed: RequestInit[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      observed.push(init ?? {});
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    // When: the ingress call is made.
    await callDenoRelay(request, "context-token", enabledRelayConfig);

    // Then: no Idempotency-Key header is forwarded.
    const headers = new Headers(observed[0]?.headers);
    expect(headers.get("idempotency-key")).toBeNull();
  });

  it("forwards a lying Content-Length without buffering the body", async () => {
    // Given: a request whose Content-Length disagrees with the real body.
    const request = new Request("https://octg.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "5" },
      body: "hello world",
    });
    const observed: RequestInit[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const received = new Uint8Array(await new Response(init?.body).arrayBuffer());
      observed.push({ ...init, body: received });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    // When: the ingress call is made.
    const relayed = await callDenoRelay(request, "context-token", enabledRelayConfig);

    // Then: the full raw body is streamed through once.
    expect(relayed.status).toBe(200);
    const received = observed[0]?.body as Uint8Array;
    expect(received.byteLength).toBe(11);
    expect(new TextDecoder().decode(received)).toBe("hello world");
  });
});

describe("relay ingress context", () => {
  it("builds a signed context that verifies with the exact contract claims", async () => {
    // Given: the relay identity fields for one request.
    const context = await buildRelayIngressContext({
      environment: "preview",
      requestId: "req_AAAAAAAAAAAAAAAAAAAAAAAAAA",
      clientId: TEST_CLIENT_ID,
      idempotencyKeyHash: null,
    });

    // When: the context is signed and verified with the same key.
    const token = await signRelayContext(context, enabledRelayConfig.contextHmacKey);
    const verified = await verifyRelayContext(token, enabledRelayConfig.contextHmacKey, "preview", Date.now());

    // Then: the claims match the bounded v1 contract.
    expect(verified).toBeDefined();
    expect(verified?.audience).toBe(RELAY_CONTEXT_AUDIENCE);
    expect(verified?.route).toBe("responses");
    expect(verified?.requestId).toBe("req_AAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(verified?.clientId).toBe(TEST_CLIENT_ID);
    expect(verified?.idempotencyKeyHash).toBeNull();
    expect(verified?.nonce).toMatch(RELAY_NONCE_PATTERN);
    expect((verified?.expiresAtMs ?? 0) - (verified?.issuedAtMs ?? 0)).toBe(RELAY_MAX_CONTEXT_LIFETIME_MS);
  });

  it("binds the exact raw key as SHA-256(clientId || NUL || key) and null when absent", async () => {
    // Given: one client id with and without an exact raw key.
    // When: the binding hash is computed.
    const withKey = await relayIdempotencyKeyHash(TEST_CLIENT_ID, "idem-42");
    const withoutKey = await relayIdempotencyKeyHash(TEST_CLIENT_ID, undefined);

    // Then: the hash is the exact lowercase hex digest, or null.
    expect(withoutKey).toBeNull();
    expect(withKey).toMatch(/^[0-9a-f]{64}$/);
    const encoder = new TextEncoder();
    const prefix = encoder.encode(TEST_CLIENT_ID);
    const key = encoder.encode("idem-42");
    const bytes = new Uint8Array(prefix.length + 1 + key.length);
    bytes.set(prefix, 0);
    bytes[prefix.length] = 0;
    bytes.set(key, prefix.length + 1);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(withKey).toBe(hex);
  });
});

describe("public responses relay", () => {
  beforeEach(() => {
    configureRelay();
  });

  it("relays a non-stream Responses request through Deno without contacting the upstream", async () => {
    // Given: a Deno ingress that echoes the context and returns a success with metadata.
    const stub = stubDenoIngress((call, context) => {
      const headers = new Headers(call.init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${INGRESS_TOKEN}`);
      expect(headers.get("content-type")).toBe("application/json");
      return relaySuccess({ meta: metaHeaderValue(context) });
    });

    // When: the request crosses the real Worker route.
    const response = await responsesRequest();

    // Then: the relay path answered once with free_shared public headers and no upstream call.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "resp_1", usage: { total_tokens: 3 } });
    expect(stub.ingressCalls.length).toBe(1);
    expect(stub.upstreamUrls.length).toBe(0);
    const call = stub.ingressCalls[0];
    expect(call?.bodyBytes).toBe(JSON.stringify({ model: "gpt-5", input: "input is intentionally not parsed by the Worker", max_output_tokens: 9 }).length);
    const headers = response.headers;
    expect(headers.get("x-octg-route")).toBe("free_shared");
    expect(headers.get("x-octg-pool")).toBe("standard");
    expect(headers.get("x-octg-quota-limit")).toBe("100");
    expect(headers.get("x-octg-quota-used")).toBe("10");
    expect(headers.get("x-octg-quota-remaining")).toBe("90");
    expect(headers.get("x-octg-quota-reset")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    const versionId = env.CF_VERSION_METADATA?.id;
    expect(headers.get("x-octg-worker-version")).toBe(typeof versionId === "string" && versionId.length > 0 ? versionId : "local");
    const context = contextOf(call ?? { url: INGRESS_ENDPOINT, init: {}, bodyBytes: 0, bodyText: "" });
    expect(context.requestId).toBe(headers.get("x-octg-request-id"));
    expect(context.clientId).toBe(TEST_CLIENT_ID);
    expect(context.idempotencyKeyHash).toBeNull();
    expect(headers.get("x-octg-request-id")).toMatch(/^req_/);
  });

  it("forwards the exact Idempotency-Key and binds its hash into the context", async () => {
    // Given: a public request with an Idempotency-Key.
    const stub = stubDenoIngress((_call, context) => relaySuccess({ meta: metaHeaderValue(context) }));

    // When: the request crosses the route.
    const response = await responsesRequest({ "idempotency-key": "idem-42" });

    // Then: the exact key reaches Deno and the signed hash binds it.
    expect(response.status).toBe(200);
    const call = stub.ingressCalls[0];
    expect(new Headers(call?.init.headers).get("idempotency-key")).toBe("idem-42");
    const context = contextOf(call ?? { url: INGRESS_ENDPOINT, init: {}, bodyBytes: 0, bodyText: "" });
    expect(context.idempotencyKeyHash).toBe(await relayIdempotencyKeyHash(String(context.clientId), "idem-42"));
  });

  it("relays an exact 1 MiB body once with a declared Content-Length", async () => {
    // Given: a body at the exact ingress limit with an implicit Content-Length.
    const body = "x".repeat(ONE_MIB);
    const stub = stubDenoIngress((_call, context) => relaySuccess({ meta: metaHeaderValue(context) }));

    // When: the request crosses the route.
    const response = await responsesRequest({}, body);

    // Then: exactly the 1 MiB reaches Deno once and the relay succeeds.
    expect(response.status).toBe(200);
    expect(response.headers.get("x-octg-route")).toBe("free_shared");
    expect(stub.ingressCalls.length).toBe(1);
    expect(stub.ingressCalls[0]?.bodyBytes).toBe(ONE_MIB);
    expect(stub.upstreamUrls.length).toBe(0);
  });

  it("relays an exact 1 MiB body once without a Content-Length", async () => {
    // Given: a streamed body at the exact ingress limit with no declared length.
    const stub = stubDenoIngress((_call, context) => relaySuccess({ meta: metaHeaderValue(context) }));

    // When: the request crosses the route as a raw stream.
    const response = await responsesRequest({}, oneMibStream());

    // Then: exactly the 1 MiB reaches Deno once.
    expect(response.status).toBe(200);
    expect(stub.ingressCalls.length).toBe(1);
    expect(stub.ingressCalls[0]?.bodyBytes).toBe(ONE_MIB);
  });

  it("relays SSE payload bytes unchanged with public success headers", async () => {
    // Given: a Deno SSE response whose usage event is split across chunks.
    const sseChunks = [
      'data: {"usage":{"in',
      'put_tokens":1,"total_tokens":3}}\n\n',
      "data: [DONE]\n\n",
    ];
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of sseChunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const stub = stubDenoIngress((_call, context) =>
      relaySuccess({ body: sseBody, contentType: "text/event-stream", meta: metaHeaderValue(context) })
    );

    // When: the request crosses the route.
    const response = await responsesRequest({ "accept": "text/event-stream", "stream": "true" });

    // Then: the raw SSE bytes are identical and the public headers stay complimentary.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-octg-route")).toBe("free_shared");
    expect(await response.text()).toBe(sseChunks.join(""));
    expect(stub.ingressCalls.length).toBe(1);
    expect(stub.upstreamUrls.length).toBe(0);
  });

  it("maps a validation reject to the public 400 invalid_request", async () => {
    // Given: Deno rejects the decision with the internal envelope.
    stubDenoIngress(() => relayEnvelope(400, "invalid_request"));

    // When: the request crosses the route.
    const response = await responsesRequest();

    // Then: the existing public OCTG validation error is returned.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(response.headers.get("x-octg-request-id")).toMatch(/^req_/);
  });

  it("maps a quota reject to the public 429 insufficient_quota", async () => {
    // Given: Deno reports an insufficient quota rejection.
    stubDenoIngress(() => relayEnvelope(429, "insufficient_quota"));

    // When: the request crosses the route.
    const response = await responsesRequest();

    // Then: the public quota error is returned with its reject route.
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "insufficient_quota" } });
    expect(response.headers.get("x-octg-route")).toBe("reject:complimentary_quota");
  });

  it("maps a model reject to the public 403 model_requires_paid", async () => {
    // Given: Deno reports a paid-only model rejection.
    stubDenoIngress(() => relayEnvelope(403, "model_requires_paid"));

    // When: the request crosses the route.
    const response = await responsesRequest();

    // Then: the existing public model error is returned.
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "model_requires_paid" } });
  });

  it("maps an internal failure envelope to 500 internal_error, never 503", async () => {
    // Given: Deno reports an internal relay failure.
    stubDenoIngress(() => relayEnvelope(500, "internal_error"));

    // When: the request crosses the route.
    const response = await responsesRequest();

    // Then: the public internal error is returned.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(response.headers.get("x-octg-route")).toBe("error:internal_error");
  });

  it("maps an unmapped internal code to 500 internal_error", async () => {
    // Given: Deno reports a lease-lost internal failure with no public mapping.
    stubDenoIngress(() => relayEnvelope(500, "lease_lost"));

    // When: the request crosses the route.
    const response = await responsesRequest();

    // Then: the response fails closed at the public internal error.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
  });

  it("maps an envelope whose status disagrees with its code to 500 internal_error", async () => {
    // Given: Deno pairs insufficient_quota (public 429) with status 500.
    stubDenoIngress(() => relayEnvelope(500, "insufficient_quota"));

    // When: the request crosses the route.
    const response = await responsesRequest();

    // Then: the mismatched internal response is invalid and fails closed.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
  });

  it("passes a non-envelope upstream error through unchanged", async () => {
    // Given: Deno forwards an upstream 503 with an OpenAI-shaped error body.
    const upstreamBody = JSON.stringify({ error: { message: "upstream unavailable", type: "server_error" } });
    stubDenoIngress(() => new Response(upstreamBody, {
      status: 503,
      headers: { "content-type": "application/json" },
    }));

    // When: the request crosses the route.
    const response = await responsesRequest();

    // Then: the existing upstream passthrough contract is preserved.
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(upstreamBody);
  });

  it("passes an over-limit non-envelope error body through unchanged", async () => {
    // Given: an upstream error body larger than any possible internal envelope.
    const upstreamBody = JSON.stringify({ error: { message: "y".repeat(9_000) } });
    stubDenoIngress(() => new Response(upstreamBody, {
      status: 502,
      headers: { "content-type": "application/json" },
    }));

    // When: the request crosses the route.
    const response = await responsesRequest();

    // Then: the body is streamed through byte-for-byte.
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(upstreamBody);
  });

  it("fails closed when a success response lacks response metadata", async () => {
    // Given: Deno answers 2xx without the response metadata header.
    stubDenoIngress(() => relaySuccess({}));

    // When: the request crosses the route.
    const response = await responsesRequest();

    // Then: the proxy fails closed at the public internal error.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
  });

  it("fails closed when response metadata does not match the request", async () => {
    // Given: Deno answers with metadata for a different request ID.
    stubDenoIngress((_call, _context) =>
      relaySuccess({ meta: metaHeaderValue({}, { requestId: "req_BBBBBBBBBBBBBBBBBBBBBBBBBB" }) })
    );

    // When: the request crosses the route.
    const response = await responsesRequest();

    // Then: the metadata is rejected before any public success headers.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
  });

  it("fails closed when response metadata violates pool quota invariants", async () => {
    // Given: Deno reports used and remaining that do not add up to the limit.
    stubDenoIngress((_call, context) =>
      relaySuccess({ meta: metaHeaderValue(context, { remaining: 91 }) })
    );

    // When: the request crosses the route.
    const response = await responsesRequest();

    // Then: the metadata is rejected.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
  });

  it("fails closed when response metadata carries a negative counter", async () => {
    // Given: Deno reports a negative used counter.
    stubDenoIngress((_call, context) =>
      relaySuccess({ meta: metaHeaderValue(context, { used: -1, remaining: 101 }) })
    );

    // When: the request crosses the route.
    const response = await responsesRequest();

    // Then: the metadata is rejected.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
  });

  it("fails closed on a Deno transport failure without legacy fallback", async () => {
    // Given: the ingress call itself times out.
    const upstreamUrls: string[] = [];
    let ingressAttempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === INGRESS_ENDPOINT) {
        ingressAttempts += 1;
        throw new TypeError("deno ingress timed out");
      }
      upstreamUrls.push(String(input));
      return new Response("{}", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    // When: the request crosses the route.
    const response = await responsesRequest();

    // Then: the proxy answers 500 once without retrying, contacting upstream, or preparing.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(ingressAttempts).toBe(1);
    expect(upstreamUrls.length).toBe(0);
  });

  it("keeps the Chat route on the legacy path when relay is enabled", async () => {
    // Given: relay enabled plus the legacy tokenizer configuration.
    Object.defineProperties(env, {
      DENO_TOKENIZER_ENDPOINT: { value: "https://deno.test/tokenize", configurable: true },
      DENO_TOKENIZER_AUTH_TOKEN: { value: "test-token", configurable: true },
      DENO_TOKENIZER_THRESHOLD_BYTES: { value: "1", configurable: true },
      DENO_TOKENIZER_TIMEOUT_MS: { value: "1000", configurable: true },
    });
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://deno.test/tokenize") {
        calls.push("tokenize");
        return new Response(JSON.stringify({ baseTokenCount: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === INGRESS_ENDPOINT) calls.push("deno-relay");
      calls.push("upstream");
      return new Response(JSON.stringify({ usage: { total_tokens: 9 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);

    // When: a Chat Completions request crosses the route.
    const response = await SELF.fetch("https://octg.test/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_CLIENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "Hello" }] }),
    });

    // Then: the legacy chat flow answers and the Deno relay is never contacted.
    expect(response.status).toBe(200);
    expect(calls).not.toContain("deno-relay");
    expect(calls).toContain("tokenize");
    expect(calls).toContain("upstream");
  });
});
