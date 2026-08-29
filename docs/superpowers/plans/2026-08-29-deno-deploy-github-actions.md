# Deno Deploy GitHub Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a gated GitHub Actions workflow that validates and deploys the Deno tokenizer to its configured Deno Deploy production project.

**Architecture:** Keep Deno deployment in a dedicated workflow. Pull requests run Deno checks only; pushes to `master` run the same checks and then use `denoland/deployctl@v1` with GitHub OIDC to deploy the monorepo entrypoint. Runtime secrets remain in Deno Deploy and are not exposed to Actions.

**Tech Stack:** GitHub Actions, Deno 2.x, `denoland/setup-deno@v2`, `denoland/deployctl@v1`, Deno Deploy GitHub Actions deployment mode.

## Global Constraints

- Production and Preview control planes must remain separate.
- `OCTG_TOKENIZER_AUTH_TOKEN` must not be committed or passed through workflow logs.
- The Deno app imports `packages/shared/src` through `apps/deno-tokenizer/deno.json`.
- Existing Cloudflare Worker workflows must remain unchanged.
- Deploy only after `deno task check` and `deno task test` succeed.

---

### Task 1: Add the Deno Deploy workflow

**Files:**
- Create: `.github/workflows/deploy-deno-tokenizer.yml`

**Interfaces:**
- Consumes: GitHub Environment `deno-production`, with non-secret variable `DENO_DEPLOY_PROJECT`.
- Produces: PR validation and `master` push deployment for `apps/deno-tokenizer/src/main.ts`.

- [ ] **Step 1: Write the workflow**

Create a workflow with `pull_request` validation and `push` deployment triggers, limited to `apps/deno-tokenizer/**`, `packages/shared/**`, and the workflow file. Use `denoland/setup-deno@v2` pinned to `v2.x`, run `deno task check` and `deno task test` from `apps/deno-tokenizer`, and make the deployment job depend on validation. Give the deployment job `id-token: write`, `contents: read`, and `environment: deno-production`. Fail before the action when `DENO_DEPLOY_PROJECT` is empty. Configure `denoland/deployctl@v1` with repository root `.`, entrypoint `apps/deno-tokenizer/src/main.ts`, and include paths for `apps/deno-tokenizer` and `packages/shared/src`.

- [ ] **Step 2: Run the repository checks**

Run: `deno task check` and `deno task test` from `apps/deno-tokenizer`.

Expected: Both commands pass without requiring any deployment credential.

### Task 2: Document required GitHub configuration

**Files:**
- Modify: `docs/deno-tokenizer.md:34-56`
- Modify: `README.md` CI/CD section

**Interfaces:**
- Consumes: `.github/workflows/deploy-deno-tokenizer.yml`.
- Produces: Setup instructions for the `deno-production` Environment and `DENO_DEPLOY_PROJECT` variable.

- [ ] **Step 1: Document environment provisioning**

Document that the Deno Deploy project must be linked to the repository in GitHub Actions deployment mode, that the GitHub Environment `deno-production` needs the `DENO_DEPLOY_PROJECT` variable, and that the Deno Deploy runtime Secret remains configured in Deno Deploy. State that PRs validate only and `master` pushes deploy after checks.

- [ ] **Step 2: Verify documentation references**

Run: `grep -n "deploy-deno-tokenizer\|DENO_DEPLOY_PROJECT\|deno-production" README.md docs/deno-tokenizer.md .github/workflows/deploy-deno-tokenizer.yml`.

Expected: All required setup names appear in the workflow documentation.
