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

For a valid proxy route, the implementation performs these stages in order:

1. client authentication;
2. Deno tokenizer configuration validation;
3. `Idempotency-Key` validation;
4. bounded raw body read and JSON parse;
5. endpoint-specific normalization;
6. model classification through the runtime registry;
7. client policy lookup and tool-use admission;
8. best-effort D1 audit insertion;
9. current quota-state read;
10. tokenization;
11. token budget resolution;
12. fail-closed reservation;
13. per-pool in-flight admission;
14. upstream request construction and execution;
15. settlement, release, or uncertainty transition;
16. best-effort D1 audit completion.

No upstream request is permitted before a successful quota reservation and in-flight admission.

## 7. Request Normalization

### 7.1 General constraints

The request body MUST be valid JSON and MUST fit within the resolved input-size limit.

The resolved HTTP input limit is capped by the tokenization RPC safety ceiling even if a larger environment value is provided.

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

Runtime environment configuration can set a different operational limit. The repository's checked-in Worker configuration currently uses 1,000,000 for STANDARD and 9,950,000 for MINI. Therefore program allowance and deployed operational ceiling MUST NOT be treated as the same concept.

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

The specification must be reviewed whenever those tests or externally visible contracts change.
