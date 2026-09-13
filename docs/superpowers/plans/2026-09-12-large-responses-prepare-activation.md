# Large Responses Prepare Production Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate Deno `/prepare` for production Responses traffic, route malformed declared lengths safely to it, and make production deployment reject any configuration that could restore the CPU-heavy legacy route.

**Architecture:** Keep the existing Deno prepare implementation and the non-production runtime truth table intact. Change only the Worker route-selection predicate for malformed `Content-Length`, then make the production-only validator and workflow require a complete prepare pair whose trimmed threshold is exactly `"1"`; upload that pair directly after validation. Synchronize the normative specification and operator documentation with this production contract and its rollback procedure.

**Tech Stack:** TypeScript strict mode, Cloudflare Workers, Deno Deploy, GitHub Actions, Node.js 22, Vitest, Node.js test runner, Markdown.

**Spec:** `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md`

## Global Constraints

- Keep `MAX_INPUT_BYTES` at its current 1 MiB (`1048576`) value.
- Avoid requiring a paid Cloudflare Workers plan.
- Quota authority remains the `QuotaController` Durable Object; D1 remains audit-only and Deno never decides quota availability.
- Deno processing occurs before quota reservation. A prepare-resolution failure never calls the Durable Object tokenizer, reserves quota, or calls the upstream gateway.
- Preserve quota reservation, in-flight admission, release, settlement, and uncertain-upstream behavior exactly as implemented.
- Preserve legacy paths for Chat Completions, non-production prepare-disabled environments, and rollback.
- In production, `DENO_PREPARE_ENDPOINT` and `DENO_PREPARE_THRESHOLD_BYTES` are mandatory, and the trimmed threshold string is exactly `"1"`.
- Production validation must fail before the first remote mutation in `deploy-production`: D1 migration, Worker version upload, or Worker version deployment.
- The valid-auth Preview Worker version used for post-deployment large-body acceptance is staged by a qualifying attempt of the PR-only smoke workflow while the candidate pull request is open; its candidate SHA, run attempt, and exact version ID are correlated before the candidate is merged, and artifact staging is not Preview acceptance or a production-mutation gate.
- The complete production prepare pair is passed explicitly to the Worker upload; never represent disabled prepare with an empty `--var` value.
- For non-production environments, the prepare pair remains optional. Both absent disables prepare; a complete valid pair may use any positive safe integer no greater than `MAX_INPUT_BYTES`.
- A valid declared raw body size above `MAX_INPUT_BYTES` is rejected by the Worker and its body is canceled before Deno dispatch.
- When prepare is enabled, a missing or malformed `Content-Length` selects Deno prepare. A valid declared length at or below the configured threshold retains the legacy Worker path.
- Do not modify `apps/gateway-worker/wrangler.jsonc`, `deno.json`, the Deno deployment workflow, Deno source, shared protocol types, or Deno startup input-limit propagation in this revision.
- Do not log request bodies, client keys, authentication values, or output markers.

## Review Gate Resolution

- **RG-001:** Task 4 and Task 5 preserve the approved rollout order: Deno prerequisite verification, complete production pair configuration, production validation/upload/deployment, isolated Preview canary, then production canary and representative peak. Preview acceptance is not introduced as a prerequisite for production configuration or deployment.
- **RG-002:** Task 4 requires the operator runbook to carry Task 5's executable temporary-file, result assertion, telemetry parser, `wrangler tail`, and request-audit procedures. Task 5 applies explicit request-ID, mode, version, resource-stage, CPU-outcome, and audit assertions to Preview, production, peak, and rollback instead of treating a canary process exit code as acceptance.
- **RG-003:** This header identifies the approved design spec, and `Requirement Coverage Review` maps each plan requirement to its design path and exact heading without adding a Preview-before-production gate requirement.
- **RG-004:** Preview version artifact staging is now a separate pre-merge operation performed while the candidate pull request is open. It requires a post-configuration qualifying attempt of the existing PR-only `deno-version-smoke` workflow, correlates the attempt's candidate SHA with exactly one new valid-auth version using the workflow tag/message and a before/after version set, and records the exact version ID before the candidate is merged. Task 5 Step 4 re-adds that recorded version to the current Preview deployment at 0% beside the current base at 100%, verifies membership before Version Override, restores the base on every exit path, and no longer opens or updates a merged pull request. Artifact staging is ordinary PR smoke and is not large-body Preview acceptance or a production-mutation gate.
- **RG-005:** The Preview version lookup now parses the Wrangler 4.120.0 JSON shape directly: the root must be an array, the tag/message must equal `annotations["workers/tag"]` and `annotations["workers/message"]`, and the version ID must be the matching record's `id`. Zero or multiple new records matching the expected tag/message and any malformed version ID fail before the ID is used for Version Override.

---

## Scope And File Structure

| File | Responsibility after this change |
| --- | --- |
| `apps/gateway-worker/src/proxy.ts` | Select Deno prepare for enabled Responses requests unless the declared length is valid and at or below the threshold; retain the raw over-limit gate and all legacy/quota cleanup paths. |
| `apps/gateway-worker/test/proxy-prepare.test.ts` | Prove malformed `Content-Length` uses prepare before Worker body parsing, without changing Chat Completions or below-threshold legacy coverage. |
| `scripts/production-deno-config.mjs` | Validate the mandatory production prepare pair, canonical production threshold, endpoint security, and existing tokenizer/input-limit requirements before deployment. |
| `scripts/production-deno-config.test.mjs` | Lock the mandatory-pair, canonical-threshold, no-value-leak, and CLI failure contracts. |
| `.github/workflows/deploy-production.yml` | Run the validator before any remote mutation and upload both mandatory prepare bindings directly. |
| `scripts/deploy-production-workflow.test.mjs` | Statically prove validation ordering and direct prepare binding upload without optional-pair masking logic. |
| `SPEC.md` | Own normative runtime, production-validation, activation, and rollback semantics in sections 9.4, 17, and 18. |
| `docs/configuration.md` | Explain the production-required pair separately from the optional non-production pair. |
| `docs/deno-tokenizer.md` | Explain prepare routing boundaries, production threshold `"1"`, activation, and rollback behavior. |
| `docs/operations.md` | Provide the production activation, pre-mutation validation, canary monitoring, and known-version rollback runbook. |

**Read-only verification references:** `apps/gateway-worker/wrangler.jsonc`, `deno.json`, `.github/workflows/deploy-deno-tokenizer.yml`, `apps/gateway-worker/src/deno-tokenizer-config.ts`, and `apps/deno-tokenizer/src/**` already provide the prepare endpoint, non-production configuration semantics, input-limit propagation, startup assertion, and secret isolation. Do not change them for this plan.

## Baseline Evidence

Before implementation, the following focused checks pass on the current branch:

```bash
npm test -w apps/gateway-worker -- proxy-prepare.test.ts
node --test scripts/production-deno-config.test.mjs scripts/deploy-production-workflow.test.mjs
```

The current behavior is intentionally captured by now-obsolete tests: malformed `Content-Length` selects the legacy Responses route, the production validator accepts an absent prepare pair and thresholds such as `"700000"`, and the production workflow conditionally omits prepare bindings. Each task below replaces only the assertion that contradicts the approved revision.

### Task 1: Route Malformed Declared Lengths Through Prepare

**Files:**
- Modify: `apps/gateway-worker/src/proxy.ts:659-669`
- Modify: `apps/gateway-worker/test/proxy-prepare.test.ts:405-422`
- Verify only: `apps/gateway-worker/src/deno-tokenizer-config.ts:80-139`

**Interfaces:**
- Consumes: `parseDeclaredContentLength(value: string | null): { kind: "absent" } | { kind: "malformed" } | { kind: "valid"; value: number }`.
- Consumes: enabled `DenoPrepareConfig` with `thresholdBytes`, `maxInputBytes`, endpoint, shared auth token, and timeout.
- Produces: `usePrepare === true` for an enabled Responses request whenever the declared length is absent or malformed, or is valid and greater than `thresholdBytes`.
- Preserves: declared sizes greater than `maxInputBytes` are canceled and return `errInputTooLarge` before Deno; Chat Completions always remains on the legacy route.

- [ ] **Step 1: Replace the obsolete malformed-length legacy test with a prepare-routing regression test**

  In `apps/gateway-worker/test/proxy-prepare.test.ts`, replace `it("uses the legacy Responses path for a malformed declared content length", ...)` with this test. It uses the existing `stubPreparedResponses()` helper so the upstream consumes the prepared stream and the prepare stage can close normally.

  ```ts
  it("routes malformed Content-Length through prepare before Worker parsing", async () => {
    // Given: prepare is enabled and the client supplies an unusable declared length.
    const resourceInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { calls } = stubPreparedResponses(JSON.stringify({
      max_output_tokens: metadata.outputMarker,
    }));

    // When: a Responses request crosses the Worker route.
    const response = await responsesRequest({ "content-length": "not-a-number" });

    // Then: Deno prepares the original stream before any legacy body processing occurs.
    expect(response.status).toBe(200);
    expect(calls).toEqual(["prepare", "upstream"]);
    const resourceEvents = resourceInfo.mock.calls
      .map(([event]) => event)
      .filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null);
    expect(resourceEvents).toContainEqual(expect.objectContaining({
      stage: "prepare",
      phase: "finish",
      outcome: "success",
    }));
    expect(resourceEvents).not.toContainEqual(expect.objectContaining({ stage: "body_read" }));
    expect(resourceEvents).not.toContainEqual(expect.objectContaining({ stage: "parse" }));
    expect(resourceEvents).not.toContainEqual(expect.objectContaining({ stage: "normalize" }));
  });
  ```

- [ ] **Step 2: Run the focused test to prove the current legacy fallback fails the new contract**

  Run:

  ```bash
  npm test -w apps/gateway-worker -- proxy-prepare.test.ts
  ```

  Expected: FAIL in `routes malformed Content-Length through prepare before Worker parsing`; the current call list is `['tokenize', 'upstream']` and legacy body stages are emitted because `usePrepare` explicitly excludes `declared.kind === "malformed"`.

- [ ] **Step 3: Replace only the prepare-selection predicate**

  In `apps/gateway-worker/src/proxy.ts`, retain the existing declared-size gate at lines 660-664 unchanged. Replace the current `usePrepare` expression with the following expression:

  ```ts
  const usePrepare = endpoint === "responses" && denoPrepareConfig.kind === "enabled" &&
    (declared.kind !== "valid" || declared.value > denoPrepareConfig.thresholdBytes);
  ```

  This intentionally treats `absent` and `malformed` alike for routing, while TypeScript narrows `declared` to the `valid` variant before reading `value`. Do not modify `parseDeclaredContentLength`, `prepareWithDeno`, quota handling, the raw over-limit cancellation branch, or the legacy body reader.

- [ ] **Step 4: Run focused behavior and type checks**

  Run:

  ```bash
  npm test -w apps/gateway-worker -- proxy-prepare.test.ts
  npm run typecheck -w apps/gateway-worker
  ```

  Expected: PASS. The malformed request calls only prepare and upstream; the existing below-threshold test still calls tokenizer and upstream; the declared 1 MiB-plus-one request still cancels before any fetch; and the Chat Completions test remains on its legacy route.

- [ ] **Step 5: Review the narrow routing boundary and commit**

  Confirm the diff changes only the predicate and its regression test. In particular, confirm the valid `Content-Length` comparison remains strictly greater than `thresholdBytes`, so declared lengths `0` and `1` remain on the production legacy invalid-body boundary when the threshold is `1`.

  ```bash
  git diff --check
  git add apps/gateway-worker/src/proxy.ts apps/gateway-worker/test/proxy-prepare.test.ts
  git commit -m "fix: route malformed content length through prepare"
  ```

### Task 2: Enforce the Mandatory Production Prepare Pair

**Files:**
- Modify: `scripts/production-deno-config.mjs:3-116`
- Modify: `scripts/production-deno-config.test.mjs:12-260`

