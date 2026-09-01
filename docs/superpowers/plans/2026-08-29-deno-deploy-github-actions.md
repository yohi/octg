# Deno Deploy GitHub Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a gated GitHub Actions workflow that validates and deploys the Deno tokenizer to its configured Deno Deploy production project.

**Architecture:** Keep Deno deployment in a dedicated workflow. Ordinary pull requests and fork pull requests run Deno checks only; pushes to `master`, manual `workflow_dispatch` runs, and same-repository pull requests labeled `deploy-deno` run the same checks and then use the pinned `@deno/deploy` CLI implementation with a GitHub Environment access token. Runtime secrets remain in Deno Deploy and are not exposed to Actions.

**Tech Stack:** GitHub Actions, Deno 2.x, `denoland/setup-deno@v2`, `jsr:@deno/deploy@0.0.9904`, Deno Deploy current platform.

## Global Constraints

- Production and Preview control planes must remain separate.
- `OCTG_TOKENIZER_AUTH_TOKEN` and `DENO_DEPLOY_TOKEN` must not be committed or passed through workflow logs.
- The Deno app imports `packages/shared/src` through `apps/deno-tokenizer/deno.json`.
- Existing Cloudflare Worker workflows must remain unchanged.
- Deploy only after `deno task check` and `deno task test` succeed.

---

### Task 1: Add the Deno Deploy workflow

**Files:**
- Create: `.github/workflows/deploy-deno-tokenizer.yml`

**Interfaces:**
- Consumes: GitHub Environment `deno-production`, with variables `DENO_DEPLOY_ORG` / `DENO_DEPLOY_APP` and Secret `DENO_DEPLOY_TOKEN`.
- Produces: pull request validation and gated deployment for `master` pushes, manual `workflow_dispatch` runs, and same-repository pull requests labeled `deploy-deno`, targeting `apps/deno-tokenizer/src/main.ts`.

- [ ] **Step 1: Write the workflow**

Create a workflow with `pull_request`, `push`, and `workflow_dispatch` triggers, limited to `apps/deno-tokenizer/**`, `packages/shared/**`, and the workflow file. Run validation for ordinary and fork pull requests only; a same-repository pull request may deploy after a `deploy-deno` label event, and a manual `workflow_dispatch` run may deploy from its selected ref. Use `denoland/setup-deno@v2` pinned to `v2.9.6`, which includes the Deno Deploy workspace-member include fix and deploy CLI cache refresh, run `deno install --node-modules-dir=auto`, `deno task check`, and `deno task test` from `apps/deno-tokenizer`, and make the deployment job depend on validation. Give the deployment job `contents: read`, `environment: deno-production`, and serialized production concurrency. Fail before the CLI when `DENO_DEPLOY_ORG`, `DENO_DEPLOY_APP`, or `DENO_DEPLOY_TOKEN` is empty. Run `deno run -A jsr:@deno/deploy@0.0.9904 --prod --json --non-interactive` from the repository root because the Deno 2.9.6 wrapper duplicates passthrough arguments; the CLI implementation reads the organization and application from the prepared root manifest and environment variables.

- [ ] **Step 2: Run the repository checks**

Run: `deno install --node-modules-dir=auto`, `deno task check`, and `deno task test` from `apps/deno-tokenizer`.

Expected: Both commands pass without requiring any deployment credential.

### Task 2: Document required GitHub configuration

**Files:**
- Modify: `docs/deno-tokenizer.md:34-56`
- Modify: `README.md` CI/CD section

**Interfaces:**
- Consumes: `.github/workflows/deploy-deno-tokenizer.yml`.
- Produces: Setup instructions for the `deno-production` Environment variables and `DENO_DEPLOY_TOKEN` Secret.

- [ ] **Step 1: Document environment provisioning**

Document that the current Deno Deploy app must exist, that the GitHub Environment `deno-production` needs `DENO_DEPLOY_ORG` / `DENO_DEPLOY_APP` variables and `DENO_DEPLOY_TOKEN` Secret, and that `OCTG_TOKENIZER_AUTH_TOKEN` remains configured in Deno Deploy. State that ordinary and fork PRs validate only; a same-repository PR with the `deploy-deno` label and a manual `workflow_dispatch` run may deploy after validation and `deno-production` approval; `master` pushes deploy after checks.

- [ ] **Step 2: Verify documentation references**

Run: `grep -n "deploy-deno-tokenizer\|DENO_DEPLOY_APP\|DENO_DEPLOY_TOKEN\|deno-production" README.md docs/deno-tokenizer.md .github/workflows/deploy-deno-tokenizer.yml`.

Expected: All required setup names appear in the workflow documentation.
