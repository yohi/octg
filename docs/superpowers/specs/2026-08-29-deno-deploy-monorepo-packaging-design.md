# Deno Deploy Monorepo Packaging Design

## Context

The previous production deploy workflow validated `apps/deno-tokenizer` from its own
directory and then runs `deno deploy` from that directory. Deno Deploy CLI
collects files below the deploy root, but the tokenizer imports
`packages/shared/src` through `../../packages/shared/src/index.ts`.

Run `33248718284` proved the boundary failure: Deno 2.9.5 reached Deno Deploy,
created revision `wjz57t1v8bvt`, and received `REVISION_FAILED`. Local
`deno run -A jsr:@deno/deploy@0.0.9904 --debug` showed that the app-root deployment contained only the
12 files below `apps/deno-tokenizer`; no `packages/shared` file was uploaded.

## Goals

- Include the tokenizer source and its shared source dependency in the local
  deployment manifest.
- Keep `packages/shared` as the single source of shared quota/tokenization
  arithmetic instead of duplicating it inside the tokenizer app.
- Keep PR validation and production deployment gated as they are today.
- Make the packaging boundary testable without a production credential.

## Non-goals

- Do not publish `@octg/shared` as a separate registry package.
- Do not change tokenizer runtime behavior, secrets, or the Cloudflare Worker
  workflows.
- Do not retry the production deployment as part of local verification.

## Design

Add a repository-root `deno.json` containing a Deno Deploy source
configuration. Its `deploy.include` list will include the root configuration,
the tokenizer app source (`./apps/deno-tokenizer/src/**`), and `packages/shared/src`.
Its dynamic runtime entrypoint will be `./apps/deno-tokenizer/src/main.ts`.

Deno CLI requires `deploy.org` whenever a `deploy` object is present. The
checked-in root config will therefore omit deployment identity so the template
does not hard-code one account. The production job will first copy the root config
into the staging directory, then inject the non-secret `DENO_DEPLOY_ORG` and
`DENO_DEPLOY_APP` values into that staging copy. The access token will never be
written to the file and is scoped only to the Deploy and conditional Classify failed
revision steps, rather than the whole job.

Keep the existing validation commands in `apps/deno-tokenizer`, where the app's
tasks and tests run unchanged. The root `deno.json` owns the import map used by
root-based deployment and maps `@octg/shared` and the required `tiktoken`
specifiers relative to the repository root. Prepare a dedicated staging directory
(`<repo>/.deno-deploy-source`) that copies the included paths and the materialized
root `deno.json`, then run `deno run -A jsr:@deno/deploy@0.0.9904` from that staging directory so the CLI collector
can see every included path while keeping the workspace root unmodified. Materialize the
deployment identity and resolve the `tiktoken` WASM file into the staging copy before the deploy
step. The app's `deno.json` remains at the app root for app-local validation, but it is not included
in the deploy manifest or relied upon for root-based deployment dependency resolution.

The workflow contract test will require the staging deploy working directory
(`${{ github.workspace }}/.deno-deploy-source`), the identity materialization step, and will parse `deno.json` to require the three packaging paths and the dynamic entrypoint. This prevents a future change from
silently restoring an app-only manifest or hard-coding deployment identity.

## Verification

- The contract test must fail before the workflow/configuration change because
  the current deploy step runs from `apps/deno-tokenizer` and root `deno.json`
  does not exist.
- The contract test must pass after the change.
- `deno run -A jsr:@deno/deploy@0.0.9904 --debug` with a deliberately invalid token must show both the
  tokenizer and `packages/shared/src` files in its collected manifest without
  exposing any real credential.
- Existing Deno typecheck/tests, repository tests, typecheck, ShellCheck, and
  actionlint must remain green.
- A real production deploy is performed only by the gated workflow after the
  fix is reviewed and merged.
