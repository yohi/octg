# Large Responses CPU-Limit Mitigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move large `/v1/responses` parsing, normalization, and exact BPE counting to Deno while preserving fail-closed quota behavior and the existing small-input path.

**Architecture:** Stage 1 removes the avoidable `Buffer.concat` allocation from the Worker body reader while preserving bounded streaming for unknown-length bodies. Stage 2 adds an authenticated Deno `/prepare` endpoint that accepts raw Responses JSON, returns validated metadata plus a normalized upstream-body stream, and lets the Worker apply the quota-derived output limit through a marker replacement stream before calling the existing upstream path.

**Tech Stack:** TypeScript strict mode, Cloudflare Workers, Durable Objects, Deno Deploy, Web Streams, Vitest, `@cloudflare/vitest-pool-workers`, Deno test runner.

## Global Constraints

- Keep `MAX_INPUT_BYTES` at `1048576`.
- Never use D1 or Deno state as quota authority; quota decisions remain in `QuotaController` Durable Object.
- Deno processing is before quota reservation, and Deno failures never fall back to the Durable Object tokenizer.
- Do not log request bodies, client API keys, Deno auth tokens, or output markers.
- Preserve existing public error codes, reservation settlement, in-flight lease, and upstream-uncertain behavior.
- Prepare routing initially applies only to large `POST /v1/responses` requests.
- Do not modify the existing `/tokenize` contract or remove its rollback path.
- Do not commit changes unless the user explicitly requests a commit.

---

### Task 1: Establish Stage 1 body-reader regression coverage

**Files:**
- Modify: `apps/gateway-worker/test/request-body.test.ts`
- Test target: `readJsonBody()` in `apps/gateway-worker/src/request-body.ts`

**Interfaces:**
- Consumes: existing `readJsonBody(request, maxBytes)` signature and `ReadJsonBodyResult` union.
- Produces: regression tests proving native text consumption is safe for an in-bound declared body and bounded streaming remains safe for unknown-length bodies.

- [ ] **Step 1: Inspect and extend tests for the current observable contract**

  Add cases that assert `rawBodyBytes`, `rawBodyBytesSource`, `truncated`, `bodyReadMs`, `parseMs`, parsed JSON, invalid JSON, and cancellation behavior. Include a non-ASCII payload where `Content-Length` is measured in UTF-8 bytes.

- [ ] **Step 2: Add the failing native-body test**

  Use a request double exposing `headers`, `body`, and `text()` whose `body.getReader()` throws if called. Set an in-bound numeric `Content-Length`; assert that valid JSON succeeds. This fails until the implementation uses the native path.

- [ ] **Step 3: Run the focused test**

  Run: `npm test -w apps/gateway-worker -- request-body.test.ts`

  Expected: the new native-body test fails while existing tests identify the preserved behavior that must not regress.

- [ ] **Step 4: Keep boundary tests explicit**

  Cover exact `maxBytes`, declared oversize before reading, measured oversize with no `Content-Length`, malformed `Content-Length`, missing body, invalid JSON, and body cancellation. Do not assert rejection of invalid UTF-8 unless the existing implementation rejects it; preserve the existing decoder behavior instead.

### Task 2: Implement Stage 1 body-reader optimization

**Files:**
- Modify: `apps/gateway-worker/src/request-body.ts:17-135`
- Test: `apps/gateway-worker/test/request-body.test.ts`

**Interfaces:**
- Consumes: Stage 1 tests and existing `readJsonBody(request, maxBytes)` callers in `proxy.ts` and `admin.ts`.
- Produces: the same `ReadJsonBodyResult` union and metrics, with a native text fast path only when the declared length is valid and in bounds.

- [ ] **Step 1: Add the native text fast path**

  Extend the request parameter type only as needed to call the standard `Request.text()` method. For a valid in-bound declared length, read text once with the native consumer, call `JSON.parse(rawText)`, and return the existing success metrics. If native text consumption or parsing throws, return the existing `invalid_json` result with measured declared bytes and timing.

- [ ] **Step 2: Preserve the bounded reader fallback**

  Keep the reader path for missing, malformed, or otherwise unusable `Content-Length`. Retain the early declared oversize response, measured partial oversize response, cancellation, and existing `Buffer.concat` decoding semantics for that fallback.

- [ ] **Step 3: Run focused and type checks**

  Run: `npm test -w apps/gateway-worker -- request-body.test.ts`

  Run: `npm run typecheck -w apps/gateway-worker`

  Expected: all body-reader tests pass and TypeScript reports no errors.

### Task 3: Define shared prepare metadata and stream contracts

