<!-- markdownlint-disable MD013 -->

# Production and Preview Deno GitHub Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Production Deno configuration complete and secret-safe, and make
Preview CI exercise both the isolated Durable Object and real Deno tokenizer paths.

**Architecture:** Keep the checked-in Worker configuration portable. Production
uses repository Variables for the three non-secret Deno settings and the protected
`deno-production` Environment Secret
`PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`; the Worker version and Deno Deploy runtime
receive that value through temporary `0600` files. Preview keeps the existing
DO-only smoke and adds a serialized, same-repository-only job that deploys the
checked-out tokenizer to a dedicated Preview Deno app, then tests an invalid-auth
version before a valid-auth version and always rolls back Worker traffic.

**Tech Stack:** GitHub Actions YAML, Bash, Zsh, Node.js 22 built-in test runner,
Cloudflare Wrangler 4, Deno 2.9.6, Deno Deploy CLI wrapper, Markdown.

## Global Constraints

- Keep `DENO_TOKENIZER_ENDPOINT`, `DENO_TOKENIZER_THRESHOLD_BYTES`, and `DENO_TOKENIZER_TIMEOUT_MS` as non-secret Production GitHub Actions Variables.
- Keep Production Secret `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN` in GitHub Environment `deno-production`; do not print or interpolate its value.
- Keep Preview Deno identity, endpoint, Worker Secret, runtime Secret, D1, Durable Objects, registry, audit/reconciliation state, and upstream resources separate from Production.
- Keep `apps/gateway-worker/wrangler.jsonc` free of environment-specific Deno values.
- Preserve `--keep-vars` and use `versions upload --secrets-file` for atomic Worker version configuration.
- Validate Production Deno Variables and Secret presence before remote D1 migration.
- Use a temporary secrets file with mode `0600`; remove it with an EXIT trap.
- The invalid-auth Preview smoke uses a fixed non-secret sentinel, never a real Secret value.
- Fork pull requests receive only secret-free validation and never request the `preview` Environment.
- Keep Deno Deploy access credential `DENO_DEPLOY_TOKEN` separate from the tokenizer runtime Secret.
- Do not print request bodies, response bodies, Authorization headers, API keys, client keys, or Secret values.
- Use Node.js `>=22`, the repository's built-in `node:test` runner, and existing pinned action/runtime versions.

---

### Task 1: Add Preview Configuration Helper and Smoke Expectations

**Files:**

- Create: `scripts/preview-worker-config.mjs`
- Create: `scripts/preview-worker-config.test.mjs`
- Modify: `scripts/ci-smoke-test.sh`
- Modify: `scripts/ci-smoke-test.test.sh`
- Modify: `package.json`

**Interfaces:**

- Export `PREVIEW_DENO_VARIABLE_NAMES` from `scripts/preview-worker-config.mjs`.
- Export `buildPreviewWorkerConfig(baseConfig, options)` returning a plain Wrangler config object.
- `options` contains `projectRoot`, `databaseId`, `databaseName`, `workerName`, `upstreamBaseUrl`, `standardLimit`, `miniLimit`, and `deno` where `deno` is either `undefined` for DO-only mode or `{ endpoint, thresholdBytes, timeoutMs }` for Deno mode.
- `buildPreviewWorkerConfig` removes all Deno variables in DO-only mode and writes only Preview values in Deno mode; it never writes an authentication Secret.
- Extend `scripts/ci-smoke-test.sh` with optional `OCTG_EXPECTED_HTTP_STATUS`, defaulting to `200`. For `200`, retain completion-content and Version Override checks. For `500`, require JSON `.error.code == "internal_error"` and still require the expected Worker version header.

- [ ] **Step 1: Write failing helper and smoke tests**

Add tests with these cases:

