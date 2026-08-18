# Tokenizer Durable Object Review Follow-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address the 8 still-valid review findings from the tokenizer Durable Object design review, updating docs, code, and tests without changing external API contracts beyond what the findings require.

**Architecture:** Keep the existing `errInternal()` external contract; update the design doc to match. Split BPE responsibilities out of `@octg/shared` by deleting `estimateInputTokens` and the `js-tiktoken` dependency, moving those tests to a new Tokenizer workspace. Add a serialization-aware input limit boundary in `resolveMaxInputBytes()`. Update requirements for consistency in dependency graph, heading hierarchy, stage names, and rollback procedure.

**Tech Stack:** TypeScript strict, Vitest, Cloudflare Workers test pool, Durable Objects, npm workspaces.

## Global Constraints

- TypeScript strict mode; no `as any`, no `@ts-ignore`, no `@ts-expect-error`.
- Never delete a failing test to make a suite pass.
- Keep changes minimal; fix only what the finding describes.
- Do not change external API status codes unless a finding explicitly requires it.
- No absolute paths in output; use relative paths.
- Do not create new agent configuration files.
- Git operations only when explicitly requested by the user; no commits in this task unless asked.

---

## Task 1: Align tokenizer failure HTTP response in design doc with existing external contract

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-tokenizer-durable-object-design.md:237-253`

**Interfaces:**
- Consumes: existing `errInternal()` in `packages/shared/src/errors.ts:155-157`.
- Produces: updated design doc wording for the Tokenizer unavailable HTTP response.

- [ ] **Step 1: Read current contract**

Confirm `errInternal()` returns `{ status: 500, type: "api_error", code: "internal_error", route: "internal_error" }`.

- [ ] **Step 2: Rewrite design doc §8.1**

Change the section to state:

- Tokenizer unavailable failures are surfaced to clients using the existing `errInternal()` contract: HTTP status `500`, `type: "api_error"`, `code: "internal_error"`, route `error:internal_error`.
- `tokenizer_unavailable` is retained as an internal failure category only (resource stage `route` value inside `octg.resource_stage`, not the external HTTP `code`).
- No `Retry-After` header is introduced for this failure path.
- The example JSON body matches `errInternal()` output.

- [ ] **Step 3: Verify doc consistency**

Read the updated section and confirm no 503 / `tokenizer_unavailable` HTTP contract remains in the design doc.

---

## Task 2: Unify Durable Object stage names with requirements

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-tokenizer-durable-object-design.md:303-316`

**Interfaces:**
- Consumes: `REQUIREMENTS_2026-08-17.md` §FR-15 stage names `tokenizer_init` and `tokenizer_encode`.
- Produces: design doc stage names consistent with requirements.

- [ ] **Step 1: Update stage list**

Replace `init` / `encode` in the design doc with `tokenizer_init` / `tokenizer_encode`.

- [ ] **Step 2: Update structured event example**

Ensure the `octg.tokenizer_stage` example uses `"stage": "tokenizer_encode"` or `"tokenizer_init"`.

- [ ] **Step 3: Verify consistency**

Grep both documents for `tokenizer_init` / `tokenizer_encode` and confirm they match.

---

## Task 3: Add canary pass criteria for single `tokenizer:primary` object

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-tokenizer-durable-object-design.md:214-221`

**Interfaces:**
- Produces: documented canary acceptance thresholds and halt conditions.

- [ ] **Step 1: Define metrics and thresholds**

Add a subsection under §7 or §8 with concrete canary criteria:

- Measure at expected peak concurrency:
  - Maximum DO queue length
  - p95 / p99 tokenization latency
  - 503 (overload) rate
  - Tokenizer CPU utilization
  - Total request completion time
- Define upper bounds for each metric.
- Define halt condition: if any metric exceeds its bound, stop the canary and mark it failed.

- [ ] **Step 2: Explicitly preserve existing constraints**

State that Gateway tokenizer client does **not** add RPC retry or custom wall-clock timeout for the canary; it relies on existing load cases.

- [ ] **Step 3: Verify no new RPC retry / timeout language**

Read the new section and confirm it does not introduce client-side retry or timeout behavior.

---

## Task 4: Apply RPC serialization limit to `resolveMaxInputBytes()`

**Files:**
- Modify: `apps/gateway-worker/src/proxy.ts:101-103` and related constants
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts:39-63`
- Read: `apps/gateway-worker/src/proxy.ts` constants for `MAX_NORMALIZED_INPUT_BYTES`

