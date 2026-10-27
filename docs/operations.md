# Operations

This document is the operator runbook for a deployed OCTG instance. Technical behavior is normative in [../SPEC.md](../SPEC.md). Configuration names and ownership live in [configuration.md](./configuration.md).

## Routine Health Checks

Check the client-visible model registry:

```bash
curl https://<worker-host>/v1/models \
  -H "Authorization: Bearer <octg-client-key>"
```

Check both complimentary pools:

```bash
curl https://<worker-host>/quota \
  -H "Authorization: Bearer <octg-client-key>"
```

A pool snapshot reports its configured limit, used capacity, remaining capacity, reset time, and underlying confirmed/reserved/uncertain accounting.

Use the Access-protected Admin UI at `/admin/ui/` for operator views when configured.

## Production CPU-Gate Release HOLD and Cutover

The current-ref release restriction is unconditional: do not run Deno Deploy,
apply Worker D1 migrations, or deploy the Worker from the current source ref while
the interim HOLD is in force. `HOLD_CODE_PRESENT` means only that deny/control
code exists in the checked-out source; it is not evidence that the running
Production workflows or jobs are held. Report `HOLD_ACTIVE` only when positive
evidence proves **all** of these necessary conditions:

1. An approved operator cutover decision exists.
2. All running, queued, pending, and approval-waiting Production-capable jobs are
   stopped or safely contained.
3. Historical `workflow_dispatch` and old-SHA reusable-workflow dispatch/reuse
   routes are blocked or safely contained.
4. `deno-production` Environment deployment-branch restrictions and required
   reviewers are effective.
5. Production deployment credential reachability has been verified and is
   bounded to the approved trusted routes.

If any item cannot be controlled or observed, or its evidence is missing,
ambiguous, or stale, the status must remain
`HOLD_CUTOVER_BLOCKED / HOLD_ACTIVE_NOT_PROVEN`; preserve the HOLD and do not
infer activation from the presence of new YAML. Do not roll back traffic that
was already running before the cutover.

### No-gap operator cutover inventory

An authorized operator records this inventory before and after the historical
cutover. Keep evidence in the approved protected location; never record secret
values.

| Evidence | Record and verify |
| --- | --- |
| Run identity | Workflow/run IDs and attempt numbers before and after the change; include queued, active, rerunnable, and Environment-waiting approvals. |
| Approval state | Identify approvals still actionable, pending Environment reviewers, and jobs that can be rerun or resumed; verify their disposition rather than assuming cancellation. |
| Ref selection | Record source ref and exact SHA for each run, and which ref/SHA the production workflow permits. |
| Environment policy | Verify `deno-production` deployment branch restrictions and required reviewer rules against the actual Environment configuration. |
| Credential scope | Verify trusted Production Deno management/runtime credentials and Worker deployment credentials are scoped only to intended trusted workflows; do not disclose values. |
| Emergency / rollback | Name the authorized recovery operator, known-good immutable Deno and Worker revisions, and the reviewed recovery sequence. Never use an unverified `wrangler deploy` of newest master as an emergency workaround. |
| Authority | Record the operator who performed and independently checked the cutover, with the authorization source. |
| Timestamps | Capture UTC timestamps for every observation and action, including the before/after run inventory. Mark unavailable or uncorrelated facts `UNKNOWN`. |

New YAML does not protect against old Workflow definitions already queued or
running, preapproved jobs, or a rerun that selects an older ref. Inspect those
jobs and approvals directly in the actual Production control plane. Do not roll
back previously running traffic; stop or block only actions that have not yet
safely started, using the approved control-plane procedure. If an emergency recovery is
needed, use only the documented, exact known-good revision and authorized path.

### Deferred release-unblocking handoff — Issue #121

The release HOLD remains until the separately reviewed and authorized follow-up
work is complete. This documentation-only change does not implement or verify
that work (**NOT VERIFIED**):

1. Task 6 Stage 1 must run at its locked SHA and produce authoritative evidence.
2. Tasks 7/8 are conditional follow-up only if the lifecycle result is FAIL.
3. Task 9 owns the exact Durable Object compatibility manifest.
4. Task 10 owns generated bridge/candidate configs, mandatory bridge 100% and
   candidate 0%, fenced fixture terminalization, and authoritative singleton idle.
5. Task 11 owns the immutable SHA lock, full local gates, and fresh Stage 1.
6. Task 12 is separately authorized Stage 2: 5/7/0, at least 500 successes,
   complete telemetry, exact candidate acceptance, a distinct hardening version,
   and secret teardown.

The later RED/GREEN tests and acceptance ownership are tracked in Issue #121,
Tasks 9–12, and the [CPU headroom plan](./superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md).
They are **NOT VERIFIED** by this interim runbook contract test; do not claim
Stage 1 or Stage 2 PASS or treat this test as release authorization. Keep Issue
#121 open until its complete criteria are met.

## Observability

The Worker has Cloudflare observability enabled.

Request processing emits resource-stage events for stages such as body read, parse, normalize, tokenization, quota state, reserve, and upstream execution. Useful fields include:

- OCTG request ID;
- Worker revision/version metadata;
- route;
- input byte measurements;
- tokenization provider;
- tokenization failure category;
- whether quota was reserved;
- whether upstream was reached;
- stage outcome and duration.

`TokenizerController` emits `octg.tokenizer_stage` events for
`tokenizer_init` and `tokenizer_encode`. Check the paired start/finish events
when investigating initialization or BPE CPU cost. Safe metadata may include
duration, byte/token counts, estimation path, and failure category; it must not
include input text, prompts, request bodies, credentials, or raw tokenizer
output.

Do not add raw prompts, response payloads, API keys, peppers, or tokenizer input text to operational logs.

For a customer-visible failure, start with `X-OCTG-Request-Id` and, where present, Worker version metadata and `X-OCTG-Route`.

## Quota Interpretation

Live quota safety comes from `QuotaController`, not D1 request totals.

Remaining capacity is conservative:

```text
limit - confirmed - reserved - uncertain
```

An uncertain request continues to consume capacity until reconciliation resolves it.

If the pool is exhausted, OCTG rejects new traffic rather than falling through to a paid route.

## Daily Reconciliation

The checked-in cron runs at 00:05 UTC and processes the immediately previous UTC day.

For each pool the job:

1. gets the canonical pending snapshot from the prior day's QuotaController;
2. fetches OpenAI organization completion usage for a 48-hour interval beginning at that day's midnight;
3. sums usage for models currently mapped to that pool;
4. compares upstream usage with locally completed token projections;
5. automatically reconciles ordinary pending requests only when the aggregate difference exactly matches their aggregate reservation;
6. leaves the reconciliation `open` otherwise.

Usage API retrieval is attempted up to three times during that reconciliation execution.

### Important implementation boundary

The current scheduler does not iterate over all older reconciliation rows whose status remains `open`.

Do not assume that an unresolved row will be automatically re-run every day or force-consumed at a retention deadline.

If an old `open` row needs action, inspect it explicitly and follow the manual path where applicable.

## Reserve-Unknown Incidents

A `reserve_unknown` origin means OCTG could not determine the result of a reservation attempt strongly enough to safely release capacity.

These requests are excluded from automatic aggregate consumed inference.

Resolve one through:

```text
POST /admin/reconcile/:pool/:utcDay/:requestId
```

with a disposition:

- `consumed`; or
- `unused`.

For `unused`, operator evidence is required. Evidence should identify the external fact that proves the request did not consume the upstream allowance; do not put secrets or request payloads in evidence.

A replay of the same disposition is safe. A conflicting disposition returns a reconciliation conflict.

## Finalization

Only reconciliation rows marked `done` are candidates for scheduled day finalization.

QuotaController refuses finalization while canonical reserved or uncertain entries remain.