```javascript
test("builds a DO-only Preview config without Deno values", () => {
  const config = buildPreviewWorkerConfig(baseConfig, {
    projectRoot: "/workspace",
    databaseId: "814c8fdb-dc9d-4a83-9065-001729ccd169",
    databaseName: "octg-gateway-preview-db",
    workerName: "octg-gateway-preview",
    upstreamBaseUrl: "https://gateway.example.test/openai",
    standardLimit: "0",
    miniLimit: "100000",
  });
  assert.equal(config.vars.DENO_TOKENIZER_ENDPOINT, undefined);
  assert.equal(config.vars.DENO_TOKENIZER_THRESHOLD_BYTES, undefined);
  assert.equal(config.vars.DENO_TOKENIZER_TIMEOUT_MS, undefined);
});

test("builds a Deno Preview config only from Preview values", () => {
  const config = buildPreviewWorkerConfig(baseConfig, {
    projectRoot: "/workspace",
    databaseId: "814c8fdb-dc9d-4a83-9065-001729ccd169",
    databaseName: "octg-gateway-preview-db",
    workerName: "octg-gateway-preview",
    upstreamBaseUrl: "https://gateway.example.test/openai",
    standardLimit: "0",
    miniLimit: "100000",
    deno: {
      endpoint: "https://preview-tokenizer.deno.dev/tokenize",
      thresholdBytes: "1",
      timeoutMs: "5000",
    },
  });
  assert.equal(config.vars.DENO_TOKENIZER_ENDPOINT, "https://preview-tokenizer.deno.dev/tokenize");
  assert.equal(config.vars.DENO_TOKENIZER_THRESHOLD_BYTES, "1");
  assert.equal(config.vars.DENO_TOKENIZER_TIMEOUT_MS, "5000");
  assert.equal(config.vars.DENO_TOKENIZER_AUTH_TOKEN, undefined);
});

test("rejects non-HTTPS or invalid Preview Deno settings", () => {
  assert.throws(() => buildPreviewWorkerConfig(baseConfig, {
    ...validOptions,
    deno: { endpoint: "http://preview-tokenizer.deno.dev/tokenize", thresholdBytes: "1", timeoutMs: "5000" },
  }), /Deno Preview configuration/);
});
```

Add shell assertions that the smoke helper accepts a configured expected `500`
with `error.code` `internal_error`, rejects an unexpected `200`, and never emits
the response body or a Secret-like value in its error output.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `node --test scripts/preview-worker-config.test.mjs`

Expected: FAIL because the helper does not exist.

Run: `bash scripts/ci-smoke-test.test.sh`

Expected: FAIL because the smoke helper has no expected-status mode.

- [ ] **Step 3: Implement the minimal helper and smoke status mode**

Use the existing TypeScript JSONC parser and `assertPreviewQuotaAllocation` logic
from `preview-smoke.yml`. Keep endpoint validation HTTPS-only with no URL
credentials, and validate threshold/timeout as positive safe decimal integers.
Use `jq -e '.error.code == "internal_error"'` for the expected 500 case. Keep
retry count, redacted diagnostics, request ID validation, and Version Override
behavior unchanged.

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `node --test scripts/preview-worker-config.test.mjs && bash scripts/ci-smoke-test.test.sh`

Expected: all helper and smoke tests pass with zero failures.

### Task 2: Wire the Shared Production Authentication Secret

**Files:**

- Modify: `.github/workflows/deploy-production.yml`
- Modify: `.github/workflows/deploy-deno-tokenizer.yml`
- Modify: `scripts/deploy-production-workflow.test.mjs`
- Modify: `scripts/deno-deploy-workflow.test.sh`

**Interfaces:**

- Production Worker job uses `environment: deno-production` and maps
  `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN: ${{ secrets.PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN }}`
  only in the version upload step.
- Production Worker version upload uses a temporary JSON or dotenv secrets file,
  containing only `DENO_TOKENIZER_AUTH_TOKEN`, with `--keep-vars` and all three
  explicit `--var` options, followed by `wrangler versions deploy`.
- Production Deno Deploy steps use the same Environment Secret through a
  temporary `.env` file and `deno deploy env load`; the runtime key is
  `OCTG_TOKENIZER_AUTH_TOKEN`.

- [ ] **Step 1: Extend the Production workflow contract test first**

Assert that the workflow has `environment: deno-production`, references the exact
Environment Secret name, creates a temporary secrets file, sets mode `0600`, uses
`wrangler versions upload`, passes `--secrets-file`, retains `--keep-vars`, and
deploys the uploaded version. Assert that the Secret expression is not inside a
`run:` block and that no raw tokenizer Secret value is hardcoded.

Assert that validation occurs before `Apply D1 migrations`, and that the
authentication Secret presence check also occurs before migration.

- [ ] **Step 2: Run the focused Production contract test and verify it fails**

Run: `node --test scripts/deploy-production-workflow.test.mjs`

Expected: FAIL because the workflow still uses direct `wrangler deploy` and has
no shared authentication Secret handling.

- [ ] **Step 3: Implement secret-safe Production Worker upload**

Keep the existing non-secret Variable validation and `--var` options. Write the
Secret value via Node into `$RUNNER_TEMP/production-worker-secrets.json` with
`0600`, set an EXIT trap to remove it, then run:

```yaml
./node_modules/.bin/wrangler versions upload \
  --config apps/gateway-worker/wrangler.jsonc \
  --keep-vars \
  --secrets-file "$secrets_file" \
  --var "DENO_TOKENIZER_ENDPOINT:${DENO_TOKENIZER_ENDPOINT}" \
  --var "DENO_TOKENIZER_THRESHOLD_BYTES:${DENO_TOKENIZER_THRESHOLD_BYTES}" \
  --var "DENO_TOKENIZER_TIMEOUT_MS:${DENO_TOKENIZER_TIMEOUT_MS}"
./node_modules/.bin/wrangler versions deploy --config apps/gateway-worker/wrangler.jsonc
```