**Files:**
- Create: `apps/gateway-worker/src/prepare-contract.ts`
- Create: `apps/gateway-worker/src/prepared-body.ts`
- Modify: `apps/gateway-worker/src/upstream.ts:16-63`
- Test: `apps/gateway-worker/test/prepare-contract.test.ts`
- Test: `apps/gateway-worker/test/prepared-body.test.ts`
- Test: `apps/gateway-worker/test/upstream.test.ts`

**Interfaces:**
- Produces `PrepareMetadata`:

  ```ts
  type PrepareMetadata = {
    readonly version: 1;
    readonly model: string;
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
  };
  ```

- Produces `parsePrepareMetadata(value: string | null): PrepareMetadata | undefined`, which enforces the exact field set, version, bounded string lengths, booleans, and non-negative safe integers.
- Produces `replaceOutputMarker(body: ReadableStream<Uint8Array>, marker: string, outputTokens: number): ReadableStream<Uint8Array>`, which handles marker bytes split across chunks and throws on zero or multiple quoted-marker occurrences.
- Extends `callUpstream` body input to `unknown | string | ReadableStream<Uint8Array>` without changing headers or response behavior.

- [ ] **Step 1: Write metadata validation tests**

  Test valid metadata, missing fields, extra fields, wrong version, negative and unsafe integers, invalid `estimationPath`, empty/oversized model and marker strings, and invalid boolean fields. Assert invalid values return `undefined` without throwing input-derived text.

- [ ] **Step 2: Write marker-stream tests**

  Test replacement in one chunk, marker split at every byte boundary, UTF-8 bytes surrounding the marker, missing marker, duplicate marker, and a final decimal output value selected independently from Deno's original `maxOutputTokens`.

- [ ] **Step 3: Run tests to establish failures**

  Run: `npm test -w apps/gateway-worker -- prepare-contract.test.ts prepared-body.test.ts upstream.test.ts`

  Expected: new contract and stream tests fail because the functions and stream body support do not yet exist.

- [ ] **Step 4: Implement bounded metadata parsing and marker replacement**

  Decode only the bounded metadata header, parse JSON, validate the exact shape, and use a byte-level streaming state machine that retains the longest suffix that could begin the quoted marker. Emit all other bytes unchanged. At end-of-stream require exactly one replacement.

- [ ] **Step 5: Extend `callUpstream` minimally**

  Detect `ReadableStream<Uint8Array>` and pass it directly as `body`; retain `JSON.stringify` for object bodies and direct pass-through for string bodies. Keep the existing `content-type`, AI Gateway, cache, idempotency, and metadata headers unchanged.

- [ ] **Step 6: Run tests**

  Run: `npm test -w apps/gateway-worker -- prepare-contract.test.ts prepared-body.test.ts upstream.test.ts`

  Expected: all metadata, marker, and upstream body tests pass.

### Task 4: Add Deno `/prepare` service behavior

**Files:**
- Modify: `apps/deno-tokenizer/src/http.ts:4-235`
- Modify: `apps/deno-tokenizer/src/config.ts:3-22`
- Test: `apps/deno-tokenizer/test/http.test.ts`
- Test: `apps/deno-tokenizer/test/config.test.ts`

**Interfaces:**
- Consumes: authenticated `POST /prepare` with UTF-8 `application/json` raw Responses body and the existing `DenoTokenizerServiceConfig` limits.
- Produces: `200 application/json`, a normalized upstream JSON body, and `X-OCTG-Prepare-Metadata` containing base64url-encoded `PrepareMetadata`; error responses contain only allowlisted codes.

- [ ] **Step 1: Add failing endpoint tests**

  Test method/path/auth/content type, raw-body 413, invalid JSON, every shared normalization error, exact metadata values, exactly one quoted marker in the returned body, and marker regeneration when a collision is forced. Assert error bodies contain no request text.

- [ ] **Step 2: Run Deno tests to verify failure**

  Run: `deno test --allow-env --allow-read apps/deno-tokenizer/test/http.test.ts apps/deno-tokenizer/test/config.test.ts`

  Expected: new `/prepare` tests fail because the route and config fields are absent.

- [ ] **Step 3: Add service configuration for prepare limits**

  Reuse the configured auth token and timeout-independent input limit. Ensure `/prepare` raw-body enforcement preserves the Worker’s existing raw request limit semantics while leaving `/tokenize`’s existing `maxRawBodyBytes` behavior unchanged.

