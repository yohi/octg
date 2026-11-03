# OCTG Cloud-native Zero-Cost CPU Headroom R0.1.1 — Implementation Continuation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish an enforceable, evidence-backed zero-additional-cost preflight and resume existing Issue #121 Stage 1 safely, without reimplementing merged code or weakening quota, API, CPU, or release safeguards.

**Architecture:** Reuse existing Cloudflare Worker → Deno Relay → Durable Objects paths and Issue #121 Tasks 1–5. Add a pure local Cost/Capacity Preflight evaluator and fail-closed runner entry guard as the smallest missing executable boundary. Then, **only with new Human Owner authorization**, execute existing Task 6; activate existing conditional Tasks 7–8 only on lifecycle CPU FAIL, and reuse Tasks 9–12 without rewriting their plan.

**Tech Stack:** Node.js 22+, ECMAScript modules (`.mjs`), `node:test`, TypeScript 5.6, Cloudflare Workers Free / SQLite-backed Durable Objects, Deno Deploy Free, Wrangler 4.x and the existing OCTG scripts.

**Spec:** `docs/superpowers/specs/2026-11-03-octg-cloud-native-zero-cost-cpu-headroom-design.md` — **R0.1.1** on `feature/octg-cloud-native-zero-cost-cpu-headroom-design-r01`, commit `bcf23252c1b616059bb9f18a83a32582e40bb2c2`, Git blob `2bd9ec5d75a5e1f84fb9d45bb26de85e57b8afdb`.

**Normative implementation plan retained:** `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md` (`master` at `40857b37db1e0a53f20b794daae6e6b45195beef`). This continuation plan supplements its Cost Gate and as-built boundaries; it **does not replace or silently amend** that plan.

**Plan status:** `DOCUMENT_ONLY / PLAN_CANDIDATE / NOT_OWNER_APPROVED_FOR_IMPLEMENTATION`. This document authorizes no source change, test execution, remote telemetry query, Cloudflare/Deno deployment, quota change, CI change, branch push or HOLD release. Recording the plan in GitHub also requires separate authorization.

## Global Constraints

- Project success: Workers Free HTTP CPU ≤10 ms, **every required stateless measurement series** p99 ≤5 ms, max ≤7 ms, `exceededCpu = 0`, ≥500 successful invocations, complete platform telemetry.
- **Zero additional recurring cost**: Workers Free + Deno Deploy Free; no automatic upgrade or supplemental paid platform. Account-specific effective free limits and balances are verified at execution time, not inferred from the design snapshot.
- `QuotaController` is the sole Quota Authority. D1 is not used to authorize admission, settlement or grant lifecycle decisions.
- Maintain `/v1/responses` and `/v1/chat/completions` public compatibility, streaming, idempotency, uncertainty handling, fail-closed logic and Production/Preview separation.
- Retain existing Production HOLD, Option B normative authority and Owner Decisions. `HOLD_CODE_PRESENT` is **not** evidence that remote `HOLD_ACTIVE` is proved.
- Secret material, raw requests/responses, prompts, client keys, HMAC keys, grant credentials and raw telemetry must not be committed or included in cost evidence.
- **Do not rerun the old Plan's Tasks 1–5 as implementation work** merely because their checkboxes remain unchecked. Source is merged, but current runtime acceptance is not proved.
- Existing Stage 1 orchestration expects a full 68-series run, with candidate/secret cleanup; safe pause/resume across quota-reset boundaries and preservation of a single candidate ScriptVersion are **not established**. This plan does not claim day splitting is already safe.
- On missing/late/unverifiable capacity evidence, return `PREFLIGHT_HOLD` **before any upload, deploy, fixture setup or measured request**. Recovery/cleanup of already-live grants must remain available independently of Cost Gate status.
- Completion of local implementation work or documentation does not authorize remote execution. Every later mutation needs explicit scope-bound Human Owner permission.

## Review Focus — high-risk failures and owning tests

