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
- remember that canary requests consume real production complimentary quota;
- compare the observed Worker version with the version intended for acceptance;
- stop on unexpected quota, tokenizer, upstream, or resource-limit behavior.

Do not use the canary as a load-test framework against the shared complimentary allowance.

## Deno Tokenizer Operations

When Deno is disabled, all tokenization uses `TokenizerController`.

When enabled, requests below the configured text-byte threshold use the Durable Object and requests at/above the threshold use Deno.

A Deno failure does not transparently retry through the Durable Object path.

Monitor:

- tokenization provider;
- tokenization failure category;
- network error name where emitted;
- tokenization duration;
- Worker resource-limit outcomes.

See [deno-tokenizer.md](./deno-tokenizer.md) for Deno-specific deployment and acceptance.

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