- [ ] **Step 4: Implement `/prepare`**

  Authorize and validate the request before reading it. Read the bounded raw JSON, call `normalizeResponses(body, maxInputBytes)`, map its errors to `invalid_body`, `non_text`, `max_tokens_conflict`, or `input_too_large`, count `inputText` with the existing encoder, create a cryptographically random marker with no user-derived content, set the normalized body’s `max_output_tokens` to the marker, serialize it once, and emit validated metadata in the bounded header.

- [ ] **Step 5: Run Deno checks**

  Run: `deno check apps/deno-tokenizer/src/main.ts apps/deno-tokenizer/test/*.test.ts`

  Run: `deno test --allow-env --allow-read apps/deno-tokenizer/test`

  Expected: type checking and all existing plus new Deno tests pass.

### Task 5: Add Worker prepare configuration and client

**Files:**
- Modify: `apps/gateway-worker/src/deno-tokenizer-config.ts:5-69`
- Create: `apps/gateway-worker/src/deno-prepare-client.ts`
- Test: `apps/gateway-worker/test/deno-tokenizer-config.test.ts`
- Test: `apps/gateway-worker/test/deno-prepare-client.test.ts`

**Interfaces:**
- Produces `DenoPrepareConfig` as a disabled/invalid/enabled discriminated union with `endpoint`, `authToken`, `thresholdBytes`, and `timeoutMs`.
- Produces `prepareWithDeno(args: { endpoint: string; authToken: string; timeoutMs: number; request: Request; fetchImpl?: typeof fetch }): Promise<PrepareOutcome>` where `PrepareOutcome` is `resolved` with metadata and body stream or `unavailable` with `timeout | network | upstream_status | malformed_response`.

- [ ] **Step 1: Write configuration tests**

  Test both prepare settings absent, one missing, invalid HTTPS URL, credentials in URL, invalid threshold, threshold above `MAX_INPUT_BYTES`, invalid timeout, and a valid complete prepare group. Verify existing tokenizer configuration cases remain unchanged.

- [ ] **Step 2: Write client failure and success tests**

  Test request forwarding without reading the body first, auth/content-type headers, timeout abort, network failure, non-2xx response, missing/invalid metadata, oversized metadata header, and successful metadata/body return. Test response-body cancellation when metadata is rejected.

- [ ] **Step 3: Run focused tests to verify failure**

  Run: `npm test -w apps/gateway-worker -- deno-tokenizer-config.test.ts deno-prepare-client.test.ts`

  Expected: new prepare tests fail before implementation.

- [ ] **Step 4: Implement config validation and bounded client parsing**

  Keep the existing four-setting Deno tokenizer group semantics. Add a separate prepare group requiring endpoint and threshold together, reuse the existing auth token, and use the existing timeout validator. Abort and cancel response streams on every timeout, malformed, or rejected outcome.

- [ ] **Step 5: Run focused checks**

  Run: `npm test -w apps/gateway-worker -- deno-tokenizer-config.test.ts deno-prepare-client.test.ts`

  Run: `npm run typecheck -w apps/gateway-worker`

  Expected: all prepare client/config tests pass.

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
- Consumes: `DenoPrepareConfig`, `prepareWithDeno`, `parsePrepareMetadata`, `replaceOutputMarker`, existing `resolveTokenBudget`, and existing quota/upstream lifecycle methods.
- Produces: a prepare branch that supplies `requestData` from validated Deno metadata and supplies a marker-replacement stream to `callUpstream` after reservation.

- [ ] **Step 1: Add resource-stage and routing tests**

  Assert large Responses bodies route to `/prepare` before `readJsonBody`, small Responses bodies use the legacy path, Chat Completions never use prepare, malformed Content-Length uses the legacy path, and prepare failures do not call the DO tokenizer, quota reservation, or upstream.

- [ ] **Step 2: Add quota/upstream integration tests**

  Assert model and policy checks use Deno metadata, `resolveTokenBudget` receives Deno’s exact estimated count, CLAMP changes only the marker replacement value, REJECT returns quota error before upstream, and reservation release/uncertain handling matches existing tests.

- [ ] **Step 3: Run focused tests to establish failures**

  Run: `npm test -w apps/gateway-worker -- proxy-prepare.test.ts proxy-failures.test.ts tokenization-routing.test.ts`

  Expected: new prepare integration cases fail before proxy integration exists.

- [ ] **Step 4: Add the `prepare` resource stage**

  Extend `ResourceStage` and route types with `prepare`. Emit start/finish events containing only safe byte counts, estimation path, provider, failure category, quota reservation, and upstream reachability. Do not emit raw body, marker, or secret values.