1. **Unknown usage billed as zero**: missing or stale meter evidence must HOLD (`relay-cpu-capacity.test.mjs`).
2. **Under-counted gate work**: 34,000 successful measured callbacks must not be treated as the whole Worker/DO/Deno cost budget; all 68 series, 170,000 fivefold attempt envelope, fixture/control operations and safety reserve are represented or HOLD (`relay-cpu-capacity.test.mjs`).
3. **Gate bypass**: `stage1`, `stage2-preflight` and `stage2-series` cannot begin external actions without a passing, in-scope Cost Gate; `recover-operation` is permitted to safely close previously active operations (`relay-cpu-cli` regression tests).
4. **Revision/environment mismatch**: a passing document for another source SHA, environment, account scope or expired usage window cannot authorize a run (`relay-cpu-capacity.test.mjs`, CLI tests).
5. **CPU telemetry failure vs absence of proof**: `exceededCpu` is FAIL even without an app marker, while missing telemetry is `BLOCKED/INCOMPLETE`, not PASS (reuse `relay-cpu-evidence.test.mjs` and old Task 6).

---

## File / responsibility map

| File | Proposed disposition | Responsibility |
| --- | --- | --- |
| `docs/superpowers/specs/2026-11-03-octg-cloud-native-zero-cost-cpu-headroom-design.md` | **Read-only source of truth** | Adopted Cost Gate, thresholds, authority and pending-work crosswalk. |
| `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md` | **Read-only** | Existing 12-task normative implementation/rollout plan. |
| `scripts/relay-cpu-workloads.mjs` | Read-only | `requiredSeriesMatrix()` source of truth; do not duplicate class lists. |
| `scripts/relay-cpu-capacity.mjs` | **Create if implementation separately authorized** | Pure capacity evaluation, input validation, matrix-derived lower/upper requirements. No network I/O. |
| `scripts/relay-cpu-capacity.test.mjs` | **Create if authorized** | Boundary tests including missing data, meter periods, fixtures, reserve and matching SHA. |
| `scripts/relay-cpu-capacity-cli.mjs` | **Create if authorized** | Read an operator-supplied evidence JSON file, emit a sanitized `PREFLIGHT_PASS`/`PREFLIGHT_HOLD` result. No provider access. |
| `scripts/relay-cpu-capacity-cli.test.mjs` | **Create if authorized** | Valid/invalid JSON, predictable exit codes, no secret leakage. |
| `scripts/relay-cpu-cli.mjs` | **Modify if authorized** | Fail-closed `--capacity-evidence=<path>` guard before any Stage 1/2 remote action; preserve `--execute` and recovery paths. |
| `scripts/relay-cpu-stage1.mjs` | Keep existing unless proven necessary | Already provisions Preview candidate, runs gate, safely cleans up. Do not refactor gratuitously. |
| `scripts/relay-cpu-cli`-related tests (`scripts/run-relay-cpu-gate.test.mjs`, `scripts/relay-cpu-stage1.test.mjs`) | Extend if authorized | Verify early rejection before deployment and preservation of recovery behavior. |
| `docs/operations.md` | **Modify only after authorized implementation** | Document capacity inputs, evidence handling, stop conditions, and reference to old Task 6; do not duplicate rollout protocol. |

Only the proposed capacity evaluator, its read-only CLI and CLI entry guard are **new local implementation work**. Other source files already merged by PR #124 are not reimplemented. Conditional DO and Stage 2 code belong to the old Plan's Tasks 7–12, with their separate gates.

## Execution states and dependencies

```text
Owner-approved R0.1.1 (DOCUMENT_ONLY)
    │
    ├─ Task 1: fixed-source as-built verification (READ_ONLY)
    │
    ├─ Task 2: capacity evaluator + offline evidence CLI (LOCAL CODE — not authorized yet)
    │
    ├─ Task 3: fail-closed CPU Runner entry guard (LOCAL CODE — not authorized yet)
    │
    └─ Owner Checkpoint for local implementation/evidence
              │
              ├─ No verified capacity or split-run safety -> HOLD / no remote action
              │
              └─ PREFLIGHT_PASS + explicit remote approval
                          │
                          └─ Original Issue #121 Task 6 / Stage 1
                                  │
                                  ├─ CPU Gate PASS -> Owner chooses next authorized stage
                                  ├─ Lifecycle class FAIL -> conditional old Tasks 7–8,
                                  │                       then full Stage 1 rerun
                                  ├─ Ingress/Decision FAIL -> STOP (no lifecycle DO)
                                  └─ Missing evidence / capacity -> BLOCKED / HOLD
```

