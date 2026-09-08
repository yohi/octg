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
- Reuse the existing Deno auth token and timeout. Do not add a prepare-specific auth token or timeout setting.
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

  Also assert `rawBodyBytes`, `rawBodyBytesSource`, `truncated`, `bodyReadMs`, `parseMs`, invalid JSON, and cancellation for exact `maxBytes`, declared oversize, measured oversize without `Content-Length`, malformed `Content-Length`, missing body, and non-ASCII UTF-8. Preserve the current invalid UTF-8 behavior rather than adding a new rejection.

- [ ] **RED check: run the focused test**

  Run: `npm test -w apps/gateway-worker -- request-body.test.ts`

  Expected RED result: the native-body test fails because the current implementation calls `body.getReader()` before using `Request.text()`; boundary tests describe the metrics that must remain unchanged.

- [ ] **GREEN: add the native text fast path and retain the bounded fallback**

  Replace the request parameter type with `Pick<Request, "headers" | "body" | "text">`. After the declared oversize and missing-body checks, call `request.text()` once for a valid in-bound declared length, parse it once with `JSON.parse`, and return declared byte accounting. Keep the reader and `Buffer.concat` path for missing, malformed, or unusable lengths, including measured oversize cancellation.

  ```ts
  if (declaredContentLength !== null && typeof request.text === "function") {
    const parseStartedAt = performance.now();
    try {
      const rawText = await request.text();
      return {
        ok: true,
        body: JSON.parse(rawText),
        rawText,
        metrics: {
          rawBodyBytes: declaredContentLength,
          rawBodyBytesSource: "declared_content_length",
          declaredContentLength,
          measuredRawBodyBytes: null,
          truncated: false,
          bodyReadMs: elapsedSince(bodyReadStartedAt),
          parseMs: elapsedSince(parseStartedAt),
        },
      };
    } catch {
      return {
        ok: false,
        reason: "invalid_json",
        metrics: {
          rawBodyBytes: declaredContentLength,
          rawBodyBytesSource: "declared_content_length",
          declaredContentLength,
          measuredRawBodyBytes: null,
          truncated: false,
          bodyReadMs: elapsedSince(bodyReadStartedAt),
          parseMs: elapsedSince(parseStartedAt),
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

- Consumes: authenticated `POST /prepare` with `application/json` raw Responses body and the existing `DenoTokenizerServiceConfig` auth and timeout settings.
- Produces: `200 application/json`, a normalized upstream JSON body, and `X-OCTG-Prepare-Metadata` containing base64url-encoded `PrepareMetadata`; error responses contain only the shared allowlisted codes.
- The `/prepare` raw-body bound is the resolved `MAX_INPUT_BYTES`. The existing `/tokenize` raw-body bound, fatal UTF-8 decoder, and response contract remain unchanged.
- The successful metadata uses `rawBodyBytes` from bytes actually read, `inputBytes = inputTextBytes + opaqueInputBytes`, exact `estimatedInputTokensOf` accounting, positive `maxOutputTokens`, and an `octg_prepare_` plus 32 lowercase hexadecimal marker.
- The response body contains exactly one quoted marker in `max_output_tokens`. Deno regenerates the marker for up to 16 attempts if the candidate appears elsewhere in the serialized body.

- [ ] **RED: add failing `/prepare` endpoint tests**

  Test method/path/auth/content type, declared and measured raw-body oversize, replacement-style UTF-8 decoding, invalid JSON, all shared normalization errors, exact metadata values, non-ASCII `rawBodyBytes`, generic `text` normalization for user/system/developer/assistant and `function_call_output`, exactly one quoted marker in the returned body, marker regeneration on collision, and no request-derived error detail.

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
  const serialized = await response.text();
  expect(countOccurrences(serialized, JSON.stringify(metadata.outputMarker))).toBe(1);
  ```

- [ ] **RED check: run the Deno tests**

  Run: `deno test --allow-env --allow-read apps/deno-tokenizer/test/http.test.ts apps/deno-tokenizer/test/config.test.ts`

  Expected RED result: the new `/prepare` tests fail because the route, shared metadata, and prepare raw-body handling are absent.