- [ ] **Step 5: Branch before Worker body parsing**

  In `handleProxy`, after authentication and idempotency validation, select prepare only for `endpoint === "responses"` and an enabled prepare config when the declared byte length is above threshold or absent. Reject a declared raw length above the configured maximum before forwarding. Send the original request body to `prepareWithDeno`; for the legacy branch retain `readJsonBody` and normalization exactly.

- [ ] **Step 6: Feed validated metadata into existing policy/quota logic**

  Convert prepare metadata to the existing normalized request shape. Preserve model classification, tool policy, quota state read, `resolveTokenBudget`, reservation, in-flight admission, audit, and settlement code. On every pre-reservation prepare failure, finish the prepare stage and return the existing mapped OCTG error without DO fallback.

- [ ] **Step 7: Forward the prepared stream after reservation**

  After `resolveTokenBudget` and successful reservation/in-flight admission, call `replaceOutputMarker` with the Deno response body and the budget-selected `maxOutputTokens`, then pass that `ReadableStream` to `callUpstream`. If marker replacement fails before an upstream attempt, release reservation and in-flight state; if failure occurs after attempt, use the existing uncertain outcome path.

- [ ] **Step 8: Run focused integration checks**

  Run: `npm test -w apps/gateway-worker -- proxy-prepare.test.ts proxy-failures.test.ts tokenization-routing.test.ts`

  Run: `npm run typecheck -w apps/gateway-worker`

  Expected: prepare routing, quota, failure, and legacy regression tests pass.

### Task 7: Update deployment configuration and documentation

**Files:**
- Modify: `apps/gateway-worker/wrangler.jsonc`
- Modify: `.env.example`
- Modify: `docs/deno-tokenizer.md`
- Modify: `docs/configuration.md`
- Modify: `SPEC.md`
- Modify: `docs/operations.md`
- Modify: deployment workflow files only where the new environment variables are required

**Interfaces:**
- Consumes: implemented prepare configuration names and `/prepare` contract.
- Produces: documented disabled-by-default configuration, rollout, rollback, security, and acceptance procedures.

- [ ] **Step 1: Document configuration semantics**

  Add `DENO_PREPARE_ENDPOINT` and `DENO_PREPARE_THRESHOLD_BYTES`, state that both are required together, and state that prepare is disabled when both are absent. Document that `MAX_INPUT_BYTES` remains `1048576` and is not reduced as a mitigation.

- [ ] **Step 2: Document protocol and failure behavior**

  Describe `/prepare`, metadata validation, marker replacement, no-DO-fallback behavior, quota-before-upstream ordering, and the absence of payload/secret logging. Keep `/tokenize` documentation and rollback instructions intact.

- [ ] **Step 3: Document staged rollout**

  Specify Stage 1 deployment with prepare absent, Deno `/prepare` health/auth verification, sanitized 74k-token-class canaries at concurrency 1 and 2, resource-stage acceptance, and disabling prepare by removing its complete setting group.

- [ ] **Step 4: Run documentation/config checks**

  Run: `git diff --check`

  Run: `npm run typecheck`

  Expected: no whitespace errors and all workspace types pass.

### Task 8: Execute full verification and CPU regression canary

**Files:**
- No source changes expected.
- Test artifacts: temporary sanitized payloads outside the repository; do not add production prompts or secrets.

**Interfaces:**
- Consumes: all Stage 1/2 implementation and documentation changes.
- Produces: verified test output and an acceptance record containing no sensitive request content.

- [ ] **Step 1: Run all automated checks**

  Run: `npm test`

  Run: `npm run typecheck`

  Run: `deno check apps/deno-tokenizer/src/main.ts apps/deno-tokenizer/test/*.test.ts`

  Expected: all commands pass.

- [ ] **Step 2: Verify no sensitive telemetry**

  Review changed logging and telemetry code. Confirm only byte counts, safe enum values, request IDs, version IDs, and bounded allowlisted error codes are emitted; confirm no raw text, marker, API key, or Deno auth token is emitted.

- [ ] **Step 3: Run sanitized canaries**

  Send representative synthetic Responses payloads in the approximately 74k-token class at concurrency 1 and 2 through a prepare-enabled deployment. Verify HTTP success, normal quota headers, `prepare` start/finish events, successful reservation and settlement, and absence of Worker `exceededCpu` for the incident payload class.

- [ ] **Step 4: Verify rollback**

  Remove the complete prepare setting group and send a small request. Verify routing returns to the existing Worker/DO path and that the `/tokenize` endpoint remains functional.

- [ ] **Step 5: Review the final diff**

  Run: `git status --short`

  Run: `git diff --check`

  Expected: only intended source, test, and documentation files are changed; pre-existing `deno.lock` remains untouched.
