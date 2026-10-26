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
- [x] Task 5: Build canonical CPU workload, telemetry acquisition, and evidence tooling — commits `f42c055`, `f08492b`, `6a41e43`, completed with commit `eba0193` — the independent P2 identity-consistency finding is fixed and its repair passed a fresh five-lane review (requirements, QA, code quality, security and context). Post-commit `npm test`: 1,605 passed; `npm run typecheck` passed. Focused independent QA: 247 passed; CLI help and execution guard behaved as expected. Live Task 6 evidence remains separate. See the latest checkpoint in `task-5-report.md`.
- [ ] Task 6: Attribute the Production recurrence and execute the Stage 1 gate — Production source SHA attributed to `8ab973066a7e97c1ec9b759e08f8f70930137bcd`; read-only Observability found three `/v1/responses` `exceededCpu` events, but retrieval is sampled (`sampleInterval≈10.69`) and diagnostic only. Preview URL/upstream/quota Variables are now verified, and Preview Worker/D1/DO isolation checks pass. Stage 1 remains BLOCKED under read-only access: the deployed Preview Worker lacks the `OCTG_RELAY_SERVICE_AUTH_TOKEN` secret binding and the credential-broker writable operation/approval is unavailable. No Worker deploy/Secret/traffic mutation or Stage 1 candidate execution occurred; no Phase 2 branch selected.
- [ ] Task 7 (conditional): Implement RelayGrantLifecycleController contract and trust-processing DO
- [ ] Task 8 (conditional): Move lifecycle callbacks behind the DO and synchronize Preview routing
- [ ] Task 9: Generate and verify the Durable Object compatibility manifest
- [ ] Task 10: Implement exact Production version configuration and bridge/candidate/hardening rollout tooling
- [ ] Task 11: Synchronize operations documentation and run the complete local verification gate
- [ ] Task 12 (authorized remote): Stage 2 / acceptance / promotion / hardening evidence

## Task 6 prerequisite checkpoint

- Implementation baseline at task start: `8f314e2d0d92f975bfdfdba3ea4a7fad13404f74`;
  the feature worktree was clean. This identifies the inspected baseline, not a
  live measurement or final candidate version.
- Read Task 6's exact steps: Production recurrence attribution, isolated Preview
  provisioning/preflight/measurement/cleanup, per-series authoritative telemetry,
  and reducer results for all required series.
- The task requires exact registered resources and an allow-listed credential
  broker operation. No credential-broker capability is exposed by the connected
  tool catalog. Registration, bounded write approval and credential issuance
  cannot be inferred from a generic instruction to continue the plan.
