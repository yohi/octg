# OCTG Production CPU-Gate Release Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a new unrehearsed OCTG Worker/Deno production mutation via the existing automatic master-push workflow while Issue #121's Stage 1/Stage 2 rollout prerequisites are not independently satisfied, then hand off to the already approved staged rollout plan.

**Architecture:** Adopt a narrowly scoped, explicit temporary **HOLD** for both Deno and Worker remote production mutations from automatic master-push, PR-label and ad hoc dispatch paths; preserve offline validation, Preview-only isolation, and existing production traffic. Do not build a parallel/shortcut deployment mechanism. When the approved Task 9–12 machinery is implemented and independently reviewed, remove the temporary hold only in the same reviewed change that wires the version/manifest/evidence gates into the production deployment path.

**Tech Stack:** GitHub Actions YAML, Node.js >=22 `node:test`, shell contract tests, Wrangler 4.x (verification of CLI construction only; no remote execution in this plan).

**Spec:** `docs/superpowers/specs/2026-10-05-worker-free-cpu-headroom-redesign.md` §§CPU gate, Stage 1, Stage 2/bridge and completion; `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md` Tasks 9, 10, 11, 12. **Fixed audit baseline:** `0ac76d5727018ee47e01935022d59581039a87d2` (2026-10-27 JST). This is an interim safety delta, not a replacement for the existing Task 9–12 implementation plan.

## Global Constraints

- **HUMAN OWNER DECISION GATE:** Before implementing this temporary hold, approve its operational trade-off: while in force, normal master-push *production deployments of both Deno and Worker stop*. CI validation and separate Preview paths remain. No model may infer this approval from the existence of this plan.
- Do not alter or roll back the currently deployed `octg-gateway` version as part of the local plan. The audited successful run's version ID is `85c82b1b-ef44-4dfd-9a1b-d465c975dbff`; verify current Production version afresh before any future operator action.
- Cloudflare Worker Free target is 10 ms; all required stateless series: `p99 <= 5 ms`, `max <= 7 ms`, `exceededCpu = 0`, >=500 successes each, full platform telemetry. CI tests are not CPU-gate proof.
- Existing auth, Cloudflare/Deno secrets, quota decision semantics, D1 separation, lifecycle rollback and Production/Preview isolation must remain unchanged.
- Do not create a `workflow_dispatch` or Boolean environment variable that bypasses the hold or promotes the candidate to 100% without the approved Stage 2 chain and external/operator authorization.
- A GitHub environment approval alone does not prove Stage 1/2, immutable source/version matching, DO compatibility or canonical fixture terminalization. Do not accept an untrusted PR artifact/branch variable as the sole evidence authority.
- Stop on ambiguous Production identity, origin/baseline SHA, incomplete telemetry, unresolved fixtures, missing CPU-gate-slot idle proof, or Worker/DO version skew not covered by the exact manifest.
- All code/CI edits, commits, PRs and remote operations require their own permissions. This plan's creation grants **none**.

## Review Focus

1. Master push after merge must validate but never mutate Deno production secrets/code or Worker/D1 when HOLD is enabled. Test owner: Task 1.
2. PR `deploy-deno` label and `workflow_dispatch` must not mutate Production during HOLD. Test owner: Task 1.
3. The reusable production workflow must reject accidental/direct invocation **before D1/Worker mutation**; tests must cover the route other than the normal caller. Test owner: Task 2.
4. Removal of HOLD without exact Task 9/10/11 evidence must fail a new regression test; GitHub environment approval or CI SUCCESS alone must not release it. Test owner: Task 3.
5. Stage 2 must not be mistaken for a conventional one-step `wrangler deploy`; bridge 100%, candidate 0%, canonical cleanup, exact candidate/hardening version ordering remain mandatory. Test owner: Task 3 / existing Task 10.

---

## File and Interface Map

| File | Role |
| --- | --- |
| `.github/workflows/deploy-deno-tokenizer.yml` | Retain validation; stop production `deploy` and `deploy-production` remote jobs at job-level while HOLD is active |
| `.github/workflows/deploy-production.yml` | Defense-in-depth first-step stop before D1 migrations / Worker upload while interim HOLD exists |
| `scripts/deploy-production-workflow.test.mjs` | Exact no-remote-on-master/dispatch/reusable-path contract assertions |
| `scripts/deno-deploy-workflow.test.sh` | Preserve Deno validation and ensure no unintended release trigger |
| `docs/operations.md`, `docs/deployment.md` | Explicit temporary HOLD scope, known deployed baseline, owner-approved release/rollback handoff |
| `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md` | Existing canonical Stage 1/Stage 2 execution plan; do not modify contract or bypass gates |