**Interfaces:**
- Consumes: an environment-like object passed to `validateProductionDenoConfig(environment)`.
- Produces: `{ valid: boolean, missing: string[], invalid: string[] }` without including configuration values in the result or formatted CLI error.
- Requires: `DENO_TOKENIZER_ENDPOINT`, `DENO_TOKENIZER_THRESHOLD_BYTES`, `DENO_TOKENIZER_TIMEOUT_MS`, `DENO_PREPARE_ENDPOINT`, `DENO_PREPARE_THRESHOLD_BYTES`, and `MAX_INPUT_BYTES`.
- Requires: after trimming whitespace, `DENO_PREPARE_THRESHOLD_BYTES === "1"`; `DENO_PREPARE_ENDPOINT` is HTTPS and has no URL credentials.
- Preserves: non-production optional-pair semantics in `resolveDenoRuntimeConfig`; this production-only script must not be imported by the Worker runtime.

- [ ] **Step 1: Replace optional-pair assertions with mandatory production contract tests**

  In `scripts/production-deno-config.test.mjs`, extend `completeProductionConfig` so every valid production fixture includes the required prepare pair:

  ```js
  const completeProductionConfig = {
    MAX_INPUT_BYTES: "1048576",
    DENO_TOKENIZER_ENDPOINT: "https://tokenizer.example/tokenize",
    DENO_TOKENIZER_THRESHOLD_BYTES: "4096",
    DENO_TOKENIZER_TIMEOUT_MS: "5000",
    DENO_PREPARE_ENDPOINT: "https://prepare.example/prepare",
    DENO_PREPARE_THRESHOLD_BYTES: "1",
  };
  ```

  Delete the tests that say an absent pair is accepted: `allows the optional prepare pair to be disabled when both values are absent` and the absent-pair half of `accepts an absent prepare pair and a complete prepare pair`. Replace them with these exact cases:

  ```js
  test("requires the complete prepare pair in production", () => {
    const {
      DENO_PREPARE_ENDPOINT: _endpoint,
      DENO_PREPARE_THRESHOLD_BYTES: _threshold,
      ...withoutPrepare
    } = completeProductionConfig;

    assert.deepEqual(validateProductionDenoConfig(withoutPrepare), {
      valid: false,
      missing: ["DENO_PREPARE_ENDPOINT", "DENO_PREPARE_THRESHOLD_BYTES"],
      invalid: [],
    });
  });

  test("accepts only the canonical production prepare threshold", () => {
    assert.deepEqual(validateProductionDenoConfig({
      ...completeProductionConfig,
      DENO_PREPARE_THRESHOLD_BYTES: " 1 ",
    }), { valid: true, missing: [], invalid: [] });

    for (const threshold of ["0", "01", "1.0", "1e0", "700000", "1048576"]) {
      assert.deepEqual(validateProductionDenoConfig({
        ...completeProductionConfig,
        DENO_PREPARE_THRESHOLD_BYTES: threshold,
      }), {
        valid: false,
        missing: [],
        invalid: ["DENO_PREPARE_THRESHOLD_BYTES"],
      });
    }
  });
  ```

  Replace the old partial/empty tests and expand the all-missing/CLI assertions with these exact expectations:

  ```js
  test("reports absent and empty mandatory prepare members as missing", () => {
    for (const [overrides, missing] of [
      [{ DENO_PREPARE_THRESHOLD_BYTES: undefined }, ["DENO_PREPARE_THRESHOLD_BYTES"]],
      [{ DENO_PREPARE_ENDPOINT: undefined }, ["DENO_PREPARE_ENDPOINT"]],
      [{ DENO_PREPARE_ENDPOINT: "" }, ["DENO_PREPARE_ENDPOINT"]],
      [{ DENO_PREPARE_THRESHOLD_BYTES: "" }, ["DENO_PREPARE_THRESHOLD_BYTES"]],
    ]) {
      assert.deepEqual(validateProductionDenoConfig({
        ...completeProductionConfig,
        ...overrides,
      }), { valid: false, missing, invalid: [] });
    }
  });

  test("retains invalid reporting for non-empty partial prepare values", () => {
    assert.deepEqual(validateProductionDenoConfig({
      ...completeProductionConfig,
      DENO_PREPARE_ENDPOINT: "http://prepare.example/prepare",
      DENO_PREPARE_THRESHOLD_BYTES: undefined,
    }), {
      valid: false,
      missing: ["DENO_PREPARE_THRESHOLD_BYTES"],
      invalid: ["DENO_PREPARE_ENDPOINT"],
    });

    assert.deepEqual(validateProductionDenoConfig({
      ...completeProductionConfig,
      DENO_PREPARE_ENDPOINT: undefined,
      DENO_PREPARE_THRESHOLD_BYTES: "700000",
    }), {
      valid: false,
      missing: ["DENO_PREPARE_ENDPOINT"],
      invalid: ["DENO_PREPARE_THRESHOLD_BYTES"],
    });
  });

  test("reports every missing production variable by name", () => {
    assert.deepEqual(validateProductionDenoConfig({}), {
      valid: false,
      missing: [
        "DENO_TOKENIZER_ENDPOINT",
        "DENO_TOKENIZER_THRESHOLD_BYTES",
        "DENO_TOKENIZER_TIMEOUT_MS",
        "DENO_PREPARE_ENDPOINT",
        "DENO_PREPARE_THRESHOLD_BYTES",
        "MAX_INPUT_BYTES",
      ],
      invalid: [],
    });
  });
  ```

  In the existing CLI test, add this assertion while retaining the existing status and no-value assertions:

  ```js
  assert.match(
    result.stderr,
    /missing: DENO_TOKENIZER_ENDPOINT, DENO_TOKENIZER_THRESHOLD_BYTES, DENO_TOKENIZER_TIMEOUT_MS, DENO_PREPARE_ENDPOINT, DENO_PREPARE_THRESHOLD_BYTES, MAX_INPUT_BYTES/,
  );
  ```

  Retain the existing tests for endpoint HTTPS/no-credentials, non-string values, existing tokenizer settings, `MAX_INPUT_BYTES`, `OCTG_EXPECTED_MAX_INPUT_BYTES`, and value-free error output.

- [ ] **Step 2: Run the validator tests to prove the old optional semantics fail**

  Run:

  ```bash
  node --test scripts/production-deno-config.test.mjs
  ```

  Expected: FAIL because the current validator reports an absent prepare pair as valid and accepts `"700000"` as a production prepare threshold.

- [ ] **Step 3: Make prepare names required and validate the exact canonical threshold**

  In `scripts/production-deno-config.mjs`, include `PRODUCTION_PREPARE_VARIABLE_NAMES` in the existing required-name loop. Replace the optional `isPresent`/`isEmptyString` branch with direct validation of required prepare values after missing values have been collected:

  ```js
  for (const name of [
    ...PRODUCTION_DENO_VARIABLE_NAMES,
    ...PRODUCTION_PREPARE_VARIABLE_NAMES,
    PRODUCTION_INPUT_LIMIT_VARIABLE_NAME,
  ]) {
    if (isMissingValue(values[name])) {
      missing.push(name);
    }
  }

  const prepareEndpoint = values.DENO_PREPARE_ENDPOINT;
  const prepareThreshold = values.DENO_PREPARE_THRESHOLD_BYTES;
  if (!missing.includes("DENO_PREPARE_ENDPOINT") && !isValidHttpsEndpoint(prepareEndpoint)) {
    invalid.push("DENO_PREPARE_ENDPOINT");
  }
  if (
    !missing.includes("DENO_PREPARE_THRESHOLD_BYTES") &&
    (typeof prepareThreshold !== "string" || prepareThreshold.trim() !== "1")
  ) {
    invalid.push("DENO_PREPARE_THRESHOLD_BYTES");
  }
  ```

  Keep the existing validation of the tokenizer endpoint, tokenizer threshold, tokenizer timeout, and `MAX_INPUT_BYTES`. Keep rejection of an independently supplied `OCTG_EXPECTED_MAX_INPUT_BYTES`. Remove `isPresent` and `isEmptyString` if they have no remaining callers; do not add a new general numeric parser because production prepare has the deliberately stricter string contract.

- [ ] **Step 4: Run the complete production-validator contract**

  Run:

  ```bash
  node --test scripts/production-deno-config.test.mjs
  npm test -w apps/gateway-worker -- deno-tokenizer-config.test.ts
  ```

  Expected: PASS. A complete pair with `"1"` or `" 1 "` is accepted; absent, empty, partial, malformed, insecure, credential-bearing, non-string, and every noncanonical threshold value is rejected without printing any value. The unchanged Worker runtime test still proves an absent non-production pair is disabled and a valid non-production threshold such as `"700000"` remains enabled.

- [ ] **Step 5: Confirm the runtime/non-production boundary and commit**

  Confirm that this task does not edit `apps/gateway-worker/src/deno-tokenizer-config.ts` or its tests: that runtime resolver must continue to allow both prepare values to be absent outside production and to accept valid non-production thresholds such as `"700000"`.

  ```bash
  git diff --check
  git add scripts/production-deno-config.mjs scripts/production-deno-config.test.mjs
  git commit -m "fix: require production prepare activation"
  ```

### Task 3: Make Production Uploads Depend On Pre-Mutation Validation

**Files:**
- Modify: `.github/workflows/deploy-production.yml:47-61`
- Modify: `.github/workflows/deploy-production.yml:79-141`
- Modify: `scripts/deploy-production-workflow.test.mjs:78-239`

**Interfaces:**
- Consumes: the mandatory production values validated by `node scripts/production-deno-config.mjs` and the existing protected `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN` secret.
- Produces: a Worker version upload with explicit `MAX_INPUT_BYTES`, tokenizer variables, `DENO_PREPARE_ENDPOINT`, and `DENO_PREPARE_THRESHOLD_BYTES` bindings.
- Produces: static test evidence that validation occurs before D1 migration, Worker version upload, and Worker version deployment.
- Preserves: `--keep-vars`, secret-file creation and cleanup, Worker version upload/deploy behavior, and the independent Deno prerequisite workflow.

- [ ] **Step 1: Replace optional workflow assertions with mandatory-pair and ordering tests**

  In `scripts/deploy-production-workflow.test.mjs`, remove `extractPrepareArgsScript()` and replace `deploy-production workflow only uploads a complete prepare pair` with these static contract tests:

  ```js
  test("deploy-production validates prepare configuration before every remote mutation", () => {
    const workflow = readFileSync(join(root, ".github/workflows/deploy-production.yml"), "utf8");
    const validationIndex = workflow.indexOf("- name: Validate Production Deno tokenizer configuration");

    assert.ok(validationIndex >= 0, "Production configuration validation step must exist");
    for (const command of [
      "wrangler d1 migrations apply",
      "wrangler versions upload",
      "wrangler versions deploy",
    ]) {
      assert.ok(
        workflow.indexOf(command) > validationIndex,
        `Production validation must precede ${command}`,
      );
    }
  });

  test("deploy-production uploads the mandatory prepare pair directly", () => {
    const workflow = readFileSync(join(root, ".github/workflows/deploy-production.yml"), "utf8");
    const validationStep = extractStepRun(workflow, "Validate Production Deno tokenizer configuration");
    const deployCommand = extractStepRun(workflow, "Deploy Worker");

    assert.ok(validationStep, "Production configuration validation must have a run command");
    assert.ok(deployCommand, "Deploy Worker must have a run command");
    assert.match(validationStep, /node scripts\/production-deno-config\.mjs/);
    assert.doesNotMatch(validationStep, /PRODUCTION_PREPARE_CONFIGURED|unset DENO_PREPARE_/);
    assert.match(deployCommand, /--var "DENO_PREPARE_ENDPOINT:\$\{DENO_PREPARE_ENDPOINT\}"/);
    assert.match(deployCommand, /--var "DENO_PREPARE_THRESHOLD_BYTES:\$\{DENO_PREPARE_THRESHOLD_BYTES\}"/);
    assert.doesNotMatch(deployCommand, /prepare_args=\(\)|PRODUCTION_PREPARE_CONFIGURED|unset DENO_PREPARE_/);
  });
  ```

  Retain assertions that all non-secret settings originate from GitHub Variables, `--keep-vars` remains present, the auth secret is passed only through the temporary secrets file, and the Deno deploy workflow still propagates its shared input limit assertion.

- [ ] **Step 2: Run the workflow contract test to prove conditional upload logic fails**

  Run:

  ```bash
  node --test scripts/deploy-production-workflow.test.mjs
  ```

  Expected: FAIL because the checked-in workflow still sets `PRODUCTION_PREPARE_CONFIGURED`, unsets absent prepare variables, builds `prepare_args`, and omits the two `--var` arguments when the pair is absent.