**Important:** Task 2/3 are future *implementation* work and not implied by the present `writing-plans` invocation. Running Stage 1 and remote telemetry is a separate Owner decision after local readiness. The implementation team must not treat this diagram as blanket approval.

### Task 1: Lock the existing code / plan identity (READ_ONLY; no source modifications)

**Files:**
- Inspect: `packages/shared/src/relay-credential.ts`, `apps/gateway-worker/src/relay-callback.ts`, `apps/gateway-worker/wrangler.jsonc`.
- Inspect: `scripts/relay-cpu-workloads.mjs`, `scripts/run-relay-cpu-gate.mjs`, `scripts/relay-cpu-stage1.mjs`, `scripts/relay-cpu-evidence.mjs`.
- Inspect: adopted R0.1.1 spec and the existing Issue #121 implementation plan.

**Interfaces:**
- Consumes: fixed `master` SHA `40857b37db1e0a53f20b794daae6e6b45195beef` and adopted spec commit `bcf23252c1b616059bb9f18a83a32582e40bb2c2`.
- Produces: a source identity and source-to-task inventory. No new API or RPC.

- [ ] **Step 1: Verify both immutable refs.** Use `git rev-parse` / `git show` against the exact hashes, without switching Production or starting Actions. Abort if ref identity differs.
- [ ] **Step 2: Confirm existing implementation:** `relayMacKey` cache, CPU Gate RPC/runner/evidence code, 68-row `requiredSeriesMatrix()`; confirm Lifecycle DO class and v4 migration are absent at this baseline. Document observed facts without treating absence of remote results as CPU FAIL.
- [ ] **Step 3: Compare with old plan:** Tasks 1–5 `IMPLEMENTED_IN_CODE`, earlier tests `LOCALLY_VERIFIED` **historically only**; Task 6 `RUNTIME_NOT_VERIFIED`, Tasks 7–8 conditional unimplemented, Tasks 9–11 incomplete, Task 12 HELD. If current checkout differs, stop and reassess source identity rather than rewriting all historical tasks.
- [ ] **Step 4: Check local commands** on the exact selected source tree only when authorized for local execution:
  `npm run typecheck` and `npm test`. Expected 0 exits to claim this checkout's local test PASS. Do not infer remote Stage 1 PASS from these results.

**Task completion / stop:** Produce one accurate as-built source inventory and then stop; no new standalone review, PR or reimplementation sequence.

### Task 2: Make the Cost / Capacity Preflight calculation executable (future LOCAL implementation; needs separate Owner authorization)

**Files:**
- Create: `scripts/relay-cpu-capacity.mjs`
- Create: `scripts/relay-cpu-capacity.test.mjs`
- Create: `scripts/relay-cpu-capacity-cli.mjs`
- Create: `scripts/relay-cpu-capacity-cli.test.mjs`
- Reuse unchanged: `scripts/relay-cpu-workloads.mjs`

**Interfaces:**

```ts
// scripts/relay-cpu-capacity.mjs — ESM exports, JSDoc types or TS-checkable JS
export function requiredCapacityMatrix(): {
  seriesCount: number;             // 68, derived from requiredSeriesMatrix()
  successesPerSeries: number;      // 500
  minimumSuccessfulCalls: number;  // 34_000
  attemptEnvelope: number;         // 170_000, excluding control/fixture/retry
};
export function evaluateCapacityPreflight(
  input: CapacityEvidenceV1, nowUTC: string,
): { status: 'PREFLIGHT_PASS' | 'PREFLIGHT_HOLD'; reasons: string[] };
```