### Task 0: Obtain the operational HOLD decision (no code changes)

**Files:** No runtime or CI edits. Decision record is a review artifact external to the repo unless explicitly approved for commit.

**Interfaces:** Consumes Issue #121 acceptance status, actual Cloudflare/Deno Production identity, last successful deployment and Human Owner's operational policy. Produces decision `TEMPORARY_PRODUCTION_DEPLOY_HOLD_APPROVED | NOT_APPROVED` scoped to both providers and all current workflow triggers.

- [ ] **Step 1:** Independently read the current Issue #121 status, master HEAD, Actions workflow graph, release state and Cloudflare/Deno Production state using authorized read-only access. Record whether the active deployment differs from `85c82b1b-ef44-4dfd-9a1b-d465c975dbff` and the paired Deno revision; do not assume the audited version remains current.
- [ ] **Step 2:** Human Owner explicitly chooses the temporary hold vs a separately approved non-blocking maintenance policy; record its scope, effective time, rollback/escalation procedure, and how urgent fixes will be processed. **STOP** if unapproved; no implementation task is authorized.
- [ ] **Step 3:** Record `Stage 1 = NOT VERIFIED`, `Stage 2 = NOT VERIFIED` unless current immutable evidence independently proves otherwise. CI SUCCESS, merge and green unit tests never upgrade these statuses.

### Task 1: TDD the producer-workflow release HOLD

**Files:** Modify `.github/workflows/deploy-deno-tokenizer.yml`, `scripts/deploy-production-workflow.test.mjs`, `scripts/deno-deploy-workflow.test.sh`.

**Interfaces:** Consumes Task 0 owner decision. Produces a validation-only workflow for master push, PR and dispatch while HOLD is active. Use the existing `validate` job unchanged and make `deploy` and `deploy-production` jobs unreachable for every trigger; a deliberate job-level `if: false` is acceptable for the **temporary** hold, with a conspicuous TODO referring to Task 10, but not a long-term release architecture.

- [ ] **Step 1: Write RED contract tests.** In `scripts/deploy-production-workflow.test.mjs`, replace the prior assertion that every master push must deploy Production with assertions that both `deploy` and `deploy-production` are denied for `push`, `pull_request` label and `workflow_dispatch` during HOLD; Deno validation must still run. In `scripts/deno-deploy-workflow.test.sh`, replace any test that incorrectly treats automatic Production mutation as current policy. Assert both jobs' `if` expressions are an unconditional deny until reviewed staging replaces them (not an easily controlled Boolean variable).
- [ ] **Step 2: Verify RED.** Run `node --test scripts/deploy-production-workflow.test.mjs && bash scripts/deno-deploy-workflow.test.sh`. Expected: current automatic deploy job expression violates HOLD test; do not reinterpret that expected failure as a production incident.
- [ ] **Step 3: Implement the minimum HOLD.** Change only the `deploy` and `deploy-production` **job-level** conditions to fail closed across all events. Preserve the `validate` job, PR scope, dependency graph, secret handling, deployment source revision checks and concurrency contracts. Do not remove the existing deployment recipes—they remain referenced by the future Stage 2 replacement.
- [ ] **Step 4: Verify GREEN.** Run the two commands from Step 2 and `npm run test:deno-deploy-workflow`. Expected: validation workflow regressions pass and no master/PR/dispatch path reaches remote Deno mutation. Review the YAML semantics, not just grepped strings.
- [ ] **Step 5: Commit boundary (execution-time only).** `git add .github/workflows/deploy-deno-tokenizer.yml scripts/deploy-production-workflow.test.mjs scripts/deno-deploy-workflow.test.sh && git commit -m "ci: hold automatic production mutations pending relay cpu gates"`.

### Task 2: Guard the reusable production Worker workflow directly

**Files:** Modify `.github/workflows/deploy-production.yml` and `scripts/deploy-production-workflow.test.mjs`.

**Interfaces:** Consumes Task 1; produces an early hard-stop that prevents any alternate `workflow_call` invoker from reaching D1/Worker mutations before Stage 2 replacement. Do not add a privileged skip knob.

- [ ] **Step 1: Write RED tests.** Assert a step named `Enforce Issue 121 release HOLD` is the first executable step after checkout (or earlier where platform permits), runs before `Apply D1 migrations` and `Deploy Worker`, unconditionally exits nonzero, and has no environment/argument-driven bypass. Existing master SHA alignment and Deno prerequisite validation remain present for the later reviewed release path.
- [ ] **Step 2: Verify RED.** Run `node --test scripts/deploy-production-workflow.test.mjs`. Expected: new early-stop test fails against current reusable workflow.
- [ ] **Step 3: Add minimal early-stop step.** Add a fixed, clearly labeled failing `run` step; no secret is read or remote command executed first. Do not convert the job to `success()`-dependent skipping that can accidentally skip guard while later steps execute.
- [ ] **Step 4: Verify GREEN.** Run `npm run test:scripts && npm run test:deno-deploy-workflow && git diff --check`. Expected: every regression passes and no alternative existing invoker can reach the production mutation steps in this workflow.
- [ ] **Step 5: Commit boundary (execution-time only).** `git add .github/workflows/deploy-production.yml scripts/deploy-production-workflow.test.mjs && git commit -m "ci: fail closed direct production worker workflow calls"`.

