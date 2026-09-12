# Large Responses Prepare Production Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate Deno `/prepare` for production Responses traffic, route malformed declared lengths safely to it, and make production deployment reject any configuration that could restore the CPU-heavy legacy route.

**Architecture:** Keep the existing Deno prepare implementation and the non-production runtime truth table intact. Change only the Worker route-selection predicate for malformed `Content-Length`, then make the production-only validator and workflow require a complete prepare pair whose trimmed threshold is exactly `"1"`; upload that pair directly after validation. Synchronize the normative specification and operator documentation with this production contract and its rollback procedure.

**Tech Stack:** TypeScript strict mode, Cloudflare Workers, Deno Deploy, GitHub Actions, Node.js 22, Vitest, Node.js test runner, Markdown.

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

  Replace the prepare-disabled production staging text in `docs/operations.md` with this operational sequence:

  ```markdown
  1. Independently deploy or verify the Deno `/prepare` service and its health/authentication behavior. This prerequisite is outside the Worker workflow's pre-mutation validation boundary.
  2. Configure the complete production prepare pair. Use an HTTPS `/prepare` endpoint and the trimmed threshold `"1"`.
  3. Confirm `deploy-production` validates the pair before D1 migration, Worker version upload, and Worker version deployment. It must upload both bindings directly and must never use empty placeholders.
  4. Run sanitized approximately 74k-token Responses canaries at concurrency 1 and 2. Confirm a `prepare` finish event, successful reservation and settlement, no Worker `exceededCpu`, and no payload or secret telemetry.
  5. For rollback, restore a known Worker version that predates prepare. Do not attempt to disable prepare by omitting variables from a later `--keep-vars` upload.
  ```

  Keep detailed routing/validation protocol facts in `SPEC.md`; the human-facing documents should link to it rather than reproduce the complete metadata and error-envelope contract.

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
- No source changes expected.
- Temporary synthetic canary payloads: create outside the repository and remove after use.

**Interfaces:**
- Consumes: Tasks 1 through 4, isolated Preview configuration, the independently deployed Deno `/prepare` service, and a dedicated production canary client.
- Produces: automated verification evidence, a safe production activation record, and a rollback verification result with no request content or credentials recorded.
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

- [ ] **Step 3: Configure and deploy the mandatory production pair**

  Set `DENO_PREPARE_ENDPOINT` in `deno-production` to the approved production HTTPS URL ending in `/prepare`, then set the exact threshold before triggering the Worker workflow:

  ```text
  DENO_PREPARE_THRESHOLD_BYTES=1
  ```

  Use the already configured positive-safe-integer `MAX_INPUT_BYTES=1048576`, full tokenizer group, and protected `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`. Trigger `deploy-production` only after the Deno prerequisite is verified. Confirm the workflow log shows `Validate Production Deno tokenizer configuration` before any D1 migration, version upload, or version deployment; it must not log or expose a value-bearing configuration error.

- [ ] **Step 4: Run an isolated Preview Responses canary at concurrency 1 and 2**

  Configure Preview with its separate `OCTG_PREVIEW_MAX_INPUT_BYTES`, `DENO_PREVIEW_PREPARE_ENDPOINT`, and `DENO_PREVIEW_PREPARE_THRESHOLD_BYTES` sources. Preserve Preview's optional-pair semantics; do not set production values in the Preview control plane.

  Export the existing `OCTG_CANARY_URL`, `OCTG_CANARY_ALLOWED_HOSTS`, and `OCTG_CANARY_CLIENT_KEY` names with isolated Preview values before running the command. Create a synthetic Responses payload outside the repository, then run the existing canary command:

  ```bash
  set -euo pipefail
  payload_file="$(mktemp)"
  trap 'rm -f "$payload_file"' EXIT
  node --input-type=module - "$payload_file" <<'NODE'
  import { writeFileSync } from "node:fs";

  const payloadPath = process.argv[2];
  const input = "token ".repeat(74_000);
  writeFileSync(payloadPath, JSON.stringify({
    model: "gpt-5",
    input,
    max_output_tokens: 16,
  }), { mode: 0o600 });
  NODE
  CANARY_PAYLOAD_PATH="$payload_file" \
  npm run canary:worker -- --env-file=admin.env --concurrency=1,2
  ```

  Expected: both canary runs succeed without Worker `exceededCpu`; the Worker emits a `prepare` finish event and no legacy `body_read`, `parse`, or `normalize` stage for the prepared request; the request reaches upstream only after quota reservation; and completion settlement is correct.

