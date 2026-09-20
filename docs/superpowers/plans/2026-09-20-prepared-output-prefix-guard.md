# Prepared Output Prefix Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Deno `/prepare` fail closed when JSON property ordering prevents the generated `max_output_tokens` marker from being the first property.

**Architecture:** Keep shared Responses normalization unchanged. Validate the serialized candidate body at the Deno producer boundary against the exact prefix already required by the Worker preflight. A malformed candidate returns the existing empty-body 500 response; valid candidates retain the existing marker collision loop and metadata.

**Tech Stack:** TypeScript strict mode, Deno test runner, shared OCTG normalization package, npm workspace scripts.

**Spec:** `docs/superpowers/specs/2026-09-20-prepared-output-prefix-guard-design.md`

## Global Constraints

- The generated marker must remain the first JSON property and occur exactly once.
- The existing `preflightPreparedOutput` prefix requirement must not be weakened.
- Shared Responses normalization and public 400/413 error shapes must not change.
- A malformed prepared body must fail closed before upstream processing.
- Do not stage the pre-existing untracked `deno.lock` file.

---

## Task 1: Add The Failing Deno Regression Test

**Files:**
- Modify: `apps/deno-tokenizer/test/http.test.ts` near the `/prepare` success-path tests

**Interfaces:**
- Consumes: `prepareRequest`, `responsesBody`, and `createFixture`.
- Produces: a test that distinguishes a malformed successful response from the required 500 fail-closed response.

- [ ] **Step 1: Add the regression test**

  Add this test beside the existing `/prepare` success-path test:

  ```ts
  Deno.test("prepare: fails closed when an array-index key precedes the marker", async () => {
    const fixture = createFixture();
    const response = await fixture.handler(prepareRequest({
      body: responsesBody({ extra: { "0": "unexpected" } }),
    }));

    assertEquals(response.status, 500);
    assertEquals(await response.text(), "");
    assertEquals(fixture.calls(), 1);
  });
  ```

  The request remains otherwise valid, so the encoder call proves failure occurs
  after normalization and token estimation at the prepare serialization
  boundary.

- [ ] **Step 2: Run the focused test and verify it fails for the old behavior**

  Run:

  ```bash
  deno test --config apps/deno-tokenizer/deno.json --allow-env --allow-read apps/deno-tokenizer/test/http.test.ts --filter "array-index key"
  ```

  Expected: FAIL because the current handler returns 200 for the serialized body
  beginning with `{"0":...`.

## Task 2: Guard The Serialized Prefix

**Files:**
- Modify: `apps/deno-tokenizer/src/http.ts:375-391`

**Interfaces:**
- Consumes: the existing generated marker and serialized candidate body.
- Produces: either the existing valid serialized body or `prepareInternalFailure()` when the exact first-property contract is violated.

- [ ] **Step 1: Add the minimum producer-boundary check**

  Compute `markerJson` before the candidate acceptance condition and require the
  serialized candidate to begin with the exact generated-property prefix:

  ```ts
  const candidateSerialized = JSON.stringify(candidateBody);
  const markerJson = JSON.stringify(candidate);
  if (!candidateSerialized.startsWith(`{"max_output_tokens":${markerJson},`)) {
    return prepareInternalFailure();
  }
  if (countOccurrences(candidateSerialized, markerJson) === 1) {
    outputMarker = candidate;
    serialized = candidateSerialized;
    break;
  }
  ```

  Preserve the existing marker regeneration behavior for duplicate occurrences.
  Do not alter `normalizeResponsesUpstreamBody`, metadata, or the Worker
  preflight contract.

- [ ] **Step 2: Run the focused regression test**

  Run:

  ```bash
  deno test --config apps/deno-tokenizer/deno.json --allow-env --allow-read apps/deno-tokenizer/test/http.test.ts --filter "array-index key"
  ```

  Expected: PASS, with HTTP 500 and an empty body.

- [ ] **Step 3: Run Deno package verification**

  Run:

  ```bash
  npm run typecheck -w apps/deno-tokenizer
  npm test -w apps/deno-tokenizer
  ```

  Expected: typecheck succeeds and all Deno tokenizer tests pass.

## Task 3: Verify The Repository And Publish

**Files:**
- No additional source files.

**Interfaces:**
- Consumes: the tested Deno source and regression test.
- Produces: a focused commit pushed to the current branch's configured upstream.

- [ ] **Step 1: Run repository verification**

  Run:

  ```bash
  npm run typecheck
  npm test
  ```

  Expected: both commands exit successfully.

- [ ] **Step 2: Review the final diff and status**

  Run:

  ```bash
  git diff --check
  git diff -- apps/deno-tokenizer/src/http.ts apps/deno-tokenizer/test/http.test.ts
  git status --short
  ```

  Confirm only the intended source and test files are staged; leave the
  untracked `deno.lock` unstaged.

- [ ] **Step 3: Commit the implementation**

  Run:

  ```bash
  git add apps/deno-tokenizer/src/http.ts apps/deno-tokenizer/test/http.test.ts
  git commit -m "fix: guard prepared output prefix"
  ```

- [ ] **Step 4: Push the current branch**

  Run:

  ```bash
  git push
  ```

  Expected: the current branch `free-tier-cpu-limit-remediation/contract` is
  pushed to its configured upstream without staging `deno.lock`.
