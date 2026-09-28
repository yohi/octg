import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { resolveRelayConfig, type RelayServiceConfig } from "../src/config.ts";
import type { ExactEncoder } from "../src/encoder.ts";
import { createRelayHandler, RELAY_INGRESS_ROUTE } from "../src/relay.ts";
import { MAX_IDEMPOTENCY_KEY_BYTES } from "@octg/shared";
import type { ActivationDenialCode, RelayErrorCode } from "@octg/shared";

const serviceAuthToken = "relay-service-token-0123456789abcdef";
const ingressAuthToken = "relay-ingress-token-0123456789abcdef";
const callbackOrigin = "https://worker.test";
const gatewayBBaseUrl = "https://gateway-b.test/openai";
const gatewayBToken = "gateway-b-run-token";

const requestId = "req_ABCDEFGHJKMNPQRSTVWXYZ1234";
const clientId = "client-1";
const grantId = "0123abcd-0000-4000-8000-000000000001";
const leaseGeneration = "0123abcd-0000-4000-8000-000000000002";
const grantCredential = "grant-credential-payload.grant-credential-signature";
const idempotencyKeyValue = "idem-key-123";

const maxIngressBodyBytes = 1_048_576;

type CallbackRoute = "decision" | "activation" | "renewal" | "terminal" | "upstream";

type RecordedCall = {
  readonly url: string;
  readonly init: RequestInit;
};

type StubOverrides = {
  readonly decision?: (call: RecordedCall) => Response;
  readonly activation?: (call: RecordedCall) => Response;
  readonly renewal?: (call: RecordedCall) => Response;
  readonly terminal?: (call: RecordedCall) => Response;
  readonly upstream?: (call: RecordedCall) => Response;
};

