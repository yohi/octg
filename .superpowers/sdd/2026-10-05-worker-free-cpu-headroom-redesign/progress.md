# SDD ledger — plan: docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md

## Setup

- Worktree: `/home/y_ohi/program/private/octg/.worktrees/feat/issue-121-cpu-headroom-redesign`
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
- [x] Task 5: Build canonical CPU workload, telemetry acquisition, and evidence tooling — base commit `f42c055`, continuation `f08492b`, and Task 5 completion commit — ✅ implemented; locally mocked protocol coverage complete
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

### Task 5 — minor deferred findings

1. Runner tests exercise ingress and a representative renewal callback; executing every workload/concurrency matrix row in runner tests remains additional coverage because each default row targets 500 successful callbacks.
2. Telemetry normalization covers representative grouped events and query failures; more Cloudflare response variants and malformed/truncated pagination cases are optional evidence-tool coverage.
3. Existing scripts-wide diagnostics retain two import-style hints in unrelated files; no errors were reported. Full verification evidence is in `task-5-report.md`.
