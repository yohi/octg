# Task 5 report — Worker Free CPU headroom tooling

Base commit: `f42c055` (`feat: add relay CPU gate telemetry and evidence tooling`). Continuation commit: `f08492b`; this completion is committed separately.

## Status

Task 5 remains incomplete and unapproved. The earlier implementation and verification claims below are historical, not acceptance evidence. The direct implementation repair round is recorded at the end of this report. No remote execution has been performed.

The runner now models fixture setup, ambiguous setup-fence recovery, operation inspection, unused reconciliation outcomes, terminal callback retry and proof; singleton-first restart recovery with operation-journal owner/generation reconciliation and close-to-idle proof; Stage 2 rejection preflight bound to the current run/model before slot claim; callback execution and target-terminal/fenced-absent slot close; and Preview candidate upload/deploy/version observation, measured callbacks, secretless version traffic at 100%, exact-version secret deletion, metadata/404 proof, rollback, and temp-secret cleanup. Safe journal serialization retains no credentials. Credential sentinels are scanned across supplied stdout, stderr, generated config, argv, and artifact surfaces.

## Final verification

- `node --test scripts/relay-cpu-workloads.test.mjs scripts/relay-cpu-telemetry.test.mjs scripts/relay-cpu-evidence.test.mjs scripts/run-relay-cpu-gate.test.mjs` — 24 tests, 24 pass, 0 fail.
- `node --test scripts/preview-worker-config.test.mjs` — 27 tests, 27 pass, 0 fail.
- `npm run test:scripts` — 188 tests, 188 pass, 0 fail.
- `npm run typecheck` — exited 0 for Deno tokenizer, gateway Worker, quota controller, tokenizer controller, and shared workspaces.
- `lsp_diagnostics` on `scripts/` — 0 errors; 2 existing import-style hints remain in `documentation-contract.test.mjs` and `preview-worker-config.mjs`.
- `git diff --check` — clean.

## Coverage and minor deferred findings

- The full workload matrix is defined and runner coverage includes ingress plus a non-ingress renewal case; all combinations are not individually executed in the runner tests because the default target is 500 successful callbacks per configured series.
- Telemetry normalization has representative grouped-event and query-failure coverage; additional Cloudflare response variants and malformed/truncated pagination cases remain minor evidence-tool coverage work.
- `run-relay-cpu-gate.mjs` exceeds the 250-line module-size guideline; splitting its adapters is a follow-up style improvement, not a protocol or correctness gap.
- Existing scripts-wide style hints are outside the runner change and are not blockers.

No raw credentials, request/response bodies, or machine-specific absolute paths are retained in this report. All credentials used by tests are synthetic sentinels.

## Direct implementation repair round

The user switched implementation ownership to the primary agent. Existing
uncommitted telemetry/evidence changes were preserved and extended.

Implemented and regression-tested:

- Multi-window completeness uses each window's platform count plus global totals.
- PASS requires at least 500 successful calls; invalid CPU values, duplicate
  event IDs, duplicate/missing ordinals and unassigned records cannot pass.
- Observed CPU threshold violations remain FAIL with incomplete sampling.
- The evidence CLI now reads ledger/JSONL/metadata and writes a 0600 verdict.
- Telemetry checks required platform fields, identity contradictions on marker
  events, truncation, global duplicate fingerprints and conflicting CPU events
  split across pages. Pagination tracks new IDs per window, independently of
  global duplicate detection, so adjacent windows do not stop prematurely.
- Telemetry rejects unknown CLI arguments (including credential arguments) and
  enforces 0600 export permissions even when files already exist.
- `relay-cpu-operation.mjs` uses actual Worker envelopes. Successful setup is not
  fenced; lost acknowledgements recover by ID without admission retry; recovered
  fixtures without credentials are closed, never presented as usable grants.
- Singleton recovery reads the slot before loading the journal, closes with the
  exact pool/requestId/generation and verifies idle; an idle slot does not skip
  unresolved journal entries. Stale generations block closure.
