# Large Responses CPU-Limit Mitigation Implementation Plan

**Goal:** Move large `/v1/responses` parsing, normalization, and exact BPE counting to Deno while preserving fail-closed quota behavior and the existing small-input path.

**Architecture:** Stage 1 removes the avoidable `Buffer.concat` allocation from the Worker body reader while preserving bounded streaming for unknown-length bodies. Stage 2 adds an authenticated Deno `/prepare` endpoint that accepts raw Responses JSON, returns validated metadata plus a normalized upstream-body stream, and lets the Worker apply the quota-derived output limit through a marker replacement stream before calling the existing upstream path.

**Tech Stack:** TypeScript strict mode, Cloudflare Workers, Durable Objects, Deno Deploy, Web Streams, Vitest, `@cloudflare/vitest-pool-workers`, Deno test runner.

## Global Constraints

- Keep `MAX_INPUT_BYTES` at `1048576`.
- Never use D1 or Deno state as quota authority; quota decisions remain in the `QuotaController` Durable Object.
- Deno processing is before quota reservation, and Deno failures never fall back to the Durable Object tokenizer.
- Do not log request bodies, client API keys, Deno auth tokens, or output markers.
- Preserve existing public error codes, reservation settlement, in-flight lease, and upstream-uncertain behavior.
- Prepare routing initially applies only to large `POST /v1/responses` requests.
- Do not modify the existing `/tokenize` contract or remove its rollback path.
- Put transport-neutral `PrepareMetadata`, `PrepareErrorCode`, and `PrepareErrorBody` in `packages/shared/src/prepare.ts`, exported from `packages/shared/src/index.ts`.
- Keep Worker-specific base64url decoding, metadata validation, and marker-stream logic out of the Deno service and out of the shared package.
- Call the shared `normalizeResponses` and `normalizeResponsesUpstreamBody` implementations from Deno; do not duplicate their Responses semantics.
- Compute `estimatedInputTokens` with the existing `estimatedInputTokensOf` formula using exact BPE count, `messageCount`, and `opaqueInputBytes`. The Worker must not add those overheads again.
- Include `rawBodyBytes` in successful metadata. Count raw bytes from the bytes actually read by Deno, including non-ASCII JSON bytes.
- Enforce `MAX_INPUT_BYTES` at both the raw gateway body and normalized input boundary. A declared raw body above the limit is rejected and canceled by the Worker before Deno dispatch.
- The resolved prepare body owns its Deno response stream and an idempotent `cancel()` operation until upstream transport takes ownership.
- A prepare-resolution failure has no quota reservation, upstream call, or Durable Object tokenizer fallback. A resolved prepared-body failure cancels/releases known state before upstream transport starts and uses existing uncertain semantics after it starts.
- Prepare resolution validates only status, success media type, bounded metadata, and non-null body presence. The Worker never buffers or parses a successful 200 body before returning a resolved outcome; marker and stream failures are handled after resolution by the prepared-body lifecycle.
- The existing `upstreamAttempted` flag is the single proxy-local authority for whether the upstream transport attempt has started. Do not introduce a parallel attempt flag; `upstreamReached` remains the separate response-received state.
- Reuse the existing tokenizer auth token and timeout in the Worker prepare client. The Deno service reuses its existing auth and input-size settings. Do not add a prepare-specific auth token or timeout setting.
- A complete prepare pair is `DENO_PREPARE_ENDPOINT` plus `DENO_PREPARE_THRESHOLD_BYTES`. Empty-string disabled placeholders are invalid and must not be uploaded.
- `DENO_PREPARE_THRESHOLD_BYTES` must be a positive safe integer no greater than the resolved `MAX_INPUT_BYTES`.
- The protocol error codes are exactly `invalid_body`, `non_text`, `max_tokens_conflict`, `input_too_large`, and `request_too_large`.
- The prepare metadata header is base64url JSON of at most 4096 ASCII bytes. Long model strings produce an internal prepare failure rather than a new public model-length rule.
- Deno serializes the normalized upstream body once and puts a single request-specific quoted output marker in `max_output_tokens`. The Worker replaces that quoted marker with the final decimal output-token budget without parsing or re-stringifying the large body.

## TDD Sequence

Every task that changes code follows this exact order:

1. **RED:** add a focused regression test for one observable behavior, including the expected value or call ordering.
2. **RED check:** run the task's focused command and record the new failure proving the test reaches the missing behavior.
3. **GREEN:** add the smallest production change that satisfies the failing test and preserves existing callers.
4. **GREEN check:** rerun the focused command and the relevant type check; record the passing result.
5. **REFACTOR:** simplify names and boundaries without changing behavior, then rerun the focused command.

Each code step below includes the test assertion, command, expected RED result, implementation shape, and GREEN command. No task may replace a failing test with a weaker assertion.

---

### Task 1: Implement Stage 1 body-reader optimization with regression coverage

**Files:**
- Modify: `apps/gateway-worker/src/request-body.ts:17-135`
- Test: `apps/gateway-worker/test/request-body.test.ts`

**Interfaces:**
- Consumes: existing `readJsonBody(request, maxBytes)` callers in `proxy.ts` and `admin.ts`.
- Produces: the same `ReadJsonBodyResult` union and metrics, with a native text fast path only for a valid in-bound declared length.

- [ ] **RED: add the native-body and boundary tests**

  Use a request double whose `body.getReader()` throws if called, whose `text()` returns valid JSON, and whose declared length is in bounds. Assert parsed JSON, the declared-byte source, and that the reader was not called:

  ```ts
  it("uses native text for an in-bound declared body", async () => {
    let readerCalled = false;
    const request = {
      headers: new Headers({ "content-length": "8" }),
      body: {
        getReader() {
          readerCalled = true;
          throw new Error("bounded reader should not run");
        },
      },
      text: async () => "{\"ok\":1}",
    } as unknown as Pick<Request, "headers" | "body"> & { text(): Promise<string> };

    const result = await readJsonBody(request, 1_048_576);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toEqual({ ok: 1 });
      expect(result.metrics.rawBodyBytesSource).toBe("declared_content_length");
      expect(result.metrics.rawBodyBytes).toBe(8);
    }
    expect(readerCalled).toBe(false);
  });
  ```

  Also assert `rawBodyBytes`, `rawBodyBytesSource`, `truncated`, `bodyReadMs`, `parseMs`, invalid JSON, and cancellation for exact `maxBytes`, declared oversize, measured oversize without `Content-Length`, malformed `Content-Length`, missing body, and non-ASCII UTF-8. Use a controllable `performance.now()` fixture or equivalent phase clock to assert that `bodyReadMs` covers only the `request.text()` phase and `parseMs` covers only the `JSON.parse()` phase; neither value may include the other phase. Add separate cases for `request.text()` rejection and `JSON.parse()` rejection: the former preserves the existing body-read exception/internal response semantics and does not become `invalid_json`, while the latter remains `invalid_json`. Preserve the current invalid UTF-8 behavior rather than adding a new public error code.

- [ ] **RED check: run the focused test**

  Run: `npm test -w apps/gateway-worker -- request-body.test.ts`

  Expected RED result: the native-body test fails because the current implementation calls `body.getReader()` before using `Request.text()`; boundary tests describe the metrics that must remain unchanged.

- [ ] **GREEN: add the native text fast path and retain the bounded fallback**

  Replace the request parameter type with `Pick<Request, "headers" | "body" | "text">`. After the declared oversize and missing-body checks, start the body-read clock immediately before calling `request.text()` once for a valid in-bound declared length. If `request.text()` rejects, preserve the existing body-read exception/internal response semantics and do not map it to `invalid_json`. After it resolves, close the body-read measurement and start the parse clock immediately before one `JSON.parse` call. A parse rejection returns `invalid_json` with the already-closed body-read duration and parse-only duration. Keep the reader and `Buffer.concat` path for missing, malformed, or unusable lengths, including measured oversize cancellation.

  ```ts
  if (declaredContentLength !== null && typeof request.text === "function") {
    const bodyReadStartedAt = performance.now();
    let rawText: string;
    try {
      rawText = await request.text();
    } catch (error) {
      // Preserve the existing body-read exception/internal response semantics.
      throw error;
    }
    const bodyReadMs = elapsedSince(bodyReadStartedAt);
    const parseStartedAt = performance.now();
    try {
      const body = JSON.parse(rawText);
      const parseMs = elapsedSince(parseStartedAt);
      return {
        ok: true,
        body,
        rawText,
        metrics: {
          rawBodyBytes: declaredContentLength,
          rawBodyBytesSource: "declared_content_length",
          declaredContentLength,
          measuredRawBodyBytes: null,
          truncated: false,
          bodyReadMs,
          parseMs,
        },
      };
    } catch {
      const parseMs = elapsedSince(parseStartedAt);
      return {
        ok: false,
        reason: "invalid_json",
        metrics: {
          rawBodyBytes: declaredContentLength,
          rawBodyBytesSource: "declared_content_length",
          declaredContentLength,
          measuredRawBodyBytes: null,
          truncated: false,
          bodyReadMs,
          parseMs,
        },
      };
    }
  }
  ```

  Integrate the snippet with the existing result construction rather than adding a second parser helper or a second body read.

- [ ] **GREEN check: run the focused test and type check**

  Run: `npm test -w apps/gateway-worker -- request-body.test.ts`

  Run: `npm run typecheck -w apps/gateway-worker`

  Expected GREEN result: all native and boundary tests pass and TypeScript reports no errors.

- [ ] **REFACTOR: compare every fallback metric with the prior contract**

  Keep cancellation on both declared and measured oversize paths, retain `Buffer.concat` only in the bounded fallback, and remove any helper that duplicates existing result construction. Rerun `npm test -w apps/gateway-worker -- request-body.test.ts`.

### Task 2: Verify Stage 1 compatibility at its callers

**Files:**
- Modify: `apps/gateway-worker/test/request-body.test.ts` only for missing reader coverage
- Test: `apps/gateway-worker/test/proxy-failures.test.ts`
- Test target: `readJsonBody()` callers in `apps/gateway-worker/src/proxy.ts` and `apps/gateway-worker/src/admin.ts`

**Interfaces:**
- Consumes: the Stage 1 `ReadJsonBodyResult` produced by Task 1.
- Produces: proof that the optimization does not alter public 413/invalid-JSON behavior or admin JSON parsing.

- [ ] **RED: add caller-level assertions for preserved responses**

  Add a proxy test for a declared oversize body that asserts the existing OCTG `request_too_large` response, body cancellation, and absence of tokenizer, quota, and upstream calls. Add an admin test for valid and invalid JSON with a declared in-bound length.

  ```ts
  const response = await fetchProxy(makeRequest({
    headers: { "content-length": "1048577" },
    body: "{}",
  }));

  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: { code: "request_too_large" } });
  expect(bodyCancel).toHaveBeenCalledOnce();
  expect(tokenizerRpc).not.toHaveBeenCalled();
  expect(quotaReserve).not.toHaveBeenCalled();
  expect(upstreamFetch).not.toHaveBeenCalled();
  ```

- [ ] **RED check: run the caller-focused tests**

  Run: `npm test -w apps/gateway-worker -- proxy-failures.test.ts request-body.test.ts`

  Expected RED result: the new proxy/admin fixture fails if the request double or body-reader metrics do not preserve the existing caller behavior.

- [ ] **GREEN: make no caller behavior change**

  If the focused tests expose a regression, adjust only Stage 1 result construction so `errRequestTooLarge` and invalid JSON continue to receive the same fields. Do not add a caller-specific parser or another fallback path.

- [ ] **GREEN check: run caller and type checks**

  Run: `npm test -w apps/gateway-worker -- proxy-failures.test.ts request-body.test.ts`

  Run: `npm run typecheck -w apps/gateway-worker`

  Expected GREEN result: proxy and admin callers retain their existing public behavior.