- [ ] **Step 3: Remove masking logic and upload both prepare variables directly**

  In the validation step of `.github/workflows/deploy-production.yml`, leave only the shell safety flags and validator invocation:

  ```yaml
      - name: Validate Production Deno tokenizer configuration
        run: |
          set -euo pipefail
          node scripts/production-deno-config.mjs
  ```

  Keep the six GitHub Variable mappings in that step, but remove the `PRODUCTION_PREPARE_CONFIGURED` mapping.

  In the `Deploy Worker` step, remove the `PRODUCTION_PREPARE_CONFIGURED` unset block, `prepare_args=()`, pair checks, conditional append block, and the final `"${prepare_args[@]}"` argument. Add the mandatory bindings directly to the existing `wrangler versions upload` command after the tokenizer variables:

  ```bash
  --var "DENO_TOKENIZER_TIMEOUT_MS:${DENO_TOKENIZER_TIMEOUT_MS}" \
  --var "DENO_PREPARE_ENDPOINT:${DENO_PREPARE_ENDPOINT}" \
  --var "DENO_PREPARE_THRESHOLD_BYTES:${DENO_PREPARE_THRESHOLD_BYTES}"
  ```

  Remove the deploy-step `PRODUCTION_PREPARE_CONFIGURED` environment mapping. The validator is the one authority for missing, empty, partial, invalid, or noncanonical production prepare values; do not duplicate a weaker shell validation.

- [ ] **Step 4: Run workflow and validator contracts together**

  Run:

  ```bash
  node --test scripts/production-deno-config.test.mjs scripts/deploy-production-workflow.test.mjs
  ```

  Expected: PASS. The static workflow contains no disabled-state masking logic, every validated production upload carries both prepare variables, and the validator step occurs before all three remote mutation commands.

- [ ] **Step 5: Review secret and rollback safety, then commit**

  Confirm that `DENO_PREPARE_ENDPOINT` and `DENO_PREPARE_THRESHOLD_BYTES` remain GitHub Variables, while the shared authentication value remains exclusively in `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN` and the temporary `--secrets-file`. Confirm no empty `--var` placeholder can be produced.

  ```bash
  git diff --check
  git add .github/workflows/deploy-production.yml scripts/deploy-production-workflow.test.mjs
  git commit -m "ci: require prepare settings for production deploy"
  ```

### Task 4: Synchronize Normative And Operator Documentation

**Files:**
- Modify: `SPEC.md:292-320`
- Modify: `SPEC.md:630-669`
- Modify: `docs/configuration.md:90-164`
- Modify: `docs/deno-tokenizer.md:42-59`
- Modify: `docs/deno-tokenizer.md:174-199`
- Modify: `docs/deno-tokenizer.md:276-285`
- Modify: `docs/operations.md:147-216`
- Modify: `docs/operations.md:253-265`

**Interfaces:**
- Consumes: the production validator contract from Task 2, the direct upload contract from Task 3, and the Worker routing boundary from Task 1.
- Produces: `SPEC.md` as the normative source; `docs/configuration.md` as the configuration reference; `docs/deno-tokenizer.md` as component guidance; and `docs/operations.md` as the activation and recovery runbook.
- Preserves: English canonical documentation, the optional non-production runtime truth table, the unchanged Deno prerequisite deployment workflow, `/tokenize`, and the no-fallback quota invariant.

- [ ] **Step 1: Update the normative specification before human-facing summaries**

  Replace the optional-production wording in `SPEC.md` section 9.4 with a distinction between runtime and production semantics. The replacement must state all of the following facts in prose or a table:

  ```markdown
  Outside production, both prepare variables absent disables prepare; a complete valid pair enables it; and a partial or invalid pair is a Responses-only configuration error.

  With prepare enabled, a missing or malformed `Content-Length` routes a Responses request to `/prepare`. A valid declared length above the threshold routes to `/prepare`; a valid declared length at or below the threshold retains the legacy path. A valid declared length above `MAX_INPUT_BYTES` is canceled and rejected before Deno dispatch.

  Production deployment requires both prepare variables. After surrounding whitespace is trimmed, `DENO_PREPARE_THRESHOLD_BYTES` must be exactly `"1"`. The validator must reject invalid production configuration before D1 migration, Worker version upload, or Worker version deployment, and the upload passes both values explicitly.
  ```

  In section 17, replace the bullet that declares both prepare variables absent as generally disabled with separate production and non-production bullets. State that a production pair is mandatory, empty/partial/noncanonical values are invalid, and the validation boundary is before every Worker-side remote mutation. In section 18, replace the prepare-absent production activation wording with Deno prerequisite verification, mandatory-pair activation, sanitized Responses canaries at concurrency 1 and 2, `prepare` telemetry, no `exceededCpu`, and rollback to a known pre-prepare Worker version.

- [ ] **Step 2: Update configuration and component documentation with the same boundary**

  In `docs/configuration.md`, replace `Responses prepare is a separate optional pair` with two labeled contracts:

  ```markdown
  **Non-production runtime contract:** both prepare values absent disables prepare. A complete valid pair may use any positive safe-integer threshold no greater than `MAX_INPUT_BYTES`.

  **Production deployment contract:** `DENO_PREPARE_ENDPOINT` and `DENO_PREPARE_THRESHOLD_BYTES` are required GitHub Variables. The endpoint is HTTPS without URL credentials. After trimming, the threshold is exactly `"1"`; values such as `"01"`, `"1.0"`, `"1e0"`, and `"700000"` are rejected. The production validator runs before D1 migration, Worker upload, and Worker deployment, then both bindings are uploaded explicitly.
  ```

  In `docs/deno-tokenizer.md`, retain the optional non-production pair, then add the production threshold and routing boundary. State that an ordinary accepted non-empty Responses body routes to `/prepare` at threshold `"1"`, including when the original declared length is missing or malformed; only valid zero-byte or one-byte declared bodies can remain on the legacy invalid-body boundary. Replace the rollout step that says to configure an arbitrary measured prepare threshold with the mandatory production pair and `"1"`. Replace the disable instruction that deploys both prepare variables absent with the known-pre-prepare-version rollback rule.

- [ ] **Step 3: Update the operations runbook without introducing a second specification**

  Replace the prepare-disabled production staging text in `docs/operations.md` with the rollout sequence from the approved design. Do not make Preview acceptance a prerequisite for setting production variables, merging the candidate, or allowing the production workflow to validate, upload, or deploy. The runbook order must be:

  Before that normative sequence, document a separate **Preview artifact staging** procedure that runs while the candidate pull request is still open:

  ```markdown
  - Configure only the isolated Preview input-limit and prepare sources, and
    record the UTC configuration-complete time after those values are saved.
  - Keep the candidate pull request open at the recorded head SHA. Use a
    same-repository `Preview Smoke Test` attempt whose `event` is
    `pull_request`, whose `headSha` is that exact SHA, and whose
    `deno-version-smoke` job finishes successfully after configuration. A
    completed run from before configuration is not a qualifying attempt; use
    the existing GitHub Actions re-run operation when necessary.
  - Correlate the qualifying attempt with exactly one new valid-auth version
    by comparing the version ID set immediately before and after the attempt,
    then matching `pr-<number>-deno-valid` and the message containing the exact
    candidate SHA. Record the run ID, attempt, candidate SHA, and exact version
    ID; restoring traffic does not delete this deployable version artifact.
  - Treat this as ordinary PR smoke and artifact staging only. It is not the
    approximately 74k-token large-body acceptance canary and it is not a gate
    for production configuration, validation, upload, or deployment.
  ```

  The runbook must explicitly state that the exact staged version ID is carried forward after the candidate merge; Step 4 must not open or update a pull request or rely on a post-merge `pull_request` event. The normative runbook order must remain:

  ```markdown
  1. Independently deploy or verify the Deno `/prepare` service and its health/authentication behavior. This prerequisite is outside the Worker workflow's pre-mutation validation boundary.
  2. Configure the complete production pair with an HTTPS `/prepare` endpoint and trimmed threshold `"1"`, then let the authorized `master` push invoke `deploy-production`.
  3. Confirm the production validator runs before D1 migration, Worker version upload, and Worker version deployment, and that both prepare bindings are uploaded directly without empty placeholders.
  4. After production deployment, read the current isolated Preview deployment and require exactly one 100% base version. Re-add the recorded valid-auth Preview Worker version at 0% beside that base at 100%, read back and verify both memberships, then use Cloudflare Version Override for the large Responses canary. Do not trigger a new Preview workflow or open/update a pull request here. After the canary, including failure or timeout, restore the captured base to 100% and verify that the candidate is no longer a current-deployment member. Keep Preview configuration and credentials isolated from production; a cleanup failure must be reported alongside, and never replace, the original canary result.
 5. Capture `octg.canary.result` records and `wrangler tail --format=json --version-id <candidate-version>` output only in protected temporary files. Require request-result, resource-stage, CPU-outcome, ordering, and bounded request-audit assertions for Preview, production, representative peak, and rollback. Treat the D1 row only as settlement evidence; it never decides quota availability.
 6. Run the production canary after the isolated Preview canary, then run the representative peak after concurrency 1 and 2. For rollback, restore a known pre-prepare Worker version and require legacy `body_read`/`parse`/`normalize` stages, no `prepare` stage, the configured legacy tokenization provider, successful reservation/upstream completion, and completed settlement evidence.
  ```

  The runbook must include the executable Preview artifact-staging/version-lookup, temporary-file, canary-result, telemetry-parser, `wrangler tail`, and request-audit commands from Task 5 rather than replacing them with an unspecified instruction to "review telemetry." It must never print or persist the synthetic payload, client key, Deno authentication value, or upstream response body. Keep detailed routing/validation protocol facts in `SPEC.md`; the human-facing documents should link to it rather than reproduce the complete metadata and error-envelope contract.

- [ ] **Step 4: Verify wording, links, and read-only scope**

  Run:

  ```bash
  git diff --check
  git diff -- SPEC.md docs/configuration.md docs/deno-tokenizer.md docs/operations.md
  git diff -- apps/gateway-worker/wrangler.jsonc deno.json .github/workflows/deploy-deno-tokenizer.yml
  ```

  Expected: no whitespace errors; all four documents distinguish optional non-production behavior from mandatory production activation; and the read-only reference diff is empty.

- [ ] **Step 5: Commit documentation synchronization**

  ```bash
  git add SPEC.md docs/configuration.md docs/deno-tokenizer.md docs/operations.md
  git commit -m "docs: document production prepare activation"
  ```

### Task 5: Verify The Repository And Execute The Controlled Activation

**Files:**
- No repository source or helper-script changes expected.
- Temporary Preview version-list capture, synthetic payloads, canary output, telemetry capture, SQL query text, and audit output: create outside the repository with mode `0600` and remove after use.

