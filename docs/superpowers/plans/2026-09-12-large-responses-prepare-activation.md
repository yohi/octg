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
- The complete production prepare pair is passed explicitly to the Worker upload; never represent disabled prepare with an empty `--var` value.
- For non-production environments, the prepare pair remains optional. Both absent disables prepare; a complete valid pair may use any positive safe integer no greater than `MAX_INPUT_BYTES`.
- A valid declared raw body size above `MAX_INPUT_BYTES` is rejected by the Worker and its body is canceled before Deno dispatch.
- When prepare is enabled, a missing or malformed `Content-Length` selects Deno prepare. A valid declared length at or below the configured threshold retains the legacy Worker path.
- Do not modify `apps/gateway-worker/wrangler.jsonc`, `deno.json`, the Deno deployment workflow, Deno source, shared protocol types, or Deno startup input-limit propagation in this revision.
- Do not log request bodies, client keys, authentication values, or output markers.

## Review Gate Resolution

- **RG-001:** Task 5 makes a deployed, Version Override-targeted Preview candidate and its full acceptance evidence an explicit gate before any production prepare variable, deployment, or canary.
- **RG-002:** Task 4 requires the operator runbook to carry Task 5's executable temporary-file, result assertion, `wrangler tail`, and request-audit procedure. Task 5 requires those checks for Preview, production, peak, and rollback instead of treating a canary process exit code as acceptance.
- **RG-003:** This header identifies the approved design spec, and `Requirement Coverage Review` maps every plan requirement to its design path and exact heading.

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

  Replace the prepare-disabled production staging text in `docs/operations.md` with a Preview-before-production operational sequence. The runbook must make a Preview acceptance failure an explicit stop condition before an operator sets a production prepare variable, merges the candidate to `master`, or allows the resulting `deploy-production` run to mutate production.

  ```markdown
  1. Independently deploy or verify the Deno `/prepare` service and its health/authentication behavior. This prerequisite is outside the Worker workflow's pre-mutation validation boundary.
  2. Use the existing same-repository Preview Deno smoke to deploy a valid prepare-configured Preview Worker version at 0%, then target that exact version with Cloudflare Version Override for the large Responses canary. Keep Preview configuration and credentials isolated from production.
  3. Capture `octg.canary.result` records and `wrangler tail --format=json --version-id <candidate-version>` output only in protected temporary files. Require one successful HTTP 200 result with a valid OCTG request ID and the expected Worker version for concurrency 1, and two equivalent results for concurrency 2.
  4. Correlate every result's request ID to Worker resource-stage telemetry. Require a successful `prepare` finish, no legacy `body_read`/`parse`/`normalize` stages, a successful `quota_reserve` finish before upstream, successful upstream completion, no `exceededCpu`, and a completed request-audit row. Treat the D1 row only as settlement evidence; it never decides quota availability.
  5. Only after every Preview assertion passes, configure the complete production pair with an HTTPS `/prepare` endpoint and trimmed threshold `"1"`, then let the authorized `master` push invoke `deploy-production`. Confirm its validation precedes D1 migration, Worker version upload, and Worker version deployment, and that it uploads both bindings directly without empty placeholders.
  6. Repeat the same request-ID-correlated evidence procedure for production at concurrency 1, 2, and the operator-selected representative peak. For rollback, restore a known pre-prepare Worker version and require legacy `body_read`/`parse`/`normalize` stages, no `prepare` stage, the configured legacy tokenization provider, successful reservation/upstream completion, and completed settlement evidence.
  ```

  The runbook must include the executable temporary-file, canary-result, `wrangler tail`, and request-audit commands from Task 5 rather than replacing them with an unspecified instruction to "review telemetry." It must never print or persist the synthetic payload, client key, Deno authentication value, or upstream response body. Keep detailed routing/validation protocol facts in `SPEC.md`; the human-facing documents should link to it rather than reproduce the complete metadata and error-envelope contract.

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
- Temporary synthetic payloads, canary output, telemetry capture, SQL query text, and audit output: create outside the repository with mode `0600` and remove after use.