Do not place the secret in `--var`, a shell command argument, workflow output, or
the checked-in repository.

- [ ] **Step 4: Implement secret-safe Production Deno runtime loading**

In `deploy-deno-tokenizer.yml`, add a step before `Deploy` that creates a
mode-`0600` dotenv file containing only `OCTG_TOKENIZER_AUTH_TOKEN` from the
Environment Secret, loads it with the pinned Deno Deploy wrapper's
`deploy env load` command scoped by `DENO_DEPLOY_ORG` and `DENO_DEPLOY_APP`, and
removes it on exit. Keep `DENO_DEPLOY_TOKEN` scoped only to deployment and
diagnostics steps.

- [ ] **Step 5: Run focused workflow contract tests**

Run: `node --test scripts/deploy-production-workflow.test.mjs && bash scripts/deno-deploy-workflow.test.sh`

Expected: both contract tests pass with zero failures and no Secret values are
printed.

### Task 3: Add the Dedicated Preview Deno Deployment and Two-Phase Smoke

**Files:**

- Modify: `.github/workflows/preview-smoke.yml`
- Modify: `scripts/preview-workflow.test.sh`

**Interfaces:**

- Existing `version-smoke` remains the DO-only Preview path and uses a config
  generated without Deno variables.
- Add a same-repository-only `deno-version-smoke` job using `environment: preview`
  and a non-canceling concurrency group dedicated to Preview Deno/Worker smoke.
- Preview Environment variables provide `DENO_PREVIEW_DEPLOY_ORG`,
  `DENO_PREVIEW_DEPLOY_APP`, `DENO_PREVIEW_TOKENIZER_ENDPOINT`,
  `DENO_PREVIEW_TOKENIZER_THRESHOLD_BYTES`, and
  `DENO_PREVIEW_TOKENIZER_TIMEOUT_MS`.
- Preview Environment Secrets provide `DENO_PREVIEW_DEPLOY_TOKEN`,
  `DENO_PREVIEW_TOKENIZER_AUTH_TOKEN`, and existing Preview Cloudflare/Worker
  secrets. The Production Secret name must not appear in this job.
- The Deno app runtime receives `OCTG_TOKENIZER_AUTH_TOKEN`; the Worker version
  receives `DENO_TOKENIZER_AUTH_TOKEN` from the same Preview Secret via temporary
  files.

- [ ] **Step 1: Extend the Preview workflow contract test first**

Assert all of the following:

1. The existing DO config path removes all three Deno Variables.
2. The new Deno job uses `environment: preview`, skips fork PRs, and has its own
   non-canceling concurrency group.
3. Preview Deno org/app/endpoint/threshold/timeout names are sourced from
   `vars.*`, and Preview Secret names are sourced from `secrets.*`.
4. The Deno staging step copies `deno.json`, tokenizer sources, shared sources,
   and the local tiktoken WASM asset without mutating checkout files.
5. The Deno runtime Secret is loaded with `deno deploy env load` from a temporary
   file, and the file cleanup is unconditional.
6. The Worker config uses `buildPreviewWorkerConfig` in Deno mode and the Worker
   Secret is loaded from a temporary file; no Production Secret expression occurs.
7. The first Deno version is deployed at `0%` beside the captured `100%` version,
   invokes `ci-smoke-test.sh` with `OCTG_EXPECTED_HTTP_STATUS=500` and an invalid
   non-secret sentinel, and verifies `internal_error` plus the Worker version.
8. A second version uses the correct Preview Secret, invokes the smoke helper with
   expected `200`, and verifies the completion plus Worker version.
9. An `always()` cleanup step restores the captured version with `wrangler rollback`.
10. Fork validation contains no `preview` Environment, Deno Deploy command, or
    credential reference.

- [ ] **Step 2: Run the focused Preview contract test and verify it fails**

Run: `bash scripts/preview-workflow.test.sh`

Expected: FAIL because the workflow has no dedicated Deno job or two-phase route
proof.

- [ ] **Step 3: Add Deno staging and runtime Secret setup**

Reuse the existing pinned Deno setup and staging shape from
`deploy-deno-tokenizer.yml`. Set staged `deploy.org` and `deploy.app` from
Preview environment Variables only. Load the runtime Secret using a temporary
dotenv file and remove it in an EXIT trap. Keep raw Deno Deploy CLI output
redirected to a temporary log and retain the existing diagnostics redaction
pattern.

- [ ] **Step 4: Add the Deno-enabled Preview Worker versions**

Generate a Deno-mode isolated Wrangler config with Preview D1/upstream values and
the three Preview Deno Variables. Capture the existing 100% version before any
traffic change. Upload the invalid-token version and route it at 0%; run the smoke
helper with the Version Override header and `OCTG_EXPECTED_HTTP_STATUS=500`.
Upload a second version with the correct Preview Worker Secret, route it at 0%
beside the same captured version, and run the smoke helper with expected `200`.
Use `if: always()` cleanup and fail the job after cleanup if either assertion
failed.