**Interfaces:**
- Consumes: Tasks 1 through 4; the independently deployed Deno `/prepare` service; the exact valid-auth Preview Worker version staged by a qualifying same-repository pull request workflow attempt while that pull request is open; isolated Preview and production Wrangler credentials; and dedicated canary clients for each control plane.
- Produces: automated verification evidence; a safe production activation record; Preview and production request-ID-correlated acceptance evidence; and rollback evidence with no request content or credentials recorded.
- Requires: while the candidate pull request is open, `PREVIEW_PR_NUMBER`, `PREVIEW_HEAD_SHA`, `PREVIEW_CONFIGURED_AT`, `PREVIEW_RUN_ID`, `PREVIEW_RUN_ATTEMPT`, and `PREVIEW_PREPARE_VERSION_ID` are recorded as safe identifiers or timestamps only; `PREVIEW_WORKER_NAME`, `PREVIEW_CONFIG`, `PRODUCTION_WORKER_NAME`, `CANARY_D1_DATABASE`, and the intended Worker version are also recorded as safe identifiers or an isolated temporary configuration path. The run identity must describe a successful `pull_request` attempt for `PREVIEW_HEAD_SHA` that started after `PREVIEW_CONFIGURED_AT`, and the version ID must be the sole new valid-auth artifact correlated to that attempt. `PREVIEW_PREPARE_VERSION_ID` is captured before the candidate is merged and is the only Preview Version Override target used by the large-body canary. `PREVIEW_CONFIG` selects the isolated Preview control plane for deployment status, traffic changes, and cleanup. `CANARY_D1_DATABASE` selects audit evidence for the matching control plane; it is never a quota authority.
- Preserves: the independent Deno deployment workflow and the existing `/tokenize` route for legacy/rollback behavior.

  The following three shell functions are the complete, repository-free acceptance procedures used by the canary steps below. Define them in the protected operator shell before running the steps. They consume only the canary result file and the version-filtered `wrangler tail --format=json` capture; secret values are supplied to Node.js through standard input and are never passed as process arguments.

  `assert_telemetry` accepts these positional inputs: canary result file, telemetry capture file, expected Worker version, expected concurrency list, expected mode (`prepared` or `legacy`), and the expected legacy tokenization provider. It derives the exact request ID set from the canary result records, rejects duplicate IDs, and fails non-zero for missing/duplicate stage events, wrong outcomes/providers, forbidden stages, bad ordering, wrong revisions, or `exceededCpu`.

  ```bash
  assert_telemetry() {
    local canary_output="$1"
    local telemetry_output="$2"
    local expected_worker_version="$3"
    local expected_concurrencies="$4"
    local expected_mode="$5"
    local expected_legacy_provider="${6:-}"

    CANARY_OUTPUT="$canary_output" \
    TELEMETRY_OUTPUT="$telemetry_output" \
    EXPECTED_WORKER_VERSION="$expected_worker_version" \
    EXPECTED_CONCURRENCIES="$expected_concurrencies" \
    EXPECTED_MODE="$expected_mode" \
    EXPECTED_LEGACY_TOKENIZATION_PROVIDER="$expected_legacy_provider" \
    node --input-type=module <<'NODE'
  import { readFileSync } from "node:fs";

  const fail = (message) => {
    throw new Error(`telemetry assertion failed: ${message}`);
  };
  const requestIdPattern = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
  const mode = process.env.EXPECTED_MODE;
  const expectedWorkerVersion = process.env.EXPECTED_WORKER_VERSION;
  const expectedLegacyProvider = process.env.EXPECTED_LEGACY_TOKENIZATION_PROVIDER;
  if (!expectedWorkerVersion) fail("expected Worker version is missing");
  if (mode !== "prepared" && mode !== "legacy") fail("expected mode is invalid");
  if (mode === "legacy" && !["deno", "cloudflare_do"].includes(expectedLegacyProvider)) {
    fail("expected legacy tokenization provider is invalid");
  }

  const expectedKeys = process.env.EXPECTED_CONCURRENCIES.split(",").map((value) => {
    const concurrency = Number(value.trim());
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0 || concurrency > 64) {
      fail("expected concurrency is invalid");
    }
    return Array.from({ length: concurrency }, (_, ordinal) => `${concurrency}/${ordinal}`);
  }).flat();
  const expectedKeySet = new Set(expectedKeys);
  if (expectedKeySet.size !== expectedKeys.length) fail("expected concurrency list contains duplicates");

  const canaryRecords = readFileSync(process.env.CANARY_OUTPUT, "utf8").split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.event === "octg.canary.result" ? [value] : [];
    } catch {
      return [];
    }
  });
  if (canaryRecords.length !== expectedKeySet.size) fail("unexpected canary result count");
  const requestIds = new Set();
  for (const record of canaryRecords) {
    const key = `${record.concurrency}/${record.ordinal}`;
    if (!expectedKeySet.delete(key)) fail("unexpected or duplicate canary ordinal");
    if (record.outcome !== "response" || record.status !== 200) fail("canary HTTP result failed");
    if (!requestIdPattern.test(record.requestId ?? "")) fail("canary request ID is missing or invalid");
    if (record.workerVersion !== expectedWorkerVersion) fail("canary Worker version mismatch");
    if (requestIds.has(record.requestId)) fail("canary request ID is duplicated");
    requestIds.add(record.requestId);
  }
  if (expectedKeySet.size !== 0) fail("canary result is missing");

  const stageEvents = [];
  const exceededCpu = [];
  let order = 0;
  const visit = (value, lineNumber) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, lineNumber));
      return;
    }
    if (typeof value === "string") {
      const text = value.trim();
      if (text.startsWith("{") || text.startsWith("[")) {
        try { visit(JSON.parse(text), lineNumber); } catch { /* non-JSON log text */ }
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (value.event === "octg.resource_stage") stageEvents.push({ ...value, order: order++, lineNumber });
    if (value.outcome === "exceededCpu") exceededCpu.push(value);
    Object.values(value).forEach((entry) => visit(entry, lineNumber));
  };

  for (const [lineNumber, line] of readFileSync(process.env.TELEMETRY_OUTPUT, "utf8").split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    try { visit(JSON.parse(line), lineNumber); } catch { /* missing expected events fail below */ }
  }
  if (exceededCpu.length !== 0) fail("Worker reported exceededCpu");

  const forRequest = (requestId) => stageEvents.filter((event) => event.requestId === requestId);
  const assertNoStage = (events, stages) => {
    if (events.some((event) => stages.includes(event.stage))) fail("forbidden resource stage observed");
  };
  const requireSuccessfulPair = (events, stage, predicate) => {
    const matching = events.filter((event) => event.stage === stage);
    const starts = matching.filter((event) => event.phase === "start");
    const finishes = matching.filter((event) => event.phase === "finish");
    if (starts.length !== 1 || finishes.length !== 1) fail(`stage ${stage} is not exactly one start/finish pair`);
    const [start] = starts;
    const [finish] = finishes;
    if (start.revisionId !== expectedWorkerVersion || finish.revisionId !== expectedWorkerVersion) {
      fail(`stage ${stage} has an unexpected Worker revision`);
    }
    if (start.order >= finish.order || finish.outcome !== "success" || !predicate(finish)) {
      fail(`stage ${stage} did not satisfy its success assertion`);
    }
    return { start, finish };
  };

  for (const requestId of requestIds) {
    const events = forRequest(requestId);
    if (events.length === 0) fail("request has no correlated resource-stage telemetry");
    if (events.some((event) => event.revisionId !== expectedWorkerVersion)) {
      fail("request has telemetry from an unexpected Worker revision");
    }

    if (mode === "prepared") {
      assertNoStage(events, ["body_read", "parse", "normalize", "tokenize"]);
      requireSuccessfulPair(events, "prepare", (finish) => finish.tokenizationProvider === "deno");
    } else {
      assertNoStage(events, ["prepare"]);
      requireSuccessfulPair(events, "body_read", () => true);
      requireSuccessfulPair(events, "parse", () => true);
      requireSuccessfulPair(events, "normalize", () => true);
      requireSuccessfulPair(events, "tokenize", (finish) => finish.tokenizationProvider === expectedLegacyProvider);
    }

    const quota = requireSuccessfulPair(events, "quota_reserve", (finish) => finish.quotaReserved === true);
    const upstream = requireSuccessfulPair(events, "upstream", (finish) => finish.upstreamReached === true);
    if (quota.finish.order >= upstream.start.order) fail("upstream started before quota reservation finished");
  }
  console.log("resource-stage telemetry assertions passed");
  NODE
  }
  ```

  `assert_no_canary_secret_leak` accepts the two protected capture paths. It checks both the synthetic body marker and the canary client key through a Node.js validator; the two values cross the process boundary only through standard input.

  ```bash
  assert_no_canary_secret_leak() {
    local canary_output="$1"
    local telemetry_output="$2"

    printf '%s\0%s\0' "$CANARY_BODY_MARKER" "$OCTG_CANARY_CLIENT_KEY" |
      CANARY_OUTPUT="$canary_output" \
      TELEMETRY_OUTPUT="$telemetry_output" \
      node --input-type=module -e '
        import { readFileSync } from "node:fs";

        const [marker, clientKey] = readFileSync(0, "utf8").split("\0");
        if (marker === undefined || clientKey === undefined || marker.length === 0 || clientKey.length === 0) {
          throw new Error("canary secret validation input is incomplete");
        }
        const paths = [process.env.CANARY_OUTPUT, process.env.TELEMETRY_OUTPUT];
        if (paths.some((path) => typeof path !== "string")) {
          throw new Error("canary capture path is missing");
        }
        const captures = paths.map((path) => readFileSync(path, "utf8"));
        if (captures.some((capture) => capture.includes(marker) || capture.includes(clientKey))) {
          throw new Error("canary payload marker or client key appeared in protected capture");
        }
      '
  }
  ```

  `assert_audit_completed` accepts the canary result file, a protected audit output file, and the matching control-plane D1 database name. It queries only the exact request IDs produced by the canary parser, retries for a bounded period, and exits non-zero for a query failure, missing row, duplicate row, or any status other than `completed`.

  ```bash
  assert_audit_completed() {
    local canary_output="$1"
    local audit_output="$2"
    local database="$3"
    local audit_sql

    audit_sql="$(node --input-type=module - "$canary_output" <<'NODE'
  import { readFileSync } from "node:fs";

  const requestIdPattern = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
  const records = readFileSync(process.argv[2], "utf8").split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.event === "octg.canary.result" ? [value] : [];
    } catch {
      return [];
    }
  });
  const ids = records.map((record) => record.requestId);
  if (ids.length === 0 || ids.some((id) => !requestIdPattern.test(id ?? "")) || new Set(ids).size !== ids.length) {
    throw new Error("canary request ID set is missing, invalid, or duplicated");
  }
  process.stdout.write(`SELECT request_id, status FROM requests WHERE request_id IN (${ids.map((id) => `'${id}'`).join(",")}) ORDER BY request_id`);
  NODE
  )"

    for attempt in 1 2 3 4 5 6; do
      if ./node_modules/.bin/wrangler d1 execute "$database" \
        --remote \
        --json \
        --command "$audit_sql" >"$audit_output"; then
        if node --input-type=module - "$canary_output" "$audit_output" <<'NODE'
  import { readFileSync } from "node:fs";

  const resultRecords = readFileSync(process.argv[2], "utf8").split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.event === "octg.canary.result" ? [value] : [];
    } catch {
      return [];
    }
  });
  const expectedIds = new Set(resultRecords.map((record) => record.requestId));
  const rows = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value === null || typeof value !== "object") return;
    if (typeof value.request_id === "string" && typeof value.status === "string") rows.push(value);
    Object.values(value).forEach(visit);
  };
  visit(JSON.parse(readFileSync(process.argv[3], "utf8")));
  for (const requestId of expectedIds) {
    const matching = rows.filter((row) => row.request_id === requestId);
    if (matching.length !== 1 || matching[0].status !== "completed") process.exit(1);
  }
  NODE
        then
          return 0
        fi
      fi
      if [ "$attempt" = 6 ]; then
        echo "canary settlement evidence was not completed" >&2
        return 1
      fi
      sleep 5
    done
  }
  ```

- [ ] **Step 1: Run the full automated verification suite before any deployment**

  Run:

  ```bash
  npm run typecheck
  npm test
  git diff --check
  ```

  Expected: PASS. `npm test` includes `scripts/production-deno-config.test.mjs`, `scripts/deploy-production-workflow.test.mjs`, the Worker proxy test, and all existing workspace tests. Do not weaken a test if this step fails; return to the owning task and add or correct its focused regression test first.