- [ ] **Step 5: Run the production canary and record only safe acceptance evidence**

  Repeat the same synthetic Responses canary at production concurrency 1 and 2 with a dedicated production canary client and the approved production hostname. Also run the operator-defined expected peak only after the 1 and 2 runs succeed. Record request IDs, Worker version IDs, HTTP statuses, resource-stage outcomes, quota reservation/settlement outcomes, and the absence of `exceededCpu`. Do not save the generated payload, a client key, a Deno authentication value, or any upstream response body in the repository.

- [ ] **Step 6: Verify rollback from a known pre-prepare Worker version**

  Before activation, record the compatible Worker version ID that predates prepare as `KNOWN_PREPARE_FREE_VERSION_ID`. If a rollback is required, restore that exact version instead of omitting prepare variables from a later `--keep-vars` upload:

  ```bash
  ./node_modules/.bin/wrangler versions deploy \
    "${KNOWN_PREPARE_FREE_VERSION_ID}@100%" \
    --config apps/gateway-worker/wrangler.jsonc \
    --message "Rollback to pre-prepare Worker version" \
    --yes
  ```

  Send the same synthetic Responses payload after rollback. Confirm no `prepare` resource stage is emitted; legacy `body_read`, `parse`, and `normalize` stages are emitted; `/tokenize` remains available; tokenization provider selection follows the retained `DENO_TOKENIZER_THRESHOLD_BYTES` setting; and quota reservation and upstream settlement remain correct.

## Requirement Coverage Review

| Specification requirement | Implementing task | Executable or review evidence |
| --- | --- | --- |
| Malformed `Content-Length` never falls back to Worker-side Responses normalization when prepare is enabled | Task 1 | Proxy regression asserts prepare/upstream calls and absence of `body_read`, `parse`, and `normalize` stages. |
| Declared raw size above the resolved limit still cancels before Deno | Task 1 | Existing declared-oversize regression remains green. |
| Production prepare pair is mandatory and threshold is exactly trimmed `"1"` | Task 2 | Node validator tests cover absent, empty, partial, invalid, whitespace-trimmed valid, and noncanonical numeric values. |
| Production validation occurs before D1 migration, upload, and deploy | Task 3 | Static workflow test checks the validator position against each remote mutation command. |
| Production upload passes the complete pair explicitly and never emits empty placeholders | Task 3 | Static workflow test checks direct `--var` arguments and rejects optional masking constructs. |
| Non-production optional pair and legacy rollback paths remain available | Tasks 2 and 4 | Task 2 does not edit runtime resolver; Task 4 documents the separate non-production contract and version rollback. |
| Deno prerequisite, shared input-limit propagation, Deno source, and secrets remain unchanged | Tasks 3 and 4 | Workflow/reference diff check is empty; secret-file assertions remain green. |
| Public documentation is synchronized | Task 4 | Normative sections 9.4, 17, and 18 plus configuration, component, and operations documents receive the same production boundary. |
| CPU mitigation is measurable and independently rollbackable | Task 5 | Preview/production synthetic canaries, safe telemetry checks, and known-version rollback verification. |

## Plan Self-Review

**Spec coverage:** All files named in the revision scope have a dedicated task. The worker routing invariant is Task 1; production validator and threshold invariant is Task 2; pre-mutation workflow invariant is Task 3; required specification/documentation updates are Task 4; rollout, canary, and rollback acceptance are Task 5. No Deno service implementation task is included because the approved spec marks it complete and identifies it as a read-only verification reference for this revision.

**Placeholder scan:** This plan contains no deferred implementation markers and no generic error-handling instructions. Every source modification names the exact file, existing behavior to replace, tests to add or remove, command to run, expected failure, and target implementation shape. The approved Deno host in the operational configuration is intentionally supplied by the production operator and is never committed.

**Type and interface consistency:** Task 1 uses the existing `DeclaredContentLength` discriminated union and reads `value` only in its `valid` variant. Tasks 2 and 3 use the same production variable names and the same trimmed `"1"` threshold contract. Task 4 documents that production-only constraint while preserving `resolveDenoRuntimeConfig` as the optional non-production runtime authority. Task 5 uses `/v1/responses`, not the Chat Completions-only default canary payload, and verifies the `prepare` resource stage introduced by the existing implementation.

## Implementation Order

1. Complete Task 1 before changing deployment activation so malformed declared lengths cannot reach the CPU-heavy legacy branch after activation.
2. Complete Task 2 before Task 3 so the workflow has one tested validator authority.
3. Complete Task 3 before Task 4 so the normative and operator documentation describe the deployed behavior rather than an intermediate state.
4. Complete Task 4 before Task 5 so the production operator has the correct canary and rollback runbook.