- [ ] **REFACTOR: remove implementation-specific test assumptions**

  Keep assertions on result fields, cancellation, and downstream call ordering; do not assert `Buffer.concat` or a particular reader implementation. Rerun the focused command.

### Task 3: Define shared prepare metadata and stream contracts

**Files:**
- Create: `packages/shared/src/prepare.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/gateway-worker/src/prepare-contract.ts`
- Create: `apps/gateway-worker/src/prepared-body.ts`
- Modify: `apps/gateway-worker/src/upstream.ts:16-63`
- Test: `packages/shared/test/prepare.test.ts`
- Test: `apps/gateway-worker/test/prepare-contract.test.ts`
- Test: `apps/gateway-worker/test/prepared-body.test.ts`
- Test: `apps/gateway-worker/test/upstream.test.ts`

**Interfaces:**
- Produces transport-neutral `PrepareMetadata`, `PrepareErrorCode`, and `PrepareErrorBody` from `packages/shared/src/prepare.ts`:

  ```ts
  export interface PrepareMetadata {
    readonly version: 1;
    readonly model: string;
    readonly rawBodyBytes: number;
    readonly inputBytes: number;
    readonly inputTextBytes: number;
    readonly opaqueInputBytes: number;
    readonly messageCount: number;
    readonly estimatedInputTokens: number;
    readonly estimationPath: "exact_bpe";
    readonly maxOutputTokens: number;
    readonly stream: boolean;
    readonly isToolUse: boolean;
    readonly outputMarker: string;
  }

  export type PrepareErrorCode =
    | "invalid_body"
    | "non_text"
    | "max_tokens_conflict"
    | "input_too_large"
    | "request_too_large";

  export interface PrepareErrorBody {
    readonly code: PrepareErrorCode;
  }
  ```

- `PrepareMetadata` has an exact field set. `version` is `1`; all byte, count, and estimate fields are non-negative safe integers; `maxOutputTokens` is a positive safe integer; `model` is non-empty; `estimationPath` is exactly `exact_bpe`; `stream` and `isToolUse` are booleans; and `outputMarker` matches `octg_prepare_[0-9a-f]{32}`. Do not add a public model-length rule; header size is the transport bound.
- Produces `parsePrepareMetadata(value: string | null, maxInputBytes: number): PrepareMetadata | undefined`, which decodes bounded base64url JSON and validates the exact field set, version, scalar types, safe-integer ranges, and semantic relationships.
- Produces `replaceOutputMarker(body: ReadableStream<Uint8Array>, marker: string, outputTokens: number): ReadableStream<Uint8Array>`, which handles marker bytes split across chunks and throws on zero or multiple quoted-marker occurrences.
- Marker, EOF, and response-body read failures discovered while consuming a resolved body are lifecycle failures after resolution; they are not mapped back to `PrepareOutcome.unavailable` by buffering or parsing the body.
- The resolved client result owns the response body until transfer:

  ```ts
  export type PrepareOutcome =
    | {
        readonly kind: "resolved";
        readonly metadata: PrepareMetadata;
        readonly body: ReadableStream<Uint8Array>;
        readonly cancel: () => Promise<void>;
      }
    | { readonly kind: "rejected"; readonly code: PrepareErrorCode }
    | {
        readonly kind: "unavailable";
        readonly failure: "timeout" | "network" | "upstream_status" | "malformed_response";
      };
  ```

- `cancel()` is idempotent, aborts the Deno request, and cancels the Deno response body. The timeout remains active until the body closes or is canceled.
- Keep `callUpstream`'s existing `body: unknown` public signature. Detect `ReadableStream<Uint8Array>` and pass it directly; retain direct string pass-through and `JSON.stringify` for object bodies. Keep all existing content-type, AI Gateway, cache, idempotency, and metadata headers unchanged.

- [ ] **RED: write metadata and stream contract tests**

  Assert a valid exact-field metadata value, including `rawBodyBytes`, and invalid values for missing/extra fields, wrong version, negative/unsafe integers, invalid `estimationPath`, empty model, malformed marker, invalid booleans, invalid `inputBytes` relationships, and `maxOutputTokens`. Test a non-ASCII body marker header boundary separately from model validation. For marker replacement, test one chunk, every marker byte split across chunks, UTF-8 bytes around the marker, missing marker, duplicate marker, and a final decimal output selected independently from Deno's original value.

  ```ts
  const metadata: PrepareMetadata = {
    version: 1,
    model: "model-name",
    rawBodyBytes: 12,
    inputBytes: 10,
    inputTextBytes: 10,
    opaqueInputBytes: 0,
    messageCount: 1,
    estimatedInputTokens: 17,
    estimationPath: "exact_bpe",
    maxOutputTokens: 64,
    stream: false,
    isToolUse: false,
    outputMarker: "octg_prepare_0123456789abcdef0123456789abcdef",
  };

  expect(parsePrepareMetadata(encodeMetadataHeader(metadata), 1_048_576)).toEqual(metadata);
  expect(parsePrepareMetadata(encodeMetadataHeader({ ...metadata, inputBytes: 11 }), 1_048_576)).toBeUndefined();
  ```

- [ ] **RED check: run the focused tests**

  Run: `npm test -w apps/gateway-worker -- prepare-contract.test.ts prepared-body.test.ts upstream.test.ts`

  Expected RED result: new metadata, marker, and stream-body tests fail because the contracts and stream body support do not yet exist.

- [ ] **GREEN: implement bounded validation, marker replacement, and stream forwarding**

  Decode only the bounded base64url header, parse JSON, validate its exact keys and relationships, and return `undefined` for every malformed value. Implement a byte-level state machine that retains only the longest suffix that can begin the quoted marker, emits other bytes unchanged, and requires exactly one replacement at end-of-stream.

  ```ts
  const quotedMarker = new TextEncoder().encode(JSON.stringify(marker));
  const replacement = new TextEncoder().encode(String(outputTokens));
  let pending = new Uint8Array(0);
  let replacements = 0;

  // Combine only the pending marker prefix with the next chunk.
  const combined = concatBytes(pending, chunk);
  const next = replaceOneQuotedMarker(combined, quotedMarker, replacement);
  pending = next.pending;
  replacements += next.replacements;
  controller.enqueue(next.emitted);
  ```

  Make `replaceOneQuotedMarker` preserve a marker prefix at the end of each chunk and make the flush path reject `replacements !== 1`. In `callUpstream`, pass a readable body directly:

  ```ts
  const bodyValue = body instanceof ReadableStream
    ? body
    : typeof body === "string"
      ? body
      : JSON.stringify(body);
  return transport(url, { method: "POST", headers, body: bodyValue });
  ```

- [ ] **GREEN check: run focused tests and type checks**

  Run: `npm test -w apps/gateway-worker -- prepare-contract.test.ts prepared-body.test.ts upstream.test.ts`

  Run: `npm run typecheck -w apps/gateway-worker`

  Run: `npm run typecheck -w packages/shared`

  Expected GREEN result: all metadata, marker-boundary, stream-body, and existing upstream tests pass with no type errors.

- [ ] **REFACTOR: keep protocol and runtime concerns separate**

  Leave only shared types in `packages/shared/src/prepare.ts`; keep base64url/runtime validation in the Worker and marker generation in Deno. Ensure no helper buffers the complete prepared body or serializes it a second time. Rerun the focused commands.

### Task 4: Add Deno `/prepare` service behavior

**Files:**
- Modify: `apps/deno-tokenizer/src/http.ts:4-235`
- Modify: `apps/deno-tokenizer/src/config.ts:3-22`
- Test: `apps/deno-tokenizer/test/http.test.ts`
- Test: `apps/deno-tokenizer/test/config.test.ts`

**Interfaces:**

- Consumes: authenticated `POST /prepare` with `application/json` raw Responses body, the existing `DenoTokenizerServiceConfig` auth and input-size settings, and no Deno-side timeout setting. The Worker client reuses `DENO_TOKENIZER_TIMEOUT_MS` as its request/body deadline in Task 5.
- Produces: `200 application/json`, a normalized upstream JSON body, and `X-OCTG-Prepare-Metadata` containing base64url-encoded `PrepareMetadata`; validation responses contain only the shared allowlisted codes, while internal failures are status-only `500` responses with no validation envelope.
- The `/prepare` raw-body bound is `config.maxInputBytes`, the resolved `MAX_INPUT_BYTES`. The existing `/tokenize` raw-body bound `config.maxRawBodyBytes`, fatal UTF-8 decoder, and response contract remain unchanged.
- The successful metadata uses `rawBodyBytes` from bytes actually read, `inputBytes = inputTextBytes + opaqueInputBytes`, exact `estimatedInputTokensOf` accounting, positive `maxOutputTokens`, and an `octg_prepare_` plus 32 lowercase hexadecimal marker.
- The response body contains exactly one quoted marker in `max_output_tokens`. Deno regenerates the marker for up to 16 attempts if the candidate appears elsewhere in the serialized body.

The `/prepare` response status/body contract is the same matrix used by the
Worker client in Task 5:

| HTTP status | Response contract | Worker outcome |
| --- | --- | --- |
| `400` | `invalid_body`, `non_text`, or `max_tokens_conflict` | `rejected` |
| `413` | `input_too_large` or `request_too_large` | `rejected` |
| `200` | Expected success media type, valid metadata, and non-null body | `resolved` |
| `200` | Missing/wrong success media type, malformed/oversized metadata, or null body | `unavailable: malformed_response` |
| `500` | Internal prepare failure with no validation envelope | `unavailable` |
| Any other status, including `401`, `415`, and all other `5xx` | Any body, including an allowlisted-looking code | `unavailable` |

The `400` and `413` error bodies are bounded `application/json` objects with
exactly one `code` field, and the code must match the status row. Raw-body
oversize is `request_too_large` with HTTP `413`; normalized input oversize is
`input_too_large` with HTTP `413`.

Deno's successful `200` response is serialized once and has the expected
`application/json` media type, valid metadata, and a non-null body. The normal
Deno success path does not emit a `200` error envelope, and the Worker does not
parse the successful body to look for one; the normalized body remains a
single-pass stream for Task 5 and Task 6.

The following helpers are local to `apps/deno-tokenizer/src/http.ts` and are
defined in this task before the endpoint handler uses them:

```ts
type PrepareRawBodyResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "too_large" | "read_failure" };

async function readBoundedRawBody(
  request: Request,
  maxBytes: number,
): Promise<PrepareRawBodyResult>;

function prepareError(status: 400 | 413, code: PrepareErrorCode): Response;
```

`readBoundedRawBody` returns `too_large` for declared or measured raw-body
oversize and `read_failure` when `getReader()` or `reader.read()` rejects; it
retains no request content. `read_failure` is an internal helper result and is
never passed as `PrepareErrorCode`. A body that reaches normal end-of-stream
returns `ok: true`, including an empty body. `prepareError` emits the exact
bounded envelope for the validation status/code matrix and has no other side
effect. Add this local helper for the status-only internal contract:

```ts
function prepareInternalFailure(): Response {
  return new Response(null, { status: 500 });
}
```