- [ ] **Step 2: Verify the independent Deno prerequisite without exposing shared authentication**

  Use the unchanged `.github/workflows/deploy-deno-tokenizer.yml` to deploy or verify the Deno service. Confirm the service has an authenticated `POST /prepare` endpoint and an unauthenticated `GET /health` endpoint using sanitized JSON only. Do not print the bearer value, client key, request payload, response metadata header, or any secret in workflow logs, shell history, or acceptance notes.

  Record only these safe facts: Deno deployment revision, health status, authenticated prepare status, the deployed `MAX_INPUT_BYTES` decimal value, and successful startup assertion status.

  **Pre-staging before Step 3: create the Preview version artifact while the candidate pull request is open.** Configure only the isolated Preview `OCTG_PREVIEW_MAX_INPUT_BYTES`, `DENO_PREVIEW_PREPARE_ENDPOINT`, and `DENO_PREVIEW_PREPARE_THRESHOLD_BYTES` sources. Do not set `deno-production` variables. Immediately after those GitHub Environment variables are saved, record `PREVIEW_CONFIGURED_AT` as a UTC timestamp. Keep the candidate pull request open at the recorded `PREVIEW_HEAD_SHA`, identify its same-repository `Preview Smoke Test` run, and re-run that existing workflow after the configuration timestamp. This avoids treating a completed run from before the configuration change as a valid artifact source. The `deno-version-smoke` job must finish successfully in the new attempt. It uploads the valid-auth Worker version at 0% and restores the captured Preview version at 100%; restoration does not delete the deployable artifact:

  ```bash
  set -euo pipefail
  umask 077
  : "${PREVIEW_PR_NUMBER:?set the still-open same-repository pull request number}"
  : "${PREVIEW_HEAD_SHA:?set the exact candidate pull request head SHA}"
  : "${PREVIEW_CONFIGURED_AT:?record the UTC time immediately after Preview variables were saved}"
  : "${PREVIEW_WORKER_NAME:?set the isolated Preview Worker name}"
  : "${PREVIEW_RUN_ID:?set the candidate's Preview Smoke Test run ID}"
  : "${CLOUDFLARE_API_TOKEN:?load the isolated Preview API token without printing it}"
  : "${CLOUDFLARE_ACCOUNT_ID:?set the isolated Preview account ID}"

  preview_pr_file="$(mktemp)"
  preview_run_before_file="$(mktemp)"
  preview_run_after_file="$(mktemp)"
  preview_versions_before_file="$(mktemp)"
  preview_versions_after_file="$(mktemp)"
  trap 'rm -f "$preview_pr_file" "$preview_run_before_file" "$preview_run_after_file" "$preview_versions_before_file" "$preview_versions_after_file"' EXIT

  gh pr view "$PREVIEW_PR_NUMBER" \
    --json state,headRefOid,isCrossRepository > "$preview_pr_file"
  node --input-type=module - "$preview_pr_file" "$PREVIEW_HEAD_SHA" <<'NODE'
  import { readFileSync } from "node:fs";

  const [path, expectedHeadSha] = process.argv.slice(2);
  const pullRequest = JSON.parse(readFileSync(path, "utf8"));
  if (!/^[0-9a-f]{40}$/i.test(expectedHeadSha)) throw new Error("Preview head SHA is malformed");
  if (pullRequest.state !== "OPEN" || pullRequest.isCrossRepository === true) {
    throw new Error("Preview candidate must be an open same-repository pull request");
  }
  if (pullRequest.headRefOid !== expectedHeadSha) {
    throw new Error("Preview pull request head SHA changed");
  }
  NODE

  gh run view "$PREVIEW_RUN_ID" \
    --json workflowName,event,headSha,status,conclusion,attempt > "$preview_run_before_file"
  initial_attempt="$(node --input-type=module - "$preview_run_before_file" "$PREVIEW_HEAD_SHA" <<'NODE'
  import { readFileSync } from "node:fs";

  const [path, expectedHeadSha] = process.argv.slice(2);
  const run = JSON.parse(readFileSync(path, "utf8"));
  if (run.workflowName !== "Preview Smoke Test" || run.event !== "pull_request" || run.headSha !== expectedHeadSha) {
    throw new Error("Preview run is not the expected pull_request workflow for the candidate SHA");
  }
  if (!Number.isSafeInteger(run.attempt)) throw new Error("Preview run attempt is missing");
  process.stdout.write(String(run.attempt));
  NODE
  )"

  initial_status="$(node --input-type=module - "$preview_run_before_file" <<'NODE'
  import { readFileSync } from "node:fs";
  process.stdout.write(String(JSON.parse(readFileSync(process.argv[2], "utf8")).status ?? ""));
  NODE
  )"
  if [ "$initial_status" != "completed" ]; then
    gh run watch "$PREVIEW_RUN_ID" || true
  fi

  PREVIEW_PREPARE_VERSION_TAG="pr-${PREVIEW_PR_NUMBER}-deno-valid"
  PREVIEW_PREPARE_VERSION_MESSAGE="pr-${PREVIEW_PR_NUMBER} ${PREVIEW_HEAD_SHA} Deno valid auth"
  ./node_modules/.bin/wrangler versions list \
    --name "$PREVIEW_WORKER_NAME" \
    --json > "$preview_versions_before_file"

  # Re-run the full existing workflow so this attempt reads the saved Preview variables.
  gh run rerun "$PREVIEW_RUN_ID"
  gh run watch "$PREVIEW_RUN_ID" --exit-status
  gh run view "$PREVIEW_RUN_ID" \
    --json workflowName,event,headSha,status,conclusion,attempt,startedAt,jobs > "$preview_run_after_file"

  gh pr view "$PREVIEW_PR_NUMBER" \
    --json state,headRefOid,isCrossRepository > "$preview_pr_file"
  node --input-type=module - "$preview_pr_file" "$PREVIEW_HEAD_SHA" <<'NODE'
  import { readFileSync } from "node:fs";

  const [path, expectedHeadSha] = process.argv.slice(2);
  const pullRequest = JSON.parse(readFileSync(path, "utf8"));
  if (pullRequest.state !== "OPEN" || pullRequest.isCrossRepository === true || pullRequest.headRefOid !== expectedHeadSha) {
    throw new Error("Preview candidate pull request changed during artifact staging");
  }
  NODE

  PREVIEW_RUN_ATTEMPT="$(node --input-type=module - "$preview_run_after_file" "$PREVIEW_HEAD_SHA" "$PREVIEW_CONFIGURED_AT" "$initial_attempt" <<'NODE'
  import { readFileSync } from "node:fs";

  const [path, expectedHeadSha, configuredAt, previousAttempt] = process.argv.slice(2);
  const run = JSON.parse(readFileSync(path, "utf8"));
  if (run.workflowName !== "Preview Smoke Test" || run.event !== "pull_request" || run.headSha !== expectedHeadSha) {
    throw new Error("Preview run is not the expected pull_request workflow for the candidate SHA");
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("Preview Smoke Test did not complete successfully");
  }
  if (!Number.isSafeInteger(run.attempt) || run.attempt <= Number(previousAttempt)) {
    throw new Error("Preview workflow attempt was not re-run after configuration");
  }
  const configuredTimestamp = Date.parse(configuredAt);
  const startedTimestamp = typeof run.startedAt === "string" ? Date.parse(run.startedAt) : NaN;
  if (!configuredAt.endsWith("Z") || !Number.isFinite(configuredTimestamp) || !Number.isFinite(startedTimestamp) || startedTimestamp <= configuredTimestamp) {
    throw new Error("Preview workflow attempt did not start after configuration");
  }
  const denoJobs = Array.isArray(run.jobs)
    ? run.jobs.filter((job) => job?.name === "deno-version-smoke")
    : [];
  if (denoJobs.length !== 1 || denoJobs[0]?.conclusion !== "success") {
    throw new Error("deno-version-smoke did not complete successfully");
  }
  process.stdout.write(String(run.attempt));
  NODE
  )"

  ./node_modules/.bin/wrangler versions list \
    --name "$PREVIEW_WORKER_NAME" \
    --json > "$preview_versions_after_file"

  PREVIEW_PREPARE_VERSION_ID="$(node --input-type=module - "$preview_versions_before_file" "$preview_versions_after_file" "$PREVIEW_PREPARE_VERSION_TAG" "$PREVIEW_PREPARE_VERSION_MESSAGE" <<'NODE'
  import { readFileSync } from "node:fs";

  const [beforePath, afterPath, expectedTag, expectedMessage] = process.argv.slice(2);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const readVersions = (path) => {
    const versions = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(versions)) throw new Error("Wrangler versions list JSON must be an array");
    return versions.map((version) => {
      const id = version?.id;
      if (typeof id !== "string" || !uuid.test(id)) throw new Error("Preview Worker version ID is not a UUID");
      return { id, tag: version?.annotations?.["workers/tag"], message: version?.annotations?.["workers/message"] };
    });
  };
  const before = readVersions(beforePath);
  const after = readVersions(afterPath);
  const beforeIds = new Set(before.map((version) => version.id));
  const candidates = after.filter((version) =>
    !beforeIds.has(version.id) &&
    version.tag === expectedTag &&
    version.message === expectedMessage,
  );
  if (candidates.length !== 1) {
    throw new Error("expected exactly one new valid-auth Preview Worker version for the workflow attempt");
  }
  process.stdout.write(candidates[0].id);
  NODE
  )"
  if ! [[ "$PREVIEW_PREPARE_VERSION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo "Preview artifact identity is malformed" >&2
    exit 1
  fi
  export PREVIEW_PREPARE_VERSION_ID
  export PREVIEW_RUN_ATTEMPT
  ```

  This procedure is intentionally aligned with the Wrangler `4.120.0` dependency locked in `package-lock.json`: `versions list --json` returns the ten most recent deployable versions, each version uses top-level `id`, and the upload tag/message use `annotations["workers/tag"]` and `annotations["workers/message"]`. The before/after set comparison makes the new artifact belong to the re-run attempt rather than selecting an arbitrary older duplicate. A missing or malformed version record, zero or multiple new records matching the expected tag/message, a changed PR head, a pre-configuration attempt, a failed workflow, or a failed `deno-version-smoke` job is a stop condition. This is ordinary PR smoke and artifact staging only; it is not the approximately 74k-token large-body Preview acceptance canary and it is not a gate for production configuration, validation, upload, or deployment. The exact recorded run ID, attempt, candidate SHA, and version ID are carried forward to Step 4.

- [ ] **Step 3: Configure and deploy the mandatory production pair before the Preview canary**

  Before production activation, record the currently compatible pre-prepare Worker version as `KNOWN_PREPARE_FREE_VERSION_ID` from the single 100% deployment. Do not expose credentials while doing so.

  ```bash
  set -euo pipefail
  umask 077
  production_deployments_file="$(mktemp)"
  trap 'rm -f "$production_deployments_file"' EXIT
  ./node_modules/.bin/wrangler deployments status \
    --config apps/gateway-worker/wrangler.jsonc \
    --json > "$production_deployments_file"
  KNOWN_PREPARE_FREE_VERSION_ID="$(jq -er '
    [.versions[] | select(.percentage == 100) | .version_id]
    | if length == 1 then .[0] else error("expected one 100% production version") end
  ' "$production_deployments_file")"
  export KNOWN_PREPARE_FREE_VERSION_ID
  ```

  Set `DENO_PREPARE_ENDPOINT` in `deno-production` to the approved production HTTPS `/prepare` URL and set `DENO_PREPARE_THRESHOLD_BYTES=1`. The authorized release operator then merges the candidate to `master`; that push invokes `deploy-production`. Do not grant an implementation agent authority to merge a pull request merely to execute this plan.

  Require the production workflow to pass. Its log must show `Validate Production Deno tokenizer configuration` before D1 migration, Worker version upload, and Worker version deployment, with no value-bearing configuration error. Afterwards, identify the exact 100% deployed version with the same `wrangler deployments status` command and assign it to `EXPECTED_PRODUCTION_WORKER_VERSION`. A failed workflow run or version lookup is a stop condition for the subsequent canary steps.

  The production pair and its deployment are intentionally before Step 4, matching the approved `## Rollout and Acceptance` sequence. Preview acceptance must not be described as a prerequisite for these production configuration or deployment mutations.