- Runner replay batches use fresh fixtures and require terminal acknowledgement
  before another sample. Candidate override inputs and observed version equality
  are mandatory. An injected aggregate `runSeries` cannot bypass actual callbacks.
- Fixture identity is journaled before admission with createdAt/lastTransitionAt;
  credentials are excluded and the persisted journal is mode 0600.
- Preview teardown order is secret deletion, secretless upload/traffic, metadata
  and exact secretless-version 404 verification.

Verification:

- `npm run test:scripts`: 228 passed, zero failures.
- `npm run typecheck`: exit 0 across all configured workspaces.
- `lsp_diagnostics scripts/`: zero errors at the time checked.
- `git diff --check`: clean.
- `npm test`: scripts 227/227 at that point, Deno 133/133, tokenizer 49/49,
  shared 222/222; gateway 779/780. The failure is
  `proxy-prepare.test.ts > prepare routing > routes non-decimal Content-Length
  "1e2" through prepare`, expected 200 but got 500.
- Isolated `npm test -w apps/gateway-worker -- proxy-prepare.test.ts`: 21/21.
- A subsequent complete gateway run again failed the same case (779/780).
  Logs show prepare expiring at 1000 ms while quota RPCs consume most of that
  deadline under the full suite. The cause is not fully established, and no
  unrelated timeout or production code was changed to hide the failure.

Remaining blockers (do not run Task 6 yet):

- Real HTTP/Wrangler adapter and executable runner CLI wiring.
- End-to-end Preview secret-file provisioning, auth/context preflight and
  guaranteed failure/cancellation cleanup; output-surface sentinel collection.
- Preview registry model validation and exact callback preparation/measurement
  windows for every lifecycle series, plus source-identity run-ledger persistence.
- Full singleton ownership integration with each measured fixture and automatic
  cleanup of exceptions during callback execution.
- Review of the remaining historical findings and complete local verification,
  including investigation of the full-suite prepare timeout.

No new commit has been created in this repair round.

## Latest direct implementation checkpoint

This checkpoint supersedes the earlier partial repair findings. The repair is
implemented and locally verified, but has not received a new independent review
or a commit boundary. Task 5 is not marked approved and no remote CPU acceptance
claim is made.

Additional implementation:

- Real HTTP adapters and CLI wiring, with independent control/service/client
  authorization, exact Worker bodies, version overrides and observed-version
  checks. CLI remote execution requires the bare `--execute` flag; credentials
  remain environment-only.
- Per-fixture target proof and generation-bound singleton closure before the
  next setup; failure and cancellation drain concurrent callbacks before recovery.
  Cleanup never fences a newer, different slot owner.
- Partial decision failures still terminalize every credential actually received;
  failure to confirm one grant does not skip the others. Normal terminal
  acknowledgements do not depend on CPU-fixture inspection routes.
- Authoritative generation is journaled before callbacks. Series-specific 0600
  ledgers contain source/version identity, actual HTTP status, semantic success
  and windows that exclude preparation and terminal cleanup.
- Stage 2's exact `model_requires_paid` 403 is a valid ingress measurement
  outcome; arbitrary 403 responses remain invalid.
- Preview provisioning generates a fresh bearer, uses a real 0600 secrets file
  inside a 0700 directory, checks auth separation and the Preview registry/model
  pool, and closes known operations before versioned secret deletion. The version
  returned by deletion is deployed at 100%, checked against candidate bindings,
  and verified to disable all eight control routes. Unproven cleanup remains
  BLOCKED with safe version identifiers.
- Added bounded Wrangler command adapters with injected execution for local
  tests, generated-config isolation checks and credential output scanning.
  No upload/deploy/delete command was executed against Cloudflare.
- Corrected runner ULID timestamp ordering and incident workloads' Responses
  function-call shapes. The local exact tokenizer is pinned to tiktoken 1.0.22.
