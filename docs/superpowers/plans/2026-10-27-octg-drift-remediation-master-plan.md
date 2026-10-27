# OCTG Spec–Code Drift Closure — Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close `NEG-001` (current normative SPEC/internal control-plane mismatch) and prevent additional unverified Production release while Issue #121 CPU gates remain unresolved, without claiming Runtime PASS or changing the currently running Production version by this planning activity.

**Architecture:** Split two independently reviewable subprojects. A: code-neutral `SPEC.md` contract synchronization, protected by executable documentation and Worker-route tests. B: **proposed**, Human Owner-approved temporary hold of Deno/Worker Production mutations, consisting of **two separate gates**: (1) current-ref Workflow fail-closed changes and (2) an operator-verified cutover covering historical refs, running/waiting jobs, Environment permissions and credential exposure. **Current-ref tests do not prove repository-wide HOLD activation**. After independently verified cutover, the hold can be replaced only by the separately reviewed Issue #121 Task 9–12 exact bridge/candidate/hardening release flow. Carry Stage 1/Stage 2 validation forward to the existing plan rather than duplicating it.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, Deno Deploy, GitHub Actions, Node.js >=22, `node:test`, Vitest, Wrangler.

**Spec:** `SPEC.md`; `docs/superpowers/specs/2026-10-05-worker-free-cpu-headroom-redesign.md`; the existing `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md` (Tasks 6/9–12). Snapshot `master@0ac76d5727018ee47e01935022d59581039a87d2`.

## Global Constraints

- No code, CI, GitHub, Cloudflare, Deno or Production mutation has occurred during creation of these plans.
- No Human Owner approval is implied. The temporary production HOLD is an option awaiting explicit adoption; it affects both Deno and Worker ongoing deploys and requires an urgent-maintenance policy.
- `HOLD_CODE_PRESENT` means only that new Workflow definitions reject Production mutation. `HOLD_ACTIVE` additionally requires approved cutover, quiesced/controlled preexisting and approval-waiting jobs, historical-ref dispatch/reuse closure, effective `deno-production` Environment branch restrictions and Production credential reachability verification. If any path cannot be controlled or observed, use `HOLD_CUTOVER_BLOCKED / HOLD_ACTIVE_NOT_PROVEN`.
- The current PR creates plans only; no deployment prevention is active by virtue of merging plans, and historical Workflow/SHA reachability cannot be proven from current-master static tests.
- `QuotaController` remains quota authority; preserve fail-closed semantics, credentials, isolation and unchanged public Chat/Responses contracts.
- CPU PASS requires each mandatory stateless series to satisfy `p99 <= 5 ms`, `max <= 7 ms`, `exceededCpu = 0`, >=500 successes and complete platform telemetry. Local tests/CI/merge are not sufficient.
- Existing Stage 2 order is mandatory: Stage 1 -> conditional lifecycle DO -> DO compatibility bridge 100% -> candidate 0% -> preflight cleanup -> Stage 2 -> exact candidate 100% acceptance -> distinct hardening version.

## Review Focus

1. An inactive or invalid CPU-gate control secret must not expose CPU control routes or touch Durable Objects.
2. The closed Deno Relay v1 callback contract must remain distinct from CPU-gate control-plane GET/POST operations.
3. Current-ref master-push, labeled PR, dispatch and reusable calls must fail closed in Workflow contract tests; separate cutover evidence must cover historical refs, pending approvals, in-flight jobs and Production credential reachability.
4. Disabling production deploy must not silently advance a new Deno revision while leaving a mismatched Worker; if an in-flight job cannot be drained or contained, `HOLD_ACTIVE` is unproven.
5. The **future** HOLD lift must be tested in Issue #121 Tasks 9/10/11 with immutable source/version, Stage 1 evidence, DO manifest equality, 100% bridge / 0% candidate and terminal/idle preflight; Task 12 still requires separate Human Owner authorization and actual Stage 2 evidence. Current interim tests prove only unconditional HOLD.

## Task order (details in the linked implementation plans)

- [ ] **A1 — Normative contract synchronization:** write RED tests in `scripts/documentation-contract.test.mjs`, reconcile `SPEC.md` §19 with the eight protected CPU-gate control routes and internal `X-OCTG-Worker-Version`, rerun tests, commit.
- [ ] **A2 — Entrypoint regression coverage:** ensure `SELF.fetch` tests prove 404/401 guard order, method restrictions, version identity scope, no public header drift; add only missing tests and avoid speculative runtime fixes.
- [ ] **A3 — Independent documentation review:** run repo validation, map SPEC→Worker→QuotaController→tests, submit `NEG-001` for evidence-based review closure; do not close Issue #121.
- [ ] **B0 — Human Owner decision and cutover contract:** approve the operational hold and emergency/rollback policy; enumerate running, queued, pending and Environment-approval-waiting jobs; inventory dispatchable historical refs, old reusable callers, `deno-production` branch restrictions, credential scopes and authorized stop/drain controls. No cancellation or setting changes without separate owner authorization.
- [ ] **B1 — Producer workflow HOLD:** TDD reject current-ref master/PR-label/dispatch Production jobs while keeping validation; commit. This yields `HOLD_CODE_PRESENT`, **not** `HOLD_ACTIVE`.
- [ ] **B2 — Reusable workflow defense:** TDD reject current-ref reusable calls before D1/Worker mutation; commit. Historical SHA/ref callers require the B0 operational cutover independently.
- [ ] **B3 — Runbook, cutover verification and R1:** document the unproven/active distinction, authorized drain or containment, emergency handling and handoff. Independently review workflow contracts **and** complete old-ref/Environment/credential cutover checks. Declare `HOLD_ACTIVE` only on affirmative operator evidence; otherwise remain `HOLD_CUTOVER_BLOCKED / HOLD_ACTIVE_NOT_PROVEN`.
- [ ] **Deferred HOLD lift (Issue #121 Tasks 9–12 only):** Task 9 manifest tests; Task 10 executable release-path denial/eligibility tests; Task 11 locked-SHA and Stage 1 evidence binding/retest; Task 12 separately authorized remote Stage 2, rollout and hardening. Do not claim this is tested by B1–B3.
- [ ] **Existing Issue #121 follow-through:** after the reviewed fix, perform the *existing* Task 6 Stage 1, conditional Tasks 7/8, Task 9 compatibility manifest, Task 10 staged release implementation, Task 11 source lock, and operator-authorized Task 12. No remote work is authorized by this plan.

## Completion boundary

A and B are separate pull requests/review gates; they may be reviewed independently. A completed A only establishes the normative contract has been synchronized at a fixed HEAD. Completed B establishes only `HOLD_CODE_PRESENT` until a **separate operator cutover audit** demonstrates no uncontained in-flight, pending, historical-ref dispatch/reusable, Environment or credential route remains; only then may the owner record `HOLD_ACTIVE`. If verification is unavailable, status remains `HOLD_CUTOVER_BLOCKED / HOLD_ACTIVE_NOT_PROVEN`, regardless of CI/merge. Issue #121 stays OPEN until independently proven runtime attribution, per-series gate evidence, exact deployment and hardening acceptance are complete. Deactivating B's HOLD is a **future, separate** Task 9–12 workstream: executable denial/acceptance tests must first bind the exact staged rollout to source SHA, manifests and Stage 1 evidence, followed by a fresh owner decision and real Stage 2 validation.

## Execution method

**Recommended:** Superpowers subagent-driven development, with fresh independent R1 reviewer per subproject and a final cross-workflow security review. There is no implementation authorization merely from the presence of these plan files.