- [ ] **Step 4: Run the isolated Preview large-body acceptance after production deployment**

  Reuse the exact valid-auth Preview Worker version ID recorded by the pre-staging procedure while the candidate pull request was open. Do not open or update a pull request, trigger a new Preview workflow, or look up a replacement version after the candidate has been merged. Before sending any large-body request, read the current isolated Preview deployment and require exactly one 100% base version. Record it as `PREVIEW_BASE_VERSION_ID`, deploy `PREVIEW_PREPARE_VERSION_ID@0%` together with `PREVIEW_BASE_VERSION_ID@100%`, and read back the deployment until both memberships are explicitly verified. Do not send the large canary to the restored 100% base version or to a candidate whose membership has not been verified.

  A missing or non-unique version ID must already have failed during pre-staging, and the canary command below rejects any non-UUID ID before constructing the Version Override header. A deployment-status failure, a deployment with anything other than one 100% base version before staging, a failed `candidate@0%` plus `base@100%` read-back, or a candidate/base identity collision is a stop condition. Production pair configuration and deployment are completed in Step 3, and this large-body Preview acceptance remains after that deployment. Do not proceed to the production canary until this Preview candidate and its assertions are complete.

  **Continue Step 4: Run the request-ID-correlated Preview Responses canary after production deployment**

  Export the existing `OCTG_CANARY_URL`, `OCTG_CANARY_ALLOWED_HOSTS`, and `OCTG_CANARY_CLIENT_KEY` names with isolated Preview values, and set `PREVIEW_CONFIG` to the isolated Preview Wrangler configuration generated by the existing `preview-worker-config.mjs` script in `deno` mode. Use `OCTG_VERSION_OVERRIDE` so every request targets `PREVIEW_PREPARE_VERSION_ID`; `scripts/canary-worker-resource-limits.mjs` cannot add that header itself, so use its exported `requestCanary()` through this one-shot inline Node command. Keep deployment membership setup, canary execution, assertions, and restoration in one protected shell so the finalizer runs for success, failure, timeout, assertion failure, and interrupted command paths. The command changes no repository file and emits only existing safe `octg.canary.result` fields.

  ```bash
  set -euo pipefail
  umask 077
  : "${PREVIEW_PREPARE_VERSION_ID:?set the Preview candidate version ID}"
  : "${PREVIEW_WORKER_NAME:?set the Preview Worker name}"
  : "${PREVIEW_CONFIG:?set the isolated Preview Wrangler config path}"
  : "${CLOUDFLARE_API_TOKEN:?load the isolated Preview API token without printing it}"
  : "${CLOUDFLARE_ACCOUNT_ID:?set the isolated Preview account ID}"
  : "${OCTG_CANARY_URL:?set the isolated Preview URL}"
  : "${OCTG_CANARY_ALLOWED_HOSTS:?set the isolated Preview host allowlist}"
  : "${OCTG_CANARY_CLIENT_KEY:?set the isolated Preview canary client key}"

  if ! [[ "$PREVIEW_PREPARE_VERSION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo "Preview artifact identity is malformed" >&2
    exit 1
  fi
  export OCTG_VERSION_OVERRIDE="$PREVIEW_PREPARE_VERSION_ID"
  export OCTG_VERSION_OVERRIDE_WORKER_NAME="$PREVIEW_WORKER_NAME"
  export CANARY_BODY_MARKER="octg_canary_body_marker_${RANDOM}_${RANDOM}"
  preview_current_file="$(mktemp)"
  preview_membership_file="$(mktemp)"
  preview_restore_file="$(mktemp)"
  payload_file="$(mktemp)"
  canary_output="$(mktemp)"
  telemetry_output="$(mktemp)"
  audit_output="$(mktemp)"
  tail_pid=""
  preview_deployment_changed=0
  cleanup_preview() {
    local primary_status="$1"
    local restore_status=0
    set +e
    if [ -n "$tail_pid" ]; then
      kill "$tail_pid" 2>/dev/null || true
      wait "$tail_pid" 2>/dev/null || true
    fi
    if [ "$preview_deployment_changed" -eq 1 ] && [ -n "${PREVIEW_BASE_VERSION_ID:-}" ]; then
      ./node_modules/.bin/wrangler rollback \
        "$PREVIEW_BASE_VERSION_ID" \
        --config "$PREVIEW_CONFIG" \
        --message "Restore Preview base after large-body acceptance" \
        --yes
      restore_status=$?
      if [ "$restore_status" -eq 0 ]; then
        sleep 5
        ./node_modules/.bin/wrangler deployments status \
          --config "$PREVIEW_CONFIG" \
          --json > "$preview_restore_file"
        restore_status=$?
      fi
      if [ "$restore_status" -eq 0 ]; then
        if jq -e --arg base "$PREVIEW_BASE_VERSION_ID" --arg candidate "$PREVIEW_PREPARE_VERSION_ID" '
          ([.versions[]? | select(.percentage == 100) | .version_id] == [$base]) and
          ([.versions[]? | select(.version_id == $candidate)] | length == 0)
        ' "$preview_restore_file" >/dev/null; then
          :
        else
          restore_status=1
        fi
      fi
    fi
    rm -f "$preview_current_file" "$preview_membership_file" "$preview_restore_file" "$payload_file" "$canary_output" "$telemetry_output" "$audit_output"
    if [ "$restore_status" -ne 0 ]; then
      echo "Preview cleanup failed: canary_exit=$primary_status cleanup_exit=$restore_status" >&2
    fi
    if [ "$primary_status" -ne 0 ]; then
      echo "Preview canary failed: canary_exit=$primary_status cleanup_exit=$restore_status" >&2
      return "$primary_status"
    fi
    return "$restore_status"
  }
  status=0
  trap 'status=$?; cleanup_preview "$status" || status=$?; trap - EXIT; exit "$status"' EXIT

  ./node_modules/.bin/wrangler deployments status \
    --config "$PREVIEW_CONFIG" \
    --json > "$preview_current_file"
  PREVIEW_BASE_VERSION_ID="$(node --input-type=module - "$preview_current_file" <<'NODE'
  import { readFileSync } from "node:fs";

  const deployment = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const versions = Array.isArray(deployment.versions) ? deployment.versions : [];
  const bases = versions.filter((version) => version?.percentage === 100);
  const id = bases[0]?.version_id;
  if (bases.length !== 1 || typeof id !== "string" || !uuid.test(id)) {
    throw new Error("Preview deployment must have exactly one valid 100% base version");
  }
  process.stdout.write(id);
  NODE
  )"
  if [ "$PREVIEW_BASE_VERSION_ID" = "$PREVIEW_PREPARE_VERSION_ID" ]; then
    echo "Preview candidate and base version IDs must differ" >&2
    exit 1
  fi

  preview_deployment_changed=1
  ./node_modules/.bin/wrangler versions deploy \
    "${PREVIEW_PREPARE_VERSION_ID}@0%" \
    "${PREVIEW_BASE_VERSION_ID}@100%" \
    --config "$PREVIEW_CONFIG" \
    --message "Stage Preview large-body acceptance candidate" \
    --yes
  sleep 5
  ./node_modules/.bin/wrangler deployments status \
    --config "$PREVIEW_CONFIG" \
    --json > "$preview_membership_file"
  if ! jq -e --arg base "$PREVIEW_BASE_VERSION_ID" --arg candidate "$PREVIEW_PREPARE_VERSION_ID" '
    ([.versions[]? | select(.percentage == 100) | .version_id] == [$base]) and
    ([.versions[]? | select(.version_id == $candidate and .percentage == 0)] | length == 1) and
    ([.versions[]? | select(.version_id == $candidate)] | length == 1)
  ' "$preview_membership_file" >/dev/null; then
    echo "Preview candidate deployment membership was not verified" >&2
    exit 1
  fi
  node --input-type=module - "$payload_file" "$CANARY_BODY_MARKER" <<'NODE'
  import { writeFileSync } from "node:fs";

  const [payloadPath, marker] = process.argv.slice(2);
  writeFileSync(payloadPath, JSON.stringify({
    model: "gpt-5",
    input: `${marker} ${"token ".repeat(74_000)}`,
    max_output_tokens: 16,
  }), { mode: 0o600 });
  NODE
  ./node_modules/.bin/wrangler tail "$PREVIEW_WORKER_NAME" \
    --config "$PREVIEW_CONFIG" \
    --format=json \
    --version-id="$PREVIEW_PREPARE_VERSION_ID" >"$telemetry_output" 2>&1 &
  tail_pid=$!
  sleep 5
  kill -0 "$tail_pid"
  CANARY_PAYLOAD_PATH="$payload_file" CANARY_ENV_FILE=admin.env CANARY_CONCURRENCY=1,2 \
    node --input-type=module <<'NODE' | tee "$canary_output"
  import { readFile } from "node:fs/promises";
  import { requestCanary } from "./scripts/canary-worker-resource-limits.mjs";
  import { loadEnvironment, resolveCanaryConfig } from "./scripts/run-worker-canary.mjs";

  const environment = await loadEnvironment(process.env.CANARY_ENV_FILE, process.env);
  const config = resolveCanaryConfig(environment, {
    concurrency: process.env.CANARY_CONCURRENCY,
    payloadPath: process.env.CANARY_PAYLOAD_PATH,
  });
  const version = process.env.OCTG_VERSION_OVERRIDE;
  const workerName = process.env.OCTG_VERSION_OVERRIDE_WORKER_NAME;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(version ?? "") || !workerName) {
    throw new TypeError("valid Version Override inputs are required");
  }
  const payload = await readFile(config.payloadPath, "utf8");
  const fetchWithVersionOverride = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Cloudflare-Workers-Version-Overrides", `${workerName}="${version}"`);
    return fetch(input, { ...init, headers });
  };
  for (const concurrency of config.concurrency.split(",").map(Number)) {
    const results = await Promise.all(Array.from({ length: concurrency }, (_, ordinal) =>
      requestCanary({
        url: new URL(config.url),
        apiKey: config.apiKey,
        payload,
        concurrency,
        ordinal,
        requestTimeoutMs: config.timeoutMs,
        fetchImpl: fetchWithVersionOverride,
      }),
    ));
    for (const result of results) console.log(JSON.stringify(result));
  }
  NODE
  sleep 10
  kill "$tail_pid" 2>/dev/null || true
  wait "$tail_pid" || true
  ```

  Assert the captured result records instead of treating the canary process exit code as acceptance. Run this exact assertion with `EXPECTED_CONCURRENCIES=1,2` and `EXPECTED_WORKER_VERSION="$PREVIEW_PREPARE_VERSION_ID"`:

  ```bash
  EXPECTED_CONCURRENCIES=1,2 \
  EXPECTED_WORKER_VERSION="$PREVIEW_PREPARE_VERSION_ID" \
  node --input-type=module - "$canary_output" <<'NODE'
  import { readFileSync } from "node:fs";

  const [path] = process.argv.slice(2);
  const expectedVersion = process.env.EXPECTED_WORKER_VERSION;
  const concurrencies = process.env.EXPECTED_CONCURRENCIES.split(",").map(Number);
  const expected = new Set(concurrencies.flatMap((concurrency) =>
    Array.from({ length: concurrency }, (_, ordinal) => `${concurrency}/${ordinal}`),
  ));
  const records = readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.event === "octg.canary.result" ? [value] : [];
    } catch {
      return [];
    }
  });
  if (records.length !== expected.size) throw new Error("unexpected canary result count");
  for (const record of records) {
    const key = `${record.concurrency}/${record.ordinal}`;
    if (!expected.delete(key)) throw new Error("unexpected canary concurrency or ordinal");
    if (record.outcome !== "response" || record.status !== 200) throw new Error("canary HTTP response failed");
    if (!/^req_[0-9A-HJKMNP-TV-Z]{26}$/.test(record.requestId ?? "")) throw new Error("canary request ID missing");
    if (record.workerVersion !== expectedVersion) throw new Error("canary Worker version mismatch");
  }
  if (expected.size !== 0) throw new Error("missing canary result");
  console.log("canary result assertions passed");
  NODE
  ```

  Run the complete telemetry procedure defined above with the exact Preview inputs. The canary result file supplies the exact request ID set; the expected mode is `prepared`; and the expected Worker version is the Version Override target. The command fails non-zero for every missing, duplicate, contradictory, out-of-order, wrong-version, forbidden-stage, or `exceededCpu` observation:

  ```bash
  assert_telemetry \
    "$canary_output" \
    "$telemetry_output" \
    "$PREVIEW_PREPARE_VERSION_ID" \
    "1,2" \
    prepared \
    ""
  ```

  Also fail if the marker or the canary client key appears in either protected capture:

  ```bash
  assert_no_canary_secret_leak "$canary_output" "$telemetry_output"
  ```

  Run the complete bounded audit procedure defined above with the isolated Preview database and the same canary result file. `completed` is the required settlement evidence; `orphaned`, `uncertain`, a missing row, a duplicate row, or a query failure fails acceptance. This query is an operational confirmation only: D1 remains audit-only and never makes a quota decision.

  ```bash
  : "${CANARY_D1_DATABASE:?set the isolated Preview D1 database name}"
  assert_audit_completed "$canary_output" "$audit_output" "$CANARY_D1_DATABASE"
  ```

  Preview acceptance is PASS only when every command and assertion above passes. The `cleanup_preview` EXIT finalizer must always stop the tail process, restore `PREVIEW_BASE_VERSION_ID` with `wrangler rollback`, read back the deployment, require exactly one 100% base version, and require that `PREVIEW_PREPARE_VERSION_ID` is absent from the current deployment. It runs after a successful canary as well as after a failure, timeout, assertion failure, or deployment command failure. A cleanup failure is recorded with the original canary exit status and never hides it; if the canary succeeded but cleanup failed, the overall step fails. Only safe failure facts are retained after temporary-file deletion, and the subsequent production canary stops on any failure. This Preview evidence is collected after production configuration and deployment; it is not a pre-mutation production gate.

