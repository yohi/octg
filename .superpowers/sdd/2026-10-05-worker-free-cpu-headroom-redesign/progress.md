# SDD ledger — plan: docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md

## Setup

- Worktree: `.worktrees/feat/issue-121-cpu-headroom-redesign` (relative to repository root)
- Branch: `feat/issue-121-cpu-headroom-redesign`
- Base SHA: `f40c05d` (master HEAD before worktree)
- Baseline verification: `npm test` all workspaces pass (740 + 49 + 206 + 162 + Deno tests pass, 0 failures)

## Conflict scan (pre-execution)

| Task pair | Shared file/interface | Finding | Ruling |
|---|---|---|---|
| Task 2 → Task 4 | `apps/gateway-worker/src/relay-decision-controller.ts` | Task 2 moves shard helper to shared; Task 4 moves grant-claims mapping to shared. Sequential, non-overlapping changes. | Clean |
| Task 4 → Task 7/8 | `apps/gateway-worker/src/index.ts`, `apps/gateway-worker/src/relay-auth.ts` | Sequential modifications, each task builds on prior. | Clean |
| Task 3 → Task 4 | QuotaController RPCs | Task 3 produces inspection/fence/slot RPCs; Task 4 consumes them. | Clean |
| Task 2 → Task 3 | Shared contracts | Task 2 produces contracts; Task 3 consumes them. | Clean |
| Task 4 → Task 5 | CPU-gate HTTP contracts, markers | Task 4 produces; Task 5 consumes. | Clean |
| Task 7 → Task 8 | Lifecycle DO | Task 7 produces class/binding; Task 8 routes callbacks through it when toggle active. | Clean |

Self-contradiction scan: each task's own text agrees with itself. No plan-mandated defect detected.

**Scan result:** clean. Proceed to Task 1.

## Tasks

- [x] Task 1: Cache the relay HMAC CryptoKey import — commit `72bb068` — ✅ reviewed & approved
- [x] Task 2: Define shared routing, lifecycle RPC, and CPU-gate control contracts — commit `b736bc0` — ✅ reviewed & approved (year-10000 edge fixed in round 1)
- [x] Task 3: Add QuotaController CPU-gate inspection, fence, and global slot RPCs — commits `fb02371`, `7a10d48` — ✅ reviewed & approved after fix round 1
- [x] Task 4: Implement the protected Worker CPU-gate control plane and safe relay markers — commits `2718c60`, `d806d4b` — ✅ reviewed & approved with minor deferrals
- [ ] Task 5: Build canonical CPU workload, telemetry acquisition, and evidence tooling — commits `f42c055`, `f08492b`, `6a41e43` plus current repairs — the independent P2 identity-consistency finding is fixed and its repair has passed a fresh five-lane review (requirements, QA, code quality, security and context). Latest full `npm test`: 1,605 passed; typecheck passed. Focused independent QA: 247 passed; CLI help and execution guard behaved as expected. Task 5 changes are ready for the requested commit boundary; live Task 6 evidence is separate. See the latest checkpoint in `task-5-report.md`.
- [ ] Task 6: Attribute the Production recurrence and execute the Stage 1 gate
- [ ] Task 7 (conditional): Implement RelayGrantLifecycleController contract and trust-processing DO
- [ ] Task 8 (conditional): Move lifecycle callbacks behind the DO and synchronize Preview routing
- [ ] Task 9: Generate and verify the Durable Object compatibility manifest
- [ ] Task 10: Implement exact Production version configuration and bridge/candidate/hardening rollout tooling
- [ ] Task 11: Synchronize operations documentation and run the complete local verification gate
- [ ] Task 12 (authorized remote): Stage 2 / acceptance / promotion / hardening evidence

## Deferred minor findings (for final whole-branch review)

### Task 1

1. `packages/shared/src/relay-credential.ts:149-154` — second Uint8Array copy is defensive; restore or clarify rationale comment.
2. `packages/shared/src/relay-credential.ts:134-139,149` — document in-process-only, non-logged, non-persisted retention of `rawKeySnapshot`.
3. `packages/shared/test/relay-credential.test.ts:57-59,99-203` — add comment documenting unique-key-bytes isolation convention.
4. `packages/shared/src/relay-credential.ts` LOC 263 > 250 guideline — non-blocking; consider extracting helpers in follow-up.