`CapacityEvidenceV1` is a **plain JSON** document (not a provider credential or raw billing export), with:
- `version: 1`, `stage: "stage1" | "stage2"`, `environment: "preview" | "production"`, `sourceRevision` (40 lowercase hex), `workerName` (nonblank), `observedAtUTC`, `expiresAtUTC` (ISO-8601 UTC), `accountScopeRef` (non-secret operator-generated identifier), `budgetMethodRef` (evidence link or protected record ID).
- `matrix: { seriesCount: 68, successesPerSeries: 500, attemptEnvelope: 170000, fullRun: true }`. These values must equal `requiredCapacityMatrix()`. Do not silently accept a smaller matrix.
- `meters`: exactly one evidence row for each applicable billable/limit meter, with `{ id, unit, windowStartUTC, windowEndUTC, limit, consumed, normalForecast, reserve, gateBudget, usageObservedAtUTC, limitSourceUrl, limitVerifiedAtUTC, usageEvidenceRef, normalForecastEvidenceRef, budgetEvidenceRef }`.
- Required metric IDs: `workers.requests.daily`, `do.requests.daily`, `do.duration.gb_s.daily`, `do.storage.bytes.total`, `deno.inbound_requests.monthly`, `deno.active_cpu.seconds.monthly`, `deno.memory.gib_hours.monthly`, `deno.egress.bytes.monthly`, `deno.revision_storage.bytes.total`. **Values and units are proof inputs, not hardcoded account facts**; if provider/account terms differ, set HOLD rather than coercing a meter away. `workers.http_cpu_ms.per_invocation` and 5/7/0 are separate fixed CPU acceptance limits, not a substitute for budget rows.
- A `meter` uses one consistent canonical unit and nonnegative finite numeric values. `consumed` is authoritative usage, `normalForecast` includes other apps, `reserve` protects cleanup/safety, and `gateBudget` includes the proposed *entire non-pausing run* (measured calls, callback/fixture control, internal RPC, retries, telemetry, and associated provider consumption). Unknown estimates must be omitted and cause HOLD; they must never become zero without an explicit zero-increment justification in the evidence record.

- [ ] **Step 1: Write RED tests** named `matrix_has_68_series_34000_minimum_and_170000_attempt_envelope`, `missing_usage_or_fixture_cost_holds`, `stale_or_cross_account_evidence_holds`, `cross_period_budget_holds`, `negative_or_nonfinite_meter_holds`, `reached_free_limit_holds`, `explicit_zero_cost_with_evidence_is_allowed`, and `all_complete_meters_with_L_minus_U_minus_N_minus_R_ge_B_pass`.
- [ ] **Step 2: Run RED:** `node --test scripts/relay-cpu-capacity.test.mjs scripts/relay-cpu-capacity-cli.test.mjs`. Expected: tests fail because evaluator/CLI or required behavior is absent.
- [ ] **Step 3: Implement pure validation.** Compute matrix requirements from `requiredSeriesMatrix()`; require matching revision, account scope and environment; valid ISO timestamps; fresh usage evidence before execution (choose a fixed, documented freshness window of 15 minutes); full required meter coverage; meter windows and reset period consistent with provider/account proof; valid Free plan evidence; and `limit - consumed - normalForecast - reserve >= gateBudget` **for every meter**. `PREFLIGHT_PASS` means only capacity evidence is sufficient; it is neither CPU PASS nor permission to execute.
- [ ] **Step 4: Implement local evidence CLI:** `node scripts/relay-cpu-capacity-cli.mjs --evidence=<protected-json-path> --now=<ISO-UTC>`. Exit `0` on `PREFLIGHT_PASS`, `2` on `PREFLIGHT_HOLD`, `1` on malformed invocation/IO. JSON stdout contains only status and non-sensitive reason codes. Never fetch billing data or upload a report.
- [ ] **Step 5: Run GREEN:** `node --test scripts/relay-cpu-capacity.test.mjs scripts/relay-cpu-capacity-cli.test.mjs`. Expected: 0 failures. Re-run `npm run test:scripts` to detect regressions.
- [ ] **Step 6: Scope-bound commit boundary only if Owner authorizes local implementation and Git writes:** stage the four new script/test files; do not push, start remote execution or alter the old plan automatically.

**Task-specific stop:** A valid meter input cannot be constructed from verified account usage, or the current single-run attempt/fixture budget exceeds capacity ⇒ `PREFLIGHT_HOLD`; do not fabricate usage, trim the required 68 series, or pretend a day-split resume exists.

### Task 3: Enforce Cost Gate before any Stage 1/2 remote action (future LOCAL implementation; needs separate Owner authorization)

**Files:**
- Modify: `scripts/relay-cpu-cli.mjs`
- Test: `scripts/run-relay-cpu-gate.test.mjs`
- Test: `scripts/relay-cpu-stage1.test.mjs`
- Reuse: `scripts/relay-cpu-capacity.mjs`