- [ ] **RED: add failing `/prepare` endpoint tests**

  Test method/path/auth/content type, declared and measured raw-body oversize, replacement-style UTF-8 decoding, invalid JSON, all shared normalization errors, exact metadata values, non-ASCII `rawBodyBytes`, generic `text` normalization for user/system/developer/assistant and `function_call_output`, exactly one quoted marker in the returned body, marker regeneration on collision, and no request-derived error detail. Add separate cases for a request-body reader rejection returning HTTP `500` with no `code`, invalid JSON after a complete body read returning `400` with `invalid_body`, normalization `invalid_body` returning `400` with `invalid_body`, and declared/measured oversize returning `413` with `request_too_large`. Test the complete status/body matrix above, including valid `400` and `413` envelopes, wrong status/code combinations, `500` plus `invalid_body`, `500` with no body, `401` plus an allowlisted code, and `415` plus an allowlisted code.

  ```ts
  const requestBody = JSON.stringify({
    model: "model-name",
    input: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
  const response = await handler(new Request("https://deno.test/prepare", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: requestBody,
  }));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  const metadata = decodeMetadata(response.headers.get("X-OCTG-Prepare-Metadata"));
  expect(metadata).toMatchObject({
    rawBodyBytes: new TextEncoder().encode(requestBody).byteLength,
    inputTextBytes: 5,
    inputBytes: 5,
    messageCount: 1,
    estimationPath: "exact_bpe",
  });
  // Test-only body inspection; the Worker success path must not do this.
  const serialized = await response.text();
  expect(countOccurrences(serialized, JSON.stringify(metadata.outputMarker))).toBe(1);
  ```

- [ ] **RED check: run the Deno tests**

  Run: `deno test --allow-env --allow-read apps/deno-tokenizer/test/http.test.ts apps/deno-tokenizer/test/config.test.ts`

  Expected RED result: the new `/prepare` tests fail because the route, shared metadata, and prepare raw-body handling are absent.

- [ ] **GREEN: add the prepare service without changing `/tokenize`**

  Reuse the configured auth token and resolved input limit; the Deno service has no new timeout setting. Authorize and validate the request before reading it. Read the raw body with a bounded byte reader using `config.maxInputBytes`; return `request_too_large` for declared or measured raw oversize; return status-only `500` from `prepareInternalFailure()` for `getReader()` or `reader.read()` rejection; decode UTF-8 with replacement semantics only after a complete read; parse JSON; call the shared normalizer; and map its errors without including request-derived detail. Return `400` for `invalid_body`, `non_text`, and `max_tokens_conflict`, and `413` for `input_too_large` and `request_too_large`, exactly as shown in the status/body matrix. A raw-body read failure must never be passed to `prepareError` or represented by `PrepareErrorCode.invalid_body`.

  ```ts
  const rawBody = await readBoundedRawBody(request, config.maxInputBytes);
  if (!rawBody.ok) {
    if (rawBody.reason === "read_failure") return prepareInternalFailure();
    return prepareError(413, "request_too_large");
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(rawBody.bytes));
  } catch {
    return prepareError(400, "invalid_body");
  }

  const normalized = normalizeResponses(parsedBody, config.maxInputBytes);
  if (!normalized.ok) {
    return prepareError(
      normalized.error === "input_too_large" ? 413 : 400,
      normalized.error,
    );
  }
  const baseTokenCount = args.encoder.count(normalized.value.inputText);
  const estimatedInputTokens = estimatedInputTokensOf({
    baseTokenCount,
    messageCount: normalized.value.messageCount,
    opaqueInputBytes: normalized.value.opaqueInputBytes,
  });
  ```

  Normalize the upstream body with `normalizeResponsesUpstreamBody(parsedBody)`, choose a cryptographically random marker from 16 attempts, set its only `max_output_tokens` property, serialize once, and emit the bounded base64url metadata header. The header encoding must reject values over 4096 ASCII bytes. Preserve the existing `/tokenize` path and fatal decoder exactly.

- [ ] **GREEN check: run Deno type and test checks**

  Run: `deno check apps/deno-tokenizer/src/main.ts apps/deno-tokenizer/test/*.test.ts`

  Run: `deno test --allow-env --allow-read apps/deno-tokenizer/test`

  Expected GREEN result: type checking and all existing plus new Deno tests pass.

- [ ] **REFACTOR: keep endpoint phases and error mapping explicit**

  Keep authentication and media-type checks before body reads, keep raw-body rejection distinct from normalized `input_too_large`, keep raw-body read failure as a status-only internal response, and keep `/tokenize` implementation untouched apart from shared imports required by compilation. Rerun the focused Deno tests.

### Task 5: Add Worker prepare configuration and client

**Files:**
- Modify: `apps/gateway-worker/src/deno-tokenizer-config.ts:5-69`
- Create: `apps/gateway-worker/src/deno-prepare-client.ts`
- Test: `apps/gateway-worker/test/deno-tokenizer-config.test.ts`
- Test: `apps/gateway-worker/test/deno-prepare-client.test.ts`

**Interfaces:**
- Keep `resolveDenoTokenizerConfig`'s existing four-setting contract unchanged and add `resolveDenoRuntimeConfig` for the combined proxy view:

  ```ts
  export type DenoPrepareConfig =
    | { readonly kind: "disabled"; readonly maxInputBytes: number }
    | { readonly kind: "invalid"; readonly maxInputBytes: number }
    | {
        readonly kind: "enabled";
        readonly endpoint: string;
        readonly authToken: string;
        readonly thresholdBytes: number;
        readonly timeoutMs: number;
        readonly maxInputBytes: number;
      };

  export interface DenoRuntimeConfig {
    readonly tokenizer: DenoTokenizerConfig;
    readonly prepare: DenoPrepareConfig;
  }
  ```

- `resolveDenoRuntimeConfig(env)` reuses the existing tokenizer result. Prepare is enabled only when the existing tokenizer group is enabled and both prepare settings are present and valid. It is disabled when both prepare settings are absent. A partial/invalid prepare pair is invalid for Responses but does not change Chat Completions behavior. If the tokenizer group is partial/invalid, the existing tokenizer configuration error remains authoritative for both routes.
- The effective truth table is:

  | Existing tokenizer group | Prepare pair | Chat Completions | Responses |
  | --- | --- | --- | --- |
  | all absent | both absent | legacy DO tokenizer | legacy DO tokenizer; prepare disabled |
  | enabled and valid | both absent | legacy Deno tokenizer | legacy Deno tokenizer; prepare disabled |
  | enabled and valid | complete and valid | legacy Deno tokenizer | prepare enabled in addition to legacy behavior |
  | partial or invalid | any | existing tokenizer configuration error | existing tokenizer configuration error |
  | all absent | complete or partial/invalid | legacy DO tokenizer | prepare configuration error |
  | enabled and valid | partial or invalid | legacy Deno tokenizer | prepare configuration error |

- A complete prepare pair reuses `DENO_TOKENIZER_AUTH_TOKEN` and `DENO_TOKENIZER_TIMEOUT_MS`; it does not create parallel auth or timeout settings. Validate HTTPS without URL credentials, a positive safe threshold no greater than `maxInputBytes`, and the same positive safe timeout rule as the tokenizer group.
- Produces `prepareWithDeno(args: { endpoint: string; authToken: string; timeoutMs: number; maxInputBytes: number; request: Request; fetchImpl?: typeof fetch; onTimeout?: () => void }): Promise<PrepareOutcome>`. It forwards the original body stream without calling `request.text()`, `request.json()`, or `readJsonBody()`. `onTimeout` is a local lifecycle callback for the proxy and is not serialized or added to the shared protocol.
- `PrepareOutcome` has `resolved`, `rejected`, and `unavailable` variants. `resolved` carries validated metadata, the response body, and an idempotent `cancel`; `rejected` carries one shared `PrepareErrorCode`; `unavailable` carries only `timeout`, `network`, `upstream_status`, or `malformed_response`. A Deno `500` body-read failure is classified by status as `unavailable: upstream_status`; it is never parsed as a validation code. `malformed_response` is limited to status, success media type, metadata, and null-body failures observed before resolution; it does not describe a failure discovered while consuming a resolved body.

The client classifies HTTP status before inspecting an error body, using this
exact matrix:

| HTTP status | Exact error envelope | Worker outcome |
| --- | --- | --- |
| `400` | `invalid_body`, `non_text`, or `max_tokens_conflict` | `rejected` |
| `413` | `input_too_large` or `request_too_large` | `rejected` |
| `200` | Expected success media type, valid metadata, and non-null body | `resolved` |
| `200` | Missing/wrong success media type, malformed/oversized metadata, or null body | `unavailable: malformed_response` |
| `500` | Internal prepare failure with no validation envelope | `unavailable: upstream_status` |
| Any other status, including `401`, `415`, and all other `5xx` | Any body, including an allowlisted-looking code | `unavailable` |

The first two rows require a bounded `application/json` object with exactly
one `code` field, and the code must match the status row. The successful `200`
row requires the expected `application/json` media type, a bounded valid
metadata header, and a non-null response body, but does not consume that body.
A `2xx` status other than `200` is unavailable even when its body resembles a
valid envelope. A body-stream failure after a resolved outcome is handled by
Task 6's lifecycle rather than returned as `unavailable` from this client.

- [ ] **RED: write configuration and client tests**

  Test the complete truth table, both prepare settings absent, one missing, empty-string placeholders, invalid HTTPS URL, credentials in URL, invalid/too-large threshold, invalid timeout, and unchanged tokenizer configuration cases. Test body forwarding without a preliminary read, auth/content-type headers, response-body cancellation, timeout through body close/cancel, a resolved-body timeout invoking `onTimeout` exactly once, network failure, and successful metadata/body return. Test the complete status/body matrix above: valid `400` and `413` envelopes, `400`/`413` with unknown codes, every other wrong status/code combination, `500` plus `invalid_body`, `500` plus `request_too_large`, `500` with no body from a Deno body-read failure, `401` plus an allowlisted code, `415` plus an allowlisted code, missing/wrong success `Content-Type`, missing/invalid metadata, oversized metadata headers, null response body, and a successful `200` whose body is returned without being read. Do not test missing/duplicate markers or body read failures as phase-1 malformed responses; those are resolved-body lifecycle cases in Task 6. Assert that the body-read failure is `unavailable` and never `rejected`.

  ```ts
  const config = resolveDenoRuntimeConfig({
    DENO_TOKENIZER_ENDPOINT: "https://deno.test/tokenize",
    DENO_TOKENIZER_AUTH_TOKEN: "token",
    DENO_TOKENIZER_THRESHOLD_BYTES: "700000",
    DENO_TOKENIZER_TIMEOUT_MS: "25000",
    DENO_PREPARE_ENDPOINT: "https://deno.test/prepare",
    DENO_PREPARE_THRESHOLD_BYTES: "700000",
    MAX_INPUT_BYTES: "1048576",
  });

  expect(config.tokenizer.kind).toBe("enabled");
  expect(config.prepare).toMatchObject({
    kind: "enabled",
    endpoint: "https://deno.test/prepare",
    thresholdBytes: 700000,
    timeoutMs: 25000,
  });
  ```

  For the client, assert the fetch init body is the original `ReadableStream`, and assert that an allowlisted Deno error returns `{ kind: "rejected", code }` while a 401 or malformed response returns `{ kind: "unavailable", ... }`.

- [ ] **RED check: run the focused tests**

  Run: `npm test -w apps/gateway-worker -- deno-tokenizer-config.test.ts deno-prepare-client.test.ts`

  Expected RED result: new prepare configuration, outcome, ownership, and timeout tests fail before the resolver and client exist.

