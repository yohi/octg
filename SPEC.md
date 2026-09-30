# OCTG Technical Specification

## 1. Status and Authority

This document is the normative technical specification for the current Phase 1 behavior of OCTG.

It is reconstructed from the implementation on `master`. After this specification is adopted, changes that alter externally observable behavior, quota safety, protocol semantics, or persistent-state invariants MUST update implementation and this document together.

Historical requirements and design records have been consolidated into this
specification, the linked operational documents, and
[roadmap.md](./docs/roadmap.md). Those records are not current technical
authority.

## 2. Scope

OCTG is an OpenAI-compatible gateway that shares a complimentary OpenAI token allowance across authenticated clients while enforcing a conservative quota before upstream execution.

Phase 1 supports:

- `POST /v1/chat/completions`;
- `POST /v1/responses`;
- `GET /v1/models`;
- `GET /quota`;
- Cloudflare Access-protected Admin API and Admin UI;
- STANDARD and MINI complimentary quota pools;
- exact `o200k_base` text tokenization;
- optional Deno tokenizer offload;
- per-client policy for output limiting, cache use, and tool use;
- request reservation, settlement, uncertainty handling, and reconciliation.

Phase 1 does **not** implement a paid request path. `PAID_SHARED`, `max_paid_usd_day`, and model fallback fields are retained in configuration/schema surfaces for forward compatibility only. They MUST NOT be interpreted as enabling paid fallback.

Non-text model input is not supported by the gateway normalization contract.

Future work and candidate directions are tracked in
[docs/roadmap.md](./docs/roadmap.md). A roadmap item is not part of the Phase 1
contract until this specification is updated.

## 3. Components and Trust Boundaries

```text
Client
  |
  v
Gateway Worker
  |-- D1: client registry, client policy, model registry, audit projections,
  |       daily usage, reconciliation records
  |
  |-- TokenizerController Durable Object
  |       exact o200k_base BPE for the Cloudflare tokenization path
  |
  |-- optional Deno tokenizer
  |       exact o200k_base BPE for inputs routed by configured byte threshold
  |
  `-- QuotaController Durable Object
          canonical quota state for one pool and one UTC day
          |
          v
      Cloudflare AI Gateway
          |
          v
      OpenAI API
