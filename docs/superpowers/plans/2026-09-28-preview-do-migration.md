# Preview Durable Object Migration Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current PR branch.

**Goal:** Apply pending Durable Object migrations to the isolated Preview Worker before the version smoke workflow uploads a version.

**Architecture:** Extend the existing Preview workflow contract test to require the migration deployment between D1 migration application and current deployment capture. Add a normal `wrangler deploy` step at that position, using the already-generated isolated Preview config and the existing Preview credentials.

**Tech Stack:** GitHub Actions YAML, Node.js workflow contract tests, Wrangler 4.

## Global Constraints

- Durable Object migration must be applied by a non-versioned deployment before `wrangler versions upload`.
- Use only the isolated Preview Worker configuration and Preview credentials.
- Preserve the existing version smoke, traffic routing, and rollback steps.
- Preserve all unrelated pre-existing working tree changes.

---

### Task 1: Test Preview migration deployment ordering

**Files:**
- Modify: `scripts/preview-workflow.test.mjs` (or the existing Preview workflow contract test file)
- Modify: `.github/workflows/preview-smoke.yml`

**Interfaces:**
- Consumes: Existing workflow-source contract assertions.
- Produces: An assertion that a regular `wrangler deploy` uses `PREVIEW_CONFIG` after D1 migrations and before current deployment capture/version upload.

- [ ] Add the assertion to the existing workflow contract test and run `node --test scripts/preview-workflow.test.mjs` to confirm it fails before the workflow change.
- [ ] Add a `Deploy Preview Worker to apply Durable Object migrations` step after `Apply preview D1 migrations`; invoke `./node_modules/.bin/wrangler deploy --config "$PREVIEW_CONFIG"` with the Preview Cloudflare API token and account ID.
- [ ] Run `npm run test:preview-workflow` and confirm it passes.
- [ ] Run `git diff --check` and inspect the staged file list to exclude existing user changes.

### Task 2: Verify, commit, and push the fix

**Files:**
- Commit: `scripts/preview-workflow.test.mjs` (or the existing Preview workflow contract test file)
- Commit: `.github/workflows/preview-smoke.yml`
- Commit: `docs/superpowers/specs/2026-09-28-preview-do-migration-design.md`
- Commit: `docs/superpowers/plans/2026-09-28-preview-do-migration.md`

- [ ] Run the targeted contract test and `git diff --check`.
- [ ] Commit only the four intended files with a Japanese Conventional Commit message.
- [ ] Push the current PR #114 branch and verify the resulting commit and remote branch.