**Interfaces:**
- Consumes: existing `resolvePositiveSafeInteger()` helper, `MAX_NORMALIZED_INPUT_BYTES` default.
- Produces: `resolveMaxInputBytes()` returns the lesser of the configured limit and a serialization-aware RPC ceiling.

- [ ] **Step 1: Write failing test**

Add a test in `proxy-failures.test.ts`:

```ts
it("caps resolved limit at the RPC serialization ceiling", () => {
  const resolved = resolveMaxInputBytes(String(40 * 1024 * 1024));
  expect(resolved).toBeLessThanOrEqual(MAX_TOKENIZATION_RPC_INPUT_BYTES);
});
```

Use a value such as `32 * 1024 * 1024` minus an overhead allowance. Define the constant first if needed.

- [ ] **Step 2: Run test and confirm failure**

`npm test -w apps/gateway-worker -- proxy-failures.test.ts`

Expected: FAIL because `resolveMaxInputBytes` does not cap the value.

- [ ] **Step 3: Implement the cap**

In `proxy.ts`:

- Define `MAX_TOKENIZATION_RPC_INPUT_BYTES` as a constant that accounts for UTF-8 input bytes, `opaqueInputBytes`, and RPC serialization overhead. Use a conservative value such as `32 * 1024 * 1024 - 65_536` or document the exact overhead.
- Update `resolveMaxInputBytes()` to return `Math.min(resolvePositiveSafeInteger(configured, MAX_NORMALIZED_INPUT_BYTES), MAX_TOKENIZATION_RPC_INPUT_BYTES)`.
- Add a comment explaining the 32 MiB RPC limit and the invariant.

- [ ] **Step 4: Run test and confirm pass**

`npm test -w apps/gateway-worker -- proxy-failures.test.ts`

- [ ] **Step 5: Add boundary / overflow tests**

Add tests for:

- Configured value exactly at the RPC ceiling.
- Configured value one byte over the RPC ceiling.
- UTF-8 byte length plus opaque bytes counted before tokenizer RPC (existing parse/body_read limit already covers this; add a comment in the test or doc).
- Invalid values still fall back to `MAX_NORMALIZED_INPUT_BYTES`.

- [ ] **Step 6: Document invariant**

Add a short spec note in `docs/superpowers/specs/2026-08-17-tokenizer-durable-object-design.md` §5.1 or §6 stating:

> `resolveMaxInputBytes()` never returns a value that, combined with RPC serialization overhead, exceeds 32 MiB. Inputs above this ceiling are rejected before RPC by the existing body size limit; allowing larger inputs requires a stream or chunk protocol to be defined.

---

## Task 5: Migrate shared BPE tests and remove `js-tiktoken` dependency

**Files:**
- Modify: `packages/shared/test/estimate.test.ts`
- Modify: `packages/shared/src/estimate.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`
- Create: `durable-objects/tokenizer-controller/test/tokenizer.test.ts` (or equivalent workspace test location)
- Create: `durable-objects/tokenizer-controller/src/tokenizer.ts` scaffold if needed

**Interfaces:**
- Consumes: existing `estimateInputTokens()` implementation using `js-tiktoken`.
- Produces: `@octg/shared` owns only `safetyMargin`, `upperBoundOf`, `decideOutput`; BPE logic lives in Tokenizer workspace.

- [ ] **Step 1: Inspect shared exports and consumers**

Confirm `packages/shared/src/index.ts` re-exports `estimateInputTokens`. Identify all consumers (e.g., `apps/gateway-worker/src/proxy.ts`).

- [ ] **Step 2: Move BPE parity / fallback tests out of shared**

In `packages/shared/test/estimate.test.ts`, delete the `describe("estimateInputTokens", ...)` block and any `js-tiktoken` import / mock. Keep only `safetyMargin`, `upperBoundOf`, `decideOutput` tests.

- [ ] **Step 3: Remove `estimateInputTokens` from shared**

Delete `estimateInputTokens` and its `js-tiktoken` import from `packages/shared/src/estimate.ts`. Remove the export from `packages/shared/src/index.ts`.

- [ ] **Step 4: Remove `js-tiktoken` dependency**

Delete `js-tiktoken` from `packages/shared/package.json` dependencies.