- [ ] **Step 5: Run the production canary at concurrency 1 and 2 with explicit deterministic evidence assertions**

  Set `OCTG_CANARY_URL`, `OCTG_CANARY_ALLOWED_HOSTS`, and `OCTG_CANARY_CLIENT_KEY` from the dedicated production canary configuration; set `PRODUCTION_WORKER_NAME`, `EXPECTED_PRODUCTION_WORKER_VERSION`, and `CANARY_D1_DATABASE` for production. Start a version-filtered `wrangler tail` capture before the request, create the synthetic payload in a protected temporary file, and capture stdout to a protected `canary_output` file. Do not use Version Override in production.

  ```bash
  set -euo pipefail
  umask 077
  : "${OCTG_CANARY_URL:?set the production canary URL}"
  : "${OCTG_CANARY_ALLOWED_HOSTS:?set the production canary host allowlist}"
  : "${OCTG_CANARY_CLIENT_KEY:?set the production canary client key}"
  : "${PRODUCTION_WORKER_NAME:?set the production Worker name}"
  : "${EXPECTED_PRODUCTION_WORKER_VERSION:?set the deployed production version ID}"
  : "${CANARY_D1_DATABASE:?set the production D1 database name}"
  export CANARY_BODY_MARKER="octg_canary_body_marker_${RANDOM}_${RANDOM}"
  payload_file="$(mktemp)"
  canary_output="$(mktemp)"
  telemetry_output="$(mktemp)"
  audit_output="$(mktemp)"
  trap 'if [ -n "${tail_pid:-}" ]; then kill "$tail_pid" 2>/dev/null || true; wait "$tail_pid" 2>/dev/null || true; fi; rm -f "$payload_file" "$canary_output" "$telemetry_output" "$audit_output"' EXIT
  node --input-type=module - "$payload_file" "$CANARY_BODY_MARKER" <<'NODE'
  import { writeFileSync } from "node:fs";

  const [payloadPath, marker] = process.argv.slice(2);
  writeFileSync(payloadPath, JSON.stringify({
    model: "gpt-5",
    input: `${marker} ${"token ".repeat(74_000)}`,
    max_output_tokens: 16,
  }), { mode: 0o600 });
  NODE
  ./node_modules/.bin/wrangler tail "$PRODUCTION_WORKER_NAME" \
    --format=json \
    --version-id="$EXPECTED_PRODUCTION_WORKER_VERSION" >"$telemetry_output" 2>&1 &
  tail_pid=$!
  sleep 5
  kill -0 "$tail_pid"
  CANARY_PAYLOAD_PATH="$payload_file" \
  npm run canary:worker -- --env-file=admin.env --concurrency=1,2 | tee "$canary_output"
  sleep 10
  kill "$tail_pid"
  wait "$tail_pid" || true
  EXPECTED_CONCURRENCIES=1,2 \
  EXPECTED_WORKER_VERSION="$EXPECTED_PRODUCTION_WORKER_VERSION" \
  node --input-type=module - "$canary_output" <<'NODE'
  import { readFileSync } from "node:fs";

  const [path] = process.argv.slice(2);
  const expectedVersion = process.env.EXPECTED_WORKER_VERSION;
  const concurrencies = process.env.EXPECTED_CONCURRENCIES.split(",").map(Number);
  const expected = new Set(concurrencies.flatMap((concurrency) =>
    Array.from({ length: concurrency }, (_, ordinal) => `${concurrency}/${ordinal}`),
  ));
  const records = readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.event === "octg.canary.result" ? [value] : [];
    } catch {
      return [];
    }
  });
  if (records.length !== expected.size) throw new Error("unexpected canary result count");
  for (const record of records) {
    const key = `${record.concurrency}/${record.ordinal}`;
    if (!expected.delete(key)) throw new Error("unexpected canary concurrency or ordinal");
    if (record.outcome !== "response" || record.status !== 200) throw new Error("canary HTTP response failed");
    if (!/^req_[0-9A-HJKMNP-TV-Z]{26}$/.test(record.requestId ?? "")) throw new Error("canary request ID missing");
    if (record.workerVersion !== expectedVersion) throw new Error("canary Worker version mismatch");
  }
  if (expected.size !== 0) throw new Error("missing canary result");
  console.log("canary result assertions passed");
  NODE
  ```

  Run the complete telemetry procedure defined above with the exact production inputs. The expected mode is `prepared`, the exact request ID set is derived from this step's `canary_output`, and the expected Worker version is `EXPECTED_PRODUCTION_WORKER_VERSION`:

  ```bash
  assert_telemetry \
    "$canary_output" \
    "$telemetry_output" \
    "$EXPECTED_PRODUCTION_WORKER_VERSION" \
    "1,2" \
    prepared \
    ""
  ```

  Run the marker and client-key leak check, then the complete bounded audit procedure with this step's production database:

  ```bash
  assert_no_canary_secret_leak "$canary_output" "$telemetry_output"
  assert_audit_completed "$canary_output" "$audit_output" "$CANARY_D1_DATABASE"
  ```

  Production acceptance requires every assertion in this step for every request ID. An HTTP 500, a timeout, a missing or duplicate result, an unexpected version or revision, missing telemetry, a forbidden legacy stage, a bad reservation/upstream order, a non-`completed` audit state, or `exceededCpu` is failure, not a successful canary process exit.

- [ ] **Step 6: Run the operator-defined production peak after concurrency 1 and 2 pass**

  Set `CANARY_PEAK_CONCURRENCY` to the representative expected peak as an integer from `3` through `64`; reject any other value. This step allocates fresh files and independently starts the version-filtered tail capture, sends concurrency `1`, `2`, and the selected peak, then runs both the HTTP/result assertion and the prepared-mode telemetry and audit assertions.

  ```bash
  set -euo pipefail
  umask 077
  : "${OCTG_CANARY_URL:?set the production canary URL}"
  : "${OCTG_CANARY_ALLOWED_HOSTS:?set the production canary host allowlist}"
  : "${OCTG_CANARY_CLIENT_KEY:?set the production canary client key}"
  : "${PRODUCTION_WORKER_NAME:?set the production Worker name}"
  : "${EXPECTED_PRODUCTION_WORKER_VERSION:?set the deployed production version ID}"
  : "${CANARY_D1_DATABASE:?set the production D1 database name}"
  : "${CANARY_PEAK_CONCURRENCY:?set the representative production peak}"
  if ! [[ "$CANARY_PEAK_CONCURRENCY" =~ ^([3-9]|[1-5][0-9]|6[0-4])$ ]]; then
    echo "CANARY_PEAK_CONCURRENCY must be an integer from 3 through 64" >&2
    exit 2
  fi
  export CANARY_BODY_MARKER="octg_canary_body_marker_${RANDOM}_${RANDOM}"
  payload_file="$(mktemp)"
  canary_output="$(mktemp)"
  telemetry_output="$(mktemp)"
  audit_output="$(mktemp)"
  tail_pid=""
  trap 'if [ -n "$tail_pid" ]; then kill "$tail_pid" 2>/dev/null || true; wait "$tail_pid" 2>/dev/null || true; fi; rm -f "$payload_file" "$canary_output" "$telemetry_output" "$audit_output"' EXIT
  node --input-type=module - "$payload_file" "$CANARY_BODY_MARKER" <<'NODE'
  import { writeFileSync } from "node:fs";

  const [payloadPath, marker] = process.argv.slice(2);
  writeFileSync(payloadPath, JSON.stringify({
    model: "gpt-5",
    input: `${marker} ${"token ".repeat(74_000)}`,
    max_output_tokens: 16,
  }), { mode: 0o600 });
  NODE
  ./node_modules/.bin/wrangler tail "$PRODUCTION_WORKER_NAME" \
    --format=json \
    --version-id="$EXPECTED_PRODUCTION_WORKER_VERSION" >"$telemetry_output" 2>&1 &
  tail_pid=$!
  sleep 5
  kill -0 "$tail_pid"
  CANARY_PAYLOAD_PATH="$payload_file" \
  npm run canary:worker -- --env-file=admin.env \
    --concurrency="1,2,${CANARY_PEAK_CONCURRENCY}" | tee "$canary_output"
  sleep 10
  kill "$tail_pid"
  wait "$tail_pid" || true
  ```

  Run this exact HTTP/result assertion; it derives the expected result key set from `EXPECTED_CONCURRENCIES` and fails on missing, duplicate, unexpected, non-200, missing-request-ID, or wrong-version results:

  ```bash
  EXPECTED_CONCURRENCIES="1,2,${CANARY_PEAK_CONCURRENCY}" \
  EXPECTED_WORKER_VERSION="$EXPECTED_PRODUCTION_WORKER_VERSION" \
  node --input-type=module - "$canary_output" <<'NODE'
  import { readFileSync } from "node:fs";

  const [path] = process.argv.slice(2);
  const expectedVersion = process.env.EXPECTED_WORKER_VERSION;
  const concurrencies = process.env.EXPECTED_CONCURRENCIES.split(",").map(Number);
  const expected = new Set(concurrencies.flatMap((concurrency) =>
    Array.from({ length: concurrency }, (_, ordinal) => `${concurrency}/${ordinal}`),
  ));
  const records = readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.event === "octg.canary.result" ? [value] : [];
    } catch {
      return [];
    }
  });
  if (records.length !== expected.size) throw new Error("unexpected canary result count");
  for (const record of records) {
    const key = `${record.concurrency}/${record.ordinal}`;
    if (!expected.delete(key)) throw new Error("unexpected canary concurrency or ordinal");
    if (record.outcome !== "response" || record.status !== 200) throw new Error("canary HTTP response failed");
    if (!/^req_[0-9A-HJKMNP-TV-Z]{26}$/.test(record.requestId ?? "")) throw new Error("canary request ID missing");
    if (record.workerVersion !== expectedVersion) throw new Error("canary Worker version mismatch");
  }
  if (expected.size !== 0) throw new Error("missing canary result");
  console.log("canary result assertions passed");
  NODE
  ```

  Run the complete prepared-mode telemetry assertion with this step's exact files, request ID set, and Worker version, then check for marker/client-key leakage and assert completed audit rows from the production database:

  ```bash
  assert_telemetry \
    "$canary_output" \
    "$telemetry_output" \
    "$EXPECTED_PRODUCTION_WORKER_VERSION" \
    "1,2,${CANARY_PEAK_CONCURRENCY}" \
    prepared \
    ""
  assert_no_canary_secret_leak "$canary_output" "$telemetry_output"
  assert_audit_completed "$canary_output" "$audit_output" "$CANARY_D1_DATABASE"
  ```

  Record only safe counts, request IDs, version IDs, result statuses, stage outcomes, and final PASS/FAIL. Do not record payload, client key, Deno authentication value, or upstream body.