**Interfaces:**
- Consumes: Tasks 1 through 4; the independently deployed Deno `/prepare` service; a same-repository Preview pull request; isolated Preview and production Wrangler credentials; and dedicated canary clients for each control plane.
- Produces: automated verification evidence; Preview acceptance evidence that gates every production mutation; a safe production activation record; and request-ID-correlated rollback evidence with no request content or credentials recorded.
- Requires: `PREVIEW_PREPARE_VERSION_ID`, `PREVIEW_WORKER_NAME`, `PRODUCTION_WORKER_NAME`, `CANARY_D1_DATABASE`, and the intended Worker version are recorded as safe identifiers only. `CANARY_D1_DATABASE` selects audit evidence for the matching control plane; it is never a quota authority.
- Preserves: the independent Deno deployment workflow and the existing `/tokenize` route for legacy/rollback behavior.

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

- [ ] **Step 3: Deploy and identify an isolated Preview prepare candidate before any production mutation**

  Configure only Preview's isolated `OCTG_PREVIEW_MAX_INPUT_BYTES`, `DENO_PREVIEW_PREPARE_ENDPOINT`, and `DENO_PREVIEW_PREPARE_THRESHOLD_BYTES` sources. Do not set `deno-production` variables. Open or update a same-repository pull request for the candidate, then wait for the existing `Preview Smoke Test` workflow's `deno-version-smoke` job to pass. That job deploys a valid-auth Deno Preview Worker version at 0% and restores the captured Preview version after its smoke checks.

  Record the exact valid-auth Preview version by its existing tag, then use it only through Cloudflare Version Override. Do not send the large canary to Preview's restored 100% base version.

  ```bash
  set -euo pipefail
  umask 077
  : "${PREVIEW_PR_NUMBER:?set the same-repository pull request number}"
  : "${PREVIEW_WORKER_NAME:?set the isolated Preview Worker name}"
  : "${PREVIEW_RUN_ID:?set the Preview Smoke Test run ID}"
  gh run watch "$PREVIEW_RUN_ID" --exit-status

  preview_versions_file="$(mktemp)"
  trap 'rm -f "$preview_versions_file"' EXIT
  PREVIEW_PREPARE_VERSION_TAG="pr-${PREVIEW_PR_NUMBER}-deno-valid"
  ./node_modules/.bin/wrangler versions list \
    --name "$PREVIEW_WORKER_NAME" \
    --json > "$preview_versions_file"
  PREVIEW_PREPARE_VERSION_ID="$(node --input-type=module - "$preview_versions_file" "$PREVIEW_PREPARE_VERSION_TAG" <<'NODE'
  import { readFileSync } from "node:fs";

  const [path, tag] = process.argv.slice(2);
  const ids = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value === null || typeof value !== "object") return;
    const record = value;
    if (record.tag === tag && typeof (record.version_id ?? record.id) === "string") {
      ids.add(record.version_id ?? record.id);
    }
    Object.values(record).forEach(visit);
  };
  visit(JSON.parse(readFileSync(path, "utf8")));
  if (ids.size !== 1) throw new Error("expected exactly one tagged Preview Worker version");
  const [id] = ids;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Preview Worker version ID is not a UUID");
  }
  process.stdout.write(id);
  NODE
  )"
  export PREVIEW_PREPARE_VERSION_ID
  ```

  A missing, non-unique, or non-UUID version ID fails Preview acceptance. Do not set a production variable, merge the candidate, or invoke a production deployment until the Preview canary in Step 4 passes.