- [ ] **Step 5: Place golden values in Tokenizer workspace**

Create `durable-objects/tokenizer-controller/test/tokenizer.test.ts` and move the BPE parity and fallback tests there. If the Tokenizer source file does not exist yet, create a minimal `src/tokenizer.ts` that wraps `js-tiktoken` and export `estimateInputTokens` from there. Move the `js-tiktoken` dependency to `durable-objects/tokenizer-controller/package.json`.

- [ ] **Step 6: Update gateway-worker imports**

Change `apps/gateway-worker/src/proxy.ts` to import `estimateInputTokens` from the Tokenizer workspace once it exists. If the workspace does not yet exist, create it with the minimal package structure and update `package-lock.json` by running `npm install`.

- [ ] **Step 7: Run tests for both workspaces**

```bash
npm test -w packages/shared
npm test -w durable-objects/tokenizer-controller
npm test -w apps/gateway-worker
```

- [ ] **Step 8: Run typecheck**

`npm run typecheck`

---

## Task 6: Align dependency graph in requirements

**Files:**
- Modify: `REQUIREMENTS_2026-08-17.md:687-701`

**Interfaces:**
- Consumes: actual `package.json` files for `@octg/shared`, `gateway-worker`, and any existing tokenizer workspace.
- Produces: requirements dependency graph consistent with code.

- [ ] **Step 1: Verify current package dependencies**

Read `packages/shared/package.json`, `apps/gateway-worker/package.json`, `durable-objects/quota-controller/package.json`, and any tokenizer-controller package.json.

- [ ] **Step 2: Update requirements text**

Match the dependency graph to the actual code:

- If a tokenizer workspace exists and needs only `js-tiktoken` (no `@octg/shared`), draw that.
- If gateway-worker uses the tokenizer workspace, draw that edge.
- If no shared types are needed by the tokenizer, remove the `@octg/shared` edge from tokenizer-controller.
- If shared types **are** needed, introduce a contracts-only package or note that the dependency must be added before this requirement is implemented.

- [ ] **Step 3: Verify no contradictions**

Ensure the updated graph does not assert dependencies that do not exist in `package.json`.

---

## Task 7: Fix heading hierarchy for Acceptance Criteria

**Files:**
- Modify: `REQUIREMENTS_2026-08-17.md:978-982`

**Interfaces:**
- Produces: `AC-01` as h2 under h1 `# 21. Acceptance Criteria`.

- [ ] **Step 1: Change `### AC-01` to `## AC-01`**

Apply the same change for `AC-02` if it also uses `###`.

- [ ] **Step 2: Run markdown lint if available**

`npm run lint:md` or `npx markdownlint-cli2 REQUIREMENTS_2026-08-17.md` if configured.

---

## Task 8: Update rollback procedure to separate v2 migration and feature enablement

**Files:**
- Modify: `REQUIREMENTS_2026-08-17.md:1177-1194`

**Interfaces:**
- Produces: two-step deployment and rollback procedure.

- [ ] **Step 1: Rewrite rollback section**

Replace the single rollback diagram with:

1. **Compatibility revision (v2 class present, TokenizerDO disabled):** deploy first. This revision retains the `TokenizerController` class, migration, and binding but does not invoke it for tokenization.
2. **Feature-enabled revision:** deploy after compatibility revision is stable.
3. **Failure rollback:** roll back to the same-v2 compatibility revision, not to the pre-v2 previous revision.
4. **v2 deployment failure:** document a forward-fix procedure (e.g., fix the v2 revision and re-deploy it) rather than rolling back to a non-v2 revision.

- [ ] **Step 2: Add explicit note about 1102**

State that rolling back to the pre-v2 previous revision reintroduces the 1102 problem, so it is only acceptable as a last-resort emergency measure, not the default failure rollback.

- [ ] **Step 3: Verify section completeness**

Read the new section and confirm it distinguishes the two deployment phases and the two rollback targets.

---

## Verification

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes in affected workspaces.
- [ ] `npx markdownlint-cli2` on modified docs passes (if available).
- [ ] No `js-tiktoken` remains in `packages/shared/package.json` or `packages/shared/src`.
- [ ] Grep confirms `tokenizer_unavailable` is not used as an external HTTP `code` in docs.
- [ ] Grep confirms `tokenizer_init` / `tokenizer_encode` appear consistently in both design doc and requirements.