- [ ] **GREEN: implement the resolver and bounded client**

  Keep `resolveDenoTokenizerConfig` unchanged, add the prepare pair resolver, and compose the six-row truth table in `resolveDenoRuntimeConfig`. The client must validate the successful response status and `application/json` media type, bound the metadata header before decoding, require a non-null body, parse only the bounded error envelope, cancel rejected response bodies, and keep the timeout active until a resolved body closes or `cancel()` runs. It must return `resolved` without reading or buffering a successful body; only resolution-time status/header/metadata/null-body failures become `unavailable: malformed_response`.

  ```ts
  const controller = new AbortController();
  let response: Response | undefined;
  const cancelResponseBody = async (): Promise<void> => {
    const body = response?.body;
    if (body === null || body === undefined) return;
    await body.cancel().catch(() => undefined);
  };
  const timeout = setTimeout(() => {
    controller.abort();
    void cancelResponseBody();
    args.onTimeout?.();
  }, timeoutMs);
  response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
    body: request.body,
    signal: controller.signal,
  });

  const cancel = async (): Promise<void> => {
    clearTimeout(timeout);
    controller.abort();
    await cancelResponseBody();
  };
  ```

  Add an optional local `onTimeout?: () => void` callback to `prepareWithDeno`; it is invoked after the shared controller aborts and a best-effort response-body cancellation is requested when headers have already arrived. It is not part of the transport protocol. Wrap the successful response body so normal close clears the same timer, while a timeout after resolution keeps the resolved body in its terminal-failure path. Classify the HTTP status before parsing any error body. Map only the exact `400`/code and `413`/code combinations in the matrix to `rejected`; map a `500` with no envelope, `401`, `415`, all other `5xx`, every other status/code combination, wrong success media type, malformed metadata, null body, timeout before resolution, and network failures to `unavailable`. A body read or marker failure after resolution must not be mapped to `unavailable`; it must reach Task 6's phase-aware lifecycle. An allowlisted code on `500`, `401`, or `415` must never become `rejected`.

- [ ] **GREEN check: run focused tests and type checks**

  Run: `npm test -w apps/gateway-worker -- deno-tokenizer-config.test.ts deno-prepare-client.test.ts`

  Run: `npm run typecheck -w apps/gateway-worker`

  Expected GREEN result: all truth-table, forwarding, ownership, timeout, and malformed-response tests pass with no type errors.

- [ ] **REFACTOR: keep configuration failure scope and stream ownership explicit**

  Ensure prepare-only invalidity affects Responses only, tokenizer-group invalidity retains existing behavior, and every non-resolved outcome consumes or cancels the Deno response body. Rerun both focused commands.

### Task 6: Integrate prepare routing into the proxy

**Files:**
- Modify: `apps/gateway-worker/src/proxy.ts:248-778`
- Modify: `apps/gateway-worker/src/tokenization-routing.ts:12-117`
- Modify: `apps/gateway-worker/src/resource-observation.ts:1-94`
- Modify: `apps/gateway-worker/src/index.ts` — add optional `DENO_PREPARE_ENDPOINT` and `DENO_PREPARE_THRESHOLD_BYTES` bindings to `Env`
- Test: `apps/gateway-worker/test/proxy-failures.test.ts`
- Test: `apps/gateway-worker/test/tokenization-routing.test.ts`
- Create or modify: `apps/gateway-worker/test/proxy-prepare.test.ts`

**Interfaces:**
- Consumes: `DenoRuntimeConfig`, `prepareWithDeno`, `replaceOutputMarker`, existing `resolveTokenBudget`, and existing quota/upstream lifecycle methods.
- Produces: a prepare branch that uses validated Deno metadata directly for model, policy, quota, and audit decisions, then supplies a marker-replacement stream to `callUpstream` after reservation.
- Do not reconstruct or tokenize `metadata.inputText` in the Worker. Use a metadata-only prepared request shape containing `model`, `inputBytes`, `inputTextBytes`, `opaqueInputBytes`, `messageCount`, `estimatedInputTokens`, `maxOutputTokens`, `stream`, and `isToolUse`.
- `PrepareOutcome.rejected` maps only the five shared codes to existing public OCTG errors. `PrepareOutcome.unavailable` maps to `errInternal`; neither variant invokes `routeTokenization` or reserves quota.
- Before adding the prepare stage calls, add the literal `"prepare"` member to the existing `ResourceStage` union in `apps/gateway-worker/src/resource-observation.ts`. Keep `ResourceStageOutcome`, `ResourceStageRoute`, and `TokenizationProvider` unchanged; no new telemetry abstraction or variant is required.
- Reuse the existing `upstreamAttempted` boolean in `handleProxy` as the single attempt authority for both legacy and prepared routes. The prepared transport wrapper sets that existing flag immediately before the actual upstream fetch; do not add any parallel attempt flag. `UpstreamConfigError` remains a pre-upstream cleanup path because the transport wrapper is not invoked, while transport/body failures after the wrapper runs use existing uncertain semantics.
- Use the shared `PrepareMetadata` type for the retained metadata-only request
  shape; do not introduce a second metadata interface in `proxy.ts`.

The `ResourceStage` update is this future implementation step:

```ts
export type ResourceStage =
  | "body_read"
  | "parse"
  | "normalize"
  | "tokenize"
  | "prepare"
  | "quota_get_state"
  | "quota_reserve"
  | "upstream";
```

The prepare branch keeps these request-local lifecycle flags in the same
`handleProxy` scope as the quota and upstream state:

```ts
// Existing handleProxy state; it is the only upstream-attempt authority.
let upstreamAttempted = false;
let preparedQuotaReserved = false;
let explicitCancelInProgress = false;
let prepareTimedOut = false;
```

The `upstreamAttempted` declaration already exists in `handleProxy`; the
implementation must not redeclare it when adding the prepare branch. The
legacy route keeps its current assignment before `callUpstream`, and the
prepared route assigns the same flag in its transport wrapper immediately
before `fetch`. `preparedQuotaReserved` is set only after a resolved
reservation and is not derived from the later cleanup state. It is a
historical telemetry fact, not a replacement for `reservationState` or the
cleanup authority. `explicitCancelInProgress` gates the observer callback while
the explicit cancellation wrapper is awaiting the idempotent Deno
cancellation. `prepareTimedOut` prevents any later pre-upstream transition
from starting quota or upstream work after the Deno deadline has fired.

The following helpers are local to `apps/gateway-worker/src/proxy.ts` and are
part of this task's implementation contract:

```ts
type DeclaredContentLength =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "valid"; readonly value: number };

function parseDeclaredContentLength(value: string | null): DeclaredContentLength {
  if (value === null) return { kind: "absent" };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? { kind: "valid", value: parsed }
    : { kind: "malformed" };
}
```

`parseDeclaredContentLength` is pure. `null` returns `absent`; otherwise the
current Worker rule is preserved: `Number(value)` must be a safe integer at
least zero for `valid`, and every other value is `malformed`. Unlike the
existing `declaredContentLengthOf` helper, it does not collapse absent and
malformed values.

```ts
function createPrepareFinalizer(
  env: Env,
  requestId: string,
  startedAt: number,
): (
  outcome: ResourceStageOutcome,
  fields?: ResourceStageFields,
) => void {
  let finished = false;
  return function finishPrepareOnce(
    outcome: ResourceStageOutcome,
    fields: ResourceStageFields = {},
  ): void {
    if (finished) return;
    finished = true;
    finishResourceStage(env, requestId, "prepare", startedAt, outcome, fields);
  };
}

type PreparedBodyTerminal = "close" | "error" | "cancel";

function observePreparedBody(
  body: ReadableStream<Uint8Array>,
  cancelSource: () => Promise<void>,
  onTerminal: (terminal: PreparedBodyTerminal) => void,
): {
  readonly body: ReadableStream<Uint8Array>;
  readonly cancel: () => Promise<void>;
} {
  const reader = body.getReader();
  let terminalSeen = false;
  let cancelPromise: Promise<void> | undefined;
  const releaseReader = (): void => {
    try {
      reader.releaseLock();
    } catch {
      // The terminal path may already have released the lock.
    }
  };
  const notify = (terminal: PreparedBodyTerminal): void => {
    if (terminalSeen) return;
    terminalSeen = true;
    onTerminal(terminal);
  };
  const cancel = (): Promise<void> => {
    if (terminalSeen) return Promise.resolve();
    cancelPromise ??= (async () => {
      notify("cancel");
      await cancelSource().catch(() => undefined);
      await reader.cancel().catch(() => undefined);
      releaseReader();
    })();
    return cancelPromise;
  };
  return {
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            notify("close");
            releaseReader();
            controller.close();
            return;
          }
          controller.enqueue(chunk.value);
        } catch {
          notify("error");
          releaseReader();
          controller.error(new Error("Prepared body read failed."));
        }
      },
      cancel,
    }),
    cancel,
  };
}

function mapPrepareError(
  code: PrepareErrorCode,
  requestId: string,
): Parameters<typeof buildErrorResponse>[0] {
  switch (code) {
    case "invalid_body":
      return errInvalidRequest(requestId);
    case "non_text":
      return errNonTextInput(requestId);
    case "max_tokens_conflict":
      return errMaxTokensConflict(requestId);
    case "input_too_large":
    case "request_too_large":
      return errInputTooLarge(requestId);
    default:
      return assertNever(code, "prepare error code");
  }
}
```

The finalizer and observer are local to `proxy.ts`; they are not a generic
stream or lifecycle framework. `finishPrepareOnce` is the closure returned by
`createPrepareFinalizer` and is the only producer allowed to emit the prepare
finish event for a request. The first terminal callback wins and every later
callback is a no-op. `observePreparedBody` forwards each chunk once without
buffering or parsing, reports `close`, `error`, and `cancel`, and composes an
idempotent cancellation path with the Deno client's `cancel`. The observer is
wrapped around the marker-replacement stream immediately before
`callUpstream`, so a marker-transform failure is an error terminal rather than
a false successful close. `mapPrepareError` is pure and maps
`invalid_body` to `errInvalidRequest`, `non_text` to `errNonTextInput`,
`max_tokens_conflict` to `errMaxTokensConflict`, and both size codes to
`errInputTooLarge`.

**Steps:**