- Read-only GitHub Actions metadata inspection found repository Variables for
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_PREVIEW_ACCOUNT_ID`, and Preview
  environment Variables for the account ID, Preview base URL, D1 ID, input limit
  and MINI quota. Required Preview workflow values `OCTG_PREVIEW_UPSTREAM_BASE_URL`
  and `OCTG_PREVIEW_QUOTA_LIMIT_STANDARD` were not present in the inspected
  repository/Preview Variable-name lists. GitHub Secret names exist for Preview
  Cloudflare and fixture credentials, but GitHub does not expose their values
  through the API; no values were requested or read.
- Initially, the two Preview variables were absent from the listed names. After
  the operator said they were registered, read-only per-variable GETs confirmed
  the Preview Environment values exactly match the supplied
  `OCTG_PREVIEW_UPSTREAM_BASE_URL` and `OCTG_PREVIEW_QUOTA_LIMIT_STANDARD=0`.
  No source-SHA or deploy-commit Variable exists in repository or Preview scopes.
- `gh run list --workflow 'Deploy Production'` omits reusable-workflow jobs, so
  its standalone listing was incomplete. Full Actions run `37100239733`
  (`Deploy Deno Tokenizer`) at `2026-10-03T05:34:09Z` had head SHA
  `8ab973066a7e97c1ec9b759e08f8f70930137bcd` and includes a successful reusable
  `Deploy Production / test-and-deploy` job. Master alignment passed; `Deploy
  Worker` ran `05:37:08Z`–`05:37:15Z`, enclosing Cloudflare Version 145 creation
  at `05:37:12.819547Z`. This attributes Version 145 to source SHA
  `8ab973066a7e97c1ec9b759e08f8f70930137bcd`. The commit changes
  `packages/shared/src/normalize.ts` and its test.
- Operator supplied `OCTG_PREVIEW_BASE_URL`, `OCTG_PREVIEW_UPSTREAM_BASE_URL`,
  `OCTG_PREVIEW_QUOTA_LIMIT_STANDARD=0`, Worker name `octg-gateway`, and
  clarified that `2e874b06` is a Worker Version ID. Read-only Cloudflare MCP
  Portal lookup verified the full version ID `2e874b06-f51b-4fc5-94ba-a5e19f2127d3`,
  version number 145, created `2026-10-03T05:37:12.819547Z`, source `wrangler`.
  The Preview Environment variable values were separately confirmed to match the
  upstream URL and quota. Worker `octg-gateway-preview` also exists in the
  authenticated Cloudflare account.
- Following the explicit request to run the read-only Portal query, Production
  Observability for this Worker version was queried for
  `[2026-10-18T00:00:00Z, 2026-10-25T00:00:00Z)`. The query completed and found
  three `exceededCpu` invocation events, all `POST /v1/responses`, at
  `2026-10-18T21:05:31.712Z`, `2026-10-20T07:24:59.463Z`, and
  `2026-10-21T18:31:05.998Z`; reported CPU times were 10, 17 and 10 ms. Trace
  correlation found a `prepare` finish (`success`, Deno provider, 1264 ms) then
  `upstream` start for the 2026-10-20 event. The other two returned partial
  stage sequences; missing events are not proof a stage did not occur.
- Completeness companion query completed but returned
  `sampleInterval=10.687022900763358` and estimated count 2,800 for 213 sampled
  unique requests. Invocation query `abr_level=100`; companion calculation
  `abr_level=10`; per-trace event queries `abr_level=1`. Query-level ABR values
  do not override the calculation's sample interval. Production data is therefore
  sampled/incomplete and diagnostic only, not complete Stage 1/acceptance evidence.
- Three follow-up 10-minute completeness queries around the individual failures
  were rejected by the Observability MCP response validator because returned
  `calculations[].series[].data[].value` fields were strings where its schema
  requires numbers. These connector errors are not empty-data results and are not
  used as evidence. Do not repeat the same connector query shape; use the Cloudflare
  API executor after re-authentication or the Task 5 acquisition CLI instead.
- User-run Task 5 CLI with 10-minute windows failed closed with
  `Invocation group must have exactly one CPU event`. Direct read-only API
  diagnostics show the 2026-10-18 10-minute window included two in-scope invocation
  groups without a CPU event (at 21:03:15Z and 21:04:18Z), before the known failure.
  Three 1-minute windows centered on the observed failures each returned COMPLETED,
  `abr_level=1`, `sampleInterval=1`, exactly one CPU event per group, no missing IDs,
  scope, timestamps or routes, no request-ID contradictions, and no truncation.
  The 1-minute windows contain 7 `exceededCpu` events total, all on `POST /v1/responses`: 10-18 21:05:27.976Z (215 ms), 21:05:30.148Z (10 ms), 21:05:31.712Z (10 ms); 10-20 07:24:59.463Z (17 ms), 07:25:01.347Z (10 ms); 10-21 18:31:01.492Z (605 ms), 18:31:05.998Z (10 ms).
- User then ran the local CLI with those 1-minute windows: 7 records normalized,
  `samplingVerified=false`. The protected metadata showed `paginationComplete=false`
  for all three windows despite sampleInterval 1 and exact platform/normalized count.
  A direct read-only pagination probe found Cloudflare page 2 returned 9 repeated
  event IDs and the same cursor, with zero new IDs. The CLI checked repeated cursor
  before its zero-new-event completion condition, incorrectly marking complete data
  incomplete.
- Added regression coverage; it failed before the fix and passed after moving the
  zero-new-event check before repeated-cursor rejection. `node --test
  scripts/relay-cpu-telemetry.test.mjs`: 23 passed. Full `npm test`: 1,605 passed;
  `npm run typecheck`: passed; `git diff --check`: passed. The user reran the
  protected CLI after the fix: `normalizedInvocationCount=7`,
  `samplingVerified=true`; metadata confirms all three windows pagination-complete,
  sampleInterval 1, no truncation, and exact platform/normalized counts 3/2/2.
- Read-only Worker settings report `usage_model=standard` and no explicit CPU
  `limits`. Version metadata has `source=wrangler` and no source revision
  annotation. The exact Git SHA is attributable via GitHub Actions: run
  `37100239733` (`Deploy Deno Tokenizer`) had `headSha=8ab973066a7e97c1ec9b759e08f8f70930137bcd`;
  its reusable `Deploy Production / test-and-deploy` job completed successfully,
  the master-alignment step passed, and its `Deploy Worker` step ran
  `2026-10-03T05:37:08Z`–`05:37:15Z`, enclosing Version 145 creation at
  `05:37:12.819547Z`. Thus this Worker version was deployed from source SHA
  `8ab973066a7e97c1ec9b759e08f8f70930137bcd`. No version code or Secret was fetched.
- The 2026-10-04 Preview Smoke run completed `version-smoke`, including isolated
  config preparation, D1/DO migrations, candidate upload, smoke, and traffic
  restoration. Current Preview upstream URL and STANDARD quota match the
  read-only GitHub Environment Variable GETs.
- Read-only Cloudflare settings checks confirm Production is `production`, Preview
  is `preview`, D1 IDs differ, and no Durable Object namespace IDs are shared.
  The existing Preview Worker does not have an `OCTG_RELAY_SERVICE_AUTH_TOKEN`
  secret binding (only binding presence was checked; no values were read). Task 5's
  Stage 1 HTTP adapter requires this service token to call Preview relay lifecycle
  routes, but its current secrets-file helper uploads only the per-run CPU-gate
  bearer. A reviewed provisioning change is needed to inject a Preview-only service
  token through the approved broker path before Stage 1 can pass.
- Cloudflare API re-authentication completed. A read-only deployment GET confirms
  Version 145 (`2e874b06-f51b-4fc5-94ba-a5e19f2127d3`) was deployed at
  `2026-10-03T05:37:14.134339Z`, source `wrangler`, with 100% traffic. Its record
  has no Git SHA annotation; SHA attribution is from the successful, master-aligned
  GitHub Actions deploy job. No writes were performed.
- Still needed: registered credential-broker environment/operation and scope-bound
  writable approval to provision a Preview-only service token, upload/deploy the
  candidate and gate token, run synthetic fixture calls, delete the versioned
  Secret, and restore the secretless version to 100%. Do not send credential
  values in chat.
- Task 7/8 remain conditional on actual Stage 1 results: lifecycle FAIL selects
  them, ingress/decision FAIL requires separate remediation, and BLOCKED evidence
  does not select a branch. No acceptance claim is made.

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