Successful finalization deletes the Durable Object storage for that day. Therefore, investigate unresolved state before trying to force lifecycle cleanup elsewhere.

## Worker Canary

Use the repository canary command and the `OCTG_CANARY_*` settings from `.env.example`.

Operational rules:

- target only explicitly allowed production hostnames;
- use a dedicated production canary client;
- start at low concurrency;
- for the large-input regression, run concurrency 1, concurrency 2, and the
  operator-defined expected peak using synthetic or sanitized approximately
  74k-token text;
- remember that canary requests consume real production complimentary quota;
- compare the observed Worker version with the version intended for acceptance;
- stop on unexpected quota, tokenizer, upstream, or resource-limit behavior;
- accept the rollout only when the Worker has no `exceededCpu` outcome, gateway
  and tokenizer stage events are paired, and quota/upstream accounting is
  correct.

Do not use the canary as a load-test framework against the shared complimentary allowance.

## Deno Tokenizer Operations

When Deno is disabled, all tokenization uses `TokenizerController`.

When enabled, requests below the configured text-byte threshold use the Durable Object and requests at/above the threshold use Deno.

A Deno failure does not transparently retry through the Durable Object path.

Outside Production runtime, Responses prepare is disabled when both
`DENO_PREPARE_ENDPOINT` and `DENO_PREPARE_THRESHOLD_BYTES` are absent. Production
requires the complete pair and rejects absent, one-sided, or invalid values
before deployment; after activation, disable prepare only by rolling back to a
known pre-prepare Worker version. Treat a one-sided or invalid pair as a
deployment failure, not as a reason to silently use the Durable Object.
Prepare-only invalidity affects Responses; Chat Completions remains on its
existing path.

Production deployments use Wrangler `--keep-vars`. The production pair is
mandatory and is validated before D1 migration, Worker upload, and Worker
deployment. After prepare bindings have been deployed, remove them by rolling
back to a known pre-prepare Worker version rather than relying on an omitted
variable.

Monitor:

- tokenization provider;
- tokenization failure category;
- network error name where emitted;
- tokenization duration;
- Worker resource-limit outcomes.

For Preview, the dedicated Deno smoke runs after the Deno-disabled Durable
Object smoke. It intentionally checks an invalid-auth version before a
valid-auth version. The invalid request must fail with HTTP 500
`internal_error` rather than silently using the Durable Object path; the valid
request must return HTTP 200. Both versions remain at 0% beside the captured
100% version, and cleanup always restores the captured version with
`wrangler rollback`. Fork pull requests use secret-free validation only.

See [deno-tokenizer.md](./deno-tokenizer.md) for Deno-specific deployment and acceptance.

## Preview Relay CPU Stage 1 Gate