### Task 3: Document the recovery-to-staged-rollout handoff and require an independent review

**Files:** Modify `docs/operations.md`, `docs/deployment.md`, `scripts/documentation-contract.test.mjs`. Do not create new candidate deploy scripts in this delta.

**Interfaces:** Consumes Tasks 1–2. Produces an owner handoff mapping HOLD release to existing implementation plan Tasks 9/10/11/12 and Stage 1 Task 6.

- [ ] **Step 1: Write RED runbook assertions.** Add `node:test` case `production runbook differentiates temporary HOLD from Stage 2 authorization` to `scripts/documentation-contract.test.mjs`. Require named scope for Deno `env load`, Deno code deploy, Worker D1 migrations and `wrangler deploy`; separately require language that existing traffic is not rolled back, Stage 1 and Stage 2 remain unverified, and Task 10/12 owner authorization is independent. Run `node --test scripts/documentation-contract.test.mjs`; expected RED because the runbook lacks this HOLD section.
- [ ] **Step 2:** Document what HOLD stops (Deno `env load` and code deployment; Worker D1 migrations and `wrangler deploy`) and what it does **not** stop (existing Production traffic, offline checks, authorized isolated Preview tests). Explicitly flag the separate urgent-service-patch/rollback decision; *do not* instruct an unverified `wrangler deploy` of newest master as a safe emergency workaround.
- [ ] **Step 3:** List exact release unblocking prerequisites: owner adoption; completed Task 6 Stage 1 evidence at locked SHA; conditional Task 7/8 if lifecycle FAIL; Task 9 DO compatibility manifest equality; Task 10 bridge 100% / exact candidate 0% / preflight terminal & slot idle; Task 11 locked source, full local tests and refreshed Stage 1; authorized Task 12 Stage 2 each series 5/7/0 plus 500 and completeness; candidate rollout acceptance; distinct hardening version/secret teardown. A later code change invalidates old evidence as specified in the existing plan.
- [ ] **Step 4: Verify GREEN.** Run `node --test scripts/documentation-contract.test.mjs`, `npm run typecheck`, `npm test`, `npm run test:preview-workflow`, `npm run test:deno-deploy-workflow`, `git diff --check`. Expected: zero local errors; never claim Cloudflare Stage 1/2 PASS from these commands.
- [ ] **Step 5:** Submit separate independent workflow/security review of every Production-mutation entrypoint and any undocumented manual deploy channel. Human Owner decides whether to merge/activate HOLD; separate operator authorization is still required for any remote restoration/release.
- [ ] **Step 6: Commit boundary (execution-time only).** Commit documentation and related tests; record fresh immutable source SHA and the externally maintained Production version snapshot.

## Stage 2 Handoff — Existing Plan, Not Duplicated Here

This temporary HOLD is **not a replacement** for the approved `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md`. After the hold and its review, continue that plan's Task 6 (authorized Stage 1), conditional Tasks 7–8 only on lifecycle CPU failure, Task 9 (manifest), Task 10 (exact Production version config and rollout-safe workflow), Task 11 (source lock/retesting) and Task 12 (authorized Production canary/candidate/hardening). Removing HOLD is a **separate reviewed release-engineering change**, performed only once the actual staged guard is executable and evidence is valid. No new task may convert a 100% direct `wrangler deploy` into the claimed Stage 2 acceptance gate.

## Self-Review / Completion Conditions

- Every known entrypoint in `.github/workflows/deploy-deno-tokenizer.yml` and `.github/workflows/deploy-production.yml` is either offline validation or explicitly blocked from Production mutation during HOLD; tests cover master push, labeled PR, dispatch and reuse.
- No unapproved Production write, secret mutation, rollout, rollback or canary is performed by this implementation-plan drafting activity.
- Owner adoption and separate runtime attestation are required; the plan is not a gate grant.
- Expected final state before Task 9–12: `TEMPORARY_DEPLOY_HOLD_ACTIVE / CURRENT_PRODUCTION_UNCHANGED / STAGE1_AND_STAGE2_NOT_PROVEN` (this is a **target state**, not a present fact).