- [ ] **RED: add routing, lifecycle, and resource-stage tests**

  Split the scenarios so success and failure expectations cannot be mixed. For a resolved large Responses request, assert that `/prepare` is called before `readJsonBody`, `readJsonBody` and `routeTokenization` are not called, quota reservation is called once, upstream is called once, and settlement completes. The upstream transport fixture must consume its request body to EOF; consuming only the returned Worker response does not prove that the prepared body reached a terminal event. Also cover a request without `Content-Length`, small Responses requests using the legacy path, Chat Completions never using prepare, malformed `Content-Length` using the legacy path, and declared raw oversize canceling before Deno.

  ```ts
  const success = await handleProxy(largeResponsesRequest, env, ctx, "responses", "req-1");
  // Drain the returned proxy response in the test; this is not prepare-body validation.
  await success.text();

  expect(success.status).toBe(200);
  expect(callOrder).toEqual(["prepare", "quota_reserve", "upstream", "settlement"]);
  expect(prepareFetch).toHaveBeenCalledWith(expect.stringContaining("/prepare"), expect.objectContaining({
    body: largeResponsesRequest.body,
  }));
  expect(readJsonBodySpy).not.toHaveBeenCalled();
  expect(routeTokenizationSpy).not.toHaveBeenCalled();
  expect(quotaReserve).toHaveBeenCalledOnce();
  expect(upstreamFetch).toHaveBeenCalledOnce();
  const prepareFinishes = resourceStages.filter((event) => event.stage === "prepare" && event.phase === "finish");
  expect(prepareFinishes).toHaveLength(1);
  expect(prepareFinishes[0]).toMatchObject({
    outcome: "success",
    rawBodyBytes: metadata.rawBodyBytes,
    inputBytes: metadata.inputBytes,
    inputTextBytes: metadata.inputTextBytes,
    opaqueInputBytes: metadata.opaqueInputBytes,
    estimationPath: "exact_bpe",
    tokenizationProvider: "deno",
  });
  ```

  For separate `rejected` and `unavailable` prepare fixtures, assert
  `callOrder` is exactly `["prepare"]`, `readJsonBody`, `routeTokenization`,
  quota reservation, upstream, and settlement are not called, and the
  resolved-body `cancel` is not expected because no resolved body exists. Add
  a Deno body-read internal-failure fixture that returns `unavailable`, maps to
  `errInternal`, and likewise does not call `routeTokenization`, quota
  reservation, upstream, or settlement. Add
  the following resolved-body lifecycle cases with a controllable stream and
  inspect the prepare finish events by request ID:

  ```text
  resolved + normal close
    -> exactly one finish, outcome success, validated metadata counts present
  resolved + pre-upstream policy/quota rejection + cancel
    -> cancel underlying body, exactly one finish, rejection route, no upstream
  resolved + timeout/error before upstream attempt
    -> exactly one finish, outcome exception, pre-upstream cleanup
  resolved + response-body setup/read failure before transport wrapper runs
    -> upstreamAttempted remains false, known reservation release, no markUncertain
  valid metadata + missing marker after resolution
    -> prepare was initially resolved, stream fails at EOF, post-attempt cleanup
       uses markUncertain and never releases the reservation when transport ran
  valid metadata + duplicate marker after resolution
    -> prepare was initially resolved, stream fails during consumption,
       post-attempt cleanup uses markUncertain and never releases the reservation
  resolved + body error after upstream attempt
    -> upstreamAttempted is true, markUncertain called, release is not called,
       in-flight lease released, audit status uncertain, exactly one uncertain finish
  transport wrapper runs, then a generic exception reaches outer handleProxy catch
    -> upstreamAttempted is true, markUncertain called, release is not called,
       in-flight lease released, audit status uncertain
  UpstreamConfigError before transport wrapper runs
    -> upstreamAttempted remains false, reservation release, in-flight release,
       no markUncertain
  explicit cancel and stream terminal callback both fire
    -> exactly one finish event
  rejected/unavailable
    -> existing immediate finish exactly once
  ```

  The pre-wrapper setup/read case is an explicit phase-classifier test. In the
  normal lazy stream path, `reader.read()` begins only after the transport
  wrapper has run and therefore follows the post-attempt case above.

  `onTimeout` and the observer terminal callback must both exercise the same
  `finishPrepareOnce` closure. Every pre-upstream cancellation site must call
  one local `cancelPreparedBeforeUpstream` wrapper rather than calling
  `prepared.cancel()` directly, so explicit cancellation and a later stream
  callback cannot emit two finish events.

  Add quota/upstream cases asserting metadata model and policy checks, exact
  `metadata.estimatedInputTokens` passed to `resolveTokenBudget`, no second
  message/opaque overhead, CLAMP changing only the marker replacement value,
  REJECT returning before upstream, and body cancellation/release behavior for
  every pre-upstream terminal path. The cases must retain distinct triggers and
  cleanup assertions rather than collapsing all failures into one policy test:

  | Case | Required assertions |
  | --- | --- |
  | Model rejected | Prepared cancel exactly once; no reservation; no upstream |
  | Registry or policy load throws | Prepared cancel exactly once from outer catch; existing internal response and cleanup |
  | Tool-policy rejection | Prepared cancel exactly once; preserve quota snapshot; no reservation or upstream |
  | Quota `getState` throws | Prepared cancel exactly once; `errInternal`; no upstream |
  | Budget `arithmetic_error` | Prepared cancel exactly once; existing internal response; no reservation |
  | Budget `request_too_large` | Prepared cancel exactly once; existing request-too-large response; no reservation |
  | Budget `quota_exceeded` | Prepared cancel exactly once; existing quota-exceeded response; no reservation |
  | Reserve throws | Prepared cancel exactly once; existing fail-closed cleanup and internal response |
  | Reserve `unknown` | Prepared cancel exactly once; `markReserveOutcomeUnknown`; never release as known-unused |
  | Reserve rejected | Prepared cancel exactly once; existing rejection response |
  | In-flight admission rejected | Prepared cancel exactly once; resolved reservation released as existing behavior requires |
  | Generic pre-upstream outer-catch exception | Prepared cancel exactly once before existing quota cleanup |
  | Same failures after `upstreamAttempted === true` | Do not run pre-upstream cancellation; preserve existing uncertain semantics |

  Table-driven tests may be used only where the trigger and cleanup semantics
  are identical. Do not add a generic cleanup framework or hide a distinct
  quota-state transition behind a test abstraction.

  Add independent timeout-race tests for the stateful awaits. Use deferred
  Promises, not fake timers alone, to control the sequence
  `await starts -> timeout callback fires -> Durable Object operation resolves`.
  Each case must assert no upstream attempt, exactly one prepared-body cancel,
  and the timeout/internal response:

  | Timeout-race case | Required assertions |
  | --- | --- |
  | Reservation pending, then resolved success | `reservationState` is recorded as `resolved` and `preparedQuotaReserved` is true before cleanup; `quota_reserve` finishes exactly once with `success` and `quotaReserved: true`; reservation release occurs exactly once; no `markReserveOutcomeUnknown`; exactly one prepared-body cancel; `errInternal` |
  | Reservation pending, then `unknown` | `reservationState` is recorded as `unknown` before cleanup; `quota_reserve` finishes exactly once with `exception` and `quotaReserved: false`; `markReserveOutcomeUnknown` occurs exactly once; reservation release never occurs; exactly one prepared-body cancel; `errInternal` |
  | Reservation pending, then rejected | No resolved reservation is recorded or released; `quota_reserve` finishes exactly once with `rejected`, `quotaReserved: false`, and the existing reserve-failure route; the normal quota-rejection response is not returned; exactly one prepared-body cancel; `errInternal` |
  | In-flight admission pending, then successful lease | Lease and its generation are recorded before cleanup; `releaseInFlight` uses that generation exactly once; the resolved reservation is released exactly once; `errInternal` |
  | In-flight admission pending, then rejected | No in-flight lease release occurs; the resolved reservation is released exactly once; the normal concurrency-rejection response is not returned; `errInternal` |

  The reservation `unknown` fixture must include the existing fail-closed retry
  behavior before returning `unknown`. The successful in-flight fixture must
  verify the exact generation returned by the deferred acquisition, rather
  than only asserting that some release was attempted. These tests must prove
  that a completed Durable Object mutation is reconciled before the timeout
  branch returns.

- [ ] **RED check: run focused integration tests**

  Run: `npm test -w apps/gateway-worker -- proxy-prepare.test.ts proxy-failures.test.ts tokenization-routing.test.ts`

  Expected RED result: new prepare routing and lifecycle cases fail before proxy integration exists.

- [ ] **GREEN: add the prepare branch before Worker body parsing**

  After authentication and idempotency validation, resolve `DenoRuntimeConfig`. Return the existing internal configuration error for an invalid Responses prepare pair before body dispatch. Parse the raw `Content-Length` only for routing; distinguish absent from malformed. Reject a valid declared raw length above `maxInputBytes`, cancel the incoming body, and return `errInputTooLarge` without a Deno call. Select prepare only when `endpoint === "responses"`, prepare is enabled, the length is absent or above threshold, and the header is not malformed. Keep legacy `readJsonBody` and normalization unchanged for all other requests.

  ```ts
  const declared = parseDeclaredContentLength(request.headers.get("content-length"));
  if (declared.kind === "valid" && declared.value > maxInputBytes) {
    await request.body?.cancel().catch(() => undefined);
    return errorResponse(errInputTooLarge(requestId));
  }

  const usePrepare = endpoint === "responses" && prepare.kind === "enabled" &&
    declared.kind !== "malformed" &&
    (declared.kind === "absent" || declared.value > prepare.thresholdBytes);
  if (usePrepare) {
    const prepareStartedAt = startResourceStage(env, requestId, "prepare");
    const finishPrepareOnce = createPrepareFinalizer(env, requestId, prepareStartedAt);
    explicitCancelInProgress = false;
    preparedQuotaReserved = false;
    prepareTimedOut = false;
    const finishPrepareTimeout = (): void => {
      prepareTimedOut = true;
      if (explicitCancelInProgress) return;
      finishPrepareOnce(upstreamAttempted ? "uncertain" : "exception", {
        route: upstreamAttempted ? "error:upstream_uncertain" : "error:pre_upstream",
        quotaReserved: preparedQuotaReserved,
        upstreamReached,
      });
    };
    const outcome = await prepareWithDeno({
      endpoint: prepare.endpoint,
      authToken: prepare.authToken,
      timeoutMs: prepare.timeoutMs,
      maxInputBytes: prepare.maxInputBytes,
      request,
      onTimeout: finishPrepareTimeout,
    });
    // Handle resolved/rejected/unavailable before quota state or tokenization.
  }
  ```