### Task 2

1. `packages/shared/src/relay.ts:1-7` / `packages/shared/src/relay-errors.ts:1-7` — update header comments to reflect module responsibilities.
2. `packages/shared/test/relay.test.ts` — move lifecycle/CPU-gate contract tests into an independent describe and pin all result discriminants literally.
3. `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md:51,304` — file map and Step 6 commit list should include `relay-control.ts` and `relay-errors.ts` if the split is retained.

### Task 3

1. Some Step 5.5 recovery scenarios remain uncovered by dedicated tests: same-pool concurrent claim, day-rollover owner blocking, restart without journal, unavailable claim blocking both pools, paused-A-after-B close, lost-close-ack recovery, bridge/candidate stub singleton sharing. These are coverage gaps, not regressions.
2. fence/admission collision test relies on DO transaction serialization rather than forced interleaving; may need deterministic hooks if flaky.
3. quota RPC guard tests cover representative methods; full enumeration not done.

### Task 4

1. `apps/gateway-worker/test/relay-cpu-gate.test.ts` — add the remaining plan-pinned route-level tests: a concurrent different-ID/different-pool `/cpu-gate/setup` race (the current race at lines 392-408 calls `claimRelayCpuGateSlot` directly), cross-UTC-day `setup-fence`/`operation-inspection`/`reconcile-unused` recovery after a rollover, `setup-fence` returning `non_fixture` for an ordinary-request collision, a denied `admitRelay` retaining the slot, failed/ambiguous signing compensation returning `setup_state_ambiguous`, and a signed Context with an extra `model` claim rejected as `invalid_context`. These are coverage gaps; the implementation already retains the slot and fails closed.
2. `apps/gateway-worker/test/relay-cpu-gate.test.ts:15` — the suite pins `OCTG_RELAY_ENVIRONMENT=production`; add a Preview-environment route case to prove Preview setup does not claim the Stage 2 singleton and `decision-context` signs a Preview context. The plan asks for both runtime environments.
3. `apps/gateway-worker/src/relay-cpu-gate.ts:119-128` — `decision-context` does not re-check the configured fixture client's `enabled` flag (setup does at lines 134-137). Mirroring the setup check would fail closed if the fixture client is disabled after setup; hardening only, not a current spec violation.
4. `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md:456-467,657-659` — update the Task 4 file map and Step 7 `git add` list to include `relay-callback.ts` (required by Step 5), `relay-cpu-gate-utils.ts` (review-fix split), and the shared `relay-control.ts`/`relay.ts` type additions.

### Task 5 — review findings (NEEDS_FIX)

**Verdict: NEEDS_FIX (reviewed 2026-10-23).** Tests pass, but they pin fictional adapter shapes rather than the Task 4 HTTP contract, and several protocol/evidence requirements are missing or reversed.

Blocking findings:

1. `scripts/run-relay-cpu-gate.mjs:43-54` — fixture lifecycle expects `setup.kind="created"`, `inspection.kind="unused"`, and reconcile kinds `reconciled|terminal|noop`. The actual Task 4 contract returns a setup response without `kind` (`apps/gateway-worker/src/relay-cpu-gate.ts:164`), operation-inspection `absent|pending_ambiguous|fixture` / 404/425/409 (`relay-cpu-gate.ts:50-62,118`), and reconcile-unused `reconciled_unused` (`relay-cpu-gate.ts:181`). `runFixtureLifecycle` also fences every successful setup (`:45`) instead of only ambiguous setup.
2. `scripts/run-relay-cpu-gate.mjs:46,61,67-75,278,301-302` — slot/recovery/close adapters expect `{kind:"owned"}`, inspection `active|terminal|fencedAbsent`, and close `{idle,targetTerminal,fencedAbsent}`. Actual GET slot is `{version:1,slot:{kind:"held"|"closing",owner,generation}}` (`relay-cpu-gate.ts:91-96`), inspection is `fixture`/`absent`/`non_fixture`, and close-operation returns `{version:1,kind:"closed"}` or 409 (`relay-cpu-gate.ts:197`; spec:1823-1826). There is no separate claim route; the Worker claims inside `/setup` (`relay-cpu-gate.ts:143-150`).
3. `scripts/run-relay-cpu-gate.mjs:276-278` — Stage 2 preflight runs before slot claim. Spec requires the slot be claimed before every Stage 2 setup, including compatibility preflight (`docs/superpowers/specs/2026-10-05-worker-free-cpu-headroom-redesign.md:1762-1763`).
4. `scripts/run-relay-cpu-gate.mjs:171-172` — no assertion that the observed Worker version equals the candidate; the override header is silently omitted when either input is missing. Plan requires the exact header and observed-version equality (`plan:1197-1204`).
5. `scripts/run-relay-cpu-gate.mjs:182-191,229-230` — `_replay` fixtures are never terminalized (line 230 excludes them), and `terminalizeFixture` is awaited without terminal proof. Plan requires terminalization before the next sample (`plan:1183-1186`).
6. `scripts/run-relay-cpu-gate.mjs:239-240,256,280` — no protected run-ledger file is written (only an in-memory object), and fixture operations are never journaled. Journal entries lack the spec's `createdAt`/`lastTransitionAt` and only cover the Stage 2 slot/recovered owner. Plan/spec require journaling every runner-owned operation (`plan:1152-1158`; spec:1722-1738).
7. `scripts/run-relay-cpu-gate.mjs:250-251,60` — journal is loaded before the shared slot, and an idle slot returns without recovering/failing journal operations. Spec requires slot query first and recovery/closure of every non-terminal operation (`spec:1733-1738`).
8. `scripts/run-relay-cpu-gate.mjs:335` — `runCpuGateCli` passes only `preflightPassed` (unused) and no callback/setup adapters, so every mode returns BLOCKED. Verified: `node scripts/run-relay-cpu-gate.mjs stage1` → `BLOCKED`, exit 2. The executable `gate:relay-cpu` command is effectively non-functional.
9. `scripts/run-relay-cpu-gate.mjs:104-108` — Preview teardown uploads/sets the secretless version to 100% before deleting the versioned secret. Plan requires versioned secret deletion, then secretless version at 100% (`plan:716-719`). The test pins the reversed order (`scripts/run-relay-cpu-gate.test.mjs:237`).
10. `scripts/run-relay-cpu-gate.mjs:15-25,85-99,114-127` — `withPreviewSecretsFile` is never used by the runner/lifecycle, Preview auth/context preflight (401/404 before measurement) is absent, and failure/cancellation does not terminalize known operations with safe IDs. Plan Step 0 requires all three (`plan:696-723`).
11. `scripts/relay-cpu-evidence.mjs:18` — multi-window series compare each window's `platformInvocationCount` to the global `normalizedInvocationCount`, so a complete two-window series returns BLOCKED. Verified locally. It also compares assigned records only; an unassigned in-scope 6 ms record yields PASS (`p99=4,max=4`) because `normalizedInvocationCount` is not compared to the actual record/assigned count (`:18-24`).
12. `scripts/relay-cpu-evidence.mjs:10-15` — matching ignores `callOrdinal`, does not verify `executionModel`, `scriptName`, stage/source revision/workload/concurrency/window identity, and only checks top-level completeness flags. Plan requires ordinal matching and exact series identity (`plan:924-949,981-988,1074-1084`).
13. `scripts/relay-cpu-telemetry.mjs:22-30,38,73-82,91-94` — no global `eventId` de-duplication, truncation is checked only on the chosen CPU event, pagination stops on an empty page without tracking "zero new invocation events" across pages, per-window `paginationComplete`/`truncationObserved` are hard-coded, and `queryComplete` is always true. Plan requires dedupe, all in-scope truncation detection, zero-new-event termination, and exact sidecar semantics (`plan:970-998,1033-1070`).

Minor deferrals:

- `scripts/preview-worker-config.test.mjs:468-489` — the "does not inherit Production fixture IDs" test uses a base config without Production CPU-gate fixture IDs; add production values to prove deletion.
- Existing `scripts/` import-style hints (2) are pre-existing; no errors were reported.
- Full verification evidence is in `task-5-report.md`; commands re-run during review: 24/24 targeted tests, 27/27 preview-config tests, 188/188 `test:scripts`, `npm run typecheck` exit 0.