function base64urlNoPadding(value: string): string {
  return btoa(String.fromCodePoint(...new TextEncoder().encode(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function compactToken(payloadJson: string): string {
  return `${base64urlNoPadding(payloadJson)}.${base64urlNoPadding("0123456789abcdef0123456789abcdef")}`;
}

function validContextPayloadJson(): string {
  return JSON.stringify({
    version: 1,
    audience: "octg-deno-relay",
    environment: "production",
    route: "responses",
    requestId,
    clientId,
    idempotencyKeyHash: null,
    nonce: "A".repeat(43),
    issuedAtMs: 1_000,
    expiresAtMs: 61_000,
  });
}

function validContextToken(): string {
  return compactToken(validContextPayloadJson());
}

/** Transport-valid claims with an unverifiable signature segment. */
function unsignedContextToken(): string {
  return `${base64urlNoPadding(validContextPayloadJson())}.${base64urlNoPadding("not-a-real-hmac-signature")}`;
}

function undecodableContextToken(): string {
  return compactToken(JSON.stringify({ broken: true }));
}

function oversizedContextToken(): string {
  return `a.${"a".repeat(4094)}a`;
}

const quotaSnapshot = {
  pool: "STANDARD",
  limit: 100_000,
  used: 10,
  remaining: 99_990,
  resetAt: "2026-09-24T00:00:00Z",
};

function allowDecisionBody(cacheEnabled = false): string {
  return JSON.stringify({
    version: 1,
    kind: "allow",
    grantId,
    leaseGeneration,
    maxOutputTokens: 1024,
    cacheEnabled,
    quota: quotaSnapshot,
  });
}

function rejectDecisionBody(code: RelayErrorCode, status: number): string {
  return JSON.stringify({ version: 1, kind: "reject", code, status });
}

function jsonResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function callsOfRoute(calls: readonly RecordedCall[], route: CallbackRoute): RecordedCall[] {
  const urls: Record<CallbackRoute, string> = {
    decision: `${callbackOrigin}/internal/relay/v1/decision`,
    activation: `${callbackOrigin}/internal/relay/v1/activation`,
    renewal: `${callbackOrigin}/internal/relay/v1/renewal`,
    terminal: `${callbackOrigin}/internal/relay/v1/terminal`,
    upstream: `${gatewayBBaseUrl}/responses`,
  };
  return calls.filter((call) => call.url === urls[route]);
}

function headerOf(call: RecordedCall, name: string): string | null {
  return new Headers(call.init.headers).get(name);
}

function jsonBodyOf(call: RecordedCall): unknown {
  return JSON.parse(String(call.init.body));
}

/** Asserts a Headers (or recorded call's headers) value exists. */
function requiredHeader(headers: Headers | RecordedCall, name: string): string {
  const value = headers instanceof Headers ? headers.get(name) : headerOf(headers, name);
  assertEquals(value === null, false, `missing header ${name}`);
  return value as string;
}

function onlyOfRoute(calls: readonly RecordedCall[], route: CallbackRoute): RecordedCall {
  const routeCalls = callsOfRoute(calls, route);
  assertEquals(routeCalls.length, 1, `expected exactly one ${route} call`);
  return routeCalls[0] as RecordedCall;
}

interface ForwardedUpstreamBody {
  readonly max_output_tokens: number;
  readonly input: readonly {
    readonly role: string;
    readonly content: readonly { readonly type: string; readonly text: string }[];
  }[];
}

function parsedJsonOf<T>(call: RecordedCall): T {
  return JSON.parse(String(call.init.body)) as T;
}

function defaultStubs(): Required<StubOverrides> {
  return {
    decision: () =>
      jsonResponse(allowDecisionBody(), 200, { "x-octg-relay-grant": grantCredential }),
    activation: () => jsonResponse(JSON.stringify({ version: 1, activated: true, code: null })),
    renewal: () => jsonResponse(JSON.stringify({ version: 1, renewed: true, code: null })),
    terminal: () => jsonResponse(JSON.stringify({ version: 1, accepted: true, state: "released", code: null })),
    upstream: () => jsonResponse(JSON.stringify({ id: "resp_upstream_1" })),
  };
}

function createFixture(
  overrides: StubOverrides = {},
  configOverrides: Partial<RelayServiceConfig> = {},
): {
  handler: (request: Request) => Promise<Response>;
  calls: readonly RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const stubs = { ...defaultStubs(), ...overrides };
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    const call: RecordedCall = { url, init: init ?? {} };
    calls.push(call);
    const route = url === `${callbackOrigin}/internal/relay/v1/decision`
      ? "decision"
      : url === `${callbackOrigin}/internal/relay/v1/activation`
      ? "activation"
      : url === `${callbackOrigin}/internal/relay/v1/renewal`
      ? "renewal"
      : url === `${callbackOrigin}/internal/relay/v1/terminal`
      ? "terminal"
      : url === `${gatewayBBaseUrl}/responses`
      ? "upstream"
      : undefined;
    if (route === undefined) {
      return Promise.reject(new Error(`unexpected fetch target: ${url}`));
    }
    return Promise.resolve(stubs[route](call));
  };
  const encoder: ExactEncoder = { count: () => 7 };
  const handler = createRelayHandler({
    config: { ...relayConfig(), ...configOverrides },
    encoder,
    fetchImpl,
  });
  return { handler, calls };
}

function relayConfig(): RelayServiceConfig {
  return {
    environment: "production",
    callbackOrigin,
    serviceAuthToken,
    ingressAuthToken,
    gatewayBBaseUrl,
    gatewayBToken,
    maxInputBytes: maxIngressBodyBytes,
    maxRequestDurationMs: 3_600_000,
    leaseTtlMs: 120_000,
    leaseRenewalIntervalMs: 30_000,
  };
}

function relayRequest(overrides: {
  readonly method?: string;
  readonly token?: string;
  readonly contentType?: string;
  readonly context?: string | null;
  readonly idempotencyKey?: string;
  readonly body?: BodyInit;
} = {}): Request {
  const headers = new Headers({
    "authorization": `Bearer ${overrides.token ?? ingressAuthToken}`,
    "content-type": overrides.contentType ?? "application/json",
  });
  const context = overrides.context === undefined ? validContextToken() : overrides.context;
  if (context !== null) {
    headers.set("x-octg-relay-context", context);
  }
  if (overrides.idempotencyKey !== undefined) {
    headers.set("idempotency-key", overrides.idempotencyKey);
  }
  const method = overrides.method ?? "POST";
  return new Request(`https://deno.test${RELAY_INGRESS_ROUTE}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD"
      ? undefined
      : overrides.body ??
        JSON.stringify({ model: "gpt-5", input: "hello", max_output_tokens: 999_999 }),
  });
}

async function assertErrorEnvelope(
  response: Response,
  status: number,
  code: RelayErrorCode,
): Promise<void> {
  assertEquals(response.status, status);
  assertEquals(response.headers.get("content-type"), "application/json");
  assertEquals(await response.json(), { version: 1, error: { code } });
}

Deno.test("rejects non-POST methods with 405, Allow: POST, and no callback", async () => {
  const { handler, calls } = createFixture();

  const response = await handler(relayRequest({ method: "GET" }));

  await assertErrorEnvelope(response, 405, "invalid_request");
  assertEquals(response.headers.get("allow"), "POST");
  assertEquals(calls.length, 0);
});

Deno.test("rejects invalid ingress bearer auth with 401 and no callback", async () => {
  const { handler, calls } = createFixture();

  const response = await handler(relayRequest({ token: "wrong-token" }));

  await assertErrorEnvelope(response, 401, "unauthorized_service");
  assertEquals(calls.length, 0);
});

Deno.test("rejects a non-JSON media type with 400 invalid_request and no callback", async () => {
  const { handler, calls } = createFixture();

  const response = await handler(relayRequest({ contentType: "text/plain" }));

  await assertErrorEnvelope(response, 400, "invalid_request");
  assertEquals(calls.length, 0);
});

Deno.test("rejects a non-utf-8 charset with 400 invalid_request and no callback", async () => {
  const { handler, calls } = createFixture();

  const response = await handler(relayRequest({ contentType: "application/json; charset=latin1" }));

  await assertErrorEnvelope(response, 400, "invalid_request");
  assertEquals(calls.length, 0);
});

Deno.test("rejects a declared body above 1,048,576 bytes with 413 request_too_large", async () => {
  const { handler, calls } = createFixture();

  const response = await handler(
    relayRequest({ body: "x".repeat(maxIngressBodyBytes + 1) }),
  );

  await assertErrorEnvelope(response, 413, "request_too_large");
  assertEquals(calls.length, 0);
});

Deno.test("rejects a streamed body above 1,048,576 bytes with 413 request_too_large", async () => {
  const { handler, calls } = createFixture();
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(maxIngressBodyBytes + 1).fill(0x20));
      controller.close();
    },
  });

  const response = await handler(relayRequest({ body: oversized }));

  await assertErrorEnvelope(response, 413, "request_too_large");
  assertEquals(calls.length, 0);
});

Deno.test("rejects transport-invalid context tokens without a decision callback", async () => {
  const invalidContexts: readonly (string | null)[] = [
    null,
    "single-segment-token",
    "a.b.c",
    oversizedContextToken(),
    "ab=.cd",
    ".signature-value",
  ];
  for (const context of invalidContexts) {
    const { handler, calls } = createFixture();

    const response = await handler(relayRequest({ context }));

    await assertErrorEnvelope(response, 500, "invalid_context");
    assertEquals(calls.length, 0);
  }
});

Deno.test("rejects an Idempotency-Key above 255 UTF-8 bytes with 400 and no callback", async () => {
  const { handler, calls } = createFixture();

  const response = await handler(
    relayRequest({ idempotencyKey: "k".repeat(MAX_IDEMPOTENCY_KEY_BYTES + 1) }),
  );

  await assertErrorEnvelope(response, 400, "invalid_request");
  assertEquals(calls.length, 0);
});

Deno.test("preserves an exact non-empty Idempotency-Key to decision and Gateway B", async () => {
  const { handler, calls } = createFixture();

  const response = await handler(
    relayRequest({ idempotencyKey: idempotencyKeyValue }),
  );

  assertEquals(response.status, 200);
  const decisionCall = onlyOfRoute(calls, "decision");
  assertEquals(headerOf(decisionCall, "idempotency-key"), idempotencyKeyValue);
  const upstreamCall = onlyOfRoute(calls, "upstream");
  assertEquals(headerOf(upstreamCall, "Idempotency-Key"), idempotencyKeyValue);
});

Deno.test("omits the Idempotency-Key upstream and on decision when absent", async () => {
  const { handler, calls } = createFixture();

  const response = await handler(relayRequest());

  assertEquals(response.status, 200);
  const decisionCall = onlyOfRoute(calls, "decision");
  assertEquals(headerOf(decisionCall, "idempotency-key"), null);
  const upstreamCall = onlyOfRoute(calls, "upstream");
  assertEquals(headerOf(upstreamCall, "Idempotency-Key"), null);
});

Deno.test("omits the Idempotency-Key when the public header is empty", async () => {
  const { handler, calls } = createFixture();

  const response = await handler(relayRequest({ idempotencyKey: "" }));

  assertEquals(response.status, 200);
  const decisionCall = onlyOfRoute(calls, "decision");
  assertEquals(headerOf(decisionCall, "idempotency-key"), null);
  const upstreamCall = onlyOfRoute(calls, "upstream");
  assertEquals(headerOf(upstreamCall, "Idempotency-Key"), null);
});

Deno.test("forwards syntactically valid contexts unverified and fails closed on callback rejection", async () => {
  const { handler, calls } = createFixture({
    decision: () => jsonResponse(JSON.stringify({ error: "invalid_context" }), 400),
  });

  const response = await handler(relayRequest({ context: unsignedContextToken() }));

  await assertErrorEnvelope(response, 500, "internal_error");
  const decisionCall = onlyOfRoute(calls, "decision");
  assertEquals(headerOf(decisionCall, "x-octg-relay-context"), unsignedContextToken());
  assertEquals(callsOfRoute(calls, "activation").length, 0);
  assertEquals(callsOfRoute(calls, "upstream").length, 0);
  assertEquals(callsOfRoute(calls, "terminal").length, 0);
});

Deno.test("forwards bounded decision metadata with the opaque context and service auth", async () => {
  const { handler, calls } = createFixture();

  const rawBody = JSON.stringify({ model: "gpt-5", input: "hello", max_output_tokens: 999_999 });
  const response = await handler(relayRequest({ body: rawBody }));

  assertEquals(response.status, 200);
  const decisionCall = onlyOfRoute(calls, "decision");
  assertEquals(headerOf(decisionCall, "authorization"), `Bearer ${serviceAuthToken}`);
  assertEquals(headerOf(decisionCall, "x-octg-relay-context"), validContextToken());
  assertEquals(headerOf(decisionCall, "content-type"), "application/json");
  assertEquals(jsonBodyOf(decisionCall), {
    version: 1,
    metadata: {
      model: "gpt-5",
      estimatedInputTokens: 14,
      maxOutputTokens: 999_999,
      inputBytes: 5,
      rawBodyBytes: new TextEncoder().encode(rawBody).byteLength,
      isToolUse: false,
      stream: false,
    },
  });
});

Deno.test("maps decision reject envelopes by the public status table without activating", async () => {
  const rejectionCases: readonly {
    readonly code: RelayErrorCode;
    readonly status: number;
  }[] = [
    { code: "insufficient_quota", status: 429 },
    { code: "worker_concurrency_exceeded", status: 429 },
    { code: "model_requires_paid", status: 403 },
    { code: "model_not_allowed", status: 403 },
    { code: "client_disabled", status: 403 },
    { code: "duplicate_idempotency_key", status: 409 },
    { code: "invalid_request", status: 400 },
    { code: "request_too_large", status: 413 },
  ];
  for (const rejection of rejectionCases) {
    const { handler, calls } = createFixture({
      decision: () => jsonResponse(rejectDecisionBody(rejection.code, rejection.status)),
    });

    const response = await handler(relayRequest());

    await assertErrorEnvelope(response, rejection.status, rejection.code);
    assertEquals(callsOfRoute(calls, "decision").length, 1);
    assertEquals(callsOfRoute(calls, "activation").length, 0);
    assertEquals(callsOfRoute(calls, "upstream").length, 0);
  }
});

Deno.test("keeps quota rejection at 429 insufficient_quota, never 503, with zero upstream calls", async () => {
  const { handler, calls } = createFixture({
    decision: () => jsonResponse(rejectDecisionBody("insufficient_quota", 429)),
  });

  const response = await handler(relayRequest());

  await assertErrorEnvelope(response, 429, "insufficient_quota");
  assertEquals(callsOfRoute(calls, "upstream").length, 0);
});

Deno.test("maps malformed or mismatched decision envelopes to 500 internal_error", async () => {
  const malformedBodies: readonly string[] = [
    "not-json",
    JSON.stringify({ version: 1, kind: "mystery" }),
    rejectDecisionBody("insufficient_quota", 503),
    JSON.stringify({ version: 1, kind: "allow", grantId: "nope" }),
  ];
  for (const body of malformedBodies) {
    const { handler, calls } = createFixture({
      decision: () => jsonResponse(body, 200, { "x-octg-relay-grant": grantCredential }),
    });

    const response = await handler(relayRequest());

    await assertErrorEnvelope(response, 500, "internal_error");
    assertEquals(callsOfRoute(calls, "activation").length, 0);
    assertEquals(callsOfRoute(calls, "upstream").length, 0);
  }
});

Deno.test("maps decision callback transport failure to 500 internal_error with no fallback", async () => {
  const failingFetch: typeof fetch = () => Promise.reject(new Error("transport down"));
  const encoder: ExactEncoder = { count: () => 7 };
  const handler = createRelayHandler({ config: relayConfig(), encoder, fetchImpl: failingFetch });

  const response = await handler(relayRequest());

  await assertErrorEnvelope(response, 500, "internal_error");
});

Deno.test("maps a non-200 decision callback response to 500 internal_error", async () => {
  const { handler, calls } = createFixture({
    decision: () => jsonResponse(JSON.stringify({ version: 1, kind: "allow" }), 500),
  });

  const response = await handler(relayRequest());

  await assertErrorEnvelope(response, 500, "internal_error");
  assertEquals(callsOfRoute(calls, "decision").length, 1);
  assertEquals(callsOfRoute(calls, "activation").length, 0);
});

Deno.test("fails closed when an allow decision lacks the grant credential header", async () => {
  const { handler, calls } = createFixture({
    decision: () => jsonResponse(allowDecisionBody()),
  });

  const response = await handler(relayRequest());

  await assertErrorEnvelope(response, 500, "internal_error");
  assertEquals(callsOfRoute(calls, "activation").length, 0);
  assertEquals(callsOfRoute(calls, "upstream").length, 0);
});

Deno.test("activates once and forwards exactly one clamped Gateway B request", async () => {
  const { handler, calls } = createFixture();
  const upstreamBody = JSON.stringify({
    model: "gpt-5",
    input: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
    max_output_tokens: 999_999,
  });

  const response = await handler(relayRequest({ body: upstreamBody }));

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { id: "resp_upstream_1" });
  assertEquals(response.headers.get("content-type"), "application/json");

  const activationCall = onlyOfRoute(calls, "activation");
  assertEquals(headerOf(activationCall, "authorization"), `Bearer ${serviceAuthToken}`);
  assertEquals(headerOf(activationCall, "x-octg-relay-grant"), grantCredential);
  assertEquals(jsonBodyOf(activationCall), { version: 1, grantId, leaseGeneration });

  const upstreamCall = onlyOfRoute(calls, "upstream");
  assertEquals(upstreamCall.url, `${gatewayBBaseUrl}/responses`);
  assertEquals(headerOf(upstreamCall, "cf-aig-authorization"), `Bearer ${gatewayBToken}`);
  assertEquals(headerOf(upstreamCall, "content-type"), "application/json");
  assertEquals(headerOf(upstreamCall, "cf-aig-request-timeout"), "25000");
  assertEquals(headerOf(upstreamCall, "cf-aig-max-attempts"), "1");
  assertEquals(headerOf(upstreamCall, "cf-aig-collect-log-payload"), "false");
  assertEquals(headerOf(upstreamCall, "authorization"), null);
  assertEquals(
    JSON.parse(requiredHeader(upstreamCall, "cf-aig-metadata")),
    {
      client_id: clientId,
      pool: "standard",
      eligibility: "COMPLIMENTARY",
      route: "free_shared",
      request_id: requestId,
    },
  );

  const forwarded = parsedJsonOf<ForwardedUpstreamBody>(upstreamCall);
  assertEquals(forwarded.max_output_tokens, 1024);
  assertEquals(forwarded.input, [
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
  ]);

  assertEquals(
    JSON.parse(atob(requiredHeader(response.headers, "x-octg-relay-response-meta"))),
    {
      version: 1,
      requestId,
      pool: "STANDARD",
      limit: quotaSnapshot.limit,
      used: quotaSnapshot.used,
      remaining: quotaSnapshot.remaining,
      resetAt: quotaSnapshot.resetAt,
      route: "responses",
    },
  );
});

Deno.test("skips the AI Gateway cache when the decision disables caching", async () => {
  const { handler, calls } = createFixture({
    decision: () =>
      jsonResponse(allowDecisionBody(false), 200, { "x-octg-relay-grant": grantCredential }),
  });

  const response = await handler(relayRequest());

  const upstreamCall = onlyOfRoute(calls, "upstream");
  assertEquals(headerOf(upstreamCall, "cf-aig-cache-key"), null);
  assertEquals(headerOf(upstreamCall, "cf-aig-skip-cache"), "true");
});

Deno.test("uses the AI Gateway cache key when the decision enables caching", async () => {
  const { handler, calls } = createFixture({
    decision: () =>
      jsonResponse(allowDecisionBody(true), 200, { "x-octg-relay-grant": grantCredential }),
  });

  const response = await handler(relayRequest());

  assertEquals(response.status, 200);
  const upstreamCall = onlyOfRoute(calls, "upstream");
  assertEquals(headerOf(upstreamCall, "cf-aig-cache-key"), `octg:${clientId}`);
  assertEquals(headerOf(upstreamCall, "cf-aig-skip-cache"), null);
});

Deno.test("sends terminal release on lease_lost denial with no upstream call", async () => {
  const { handler, calls } = createFixture({
    activation: () => jsonResponse(JSON.stringify({ version: 1, activated: false, code: "lease_lost" })),
  });

  const response = await handler(relayRequest());

  await assertErrorEnvelope(response, 500, "lease_lost");
  const terminalCall = onlyOfRoute(calls, "terminal");
  assertEquals(headerOf(terminalCall, "x-octg-relay-grant"), grantCredential);
  assertEquals(jsonBodyOf(terminalCall), {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "release",
    totalTokens: null,
  });
  assertEquals(callsOfRoute(calls, "upstream").length, 0);
});

Deno.test("sends terminal uncertain on grant_replayed denial and never releases", async () => {
  const { handler, calls } = createFixture({
    activation: () => jsonResponse(JSON.stringify({ version: 1, activated: false, code: "grant_replayed" })),
  });

  const response = await handler(relayRequest());

  await assertErrorEnvelope(response, 500, "grant_replayed");
  const terminalCall = onlyOfRoute(calls, "terminal");
  assertEquals(jsonBodyOf(terminalCall), {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "uncertain",
    totalTokens: null,
  });
  assertEquals(callsOfRoute(calls, "upstream").length, 0);
});

Deno.test("sends no terminal callback for terminal-safe denial codes", async () => {
  const denialCodes: readonly ActivationDenialCode[] = [
    "environment_mismatch",
    "grant_not_found",
    "grant_expired",
    "grant_terminalized",
  ];
  for (const code of denialCodes) {
    const { handler, calls } = createFixture({
      activation: () => jsonResponse(JSON.stringify({ version: 1, activated: false, code })),
    });

    const response = await handler(relayRequest());

    await assertErrorEnvelope(response, 500, code);
    assertEquals(callsOfRoute(calls, "terminal").length, 0);
    assertEquals(callsOfRoute(calls, "upstream").length, 0);
  }
});

Deno.test("treats malformed, non-200, and failed activation outcomes as unknown with terminal uncertain", async () => {
  const activationOverrides: readonly ((call: RecordedCall) => Response)[] = [
    () => jsonResponse("not-json"),
    () => jsonResponse(JSON.stringify({ version: 1, activated: "yes", code: null })),
    () => jsonResponse(JSON.stringify({ version: 1, activated: false, code: "mystery_code" })),
    () => jsonResponse(JSON.stringify({ version: 1, activated: true, code: "lease_lost" })),
    () => new Response(null, { status: 500 }),
  ];
  for (const activation of activationOverrides) {
    const { handler, calls } = createFixture({ activation });

    const response = await handler(relayRequest());

    await assertErrorEnvelope(response, 500, "internal_error");
    assertEquals(callsOfRoute(calls, "terminal").length, 1);
    assertEquals(jsonBodyOf(onlyOfRoute(calls, "terminal")), {
      version: 1,
      grantId,
      leaseGeneration,
      outcome: "uncertain",
      totalTokens: null,
    });
    assertEquals(callsOfRoute(calls, "upstream").length, 0);
  }
});

Deno.test("reports terminal uncertain when activation acknowledgement is lost", async () => {
  const { handler, calls } = createFixture({
    activation: () => {
      throw new Error("activation transport down");
    },
  });

  const response = await handler(relayRequest());

  await assertErrorEnvelope(response, 500, "internal_error");
  assertEquals(callsOfRoute(calls, "terminal").length, 1);
  assertEquals(callsOfRoute(calls, "upstream").length, 0);
});

Deno.test("reports terminal uncertain when the upstream fetch fails after activation", async () => {
  let upstreamAttempts = 0;
  const { handler, calls } = createFixture({
    upstream: () => {
      upstreamAttempts += 1;
      throw new Error("gateway b unreachable");
    },
  });

  const response = await handler(relayRequest());

  await assertErrorEnvelope(response, 500, "internal_error");
  assertEquals(upstreamAttempts, 1);
  assertEquals(callsOfRoute(calls, "terminal").length, 1);
  assertEquals(jsonBodyOf(onlyOfRoute(calls, "terminal")), {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "uncertain",
    totalTokens: null,
  });
});

Deno.test("releases the grant when post-allow context claims cannot be decoded", async () => {
  const { handler, calls } = createFixture({
    decision: () =>
      jsonResponse(allowDecisionBody(), 200, { "x-octg-relay-grant": grantCredential }),
  });

  const response = await handler(relayRequest({ context: undecodableContextToken() }));

  await assertErrorEnvelope(response, 500, "internal_error");
  assertEquals(callsOfRoute(calls, "decision").length, 1);
  assertEquals(callsOfRoute(calls, "activation").length, 0);
  assertEquals(callsOfRoute(calls, "upstream").length, 0);
  assertEquals(jsonBodyOf(onlyOfRoute(calls, "terminal")), {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "release",
    totalTokens: null,
  });
});

Deno.test("reports terminal uncertain and relays upstream non-2xx status and body without metadata", async () => {
  const { handler, calls } = createFixture({
    upstream: () => jsonResponse(JSON.stringify({ error: { message: "upstream said no" } }), 429),
  });

  const response = await handler(relayRequest());

  assertEquals(response.status, 429);
  assertEquals(await response.json(), { error: { message: "upstream said no" } });
  assertEquals(response.headers.get("x-octg-relay-response-meta"), null);
  assertEquals(callsOfRoute(calls, "terminal").length, 1);
  assertEquals(jsonBodyOf(onlyOfRoute(calls, "terminal")), {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "uncertain",
    totalTokens: null,
  });
});

Deno.test("maps encoder failure to 500 internal_error with no callback", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.reject(new Error("unexpected fetch"));
  };
  const encoder: ExactEncoder = {
    count: () => {
      throw new Error("encoder exploded");
    },
  };
  const handler = createRelayHandler({ config: relayConfig(), encoder, fetchImpl });

  const response = await handler(relayRequest());

  await assertErrorEnvelope(response, 500, "internal_error");
  assertEquals(calls.length, 0);
});

Deno.test("settles exact usage from a non-stream upstream response before returning it", async () => {
  const { handler, calls } = createFixture({
    upstream: () =>
      jsonResponse(JSON.stringify({ id: "resp_1", usage: { total_tokens: 123 } })),
  });

  const response = await handler(relayRequest());

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { id: "resp_1", usage: { total_tokens: 123 } });
  assertEquals(response.headers.get("x-octg-relay-response-meta") !== null, true);
  assertEquals(callsOfRoute(calls, "terminal").length, 1);
  assertEquals(jsonBodyOf(onlyOfRoute(calls, "terminal")), {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "settle",
    totalTokens: 123,
  });
});

Deno.test("relays an SSE stream byte-exactly and settles fragmented usage once", async () => {
  const completed = `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } },
  })}\n\n`;
  const cut = Math.floor(completed.length / 2);
  const chunks = [
    `event: response.created\ndata: {"type":"response.created"}\n\n`,
    completed.slice(0, cut),
    completed.slice(cut),
  ];
  const expected = chunks.join("");
  const { handler, calls } = createFixture({
    upstream: () =>
      new Response(new Blob(chunks).stream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });

  const response = await handler(relayRequest());

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "text/event-stream");
  assertEquals(response.headers.get("x-octg-relay-response-meta") !== null, true);
  assertEquals(await response.text(), expected);
  assertEquals(callsOfRoute(calls, "terminal").length, 1);
  assertEquals(jsonBodyOf(onlyOfRoute(calls, "terminal")), {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "settle",
    totalTokens: 30,
  });
});

function heldEventStream(): {
  readonly response: Response;
  readonly close: () => void;
  readonly cancelled: Promise<void>;
} {
  const cancelled = Promise.withResolvers<void>();
  const holder: { controller?: ReadableStreamDefaultController<Uint8Array> } = {};
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      holder.controller = controller;
      controller.enqueue(encoder.encode('data: {"type":"response.in_progress"}\n\n'));
    },
    cancel() {
      cancelled.resolve();
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    close: () => holder.controller?.close(),
    cancelled: cancelled.promise,
  };
}

Deno.test("renews the lease through the worker callback while the upstream stream is open", async () => {
  const held = heldEventStream();
  const renewed = Promise.withResolvers<void>();
  const { handler, calls } = createFixture(
    {
      upstream: () => held.response,
      renewal: () => {
        renewed.resolve();
        return jsonResponse(JSON.stringify({ version: 1, renewed: true, code: null }));
      },
    },
    { leaseRenewalIntervalMs: 1 },
  );

  const response = await handler(relayRequest());
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("response has no body");
  await reader.read();
  await renewed.promise;
  held.close();
  while (!(await reader.read()).done) {
    // drain the forwarded stream
  }

  const terminalCalls = callsOfRoute(calls, "terminal");
  assertEquals(terminalCalls.length, 1);
  assertEquals(jsonBodyOf(terminalCalls[0] as RecordedCall), {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "uncertain",
    totalTokens: null,
  });
  const renewals = callsOfRoute(calls, "renewal");
  assertEquals(renewals.length >= 1, true);
  const renewalCall = renewals[0] as RecordedCall;
  assertEquals(headerOf(renewalCall, "x-octg-relay-grant"), grantCredential);
  assertEquals(jsonBodyOf(renewalCall), { version: 1, grantId, leaseGeneration });
  assertEquals(headerOf(renewalCall, "idempotency-key"), null);
});

Deno.test("aborts the upstream stream and reports terminal uncertain once when renewal fails", async () => {
  const held = heldEventStream();
  const { handler, calls } = createFixture(
    {
      upstream: () => held.response,
      renewal: () => jsonResponse(JSON.stringify({ version: 1, renewed: false, code: null }), 500),
    },
    { leaseRenewalIntervalMs: 1 },
  );

  const response = await handler(relayRequest());
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("response has no body");
  await reader.read();
  await assertRejects(() => reader.read());
  await held.cancelled;

  const terminalCalls = callsOfRoute(calls, "terminal");
  assertEquals(terminalCalls.length, 1);
  assertEquals(jsonBodyOf(terminalCalls[0] as RecordedCall), {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "uncertain",
    totalTokens: null,
  });
  assertEquals(callsOfRoute(calls, "renewal").length >= 1, true);
});

Deno.test("reports terminal uncertain exactly once when the client disconnects after activation", async () => {
  const held = heldEventStream();
  const { handler, calls } = createFixture({
    upstream: () => held.response,
  });

  const response = await handler(relayRequest());
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("response has no body");
  await reader.read();
  await reader.cancel();
  await held.cancelled;

  const terminalCalls = callsOfRoute(calls, "terminal");
  assertEquals(terminalCalls.length, 1);
  assertEquals(jsonBodyOf(terminalCalls[0] as RecordedCall), {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "uncertain",
    totalTokens: null,
  });
  assertEquals(callsOfRoute(calls, "upstream").length, 1);
});

const validRelayEnv: Readonly<Record<string, string>> = {
  OCTG_RELAY_ENVIRONMENT: "production",
  OCTG_RELAY_CALLBACK_ORIGIN: "https://worker.test",
  OCTG_RELAY_SERVICE_AUTH_TOKEN: serviceAuthToken,
  OCTG_RELAY_INGRESS_AUTH_TOKEN: ingressAuthToken,
  OCTG_RELAY_GATEWAY_B_BASE_URL: gatewayBBaseUrl,
  OCTG_RELAY_GATEWAY_B_TOKEN: gatewayBToken,
  MAX_INPUT_BYTES: "1048576",
  OCTG_RELAY_MAX_REQUEST_DURATION_MS: "3600000",
  OCTG_RELAY_LEASE_TTL_MS: "120000",
  OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS: "30000",
};

function relayEnvWith(
  overrides: Readonly<Record<string, string | undefined>>,
): (name: string) => string | undefined {
  const values = new Map(Object.entries(validRelayEnv));
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) values.delete(name);
    else values.set(name, value);
  }
  return (name) => values.get(name);
}

Deno.test("resolves the exact required relay key set", () => {
  assertEquals(resolveRelayConfig(relayEnvWith({})), relayConfig());
});

Deno.test("fails closed on missing or invalid relay settings", () => {
  const invalidCases: readonly (Readonly<Record<string, string | undefined>>)[] = [
    { OCTG_RELAY_ENVIRONMENT: undefined },
    { OCTG_RELAY_ENVIRONMENT: "staging" },
    { OCTG_RELAY_CALLBACK_ORIGIN: undefined },
    { OCTG_RELAY_CALLBACK_ORIGIN: "http://worker.test" },
    { OCTG_RELAY_CALLBACK_ORIGIN: "https://worker.test/internal" },
    { OCTG_RELAY_CALLBACK_ORIGIN: "https://worker.test/?x=1" },
    { OCTG_RELAY_SERVICE_AUTH_TOKEN: undefined },
    { OCTG_RELAY_SERVICE_AUTH_TOKEN: "short-token" },
    { OCTG_RELAY_SERVICE_AUTH_TOKEN: "token with a space inside the printable range 0123456789" },
    { OCTG_RELAY_INGRESS_AUTH_TOKEN: undefined },
    { OCTG_RELAY_INGRESS_AUTH_TOKEN: "short-token" },
    { OCTG_RELAY_GATEWAY_B_BASE_URL: undefined },
    { OCTG_RELAY_GATEWAY_B_BASE_URL: "https://gateway-b.test/v1" },
    { OCTG_RELAY_GATEWAY_B_BASE_URL: "http://gateway-b.test/openai" },
    { OCTG_RELAY_GATEWAY_B_TOKEN: undefined },
    { OCTG_RELAY_GATEWAY_B_TOKEN: "" },
    { MAX_INPUT_BYTES: undefined },
    { MAX_INPUT_BYTES: "524288" },
    { OCTG_RELAY_MAX_REQUEST_DURATION_MS: undefined },
    { OCTG_RELAY_MAX_REQUEST_DURATION_MS: "3599999" },
    { OCTG_RELAY_LEASE_TTL_MS: undefined },
    { OCTG_RELAY_LEASE_TTL_MS: "60000" },
    { OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS: undefined },
    { OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS: "60000" },
  ];
  for (const overrides of invalidCases) {
    assertThrows(
      () => resolveRelayConfig(relayEnvWith(overrides)),
      TypeError,
      "Invalid Deno relay configuration.",
    );
  }
});