The normative CPU-gate control-route contract is [SPEC.md §19.7](../SPEC.md#197-internal-cpu-gate-control-plane-extension). Deploying the Worker routes does not activate the gate: activation requires the distinct `OCTG_RELAY_CPU_GATE_AUTH_TOKEN`. Stage 1 measurement PASS and the Stage 2 bridge are separate required evidence; neither is implied by deployment or local tests. Keep issue [#121](https://github.com/yohi/octg/issues/121) open until both stages are proven and the issue's closure criteria are met. Follow Tasks 6 and 9–12 in the [CPU headroom plan](./superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md) for the existing runbook and acceptance procedure.

Stage 1 measures the relay path against the isolated Preview Worker. It is a
remote deployment and traffic operation; run it only after the Preview account,
Worker, D1 database, Durable Object classes, Deno service, model registry, and
credentials have been provisioned and verified as Preview-only.

### Persistent Preview prerequisites

- The deployed Preview base version must already contain the persistent Secret
  bindings `OCTG_KEY_PEPPER`, `OCTG_UPSTREAM_API_TOKEN`,
  `DENO_TOKENIZER_AUTH_TOKEN`, `OCTG_RELAY_SERVICE_AUTH_TOKEN`,
  `OCTG_RELAY_INGRESS_AUTH_TOKEN`, and `OCTG_RELAY_CONTEXT_HMAC_KEY`. Wrangler
  versions upload preserves omitted Secrets; the upload adapter verifies these
  bindings by name before uploading a candidate.
- Store these Secrets in the Preview Worker through the approved credential
  provisioning path. The Stage 1 runner receives only the Preview service
  bearer needed for callbacks; it must never receive the ingress bearer or the
  HMAC key. The Deno service keeps its own ingress credential.
- Use a dedicated Preview environment file outside the repository with mode
  `0600`. It must contain `CLOUDFLARE_ACCOUNT_ID`, a Preview-scoped
  `CLOUDFLARE_API_TOKEN`, `OCTG_CANARY_CLIENT_KEY`,
  `OCTG_RELAY_SERVICE_AUTH_TOKEN`, and the non-secret `PREVIEW_*` config inputs
  below. Do not put `OCTG_RELAY_INGRESS_AUTH_TOKEN` or
  `OCTG_RELAY_CONTEXT_HMAC_KEY` in the runner environment file. Do not put
  Production credentials in this file or print its contents.
- The config inputs are `PREVIEW_DATABASE_ID`, `PREVIEW_DATABASE_NAME`,
  `PREVIEW_WORKER_NAME`, `PREVIEW_UPSTREAM_BASE_URL`,
  `PREVIEW_QUOTA_LIMIT_STANDARD`, `PREVIEW_QUOTA_LIMIT_MINI`,
  `PREVIEW_MAX_INPUT_BYTES`, `PREVIEW_DENO_TOKENIZER_ENDPOINT`,
  `PREVIEW_DENO_TOKENIZER_THRESHOLD_BYTES`,
  `PREVIEW_DENO_TOKENIZER_TIMEOUT_MS`,
  `PREVIEW_OCTG_RELAY_ENVIRONMENT=preview`,
  `PREVIEW_OCTG_RELAY_INGRESS_ENDPOINT` (HTTPS origin only), and the registered
  `PREVIEW_RELAY_CPU_GATE_MINI_CLIENT_ID` and
  `PREVIEW_RELAY_CPU_GATE_MINI_MODEL=gpt-5-mini` fixture identifiers.
- The Preview fixture client must be enabled and the model must resolve to the
  `MINI` pool. The Worker config generator omits Production Deno/Relay values,
  enables Relay only for the explicit Preview setting, and rejects any
  Production endpoint or secret in the generated config.

### Execute Stage 1

Run from the repository root with Node.js 22 or later. Set
`PREVIEW_STAGE1_ENV_FILE` to the protected Preview-only environment file and
`OCTG_STAGE1_EVIDENCE_DIR` to a protected directory outside the repository for
the journal and safe run ledger. The Node `--env-file` option reads assignments
without evaluating them as shell code; process environment values take
precedence over file values. Run `npm test` and `npm run typecheck` on the exact
candidate revision before committing it; the command below refuses a dirty
worktree and records that committed `HEAD` as the source revision.

```bash
set -euo pipefail
umask 077
: "${PREVIEW_STAGE1_ENV_FILE:?set the protected Preview-only env file path}"
: "${OCTG_STAGE1_EVIDENCE_DIR:?set a protected evidence directory outside the repository}"
test -f "$PREVIEW_STAGE1_ENV_FILE"
test ! -e "$OCTG_STAGE1_EVIDENCE_DIR" || {
  printf '%s\n' 'Use a new evidence directory for every Stage 1 run.' >&2
  exit 2
}
mkdir -m 700 "$OCTG_STAGE1_EVIDENCE_DIR"
test -z "$(git status --porcelain)" || {
  printf '%s\n' 'Stage 1 requires a clean, committed candidate source tree.' >&2
  exit 2
}
source_revision="$(git rev-parse HEAD)"
case "$source_revision" in
  *[!0-9a-f]*|'') printf '%s\n' 'Invalid source revision.' >&2; exit 2 ;;
esac
test "${#source_revision}" -eq 40
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

node --env-file="$PREVIEW_STAGE1_ENV_FILE" \
  scripts/preview-worker-config.mjs \
  apps/gateway-worker/wrangler.jsonc \
  "$temporary_dir/wrangler-preview.jsonc" deno

node --env-file="$PREVIEW_STAGE1_ENV_FILE" \
  scripts/run-relay-cpu-gate.mjs stage1 --execute \
  --origin=https://octg-gateway-preview.yohi-consadole12.workers.dev \
  --worker-name=octg-gateway-preview \
  --pool=MINI --model=gpt-5-mini \
  --journal="$OCTG_STAGE1_EVIDENCE_DIR/journal.json" \
  --ledger="$OCTG_STAGE1_EVIDENCE_DIR/ledger.json" \
  --source-revision="$source_revision" \
  --preview-config="$temporary_dir/wrangler-preview.jsonc"
```

The runner uploads a candidate containing only the fresh
`OCTG_RELAY_CPU_GATE_AUTH_TOKEN`. Wrangler versions preserve Secrets omitted
from the upload, and the adapter verifies all six persistent Preview Worker
Secret bindings exist first. See the [Wrangler Secrets
documentation](https://developers.cloudflare.com/workers/configuration/secrets/)
and [`versions secret delete` reference](https://developers.cloudflare.com/workers/wrangler/commands/workers/#versions-secret-delete).
The runner performs authenticated Preview preflight before measurement;
`--execute` explicitly enables the remote operations. Each measured HTTP attempt
gets a fresh, non-secret `octg_cpu_gate_measurement_id` query value. Cloudflare
Workers Observability must retain query strings in `$metadata.url`; the telemetry
normalizer requires the value and the evidence reducer joins each ledger call to
one exact platform event. Missing, redacted, duplicate, or mismatched IDs block
the series. The ID is not an auth token and is never placed in request/response
bodies or application logs.

The runner JSON summary reports `cleanupVerified` separately from runner
`status`: runner `PASS` means the planned workload completed, not that the CPU
gate passed. Keep the journal and ledger protected for telemetry acquisition
and evidence reduction; do not add raw telemetry or credentials to Git.

### Automatic cleanup and recovery

On success, failure, or handled cancellation, Stage 1 first closes and recovers
known operations. Only after closure is proven does it delete
`OCTG_RELAY_CPU_GATE_AUTH_TOKEN` with the versioned secret-delete operation,
deploy the deletion-produced version at 100%, and verify that the temporary
binding is absent, the remaining bindings are unchanged, the deployed version
is exact, and CPU-gate control routes return 404. This preserves all six
persistent Preview Worker Secrets. The temporary secrets file is removed in a
`finally` block.

After a successful or failed Stage 1 attempt, acquire authoritative telemetry
and reduce each emitted series ledger separately. The following loop uses only
the safe version/window identifiers from each protected series ledger; it does
not print credential values or telemetry contents:

```bash
shopt -s nullglob
series_ledgers=("$OCTG_STAGE1_EVIDENCE_DIR"/ledger.json.[0-9]*.json)
test "${#series_ledgers[@]}" -gt 0
for series_ledger in "${series_ledgers[@]}"; do
  series_base="${series_ledger%.json}"
  windows_file="${series_base}.windows.json"
  telemetry_file="${series_base}.jsonl"
  telemetry_meta="${series_base}.meta.json"
  summary_file="${series_base}.summary.json"
  node --input-type=module - "$series_ledger" "$windows_file" <<'NODE'
import { readFile, writeFile } from "node:fs/promises";

const [ledgerPath, windowsPath] = process.argv.slice(2);
const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
if (!Array.isArray(ledger.windows) || ledger.windows.length === 0) {
  throw new Error("Series ledger has no measured windows");
}
const windows = ledger.windows.map(({ windowStartMs, windowEndMs }) => [windowStartMs, windowEndMs]);
if (windows.some(([start, end]) => !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start)) {
  throw new Error("Series ledger contains an invalid measured window");
}
await writeFile(windowsPath, `${JSON.stringify(windows)}\n`, { mode: 0o600 });
NODE
  script_name="$(node --input-type=module - "$series_ledger" <<'NODE'
import { readFile } from "node:fs/promises";
const ledger = JSON.parse(await readFile(process.argv[2], "utf8"));
process.stdout.write(ledger.scriptName);
NODE
  )"
  script_version="$(node --input-type=module - "$series_ledger" <<'NODE'
import { readFile } from "node:fs/promises";
const ledger = JSON.parse(await readFile(process.argv[2], "utf8"));
process.stdout.write(ledger.candidateScriptVersion);
NODE
  )"
  if node --env-file="$PREVIEW_STAGE1_ENV_FILE" scripts/relay-cpu-telemetry.mjs \
    --script-name="$script_name" --script-version="$script_version" \
    --execution-model=stateless --windows-json="$windows_file" \
    --out="$telemetry_file" --meta-out="$telemetry_meta"; then
    telemetry_exit_code=0
  else
    telemetry_exit_code=$?
    : >"$telemetry_file"
    printf '{"queryComplete":false,"samplingVerified":false,"paginationComplete":false,"truncationObserved":true,"normalizedInvocationCount":0,"windows":[],"telemetryExitCode":%d}\n' \
      "$telemetry_exit_code" >"$telemetry_meta"
  fi
  if node scripts/relay-cpu-evidence.mjs --ledger="$series_ledger" \
    --telemetry="$telemetry_file" --telemetry-meta="$telemetry_meta" \
    --out="$summary_file"; then
    evidence_exit_code=0
  else
    evidence_exit_code=$?
  fi
  printf '{"telemetryExitCode":%d,"evidenceExitCode":%d}\n' \
    "$telemetry_exit_code" "$evidence_exit_code" >"${series_base}.status.json"
done
```

Every reducer summary must include p50/p90/p95/p99/max, `exceededCpu`, and the
matched invocation count. Missing or incomplete telemetry, sampling metadata
other than a verified interval of `1`, truncated records, or any
source/version/window/correlation-ID mismatch is `BLOCKED / INCOMPLETE`. Use the Task 6
acceptance thresholds and conditional branch rules in the [CPU headroom plan](./superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md); a local test pass is not Stage 1 evidence.

If `cleanupVerified` is false, cleanup could not be proven. Keep the protected
journal and ledger, stop further Preview runs, and use the approved Preview
recovery path before retrying. Do not manually delete the gate Secret or point
traffic at another version while a grant may still be live. If cleanup is
verified but runner status is `BLOCKED`, retain the partial evidence and treat
the affected series as incomplete. Any Stage 1 rerun requires a fresh per-run
bearer and replaces earlier evidence. Stage 1 does not authorize Production
changes or select the conditional Tasks 7/8 by itself; only the completed
authoritative evidence reducer outcome selects that branch.

## Responses Prepare Rollout and Acceptance

Before the normative sequence, document a separate **Preview artifact staging**
procedure that runs while the candidate pull request is still open:

- Configure only the isolated Preview input-limit and prepare sources, and
  record the UTC configuration-complete time after those values are saved.
- Keep the candidate pull request open at the recorded head SHA. Use a
  same-repository `Preview Smoke Test` attempt whose `event` is
  `pull_request`, whose `headSha` is that exact SHA, and whose
  `deno-version-smoke` job finishes successfully after configuration. A
  completed run from before configuration is not a qualifying attempt; use the
  existing GitHub Actions re-run operation when necessary.
- Correlate the qualifying attempt with exactly one new valid-auth version
  by comparing the version ID set immediately before and after the attempt,
  then matching `pr-<number>-deno-valid` and the message containing the exact
  candidate SHA. Record the run ID, attempt, candidate SHA, and exact version
  ID; restoring traffic does not delete this deployable version artifact.
- Treat this as ordinary PR smoke and artifact staging only. It is not the
  approximately 74k-token large-body acceptance canary and it is not a gate
  for production configuration, validation, upload, or deployment.

Carry the exact staged version ID forward after the candidate merge. Step 4
must not open or update a pull request or rely on a post-merge `pull_request`
event.

The normative runbook order is:

1. Independently deploy or verify the Deno `/prepare` service and its health/authentication behavior. This prerequisite is outside the Worker workflow's pre-mutation validation boundary.
2. Configure the complete production pair with an HTTPS `/prepare` endpoint and trimmed threshold `"1"`, then let the authorized `master` push invoke `deploy-production`.
3. Confirm the production validator runs before D1 migration, Worker version upload, and Worker version deployment, and that both prepare bindings are uploaded directly without empty placeholders.
4. After production deployment, read the current isolated Preview deployment and require exactly one 100% base version. Re-add the recorded valid-auth Preview Worker version at 0% beside that base at 100%, read back and verify both memberships, then use Cloudflare Version Override for the large Responses canary. Do not trigger a new Preview workflow or open/update a pull request here. After the canary, including failure or timeout, restore the captured base to 100% and verify that the candidate is no longer a current-deployment member. Keep Preview configuration and credentials isolated from production; a cleanup failure must be reported alongside, and never replace, the original canary result.
5. Capture `octg.canary.result` records and `wrangler tail --format=json --version-id <candidate-version>` output only in protected temporary files. Require request-result, resource-stage, CPU-outcome, ordering, and bounded request-audit assertions for Preview, production, representative peak, and rollback. Treat the D1 row only as settlement evidence; it never decides quota availability.
6. Run the production canary after the isolated Preview canary, then run the representative peak after concurrency 1 and 2. For rollback, restore a known pre-prepare Worker version and require legacy `body_read`/`parse`/`normalize` stages, no `prepare` stage, the configured legacy tokenization provider, successful reservation/upstream completion, and completed settlement evidence.

### Acceptance criteria

The large Responses canary uses Responses canary mode with synthetic
778240-byte and 1048576-byte bodies at concurrency 1, concurrency 2, and the
configured peak.

The runbook MUST require:

- no `exceededCpu` outcome;
- a successful `prepare` resource stage;
- Deno as the tokenization provider for the prepared route;
- correct quota settlement for every successful request;
- no `body_read`, `parse`, or `normalize` legacy body stages for the prepared
  route.

The rollback matrix MUST cover:

- new Deno with old Worker: successful legacy routing;
- old Deno with new Worker: pre-upstream fail-closed;
- Worker rollback to a pre-prepare version: restored legacy routing.

Configure and test the platform-provided Deno allowance alert. When allowance
telemetry is unavailable, record the prepare-unavailable-rate alert as the
capacity signal.

Retain only request IDs, revision IDs, resource stage outcomes, CPU/wall-time
buckets, and safe `octg.canary.result` records. Do not retain prompt text,
response bodies, markers, client keys, bearer tokens, or secrets.

Use the following executable commands from the controlled acceptance procedure.
They create protected temporary files and remove them after use; never print or
persist the synthetic payload, client key, Deno authentication value, or
upstream response body.

```bash
set -euo pipefail
umask 077
  : "${PREVIEW_PR_NUMBER:?set the still-open same-repository pull request number}"
  : "${PREVIEW_HEAD_SHA:?set the exact candidate pull request head SHA}"
  : "${PREVIEW_CONFIGURED_AT:?record the UTC time immediately after Preview variables were saved}"
  : "${PREVIEW_WORKER_NAME:?set the isolated Preview Worker name}"
  : "${PREVIEW_RUN_ID:?set the candidate pull request Preview Smoke Test run ID}"
  : "${CLOUDFLARE_API_TOKEN:?load the isolated Preview API token without printing it}"
  : "${CLOUDFLARE_ACCOUNT_ID:?set the isolated Preview account ID}"
  preview_pr_file="$(mktemp)"
  preview_run_before_file="$(mktemp)"
  preview_run_after_file="$(mktemp)"
  preview_versions_before_file="$(mktemp)"
  preview_versions_after_file="$(mktemp)"
  trap 'rm -f "$preview_pr_file" "$preview_run_before_file" "$preview_run_after_file" "$preview_versions_before_file" "$preview_versions_after_file"' EXIT
  gh pr view "$PREVIEW_PR_NUMBER" \
    --json state,headRefOid,isCrossRepository > "$preview_pr_file"
  node --input-type=module - "$preview_pr_file" "$PREVIEW_HEAD_SHA" <<'NODE'
import { readFileSync } from "node:fs";

const [path, expectedHeadSha] = process.argv.slice(2);
const pullRequest = JSON.parse(readFileSync(path, "utf8"));
if (!/^[0-9a-f]{40}$/i.test(expectedHeadSha)) throw new Error("Preview head SHA is malformed");
if (pullRequest.state !== "OPEN" || pullRequest.isCrossRepository !== false) {
  throw new Error("Preview candidate must be an open same-repository pull request");
}
if (pullRequest.headRefOid !== expectedHeadSha) {
  throw new Error("Preview pull request head SHA changed");
}
NODE
  gh run view "$PREVIEW_RUN_ID" \
    --json workflowName,event,headSha,status,conclusion,attempt > "$preview_run_before_file"
  initial_attempt="$(node --input-type=module - "$preview_run_before_file" "$PREVIEW_HEAD_SHA" <<'NODE'
import { readFileSync } from "node:fs";

const [path, expectedHeadSha] = process.argv.slice(2);
const run = JSON.parse(readFileSync(path, "utf8"));
if (run.workflowName !== "Preview Smoke Test" || run.event !== "pull_request" || run.headSha !== expectedHeadSha) {
  throw new Error("Preview run is not the expected pull_request workflow for the candidate SHA");
}
if (!Number.isSafeInteger(run.attempt)) throw new Error("Preview run attempt is missing");
process.stdout.write(String(run.attempt));
NODE
  )"
  initial_status="$(node --input-type=module - "$preview_run_before_file" <<'NODE'
import { readFileSync } from "node:fs";
process.stdout.write(String(JSON.parse(readFileSync(process.argv[2], "utf8")).status ?? ""));
NODE
  )"
  if [ "$initial_status" != "completed" ]; then
    gh run watch "$PREVIEW_RUN_ID" || true
  fi
  PREVIEW_PREPARE_VERSION_TAG="pr-${PREVIEW_PR_NUMBER}-deno-valid"
  PREVIEW_PREPARE_VERSION_MESSAGE="pr-${PREVIEW_PR_NUMBER} ${PREVIEW_HEAD_SHA} Deno valid auth"
  ./node_modules/.bin/wrangler versions list \
    --name "$PREVIEW_WORKER_NAME" \
    --json > "$preview_versions_before_file"
  gh run rerun "$PREVIEW_RUN_ID"
  gh run watch "$PREVIEW_RUN_ID" --exit-status
  gh run view "$PREVIEW_RUN_ID" \
    --json workflowName,event,headSha,status,conclusion,attempt,startedAt,jobs > "$preview_run_after_file"
  gh pr view "$PREVIEW_PR_NUMBER" \
    --json state,headRefOid,isCrossRepository > "$preview_pr_file"
  node --input-type=module - "$preview_pr_file" "$PREVIEW_HEAD_SHA" <<'NODE'
import { readFileSync } from "node:fs";

const [path, expectedHeadSha] = process.argv.slice(2);
const pullRequest = JSON.parse(readFileSync(path, "utf8"));
if (pullRequest.state !== "OPEN" || pullRequest.isCrossRepository !== false || pullRequest.headRefOid !== expectedHeadSha) {
  throw new Error("Preview candidate pull request changed during artifact staging");
}
NODE
  PREVIEW_RUN_ATTEMPT="$(node --input-type=module - "$preview_run_after_file" "$PREVIEW_HEAD_SHA" "$PREVIEW_CONFIGURED_AT" "$initial_attempt" <<'NODE'
import { readFileSync } from "node:fs";

const [path, expectedHeadSha, configuredAt, previousAttempt] = process.argv.slice(2);
const run = JSON.parse(readFileSync(path, "utf8"));
if (run.workflowName !== "Preview Smoke Test" || run.event !== "pull_request" || run.headSha !== expectedHeadSha) {
  throw new Error("Preview run is not the expected pull_request workflow for the candidate SHA");
}
if (run.status !== "completed" || run.conclusion !== "success") {
  throw new Error("Preview Smoke Test did not complete successfully");
}
if (!Number.isSafeInteger(run.attempt) || run.attempt <= Number(previousAttempt)) {
  throw new Error("Preview workflow attempt was not re-run after configuration");
}
const configuredTimestamp = Date.parse(configuredAt);
const startedTimestamp = typeof run.startedAt === "string" ? Date.parse(run.startedAt) : NaN;
if (!configuredAt.endsWith("Z") || !Number.isFinite(configuredTimestamp) || !Number.isFinite(startedTimestamp) || startedTimestamp <= configuredTimestamp) {
  throw new Error("Preview workflow attempt did not start after configuration");
}
const denoJobs = Array.isArray(run.jobs)
  ? run.jobs.filter((job) => job?.name === "deno-version-smoke")
  : [];
if (denoJobs.length !== 1 || denoJobs[0]?.conclusion !== "success") {
  throw new Error("deno-version-smoke did not complete successfully");
}
process.stdout.write(String(run.attempt));
NODE
  )"
  ./node_modules/.bin/wrangler versions list \
    --name "$PREVIEW_WORKER_NAME" \
    --json > "$preview_versions_after_file"
  PREVIEW_PREPARE_VERSION_ID="$(node --input-type=module - "$preview_versions_before_file" "$preview_versions_after_file" "$PREVIEW_PREPARE_VERSION_TAG" "$PREVIEW_PREPARE_VERSION_MESSAGE" <<'NODE'
import { readFileSync } from "node:fs";

const [beforePath, afterPath, expectedTag, expectedMessage] = process.argv.slice(2);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const readVersions = (path) => {
  const versions = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(versions)) throw new Error("Wrangler versions list JSON must be an array");
  return versions.map((version) => {
    const id = version?.id;
    if (typeof id !== "string" || !uuid.test(id)) throw new Error("Preview Worker version ID is not a UUID");
    return { id, tag: version?.annotations?.["workers/tag"], message: version?.annotations?.["workers/message"] };
  });
};
const before = readVersions(beforePath);
const after = readVersions(afterPath);
const beforeIds = new Set(before.map((version) => version.id));
const candidates = after.filter((version) =>
  !beforeIds.has(version.id) &&
  version.tag === expectedTag &&
  version.message === expectedMessage,
);
if (candidates.length !== 1) {
  throw new Error("expected exactly one new valid-auth Preview Worker version for the workflow attempt");
}
process.stdout.write(candidates[0].id);
NODE
  )"
  if ! [[ "$PREVIEW_PREPARE_VERSION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo "Preview artifact identity is malformed" >&2
    exit 1
  fi
  export PREVIEW_PREPARE_VERSION_ID
  export PREVIEW_RUN_ATTEMPT
```

Define these protected acceptance helpers in the operator shell before running
the canary blocks. They consume only protected capture files; credentials are
passed to the leak check through standard input and never as process arguments.
The third argument to `assert_no_canary_secret_leak` is the runtime shared-auth
value for the same control plane: use `DENO_PREVIEW_TOKENIZER_AUTH_TOKEN` for
Preview and `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN` for Production and rollback.
Do not use the separate `DENO_DEPLOY_TOKEN` management credential.

```bash
assert_telemetry() {
  local canary_output="$1"
  local telemetry_output="$2"
  local expected_worker_version="$3"
  local expected_concurrencies="$4"
  local expected_mode="$5"
  local expected_legacy_provider="${6:-}"

  CANARY_OUTPUT="$canary_output" \
  TELEMETRY_OUTPUT="$telemetry_output" \
  EXPECTED_WORKER_VERSION="$expected_worker_version" \
  EXPECTED_CONCURRENCIES="$expected_concurrencies" \
  EXPECTED_MODE="$expected_mode" \
  EXPECTED_LEGACY_TOKENIZATION_PROVIDER="$expected_legacy_provider" \
  node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";

const fail = (message) => {
  throw new Error(`telemetry assertion failed: ${message}`);
};
const requestIdPattern = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
const mode = process.env.EXPECTED_MODE;
const expectedWorkerVersion = process.env.EXPECTED_WORKER_VERSION;
const expectedLegacyProvider = process.env.EXPECTED_LEGACY_TOKENIZATION_PROVIDER;
if (!expectedWorkerVersion) fail("expected Worker version is missing");
if (mode !== "prepared" && mode !== "legacy") fail("expected mode is invalid");
if (mode === "legacy" && !["deno", "cloudflare_do"].includes(expectedLegacyProvider)) {
  fail("expected legacy tokenization provider is invalid");
}

const expectedKeys = process.env.EXPECTED_CONCURRENCIES.split(",").map((value) => {
  const concurrency = Number(value.trim());
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0 || concurrency > 64) {
    fail("expected concurrency is invalid");
  }
  return Array.from({ length: concurrency }, (_, ordinal) => `${concurrency}/${ordinal}`);
}).flat();
const expectedKeySet = new Set(expectedKeys);
if (expectedKeySet.size !== expectedKeys.length) fail("expected concurrency list contains duplicates");

const canaryRecords = readFileSync(process.env.CANARY_OUTPUT, "utf8").split(/\r?\n/).flatMap((line) => {
  try {
    const value = JSON.parse(line);
    return value.event === "octg.canary.result" ? [value] : [];
  } catch {
    return [];
  }
});
if (canaryRecords.length !== expectedKeySet.size) fail("unexpected canary result count");
const requestIds = new Set();
for (const record of canaryRecords) {
  const key = `${record.concurrency}/${record.ordinal}`;
  if (!expectedKeySet.delete(key)) fail("unexpected or duplicate canary ordinal");
  if (record.outcome !== "response" || record.status !== 200) fail("canary HTTP result failed");
  if (!requestIdPattern.test(record.requestId ?? "")) fail("canary request ID is missing or invalid");
  if (record.workerVersion !== expectedWorkerVersion) fail("canary Worker version mismatch");
  if (requestIds.has(record.requestId)) fail("canary request ID is duplicated");
  requestIds.add(record.requestId);
}
if (expectedKeySet.size !== 0) fail("canary result is missing");

const stageEvents = [];
const exceededCpu = [];
let order = 0;
const visit = (value, lineNumber) => {
  if (Array.isArray(value)) {
    value.forEach((entry) => visit(entry, lineNumber));
    return;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try { visit(JSON.parse(text), lineNumber); } catch { /* non-JSON log text */ }
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (value.event === "octg.resource_stage") stageEvents.push({ ...value, order: order++, lineNumber });
  if (value.outcome === "exceededCpu") exceededCpu.push(value);
  Object.values(value).forEach((entry) => visit(entry, lineNumber));
};

for (const [lineNumber, line] of readFileSync(process.env.TELEMETRY_OUTPUT, "utf8").split(/\r?\n/).entries()) {
  if (line.trim() === "") continue;
  try { visit(JSON.parse(line), lineNumber); } catch { /* missing expected events fail below */ }
}
if (exceededCpu.length !== 0) fail("Worker reported exceededCpu");

const forRequest = (requestId) => stageEvents.filter((event) => event.requestId === requestId);
const assertNoStage = (events, stages) => {
  if (events.some((event) => stages.includes(event.stage))) fail("forbidden resource stage observed");
};
const requireSuccessfulPair = (events, stage, predicate) => {
  const matching = events.filter((event) => event.stage === stage);
  const starts = matching.filter((event) => event.phase === "start");
  const finishes = matching.filter((event) => event.phase === "finish");
  if (starts.length !== 1 || finishes.length !== 1) fail(`stage ${stage} is not exactly one start/finish pair`);
  const [start] = starts;
  const [finish] = finishes;
  if (start.revisionId !== expectedWorkerVersion || finish.revisionId !== expectedWorkerVersion) {
    fail(`stage ${stage} has an unexpected Worker revision`);
  }
  if (start.order >= finish.order || finish.outcome !== "success" || !predicate(finish)) {
    fail(`stage ${stage} did not satisfy its success assertion`);
  }
  return { start, finish };
};

for (const requestId of requestIds) {
  const events = forRequest(requestId);
  if (events.length === 0) fail("request has no correlated resource-stage telemetry");
  if (events.some((event) => event.revisionId !== expectedWorkerVersion)) {
    fail("request has telemetry from an unexpected Worker revision");
  }

  if (mode === "prepared") {
    assertNoStage(events, ["body_read", "parse", "normalize", "tokenize"]);
    requireSuccessfulPair(events, "prepare", (finish) => finish.tokenizationProvider === "deno");
  } else {
    assertNoStage(events, ["prepare"]);
    requireSuccessfulPair(events, "body_read", () => true);
    requireSuccessfulPair(events, "parse", () => true);
    requireSuccessfulPair(events, "normalize", () => true);
    requireSuccessfulPair(events, "tokenize", (finish) => finish.tokenizationProvider === expectedLegacyProvider);
  }

  const quota = requireSuccessfulPair(events, "quota_reserve", (finish) => finish.quotaReserved === true);
  const upstream = requireSuccessfulPair(events, "upstream", (finish) => finish.upstreamReached === true);
  if (quota.finish.order >= upstream.start.order) fail("upstream started before quota reservation finished");
}
console.log("resource-stage telemetry assertions passed");
NODE
}

assert_no_canary_secret_leak() {
  local canary_output="$1"
  local telemetry_output="$2"
  local deno_auth_token="${3-}"

  printf '%s\0%s\0%s\0' "$CANARY_BODY_MARKER" "$OCTG_CANARY_CLIENT_KEY" "$deno_auth_token" |
    CANARY_OUTPUT="$canary_output" \
    TELEMETRY_OUTPUT="$telemetry_output" \
    node --input-type=module -e '
      import { readFileSync } from "node:fs";

      const [marker, clientKey, denoAuthToken] = readFileSync(0, "utf8").split("\0");
      if ([marker, clientKey, denoAuthToken].some((secret) => secret === undefined || secret.length === 0)) {
        throw new Error("canary secret validation input is incomplete");
      }
      const secrets = [marker, clientKey, denoAuthToken];
      const paths = [process.env.CANARY_OUTPUT, process.env.TELEMETRY_OUTPUT];
      if (paths.some((path) => typeof path !== "string")) {
        throw new Error("canary capture path is missing");
      }
      const captures = paths.map((path) => readFileSync(path, "utf8"));
      if (captures.some((capture) => secrets.some((secret) => capture.includes(secret)))) {
        throw new Error("canary marker, client key, or Deno shared auth appeared in protected capture");
      }
    '
}

build_tail_readiness_url() {
  local target_url="$1"
  local ready_marker="$2"

  node --input-type=module - "$target_url" "$ready_marker" <<'NODE'
const [targetUrl, readyMarker] = process.argv.slice(2);
const url = new URL(targetUrl);
url.searchParams.set("octg_tail_ready", readyMarker);
process.stdout.write(url.toString());
NODE
}

wait_for_tail_ready() {
  local tail_pid="$1"
  local telemetry_output="$2"
  local ready_url="$3"
  local ready_marker="$4"
  local timeout_seconds="${5:-30}"
  local deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    if grep -Fq -- "$ready_marker" "$telemetry_output"; then
      return 0
    fi
    if ! kill -0 "$tail_pid" 2>/dev/null; then
      wait "$tail_pid" 2>/dev/null || true
      echo "wrangler tail exited before the readiness probe was observed" >&2
      return 1
    fi
    curl --silent --output /dev/null \
      --connect-timeout 2 --max-time 2 \
      --request GET "$ready_url" || true
    sleep 1
  done

  if grep -Fq -- "$ready_marker" "$telemetry_output"; then
    return 0
  fi
  echo "wrangler tail readiness was not observed within ${timeout_seconds}s" >&2
  return 1
}

assert_audit_completed() {
  local canary_output="$1"
  local audit_output="$2"
  local database="$3"
  local audit_sql

  audit_sql="$(node --input-type=module - "$canary_output" <<'NODE'
import { readFileSync } from "node:fs";

const requestIdPattern = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
const records = readFileSync(process.argv[2], "utf8").split(/\r?\n/).flatMap((line) => {
  try {
    const value = JSON.parse(line);
    return value.event === "octg.canary.result" ? [value] : [];
  } catch {
    return [];
  }
});
const ids = records.map((record) => record.requestId);
if (ids.length === 0 || ids.some((id) => !requestIdPattern.test(id ?? "")) || new Set(ids).size !== ids.length) {
  throw new Error("canary request ID set is missing, invalid, or duplicated");
}
process.stdout.write(`SELECT request_id, status FROM requests WHERE request_id IN (${ids.map((id) => `'${id}'`).join(",")}) ORDER BY request_id`);
NODE
  )"

  for attempt in 1 2 3 4 5 6; do
    if ./node_modules/.bin/wrangler d1 execute "$database" \
      --remote \
      --json \
      --command "$audit_sql" >"$audit_output"; then
      if node --input-type=module - "$canary_output" "$audit_output" <<'NODE'
import { readFileSync } from "node:fs";

const resultRecords = readFileSync(process.argv[2], "utf8").split(/\r?\n/).flatMap((line) => {
  try {
    const value = JSON.parse(line);
    return value.event === "octg.canary.result" ? [value] : [];
  } catch {
    return [];
  }
});
const expectedIds = new Set(resultRecords.map((record) => record.requestId));
const rows = [];
const visit = (value) => {
  if (Array.isArray(value)) return value.forEach(visit);
  if (value === null || typeof value !== "object") return;
  if (typeof value.request_id === "string" && typeof value.status === "string") rows.push(value);
  Object.values(value).forEach(visit);
};
visit(JSON.parse(readFileSync(process.argv[3], "utf8")));
for (const requestId of expectedIds) {
  const matching = rows.filter((row) => row.request_id === requestId);
  if (matching.length !== 1 || matching[0].status !== "completed") process.exit(1);
}
NODE
      then
        return 0
      fi
    fi
    if [ "$attempt" = 6 ]; then
      echo "canary settlement evidence was not completed" >&2
      return 1
    fi
    sleep 5
  done
}
```

For each canary, capture the version-filtered tail and canary results before
asserting them. The non-sensitive readiness probe is a GET with a unique query
marker; its expected 404 response is irrelevant, and the canary starts only
after that marker is observed in the JSON tail capture.

```bash
canary_output="$(mktemp)"
telemetry_output="$(mktemp)"
audit_output="$(mktemp)"
tail_pid=""
trap 'if [ -n "${tail_pid:-}" ]; then kill "$tail_pid" 2>/dev/null || true; wait "$tail_pid" 2>/dev/null || true; tail_pid=""; fi; rm -f "$canary_output" "$telemetry_output" "$audit_output"' EXIT
tail_ready_marker="octg_tail_ready_${RANDOM}_${RANDOM}"
tail_ready_url="$(build_tail_readiness_url "$OCTG_CANARY_URL" "$tail_ready_marker")"
./node_modules/.bin/wrangler tail "$WORKER_NAME" \
  --format=json --version-id="$EXPECTED_WORKER_VERSION" >"$telemetry_output" 2>&1 &
tail_pid=$!
if ! wait_for_tail_ready "$tail_pid" "$telemetry_output" "$tail_ready_url" "$tail_ready_marker" 30; then
  exit 1
fi
CANARY_PAYLOAD_PATH="$PAYLOAD_FILE" \
  npm run canary:worker -- --env-file=admin.env --concurrency=1,2 | tee "$canary_output"
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" || true
tail_pid=""
```

Run the protected telemetry parser and bounded request-audit query against those
files using the helper definitions above. `assert_telemetry` must be run with
`prepared` for Preview, production, and peak, and with `legacy` plus the retained
provider for rollback. `assert_no_canary_secret_leak` and
`assert_audit_completed` are the corresponding assertions; all must exit
successfully. The D1 query is settlement evidence only. See [SPEC.md](../SPEC.md)
for the complete routing and validation contract.

Preview large-body acceptance uses the pre-staged candidate, verifies its
current deployment membership before Version Override, restores the captured
base at 100% in the same protected shell on every exit path, and then runs:

```bash
assert_telemetry "$preview_canary_output" "$preview_telemetry_output" \
  "$PREVIEW_PREPARE_VERSION_ID" "1,2" prepared ""
assert_no_canary_secret_leak "$preview_canary_output" "$preview_telemetry_output" \
  "$DENO_PREVIEW_TOKENIZER_AUTH_TOKEN"
assert_audit_completed "$preview_canary_output" "$preview_audit_output" "$PREVIEW_D1_DATABASE"
```

The production canary runs only after Preview acceptance and uses the deployed
production version without Version Override:

```bash
assert_telemetry "$production_canary_output" "$production_telemetry_output" \
  "$EXPECTED_PRODUCTION_WORKER_VERSION" "1,2" prepared ""
assert_no_canary_secret_leak "$production_canary_output" "$production_telemetry_output" \
  "$PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN"
assert_audit_completed "$production_canary_output" "$production_audit_output" "$CANARY_D1_DATABASE"
```

The representative production peak runs only after concurrency 1 and 2 pass:

```bash
assert_telemetry "$peak_canary_output" "$peak_telemetry_output" \
  "$EXPECTED_PRODUCTION_WORKER_VERSION" "1,2,${CANARY_PEAK_CONCURRENCY}" prepared ""
assert_no_canary_secret_leak "$peak_canary_output" "$peak_telemetry_output" \
  "$PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN"
assert_audit_completed "$peak_canary_output" "$peak_audit_output" "$CANARY_D1_DATABASE"
```

## Admin Policy Changes

The Admin API can change client policies and model registry entries.

After a policy or model update, the Worker invalidates its local configuration cache on the mutation path. Normal loads otherwise use a short-lived cache.

Treat these changes as production configuration changes:

- document intent;
- verify the affected client/model;
- watch quota and errors;
- avoid using `PAID_SHARED` as though it enables a paid path.

Mutating Admin calls from browsers must be same-origin. CLI calls without an `Origin` header are allowed after Access authentication.

## Responses Relay Rollout and Rollback

The relay moves decision orchestration to a `RelayDecisionController` Durable
Object and upstream forwarding/usage extraction to Deno while QuotaController
stays the only quota authority. [SPEC.md section 19](../SPEC.md) is the
normative contract; this section covers rollout operations only.

### Deployment order

Deploy Deno first for each immutable revision, then roll the Worker with the
Durable Object migration. The checked-in workflow chain encodes this: the Deno
Deploy workflow deploys and probes the Deno revision, then calls
`deploy-production.yml`, which re-checks out the same revision and gates remote
mutations on the current `master` SHA matching the Deno workflow's SHA. The
Worker rollout applies the `v3` SQLite migration for
`RelayDecisionController`; its validation step refuses to mutate anything when
the migration or the `RELAY_DECISION_CONTROLLER` binding is missing.

Enable the relay with `OCTG_RELAY_ENABLED=true` only per environment. Start in
Preview. A Production subset is a canary-gated manual action, never an
automated workflow variable.

### CPU evidence classes

Record CPU as separate series and never pool them together:

- each stateless Worker class (ingress buckets and the decision, activation,
  renewal, and terminal callbacks): 10 ms Free limit, p99 at most 5 ms, max at
  most 7 ms, and `exceededCpu = 0`;
- `RelayDecisionController.decide` and every QuotaController RPC class
  (`admitRelay`, activation, renewal, terminal): the documented 30,000 ms DO
  default, p99 at most 24,000 ms, max below 30,000 ms;
- record p50/p90/p95/p99/max, `exceededCpu`, sample counts, and tail margins per
  class; a DO pass never excuses a stateless Worker failure.

A rollout gate requires zero CPU failures in every required Worker and DO
series, correct quota behavior for injected failures, and Gateway B matches,
reservation/settlement/uncertainty counts, and Deno capacity recorded without
payloads or credentials.

### Fault windows the rollout must exercise

At every matrix boundary assert the quota invariant: one grant causes at most
one upstream attempt, one `QuotaController.admitRelay` transaction never
leaves a partial reservation/lease/grant, and neither quota nor audit state
depends on D1 writes. The required windows include Worker termination after
atomic admission
(identical retry returns the stored grant), lost `admitRelay` acknowledgement,
duplicate shard dispatch, stale lease generation, Deno termination after
activation (uncertain, never release), terminal conflicts, Preview credentials
at Production callbacks, UTC-midnight late callbacks, reconciliation before and
after terminalization, expired authorized/attempted grants, and terminal-record
retention at day finalization.

### Relay rollback

Roll back the Worker to the legacy `/prepare` route only when it is safe, and
keep Deno's relay endpoint compatible during the rollback window. While any
relay grant is unresolved:

- retain the `/internal/relay/v1/*` Worker callbacks;
- retain the `RELAY_DECISION_CONTROLLER` and `QUOTA_CONTROLLER` Durable Object
  bindings;
- do not remove the `v3` migration tag or the relay secrets.

Reconcile or otherwise resolve outstanding grants first: next-day
reconciliation terminalizes grants that never resolved, and only then may the
callbacks, secrets, or migrations be removed. Never route unresolved requests
to a different control plane. Quota decisions never depend on D1 writes, so a
D1 rollback cannot strand a grant that the Durable Object still owns.

## Rollback

Prefer a Worker version rollback that preserves D1 and Durable Object compatibility.

Before rollback:

1. identify the current and target Worker version;
2. check whether the newer deployment introduced D1 migrations;
3. check whether it introduced a new Durable Object migration tag;
4. verify the target code can operate against the already-applied persistent schema.

Do not rewrite or remove an already applied Durable Object migration tag to make rollback easier.

If rollback is required, restore `KNOWN_PREPARE_FREE_VERSION_ID` instead of
omitting prepare variables from a later `--keep-vars` upload. Start a new
protected capture and canary run before inspecting rollback behavior. Set
`EXPECTED_LEGACY_TOKENIZATION_PROVIDER` to `deno` only when the retained legacy
Deno tokenizer group and threshold select it for this payload; otherwise use
`cloudflare_do`.

```bash
set -euo pipefail
umask 077
: "${OCTG_CANARY_URL:?set the production canary URL}"
: "${OCTG_CANARY_ALLOWED_HOSTS:?set the production canary host allowlist}"
: "${OCTG_CANARY_CLIENT_KEY:?set the production canary client key}"
: "${KNOWN_PREPARE_FREE_VERSION_ID:?set the known rollback version}"
: "${PRODUCTION_WORKER_NAME:?set the production Worker name}"
: "${CANARY_D1_DATABASE:?set the production D1 database name}"
: "${EXPECTED_LEGACY_TOKENIZATION_PROVIDER:?set deno or cloudflare_do from retained configuration}"
export CANARY_BODY_MARKER="octg_canary_body_marker_${RANDOM}_${RANDOM}"
payload_file="$(mktemp)"
canary_output="$(mktemp)"
telemetry_output="$(mktemp)"
audit_output="$(mktemp)"
tail_pid=""
trap 'if [ -n "${tail_pid:-}" ]; then kill "$tail_pid" 2>/dev/null || true; wait "$tail_pid" 2>/dev/null || true; tail_pid=""; fi; rm -f "$payload_file" "$canary_output" "$telemetry_output" "$audit_output"' EXIT
tail_ready_marker="octg_tail_ready_${RANDOM}_${RANDOM}"
tail_ready_url="$(build_tail_readiness_url "$OCTG_CANARY_URL" "$tail_ready_marker")"
node --input-type=module - "$payload_file" "$CANARY_BODY_MARKER" <<'NODE'
import { writeFileSync } from "node:fs";

const [payloadPath, marker] = process.argv.slice(2);
writeFileSync(payloadPath, JSON.stringify({
  model: "gpt-5",
  input: `${marker} ${"token ".repeat(74_000)}`,
  max_output_tokens: 16,
}), { mode: 0o600 });
NODE
./node_modules/.bin/wrangler versions deploy \
  "${KNOWN_PREPARE_FREE_VERSION_ID}@100%" \
  --config apps/gateway-worker/wrangler.jsonc \
  --message "Rollback to pre-prepare Worker version" \
  --yes
./node_modules/.bin/wrangler tail "$PRODUCTION_WORKER_NAME" \
  --format=json \
  --version-id="$KNOWN_PREPARE_FREE_VERSION_ID" >"$telemetry_output" 2>&1 &
tail_pid=$!
if ! wait_for_tail_ready "$tail_pid" "$telemetry_output" "$tail_ready_url" "$tail_ready_marker" 30; then
  exit 1
fi
CANARY_PAYLOAD_PATH="$payload_file" \
  npm run canary:worker -- --env-file=admin.env --concurrency=1,2 | tee "$canary_output"
sleep 10
kill "$tail_pid"
wait "$tail_pid" || true
tail_pid=""
```

Validate the exact rollback result set before parsing resource telemetry:

```bash
EXPECTED_CONCURRENCIES=1,2 \
EXPECTED_WORKER_VERSION="$KNOWN_PREPARE_FREE_VERSION_ID" \
node --input-type=module - "$canary_output" <<'NODE'
import { readFileSync } from "node:fs";

const [path] = process.argv.slice(2);
const expectedVersion = process.env.EXPECTED_WORKER_VERSION;
const concurrencies = process.env.EXPECTED_CONCURRENCIES.split(",").map(Number);
const expected = new Set(concurrencies.flatMap((concurrency) =>
  Array.from({ length: concurrency }, (_, ordinal) => `${concurrency}/${ordinal}`),
));
const records = readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
  try {
    const value = JSON.parse(line);
    return value.event === "octg.canary.result" ? [value] : [];
  } catch {
    return [];
  }
});
if (records.length !== expected.size) throw new Error("unexpected canary result count");
for (const record of records) {
  const key = `${record.concurrency}/${record.ordinal}`;
  if (!expected.delete(key)) throw new Error("unexpected canary concurrency or ordinal");
  if (record.outcome !== "response" || record.status !== 200) throw new Error("rollback HTTP response failed");
  if (!/^req_[0-9A-HJKMNP-TV-Z]{26}$/.test(record.requestId ?? "")) throw new Error("rollback request ID missing");
  if (record.workerVersion !== expectedVersion) throw new Error("rollback Worker version mismatch");
}
if (expected.size !== 0) throw new Error("missing rollback canary result");
console.log("rollback result assertions passed");
NODE
```

Run all rollback assertions against the same protected files. The telemetry
parser requires no `prepare` stage, successful `body_read`, `parse`, and
`normalize` pairs, a successful `tokenize` finish with the retained provider,
quota reservation before upstream, and no `exceededCpu`:

```bash
assert_telemetry \
  "$canary_output" \
  "$telemetry_output" \
  "$KNOWN_PREPARE_FREE_VERSION_ID" \
  "1,2" \
  legacy \
  "$EXPECTED_LEGACY_TOKENIZATION_PROVIDER"
assert_no_canary_secret_leak "$canary_output" "$telemetry_output" \
  "$PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN"
assert_audit_completed "$canary_output" "$audit_output" "$CANARY_D1_DATABASE"
```

After the TokenizerController migration has been applied, prefer a rollback
target that still includes the compatible migration and binding. Rolling back
only to avoid the migration can re-enable the Worker-local large-input BPE path
and repeat the resource-limit incident. If a new migration or class registration
cannot be deployed, repair forward with a new deployment; do not rewrite an
already applied migration tag.

For a prepare incident, first restore a known Worker version that predates
prepare. Restore the captured 100% version using the versioned rollback
procedure, then verify `/health`, Chat Completions, Responses legacy routing,
`/quota`, and Admin Access. Require legacy `body_read`/`parse`/`normalize`
stages, no `prepare` stage, the configured legacy tokenization provider,
successful reservation/upstream completion, and completed settlement evidence.
Do not leave a one-sided prepare pair during rollback.

After rollback:

- run a small authenticated request;
- verify `/quota`;
- verify Admin Access;
- inspect request-stage telemetry;
- check that reconciliation can still access the expected schema.

## Secret Rotation

General rotation order:

1. issue/create the replacement credential;
2. install it in the correct secret store;
3. deploy or activate the version that uses it;
4. verify the affected path;
5. revoke the old credential.

Rotate independently:

- Cloudflare/Wrangler management token;
- Gateway B Run token;
- OpenAI Usage API credential;
- Deno Deploy management token;
- Deno tokenizer shared-auth token;
- Gateway A Run token, when Custom Provider ingress is used.

### `OCTG_KEY_PEPPER`

Do not rotate the pepper as a normal stateless secret.

Stored client hashes depend on it. Either provide a deliberate transition in which keys are re-hashed/reissued, or migrate every affected client before retiring the old pepper.

An immediate pepper replacement makes existing client keys fail authentication.

## 503 / Worker Resource Limits

For Cloudflare Error 1102 or an HTML `Worker exceeded resource limits` response:

1. capture timestamp, Worker version, and OCTG request ID when available;
2. distinguish whether the request reached OCTG's structured error path;
3. inspect Cloudflare invocation outcome, CPU/wall time, and resource telemetry;
4. correlate tokenization provider and input byte measurements;
5. determine whether quota reservation or upstream execution had been reached;
6. avoid inferring the exact CPU/memory cause from the status page alone.

The historical incident record is [troubleshooting-503-worker-resource-limits.md](./troubleshooting-503-worker-resource-limits.md).

## Incident Safety Rules

- Never release uncertain quota only because the client saw an error.
- Never assume an upstream timeout means no token consumption.
- Never enable a paid route as an emergency bypass; Phase 1 does not implement one.
- Never log prompt/response content merely to debug quota accounting.
- Prefer request IDs, stage telemetry, canonical Durable Object state, D1 projections, and OpenAI usage evidence.