**Interfaces:**
- CLI option: `--capacity-evidence=<protected-json-path>` for `stage1`, `stage2-preflight`, `stage2-series`.
- `recover-operation` remains available **without a passing new Cost Gate** for safe cleanup/recovery, but requires the existing service authorization and control-plane fences.
- Preserve existing `--execute`, `--source-revision`, `--worker-name`, `--journal`, `--ledger`, `--preview-config`, `--script-version`; do not alter callback RPCs or quota internals.

- [ ] **Step 1: Write RED CLI tests:** `stage1_no_capacity_evidence_makes_zero_remote_calls`, `stage1_expired_or_wrong_sha_holds_before_secret_upload`, `stage2_preflight_and_series_refuse_cross_environment_evidence`, `stage1_preserves_execute_guard`, `recover_operation_remains_possible_with_capacity_hold`, `valid_capacity_evidence_reaches_existing_runner_without_mutating_gate_result`. Use injected `runGate`, `commandImpl` and `fetchImpl` fakes; assert all remote-call counters remain zero on HOLD.
- [ ] **Step 2: Run RED:** `node --test scripts/run-relay-cpu-gate.test.mjs scripts/relay-cpu-stage1.test.mjs`; the new assertions must fail against current CLI.
- [ ] **Step 3: Add one early guard to `executeCpuGateCli(argv, env, io)`** before constructing any remote adapter or calling `runStage1Provisioned()`. Validate capacity evidence against the CLI's stage, source revision, worker name, environment and actual current time. On `PREFLIGHT_HOLD`, emit a sanitized status and exit `2`. This guard **does not replace** the existing authorization controls; `--execute` remains mandatory.
- [ ] **Step 4: Keep cleanup usable.** Do not place the cost guard ahead of recovery operations required to close already active grants. A failed or cancelled run must preserve the existing `runPreviewLifecycle()` teardown, journal and authoritative closure protocol.
- [ ] **Step 5: Run GREEN:** `node --test scripts/run-relay-cpu-gate.test.mjs scripts/relay-cpu-stage1.test.mjs` then `npm test` and `npm run typecheck`. Expected: 0 failures. Test failure means code is not ready; it does not trigger an automatic new review task.
- [ ] **Step 6: Scope-bound commit boundary only if separately authorized:** commit the CLI and tests; do not push/deploy/measure until expressly approved.

**Task-specific stop:** The present Runner has no proven day-boundary pause/resume preserving a single candidate ScriptVersion and authoritative grant closure. If a full run cannot be budgeted on current Free accounts, report `CAPACITY_HOLD / RESUME_NOT_PROVEN` and ask the Owner to choose hold, a separately scoped compatibility-safe batching design, or a different architecture. Do not implement batching automatically.

### Task 4: Prepare actual Stage 1 evidence and operator checkpoint (READ_ONLY preparation; remote steps require separate Owner approval)

**Files:**
- Reference unchanged: `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md`, **Task 6 Steps 1–6**.
- Read-only inputs: official plan/usage evidence, existing protected Preview configuration, source revision, worker bindings and account-scoped permission information.
- Evidence outputs: protected local journal/ledger/telemetry or sanitized aggregate, **never Git-tracked raw records**.

**Interfaces:**
- Consumes: a documented `PREFLIGHT_PASS`, source revision identity, separately authorized Preview + platform telemetry scope, existing Task 6 Runner.
- Produces (only after actual authorized execution): per-series `PASS / FAIL / BLOCKED`, exact source SHA / Worker ScriptVersion / harness identity, quota closure status and terminalization proof.

