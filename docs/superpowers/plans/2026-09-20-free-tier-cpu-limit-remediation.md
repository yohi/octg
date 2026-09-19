<!-- markdownlint-disable MD013 MD032 -->

# Free-Tier CPU-Limit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Worker-wide scan of large prepared Responses bodies while preserving exact output-budget clamping, quota safety, and operation on Cloudflare Workers Free and Deno Deploy Free.

**Architecture:** Deno serializes the generated output marker as the first JSON property. After quota reservation, the Worker reads and validates at most 512 body bytes before it starts the upstream transport, replaces the first marker in that retained prefix, and streams all remaining bytes unchanged. A Deno deployment for an immutable commit SHA must succeed before the Worker deployment for that SHA may start.

**Tech Stack:** TypeScript strict mode, Cloudflare Workers, Durable Objects, Deno Deploy, Vitest, Deno test runner, Node.js test runner, GitHub Actions, Markdown.

**Spec:** `docs/superpowers/specs/2026-09-20-free-tier-cpu-limit-remediation-design.md`

## Global Constraints

- Cloudflare Workers and Deno Deploy remain on their Free plans; no paid CPU increase or paid fallback is allowed.
- `MAX_INPUT_BYTES` remains `1048576` for production.
- Deno `/prepare` completes before quota reservation and never falls back to `TokenizerController`.
- Quota authority remains the `QuotaController` Durable Object; D1 remains audit-only.
- Preserve quota reservation, in-flight admission, release, settlement, uncertainty, and reconciliation semantics.
- The Worker inspects and marker-matches at most `512` prepared-body bytes before upstream invocation; a larger runtime chunk suffix is opaque pass-through data.
- The Deno prepare body begins with `{"max_output_tokens":"octg_prepare_[0-9a-f]{32}",`.
- A preflight failure occurs before upstream invocation, cancels the resolved prepare request once, releases the reservation and lease, and returns the existing internal error.
- A replacement-stream failure after upstream invocation follows the existing uncertain-accounting path.
- Deno Free exhaustion, timeout, network failure, and malformed response remain fail-closed unavailable outcomes.
- Do not log request bodies, prompt text, response text, markers, client keys, bearer tokens, or secrets.
- Preview must remain Deno-disabled and isolated; production Deno credentials, endpoints, limits, and state must never enter Preview.

---

## Scope And File Structure

| File | Responsibility after this change |
| --- | --- |
| `apps/deno-tokenizer/src/http.ts` | Serialize the generated output marker as the first `max_output_tokens` property. |
| `apps/deno-tokenizer/test/http.test.ts` | Prove the first-property contract and existing Deno bounds. |
| `apps/gateway-worker/src/prepared-body.ts` | Provide the 512-byte asynchronous preflight and post-preflight replacement stream. |
| `apps/gateway-worker/test/prepared-body.test.ts` | Prove byte boundaries, duplicate detection, chunk handling, pass-through, and cancellation. |
| `apps/gateway-worker/src/resource-observation.ts` | Add the bounded-prefix preflight failure route without changing telemetry payload safety. |
| `apps/gateway-worker/test/resource-observation.test.ts` | Prove the bounded-prefix route is emitted as safe structured telemetry. |
| `apps/gateway-worker/src/proxy.ts` | Run preflight before `callUpstream`; retain existing release and uncertain branches. |
| `apps/gateway-worker/test/proxy-prepare.test.ts` | Prove all prepare, quota, preflight, and post-upstream failure semantics. |
| `apps/gateway-worker/test/prepare-contract.test.ts` | Keep metadata bounds and marker shape validation aligned with preflight. |
| `scripts/run-worker-canary.mjs` | Generate explicit Chat or Responses canary payloads without exposing payloads or keys. |
| `scripts/run-worker-canary.test.mjs` | Lock canary endpoint, payload mode, and input-size selection. |
| `scripts/canary-worker-resource-limits.mjs` | Include canary mode in safe result records without logging payloads. |
| `scripts/verify-deno-prepare-contract.mjs` | Probe Deno health and first-property prepare contract without exposing credentials or bodies. |
| `scripts/verify-deno-prepare-contract.test.mjs` | Test probe bounds, diagnostics, and secret-safe failures. |
| `scripts/production-deno-config.mjs` | Reject a production `MAX_INPUT_BYTES` value other than `1048576`. |
| `scripts/production-deno-config.test.mjs` | Lock the canonical production input limit without exposing configuration values. |
| `.github/workflows/deploy-deno-tokenizer.yml` | Deploy and verify Deno for every production commit SHA, then expose that verified SHA to the Worker workflow. |
| `.github/workflows/deploy-production.yml` | Trigger only after the Deno workflow succeeds; check out and deploy its exact SHA. |
| `scripts/deploy-production-workflow.test.mjs` | Prove SHA linkage, workflow ordering, and pre-mutation checks. |
| `SPEC.md`, `docs/deno-tokenizer.md`, `docs/operations.md` | Own the normative preflight, rollback, canary, Free-capacity, and alert procedures. |