- [ ] **Step 5: Run the Preview contract test and syntax checks**

Run: `bash scripts/preview-workflow.test.sh && actionlint .github/workflows/preview-smoke.yml`

Expected: contract and YAML checks pass with zero failures.

### Task 4: Update Preview Provisioning and Documentation

**Files:**

- Modify: `scripts/setup-preview.zsh`
- Modify: `scripts/setup-preview.test.zsh`
- Modify: `docs/CONFIGURATION.md`
- Modify: `docs/deno-tokenizer.md`
- Modify: `.env.example`
- Modify: `scripts/documentation-contract.test.mjs`
- Modify: `docs/superpowers/specs/2026-09-04-production-deno-github-variables-design.md`

**Interfaces:**

- `setup-preview.zsh --github` accepts and writes only Preview Deno app identity,
  endpoint, non-secret settings, deploy token, and tokenizer auth Secret to the
  `preview` Environment; it never reads or writes Production Deno values.
- Documentation names `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN` in
  `deno-production`, the Preview-specific Secret names in `preview`, and the
  two distinct runtime key names without exposing values.

- [ ] **Step 1: Add failing provisioning/documentation assertions**

Require Preview setup tests to reject missing Preview Deno values when GitHub
configuration is requested and to assert that `gh variable set`/`gh secret set`
targets use `--env preview`. Require documentation tests to describe both the
DO-only smoke and Deno two-phase smoke, the Production Environment Secret, and the
separate Preview Secret boundary.

- [ ] **Step 2: Run focused provisioning and documentation tests**

Run: `zsh scripts/setup-preview.test.zsh && node --test scripts/documentation-contract.test.mjs`

Expected: FAIL until the new Preview inputs and documentation are present.

- [ ] **Step 3: Implement Preview setup and documentation updates**

Add concrete Preview input names and validation. Keep local `.env` parsing
allow-listed and avoid printing Secret values. Document the required first-time
Preview Deno app/environment provisioning and explain that the invalid-auth
request is intentional route-selection coverage.

- [ ] **Step 4: Run focused tests**

Run: `zsh scripts/setup-preview.test.zsh && node --test scripts/documentation-contract.test.mjs`

Expected: all provisioning and documentation contract tests pass with zero
failures.

### Task 5: Run Full Verification and Review the Secret Boundary

**Files:**

- Verify: all files changed by Tasks 1-4

- [ ] **Step 1: Run all script and workflow tests**

Run: `npm run test:scripts && npm run test:ci-smoke && npm run test:preview-workflow && npm run test:deno-deploy-workflow`

Expected: all script, shell, provisioning, Preview, and Deno Deploy contract tests
pass with zero failures.

- [ ] **Step 2: Run all workspace tests and typechecks**

Run: `npm test && npm run typecheck`

Expected: every workspace test and typecheck passes.

- [ ] **Step 3: Validate YAML, shell, JavaScript, and Markdown**

Run: `actionlint .github/workflows/deploy-production.yml .github/workflows/deploy-deno-tokenizer.yml .github/workflows/preview-smoke.yml`

Run: `bash -n scripts/ci-smoke-test.sh scripts/ci-smoke-test.test.sh scripts/preview-workflow.test.sh scripts/deno-deploy-workflow.test.sh`

Run: `node --check scripts/preview-worker-config.mjs scripts/preview-worker-config.test.mjs scripts/production-deno-config.mjs scripts/deploy-production-workflow.test.mjs scripts/documentation-contract.test.mjs`

Run:

```bash
npx --yes markdownlint-cli2 \
  docs/CONFIGURATION.md \
  docs/deno-tokenizer.md \
  docs/superpowers/specs/2026-09-04-production-deno-github-variables-design.md \
  docs/superpowers/plans/2026-09-04-production-deno-github-variables.md
```

Expected: no syntax, workflow, shell, or Markdown errors.

- [ ] **Step 4: Scan changed content for credential leakage**

Run the repository's targeted secret scan against the final diff/content. Confirm
that only Secret names and non-secret sentinel values appear, no raw credential or
client key appears, and no workflow writes a Secret into `$GITHUB_OUTPUT`.

- [ ] **Step 5: Verify operational prerequisites without reading Secret values**

Confirm GitHub names only:

```bash
gh variable list
gh variable list --env preview
gh variable list --env deno-production
gh secret list --env preview
gh secret list --env deno-production
```

Confirm the Preview Deno app, Preview endpoint, and Preview runtime Secret are
provisioned before claiming live E2E success. Do not run Production or Preview
deployments from this workspace unless explicitly requested.
