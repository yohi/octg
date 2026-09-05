<!-- markdownlint-disable MD013 -->

# Production and Preview Deno GitHub Actions Design

## Context

Production Worker version 112 lost two of the four Deno tokenizer settings during
deployment. The checked-in `wrangler.jsonc` intentionally omits Deno settings, so
deployment workflows must provide complete, environment-owned configuration.

The existing Preview workflow removes the Deno variables and tests only the
Cloudflare Durable Object tokenizer. That proves the DO path, but it cannot detect
a broken Deno endpoint, Deno runtime Secret, or Worker-to-Deno authentication
binding.

## Scope

This change covers the three non-secret Worker settings and the two runtime
authentication bindings for Production and Preview:

- `DENO_TOKENIZER_ENDPOINT`
- `DENO_TOKENIZER_THRESHOLD_BYTES`
- `DENO_TOKENIZER_TIMEOUT_MS`
- Worker Secret `DENO_TOKENIZER_AUTH_TOKEN`
- Deno Deploy runtime Secret `OCTG_TOKENIZER_AUTH_TOKEN`

Production and Preview use separate Cloudflare Worker, D1, Durable Object,
registry, audit/reconciliation, Deno Deploy application, endpoint, and
authentication Secret resources. The two Deno authentication bindings contain the
same value within one environment, but a Production value is never passed to a
Preview job.

## Source of Truth

Production GitHub Repository Variables are the source of truth for the three
non-secret Worker values. The Production workflow reads `${{ vars.* }}` and passes
all three values to Wrangler on every Worker deployment. Production authentication
is held as the protected GitHub Environment Secret
`PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN` in `deno-production`; the workflow writes it
to a temporary secrets file and uses `versions upload --secrets-file`, never a
command argument or log line.

Preview GitHub Environment `preview` owns its own Deno Deploy identity, endpoint,
three non-secret values, Worker authentication Secret, and Deno runtime
authentication Secret. Preview workflow steps read only those Preview values.
The checked-in `wrangler.jsonc` contains no environment-specific Deno values.

## Production Deployment Flow

1. Run the existing typecheck, unit tests, and smoke contract test.
2. Validate that all three Production GitHub Variables are present, that the
   endpoint uses HTTPS without URL credentials, and that threshold and timeout are
   positive decimal integers.
3. Stop before D1 migration when validation or the Production authentication Secret
   is missing.
4. Apply the existing remote D1 migration.
5. Upload a Worker version with `--keep-vars`, all three explicit `--var` values,
   and a temporary `--secrets-file` containing only
   `DENO_TOKENIZER_AUTH_TOKEN`.
6. Deploy the uploaded version.

The Deno Deploy Production workflow loads the same protected Secret into a
temporary `.env` file with `deno deploy env load`, then deploys the Deno app. The
file is mode `0600` and removed on exit. The existing Deno Deploy access token
(`DENO_DEPLOY_TOKEN`) remains a separate CI credential.

## Preview Deployment and Smoke Flow

The existing DO-only Preview Worker smoke remains unchanged in purpose and keeps
the Deno settings absent. A separate credential-bearing job runs only for
same-repository pull requests and uses the `preview` Environment:

1. Validate Preview Deno app identity, endpoint, three settings, and both
   environment-owned authentication inputs without printing their values.
2. Stage and deploy the checked-out Deno tokenizer source to the dedicated Preview
   Deno Deploy application.
3. Load `OCTG_TOKENIZER_AUTH_TOKEN` into that Preview Deno application from a
   mode-`0600` temporary file.
4. Generate an isolated Preview Worker config that contains the Preview Deno
   endpoint, threshold, and timeout, while retaining the Preview D1 and upstream
   resources.
5. Upload the Worker version with the Preview Worker Secret from a temporary
   secrets file, but initially assign the new version `0%` traffic beside the
   current Preview version at `100%`.
6. Send a Version Override request with an intentionally invalid Deno auth token.
   The expected response is HTTP `500` with `error:internal_error`; HTTP `200`
   would indicate that the Worker incorrectly fell back to the DO tokenizer.
7. Replace the temporary Worker Secret with the correct Preview value by uploading
   a second Deno-enabled version, route it at `0%`, and repeat the Version Override
   request. The expected response is HTTP `200` with a valid completion and the
   expected Worker version header.
8. Restore the version captured at the start to `100%` with Wrangler rollback in an
   `always()` cleanup step. Do not use `versions deploy` for cleanup.

The two Preview versions are deliberately separate so the invalid-auth assertion
cannot be satisfied by a stale valid Secret. A workflow-level concurrency group
serializes Preview Deno deployments and prevents two pull requests from mutating
the dedicated Deno app or Worker traffic simultaneously. Fork pull requests run
only the existing secret-free validation job.

## Secret Handling

Authentication values are passed only through GitHub Environment Secrets and
temporary files with mode `0600`. Workflows must not interpolate Secret values into
run commands, write them to repository files, print response bodies, or include
them in contract-test output. Secret files are removed with an EXIT trap. The
invalid-token smoke uses a fixed non-secret sentinel that is never the real Secret.

## Documentation

Update `docs/CONFIGURATION.md`, `docs/deno-tokenizer.md`, and `.env.example` to
document the Production `deno-production` Environment Secret and the separate
Preview `preview` Deno app/Secret inputs. Keep `apps/gateway-worker/wrangler.jsonc`
portable and keep the Production/Preview boundary explicit.

## Testing and Verification

- Test the Production variable validator for missing values, non-HTTPS endpoints,
  zero or non-numeric limits, and valid values without printing values.
- Test the Preview config helper for DO-only and Deno-enabled modes, including
  rejection of Production endpoint names or authentication values in Preview.
- Assert that Production workflow Secret handling uses the named Environment Secret,
  a temporary secrets file, `versions upload`, and no Secret interpolation.
- Assert that Preview workflow contract tests require the dedicated Deno app,
  separate Preview credentials, invalid-auth `500` verification, valid-auth `200`
  verification, and unconditional rollback.
- Run the existing workspace typecheck, unit tests, shell contract tests, workflow
  YAML validation, Markdown lint, and targeted secret scanning.
- After provisioning, inspect Worker version bindings and Deno health/routing
  results without exposing Secret values.

## Acceptance Criteria

- Production Deno settings are read from Production GitHub Variables, not hardcoded
  in the workflow or `wrangler.jsonc`.
- Production deployment fails before migration when required Variables or the
  protected authentication Secret are missing or invalid.
- Every successful Production Worker deployment includes all three Deno settings
  and the matching Worker authentication Secret.
- Production Deno Deploy receives the matching runtime Secret without logging it.
- Preview smoke tests both the DO-only path and the real Deno path using only
  Preview resources.
- The invalid-auth Preview request cannot pass through the DO fallback unnoticed.
- Preview cleanup restores the pre-existing `100%` Worker version even when smoke
  fails.
- Fork pull requests never receive Preview or Production credentials.