- [ ] **Step 7: Verify rollback from a known pre-prepare Worker version with explicit legacy-mode assertions**

  If rollback is required, restore `KNOWN_PREPARE_FREE_VERSION_ID` instead of omitting prepare variables from a later `--keep-vars` upload:

  ```bash
  ./node_modules/.bin/wrangler versions deploy \
    "${KNOWN_PREPARE_FREE_VERSION_ID}@100%" \
    --config apps/gateway-worker/wrangler.jsonc \
    --message "Rollback to pre-prepare Worker version" \
    --yes
  ```

  Start a new protected capture and canary run before inspecting rollback behavior. Set `EXPECTED_LEGACY_TOKENIZATION_PROVIDER` from the retained tokenizer configuration: `deno` only when the configured legacy Deno tokenizer group and its threshold select it for this payload; otherwise `cloudflare_do`. This step supplies `KNOWN_PREPARE_FREE_VERSION_ID` as the expected Worker version, `1,2` as the exact concurrency set, and `legacy` as the telemetry mode.

  ```bash
  set -euo pipefail
  umask 077
  : "${OCTG_CANARY_URL:?set the production canary URL}"
  : "${OCTG_CANARY_ALLOWED_HOSTS:?set the production canary host allowlist}"
  : "${OCTG_CANARY_CLIENT_KEY:?set the production canary client key}"
  : "${KNOWN_PREPARE_FREE_VERSION_ID:?set the known rollback version}"
  : "${PRODUCTION_WORKER_NAME:?set the production Worker name}"
  : "${CANARY_D1_DATABASE:?set the production D1 database name}"
  : "${EXPECTED_LEGACY_TOKENIZATION_PROVIDER:?set deno or cloudflare_do from retained configuration}"
  export CANARY_BODY_MARKER="octg_canary_body_marker_${RANDOM}_${RANDOM}"
  payload_file="$(mktemp)"
  canary_output="$(mktemp)"
  telemetry_output="$(mktemp)"
  audit_output="$(mktemp)"
  tail_pid=""
  trap 'if [ -n "$tail_pid" ]; then kill "$tail_pid" 2>/dev/null || true; wait "$tail_pid" 2>/dev/null || true; fi; rm -f "$payload_file" "$canary_output" "$telemetry_output" "$audit_output"' EXIT
  node --input-type=module - "$payload_file" "$CANARY_BODY_MARKER" <<'NODE'
  import { writeFileSync } from "node:fs";

  const [payloadPath, marker] = process.argv.slice(2);
  writeFileSync(payloadPath, JSON.stringify({
    model: "gpt-5",
    input: `${marker} ${"token ".repeat(74_000)}`,
    max_output_tokens: 16,
  }), { mode: 0o600 });
  NODE
  ./node_modules/.bin/wrangler tail "$PRODUCTION_WORKER_NAME" \
    --format=json \
    --version-id="$KNOWN_PREPARE_FREE_VERSION_ID" >"$telemetry_output" 2>&1 &
  tail_pid=$!
  sleep 5
  kill -0 "$tail_pid"
  CANARY_PAYLOAD_PATH="$payload_file" \
  npm run canary:worker -- --env-file=admin.env --concurrency=1,2 | tee "$canary_output"
  sleep 10
  kill "$tail_pid"
  wait "$tail_pid" || true
  ```

  Run this exact HTTP/result assertion for the rollback request set:

  ```bash
  EXPECTED_CONCURRENCIES=1,2 \
  EXPECTED_WORKER_VERSION="$KNOWN_PREPARE_FREE_VERSION_ID" \
  node --input-type=module - "$canary_output" <<'NODE'
  import { readFileSync } from "node:fs";

  const [path] = process.argv.slice(2);
  const expectedVersion = process.env.EXPECTED_WORKER_VERSION;
  const concurrencies = process.env.EXPECTED_CONCURRENCIES.split(",").map(Number);
  const expected = new Set(concurrencies.flatMap((concurrency) =>
    Array.from({ length: concurrency }, (_, ordinal) => `${concurrency}/${ordinal}`),
  ));
  const records = readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.event === "octg.canary.result" ? [value] : [];
    } catch {
      return [];
    }
  });
  if (records.length !== expected.size) throw new Error("unexpected canary result count");
  for (const record of records) {
    const key = `${record.concurrency}/${record.ordinal}`;
    if (!expected.delete(key)) throw new Error("unexpected canary concurrency or ordinal");
    if (record.outcome !== "response" || record.status !== 200) throw new Error("rollback HTTP response failed");
    if (!/^req_[0-9A-HJKMNP-TV-Z]{26}$/.test(record.requestId ?? "")) throw new Error("rollback request ID missing");
    if (record.workerVersion !== expectedVersion) throw new Error("rollback Worker version mismatch");
  }
  if (expected.size !== 0) throw new Error("missing rollback canary result");
  console.log("rollback result assertions passed");
  NODE
  ```

  Run the complete legacy-mode telemetry assertion with this step's exact files and version. It requires no `prepare` stage; successful `body_read`, `parse`, and `normalize` stages; a successful `tokenize` finish with the configured legacy provider; a successful `quota_reserve` before successful upstream completion; and no `exceededCpu`:

  ```bash
  assert_telemetry \
    "$canary_output" \
    "$telemetry_output" \
    "$KNOWN_PREPARE_FREE_VERSION_ID" \
    "1,2" \
    legacy \
    "$EXPECTED_LEGACY_TOKENIZATION_PROVIDER"
  assert_no_canary_secret_leak "$canary_output" "$telemetry_output"
  assert_audit_completed "$canary_output" "$audit_output" "$CANARY_D1_DATABASE"
  ```

  The audit assertion requires `requests.status = "completed"` for every rollback request. Confirm `/tokenize` remains available without saving its body:

  ```bash
  : "${DENO_TOKENIZER_ENDPOINT:?set the retained tokenizer endpoint}"
  : "${DENO_TOKENIZER_AUTH_TOKEN:?load the retained tokenizer Secret without printing it}"
  tokenize_payload="$(mktemp)"
  trap 'rm -f "$payload_file" "$canary_output" "$telemetry_output" "$audit_output" "$tokenize_payload"' EXIT
  node --input-type=module - "$tokenize_payload" <<'NODE'
  import { writeFileSync } from "node:fs";

  writeFileSync(process.argv[2], JSON.stringify({ inputText: "rollback canary" }), { mode: 0o600 });
  NODE
  printf '%s' "$DENO_TOKENIZER_AUTH_TOKEN" |
    node --input-type=module -e '
      import { readFileSync } from "node:fs";

      const token = readFileSync(0, "utf8");
      if (token.length === 0 || token.includes("\r") || token.includes("\n")) {
        throw new Error("Deno tokenizer authentication value is invalid");
      }
      process.stdout.write(`header = ${JSON.stringify(`Authorization: Bearer ${token}`)}\n`);
    ' |
    curl --fail --silent --show-error \
      --request POST \
      --config - \
      --header "Content-Type: application/json" \
      --data-binary "@${tokenize_payload}" \
      --output /dev/null \
      "$DENO_TOKENIZER_ENDPOINT"
  ```

  Any missing, contradictory, or non-correlated observation fails rollback verification.

## Requirement Coverage Review

| Design requirement and source | Implementing task | Executable or review evidence |
| --- | --- | --- |
| Malformed `Content-Length` never falls back to Worker-side Responses normalization when prepare is enabled. `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md` — `### Stage 2: Deno Prepare`; `### Worker Data Flow`; `### Proxy behavior` | Task 1 | Proxy regression asserts prepare/upstream calls and absence of `body_read`, `parse`, and `normalize` stages. |
| Declared raw size above the resolved limit still cancels before Deno. `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md` — `### Stage 2: Deno Prepare`; `### Worker Data Flow`; `### Worker body reader` | Task 1 | Existing declared-oversize regression remains green. |
| Production prepare pair is mandatory and threshold is exactly trimmed `"1"`. `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md` — `### Configuration`; `### Production configuration validation` | Task 2 | Node validator tests cover absent, empty, partial, invalid, whitespace-trimmed valid, and noncanonical numeric values. |
| Production validation occurs before D1 migration, upload, and deploy. `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md` — `### Configuration`; `## Error Handling`; `### Production configuration validation` | Task 3 | Static workflow test checks the validator position against each remote mutation command. |
| Production upload passes the complete pair explicitly and never emits empty placeholders. `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md` — `### Configuration`; `## Files in Scope` | Task 3 | Static workflow test checks direct `--var` arguments and rejects optional masking constructs. |
| Non-production optional pair and legacy rollback paths remain available. `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md` — `### Configuration`; `## Rollout and Acceptance` | Tasks 2 and 4 | Task 2 does not edit the runtime resolver; Task 4 documents the separate non-production contract and version rollback. |
| Deno prerequisite, control-plane-local input-limit propagation, Deno source, and secrets remain unchanged. `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md` — `### Configuration`; `## Rollout and Acceptance`; `## Files in Scope` | Tasks 3 and 4 | Workflow/reference diff check is empty; secret-file assertions remain green. |
| Public documentation is synchronized with the approved design. `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md` — `## Files in Scope` | Task 4 | Normative sections 9.4, 17, and 18 plus configuration, component, and operations documents receive the same production boundary and executable observation path. |
| Deno prerequisite verification, complete production pair configuration, production validation/upload/deployment, isolated Preview canary, then production canary and representative peak. `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md` — `## Rollout and Acceptance` | Tasks 4 and 5 | Task 5 stages the ordinary Preview version artifact with a post-configuration qualifying workflow attempt while the candidate pull request is open, then executes production configuration/deployment in Step 3, large-body Preview evidence against the pre-staged exact version in Step 4, production canary in Step 5, and representative peak in Step 6. Artifact staging is not Preview acceptance or a production-mutation gate. |
| The PR-only Preview workflow's valid-auth version is correlated from `pr-<number>-deno-valid` to one exact Worker version ID using the locked Wrangler JSON schema and candidate SHA. `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md` — `## Rollout and Acceptance`; `## Testing` | Task 5 | Pre-staging verifies the open same-repository PR, exact `headSha`, workflow event, post-configuration `attempt`, successful `deno-version-smoke`, and the before/after version ID set. It then matches `annotations["workers/tag"]`, `annotations["workers/message"]`, and top-level `id`, rejecting zero/multiple new artifacts and invalid UUIDs before the candidate merge. |
| Preview Version Override is used only for a current-deployment member, and Preview traffic is restored after acceptance. `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md` — `## Rollout and Acceptance`; `## Observability` | Task 5 | Step 4 requires one current 100% base, deploys the recorded candidate at 0% beside it, verifies membership before the request, and uses an EXIT finalizer to restore the base at 100% and verify candidate absence on success, failure, timeout, assertion failure, and deployment failure. |
| CPU mitigation is observable and independently rollbackable. `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md` — `## Observability`; `## Testing`; `## Rollout and Acceptance` | Task 5 | The complete telemetry parser asserts exact request IDs, prepared/legacy resource stages, quota/upstream ordering, Worker revision, and absence of `exceededCpu`; the bounded D1 query asserts completed settlement evidence; Step 7 verifies the legacy route on a known pre-prepare version. |

## Plan Self-Review

**Spec coverage:** The header identifies the approved superpowers design separately from the repository's normative `SPEC.md`. The coverage table maps each design heading to an implementation task and executable evidence. The worker routing invariant is Task 1; production validator and threshold invariant is Task 2; pre-mutation workflow invariant is Task 3; required specification/documentation updates are Task 4; and the approved production-then-Preview-then-acceptance rollout, post-configuration artifact staging, deployment membership check, unconditional Preview restoration, canary, and rollback procedures are Task 5. No Deno service implementation task is included because the approved design marks it complete and identifies it as a read-only verification reference for this revision.

**Placeholder scan:** This plan contains no deferred implementation markers or generic error-handling instructions. Every source modification names the exact file, behavior to replace, tests to add or remove, command to run, expected failure, and target implementation shape. Task 5's environment values are deliberately operator-supplied identifiers or secrets; its commands validate and never print them. The approved Deno host is intentionally supplied by the operator and is never committed.

**Type and interface consistency:** Task 1 uses the existing `DeclaredContentLength` discriminated union and reads `value` only in its `valid` variant. Tasks 2 and 3 use the same production variable names and the same trimmed `"1"` threshold contract. Task 4 documents that production-only constraint while preserving `resolveDenoRuntimeConfig` as the optional non-production runtime authority. Task 5 uses `/v1/responses`, a Version Override only in Preview, the existing PR-only smoke lifecycle for artifact staging, the `gh run view` run identity fields, the Wrangler 4.120.0 version-array and annotation shape, the existing `octg.canary.result` shape, request IDs, `octg.resource_stage` fields, the existing Worker invocation `outcome` values, and audit status without treating D1 as quota authority. The reusable shell procedures define the exact prepared/legacy modes and all step-specific inputs explicitly; large-body Preview acceptance consumes the pre-staged exact version only after current-deployment membership verification, restores the captured base on every exit path, and does not trigger a post-merge workflow.

## Implementation Order

1. Complete Task 1 before changing deployment activation so malformed declared lengths cannot reach the CPU-heavy legacy branch after activation.
2. Complete Task 2 before Task 3 so the workflow has one tested validator authority.
3. Complete Task 3 before Task 4 so the normative and operator documentation describe the deployed behavior rather than an intermediate state.
4. Complete Task 4 before Task 5 so the production operator has the correct canary and rollback runbook.