```

The QuotaController Durable Object is authoritative for live quota reservation state. D1 request and usage rows are projections used for audit, configuration, and reconciliation; D1 is not a substitute for the Durable Object's serialized quota decision.

## 4. Public HTTP Surface

### 4.1 Proxy endpoints

- `POST /v1/chat/completions`
- `POST /v1/responses`

Both require an OCTG client key.

### 4.2 Discovery and quota endpoints

- `GET /v1/models`
- `GET /quota`

Both require an OCTG client key.

`GET /v1/models` returns enabled models whose runtime registry entry belongs to `STANDARD` or `MINI`. The runtime registry, not a static documentation list, determines availability.

`GET /quota` returns the current UTC day's STANDARD and MINI pool snapshots.

### 4.3 Admin endpoints

The Admin surface is protected by Cloudflare Access JWT verification.

- `GET /admin/quota`
- `GET /admin/usage`
- `GET /admin/clients`
- `GET /admin/models`
- `PUT /admin/clients/:id/policy`
- `PUT /admin/models/:model`
- `POST /admin/reconcile`
- `POST /admin/reconcile/:pool/:utcDay/:requestId`
- `/admin/ui` and `/admin/ui/*`

Mutating Admin requests allow either no `Origin` header or an `Origin` exactly matching the request URL origin. Other browser origins are rejected with `origin_not_allowed`.

## 5. Client Authentication

Proxy, model discovery, and quota requests MUST provide:

```http
Authorization: Bearer octg_sk_...
```

The gateway:

1. requires the bearer value to begin with `octg_sk_`;
2. hashes the raw client key with `OCTG_KEY_PEPPER`;
3. looks up the resulting key hash in D1;
4. rejects unknown keys with `invalid_api_key`;
5. rejects disabled clients with `client_disabled`.

Raw client keys are not the D1 authentication record.

## 6. Request Processing Order

For a valid proxy route, the implementation performs these stages in order.
Responses requests that select the optional prepare route use the prepare
branch before ordinary body parsing; Chat Completions never selects it:

1. client authentication;
2. Deno tokenizer configuration validation;
3. `Idempotency-Key` validation;
4. prepare configuration/threshold decision for a Responses request;
5. bounded raw body read and JSON parse, or authenticated Deno `/prepare`;
6. endpoint-specific normalization;
7. model classification through the runtime registry;
8. client policy lookup and tool-use admission;
9. best-effort D1 audit insertion;
10. current quota-state read;
11. tokenization, or validated prepare metadata consumption;
12. token budget resolution;
13. fail-closed reservation;
14. per-pool in-flight admission;
15. upstream request construction and execution;
16. settlement, release, or uncertainty transition;
17. best-effort D1 audit completion.

No upstream request is permitted before a successful quota reservation and in-flight admission.

## 7. Request Normalization

### 7.1 General constraints

The request body MUST be valid JSON and MUST fit within the resolved input-size limit.

The resolved HTTP input limit is capped by the tokenization RPC safety ceiling even if a larger environment value is provided.

`MAX_INPUT_BYTES` is a positive safe integer and is the canonical limit for
both the Worker binding and the Production Deno runtime. The Deno deployment
workflow generates `OCTG_EXPECTED_MAX_INPUT_BYTES` from that same value;
missing, invalid, or mismatched startup assertions fail closed before
`Deno.serve`. Preview resolves its limit independently from
`OCTG_PREVIEW_MAX_INPUT_BYTES` and must not share mutable Production config.

OCTG accepts text-oriented request forms only. Unsupported non-text forms are rejected before reservation.

Unless otherwise specified below, normalization failures return `400 invalid_request`.

### 7.2 Chat Completions

`model` MUST be a string and `messages` MUST be an array.

Supported message content is:

- a string; or
- an array of text parts using `text` or `input_text`.

Non-text content parts are rejected.

`max_completion_tokens` and `max_tokens` MUST be positive when provided. If both are provided, they MUST be equal. When neither is provided, the normalized requested output maximum is 4096.

Tool-related request fields and message tool fields cause the request to be classified as tool use.

### 7.3 Responses

OCTG accepts text-centric Responses input and the implemented structured items used to carry text and tool history, including supported message, `function_call`, `function_call_output`, and reasoning shapes.

Generic `text` content parts are normalized to the role-appropriate upstream text type.

`previous_response_id` and `conversation` are not supported because OCTG cannot safely estimate context that is not present in the request body.

`instructions` MUST be a string when present.

Reasoning `encrypted_content` is treated as opaque input bytes for conservative estimation.

`max_output_tokens` MUST be positive when provided. When omitted, the normalized requested output maximum is 4096.

## 8. Model Eligibility and Client Policy

### 8.1 Model registry

Model classification uses the D1-backed runtime model registry with a short-lived in-process cache.

A model is complimentary only when its registry entry is enabled and its `complimentary_pool` is `STANDARD` or `MINI`.

Unknown, disabled, or `NONE` models are rejected with:

- HTTP `403`;
- error code `model_requires_paid`.

This error means the current complimentary-only implementation does not have an eligible route. It does not trigger a paid fallback.

### 8.2 Client policy defaults

When no usable policy row overrides them, the effective defaults are:

- `overflow_mode = REJECT`;
- `output_limit_mode = REJECT`;
- `max_paid_usd_day = 0`;
- `cache_enabled = false`;
- `tools_mode = REJECT`.

`overflow_mode = PAID_SHARED` and `max_paid_usd_day` are forward-compatible stored fields only in Phase 1.

### 8.3 Tool use

When normalization detects tool use:

- `tools_mode = ALLOW` permits the normal complimentary flow;
- any other effective value rejects the request with `model_not_allowed`.

A permitted tool-use request is still subject to the same model, tokenization, quota, concurrency, and upstream rules as other complimentary traffic.

## 9. Tokenization

### 9.1 Token accounting

Both tokenization providers compute exact `o200k_base` BPE token counts for the normalized text.

The final estimated input token value is:

```text
estimated_input =
    base_BPE_token_count
  + opaque_input_bytes
  + (message_count × 4)
  + 3
```

Arithmetic outside safe-integer bounds is a fail-closed internal error.

### 9.2 Cloudflare Durable Object provider

The default tokenization path uses `TokenizerController`.

The controller is an RPC service. It does not use Durable Object storage for request text, API keys, or tokenizer state.

The Worker uses the fixed logical object `tokenizer:primary`. Sharding is not
part of the current contract.

If exact BPE initialization or encoding raises an ordinary JavaScript `Error`,
the controller may return a conservative UTF-8-byte estimate with
`estimationPath = conservative_bytes`. An RPC failure, malformed result,
arithmetic failure, or work-limit failure is not eligible for a Worker-local
fallback and fails closed.

The controller emits `octg.tokenizer_stage` events for `tokenizer_init` and
`tokenizer_encode`. Start and finish events may include duration, safe byte or
token counts, estimation path, and a failure category. These events MUST NOT
contain input text, prompts, request bodies, credentials, or raw tokenizer
output.

### 9.3 Optional Deno provider

Deno tokenization is configured as a four-setting group:

- `DENO_TOKENIZER_ENDPOINT`;
- `DENO_TOKENIZER_AUTH_TOKEN`;
- `DENO_TOKENIZER_THRESHOLD_BYTES`;
- `DENO_TOKENIZER_TIMEOUT_MS`.

When all four settings are absent, Deno tokenization is disabled.

A partial or invalid group is a configuration error and the gateway fails closed before request processing proceeds.

When enabled:

- `inputTextBytes < threshold` uses `TokenizerController`;
- `inputTextBytes >= threshold` uses the Deno tokenizer.

A Deno failure does not fall back to the Durable Object provider for that request.

See `docs/deno-tokenizer.md` for deployment and component-specific operational details.

### 9.4 Responses prepare provider

The prepare pair has separate runtime and production semantics:

- `DENO_PREPARE_ENDPOINT` is an HTTPS `/prepare` endpoint;
- `DENO_PREPARE_THRESHOLD_BYTES` is a positive threshold no greater than
  `MAX_INPUT_BYTES`.

Outside production, both prepare variables absent disables prepare; a complete
valid pair enables it; and a partial or invalid pair is a Responses-only
configuration error.

With prepare enabled, a missing or malformed `Content-Length` routes a
Responses request to `/prepare`. A valid declared length above the threshold
routes to `/prepare`; a valid declared length at or below the threshold retains
the legacy path. A valid declared length above `MAX_INPUT_BYTES` is canceled and
rejected before Deno dispatch.

Production deployment requires both prepare variables. After surrounding
whitespace is trimmed, `DENO_PREPARE_THRESHOLD_BYTES` must be exactly `"1"`.
The validator must reject invalid production configuration before D1 migration,
Worker version upload, or Worker version deployment, and the upload passes both
values explicitly.

A one-sided, invalid, or tokenizer-incompatible pair is a configuration error
for Responses and does not alter Chat Completions behavior. A request with a
valid declared body length above `MAX_INPUT_BYTES` is rejected before Deno;
otherwise a large Responses request is sent to `/prepare` without reconstructing
or logging the body.

The Deno `/prepare` protocol exposes exactly these five validation codes:
`invalid_body`, `non_text`, `max_tokens_conflict`, `input_too_large`, and
`request_too_large`. `400`/`413` validation bodies contain only one `code`
field and are bounded to 4096 UTF-8 bytes. Internal/read failures are
status-only. Successful responses carry metadata in
`X-OCTG-Prepare-Metadata`; the encoded metadata header and accepted metadata
boundary are bounded to 4096 bytes. The normalized body contains one output
marker, which the Worker replaces with the final output-token value.

Prepare metadata is trusted only after schema, byte-bound, and marker checks.
The prepare result is consumed directly for model, policy, token-budget, and
quota decisions. Preparation precedes quota reservation, and neither a
rejected nor unavailable prepare result may fall back to
`TokenizerController` or reach upstream. No payload, metadata input, bearer
token, client key, or other secret may be written to logs.

## 10. Quota Model

### 10.1 Pools and identity

The live quota controller identity is:

```text
quota:{POOL}:{YYYY-MM-DD}
```

where `POOL` is `STANDARD` or `MINI`, and the date is UTC.

The shared-code fallback limits are:

- STANDARD: 1,000,000 tokens/day;
- MINI: 10,000,000 tokens/day.

Runtime environment configuration can set a lower operational ceiling. The repository's checked-in Worker configuration currently uses 950,000 for STANDARD and 9,950,000 for MINI, retaining a 50,000-token safety margin below the shared-code STANDARD fallback and MINI allowance. Therefore program allowance and deployed operational ceiling MUST NOT be treated as the same concept.

### 10.2 Pool state

The pool tracks:

- confirmed tokens;
- reserved tokens;
- uncertain tokens;
- request count.

Remaining quota is:

```text
remaining =
  limit
  - confirmed_tokens
  - reserved_tokens
  - uncertain_tokens
```

Uncertainty consumes capacity until explicitly resolved.

Policy tiers derived from remaining ratio are:

- NORMAL: greater than 20%;
- CAUTION: greater than 5% and at most 20%;
- STRICT: at most 5%, or invalid tier arithmetic.

### 10.3 Safety margin and upper bound

For estimated input `I`, requested output maximum `O`, and remaining ratio `R`:

```text
margin =
  if R <= 0.20:
    max(512, ceil(I × 0.05))
  else:
    max(256, ceil(I × 0.02))
```

The absolute request upper bound used to reject a request that can never fit in the pool is:

```text
upper_bound = I + O + max(512, ceil(I × 0.05))
```

If `upper_bound > pool_limit`, the request is rejected as `request_too_large`.

### 10.4 Output decision and reservation

For the effective output maximum:

```text
I + O + margin <= remaining
```

must hold.

If it does not hold:

- `output_limit_mode = REJECT` rejects the request;
- `output_limit_mode = CLAMP` may reduce the output maximum to `remaining - I - margin` when the result is positive.

The reservation is:

```text
reservation = I + effective_output_max + margin
```

QuotaController performs a second admission check against its canonical state. The reservation amount MUST fit the current remaining capacity. In the `STRICT` tier (remaining ratio at or below 5%), the conservative `upper_bound` MUST also fit the current remaining capacity. This protects the final pool capacity from a request whose ordinary reservation fits only because it used the less conservative dynamic margin.

Invalid quota arithmetic fails closed.

### 10.5 Reservation state machine

Request entries use these canonical states:

- `reserved`;
- `settled`;
- `uncertain`;
- `reconciled`;
- `released`.

A successful reservation increases `reservedTokens`.

A successful settlement:

- removes the reservation or uncertainty contribution;
- adds actual `usage.total_tokens` to confirmed usage;
- transitions the request to `settled`.

A known pre-upstream failure releases the reservation.

An outcome that may have reached the upstream but cannot be accounted exactly transitions to `uncertain`.

The gateway retries a failed reserve RPC once with the same request ID and parameters, relying on QuotaController replay semantics. If the result is still unknown, the request is tracked as uncertainty origin `reserve_unknown` and the client receives a fail-closed internal error.

## 11. Idempotency and Concurrency

### 11.1 Idempotency

`Idempotency-Key` is optional.

An empty value is treated as absent. A supplied key MUST be no more than 255 UTF-8 bytes.

Deduplication is scoped by client within the Durable Object that already represents pool × UTC day.

While the key maps to a non-released request, a repeated key associated with a different request ID is rejected with HTTP `409` and `duplicate_idempotency_key`. A mapping whose request has been released can be replaced by a later reservation.

A valid idempotency key is forwarded unchanged to the upstream call.

OCTG sets the outbound AI Gateway maximum-attempt behavior to one; client-provided retry headers are not used to enable upstream automatic retries.

### 11.2 In-flight admission

After reservation, OCTG acquires an in-flight lease from the same pool/day QuotaController.

The configured maximum defaults to two when the runtime value is absent or invalid.

Leases have a minimum safe TTL of 120 seconds. Streaming requests renew their lease. Expired leases are removed when lease state is evaluated.

If admission is denied:

1. the quota reservation is released;
2. no upstream call is made;
3. the request returns `worker_concurrency_exceeded`.

A lost or failed streaming lease renewal makes final accounting uncertain.

## 12. Upstream Contract

The upstream base URL MUST resolve to a Cloudflare AI Gateway OpenAI-provider endpoint ending in `/openai`.

OCTG uses the configured AI Gateway Run token in `cf-aig-authorization`.

For the upstream call, OCTG:

- sends request metadata including client ID, pool, `COMPLIMENTARY`, `free_shared`, and OCTG request ID;
- disables log-payload collection;
- limits AI Gateway attempts to one;
- skips cache unless the client policy enables cache;
- forwards a valid `Idempotency-Key`;
- rewrites the normalized output-limit field for the selected endpoint.

OCTG does not expose a Phase 1 paid upstream route.

## 13. Response Accounting

### 13.1 Non-streaming success

For a successful JSON upstream response with numeric `usage.total_tokens`, OCTG settles the reservation with that actual token count.

If a successful upstream response cannot be parsed or does not provide usable total-token usage, OCTG marks the request uncertain.

### 13.2 Streaming success

OCTG proxies the stream while looking for usage in SSE events, including usage-bearing completion events.

At finalization:

- usable total-token usage settles the request;
- missing usage marks it uncertain;
- client disconnect or lease-renewal failure marks it uncertain.

The stream parser uses bounded tail buffering rather than retaining the complete stream only for usage discovery.

### 13.3 Upstream failures

A configuration error or other known pre-upstream failure releases the reservation.

After an upstream attempt has begun, transport exceptions and non-2xx upstream responses are treated as uncertain because consumption may have occurred.

Non-2xx upstream responses are returned with OCTG request/quota routing headers while the reservation is conservatively moved to uncertainty.

## 14. Error and Header Contract

Proxy errors use an OpenAI-style body:

```json
{
  "error": {
    "message": "...",
    "type": "...",
    "param": null,
    "code": "..."
  },
  "request_id": "..."
}
```

`X-OCTG-Request-Id` is present on OCTG-generated proxy responses.

`X-OCTG-Route` is present whenever the response has a resolved OCTG route. It can therefore appear before a quota pool has been resolved, for example on a configured input-size rejection.

When both quota context and a route are available, OCTG also emits:

- `X-OCTG-Pool`;
- `X-OCTG-Quota-Limit`;
- `X-OCTG-Quota-Used`;
- `X-OCTG-Quota-Remaining`;
- `X-OCTG-Quota-Reset`.

Important rejection classes include:

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `invalid_request` | malformed or unsupported normalized request |
| 401 | `invalid_api_key` | invalid OCTG client credential |
| 403 | `client_disabled` | known but disabled client |
| 403 | `model_not_allowed` | tool-use policy rejection |
| 403 | `model_requires_paid` | no enabled complimentary route |
| 409 | `duplicate_idempotency_key` | key already associated with another request |
| 413 | `request_too_large` | configured input or pool-bound rejection |
| 429 | `insufficient_quota` | complimentary reservation cannot fit |
| 429 | `worker_concurrency_exceeded` | in-flight pool limit reached |
| 500 | `internal_error` | fail-closed internal/configuration/tokenization/accounting failure |

## 15. Reconciliation

### 15.1 Scheduled target

The Worker cron is configured for `00:05 UTC` daily.

The reconciliation implementation targets the immediately previous UTC day each time it runs.

For each pool it queries OpenAI organization completion usage over a 48-hour interval beginning at the target day's midnight, grouped by model in one-hour buckets. Usage API retrieval is attempted up to three times.

The optional `OPENAI_FREE_PROJECT_ID` scopes the Usage API query when configured.

### 15.2 Automatic inference

For the target day and pool:

1. local completed tokens are read from D1;
2. pending canonical request state is read from the QuotaController;
3. OpenAI usage is summed for runtime registry models assigned to that pool;
4. `reserve_unknown` entries are excluded from automatic consumed inference;
5. if the OpenAI-minus-local difference exactly equals the sum of ordinary reconcilable pending reservations, those pending requests are reconciled as consumed;
6. D1 projections are repaired when the Durable Object already records a compatible consumed reconciliation.

A reconciliation is `done` only when no pending requests remain and the recomputed usage difference is zero. Otherwise it remains `open`.

The implementation does **not** currently run a general scheduler over older `open` reconciliation rows and does **not** automatically force unresolved requests to consumed at a retention deadline. Documentation and operations MUST NOT assume such behavior.

### 15.3 Manual reserve-unknown resolution

`reserve_unknown` entries require explicit operator resolution through:

```text
POST /admin/reconcile/:pool/:utcDay/:requestId
```

The disposition is `consumed` or `unused`.

`unused` requires non-empty operator evidence. Evidence, when supplied, is limited by the Admin input contract.

Replaying the same resolved disposition is idempotent. A conflicting disposition is rejected.

### 15.4 Finalization

The scheduled finalization path only considers reconciliation rows already marked `done`.

QuotaController finalization succeeds only when the canonical Durable Object has no unresolved reserved or uncertain entries. A successful finalization deletes the Durable Object's stored day state.

## 16. Persistence Responsibilities

### Durable Object

QuotaController is canonical for:

- live pool counters;
- per-request reservation state;
- uncertainty state;
- idempotency mapping;
- in-flight leases;
- per-request reconciliation disposition.

### D1

D1 stores:

- clients and key hashes;
- client policies;
- model registry;
- request audit projections;
- daily usage projections;
- reconciliation records and evidence.

D1 audit writes are intentionally best effort on the request path. A failed audit projection MUST NOT weaken quota enforcement.

## 17. Operational Configuration Invariants

- Applied Durable Object migration tags are append-only operational history; do not rewrite an already applied tag.
- Production and Preview SHOULD use separate Worker, D1, client key/pepper, and control-plane state.
- Secrets MUST not be committed to the repository.
- Changing `OCTG_KEY_PEPPER` without re-hashing or reissuing client credentials invalidates existing key lookup.
- A partial Deno tokenizer configuration is an error, not a request-time fallback condition.
- Outside production, both prepare variables absent disables prepare; a complete valid pair enables it; and a partial or invalid pair is a Responses-only configuration error.
- Production requires the complete prepare pair; empty, partial, or noncanonical values are invalid, and validation occurs before every Worker-side remote mutation.
- Prepare-only invalidity affects Responses configuration, not the Chat Completions route.
- Production and Preview input-limit sources are isolated; each Deno runtime receives a generated expected-value assertion from its own canonical limit.
- Quota limits configured below the shared fallback allowance are valid operational ceilings.
- Cache use is opt-in per client. The default is off.

See `docs/configuration.md`, `docs/deployment.md`, and `docs/operations.md` for human procedures.

## 18. Verification

Repository-level correctness checks are:

```bash
npm run typecheck
npm test
```

Contract-relevant changes SHOULD add or update tests in the component that owns the invariant, including gateway proxy/normalization, QuotaController, tokenizer routing, reconciliation, or workflow contract tests.

Tokenizer and resource-limit changes MUST also be checked with representative
synthetic text in the approximately 74k-token class. The acceptance run uses
concurrency 1, concurrency 2, and the operator-defined expected peak. It
confirms that the Worker does not report `exceededCpu`, the gateway has paired
tokenization start/finish events, the TokenizerController has paired init/encode
events, and a tokenizer failure reaches neither quota reservation nor upstream.

Prepare acceptance additionally requires independent Deno `/prepare` health and
authentication verification, mandatory-pair activation, sanitized
approximately 74k-token Responses canaries at concurrency 1 and 2, `prepare`
resource-stage telemetry, and no `exceededCpu` outcome. A prepare rejection or
unavailable result must reach neither quota reservation nor upstream. Rollback
must target a known Worker version that predates prepare, require the legacy
`body_read`/`parse`/`normalize` stages and no `prepare` stage, and must repeat
the Chat/Responses route checks.

### 18.1 Free-tier prepare rollout acceptance

The prepare rollout acceptance procedure uses Responses canary mode with
synthetic 778240-byte and 1048576-byte bodies at concurrency 1, concurrency 2,
and the configured peak.

The acceptance run MUST require all of the following:

- no `exceededCpu` outcome;
- a successful `prepare` resource stage;
- Deno as the tokenization provider for the prepared route;
- correct quota settlement in D1 for every successful request;
- no `body_read`, `parse`, or `normalize` legacy body stages for the prepared
  route.

The rollback matrix MUST cover these three cases:

- new Deno with old Worker: successful legacy routing;
- old Deno with new Worker: pre-upstream fail-closed;
- Worker rollback to a pre-prepare version: restored legacy routing.

The operator MUST configure and test the platform-provided Deno allowance
alert. When allowance telemetry is unavailable, the operator MUST record the
prepare-unavailable-rate alert as the capacity signal.

Only the following evidence MAY be retained: request IDs, revision IDs,
resource stage outcomes, CPU/wall-time buckets, and safe `octg.canary.result`
records. Prompt text, response bodies, markers, client keys, bearer tokens, and
secrets MUST NOT be retained.
The specification must be reviewed whenever those tests or externally visible contracts change.

## 19. Responses Relay (v1)

This section is the single internal wire and state contract for the optional free-worker Responses relay through Deno. Names, limits, semantics, and ownership are normative: no extra HTTP headers, envelope fields, route, or status remapping may be invented. The shared v1 types, stable error union, and strict parsers live in `packages/shared/src/relay.ts`; runtime behavior is implemented behind this contract and never changes legacy Chat Completions or legacy Responses behavior.

### 19.1 Runtime configuration and environment isolation

The Deno relay requires all of these exact environment keys; values are scoped to one environment and are never shared between Preview and Production:

| Key | Meaning |
| --- | --- |
| `OCTG_RELAY_ENVIRONMENT` | Exactly `preview` or `production`; must match the Worker binding. |
| `OCTG_RELAY_CALLBACK_ORIGIN` | HTTPS origin only, no path other than `/`, query, fragment, or userinfo; fixed Worker origin for the same environment. |
| `OCTG_RELAY_SERVICE_AUTH_TOKEN` | Deno-to-Worker callback bearer secret. |
| `OCTG_RELAY_INGRESS_AUTH_TOKEN` | Worker-to-Deno ingress bearer secret. |
| `OCTG_RELAY_GATEWAY_B_BASE_URL` | Fixed HTTPS Gateway B `/openai` base URL; not client-selectable. |
| `OCTG_RELAY_GATEWAY_B_TOKEN` | Gateway B Run token. |
| `MAX_INPUT_BYTES` | Exactly `1048576` for this release. |
| `OCTG_RELAY_MAX_REQUEST_DURATION_MS` | Exactly `3600000` (one hour). |
| `OCTG_RELAY_LEASE_TTL_MS` | Exactly `120000`. |
| `OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS` | Exactly `30000`; four renewals per lease TTL. |

The Cloudflare Worker deployment alone stores `OCTG_RELAY_CONTEXT_HMAC_KEY`, an environment-unique base64url-no-padding encoding of exactly 32 random bytes. The ingress Worker uses it to sign context; RelayDecisionController uses the same environment key to verify context and sign grant credentials. It is never configured in Deno.

Worker relay configuration is enabled only when all `OCTG_RELAY_*` Worker bindings are present and valid: `OCTG_RELAY_ENVIRONMENT`, `OCTG_RELAY_INGRESS_ENDPOINT`, `OCTG_RELAY_INGRESS_AUTH_TOKEN`, `OCTG_RELAY_SERVICE_AUTH_TOKEN`, and `OCTG_RELAY_CONTEXT_HMAC_KEY`. The `RELAY_DECISION_CONTROLLER` and `QUOTA_CONTROLLER` Durable Object bindings must resolve to the same environment; the relay environment must not be inferred from callback input. The endpoint must be HTTPS and environment-pinned. Deno starts the relay endpoint only when all keys in the table are present and valid. A partial or invalid configuration is a startup/configuration failure (`500 internal_error`); it MUST NOT silently disable authentication, mix environments, or fall back to the legacy route.

The Decision DO also uses the same environment's D1 binding only for the existing read-only registry and policy lookups. D1 remains audit-only for quota mutation: the admission transaction and all quota/grant state writes are in QuotaController. `MAX_IN_FLIGHT_REQUESTS` and `IN_FLIGHT_LEASE_TTL_MS` are server-side Worker configuration consumed by QuotaController; they are never callback inputs.

`OCTG_RELAY_ENABLED` is exactly `true` to enable and `false` to disable; absent means disabled, and any other value is invalid. When true, missing or partial relay config fails closed; it never silently switches to the legacy route. Existing legacy `/prepare` configuration is independent.

### 19.2 Methods, headers, content and bounds

All relay ingress and callback routes accept **POST only** and require `Content-Type: application/json` (case-insensitive media type, optional `charset=utf-8` only). Other methods return `405` with `Allow: POST`; any other content type returns `400 invalid_request`.

| Direction / purpose | Exact route or header | Limit / rule |
| --- | --- | --- |
| Worker → Deno ingress | `POST /relay/v1/responses`; `Authorization: Bearer <OCTG_RELAY_INGRESS_AUTH_TOKEN>`; `X-OCTG-Relay-Context: <compact-context-token>`; optional `Idempotency-Key: <original value>` | Raw request body at most 1,048,576 bytes; context header at most 4,096 ASCII bytes; Idempotency-Key at most 255 UTF-8 bytes; content type is inherited as `application/json`. No other client headers are forwarded. |
| Deno → Worker callbacks | `POST /internal/relay/v1/{decision,activation,renewal,terminal}`; `Authorization: Bearer <OCTG_RELAY_SERVICE_AUTH_TOKEN>` | JSON request and response body at most 8,192 bytes; context or grant credential header at most 4,096 ASCII bytes. |
| Worker decision callback → RelayDecisionController | Internal DO RPC `decide(input)`; never exposed as a public HTTP route | Worker reads at most 8,192 callback-body bytes and passes them unchanged; context header at most 4,096 ASCII bytes; optional exact Idempotency-Key at most 255 UTF-8 bytes. The unverified request-ID hint only selects a shard; the DO verifies it. |
| Deno → Worker callback identity | `X-OCTG-Relay-Context` on decision; `X-OCTG-Relay-Grant` on activation, renewal, terminal | Never put either credential in the JSON body, logs, or public response. |
| Deno → Worker decision callback | Optional `Idempotency-Key: <exact original value>` on decision only | At most 255 UTF-8 bytes; absent when no effective public key was supplied. Never attach this header to activation, renewal or terminal callbacks. |
| Deno → Worker ingress response | `X-OCTG-Relay-Response-Meta` | Base64url without padding of UTF-8 JSON; decoded JSON at most 2,048 bytes; header at most 2,800 ASCII bytes. |

Both service tokens are 32–256 printable ASCII bytes without whitespace; each complete `Authorization` header is at most 263 ASCII bytes. HMAC keys are exactly 32 random bytes. All non-body headers in the table are ASCII and are subject to the listed per-header byte limit. Relay error-envelope bodies are at most 8,192 bytes.

The signed `RelayContextV1` claims are exactly `version`, `audience`, `environment`, `route`, `requestId`, `clientId`, `idempotencyKeyHash`, `nonce`, `issuedAtMs`, and `expiresAtMs`. Values: `version=1`, `audience="octg-deno-relay"`, `route="responses"`, environment `preview|production`. The ingress context intentionally excludes model, pool, and quota day: the ingress Worker cannot learn those without parsing/buffering the streamed input. Following the Deno metadata callback, RelayDecisionController resolves the authoritative model, pool, and admission UTC day; QuotaController binds them into the durable grant and RelayDecisionController signs the grant credential.

`idempotencyKeyHash` is `null` when absent, otherwise lowercase hex SHA-256(clientId || NUL || exact UTF-8 Idempotency-Key); raw keys and client credentials are never carried in the signed context. Ingress context lifetime is at most 60 seconds. Issuance must precede body forwarding.

Deno transports the effective Idempotency-Key value unchanged and MUST NOT use signed context claims as authority before the decision callback. It sends the opaque context and exact key (or its absence) to the decision callback. The decision callback wire contract is `Authorization: Bearer <OCTG_RELAY_SERVICE_AUTH_TOKEN>`, `X-OCTG-Relay-Context: <opaque signed context>`, and optional `Idempotency-Key: <exact original value>`; the JSON body remains exactly `{version:1,metadata:...}`. The key header is accepted only on decision, is limited to 255 UTF-8 bytes, and is absent when there is no effective key. Existing `parseIdempotencyKey` semantics define absent as a missing, null, or empty value; an empty public header therefore has no effective key, yields a null signed hash, and is omitted on internal and upstream requests. Every non-empty valid key is forwarded byte-for-byte as its original string value.

Before any reservation, lease acquisition or grant creation, the stateless Worker callback authenticates Deno and enforces the method/path, content type, and bounded header/body limits. It passes the bounded body bytes, opaque context, and exact optional Idempotency-Key to RelayDecisionController via internal RPC; it does not parse decision JSON or perform HMAC, policy, budget, or quota work.

RelayDecisionController verifies the signed context and obtains the verified `clientId` and `idempotencyKeyHash`. It parses the callback key using the same 255-byte public rule, computes `null` when absent or lowercase hex SHA-256 over UTF-8(`clientId`) || NUL || UTF-8(exact raw key) when present, and compares that result with the signed hash. A malformed key, hash mismatch, or disagreement between key presence and signed hash is rejected fail-closed before any QuotaController call: no reservation, lease or grant is created. Only after successful verification does RelayDecisionController call the single `QuotaController.admitRelay` RPC with the exact raw key, verified client ID, verified context claims and server-derived budget. Before that RPC it may read the same QuotaController's current quota view solely to compute the budget; the final admission decision and all durable writes remain inside the atomic `admitRelay` transaction. QuotaController preserves its existing raw-key plus clientId mapping; it MUST NOT receive the hash as an idempotency key or create a relay-specific namespace. Duplicate keys retain the existing `duplicate_idempotency_key` result across legacy and relay routes.

After allow, Deno may decode that same DecisionController-verified context as non-authoritative metadata, but performs no idempotency authorization check and does not issue a terminal release for key binding. It sends the identical effective raw key to Gateway B unchanged; when absent, it adds no upstream Idempotency-Key. The JSON decision body is unchanged.

All identifiers are non-empty ASCII strings: requestId is the existing OCTG request identifier generated as `req_${ulid()}` (30 ASCII bytes, matching `req_[0-9A-HJKMNP-TV-Z]{26}`); it is not a UUID and relay does not introduce a separate request identity. grantId is a UUID (36 bytes), nonce is 43-character base64url encoding of 32 random bytes, and leaseGeneration is a UUID (36 bytes). clientId is 1–128 UTF-8 bytes; model is 1–256 UTF-8 bytes; idempotencyKeyHash is null or exactly 64 lowercase hexadecimal characters. Times are safe integer Unix epoch milliseconds, `issuedAtMs <= nowMs`, and expiry is strictly greater than now when verified. Context expiry MUST be no more than 60,000 ms after issue.

Both signed context and grant credentials use the same compact representation: `base64url-no-padding(UTF8(RFC8785(claims))) + "." + base64url-no-padding(HMAC-SHA-256(key, purpose || 0x00 || canonicalPayload))`. Context purpose is ASCII `octg-relay-context-v1`; grant purpose is `octg-relay-grant-v1`. Tokens contain exactly two segments; reject padding, non-canonical JSON, duplicate keys, unknown claims, non-canonical base64url, oversize tokens, and additional segments. Cloudflare-side credential interfaces are exactly:

```ts
signRelayContext(context: RelayContextV1, key: Uint8Array): Promise<string>
verifyRelayContext(token: string, key: Uint8Array, expectedEnvironment: RelayEnvironment, nowMs: number): Promise<RelayContextV1 | undefined>
signRelayGrantCredential(claims: RelayGrantCredentialV1, key: Uint8Array): Promise<string>
verifyRelayGrantCredential(token: string, key: Uint8Array, expectedEnvironment: RelayEnvironment, nowMs: number): Promise<RelayGrantCredentialV1 | undefined>
```

The ingress Worker signs context; RelayDecisionController verifies context and signs grants; activation, renewal and terminal callbacks verify grants. Deno has no signing or verification-key capability. `RelayEnvironment` is exactly `"preview" | "production"`.

`RelayGrantCredentialV1` uses the compact token representation above, with grant purpose, and UTF-8 canonical JSON (RFC 8785) containing exactly these claims: `version:1`, `audience:"octg-worker-relay"`, `environment`, `route:"responses"`, `requestId`, `grantId`, `nonce`, `clientId`, `idempotencyKeyHash`, `model`, `pool`, `admissionUtcDay`, `leaseGeneration`, `issuedAtMs`, `expiresAtMs`. No `kid` or algorithm negotiation is accepted. The model is selected by RelayDecisionController from the authoritative registry; pool and admission UTC day are derived from that classification and the Decision DO's trusted clock. They are never copied from Deno metadata or ingress claims. Keys are environment-unique, exactly 32 random bytes, and compared using constant-time verification.

The grant credential is signed only after durable authorization. It expires at `issuedAtMs + 3,900,000` (one-hour maximum request duration plus five-minute callback grace); authorization expires at `issuedAtMs + 3,600,000`. No decision envelope controls either TTL. Every callback verifies all immutable claims against the stored grant, request entry, and environment.

### 19.3 Callback and response envelopes

All JSON objects reject unknown fields, missing required fields, duplicate JSON keys, invalid ranges, and invalid UTF-8. Raw request bodies are decoded by `parseRelayJsonBody(bytes: Uint8Array, maxBytes: number): unknown` using fatal UTF-8 decoding and a parser that detects duplicate object keys before the envelope-specific `parseRelay*` validator runs; malformed input throws only `RelayProtocolError("invalid_request")`, never a raw parser detail. No callback may supply a DO name, DO object ID, URL, environment override, quota pool override, client credential, or upstream credential.

- Decision request: `{version:1, metadata:RelayRequestMetaV1}` where metadata has exactly `model:string`, `estimatedInputTokens:safe non-negative integer`, `maxOutputTokens:safe non-negative integer`, `inputBytes:integer 0..1048576`, `rawBodyBytes:integer 0..1048576`, `isToolUse:boolean`, and `stream:boolean`. Request header carries `X-OCTG-Relay-Context`.
- Decision response: reject is `{version:1,kind:"reject",code:RelayErrorCode,status:integer}`. Allow is `{version:1,kind:"allow",grantId:string,leaseGeneration:string,maxOutputTokens:safe non-negative integer,cacheEnabled:boolean,quota:RelayQuotaSnapshotV1}`. Quota snapshot has exactly `pool:"STANDARD"|"MINI",limit,used,remaining` as safe non-negative integers and `resetAt:string` RFC3339 UTC. The grant credential is returned only in `X-OCTG-Relay-Grant` response header, never in the envelope. A reject status MUST equal the single status assigned to that code by the public mapping below; mismatched code/status pairs are invalid internal responses and map to public `500 internal_error`.
- Activation request/response: request `{version:1,grantId:string,leaseGeneration:string}`; response `{version:1,activated:boolean,code:ActivationDenialCode|null}`. `activated:true` requires `code:null`; `activated:false` requires one of the listed denial codes. Any other shape or code is malformed and is treated as `unknown` by Deno. The Deno-local activation result is exactly `| {kind:"activated"} | {kind:"denied",code:ActivationDenialCode} | {kind:"unknown"}` where `ActivationDenialCode = "environment_mismatch" | "grant_not_found" | "grant_expired" | "grant_replayed" | "grant_terminalized" | "lease_lost"`. Worker returns a denial code only when its activation operation definitively did not transition the grant to `attempted`; a transport failure, malformed response, or lost acknowledgement is `unknown`. The denial action mapping is exact: `environment_mismatch` -> no terminal callback (wrong environment); `grant_not_found` -> no quota/grant action (no matching grant exists); `grant_expired` -> no terminal callback (the expired authorized grant is released atomically by the DO); `lease_lost` -> terminal `release` (Worker proved activation did not occur and the grant is still authorized); `grant_replayed` -> terminal `uncertain` best effort (activation may already have occurred; never release); `grant_terminalized` -> no action (the grant is already terminal). `unknown` -> terminal `uncertain` best effort. None of these paths calls Gateway B. Only `activated` permits the single upstream request.
- Renewal request/response: request `{version:1,grantId:string,leaseGeneration:string}`; response `{version:1,renewed:boolean,code:RelayErrorCode|null}`. Each successful renewal extends the lease by exactly `OCTG_RELAY_LEASE_TTL_MS`; Deno renews every exactly `OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS` while upstream is active.
- Terminal request: `{version:1,grantId:string,leaseGeneration:string,outcome:"settle"|"uncertain"|"release",totalTokens:safe non-negative integer|null}`. `settle` requires integer totalTokens; other outcomes require null. Response is `{version:1,accepted:boolean,state:RelayGrantState,code:RelayErrorCode|null}`. `release` is legal only before activation; post-activation termination is `uncertain`, never release.
- `RelayResponseMetaV1` is exactly `{version:1,requestId:string,pool:"STANDARD"|"MINI",limit:safe integer,used:safe integer,remaining:safe integer,resetAt:string,route:"responses"}`. It MUST NOT contain grant credentials, service secrets, signed context, nonce, client key, request body, prompt, or upstream credential. `route: "responses"` is an internal protocol endpoint discriminator used only to validate the metadata; it is not the public `X-OCTG-Route` value. On a successful complimentary relay response, Worker constructs public headers with the existing route `free_shared`, equivalent to `buildOctgHeaders({ requestId, quota, route: "free_shared" })`. Never copy internal `"responses"` into `X-OCTG-Route`.

Deno ingress rejection/failure responses use HTTP status mapped from the `RelayErrorCode` table below, `Content-Type: application/json`, and the exact `RelayInternalErrorV1` body; successful upstream responses preserve upstream status/body/allowed headers and carry `X-OCTG-Relay-Response-Meta`. A decision callback with a policy/quota rejection is still HTTP 200 with `RelayDecisionV1.kind="reject"`; Deno translates that result to the specified public OCTG status/code envelope, never 503. Callback transport status is 200 for valid callback envelopes (including business rejection), 400 for malformed envelope/context, 401 for invalid internal service auth, 405 for a non-POST method, 409 for replay or terminal conflict, 413 for body-size violation, and 500 for internal failure. Deno treats any non-200 callback transport response as internal relay failure; Worker translates internal auth/transport failures to public `500 internal_error`.

### 19.4 RelayDecisionController authority and routing

RelayDecisionController uses a fixed 64-shard map for v1. The stateless callback derives a routing hint only from the compact context payload's existing `requestId`, after enforcing token/header bounds and the existing request-ID syntax. It does not validate the HMAC or use the hint for authorization. The shard function starts with unsigned offset basis `2166136261`; for each ASCII `requestId` byte it computes `hash = Math.imul(hash ^ byte, 16777619) >>> 0`. The shard index is `hash & 63`, zero-padded to two decimal digits. The exact DO name is `relay-decision:v1:{environment}:{shard:00..63}`. The environment is selected from static deployment configuration and names a separate Preview or Production namespace; no Production namespace ID is used by Preview.

The Worker exports class `RelayDecisionController`. Its Production SQLite namespace is introduced in `apps/gateway-worker/wrangler.jsonc` migration tag `v3` with `new_sqlite_classes: ["RelayDecisionController"]`. Preview configuration binds `RELAY_DECISION_CONTROLLER`, `QUOTA_CONTROLLER` and `TOKENIZER_CONTROLLER` to Preview-local class namespaces without explicit Production `namespace_id` values, alongside Preview D1 and Deno resources. A Preview config that can resolve any of these bindings/resources to Production must fail validation before deployment.

```ts
interface RelayDecisionDispatchInput {
  readonly decisionBody: Uint8Array; // <= 8,192 bytes; exact bytes from Deno
  readonly contextToken: string; // opaque X-OCTG-Relay-Context value
  readonly rawIdempotencyKey?: string; // exact callback header value
}

type RelayDecisionDispatchResult =
  | {
      readonly kind: "allow";
      readonly decision: Extract<RelayDecisionV1, { readonly kind: "allow" }>;
      readonly grantCredential: string;
    }
  | {
      readonly kind: "reject";
      readonly decision: Extract<RelayDecisionV1, { readonly kind: "reject" }>;
    }
  | { readonly kind: "protocol_error"; readonly code: "invalid_request" | "invalid_context" | "environment_mismatch" }
  | { readonly kind: "internal_error"; readonly code: "internal_error" };

interface RelayDecisionControllerOperations {
  decide(input: RelayDecisionDispatchInput): Promise<RelayDecisionDispatchResult>;
}
```

`RelayDecisionDispatchInput` and `RelayDecisionDispatchResult` are exported Cloudflare-internal shared types so the stateless callback and DO compile against the same RPC contract. They do not change the Deno/Worker HTTP wire format.

`kind:"allow"` and `kind:"reject"` are valid decisions serialized by the stateless callback with HTTP 200; the grant header is emitted only for allow. Malformed decision bodies, invalid signatures/claims and raw-key/hash binding mismatches return `protocol_error` (`invalid_request`, `invalid_context`, or `environment_mismatch`) and map to the existing HTTP 400 internal callback failure. Quota/model/policy denials use the exact v1 reject envelope. A lost or ambiguous QuotaController RPC result maps to `internal_error`/HTTP 500, never an allow. Deno therefore cannot activate or call Gateway B after any protocol or internal error.

RelayDecisionController obtains environment from its own bound configuration, verifies the complete context HMAC and claims, recomputes the shard name from the verified request ID, and rejects a shard mismatch before policy reads or quota operations. It then strictly parses the decision envelope, validates raw key length and binding against the signed `idempotencyKeyHash`, performs authoritative registry/policy reads and model/tool classification, calculates the token budget, and derives the admission UTC day. No field from an unverified hint, request body, or Deno-selected URL can choose a pool, quota DO, environment or policy result.

### 19.5 QuotaController.admitRelay boundary

QuotaController exposes one relay admission RPC:

```ts
interface QuotaControllerEnv {
  readonly QUOTA_LIMIT_STANDARD?: string;
  readonly QUOTA_LIMIT_MINI?: string;
  readonly MAX_IN_FLIGHT_REQUESTS?: string;
  readonly OCTG_RELAY_ENVIRONMENT?: string; // required by admitRelay; preview|production only
}

interface RelayAdmissionInput {
  readonly context: RelayContextV1; // verified by RelayDecisionController
  readonly metadata: RelayRequestMetaV1; // strictly parsed by RelayDecisionController
  readonly rawIdempotencyKey?: string; // exact value; absent when effectively absent
  readonly reservedTokens: number;
  readonly upperBoundTokens: number;
  readonly maxOutputTokens: number;
  readonly cacheEnabled: boolean;
}

type RelayAdmissionResult =
  | { readonly kind: "admitted"; readonly grant: RelayGrant; readonly quota: RelayQuotaSnapshotV1 }
  | { readonly kind: "denied"; readonly code: RelayErrorCode };

interface QuotaControllerRelayOperations {
  admitRelay(input: RelayAdmissionInput): Promise<RelayAdmissionResult>;
}
```

`admitRelay` derives pool/day from that QuotaController's immutable `quota:{POOL}:{YYYY-MM-DD}` identity and validates the context environment against its environment binding. Its single `ctx.storage.transaction()` checks the existing raw-key/client idempotency mapping, finalized state, quota and in-flight capacity before writing. On admission it commits the RequestEntry, pool and unresolved counters, existing idempotency mapping, generation-bound lease, and initial `authorized` RelayGrant together. On quota, concurrency or duplicate-key rejection it writes no reservation, counter, idempotency mapping or grant; pruning expired leases may commit in the same transaction. An exact request replay returns the stored admission result only when request identity, metadata, key binding, and grant state match; a conflicting replay rejects. Different request IDs may reach different Decision shards, but all decisions for the same authoritative pool/day serialize in the same QuotaController; its existing raw-key/client mapping prevents cross-shard duplicate admission. The RPC accepts no pool, day, namespace, DO ID, expiry, environment override, or client-selected concurrency limit. It resolves `MAX_IN_FLIGHT_REQUESTS` from its bound Worker environment using the existing positive-integer/default-2 semantics and uses the fixed `DEFAULT_IN_FLIGHT_LEASE_TTL_MS` value of 120,000 ms. The bound environment also supplies the fixed `OCTG_RELAY_ENVIRONMENT`, which must be `preview` or `production` and match the verified context. These settings are not RPC inputs. QuotaController creates grant IDs, lease generations and timestamps inside the transaction. The Decision DO signs the grant claims returned by this RPC. QuotaController remains the sole quota and durable grant authority; the Decision DO persists no quota or grant ledger.

QuotaController's existing `reserve`, `acquireInFlight`, and `authorizeRelay`-style split calls are not composed by the new decision path. Legacy routes retain their existing APIs. Relay admission uses only the atomic `admitRelay` RPC, with transaction-scoped helpers that do not open nested transactions. If an RPC acknowledgement is lost, an exact retry reaches the same Decision shard and calls `admitRelay` with the same request ID, context, metadata, and raw key; QuotaController returns the saved admission rather than reserving or authorizing twice. After activation, an exact decision replay cannot produce a second upstream attempt. Deno never retries an upstream request after activation; a transport failure before activation fails closed.

The QuotaController DO grant record stores the immutable credential claim bindings, `authorizationExpiresAtMs` (issuedAt + 3,600,000), state, terminal report/fingerprint, and retention deadline. The credential's `expiresAtMs` remains issuedAt + 3,900,000. The state union is `authorized|attempted|settled|released|uncertain|reconciled_consumed|reconciled_unused`. Only `authorized -> attempted` permits upstream fetch. Activation atomically checks reservation exists and is unresolved, grant is authorized and unexpired, all immutable bindings match, and the in-flight lease exists and has the exact generation. `attempted` cannot activate again. A credential cannot mutate quota after reconciliation or terminalization.

Terminal transitions are exact: `authorized -> released` only for a proven pre-activation failure; `authorized -> uncertain` for an unconfirmed activation result (retain reservation, remove lease); `attempted -> settled|uncertain`; `uncertain -> settled|uncertain` (a trustworthy late usage report may settle an uncertain quota entry); no state permits release after activation may have occurred. An exact terminal report replay returns the saved result, while a conflicting report fails `grant_terminalized`. Renewal is accepted only in `attempted` before authorization expiry. If an attempted grant is observed expired during renewal or terminal processing, atomically transition it to `uncertain` and release only the concurrency lease; keep its reservation. A credential-valid trustworthy terminal report may then settle that uncertain entry during the five-minute credential grace. After credential expiry, all callbacks are rejected.

### 19.6 Stable failures and public mapping

`RelayErrorCode` is exactly: `invalid_request | invalid_context | unauthorized_service | environment_mismatch | client_disabled | model_requires_paid | model_not_allowed | request_too_large | insufficient_quota | worker_concurrency_exceeded | duplicate_idempotency_key | grant_not_found | grant_expired | grant_replayed | grant_terminalized | lease_lost | upstream_error | upstream_timeout | upstream_invalid_response | internal_error`.

Internal error envelope is exactly `{version:1,error:{code:RelayErrorCode}}`; it contains no free-form message or sensitive detail. Mapping at the Worker public `/v1/responses` boundary preserves existing OCTG status/code pairs:

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `invalid_request` | validation rejection |
| 401 | `invalid_api_key` | external client authentication performed before relay |
| 403 | `client_disabled` | disabled client |
| 403 | `model_requires_paid` | no enabled complimentary route |
| 403 | `model_not_allowed` | model/policy rejection |
| 409 | `duplicate_idempotency_key` | key already associated with another request |
| 413 | `request_too_large` | request size rejection |
| 429 | `insufficient_quota` | complimentary reservation cannot fit |
| 429 | `worker_concurrency_exceeded` | in-flight pool limit reached |
| 500 | `internal_error` | all internal auth, configuration, callback, lease-lost, malformed relay, upstream transport, and unknown-reserve failures, unless public headers have already been sent |

Upstream non-2xx status/body remains the existing public upstream response contract, not an internal relay error. Deno never maps policy or quota decisions to 503. Internal callback failures use HTTP 500; Worker maps them to public `500 internal_error`. Once response headers are sent, terminate the stream on later failure; never replace it with a new error response.