- [ ] **Step 4: Run a request-ID-correlated Preview Responses canary and make it a production gate**

  Export the existing `OCTG_CANARY_URL`, `OCTG_CANARY_ALLOWED_HOSTS`, and `OCTG_CANARY_CLIENT_KEY` names with isolated Preview values. Use `OCTG_VERSION_OVERRIDE` so every request targets `PREVIEW_PREPARE_VERSION_ID`; `scripts/canary-worker-resource-limits.mjs` cannot add that header itself, so use its exported `requestCanary()` through this one-shot inline Node command. The command changes no repository file and emits only existing safe `octg.canary.result` fields.

  ```bash
  set -euo pipefail
  umask 077
  : "${PREVIEW_PREPARE_VERSION_ID:?set the Preview candidate version ID}"
  : "${PREVIEW_WORKER_NAME:?set the Preview Worker name}"
  : "${OCTG_CANARY_URL:?set the isolated Preview URL}"
  : "${OCTG_CANARY_ALLOWED_HOSTS:?set the isolated Preview host allowlist}"
  : "${OCTG_CANARY_CLIENT_KEY:?set the isolated Preview canary client key}"
  export OCTG_VERSION_OVERRIDE="$PREVIEW_PREPARE_VERSION_ID"
  export OCTG_VERSION_OVERRIDE_WORKER_NAME="$PREVIEW_WORKER_NAME"
  export CANARY_BODY_MARKER="octg_canary_body_marker_${RANDOM}_${RANDOM}"
  payload_file="$(mktemp)"
  canary_output="$(mktemp)"
  telemetry_output="$(mktemp)"
  trap 'rm -f "$payload_file" "$canary_output" "$telemetry_output"' EXIT
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
    --format=json \
    --version-id="$PREVIEW_PREPARE_VERSION_ID" >"$telemetry_output" 2>&1 &
  tail_pid=$!
  trap 'kill "$tail_pid" 2>/dev/null || true; wait "$tail_pid" 2>/dev/null || true; rm -f "$payload_file" "$canary_output" "$telemetry_output"' EXIT
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
  kill "$tail_pid"
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

  Use the request IDs from that assertion to inspect only their `octg.resource_stage` records in `telemetry_output`. This is an explicit acceptance assertion, not an informal log review: each request must have exactly one successful `prepare` finish with `tokenizationProvider: "deno"`; no `body_read`, `parse`, or `normalize` stage; a successful `quota_reserve` finish with `quotaReserved: true`; an `upstream` stage after that reservation with successful completion and `upstreamReached: true`; and no `exceededCpu` invocation outcome in the version-filtered capture. Fail when a result has no correlated stage record, a condition is absent, or a condition is contradicted. Also fail if the marker appears in either protected capture:

  ```bash
  if grep -Fq "$CANARY_BODY_MARKER" "$canary_output" "$telemetry_output"; then
    echo "canary payload marker appeared in telemetry" >&2
    exit 1
  fi
  ```

  Query only `request_id` and `status` from the matching control-plane D1 database after a bounded wait. `completed` is the required settlement evidence; `orphaned`, `uncertain`, a missing row, or a query failure fails acceptance. This query is an operational confirmation only: D1 remains audit-only and never makes a quota decision.

  ```bash
  : "${CANARY_D1_DATABASE:?set the isolated Preview D1 database name}"
  audit_sql="$(node --input-type=module - "$canary_output" <<'NODE'
  import { readFileSync } from "node:fs";

  const records = readFileSync(process.argv[2], "utf8").split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.event === "octg.canary.result" ? [value] : [];
    } catch {
      return [];
    }
  });
  const ids = records.map((record) => record.requestId);
  if (ids.some((id) => !/^req_[0-9A-HJKMNP-TV-Z]{26}$/.test(id ?? ""))) throw new Error("unsafe request ID");
  process.stdout.write(`SELECT request_id, status FROM requests WHERE request_id IN (${ids.map((id) => `'${id}'`).join(",")}) ORDER BY request_id`);
  NODE
  )"
  audit_output="$(mktemp)"
  trap 'rm -f "$payload_file" "$canary_output" "$telemetry_output" "$audit_output"' EXIT
  for attempt in 1 2 3 4 5 6; do
    ./node_modules/.bin/wrangler d1 execute "$CANARY_D1_DATABASE" \
      --remote \
      --json \
      --command "$audit_sql" >"$audit_output"
    if node --input-type=module - "$canary_output" "$audit_output" <<'NODE'
  import { readFileSync } from "node:fs";

  const resultRecords = readFileSync(process.argv[2], "utf8").split("\n").flatMap((line) => {
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
      break
    fi
    if [ "$attempt" = 6 ]; then
      echo "canary settlement evidence was not completed" >&2
      exit 1
    fi
    sleep 5
  done
  ```

  Preview acceptance is PASS only when every command and assertion above passes. On any failure, delete the temporary files, retain only safe failure facts, and stop. Production configuration, deployment, and canaries are prohibited after a Preview failure.

- [ ] **Step 5: Configure and deploy the mandatory production pair only after Preview PASS**

  Before production activation, record the currently compatible pre-prepare Worker version as `KNOWN_PREPARE_FREE_VERSION_ID` from the single 100% deployment. Do not expose credentials while doing so.

  ```bash
  set -euo pipefail
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

  Only after Step 4 is PASS, set `DENO_PREPARE_ENDPOINT` in `deno-production` to the approved production HTTPS `/prepare` URL and set `DENO_PREPARE_THRESHOLD_BYTES=1`. The authorized release operator then merges the candidate to `master`; that push invokes `deploy-production`. Do not grant an implementation agent authority to merge a pull request merely to execute this plan.

  Require the production workflow to pass. Its log must show `Validate Production Deno tokenizer configuration` before D1 migration, Worker version upload, and Worker version deployment, with no value-bearing configuration error. Afterwards, identify the exact 100% deployed version with the same `wrangler deployments status` command and assign it to `EXPECTED_PRODUCTION_WORKER_VERSION`. A failed Preview assertion, workflow run, or version lookup is a stop condition; do not continue to the production canary.

- [ ] **Step 6: Run the production canary at concurrency 1 and 2 with the same deterministic evidence gate**

  Set `OCTG_CANARY_URL`, `OCTG_CANARY_ALLOWED_HOSTS`, and `OCTG_CANARY_CLIENT_KEY` from the dedicated production canary configuration; set `PRODUCTION_WORKER_NAME`, `EXPECTED_PRODUCTION_WORKER_VERSION`, and `CANARY_D1_DATABASE` for production. Start the version-filtered `wrangler tail` capture from Step 4 before the request, create the same synthetic payload in a protected temporary file, and capture stdout to a protected `canary_output` file. Do not use Version Override in production.

  ```bash
  set -euo pipefail
  umask 077
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

  Then run the Step 4 telemetry correlation, marker-leak check, and bounded request-audit query against the production capture. In addition to the marker check, fail without printing the key if the protected captures contain the client key:

  ```bash
  if grep -Fq "$OCTG_CANARY_CLIENT_KEY" "$canary_output" "$telemetry_output"; then
    echo "canary client key appeared in protected capture" >&2
    exit 1
  fi
  ```

  Production acceptance requires every prepared-route condition from Step 4 for every request ID. An HTTP 500, a timeout, a missing result, an unexpected version, missing telemetry, a non-`completed` audit state, or `exceededCpu` is failure, not a successful canary process exit.

- [ ] **Step 7: Run the operator-defined production peak only after concurrency 1 and 2 pass**

  Set `CANARY_PEAK_CONCURRENCY` to the representative expected peak as an integer from `3` through `64`; reject any other value. Allocate fresh protected payload, canary-output, telemetry, and audit-output files, then repeat the complete Step 6 tail capture, result assertion, telemetry correlation, marker-leak check, and bounded request-audit query, changing only the canary input and expected result set.

  ```bash
  : "${CANARY_PEAK_CONCURRENCY:?set the representative production peak}"
  if ! [[ "$CANARY_PEAK_CONCURRENCY" =~ ^([3-9]|[1-5][0-9]|6[0-4])$ ]]; then
    echo "CANARY_PEAK_CONCURRENCY must be an integer from 3 through 64" >&2
    exit 2
  fi
  CANARY_PAYLOAD_PATH="$payload_file" \
  npm run canary:worker -- --env-file=admin.env \
    --concurrency="1,2,${CANARY_PEAK_CONCURRENCY}" | tee "$canary_output"
  ```

  Run the result assertion with `EXPECTED_CONCURRENCIES="1,2,${CANARY_PEAK_CONCURRENCY}"` and `EXPECTED_WORKER_VERSION="$EXPECTED_PRODUCTION_WORKER_VERSION"`. Record only safe counts, request IDs, version IDs, result statuses, stage outcomes, and final PASS/FAIL. Do not record payload, client key, Deno authentication value, or upstream body.

- [ ] **Step 8: Verify rollback from a known pre-prepare Worker version with the same request-ID correlation**

  If rollback is required, restore `KNOWN_PREPARE_FREE_VERSION_ID` instead of omitting prepare variables from a later `--keep-vars` upload:

  ```bash
  ./node_modules/.bin/wrangler versions deploy \
    "${KNOWN_PREPARE_FREE_VERSION_ID}@100%" \
    --config apps/gateway-worker/wrangler.jsonc \
    --message "Rollback to pre-prepare Worker version" \
    --yes
  ```

  Start a new protected capture and canary run before inspecting rollback behavior. Use the same result assertion and bounded audit query shown in Step 6, substituting `KNOWN_PREPARE_FREE_VERSION_ID` for `EXPECTED_PRODUCTION_WORKER_VERSION` and `EXPECTED_CONCURRENCIES=1,2`. Set `EXPECTED_LEGACY_TOKENIZATION_PROVIDER` from the retained tokenizer configuration: `deno` only when the configured legacy Deno tokenizer group and its threshold select it for this payload; otherwise `cloudflare_do`.

  ```bash
  set -euo pipefail
  umask 077
  : "${KNOWN_PREPARE_FREE_VERSION_ID:?set the known rollback version}"
  : "${PRODUCTION_WORKER_NAME:?set the production Worker name}"
  : "${CANARY_D1_DATABASE:?set the production D1 database name}"
  : "${EXPECTED_LEGACY_TOKENIZATION_PROVIDER:?set deno or cloudflare_do from retained configuration}"
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

  For every request ID, require no `prepare` stage; successful `body_read`, `parse`, and `normalize` stages; a successful `tokenize` finish with `tokenizationProvider` equal to `EXPECTED_LEGACY_TOKENIZATION_PROVIDER`; a successful `quota_reserve` before successful upstream completion; no `exceededCpu`; and `requests.status = "completed"` from the bounded audit query. Confirm `/tokenize` remains available without saving its body:

  ```bash
  : "${DENO_TOKENIZER_ENDPOINT:?set the retained tokenizer endpoint}"
  : "${DENO_TOKENIZER_AUTH_TOKEN:?load the retained tokenizer Secret without printing it}"
  tokenize_payload="$(mktemp)"
  trap 'rm -f "$payload_file" "$canary_output" "$telemetry_output" "$audit_output" "$tokenize_payload"' EXIT
  node --input-type=module - "$tokenize_payload" <<'NODE'
  import { writeFileSync } from "node:fs";

  writeFileSync(process.argv[2], JSON.stringify({ inputText: "rollback canary" }), { mode: 0o600 });
  NODE
  curl --fail --silent --show-error \
    --request POST \
    --header "Authorization: Bearer ${DENO_TOKENIZER_AUTH_TOKEN}" \
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
| Preview acceptance gates production mutation, and CPU mitigation is measurable and independently rollbackable. `docs/superpowers/specs/2026-09-09-large-responses-prepare-design.md` — `## Rollout and Acceptance`; `## Observability`; `### Worker Data Flow`; `## Testing` | Task 5 | Preview Version Override canary must pass request-result, resource-stage, audit, and `exceededCpu` assertions before production configuration or deployment. Production, peak, and rollback repeat the same request-ID correlation. |

## Plan Self-Review

**Spec coverage:** The header identifies the approved superpowers design separately from the repository's normative `SPEC.md`. The coverage table maps each design heading to an implementation task and executable evidence. The worker routing invariant is Task 1; production validator and threshold invariant is Task 2; pre-mutation workflow invariant is Task 3; required specification/documentation updates are Task 4; and Preview-gated rollout, canary, and rollback acceptance are Task 5. No Deno service implementation task is included because the approved design marks it complete and identifies it as a read-only verification reference for this revision.

**Placeholder scan:** This plan contains no deferred implementation markers or generic error-handling instructions. Every source modification names the exact file, behavior to replace, tests to add or remove, command to run, expected failure, and target implementation shape. Task 5's environment values are deliberately operator-supplied identifiers or secrets; its commands validate and never print them. The approved Deno host is intentionally supplied by the operator and is never committed.

**Type and interface consistency:** Task 1 uses the existing `DeclaredContentLength` discriminated union and reads `value` only in its `valid` variant. Tasks 2 and 3 use the same production variable names and the same trimmed `"1"` threshold contract. Task 4 documents that production-only constraint while preserving `resolveDenoRuntimeConfig` as the optional non-production runtime authority. Task 5 uses `/v1/responses`, a Version Override only in Preview, the existing `octg.canary.result` shape, request IDs, resource-stage fields, and audit status without treating D1 as quota authority.

## Implementation Order

1. Complete Task 1 before changing deployment activation so malformed declared lengths cannot reach the CPU-heavy legacy branch after activation.
2. Complete Task 2 before Task 3 so the workflow has one tested validator authority.
3. Complete Task 3 before Task 4 so the normative and operator documentation describe the deployed behavior rather than an intermediate state.
4. Complete Task 4 before Task 5 so the production operator has the correct canary and rollback runbook.