- [ ] **GREEN: map outcomes and preserve metadata-only downstream decisions**

  Create `finishPrepareOnce` immediately after `startResourceStage` and pass
  its callback as `onTimeout` to `prepareWithDeno`. Map `invalid_body` to
  `errInvalidRequest`, `non_text` to `errNonTextInput`,
  `max_tokens_conflict` to `errMaxTokensConflict`, and both size codes to
  `errInputTooLarge`. Map a `500` body-read failure and every other
  `unavailable` outcome to `errInternal` with safe resource-stage fields.
  Finish the prepare stage immediately for every non-resolved outcome. The
  switch below remains inside the `if (usePrepare)` block immediately after
  the client call, so `prepareStartedAt`, `finishPrepareOnce`, and `outcome`
  are in scope. For `resolved`, retain `metadata`, `body`, and `cancel` as
  one ownership record and use metadata directly for model classification,
  tool policy, audit, and budget inputs; never create a large `inputText`
  placeholder or call `routeTokenization`. Separate the timeout guards by
  whether the await can create cleanup state. For read-only awaits
  (`loadRegistry`, `loadPolicy`, and quota `getState`), check
  `prepareTimedOut` immediately after the await and before using the returned
  value for a later decision. A successful `loadRegistry` await must have this
  guard before model classification. An await that throws follows the
  pre-transfer exception path in the cleanup matrix below.

  `reserveFailClosed` and `acquireInFlight` are different: their completed
  results can create reservation or lease cleanup authority even when the
  timeout callback has already fired. Commit each result to the existing
  request-local state before checking `prepareTimedOut`; do not use
  `preparedQuotaReserved` as a substitute for `reservationState`.

  For reservation, the required ordering is:

  ```ts
  const reserveOutcome = await reserveFailClosed(
    (sameRequestId, sameTokens, sameUpperBound, sameIdempotencyKey, sameClientId) =>
      stub.reserve(sameRequestId, sameTokens, sameUpperBound, sameIdempotencyKey, sameClientId),
    {
      requestId,
      tokens: reservation,
      upperBoundTokens: upperBound,
      idempotencyKey,
      clientId: auth.id,
    },
  );

  if (reserveOutcome.kind === "unknown") {
    reservationState = "unknown";
  } else if (reserveOutcome.result.ok) {
    reservationState = "resolved";
    preparedQuotaReserved = true;
  } else {
    reservationState = "none";
  }

  // Finish quota telemetry from the completed mutation result before applying
  // prepare-timeout precedence to cleanup and the public response.
  if (reserveOutcome.kind === "unknown") {
    finishResourceStage(
      env,
      requestId,
      "quota_reserve",
      reserveStartedAt,
      "exception",
      {
        route: "error:pre_upstream",
        quotaReserved: false,
        upstreamReached: false,
      },
    );
  } else {
    const reserved = reserveOutcome.result;
    finishResourceStage(
      env,
      requestId,
      "quota_reserve",
      reserveStartedAt,
      reserved.ok ? "success" : "rejected",
      {
        route: reserved.ok ? "free_shared" : routeForReserveFailure(reserved.reason),
        quotaReserved: reserved.ok,
        upstreamReached: false,
      },
    );
  }
  reserveStageStartedAt = undefined;

  if (prepareTimedOut) {
    await cancelPreparedBeforeUpstream("exception", {
      route: "error:pre_upstream",
      quotaReserved: preparedQuotaReserved,
      upstreamReached: false,
    });
    if (reservationState === "unknown") {
      await stub.markReserveOutcomeUnknown(requestId).catch(() => undefined);
    } else if (reservationState === "resolved") {
      await stub.release(requestId).catch(() => undefined);
      reservationState = "none";
    }
    completeAudit(ctx, env, requestId, auditInserted, {
      status: "failed",
      billingClass: "none",
    });
    return errorResponse(errInternal(requestId));
  }

  ```

  The timeout branch must take precedence over the ordinary public quota
  rejection branch, but it must not overwrite the completed quota operation's
  resource-stage outcome. The `quota_reserve` finish event is emitted exactly
  once from the returned `ReserveOutcome` before timeout cleanup:

  | Reservation result after timeout | `quota_reserve` outcome | Cleanup | Public result |
  | --- | --- | --- | --- |
  | resolved success | `success`, `quotaReserved: true` | Cancel the prepared body and release the reservation exactly once | `errInternal` |
  | `unknown` | `exception`, `quotaReserved: false` | Cancel the prepared body and call `markReserveOutcomeUnknown`; never release as known-unused | `errInternal` |
  | resolved rejection | `rejected`, `quotaReserved: false`, existing reserve-failure route | Cancel the prepared body; no reservation release | `errInternal` |

  An unknown result is marked unknown and is never released as known-unused; a
  resolved result is released; a rejected result has no reservation to
  release. `prepareTimedOut` controls cleanup and public response precedence,
  not the quota resource-operation outcome. Clear `reserveStageStartedAt`
  immediately after the single `quota_reserve` finish and do not let this
  timeout branch rely on the outer catch for stage finalization. Do not add a
  generic quota state machine.

  For in-flight admission, record a successful lease and its generation before
  the timeout guard, then release that exact generation in the timeout branch:

  ```ts
  const lease = await stub.acquireInFlight(
    requestId,
    resolveMaxInFlightRequests(env.MAX_IN_FLIGHT_REQUESTS),
    resolveInFlightLeaseTtlMs(env.IN_FLIGHT_LEASE_TTL_MS),
  );
  if (lease.ok) {
    inFlightAcquired = true;
    inFlightLease = lease.lease;
  }

  if (prepareTimedOut) {
    await cancelPreparedBeforeUpstream("exception", {
      route: "error:pre_upstream",
      quotaReserved: preparedQuotaReserved,
      upstreamReached: false,
    });
    if (inFlightAcquired && inFlightLease !== undefined) {
      await releaseInFlightBestEffort(stub, inFlightLease);
      inFlightAcquired = false;
      inFlightLease = undefined;
    }
    if (reservationState === "resolved") {
      await stub.release(requestId).catch(() => undefined);
      reservationState = "none";
    }
    completeAudit(ctx, env, requestId, auditInserted, {
      status: "failed",
      billingClass: "none",
    });
    return errorResponse(errInternal(requestId));
  }

  ```

  The existing acquire arguments, release helper, reservation cleanup, and
  audit semantics must be used. Repeat the timeout guard immediately before
  `callUpstream` so a timeout cannot start an upstream attempt.

  ```ts
  let metadata: PrepareMetadata;
  let prepared: {
    metadata: PrepareMetadata;
    body: ReadableStream<Uint8Array>;
    cancel: () => Promise<void>;
  };

  switch (outcome.kind) {
    case "rejected":
      finishPrepareOnce("rejected", {
        quotaReserved: false,
        upstreamReached: false,
      });
      return errorResponse(mapPrepareError(outcome.code, requestId));
    case "unavailable":
      finishPrepareOnce("exception", {
        quotaReserved: false,
        upstreamReached: false,
      });
      return errorResponse(errInternal(requestId));
    case "resolved":
      metadata = outcome.metadata;
      prepared = { metadata, body: outcome.body, cancel: outcome.cancel };
      break;
    default:
      return assertNever(outcome, "prepare outcome");
  }
  ```

**Pre-transfer cleanup matrix:**

The following matrix is exhaustive for a resolved prepared body while ownership
is still in the Worker. Add the cancellation at the named existing branch; do
not replace the branch with a generic error path. The existing public response,
quota snapshot, audit status, resource-stage route, and reservation semantics
remain unchanged.

| Existing pre-transfer path in `proxy.ts` | Required prepared-body action | Existing quota/audit/public behavior to preserve |
| --- | --- | --- |
| `loadRegistry(env)` or model classification throws (`370`) | Outer catch calls `cancelPreparedBeforeUpstream("exception", ...)` before existing quota cleanup | No reservation; existing internal error and audit cleanup |
| `pool === "NONE"` model rejection (`371`) | Call `cancelPreparedBeforeUpstream("rejected", ...)` before the existing return | No quota action; preserve `errModelRequiresPaid` |
| `loadPolicy` throws (`375`) | Outer catch calls `cancelPreparedBeforeUpstream("exception", ...)` before existing quota cleanup | No reservation; existing internal error and audit cleanup |
| Tool-policy rejection after `getState` succeeds (`377-383`) | Call `cancelPreparedBeforeUpstream("rejected", ...)` before the existing return | No reservation; preserve the quota snapshot and `errModelNotAllowed` |
| Tool-policy or main quota `getState` throws (`383-407`) | Outer catch calls `cancelPreparedBeforeUpstream("exception", ...)` before existing quota cleanup | No known reservation; existing internal error and audit cleanup |
| Timeout during reservation, then resolved success | First record `reservationState = "resolved"` and `preparedQuotaReserved = true`; finish `quota_reserve` exactly once as `success` with `quotaReserved: true`; then cancel the prepared body, release the reservation, and return `errInternal` | No upstream; timeout/internal failure takes precedence over normal continuation while quota telemetry preserves the successful reservation result |
| Timeout during reservation, then `unknown` | First record `reservationState = "unknown"`; finish `quota_reserve` exactly once as `exception` with `quotaReserved: false`; then cancel the prepared body and call `markReserveOutcomeUnknown`; never release as known-unused | No upstream; preserve fail-closed unknown semantics and return `errInternal` |
| Timeout during reservation, then rejected result | First record that no reservation exists; finish `quota_reserve` exactly once as `rejected` with `quotaReserved: false` and the existing reserve-failure route; then cancel the prepared body and return `errInternal` | No upstream; do not return the normal quota-rejection response, and do not relabel the rejected operation as an exception |
| `resolveTokenBudget` returns `arithmetic_error` (`476-489`) | Call `cancelPreparedBeforeUpstream("exception", ...)` before the existing return | No reservation; preserve the existing internal response and tokenize finish |
| `resolveTokenBudget` returns `request_too_large` (`490-493`) | Call `cancelPreparedBeforeUpstream("rejected", ...)` before the existing return | No reservation; preserve the existing request-too-large response |
| `resolveTokenBudget` returns `quota_exceeded` (`494-497`) | Call `cancelPreparedBeforeUpstream("rejected", ...)` before the existing return | No reservation; preserve the existing quota-exceeded response |
| `reserveFailClosed` throws (`508-527`) | Its catch path calls `cancelPreparedBeforeUpstream("exception", ...)` before rethrowing to outer cleanup | Preserve existing fail-closed cleanup and internal error mapping |
| Reserve outcome is `unknown` (`529-538`) | Call `cancelPreparedBeforeUpstream("exception", ...)` exactly once before return; then preserve the existing unknown outcome state | Call `markReserveOutcomeUnknown`; never release as known-unused; preserve audit/internal response |
| Reserve outcome is rejected (`540-574`) | Call `cancelPreparedBeforeUpstream("rejected", ...)` before the existing return | No resolved reservation; preserve duplicate-idempotency or quota-exceeded response and snapshot |
| `acquireInFlight` throws (`580-584`) | Outer catch calls `cancelPreparedBeforeUpstream("exception", ...)` before existing cleanup | Preserve resolved-reservation release and existing internal error mapping |
| Timeout during successful in-flight acquisition | First record `inFlightAcquired = true` and the returned lease generation; then cancel the prepared body, release that exact lease generation, release the resolved reservation, and return `errInternal` | No upstream; no lease or reservation capacity remains held |
| Timeout during rejected in-flight admission | First record that no lease exists; then cancel the prepared body, release the resolved reservation, and return `errInternal` | No upstream; do not return the normal concurrency-rejection response |
| In-flight admission is rejected (`585-590`) | Call `cancelPreparedBeforeUpstream("rejected", ...)` exactly once before the existing reservation release and return | Preserve resolved-reservation release, audit status, and `errWorkerConcurrencyExceeded` |
| Transform/observer setup or `UpstreamConfigError` before the transport wrapper (`594-646`) | Call `cancelPreparedBeforeUpstream("exception", ...)` before releasing known state | Preserve reservation release, in-flight release, and existing pre-upstream error path |
| Any other outer-catch exception while the prepared body is Worker-owned and `upstreamAttempted === false` | Idempotently call `cancelPreparedBeforeUpstream("exception", ...)` before the current quota/in-flight cleanup | Preserve the existing reservation-state cleanup and internal error response |

Controlled return branches must await the cancellation immediately before the
existing return or its existing audit/quota cleanup. Exception branches must
use the same request-local prepared ownership record and cancellation wrapper
from the outer catch, before the current cleanup at `744-776`. Keep the
cancellation callback reachable from that outer catch; do not hide it inside a
block that ends before the catch. If timeout, observer terminal handling, or an
earlier explicit cancellation already finished the body, the idempotent cancel
and `finishPrepareOnce` no-op rather than emitting a second finish event. Once
the transport wrapper sets the existing `upstreamAttempted` flag, the outer
catch must not run this pre-upstream cancellation path.

- [ ] **GREEN: preserve quota lifecycle and transfer stream ownership at upstream transport**

  Read quota state and call `resolveTokenBudget` exactly once with `metadata.estimatedInputTokens` and `metadata.maxOutputTokens`. Track `preparedQuotaReserved` separately from later cleanup mutations; set it to `true` immediately after a reservation is accepted and leave it available to the prepare finalizer even when later cleanup releases the reservation. `reservationState` remains the reservation cleanup authority. After `reserveFailClosed` returns, record `unknown`, `resolved`, or no-reservation state and set the historical `preparedQuotaReserved` fact before any `prepareTimedOut` branch. Finish `quota_reserve` exactly once from that actual returned `ReserveOutcome`: `unknown` is `exception`, a resolved successful reservation is `success`, and a resolved rejection is `rejected` with `routeForReserveFailure`. Clear `reserveStageStartedAt` before timeout cleanup so neither the timeout branch nor the outer catch can finish the stage again. A timeout changes the public result and cleanup precedence, not the already-completed quota operation's resource-stage outcome. After `acquireInFlight` returns, record `inFlightAcquired` and the returned `inFlightLease` generation before any timeout branch. A timeout after either operation has completed must reconcile the recorded state, cancel the prepared body, perform only the applicable release or unknown marking, complete the existing failed audit, and return `errInternal`; it must not continue to a normal quota/concurrency rejection or start upstream work. Apply model/policy failures and reservation/in-flight rejections before upstream ownership transfer through a local `cancelPreparedBeforeUpstream(outcome, fields)` wrapper that awaits the idempotent Deno cancellation and then calls `finishPrepareOnce`; the wrapper is the only direct caller of `prepared.cancel()`. After successful reservation and in-flight admission, build the marker transform, wrap that transformed stream with `observePreparedBody`, and pass the observed stream to `callUpstream`. The terminal callback must use the following mapping:

```ts
const finishPreparedTerminal = (terminal: PreparedBodyTerminal): void => {
  if (explicitCancelInProgress) return;
  const attempted = upstreamAttempted;
  if (terminal === "close") {
    finishPrepareOnce("success", {
      rawBodyBytes: metadata.rawBodyBytes,
      inputBytes: metadata.inputBytes,
      inputTextBytes: metadata.inputTextBytes,
      opaqueInputBytes: metadata.opaqueInputBytes,
      estimationPath: metadata.estimationPath,
      tokenizationProvider: "deno",
      quotaReserved: preparedQuotaReserved,
      upstreamReached,
    });
    return;
  }
  finishPrepareOnce(attempted ? "uncertain" : "exception", {
    route: attempted ? "error:upstream_uncertain" : "error:pre_upstream",
    quotaReserved: preparedQuotaReserved,
    upstreamReached,
  });
};

const cancelPreparedBeforeUpstream = async (
  outcome: "rejected" | "exception",
  fields: ResourceStageFields,
): Promise<void> => {
  explicitCancelInProgress = true;
  try {
    await prepared.cancel().catch(() => undefined);
  } finally {
    explicitCancelInProgress = false;
    finishPrepareOnce(outcome, fields);
  }
};
```

`explicitCancelInProgress` is a request-local boolean declared before these
closures and is reset only by `cancelPreparedBeforeUpstream`. The `onTimeout`
callback uses the same failure mapping, with `terminal` treated as `error`; it
must not record body content, marker, credentials, or the thrown error. A
pre-upstream explicit rejection calls
`cancelPreparedBeforeUpstream("rejected", { route, quotaReserved, upstreamReached: false })`.
The observer's `cancel` callback and the explicit cancellation wrapper race
through the same one-shot finalizer, so only the first call emits the finish
event. The observer forwards the marker-replacement stream one chunk at a
time; it never buffers or parses the large body.

Wrap the prepared transport so the existing `upstreamAttempted` flag is set
immediately before the actual fetch:

  ```ts
  const upstreamTransport: UpstreamTransport = (input, init) => {
    upstreamAttempted = true;
    return fetch(input, init);
  };
  const budget = resolveTokenBudget({
    estimatedInput: metadata.estimatedInputTokens,
    maxOutputTokens: metadata.maxOutputTokens,
    remaining: before.remaining,
    limit: before.limit,
    outputLimitMode: policy.outputLimitMode,
  });
  const replacedBody = replaceOutputMarker(prepared.body, metadata.outputMarker, budget.maxOutputTokens);
  const observed = observePreparedBody(replacedBody, prepared.cancel, finishPreparedTerminal);
  prepared = {
    ...prepared,
    body: observed.body,
    cancel: observed.cancel,
  };
  const upstream = await callUpstream(env, "/responses", prepared.body, meta, cacheKey, idempotencyKey, upstreamTransport);
  ```

  A transform or observer setup failure or `UpstreamConfigError` before the transport wrapper runs calls `cancelPreparedBeforeUpstream("exception", { route: "error:pre_upstream", quotaReserved: preparedQuotaReserved, upstreamReached: false })`, releases known state, and finishes the prepare stage exactly once. The same request-local cancellation callback is reachable from the outer catch for every matrix row whose `upstreamAttempted` value is still `false`; invoke it before the existing reservation and in-flight cleanup. A failure after the wrapper runs marks the request uncertain, never releases the reservation as known-unused, and releases only the in-flight lease, following the existing stream settlement path. The prepare resource stage remains open until the observed prepared body closes, errors, is canceled, or the shared timeout callback fires.

- [ ] **GREEN check: run focused integration checks and type check**

  Run: `npm test -w apps/gateway-worker -- proxy-prepare.test.ts proxy-failures.test.ts tokenization-routing.test.ts`

  Run: `npm run typecheck -w apps/gateway-worker`

  This typecheck must cover the `ResourceStage` union update and every
  `startResourceStage`/`finishResourceStage` call using the new `"prepare"`
  stage; do not silence the calls with a type assertion.

  Expected GREEN result: prepare routing, exact quota accounting, cleanup phases, marker forwarding, failure mapping, and legacy regression tests pass.

- [ ] **REFACTOR: isolate prepared and legacy lifecycles**

  Keep existing Chat/legacy code paths and quota settlement helpers unchanged; add branching only at the documented prepare boundary. Ensure the proxy has only the existing `upstreamAttempted` attempt flag, with `upstreamReached` retained only as the separate response-received fact. Recheck every row of the pre-transfer cleanup matrix, including synchronous budget returns, thrown awaits, the outer catch, and the registry-load timeout guard. Ensure every resolved prepared body has exactly one terminal finalizer invocation, whether the event is normal close, read error, timeout, explicit cancel, or upstream cancellation. Ensure prepare telemetry contains only safe counts/enums/provider state and never body content, markers, credentials, or thrown error text.

  The timeout-ordering check must also prove all of the following:

  - No timeout guard runs before a reservation or in-flight mutation result is recorded.
  - `reservationState` remains the reservation cleanup authority.
  - `preparedQuotaReserved` remains a historical telemetry fact and is never used as cleanup authority.
  - `inFlightAcquired` and `inFlightLease` are recorded immediately after successful acquisition and before the timeout branch.
  - `reservationState === "unknown"` never reaches a known-unused release path.
  - A timeout that has fired cannot start a new upstream attempt.
  - Every Durable Object operation that began before timeout has its completed result reconciled before the request returns.
  - The `quota_reserve` finish event is emitted exactly once from the actual `ReserveOutcome`: success, rejected, or unknown/exception.
  - A prepare timeout never relabels a successful or rejected quota reservation operation as `exception`.
  - `prepare` remains `exception` for the timeout while the public result remains `errInternal`.
  - A resolved reservation is released, an unknown reservation is marked unknown without release, and a rejected reservation has no release path.
  - The prepared body is canceled exactly once in every reservation timeout-race row.
  - The complete F-014 pre-transfer cleanup matrix remains covered, including every cancellation-before-cleanup ordering.
  - The F-012 single `upstreamAttempted` authority remains unchanged.
  - `finishPrepareOnce` retains its exactly-once contract across timeout, explicit cancel, and stream-terminal races.

  Rerun the focused commands.

### Task 7: Update deployment configuration and documentation

**Files:**
- Modify: `.env.example`
- Modify: `docs/deno-tokenizer.md`
- Modify: `docs/configuration.md`
- Modify: `SPEC.md`
- Modify: `docs/operations.md`
- Modify: `.github/workflows/deploy-production.yml` only where the prepare pair is uploaded
- Modify: `.github/workflows/preview-smoke.yml` only where preview prepare mapping is required
- Modify: `scripts/production-deno-config.mjs`
- Modify: `scripts/production-deno-config.test.mjs`
- Modify: `scripts/preview-worker-config.mjs`
- Modify: `scripts/preview-worker-config.test.mjs`
- Modify: `scripts/preview-workflow.test.sh` only for prepare mapping coverage
- Modify: `scripts/setup-preview.zsh` and `scripts/setup-preview.test.zsh` only for prepare variables
- Verify only: `apps/gateway-worker/wrangler.jsonc`, `deno.json`, `.github/workflows/deploy-deno-tokenizer.yml`

**Interfaces:**
- Consumes: implemented prepare configuration names and `/prepare` contract.
- Produces: documented disabled-by-default configuration, rollout, rollback, security, and acceptance procedures.

- [ ] **RED: add configuration propagation tests**

  Extend production validation to require the existing tokenizer group as before while accepting the optional complete prepare pair. For Preview, keep the three layers distinct: `.env` and GitHub Environment variables are `DENO_PREVIEW_PREPARE_ENDPOINT` and `DENO_PREVIEW_PREPARE_THRESHOLD_BYTES`; workflow/process environment names are `PREVIEW_DENO_PREPARE_ENDPOINT` and `PREVIEW_DENO_PREPARE_THRESHOLD_BYTES`; generated Worker bindings are `DENO_PREPARE_ENDPOINT` and `DENO_PREPARE_THRESHOLD_BYTES`. Add tests proving the first layer maps through the second layer to the Worker bindings. Add shell/workflow assertions that both absent values produce no `--var` arguments and that exactly one present value is rejected rather than silently disabling prepare.

  ```js
  const config = buildPreviewWorkerConfig(baseConfig, {
    ...baseDenoConfig,
    deno: {
      endpoint: "https://preview-tokenizer.test/tokenize",
      thresholdBytes: "1",
      timeoutMs: "5000",
    },
    prepare: {
      endpoint: "https://preview-deno.test/prepare",
      thresholdBytes: "700000",
    },
  });

  expect(config.vars.DENO_PREPARE_ENDPOINT).toBe("https://preview-deno.test/prepare");
  expect(config.vars.DENO_PREPARE_THRESHOLD_BYTES).toBe("700000");
  expect(buildPreviewWorkerConfig(baseConfig, {
    ...baseDenoConfig,
    prepare: undefined,
  }).vars).not.toHaveProperty("DENO_PREPARE_ENDPOINT");
  ```

- [ ] **RED check: run configuration tests**

  Run: `node --test scripts/production-deno-config.test.mjs scripts/preview-worker-config.test.mjs`

  Run: `bash scripts/preview-workflow.test.sh`

  Run: `npm run test:preview-workflow`

  Expected RED result: new prepare validation/mapping cases fail before the production and Preview configuration paths are extended. The individual workflow script is not sufficient; the `npm run test:preview-workflow` suite is the Preview verification gate because it also runs `setup-preview.test.zsh` and the Preview D1/quota contract checks.

- [ ] **GREEN: implement propagation and human-readable documentation**

  Add the prepare pair to production validation as an optional all-or-nothing group and reject one-sided or invalid values. In Preview, read `DENO_PREVIEW_PREPARE_ENDPOINT` and `DENO_PREVIEW_PREPARE_THRESHOLD_BYTES` from `.env`/the GitHub Environment, pass them into the workflow as `PREVIEW_DENO_PREPARE_ENDPOINT` and `PREVIEW_DENO_PREPARE_THRESHOLD_BYTES`, and map them explicitly to Worker `DENO_PREPARE_ENDPOINT` and `DENO_PREPARE_THRESHOLD_BYTES`. Build deployment arguments only for a complete valid pair, while rejecting a one-sided pair before argument construction:

  ```sh
  prepare_args=()
  if [ -n "${PREVIEW_DENO_PREPARE_ENDPOINT:-}" ] && [ -z "${PREVIEW_DENO_PREPARE_THRESHOLD_BYTES:-}" ] || \
     [ -z "${PREVIEW_DENO_PREPARE_ENDPOINT:-}" ] && [ -n "${PREVIEW_DENO_PREPARE_THRESHOLD_BYTES:-}" ]; then
    printf '%s\n' "Preview prepare variables must be supplied together" >&2
    exit 2
  fi
  if [ -n "${PREVIEW_DENO_PREPARE_ENDPOINT:-}" ] && [ -n "${PREVIEW_DENO_PREPARE_THRESHOLD_BYTES:-}" ]; then
    prepare_args+=(--var "DENO_PREPARE_ENDPOINT:${PREVIEW_DENO_PREPARE_ENDPOINT}")
    prepare_args+=(--var "DENO_PREPARE_THRESHOLD_BYTES:${PREVIEW_DENO_PREPARE_THRESHOLD_BYTES}")
  fi
  ```

  Document that prepare is disabled by absence of both Worker variables, both variables are required together, `MAX_INPUT_BYTES` remains `1048576`, and prepare-only invalidity affects Responses without changing Chat Completions. Document the five protocol errors, metadata/header bounds, marker replacement, no-DO-fallback rule, quota-before-upstream order, no payload/secret logging, Stage 1 deployment with prepare absent, Deno `/prepare` health/auth verification, sanitized approximately 74k-token canaries at concurrency 1 and 2, resource-stage acceptance, and rollback to a known Worker version that predates prepare. Keep `/tokenize` documentation intact.