- [ ] **GREEN: add the prepare service without changing `/tokenize`**

  Reuse the configured auth token, timeout, and resolved input limit. Authorize and validate the request before reading it. Read the raw body with a bounded byte reader; return `request_too_large` for declared or measured raw oversize; decode UTF-8 with replacement semantics; parse JSON; call the shared normalizer; and map its errors without including request-derived detail.

  ```ts
  const rawBody = await readBoundedRawBody(request, config.maxRawBodyBytes);
  if (!rawBody.ok) return prepareError(413, "request_too_large");

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(rawBody.bytes));
  } catch {
    return prepareError(400, "invalid_body");
  }

  const normalized = normalizeResponses(parsedBody, config.maxRawBodyBytes);
  if (!normalized.ok) return prepareError(400, normalized.error);
  const baseTokenCount = exactEncoder.count(normalized.value.inputText);
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

  Keep authentication and media-type checks before body reads, keep raw-body rejection distinct from normalized `input_too_large`, and keep `/tokenize` implementation untouched apart from shared imports required by compilation. Rerun the focused Deno tests.

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
- Produces `prepareWithDeno(args: { endpoint: string; authToken: string; timeoutMs: number; maxInputBytes: number; request: Request; fetchImpl?: typeof fetch }): Promise<PrepareOutcome>`. It forwards the original body stream without calling `request.text()`, `request.json()`, or `readJsonBody()`.
- `PrepareOutcome` has `resolved`, `rejected`, and `unavailable` variants. `resolved` carries validated metadata, the response body, and an idempotent `cancel`; `rejected` carries one shared `PrepareErrorCode`; `unavailable` carries only `timeout`, `network`, `upstream_status`, or `malformed_response`.

- [ ] **RED: write configuration and client tests**

  Test the complete truth table, both prepare settings absent, one missing, empty-string placeholders, invalid HTTPS URL, credentials in URL, invalid/too-large threshold, invalid timeout, and unchanged tokenizer configuration cases. Test body forwarding without a preliminary read, auth/content-type headers, response-body cancellation, timeout through body close/cancel, network failure, non-2xx response, allowlisted rejected codes, missing/invalid metadata, oversized metadata header, malformed body, and successful metadata/body return.

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

  Keep `resolveDenoTokenizerConfig` unchanged, add the prepare pair resolver, and compose the six-row truth table in `resolveDenoRuntimeConfig`. The client must bound the metadata header before decoding, parse only the bounded error envelope, cancel rejected response bodies, and keep the timeout active until a resolved body closes or `cancel()` runs.

  ```ts
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
    body: request.body,
    signal: controller.signal,
  });

  const cancel = async (): Promise<void> => {
    clearTimeout(timeout);
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  };
  ```

  Wrap the successful response body so normal close clears the same timer. Map only valid bounded error codes to `rejected`; map auth failures, unsupported response media types, non-2xx statuses without a valid error envelope, malformed metadata/body, timeout, and network failures to `unavailable`.

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
- Modify: `apps/gateway-worker/src/index.ts` only if environment typing requires it
- Test: `apps/gateway-worker/test/proxy-failures.test.ts`
- Test: `apps/gateway-worker/test/tokenization-routing.test.ts`
- Create or modify: `apps/gateway-worker/test/proxy-prepare.test.ts`

**Interfaces:**
- Consumes: `DenoRuntimeConfig`, `prepareWithDeno`, `replaceOutputMarker`, existing `resolveTokenBudget`, and existing quota/upstream lifecycle methods.
- Produces: a prepare branch that uses validated Deno metadata directly for model, policy, quota, and audit decisions, then supplies a marker-replacement stream to `callUpstream` after reservation.
- Do not reconstruct or tokenize `metadata.inputText` in the Worker. Use a metadata-only prepared request shape containing `model`, `inputBytes`, `inputTextBytes`, `opaqueInputBytes`, `messageCount`, `estimatedInputTokens`, `maxOutputTokens`, `stream`, and `isToolUse`.
- `PrepareOutcome.rejected` maps only the five shared codes to existing public OCTG errors. `PrepareOutcome.unavailable` maps to `errInternal`; neither variant invokes `routeTokenization` or reserves quota.
- Track `upstreamAttemptStarted` through the transport passed to `callUpstream`: the wrapper sets it immediately before the actual upstream fetch. `UpstreamConfigError` therefore remains a pre-upstream cleanup path, while transport/body failures after fetch starts use existing uncertain semantics.

**Steps:**

- [ ] **RED: add routing, lifecycle, and resource-stage tests**

  Assert valid large Responses requests dispatch to `/prepare` before `readJsonBody`, a request without `Content-Length` dispatches when prepare is enabled, small Responses requests use the legacy path, Chat Completions never use prepare, malformed `Content-Length` uses the legacy path, declared raw oversize cancels before Deno, and prepare failures do not call the DO tokenizer, quota reservation, or upstream.

  ```ts
  const response = await handleProxy(largeResponsesRequest, env, ctx, "responses", "req-1");

  expect(prepareFetch).toHaveBeenCalledWith(expect.stringContaining("/prepare"), expect.objectContaining({
    body: largeResponsesRequest.body,
  }));
  expect(readJsonBodySpy).not.toHaveBeenCalled();
  expect(tokenizerRpc).not.toHaveBeenCalled();
  expect(quotaReserve).not.toHaveBeenCalled();
  expect(upstreamFetch).not.toHaveBeenCalled();
  expect(resourceStages).toContainEqual(expect.objectContaining({ stage: "prepare", phase: "finish" }));
  ```

  Add quota/upstream cases asserting metadata model and policy checks, exact `metadata.estimatedInputTokens` passed to `resolveTokenBudget`, no second message/opaque overhead, CLAMP changing only the marker replacement value, REJECT returning before upstream, and body cancellation/release behavior for every pre-upstream terminal path.

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
    const outcome = await prepareWithDeno({
      endpoint: prepare.endpoint,
      authToken: prepare.authToken,
      timeoutMs: prepare.timeoutMs,
      maxInputBytes: prepare.maxInputBytes,
      request,
    });
    // Handle resolved/rejected/unavailable before quota state or tokenization.
  }
  ```

