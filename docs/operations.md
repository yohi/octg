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

Use the following staged procedure for prepare:

1. **Stage 1 — prepare absent.** Deploy the Worker and Deno tokenizer with
   both prepare variables absent. Do not upload empty-string `--var`
   placeholders. Confirm ordinary Chat Completions and Responses requests use
   the existing tokenizer path.
2. **Verify the service.** Check `/health`, then send an authenticated
   `/tokenize` request and an authenticated `/prepare` request using sanitized
   JSON. Confirm invalid authentication is rejected and no request body,
   metadata input, bearer token, or other secret appears in logs.
3. **Verify the shared limit.** Confirm the exact canonical
   `MAX_INPUT_BYTES` value is present in the Worker binding and Deno runtime.
   Confirm `OCTG_EXPECTED_MAX_INPUT_BYTES` was generated from that value and
   that startup fails before `Deno.serve` for a missing, invalid, or mismatched
   assertion. Preview must use `OCTG_PREVIEW_MAX_INPUT_BYTES` independently.
4. **Enable the pair.** Configure both prepare variables together, with an
   HTTPS endpoint and threshold no greater than the canonical input limit.
   Confirm a one-sided pair is rejected before any deployment arguments are
   built. Confirm the Worker config contains both generated
   `DENO_PREPARE_*` bindings and contains neither when both source values are
   absent.
5. **Canary.** Send sanitized approximately 74k-token Responses payloads at
   concurrency 1 and 2. Confirm the prepare stage precedes quota reservation,
   successful requests reach upstream only after reservation, marker
   replacement produces the requested output limit, and normal quota headers
   remain correct. Confirm a prepare rejection, timeout, authentication
   failure, or network failure reaches neither quota reservation nor upstream
   and never falls back to `TokenizerController`.
6. **Resource acceptance.** Review Worker resource-stage telemetry and Deno
   logs for paired start/finish outcomes. Accept only when there is no
   `exceededCpu` outcome, no payload/secret logging, and quota/upstream
   accounting is correct at concurrency 1, 2, and the operator-defined peak.

The five Deno prepare validation codes are `invalid_body`, `non_text`,
`max_tokens_conflict`, `input_too_large`, and `request_too_large`. The 400/413
validation body is bounded to 4096 bytes and contains only its code. Metadata
and the `X-OCTG-Prepare-Metadata` header are bounded as well; do not increase
these bounds as an incident workaround.

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
prepare, or deploy the reviewed prepare-absent configuration. Restore the
captured 100% version using the versioned rollback procedure, then verify
`/health`, Chat Completions, Responses legacy routing, `/quota`, and Admin
Access. Do not leave a one-sided prepare pair during rollback.

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