- [ ] **GREEN check: run configuration and documentation checks**

  Run: `node --test scripts/production-deno-config.test.mjs scripts/preview-worker-config.test.mjs`

  Run: `bash scripts/preview-workflow.test.sh`

  Run: `npm run test:preview-workflow`

  Run: `git diff --check`

  Expected GREEN result: configuration tests prove explicit Production/Preview mapping without empty placeholders, `npm run test:preview-workflow` passes the workflow, setup, Preview D1, and quota contract checks, and documentation has no whitespace errors. Do not treat the individual `bash scripts/preview-workflow.test.sh` result as sufficient for this task.

- [ ] **REFACTOR: verify read-only deployment references and scope**

  Confirm `apps/gateway-worker/wrangler.jsonc`, `deno.json`, and `.github/workflows/deploy-deno-tokenizer.yml` remain unchanged unless an implementation test proves a concrete existing binding/staging change is required. Rerun the configuration tests and `git diff --check`.

### Task 8: Execute full verification and CPU regression canary

**Files:**
- No source changes expected.
- Test artifacts: temporary sanitized payloads outside the repository; do not add production prompts or secrets.

**Interfaces:**
- Consumes: all Stage 1/2 implementation and documentation changes.
- Produces: verified test output and an acceptance record containing no sensitive request content.

- Task 8 changes no code, so its RED/GREEN checkpoints are acceptance checkpoints rather than a new implementation loop. Any code fix found here returns to the originating task's RED test before proceeding.

- [ ] **RED: run the complete automated falsification pass**

  Run: `npm test`

  Run: `npm run typecheck`

  Run: `deno check apps/deno-tokenizer/src/main.ts apps/deno-tokenizer/test/*.test.ts`

  Run: `deno test --allow-env --allow-read apps/deno-tokenizer/test`

  Run: `npm run test:preview-workflow`

  Expected RED checkpoint: record every failure with its command and affected task; do not weaken a test or bypass a failing check.

- [ ] **GREEN: verify the implemented behavior against the acceptance matrix**

  Confirm `MAX_INPUT_BYTES` is still `1048576`; large Responses requests route to Deno before Worker JSON parsing; small Responses and all Chat Completions retain their existing paths; exact estimates match legacy accounting; Deno failures fail closed without DO fallback; quota decisions do not depend on D1 or Deno state; and no raw request content or credential appears in logs or telemetry.

  **Successful prepare acceptance fixture:**

  Consume the non-streaming response body, or await the stream completion for
  a streaming fixture, before asserting the settlement call order.

  ```ts
  expect(callOrder).toEqual(["prepare", "quota_reserve", "upstream", "settlement"]);
  expect(resolveTokenBudget).toHaveBeenCalledWith(expect.objectContaining({
    estimatedInput: metadata.estimatedInputTokens,
    maxOutputTokens: metadata.maxOutputTokens,
  }));
  expect(tokenizerRpc).not.toHaveBeenCalled();
  expect(quotaReserve).toHaveBeenCalledOnce();
  expect(upstreamFetch).toHaveBeenCalledOnce();
  ```

  **Prepare failure acceptance fixture:**

  ```ts
  expect(callOrder).toEqual(["prepare"]);
  expect(tokenizerRpc).not.toHaveBeenCalled();
  expect(quotaReserve).not.toHaveBeenCalled();
  expect(upstreamFetch).not.toHaveBeenCalled();
  expect(settlement).not.toHaveBeenCalled();
  ```

  Send representative sanitized Responses payloads in the approximately 74k-token class at concurrency 1 and 2 through a prepare-enabled deployment. Verify HTTP success, normal quota headers, `prepare` start/finish events, successful reservation and settlement, and absence of Worker `exceededCpu` for the incident payload class.

- [ ] **GREEN check: rerun the full commands after accepted fixes**

  Run: `npm test`

  Run: `npm run typecheck`

  Run: `deno check apps/deno-tokenizer/src/main.ts apps/deno-tokenizer/test/*.test.ts`

  Run: `deno test --allow-env --allow-read apps/deno-tokenizer/test`

  Run: `npm run test:preview-workflow`

  Expected GREEN result: all five automated commands above pass and the canary acceptance record contains only safe metrics and identifiers.

- [ ] **REFACTOR: verify rollback and final scope**

  Record a known Worker version that predates prepare, and roll back to that version rather than relying on omission from a later `--keep-vars` upload. If prepare variables are removed, remove the complete pair through the supported control-plane operation; never upload empty placeholders. Send the same synthetic large Responses payload after rollback and verify no `prepare` stage, legacy `body_read`/`parse`/`normalize` stages, retained `/tokenize` availability, tokenizer-provider behavior according to the retained threshold, correct quota reservation, and correct upstream settlement.

  Run: `git status --short`

  Run: `git diff --check`

  Expected: only intended implementation, test, and documentation files are changed; pre-existing `deno.lock` remains untouched. Rerun the relevant focused command after any cleanup-only change.

## Bidirectional Traceability

The following matrix is the implementation gate for the decisions that were
revised in the review. Each row names both the design source and the plan
steps that must provide executable evidence.

| Requirement or decision | Design location | Plan verification |
| --- | --- | --- |
| Raw-body read transport failure is internal | `Prepare Response Contract`, `Error Handling`, `Testing` | Tasks 1, 4, 5, and 6: reader rejection, status-only `500`, `unavailable`, `errInternal`, and no downstream calls |
| Invalid JSON is public validation only after complete read | `Prepare Response Contract`, `Error Handling` | Tasks 1 and 4: complete-read parse failure returns `400 invalid_body`; Tasks 5/6 preserve the mapping |
| Raw oversize remains `request_too_large` | `Stage 2: Deno Prepare`, `Prepare Response Contract`, `Testing` | Tasks 1, 2, 4, 5, and 6: declared/measured oversize, `413`, cancellation, and no Deno/quota/upstream call where applicable |
| Prepare-resolution failure fails closed | `Invariants`, `Worker Data Flow`, `Error Handling` | Tasks 4-6: no Durable Object tokenizer fallback, quota reservation, or upstream call |
| Prepare resolution validates only headers/metadata/body presence | `Prepare Response Contract`, `Worker Data Flow`, `Error Handling`, `Testing` | Tasks 3, 5, and 6: status, success media type, bounded metadata, null-body checks, and successful body forwarding without buffering |
| Resolved body integrity is a stream-lifecycle concern | `Prepare Response Contract`, `Worker Data Flow`, `Observability`, `Testing` | Tasks 3 and 6: marker/EOF/read failures after resolution, with phase-aware cleanup and no `response.text()`/`response.json()` success path |
| Resolved prepare resource stage stays open through ownership | `Observability`, `Worker Data Flow` | Task 6: observer, timeout callback, cancellation wrapper, and one-shot finish |
| Normal resolved body close finishes successfully with metadata | `Observability`, `Testing` | Task 6: upstream fixture consumes the body to EOF; exactly one success finish with validated counts |
| Resolved body error or timeout finishes in the correct phase | `Worker Data Flow`, `Observability`, `Testing` | Tasks 5 and 6: prepare timeout remains `exception` with public `errInternal`; quota operation outcome remains independent; pre-upstream exception cleanup, stateful-await timeout races, post-attempt uncertain cleanup, exactly once |
| Existing `upstreamAttempted` is the only attempt authority | `Invariants`, `Worker Data Flow`, `Error Handling` | Task 6: legacy assignment preserved, prepared transport sets the same flag before fetch, post-attempt release is forbidden, and no parallel attempt flag exists |
| `ResourceStage` includes the prepare stage | `Observability`, `Testing` | Task 6: add `"prepare"` to the existing union and run the Worker typecheck over all prepare stage calls |
| Every resolved prepared-body terminal path before transport transfer cancels the body | `Worker Data Flow` steps 6-10, `Error Handling` | Task 6: exhaustive matrix for registry/model/policy/quota/budget/reserve/in-flight/setup/outer-catch paths; each controlled return and thrown exception has a cancel-once assertion |
| Pre-upstream explicit cancel is idempotent and observable | `Worker Data Flow`, `Observability`, `Testing` | Task 6: request-local `cancelPreparedBeforeUpstream`, outer-catch ordering before existing quota cleanup, and cancel/terminal race test |
| Prepare timeout guards cover every long await | `Worker Data Flow` steps 6-10, `Observability` | Task 6: read-only guards after registry load, policy load, and quota state; reservation and in-flight results are recorded before their timeout guards; thrown-await cancellation is covered separately |
| A completed reservation result is not discarded or misclassified by timeout | `Worker Data Flow`, `Error Handling`, `Observability` | Task 6: record `reservationState` and `preparedQuotaReserved` before timeout cleanup; finish `quota_reserve` exactly once from the actual `ReserveOutcome`; release resolved reservations, mark unknown outcomes, and never release unknown as known-unused |
| Quota resource-stage telemetry preserves the completed operation outcome | `Observability`, `Worker Data Flow`, `Testing` | Task 6: resolved success finishes `quota_reserve` as `success`, resolved rejection as `rejected` with the existing route, and unknown as `exception`; timeout still returns public `errInternal` |
| An acquired in-flight lease remains releasable after timeout | `Worker Data Flow`, `Error Handling` | Task 6: record `inFlightAcquired` and the returned generation before timeout cleanup; release that exact generation before returning `errInternal` |
| Timeout takes precedence over normal quota/concurrency rejection | `Worker Data Flow`, `Error Handling`, `Testing` | Task 6: deferred race tests for reservation rejected and in-flight rejected outcomes return `errInternal`, cancel once, and never attempt upstream |
| Exact token accounting is preserved | `Stage 2: Deno Prepare`, `Prepare Response Contract` | Tasks 4 and 6: exact BPE metadata and one `resolveTokenBudget` call with no double overhead |
| Preview three-layer propagation is preserved | `Rollout and Acceptance` | Task 7: workflow, setup, and generated binding tests |
| Rollback remains explicit and verifiable | `Rollout and Acceptance` | Tasks 7 and 8: known previous Worker version and post-rollback legacy behavior |

The reverse mapping from implementation tasks to design decisions is:

| Plan task | Production step | Design decision realized |
| --- | --- | --- |
| Task 1 | Native in-bound Worker body reader with preserved metrics/errors | Stage 1 body-read optimization and existing public semantics |
| Task 2 | Caller-level regression coverage without caller behavior changes | Stage 1 safety and legacy route preservation |
| Task 3 | Shared metadata, marker, and stream ownership contracts | Prepare response contract and single-pass upstream body handling |
| Task 4 | Authenticated Deno `/prepare` endpoint and bounded raw-body classification | Deno prepare processing, validation matrix, and no `/tokenize` change |
| Task 5 | Combined configuration and Worker prepare client | Configuration truth table, status-first classification, and timeout ownership |
| Task 6 | Proxy routing, exhaustive pre-transfer cleanup, quota lifecycle, stateful-await timeout reconciliation, marker forwarding, and prepare telemetry | Worker data flow, fail-closed phases, resource-stage finalization, exact accounting, state-preserving timeout semantics, and the existing `upstreamAttempted` boundary |
| Task 7 | Production/Preview propagation and operator documentation | Rollout, Preview mapping, security, and rollback procedure |
| Task 8 | Full verification and sanitized canary/rollback acceptance | End-to-end acceptance criteria and CPU-limit mitigation evidence |

## Implementation Order

1. Complete Tasks 1 and 2 before changing the prepare protocol.
2. Complete Task 3 before either runtime implements the prepare response.
3. Complete Task 4 before Task 5 exercises the Worker client against the endpoint contract.
4. Complete Task 5 before Task 6 changes proxy routing.
5. Complete Task 6 before Task 7 changes deployment or operator documentation.
6. Complete Task 7 before Task 8 performs the full acceptance and rollback checks.

This document-only revision changes this plan and the corresponding design document only; the files listed in task sections are future implementation targets.