- [ ] **Step 1: Read-only readiness:** identify actual Preview environment and isolated D1/DO/Relay origin, account-level Free plan and metering evidence, normal workload baseline, fresh Secret **presence** (not values), current remote state, and minimum privileges. `NOT_VERIFIED` is a HOLD, not a presumed PASS.
- [ ] **Step 2: Budget the *exact proposed full Runner workload*:** record `34,000` minimum successes, `170,000` measured-attempt envelope, all fixture/callback/DO operations and Deno traffic (including retries and cleanup), account-shared headroom and reserved safety margin. Validate every cost meter and reset window. Where boundable costs are not proven, HOLD.
- [ ] **Step 3: Owner checkpoint:** request permission separately for Preview candidate upload/secret lifecycle and Stage 1 measurements, and for Production historical telemetry queries if attribution requires them. No global blanket execution permission.
- [ ] **Step 4: Only if explicitly approved and capacity PASS, follow original Task 6 exactly:** use its `npm run gate:relay-cpu -- stage1 --execute ...` path, per-run Preview bearer and teardown, and `npm run telemetry:relay-cpu -- ...` with platform telemetry completeness. The commands and flags are those already in the old Plan; never copy raw secrets into the new plan or run them as part of plan authoring.
- [ ] **Step 5: Classify:** pass only with all 68 series, each ≥500 successes and 5/7/0, exact candidate identity and complete telemetry. A missing series is `BLOCKED`; a CPU exceedance is `FAIL`. Ensure all grants are terminal/recovered and Preview gate secrets are removed/verified according to old Task 6.

**Task-specific stop:** `PREFLIGHT_HOLD`, absent remote permission, missing account balance, missing/ambiguous telemetry, incomplete fixture closure, or unsafe need to span reset boundaries => **no further measurement**. Do not treat a successful Preview smoke test as Stage 1 CPU acceptance.

### Task 5: Apply the one bounded Owner branch decision after Stage 1 (no automatic execution)

**Files:**
- Reference unchanged: `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md`, old **Tasks 7–12** and spec's rollout/HOLD rules.
- No additional file changes unless a specific downstream task is separately authorized.

**Interfaces:**
- Consumes: complete authorized Stage 1 CPU evidence and cost proof, or explicit `BLOCKED/FAIL` evidence.
- Produces: one Human Owner decision for next phase, not a newly spawned review series.

- [ ] **Step 1: If every Stage 1 series PASS:** report that conditional Tasks 7–8 are unnecessary and retain their `CONDITIONAL_NOT_IMPLEMENTED` status. Only after separate authorization may old Tasks 9–11 address the still-missing DO compatibility manifest, bridge/candidate/hardening tooling, local verification and revision lock.
- [ ] **Step 2: If activation/renewal/terminal fails the CPU gate with complete evidence:** report the specific failing series; request one scoped Owner decision on old Tasks 7–8. If approved and implemented, rerun the **whole** Stage 1 using the changed candidate as the old plan requires. No automatic review/redo loop.
- [ ] **Step 3: If ingress or decision CPU fails:** STOP; do not use Lifecycle DO as a purported fix. The Owner chooses a focused alternative or HOLD.
- [ ] **Step 4: If evidence is `BLOCKED`, cost preflight HOLD, or operational recovery incomplete:** preserve the corresponding status, keep Production HOLD, and obtain a focused Owner decision; do not convert unknown to PASS.
- [ ] **Step 5: Stage 2 remains separate:** old Task 12 requires the full compatibility bridge at 100%, CPU-tested candidate at 0%, compatibility preflight, Production-like gate, exact candidate promotion, distinct hardening ScriptVersion and explicit Production mutation/telemetry permission. Do not loosen these contracts or use the CPU pass to lift HOLD automatically.

## Completion criteria and handoff

**This writing-plans task is complete when:** (1) the plan maps the adopted spec to exact files, signatures, tests and stop conditions, (2) the existing merged code is not scheduled for automatic reimplementation, (3) the minimum and fivefold matrix budgets and additional unknown operation costs are explicitly gated, (4) Cost Gate and CPU Gate are independent, and (5) all non-approval and HOLD states remain explicit.

**Execution is *not* complete:** this plan is a candidate; no source change or CPU measurement was performed. Under current evidence, Cost/Capacity Preflight is `NOT_VERIFIED`, Stage 1 runtime is `NOT_VERIFIED`, and Production remains `HOLD`.

**Human Owner choice after reading:** approve this continuation plan, approve it with bounded changes, or return it. Even plan approval does **not** automatically authorize implementing Tasks 2–3, running Task 4, starting old Tasks 7–12, publishing a PR, or lifting the Production HOLD.

**Repository destination if separately approved:** `docs/superpowers/plans/2026-11-03-octg-cloud-native-zero-cost-cpu-headroom-r011-execution.md` on `feature/octg-cloud-native-zero-cost-cpu-headroom-design-r01`. No GitHub write was performed by this plan-authoring task.