- Repeated non-empty telemetry cursors are incomplete, not proof of pagination.
- Actual Worker internal responses now carry the existing Worker version header,
  including disabled/rejected control requests. Six entry-point tests failed on
  the missing header before the fix and pass afterward.

Final verification:

- `npm test`: exit 0; scripts 332, Deno 133, gateway 786, tokenizer 49 and shared
  222 tests passed (1,522 total).
- `npm run typecheck`: exit 0 across all configured workspaces.
- `git diff --check`: clean before this documentation-only update.
- All 68 required matrix rows execute through the real HTTP adapter against an
  in-memory HTTP fixture worker, using three samples per row for local tests.
  The separate runner target test checks 500 successful callbacks. These local
  tests are protocol coverage, not the required 500-sample remote CPU evidence.
- The previously intermittent Content-Length routing case was isolated from its
  unrelated real 1000 ms prepare timer by mocking only setTimeout/clearTimeout
  in that routing test and restoring timers after each case. No production
  deadline or CPU threshold was increased. Isolated 21/21, complete gateway
  786/786, and final whole-workspace verification passed after the test fix.

The temporary debug journal was removed. Changes remain uncommitted. Remaining
acceptance work is the Task 5 review/commit boundary followed by explicitly
authorized Task 6 provisioning, live telemetry and the complete CPU gate; local
test success does not select a Phase 2 branch or authorize Production changes.

## Continuation verification — 2026-10-24

- Re-ran the telemetry, evidence and runner tests: 71 passed, zero failures.
- Re-ran `npm test`: exit 0; scripts 332, Deno 133, gateway 786,
  tokenizer 49 and shared 222 tests passed (1,522 total).
- Re-ran `npm run typecheck`: exit 0 across all configured workspaces.
- `git diff --check`: clean before this verification-record update.
- The remaining local verification/progress-recording task is complete. Task 5
  still awaits independent review and a commit boundary. No new implementation
  changes were needed for this verification run.
- Live CPU measurements and remote acceptance evidence remain outstanding.
  Task 6 provisioning and execution require explicit authorization; these local
  results do not establish the CPU gate verdict or authorize remote changes.

## Independent review and repair checkpoint — 2026-10-24

This checkpoint supersedes the previous local-completion assessment. Independent
review found additional lifecycle defects despite the earlier passing tests.
Primary-agent comparison with the [Cloudflare SDK telemetry contract][cf-telemetry]
also exposed request/response fixtures that did not match the platform API.

Repairs made after observing failing regression tests:

- Semantic callback failures now stop the series as BLOCKED, rather than counting
  subsequent successes toward a PASS while retaining failed calls in the ledger.
- Concurrent decision calls receive distinct request IDs and signed contexts.
  Returned grant cleanup retains each call's request identity.
- Renewal and replay series retain one prepared fixture across batches, then close
  it after the series. Normal activation/terminal samples use fresh fixtures.
- Terminal normal/replay preparation activates the fixture. Activated grants use
  `settle(totalTokens=0)`; unactivated decision grants retain release cleanup.
- Exceptions and cancellation still drain callbacks before generation-bound
  recovery. Recovery does not fence a newer singleton owner.
- Telemetry uses top-level numeric `timeframe`, `limit`, `offset` and
  `offsetDirection`; datasets and typed filters live inside `parameters`.
- Normalization accepts the platform's top-level event timestamp, and completeness
  reads nested calculation aggregates. Unfinished queries, unavailable query
  statistics and adaptive database sampling cannot establish complete telemetry.
- The local HTTP matrix now executes all 68 rows for each of Stage 1 and Stage 2,
  including distinct normal decision grants and state-aware zero-token settlement.

Verification after these repairs:

- `npm test`: exit 0; scripts 404, Deno 133, gateway 786, tokenizer 49 and shared
  222 tests passed (1,594 total).
- `npm run typecheck`: exit 0 across all configured workspaces.
- `git diff --check`: clean before this report update.
- Regression failures were observed for the query wire contract, unfinished/ABR
  queries, semantic callback failure, shared decision identity, replay fixture
  retention and terminal preparation before their respective fixes.