- [ ] **GREEN: map outcomes and preserve metadata-only downstream decisions**

  Map `invalid_body` to `errInvalidRequest`, `non_text` to `errNonTextInput`, `max_tokens_conflict` to `errMaxTokensConflict`, and both size codes to `errInputTooLarge`. Map `unavailable` to `errInternal` with safe resource-stage fields. Finish the prepare stage for every non-resolved outcome. For `resolved`, retain `metadata`, `body`, and `cancel` as one ownership record and use metadata directly for model classification, tool policy, audit, and budget inputs; never create a large `inputText` placeholder or call `routeTokenization`.

  ```ts
  switch (outcome.kind) {
    case "rejected":
      finishPrepare(outcome.code, false, false);
      return errorResponse(mapPrepareError(outcome.code, requestId));
    case "unavailable":
      finishPrepare(outcome.failure, false, false);
      return errorResponse(errInternal(requestId));
    case "resolved":
      prepared = { metadata: outcome.metadata, body: outcome.body, cancel: outcome.cancel };
      break;
    default:
      return assertNever(outcome, "prepare outcome");
  }
  ```

- [ ] **GREEN: preserve quota lifecycle and transfer stream ownership at upstream transport**

  Read quota state and call `resolveTokenBudget` exactly once with `metadata.estimatedInputTokens` and `metadata.maxOutputTokens`. Apply model/policy failures and reservation/in-flight rejections before upstream ownership transfer, calling `prepared.cancel()` and releasing known state. After successful reservation and in-flight admission, build the marker transform and pass it to `callUpstream`. Wrap the transport so `upstreamAttemptStarted` is set immediately before the actual fetch:

  ```ts
  const upstreamTransport: UpstreamTransport = (input, init) => {
    upstreamAttemptStarted = true;
    return fetch(input, init);
  };
  const budget = resolveTokenBudget({
    estimatedInput: metadata.estimatedInputTokens,
    maxOutputTokens: metadata.maxOutputTokens,
    remaining: before.remaining,
    limit: before.limit,
    outputLimitMode: policy.outputLimitMode,
  });
  const body = replaceOutputMarker(prepared.body, metadata.outputMarker, budget.maxOutputTokens);
  const upstream = await callUpstream(env, "/responses", body, meta, cacheKey, idempotencyKey, upstreamTransport);
  ```

  A transform construction failure or `UpstreamConfigError` before the transport wrapper runs cancels and releases known state. A failure after the wrapper runs marks the request uncertain and releases only the in-flight lease, following the existing stream settlement path. Keep the prepare resource stage open until the prepared body closes or is canceled.

- [ ] **GREEN check: run focused integration checks and type check**

  Run: `npm test -w apps/gateway-worker -- proxy-prepare.test.ts proxy-failures.test.ts tokenization-routing.test.ts`

  Run: `npm run typecheck -w apps/gateway-worker`

  Expected GREEN result: prepare routing, exact quota accounting, cleanup phases, marker forwarding, failure mapping, and legacy regression tests pass.

- [ ] **REFACTOR: isolate prepared and legacy lifecycles**

  Keep existing Chat/legacy code paths and quota settlement helpers unchanged; add branching only at the documented prepare boundary. Ensure every resolved prepared body has exactly one terminal `cancel` or upstream ownership transfer, and ensure prepare telemetry contains only safe counts/enums/provider state. Rerun the focused commands.

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

  Extend production validation to require the existing tokenizer group as before while accepting the optional complete prepare pair. Add Preview tests proving `PREVIEW_DENO_PREPARE_ENDPOINT` maps to Worker `DENO_PREPARE_ENDPOINT` and `PREVIEW_DENO_PREPARE_THRESHOLD_BYTES` maps to Worker `DENO_PREPARE_THRESHOLD_BYTES`. Add a shell/workflow assertion that an absent pair produces no empty `--var` arguments.

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

  Expected RED result: new prepare validation/mapping cases fail before the production and Preview configuration paths are extended.

