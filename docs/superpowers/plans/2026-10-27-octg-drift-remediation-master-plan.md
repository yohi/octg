# OCTG Spec–Code Drift Closure — Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close `NEG-001` (current normative SPEC/internal control-plane mismatch) and prevent additional unverified Production release while Issue #121 CPU gates remain unresolved, without claiming Runtime PASS or changing the currently running Production version by this planning activity.

**Architecture:** Split two independently reviewable subprojects. A: code-neutral `SPEC.md` contract synchronization, protected by executable documentation and Worker-route tests. B: **proposed**, Human Owner-approved temporary hold of all existing Deno/Worker Production mutation entrypoints, replaced only by the separately reviewed Issue #121 Task 9–12 exact bridge/candidate/hardening release flow. Carry Stage 1/Stage 2 validation forward to the existing approved plan rather than duplicating it.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, Deno Deploy, GitHub Actions, Node.js >=22, `node:test`, Vitest, Wrangler.

**Spec:** `SPEC.md`; `docs/superpowers/specs/2026-10-05-worker-free-cpu-headroom-redesign.md`; the existing `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md` (Tasks 6/9–12). Snapshot `master@0ac76d5727018ee47e01935022d59581039a87d2`.

## Global Constraints

- No code, CI, GitHub, Cloudflare, Deno or Production mutation has occurred during creation of these plans.
- No Human Owner approval is implied. The temporary production HOLD is an option awaiting explicit adoption; it affects both Deno and Worker ongoing deploys and requires an urgent-maintenance policy.
- `QuotaController` remains quota authority; preserve fail-closed semantics, credentials, isolation and unchanged public Chat/Responses contracts.
- CPU PASS requires each mandatory stateless series to satisfy `p99 <= 5 ms`, `max <= 7 ms`, `exceededCpu = 0`, >=500 successes and complete platform telemetry. Local tests/CI/merge are not sufficient.
- Existing Stage 2 order is mandatory: Stage 1 -> conditional lifecycle DO -> DO compatibility bridge 100% -> candidate 0% -> preflight cleanup -> Stage 2 -> exact candidate 100% acceptance -> distinct hardening version.

## Review Focus

1. An inactive or invalid CPU-gate control secret must not expose CPU control routes or touch Durable Objects.
2. The closed Deno Relay v1 callback contract must remain distinct from CPU-gate control-plane GET/POST operations.
3. No existing master-push, labeled PR, workflow dispatch or reusable workflow call may mutate either Production runtime while an approved temporary HOLD is in effect.
4. Disabling production deploy must not silently advance a new Deno revision while leaving a mismatched Worker.
5. Removing the temporary HOLD must never silently bypass Stage 2 immutable source/version/DO compatibility and fixture cleanup gates.

## Task order (details in the linked implementation plans)

- [ ] **A1 — Normative contract synchronization:** write RED tests in `scripts/documentation-contract.test.mjs`, reconcile `SPEC.md` §19 with the eight protected CPU-gate control routes and internal `X-OCTG-Worker-Version`, rerun tests, commit.
- [ ] **A2 — Entrypoint regression coverage:** ensure `SELF.fetch` tests prove 404/401 guard order, method restrictions, version identity scope, no public header drift; add only missing tests and avoid speculative runtime fixes.
- [ ] **A3 — Independent documentation review:** run repo validation, map SPEC→Worker→QuotaController→tests, submit `NEG-001` for evidence-based review closure; do not close Issue #121.
- [ ] **B0 — Human Owner release decision:** independently confirm current Production baseline and choose whether to accept a temporary full Production deployment hold (Deno + Worker) and its urgent-fix tradeoff. Stop B1–B3 if not approved.
- [ ] **B1 — Producer workflow HOLD:** TDD update master/PR/dispatch contracts; block remote Deno deploy and downstream Worker job while preserving validation; commit.
- [ ] **B2 — Reusable workflow defense:** test and add an unconditional early stop before D1/Worker production mutation; commit.
- [ ] **B3 — Runbook and R1:** TDD runbook assertions, document HOLD scope and safe handoff, run whole repo verification, independent workflow/security review; commit if approved.
- [ ] **Existing Issue #121 follow-through:** after the reviewed fix, perform the *existing* Task 6 Stage 1, conditional Tasks 7/8, Task 9 compatibility manifest, Task 10 staged release implementation, Task 11 source lock, and operator-authorized Task 12. No remote work is authorized by this plan.

## Completion boundary

A and B are separate pull requests/review gates; they may be reviewed independently. A completed A only establishes the normative contract has been synchronized at a fixed HEAD. Completed B only establishes the adopted, tested temporary production release HOLD. Issue #121 stays OPEN until independently proven runtime attribution, per-series gate evidence, exact deployment and hardening acceptance are complete. Deactivating B's HOLD requires a fresh owner decision and a separately reviewed staged rollout implementation.

## Execution method

**Recommended:** Superpowers subagent-driven development, with fresh independent R1 reviewer per subproject and a final cross-workflow security review. There is no implementation authorization merely from the presence of these plan files.