Review disposition:

- Initial independent requirement/context and correctness reviews identified the
  lifecycle issues above; primary-agent regressions confirmed the defects.
- A fresh focused code-quality/cleanup re-review returned PASS after repair.
- The fresh requirement, security, telemetry-contract and QA re-review lanes
  aborted without usable verdicts. Aggregate independent review is therefore
  **INCONCLUSIVE**, not approved. The independent review retry budget was exhausted;
  no interrupted lane is counted as PASS. Primary-agent executed test evidence is
  recorded separately above.
- The origin allowlist suggestion was not adopted as a proven vulnerability:
  origin and credentials are selected by the trusted CLI operator, not supplied
  through an untrusted server request; HTTPS and redirect rejection remain enforced.
- A successful upload with a lost version acknowledgement can leave an unidentified
  secret-bearing version. The lifecycle remains BLOCKED rather than claiming
  cleanup; remote version discovery and cleanup evidence remain operational work.

Task 5 is still unapproved and uncommitted. No remote provisioning, live CPU
measurement, deployment or acceptance claim was performed in this repair round.

[cf-telemetry]: https://github.com/cloudflare/cloudflare-typescript/blob/e00d6c475fe5a5b7fa8b08a0e36e110f8d4ed563/src/resources/workers/observability/telemetry.ts

## Independent review completion — 2026-10-24

Aggregate verdict: **FAIL**, superseding the previous INCONCLUSIVE checkpoint.
The review round changed no implementation or tests.

The dedicated review worktree matched the implementation worktree: SHA-256
comparison covered the tracked code/manifest diff and each untracked source/test
file. Reports were not part of the frozen code comparison. Background lanes that
aborted were retried synchronously with bounded assignments; interrupted runs
were not counted as approvals.

### Confirmed finding: identity contradictions outside the window are ignored

- Priority: P2; fix before approving Task 5 evidence tooling.
- Location: `scripts/relay-cpu-telemetry.mjs:88-97`, especially the out-of-scope
  `continue` before the request-ID consistency check.
- Requirement: the plan at lines 944-947 requires request identity fields on
  **any event** to agree with the invocation-group ID; contradictions must be
  BLOCKED / INCOMPLETE.
- Actual behavior: a marker outside the measurement window is skipped before
  its conflicting `$metadata.requestId` is checked. An otherwise valid CPU event
  in the same group still normalizes successfully.
- Primary-agent reproduction: 500 groups with timestamps 120-619 in the window
  `[100,1000)`, each containing one valid CPU event at 3 ms; group 0 also contains
  a marker at timestamp 90 with a request ID different from its group. Query
  responses are synthetic, completed and unsampled; the aggregate count is 500.
  Retrieval reports `queryComplete=true`, `samplingVerified=true`, and the evidence
  reducer returns `PASS`, `p99=3`, `max=3`, `matchedInvocations=500`.
- Recommended repair: validate any present platform request identity fields
  against the group before scope filtering. Add regression coverage for
  out-of-window and other out-of-scope marker contradictions.

### Completed review coverage

| Area | Result | Evidence / scope |
| --- | --- | --- |
| Lifecycle requirements | No confirmed blocker | Independent review checked fixture reuse, preparation timing, unique decision context and settlement; a supplemental reviewer confirmed the normal-series concurrency-1 matrix. |
| Telemetry / evidence | FAIL | Independent plan-grounded finding reproduced above. |
| Credential / cleanup security | PASS, scoped | Independent review of deployment, Preview lifecycle, temporary secret protection and Stage 1 integration under the trusted-operator CLI threat model. |
| Ownership / contract context | PASS, scoped | Independent comparison with Worker replies, terminal proof, fence ordering, authoritative slot and owner/generation handling. |
| Executed local QA | PASS, scoped | Independent execution of nine tooling test files: 236 passed, zero failures; CLI help exit 0; Stage 1 without `--execute` returned BLOCKED, exit 2. |