- [ ] **GREEN: implement propagation and human-readable documentation**

  Add the prepare pair to production validation as an optional all-or-nothing group and reject one-sided or invalid values. Add Preview source names and map them explicitly to the two Worker names. Build deployment arguments only for a complete valid pair:

  ```sh
  prepare_args=()
  if [ -n "${PREVIEW_DENO_PREPARE_ENDPOINT:-}" ] && [ -n "${PREVIEW_DENO_PREPARE_THRESHOLD_BYTES:-}" ]; then
    prepare_args+=(--var "DENO_PREPARE_ENDPOINT:${PREVIEW_DENO_PREPARE_ENDPOINT}")
    prepare_args+=(--var "DENO_PREPARE_THRESHOLD_BYTES:${PREVIEW_DENO_PREPARE_THRESHOLD_BYTES}")
  fi
  ```

  Document that prepare is disabled by absence of both Worker variables, both variables are required together, `MAX_INPUT_BYTES` remains `1048576`, and prepare-only invalidity affects Responses without changing Chat Completions. Document the five protocol errors, metadata/header bounds, marker replacement, no-DO-fallback rule, quota-before-upstream order, no payload/secret logging, Stage 1 deployment with prepare absent, Deno `/prepare` health/auth verification, sanitized approximately 74k-token canaries at concurrency 1 and 2, resource-stage acceptance, and rollback to a known Worker version that predates prepare. Keep `/tokenize` documentation intact.

- [ ] **GREEN check: run configuration and documentation checks**

  Run: `node --test scripts/production-deno-config.test.mjs scripts/preview-worker-config.test.mjs`

  Run: `bash scripts/preview-workflow.test.sh`

  Run: `git diff --check`

  Expected GREEN result: configuration tests prove explicit Production/Preview mapping without empty placeholders, and documentation has no whitespace errors.

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

  Expected RED checkpoint: record every failure with its command and affected task; do not weaken a test or bypass a failing check.

- [ ] **GREEN: verify the implemented behavior against the acceptance matrix**

  Confirm `MAX_INPUT_BYTES` is still `1048576`; large Responses requests route to Deno before Worker JSON parsing; small Responses and all Chat Completions retain their existing paths; exact estimates match legacy accounting; Deno failures fail closed without DO fallback; quota decisions do not depend on D1 or Deno state; and no raw request content or credential appears in logs or telemetry.

  ```ts
  expect(prepareRoute).toHaveBeenCalledBefore(readJsonBodyRoute);
  expect(resolveTokenBudget).toHaveBeenCalledWith(expect.objectContaining({
    estimatedInput: metadata.estimatedInputTokens,
    maxOutputTokens: metadata.maxOutputTokens,
  }));
  expect(tokenizerRpc).not.toHaveBeenCalled();
  expect(quotaReserve).not.toHaveBeenCalled();
  expect(upstreamFetch).not.toHaveBeenCalled();
  ```

  Send representative sanitized Responses payloads in the approximately 74k-token class at concurrency 1 and 2 through a prepare-enabled deployment. Verify HTTP success, normal quota headers, `prepare` start/finish events, successful reservation and settlement, and absence of Worker `exceededCpu` for the incident payload class.

- [ ] **GREEN check: rerun the full commands after accepted fixes**

  Run: `npm test`

  Run: `npm run typecheck`

  Run: `deno check apps/deno-tokenizer/src/main.ts apps/deno-tokenizer/test/*.test.ts`

  Expected GREEN result: all automated checks pass and the canary acceptance record contains only safe metrics and identifiers.

- [ ] **REFACTOR: verify rollback and final scope**

  Record a known Worker version that predates prepare, and roll back to that version rather than relying on omission from a later `--keep-vars` upload. If prepare variables are removed, remove the complete pair through the supported control-plane operation; never upload empty placeholders. Send the same synthetic large Responses payload after rollback and verify no `prepare` stage, legacy `body_read`/`parse`/`normalize` stages, retained `/tokenize` availability, tokenizer-provider behavior according to the retained threshold, correct quota reservation, and correct upstream settlement.

  Run: `git status --short`

  Run: `git diff --check`

  Expected: only intended implementation, test, and documentation files are changed; pre-existing `deno.lock` remains untouched. Rerun the relevant focused command after any cleanup-only change.

## Implementation Order

1. Complete Tasks 1 and 2 before changing the prepare protocol.
2. Complete Task 3 before either runtime implements the prepare response.
3. Complete Task 4 before Task 5 exercises the Worker client against the endpoint contract.
4. Complete Task 5 before Task 6 changes proxy routing.
5. Complete Task 6 before Task 7 changes deployment or operator documentation.
6. Complete Task 7 before Task 8 performs the full acceptance and rollback checks.

This document-only revision changes this plan and the corresponding design document only; the files listed in task sections are future implementation targets.
