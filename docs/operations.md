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

Responses prepare is disabled when both `DENO_PREPARE_ENDPOINT` and
`DENO_PREPARE_THRESHOLD_BYTES` are absent. Treat a one-sided or invalid pair
as a deployment failure, not as a reason to silently use the Durable Object.
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

Use the following executable commands from the controlled acceptance procedure.
They create protected temporary files and remove them after use; never print or
persist the synthetic payload, client key, Deno authentication value, or
upstream response body.

```bash
set -euo pipefail
umask 077
preview_versions_before_file="$(mktemp)"
preview_versions_after_file="$(mktemp)"
trap 'rm -f "$preview_versions_before_file" "$preview_versions_after_file"' EXIT
./node_modules/.bin/wrangler versions list --name "$PREVIEW_WORKER_NAME" --json > "$preview_versions_before_file"
gh run rerun "$PREVIEW_RUN_ID"
gh run watch "$PREVIEW_RUN_ID" --exit-status
./node_modules/.bin/wrangler versions list --name "$PREVIEW_WORKER_NAME" --json > "$preview_versions_after_file"
```

Select the sole new UUID whose annotations match the staged tag and exact
candidate SHA message; reject zero or multiple matches. The following lookup
is the Task 5 correlation rule and must run before the candidate is merged:

```bash
PREVIEW_PREPARE_VERSION_ID="$(node --input-type=module - "$preview_versions_before_file" "$preview_versions_after_file" "$PREVIEW_PR_NUMBER" "$PREVIEW_HEAD_SHA" <<'NODE'
import { readFileSync } from "node:fs";

const [beforePath, afterPath, prNumber, headSha] = process.argv.slice(2);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const readVersions = (path) => JSON.parse(readFileSync(path, "utf8"));
const before = readVersions(beforePath);
const beforeIds = new Set(before.map((version) => version?.id));
const tag = `pr-${prNumber}-deno-valid`;
const message = `pr-${prNumber} ${headSha} Deno valid auth`;
const candidates = readVersions(afterPath).filter((version) =>
  typeof version?.id === "string" && uuid.test(version.id) && !beforeIds.has(version.id) &&
  version.annotations?.["workers/tag"] === tag && version.annotations?.["workers/message"] === message,
);
if (candidates.length !== 1) throw new Error("expected exactly one new valid-auth Preview Worker version");
process.stdout.write(candidates[0].id);
NODE
)"
export PREVIEW_PREPARE_VERSION_ID
```

For each canary, capture the version-filtered tail and canary results before
asserting them:

```bash
canary_output="$(mktemp)"
telemetry_output="$(mktemp)"
audit_output="$(mktemp)"
trap 'rm -f "$canary_output" "$telemetry_output" "$audit_output"' EXIT
./node_modules/.bin/wrangler tail "$WORKER_NAME" \
  --format=json --version-id="$EXPECTED_WORKER_VERSION" >"$telemetry_output" 2>&1 &
tail_pid=$!
CANARY_PAYLOAD_PATH="$PAYLOAD_FILE" \
  npm run canary:worker -- --env-file=admin.env --concurrency=1,2 | tee "$canary_output"
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" || true
```

Run the repository's protected telemetry parser and bounded request-audit query
against those files. `assert_telemetry` must be run with `prepared` for Preview,
production, and peak, and with `legacy` plus the retained provider for rollback.
`assert_no_canary_secret_leak` and `assert_audit_completed` are the corresponding
Task 5 assertions; all must exit successfully. The complete protected function
definitions are in the [Task 5 acceptance procedures](./superpowers/plans/2026-09-12-large-responses-prepare-activation.md#task-5-verify-the-repository-and-execute-the-controlled-activation).
The D1 query is settlement evidence only. See [SPEC.md](../SPEC.md) for the
complete routing and validation contract.

If rollback is required, use the known pre-prepare version and run the same
protected canary procedure in legacy mode:

```bash
./node_modules/.bin/wrangler versions deploy \
  "${KNOWN_PREPARE_FREE_VERSION_ID}@100%" \
  --config apps/gateway-worker/wrangler.jsonc \
  --message "Rollback to pre-prepare Worker version" \
  --yes
assert_telemetry "$canary_output" "$telemetry_output" \
  "$KNOWN_PREPARE_FREE_VERSION_ID" "1,2" legacy \
  "$EXPECTED_LEGACY_TOKENIZATION_PROVIDER"
assert_no_canary_secret_leak "$canary_output" "$telemetry_output"
assert_audit_completed "$canary_output" "$audit_output" "$CANARY_D1_DATABASE"
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

## Rollback

Prefer a Worker version rollback that preserves D1 and Durable Object compatibility.

Before rollback:

1. identify the current and target Worker version;
2. check whether the newer deployment introduced D1 migrations;
3. check whether it introduced a new Durable Object migration tag;
4. verify the target code can operate against the already-applied persistent schema.

Do not rewrite or remove an already applied Durable Object migration tag to make rollback easier.

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