Rejected unsupported findings were not treated as blockers: the SDK requires
`timeframe: {from, to}`; the plan explicitly permits platform IDs to differ from
runner IDs and requires route/time/count correlation; zero-new-event pagination
termination is specified by the plan; preserving an unresolved journal does not
mean the operation was falsely marked closed.

An additional primary-agent attempt to run Worker header/prepare tests inside
the review worktree could not start because its workspace-local
`@cloudflare/vitest-pool-workers` dependency was unavailable. This is not a test
failure in an executed test case, and the prior implementation-worktree full
suite result remains 1,594 passed; no fresh independent Worker-suite pass is
claimed here.

Task 5 remains unapproved and uncommitted. The identity-consistency defect is
reported, not repaired, in this review-only round. Live CPU evidence and remote
cleanup verification remain separate from this local review.

## P2 identity-consistency repair — 2026-10-24

The confirmed finding above is now repaired locally. `parseGroup` checks any
present `$metadata.requestId` and `$workers.requestId` against the invocation-group
ID before filtering by timestamp, script, version or execution model. The existing
error behavior is unchanged: contradictions reject acquisition, preventing a
complete telemetry sidecar or downstream evidence PASS.

Regression evidence:

- Added ten negative cases: each identity field on markers before the window, at
  its exclusive end, or belonging to another script, version or execution model.
  All ten failed with missing expected rejection before the production change.
- A positive test exercises fifteen combinations of out-of-scope markers with
  absent or consistent identity. They still filter normally and preserve complete,
  unsampled telemetry for the valid CPU event.
- After the check-order repair, `node --test scripts/relay-cpu-telemetry.test.mjs`
  passed all 23 tests.
- `npm test`: exit 0; scripts 415, Deno 133, gateway 786, tokenizer 49 and shared
  222 tests passed (1,605 total).
- `npm run typecheck`: exit 0 across all configured workspaces.
- `git diff --check`: clean before this record update.

The updated source and tests were copied to the dedicated review worktree for a
fresh, bounded independent re-review of this finding. That synchronous reviewer
timed out after five minutes without a verdict. Therefore the repair is verified
by primary-agent regression/full-suite execution, but independent approval of the
repair is still pending; no aggregate review PASS is claimed. The earlier FAIL
remains historical evidence of the pre-repair implementation, not a claim that
the current code still exhibits that defect.

Changes remain uncommitted. Live CPU and remote cleanup evidence are still pending.

## Independent review and commit-boundary approval — 2026-10-24

The latest code snapshot, including the identity-consistency repair, received a
fresh five-lane independent review:

| Lane | Verdict | Evidence |
| --- | --- | --- |
| Goal / requirement verification | PASS | Confirmed the current identity check precedes scope filtering and checked the Task 5 plan requirements; Task 6 live CPU work excluded. |
| Executed QA | PASS | Nine focused test files: 247 passed, 0 failed. CLI help exit 0; stage1 without `--execute` returned BLOCKED, exit 2, without entering execution mode. |
| Code quality | PASS | No actionable correctness or maintainability blockers in the reviewed telemetry, evidence, runner, HTTP, operation, deployment and Preview modules. |
| Security | PASS | No HIGH/CRITICAL finding under the trusted local CLI operator threat model. |
| Context completeness | PASS | Checked current plan/SPEC/progress context; no concrete Task 5 requirement gap found. Task 6 is separate. |

The prior review's identity-consistency FAIL referred to the pre-repair snapshot.
The final review confirmed the repaired source and regression coverage. A prior
independent re-review attempt timed out; the fresh bounded review lanes above
supersede that inconclusive attempt. The reviewed worktree source hashes matched
the implementation worktree for the changed code and tests.

The user requested completing the independent review and commit boundary. The
implementation, its tests, dependency lock updates, and Task 5 progress/report
records are therefore being prepared as one Task 5 commit. No Task 6 deployment,
live CPU measurement, or remote cleanup is included or claimed.