Do not modify D1 schema, quota Durable Objects, `tokenization-routing.ts`, or public error shapes. Do not stage the pre-existing untracked `deno.lock` file.

## Baseline Verification

```bash
npm test -w apps/gateway-worker -- prepared-body.test.ts prepare-contract.test.ts proxy-prepare.test.ts
npm test -w apps/deno-tokenizer
node --test scripts/run-worker-canary.test.mjs scripts/production-deno-config.test.mjs scripts/deploy-production-workflow.test.mjs
npm run typecheck -w apps/gateway-worker
npm run typecheck -w apps/deno-tokenizer
```

Expected: the current suites pass before the new regression assertions are added.

## Task 1: Establish The Deno First-Property Contract

**Files:**
- Modify: `apps/deno-tokenizer/src/http.ts`
- Modify: `apps/deno-tokenizer/test/http.test.ts`

**Interfaces:**
- Produces: a `/prepare` 200 body that starts with a generated `max_output_tokens` marker and has exactly one quoted marker.
- Preserves: `PrepareMetadata.outputMarker`, error codes, auth, raw/normalized input bounds, and response headers.

- [ ] **Step 1: Write failing Deno contract tests**

  Add `/prepare` tests that assert the first parsed key and first serialized bytes:

  ```ts
  const body = await response.text();
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assertEquals(Object.keys(parsed)[0], "max_output_tokens");
  assertEquals(parsed.max_output_tokens, metadata.outputMarker);
  assertEquals(body.startsWith(`{"max_output_tokens":${JSON.stringify(metadata.outputMarker)},`), true);
  assertEquals(body.split(JSON.stringify(metadata.outputMarker)).length - 1, 1);
  ```

  Include a source request containing `max_output_tokens: 64` and prove that it is replaced by the generated marker.

- [ ] **Step 2: Run the focused test and verify failure**

  ```bash
  deno test --allow-env --allow-read --allow-net apps/deno-tokenizer/test/http.test.ts
  ```

  Expected: the body-start assertion fails because the current serializer appends the generated property after the normalized body fields.

- [ ] **Step 3: Make marker serialization deterministic**

  In the candidate loop, remove the normalized source property and prepend the generated property:

  ```ts
  const { max_output_tokens: _sourceLimit, ...withoutOutputLimit } = upstreamBody;
  const candidateBody = { max_output_tokens: candidate, ...withoutOutputLimit };
  const candidateSerialized = JSON.stringify(candidateBody);
  ```

  Preserve the existing exact occurrence loop and metadata construction.

- [ ] **Step 4: Run Deno verification**

  ```bash
  npm run typecheck -w apps/deno-tokenizer
  npm test -w apps/deno-tokenizer
  ```

- [ ] **Step 5: Commit the Deno contract**

  ```bash
  git add apps/deno-tokenizer/src/http.ts apps/deno-tokenizer/test/http.test.ts
  git commit -m "fix: place prepare output marker at body prefix"
  ```

## Task 2: Build A Bounded Preflight With Explicit Cancellation Ownership

**Files:**
- Modify: `apps/gateway-worker/src/prepared-body.ts`
- Modify: `apps/gateway-worker/test/prepared-body.test.ts`

**Interfaces:**
- Produces: `preflightPreparedOutput(body, marker, outputTokens): Promise<PreparedOutputPreflight>`.
- `PreparedOutputPreflight` is `{ kind: "ready"; body: ReadableStream<Uint8Array>; cancel(): Promise<void> } | { kind: "invalid" }`.
- `ready.body` owns the reader after success. The caller owns `prepared.cancel()` after `invalid`; it must not call the returned `cancel` because none exists.

- [ ] **Step 1: Write failing unit tests for every preflight boundary**

  Add tests with a counted source stream for these cases:

  ```ts
  expect(await preflightPreparedOutput(validBody, MARKER, 42)).toMatchObject({ kind: "ready" });
  expect(await preflightPreparedOutput(markerAtByte511, MARKER, 42)).toMatchObject({ kind: "ready" });
  expect(await preflightPreparedOutput(markerCompletingAtByte512, MARKER, 42)).toMatchObject({ kind: "ready" });
  expect(await preflightPreparedOutput(markerCompletingAtByte513, MARKER, 42)).toEqual({ kind: "invalid" });
  expect(await preflightPreparedOutput(duplicateWithinPrefix, MARKER, 42)).toEqual({ kind: "invalid" });
  ```

  Add split-marker, malformed-first-property, source-read-error, same-chunk tail, later-chunk tail, destination-cancel, and reader-lock-release cases. For a ready body, assert the source is read only until the first property closes or until byte 512, and assert all unread chunks remain uninspected before downstream consumption.

- [ ] **Step 2: Run the focused test and verify failure**

  ```bash
  npm test -w apps/gateway-worker -- prepared-body.test.ts
  ```

  Expected: `preflightPreparedOutput` is not exported.

- [ ] **Step 3: Implement the preflight state machine**

  Define these exported types and constant:

  ```ts
  export const PREPARED_BODY_PREFIX_BYTES = 512;
  export type PreparedOutputPreflight =
    | { readonly kind: "ready"; readonly body: ReadableStream<Uint8Array>; readonly cancel: () => Promise<void> }
    | { readonly kind: "invalid" };
  ```

  The implementation must:

  1. acquire the source reader once and collect at most 512 bytes;
  2. locate the exact first-property marker and comma without decoding UTF-8;
  3. count all quoted marker occurrences in the complete retained prefix and require exactly one;
  4. construct a replacement stream from retained bytes plus the unread source;
  5. let the returned stream own a memoized `reader.cancel()` and `reader.releaseLock()` path;
  6. release the reader lock without cancelling on `invalid`, so the proxy can invoke the resolved prepare cancellation once;
  7. never use `indexOf`, `TextDecoder`, complete-body concatenation, or a marker search after byte 512.

  Remove `replaceOutputMarker` only after `proxy.ts` and tests have no callers.

- [ ] **Step 4: Run focused verification**

  ```bash
  npm test -w apps/gateway-worker -- prepared-body.test.ts
  npm run typecheck -w apps/gateway-worker
  ```

- [ ] **Step 5: Commit the preflight**

  ```bash
  git add apps/gateway-worker/src/prepared-body.ts apps/gateway-worker/test/prepared-body.test.ts
  git commit -m "fix: preflight prepared output prefix"
  ```

## Task 3: Preflight Before Upstream And Lock Quota Semantics

**Files:**
- Modify: `apps/gateway-worker/src/proxy.ts`
- Modify: `apps/gateway-worker/test/proxy-prepare.test.ts`
- Modify: `apps/gateway-worker/test/prepare-contract.test.ts`
- Modify: `apps/gateway-worker/src/resource-observation.ts`
- Modify: `apps/gateway-worker/test/resource-observation.test.ts`

**Interfaces:**
- Consumes: `preflightPreparedOutput(prepared.body, metadata.outputMarker, budget.maxOutputTokens)` after successful reservation and in-flight admission.
- Produces: an upstream request only for `kind: "ready"`; it passes `ready.body` and `ready.cancel` to `observePreparedBody`.
- Preserves: the existing public error response, release behavior before upstream, and uncertain behavior only after `callUpstream` begins.

- [ ] **Step 1: Add failing integration tests for each accounting branch**

  Use the real Worker route and assert request calls, quota state, lease state, body cancellation count, and resource event outcome for:

  ```ts
  // Prefix invalid after reservation: no upstream, release reservation and lease.
  expect(calls).toEqual(["prepare"]);
  expect(after.reservedTokens).toBe(before.reservedTokens);
  expect(after.uncertainTokens).toBe(before.uncertainTokens);

  // Replacement stream failure after callUpstream begins: upstream was called and reservation is uncertain.
  expect(calls).toEqual(["prepare", "upstream"]);
  expect(after.uncertainTokens).toBeGreaterThan(before.uncertainTokens);
  ```

  Add distinct tests for prepare validation rejection, unavailable timeout, unavailable network error, unavailable 5xx, quota rejection, unknown reservation, in-flight rejection, upstream non-OK, stream true, and stream false. Keep Content-Length present, absent, malformed, and 1 MiB-plus-one coverage in this file; large Responses must select prepare without entering `body_read`, `parse`, or `normalize`.

- [ ] **Step 2: Run the focused test and verify failure**

  ```bash
  npm test -w apps/gateway-worker -- proxy-prepare.test.ts prepare-contract.test.ts
  ```

  Expected: current code calls upstream before a lazy transform reports a malformed prefix, so the new pre-upstream release assertion fails.

- [ ] **Step 3: Integrate preflight before `callUpstream`**

  Add `error:prepared_prefix_invalid` to `ResourceStageRoute` and its focused telemetry test. After reservation and in-flight admission, await the preflight. On `invalid`, call the existing `cancelPreparedBeforeUpstream("exception", { route: "error:prepared_prefix_invalid", quotaReserved: true, upstreamReached: false })` path, which owns `prepared.cancel()`, then return the existing internal error. On `ready`, pass `ready.body` and `ready.cancel` into `observePreparedBody`; set `upstreamAttempted = true` only immediately before `callUpstream`.

  Do not change `reserveFailClosed`, `releaseInFlightBestEffort`, settlement, reconciliation, or public error builders.

- [ ] **Step 4: Run focused Worker verification**

  ```bash
  npm test -w apps/gateway-worker -- prepared-body.test.ts prepare-contract.test.ts proxy-prepare.test.ts
  npm run typecheck -w apps/gateway-worker
  ```

- [ ] **Step 5: Commit proxy integration**

  ```bash
  git add apps/gateway-worker/src/proxy.ts apps/gateway-worker/test/proxy-prepare.test.ts apps/gateway-worker/test/prepare-contract.test.ts apps/gateway-worker/src/resource-observation.ts apps/gateway-worker/test/resource-observation.test.ts
  git commit -m "fix: validate prepared output before upstream"
  ```

## Task 4: Add Responses Canary Mode And Testable Capacity Evidence

**Files:**
- Modify: `scripts/run-worker-canary.mjs`
- Modify: `scripts/run-worker-canary.test.mjs`
- Modify: `scripts/canary-worker-resource-limits.mjs`
- Create: `scripts/canary-worker-resource-limits.test.mjs`

**Interfaces:**
- Consumes: `CANARY_MODE=chat|responses`, `CANARY_REQUEST_BYTES`, and existing authenticated canary configuration.
- Produces: a Chat payload for `chat`, a `{ model, input, max_output_tokens }` payload for `responses`, and safe result records containing `mode` but no body or secret.

- [ ] **Step 1: Write failing canary tests**

  Add tests for the Responses endpoint and byte-bounded synthetic input:

  ```js
  const config = resolveCanaryConfig({
    OCTG_CANARY_URL: "https://example.test/v1/responses",
    OCTG_CANARY_CLIENT_KEY: "octg_sk_test",
    CANARY_MODE: "responses",
    CANARY_REQUEST_BYTES: "778240",
  });
  const payload = buildCanaryPayload(config);
  assert.equal(Buffer.byteLength(payload), 778240);
  assert.equal(JSON.parse(payload).max_output_tokens, 16);
  ```

  Assert `chat` rejects a `/v1/responses` URL, `responses` rejects `/v1/chat/completions`, invalid modes and byte limits fail without exposing values, and `requestCanary` includes only the allowlisted `mode` in its result.

- [ ] **Step 2: Run the focused scripts tests and verify failure**

  ```bash
  node --test scripts/run-worker-canary.test.mjs scripts/canary-worker-resource-limits.test.mjs
  ```

  Expected: mode/input parsing and the new test file do not exist.

- [ ] **Step 3: Implement explicit Responses mode**

  Add `CANARY_MODE` and `CANARY_REQUEST_BYTES` to the allowlisted environment names. Require exact endpoint path by mode. For Responses, generate ASCII `input` whose final `JSON.stringify({ model, input, max_output_tokens })` UTF-8 size equals `CANARY_REQUEST_BYTES`; reject values above `1048576` or below the fixed JSON envelope size. Preserve the existing protected temporary file lifecycle. Pass `CANARY_MODE` to the child script and include it in the JSON result as `mode`.

- [ ] **Step 4: Run tests and check script help**

  ```bash
  node --test scripts/run-worker-canary.test.mjs scripts/canary-worker-resource-limits.test.mjs
  npm run canary:worker -- --help
  ```

- [ ] **Step 5: Commit the canary mode**

  ```bash
  git add scripts/run-worker-canary.mjs scripts/run-worker-canary.test.mjs scripts/canary-worker-resource-limits.mjs scripts/canary-worker-resource-limits.test.mjs
  git commit -m "feat: add Responses worker canary mode"
  ```

## Task 5: Implement A Secret-Safe Prepare Contract Probe

**Files:**
- Create: `scripts/verify-deno-prepare-contract.mjs`
- Create: `scripts/verify-deno-prepare-contract.test.mjs`

**Interfaces:**
- Exports: `verifyPrepareContract({ endpoint, token, maxInputBytes, fetchImpl }): Promise<true>`.
- Validates: HTTPS endpoint without URL credentials, `/health`, `/prepare` status, bounded metadata, marker shape, first-property layout, and an at-most-512-byte inspected response prefix.
- Throws: stable categories only: `endpoint_invalid`, `health_status`, `prepare_status`, `metadata_invalid`, `body_layout_invalid`, or `body_too_large`.

- [ ] **Step 1: Write failing probe tests**

  Mock fetch and assert success plus each stable failure category. Use a token such as `secret-not-printed` and body text such as `body-not-printed`; assert neither occurs in a thrown message. Add a response whose marker completes at byte 513 and assert the reader is cancelled without scanning the opaque remainder.

- [ ] **Step 2: Run the focused test and verify failure**

  ```bash
  node --test scripts/verify-deno-prepare-contract.test.mjs
  ```

- [ ] **Step 3: Implement the bounded probe**

  Build `/health` from `new URL("/health", endpoint)`. POST a small static Responses body to the configured endpoint. Decode only the metadata header and inspect at most 512 response-body bytes. If a runtime chunk exceeds that bound, retain only its inspected slice and cancel the response after validation; do not decode, copy, or include its suffix in diagnostics. Validate the marker and exact first-property prefix using byte operations. On every response-body failure, cancel the reader once and omit raw endpoint query, token, and body from errors.

- [ ] **Step 4: Run probe tests**

  ```bash
  node --test scripts/verify-deno-prepare-contract.test.mjs
  ```

- [ ] **Step 5: Commit the probe**

  ```bash
  git add scripts/verify-deno-prepare-contract.mjs scripts/verify-deno-prepare-contract.test.mjs
  git commit -m "test: verify Deno prepare body contract"
  ```

## Task 6: Make Deno Deployment A Same-SHA Worker Prerequisite

**Files:**
- Modify: `.github/workflows/deploy-deno-tokenizer.yml`
- Modify: `.github/workflows/deploy-production.yml`
- Modify: `scripts/deploy-production-workflow.test.mjs`
- Modify: `scripts/production-deno-config.mjs`
- Modify: `scripts/production-deno-config.test.mjs`

**Interfaces:**
- Produces: a successful Deno workflow run for every `master` SHA and a Worker workflow triggered only by `workflow_run` success for `Deploy Deno Tokenizer`.
- Consumes: `github.event.workflow_run.head_sha` as the immutable checkout and deployment SHA.
- Preserves: separate Deno and Cloudflare credentials, `deploy-production` pre-mutation validation, and Preview isolation.
- Requires: after trimming whitespace, production `MAX_INPUT_BYTES === "1048576"`.

- [ ] **Step 1: Write the failing production input-limit test**

  In `scripts/production-deno-config.test.mjs`, add:

  ```js
  assert.deepEqual(validateProductionDenoConfig({
    ...completeProductionConfig,
    MAX_INPUT_BYTES: " 1048576 ",
  }), { valid: true, missing: [], invalid: [] });
  for (const inputLimit of ["1048575", "1048577", "1", "1048576.0"]) {
    assert.deepEqual(validateProductionDenoConfig({
      ...completeProductionConfig,
      MAX_INPUT_BYTES: inputLimit,
    }), { valid: false, missing: [], invalid: ["MAX_INPUT_BYTES"] });
  }
  ```

- [ ] **Step 2: Run the focused validator test and verify failure**

  ```bash
  node --test scripts/production-deno-config.test.mjs
  ```

  Expected: values other than `1048576` currently pass the positive-safe-integer validator.

- [ ] **Step 3: Enforce the canonical production limit**

  In `validateProductionDenoConfig`, retain the existing positive-safe-integer validation and additionally append `MAX_INPUT_BYTES` to `invalid` unless its trimmed value is exactly `"1048576"`. Keep Preview configuration validation unchanged.

- [ ] **Step 4: Write failing workflow contract tests**

  Add static assertions that:

  ```js
  assert.match(productionWorkflow, /workflow_run:/);
  assert.match(productionWorkflow, /workflows: \[Deploy Deno Tokenizer\]/);
  assert.match(productionWorkflow, /conclusion == 'success'/);
  assert.match(productionWorkflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  ```

  Assert the Deno workflow's production push trigger has no path filter, and the Worker workflow no longer has an independent `push` trigger. Assert the Deno workflow rejects `MAX_INPUT_BYTES` other than `1048576` before its `deno deploy env load` remote mutation, and its post-deploy contract probe occurs before the workflow reports success.

- [ ] **Step 5: Run the workflow test and verify failure**

  ```bash
  node --test scripts/deploy-production-workflow.test.mjs
  ```

  Expected: current workflows are independently triggered by `push` and do not link a Worker deploy to a successful Deno SHA.

- [ ] **Step 6: Link workflows by immutable SHA**

  Change the production Worker trigger to `workflow_run` for the Deno workflow. Add a job-level condition that only permits `push`-origin Deno runs on `master` with conclusion `success`. Check out `github.event.workflow_run.head_sha`. Remove the Deno workflow's production push path filter so it runs and deploys the exact Deno revision for every `master` commit. In the Deno workflow, require `MAX_INPUT_BYTES` to be exactly `1048576` before `deno deploy env load`. Keep pull-request path filters and fork-secret restrictions unchanged.

  Add a post-deploy Deno `/health` and authenticated `/prepare` contract-probe step to the Deno workflow itself. Keep the Worker workflow probe before D1 migration as defense in depth.

- [ ] **Step 7: Run workflow and script verification**

  ```bash
  node --test scripts/production-deno-config.test.mjs scripts/deploy-production-workflow.test.mjs scripts/verify-deno-prepare-contract.test.mjs
  npm run test:deno-deploy-workflow
  ```

- [ ] **Step 8: Commit the deployment dependency**

  ```bash
  git add .github/workflows/deploy-deno-tokenizer.yml .github/workflows/deploy-production.yml scripts/deploy-production-workflow.test.mjs scripts/production-deno-config.mjs scripts/production-deno-config.test.mjs
  git commit -m "ci: gate Worker deployment on Deno revision"
  ```

## Task 7: Prove Rollback, Capacity, Observability, And Preview Isolation

**Files:**
- Modify: `SPEC.md`
- Modify: `docs/deno-tokenizer.md`
- Modify: `docs/operations.md`
- Modify: `scripts/preview-worker-config.test.mjs`
- Modify: `scripts/preview-workflow.test.mjs`

- [ ] **Step 1: Add failing static and documentation tests**

  Extend Preview tests to assert no production Deno endpoint, prepare endpoint, Deno auth secret, or production input limit is included in generated Preview Worker configuration. Use `markdownlint-cli2` after documentation editing; no new Markdown contract-test framework is introduced.

- [ ] **Step 2: Document the rollback matrix and acceptance procedure**

  Add exact runbook requirements:

  1. use Responses canary mode with synthetic 778240-byte and 1048576-byte bodies at concurrency 1, 2, and the configured peak;
  2. require no `exceededCpu`, `prepare` success, Deno tokenization provider, correct quota settlement, and no legacy body stages;
  3. test new Deno plus old Worker as successful, old Deno plus new Worker as pre-upstream fail-closed, and Worker rollback as restored legacy routing;
  4. configure and test the platform-provided Deno allowance alert, or record prepare-unavailable-rate alert as the capacity signal when allowance telemetry is unavailable;
  5. retain only request IDs, revision IDs, resource stages, CPU/wall-time buckets, and safe canary result records.

- [ ] **Step 3: Add testable observability assertions**

  In `proxy-prepare.test.ts`, assert the preflight failure resource event includes the bounded-prefix category and no upstream reach. Assert post-upstream failure has `upstreamReached: true` and uncertainty. In canary tests, assert safe output includes `mode`, request ID, status, duration, route, and Worker version only.

- [ ] **Step 4: Run documentation and Preview verification**

  ```bash
  node --test scripts/preview-worker-config.test.mjs scripts/preview-workflow.test.mjs
  npx --no-install markdownlint-cli2 SPEC.md docs/deno-tokenizer.md docs/operations.md docs/superpowers/specs/2026-09-20-free-tier-cpu-limit-remediation-design.md docs/superpowers/plans/2026-09-20-free-tier-cpu-limit-remediation.md
  ```

- [ ] **Step 5: Commit documentation and isolation coverage**

  ```bash
  git add SPEC.md docs/deno-tokenizer.md docs/operations.md scripts/preview-worker-config.test.mjs scripts/preview-workflow.test.mjs docs/superpowers/specs/2026-09-20-free-tier-cpu-limit-remediation-design.md docs/superpowers/plans/2026-09-20-free-tier-cpu-limit-remediation.md
  git commit -m "docs: define free-tier prepare rollout safeguards"
  ```

## Task 8: Run Full Verification Before Canary

**Files:**
- Verify: all Task 1-7 files

- [ ] **Step 1: Run all automated gates**

  ```bash
  npm run typecheck
  npm test
  npm run test:deno-deploy-workflow
  npm run test:preview-workflow
  git diff --check
  git grep -n "replaceOutputMarker" -- ':!docs/superpowers/specs/**' ':!docs/superpowers/plans/**'
  ```

  Expected: every command succeeds and the final grep has no matches.

- [ ] **Step 2: Review staged files before commit**

  ```bash
  git status --short
  git diff --cached --check
  git diff --cached --name-only
  ```

  Expected: no credential, raw payload, paid-plan configuration, D1 schema, or pre-existing `deno.lock` file is staged.

- [ ] **Step 3: Record the controlled canary evidence**

  Record only the Deno revision, Worker version, synthetic input byte count, concurrency, request IDs, resource-stage outcomes, CPU/wall-time values, quota settlement result, and alert test result. Do not deploy automatically from this task; use the approved operations runbook.

## Plan Coverage Review

- First-property serialization: Task 1.
- 512-byte preflight, duplicate rejection, and cancellation ownership: Task 2.
- Pre-upstream release and post-upstream uncertainty: Task 3.
- Responses 760KiB/1MiB canary evidence: Task 4 and Task 7.
- Secret-safe health/prepare probe: Task 5.
- Same-SHA Deno-to-Worker deployment ordering: Task 6.
- Rollback matrix, observability, Free allowance alert, and Preview isolation: Task 7.
- Full test, type, workflow, and staging gates: Task 8.

No runtime implementation code is included in this plan.
