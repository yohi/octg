# Free-Worker Responses Relay Through Deno

## Status and scope

- Design revision status: **requires Fresh Superpowers Review Gate review** after
  the Task 0 architecture failure recorded below.
- CPU feasibility: **FAIL — decision callback architecture requires revision**.
- Fresh Review Gate findings: RG-001 remains unresolved; RG-002 through RG-007 remain resolved. This revision preserves their contracts and does not reopen those findings.
- Implementation status: Tasks 1–8 remain blocked until the revised architecture
  passes a complete new Task 0 run and the evidence is accepted by the Fresh
  Superpowers Review Gate. This document revision does not authorize that remote
  run or any implementation.
- Constraint: Cloudflare Workers Paid is not an option. Deno may hold the
  upstream AI Gateway credential and perform upstream forwarding.
- This is a follow-up to the implemented bounded-prefix approach in
  [Free-Tier CPU-Limit Remediation](2026-09-20-free-tier-cpu-limit-remediation-design.md).
  That approach remains the rollback baseline; this proposal addresses CPU
  failures observed after it was deployed.
- The normative public API and quota invariants remain in [SPEC.md](../../../SPEC.md).
  On implementation, update that document for any changed internal contracts.

## Evidence and problem

On 2026-09-23, two production `POST /v1/responses` invocations on Worker
version 139 (`115c6a58-7fa2-441f-a7ab-a7852811c9ac`) ended in `exceededCpu`.
Their request Content-Length values were 997,102 and 1,005,949 bytes. The
events report 105 and 10 ms CPU respectively. Both reached the recorded
`upstream` stage; one recorded prepared-body completion and one did not.
Quota RPCs succeeded. Gateway B has logging enabled but no log in the
04:15:35–04:15:45 UTC failure window; absence of a log does not prove the
gateway was not contacted. Earlier failures also occurred with smaller bodies.

The existing route sends the input to Deno `/prepare`, then streams the
prepared body back through Worker prefix replacement and observation to
Gateway B. Worker also inspects streaming responses for usage. The trace
data narrows down the stage but does not establish a function-level CPU
hotspot. The Free HTTP CPU allowance is 10 ms. This design reduces repeated
Worker processing and adds measured gates; it does **not** promise that
forwarding the original input once through Worker will always fit 10 ms.

### Task 0 failure evidence (2026-09-23)

The Free-plan capability spike was run on a Workers Free account using a
temporary Worker Preview and temporary Deno app. The harness and temporary
resources were removed after collecting sanitized results. No Production traffic
or resource was used; Tasks 1–8 and production source changes were not started.

| Workload | Driver successful | CPU records | min | p50 | p90 | p95 | p99 | max | `exceededCpu` | Tail margin to 10 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ingress 123 KiB / `stream=true` | 100 | 100 | 0 | 0 | 2 | 3 | 4 | 4 | 0 | 6 ms |
| Ingress 123 KiB / `stream=false` | 100 | 100 | 0 | 0 | 2 | 2 | 3 | 4 | 0 | 6 ms |
| Ingress 174 KiB / `stream=true` | 100 | 100 | 0 | 0 | 1 | 1 | 2 | 4 | 0 | 6 ms |
| Ingress 174 KiB / `stream=false` | 100 | 100 | 0 | 0 | 1 | 2 | 3 | 3 | 0 | 7 ms |
| Ingress ~700 KiB / `stream=true` | 100 | 100 | 0 | 0 | 1 | 1 | 3 | 3 | 0 | 7 ms |
| Ingress ~700 KiB / `stream=false` | 100 | 100 | 0 | 0 | 1 | 1 | 2 | 2 | 0 | 8 ms |
| Ingress exactly 1 MiB / `stream=true` | 100 | 99 | 0 | 0 | 1 | 2 | 4 | 4 | 0 | 6 ms |
| Ingress exactly 1 MiB / `stream=false` | 100 | 100 | 0 | 0 | 1 | 1 | 2 | 2 | 0 | 8 ms |
| Decision callback | 100 | 98 | 1 | 2 | 6 | 7 | **19** | **19** | 0 | **-9 ms** |
| Activation callback | 100 | 100 | 0 | 1 | 3 | 3 | 6 | 8 | 0 | 2 ms |
| Renewal callback | 100 | 99 | 0 | 1 | 3 | 5 | 7 | 7 | 0 | 3 ms |
| Terminal callback | 100 | 99 | 0 | 1 | 3 | 4 | 8 | 8 | 0 | 2 ms |

CPU values are sanitized `$workers.cpuTimeMs` records from stateless Worker
invocations; percentiles use nearest-rank over observed records. Some log series
contained fewer records than the 100 successful driver invocations. This prevents
PASS completeness, but does not make the result BLOCKED: the decision callback
has an observed p99 and maximum of 19 ms, exceeding both mandatory Worker
thresholds. The prior harness did not contain `RelayDecisionController` or
`QuotaController.admitRelay`; no DO CPU percentiles for those not-yet-designed
invocations are available or inferred here.

| Runtime evidence | Value |
| --- | --- |
| Cloudflare plan/runtime | Workers Free, Dashboard verified 2026-09-23 JST |
| Worker Preview | `cpu-gate-f631181` |
| Worker revision | `0650e69b-bb99-49c2-b59d-71413f4eaa6c` |
| Temporary Deno app / revision | `octg-task0-f631181` / `1wy0c39533tx` |
| Measurement period | 2026-09-23 21:03:49–21:10:54 JST |

**CPU feasibility: FAIL — decision callback architecture requires revision.**
No credentials, request bodies, prompts or response bodies are included in this
record.

## Goals and exclusions

- Preserve client-facing `/v1/responses`, including streaming, output
  clamping, idempotency, and existing quota and error contracts.
- Keep QuotaController DO as the sole quota authority; D1 remains outside quota
  accounting, while the existing model/registry/policy read path stays read-only.
- Have Deno prepare the body and send it to Gateway B without returning the
  prepared request body to Worker.
- Minimize Worker per-byte work on both request and response; expose measured
  CPU and correctness gates for representative traffic.
- Fail closed on ambiguous upstream attempts, Worker termination, failed
  callbacks, and Deno capacity exhaustion. Never fall back to an unreserved
  or Worker-heavy upstream route.
- Keep Production and Preview credentials, callbacks, gateways, quota DOs,
  and registry/policy state separate.

This phase covers the Deno-prepared Responses route only. Chat Completions,
the public protocol, and the 1 MiB input limit do not change. Neither Deno
nor D1 independently decides whether a request may consume quota. No request
or response body is persisted for recovery.

## Architecture and protocol

```text
Client -> ingress Worker: authenticate, make req_${ulid()}, sign context, stream body once
Worker -> Deno: original body stream + opaque context
Deno: bounded parse, normalize and tokenize; hold prepared body in memory
Deno -> Worker /decision callback: bounded metadata + opaque context + exact Idempotency-Key
Worker /decision callback: bounded transport validation + deterministic Decision DO dispatch
Worker -> RelayDecisionController DO: bounded decision envelope and opaque signed context
RelayDecisionController DO: verify context/binding, resolve policy/model/budget, choose pool/day
RelayDecisionController DO -> QuotaController: one atomic admitRelay RPC
QuotaController: reserve + lease + authorized grant in one transaction
RelayDecisionController DO -> Worker -> Deno: reject or allow + signed one-use grant
Deno -> Gateway B: upstream request using Deno-held credential
Gateway B -> Deno -> Worker -> Client: response stream
Deno -> Worker callbacks -> QuotaController: activation, renewal, terminal usage/uncertainty
```

The ingress Worker authenticates the external client, validates the
Idempotency-Key and public request route, creates the existing OCTG request ID,
signs the short-lived context, and passes the original body to Deno once.
The internal context contains the environment, client ID, idempotency-key
identity, issue and expiry times, and a unique nonce; it contains neither the
client key nor an upstream credential. The environment-specific HMAC key is a
Cloudflare Worker deployment secret. The ingress Worker uses it only to sign
context; `RelayDecisionController` uses it to verify context and sign grants.
Deno never holds the key and never verifies or signs either token. Deno and Worker
callbacks authenticate each other with environment-specific service secrets.
Deno checks only transport size and syntax bounds for the opaque context header
and forwards that token unchanged to the decision callback. A successful allow
response proves that `RelayDecisionController` verified that exact context.
Only after allow, Deno may decode the context as
non-authoritative bounded relay/upstream metadata such as request ID and client
ID; it must not use those claims for quota, policy, model, pool,
admission-day, or target selection. Deno transports grant credentials opaquely in its callbacks.
Endpoint configuration is pinned to the corresponding environment.
The short-lived ingress context is validated only when creating the decision;
long-running renewal and terminal callbacks use a separate grant-bound
credential whose expiry covers the maximum supported request duration. A
short ingress-context expiry must not prevent a legitimate late settlement.
After terminal state, the grant credential can only retrieve the stored
result for an identical terminal report; it cannot activate, renew or change
the outcome.

Deno enforces raw and normalized size limits, parses Responses, performs exact
token estimation, prepares the upstream JSON in memory, and sends bounded
metadata to the internal decision callback. The stateless Worker callback
enforces only bounded transport/authentication and deterministic dispatch. The
Decision DO verifies the context and metadata schema, loads the authoritative
registry/policy, applies model/tool rules, classifies the pool, calculates the
output budget and admission UTC day, then calls `QuotaController.admitRelay`.
That single RPC commits reservation, in-flight lease, and authorized grant in
one QuotaController transaction. The Decision DO signs the returned grant
claims and emits the unchanged allow/reject callback envelope. Rejected requests
never reach Gateway B; Deno applies the authorized output clamp before
forwarding. A timeout or malformed result at any boundary is a rejection, never
permission to send upstream.

**A signed context alone is not an execution permit.** A per-request grant
state must be durable and single-use at the DO boundary. Activation is an
atomic DO operation that verifies the reservation, lease, environment,
request ID and grant nonce, and changes the grant from `authorized` to
`attempted` before Deno calls Gateway B. A duplicate or expired activation
cannot initiate another upstream request. Deno must not retry an upstream
request after activation; a fresh client retry follows existing idempotency
rules. The grant must be bounded by an expiry and terminal state. As an
implementation detail, the Worker callback can mediate activation, but DO
storage owns the one-use transition. Activation-acknowledgement loss is
treated as an uncertain attempt; never retry activation in order to send a
second upstream request.

The existing `/prepare` endpoint remains intact for rollout and rollback.
Introduce a versioned relay endpoint and versioned callback envelopes rather
than changing the existing prepare response contract in place. Limit callback
body sizes and accepted methods; do not expose the internal route as an
unauthenticated public API. No client-provided metadata, client key, model
classification, or user-selected target URL may override the server-side
decision. Deno uses a fixed Gateway B base URL and service credential,
separate from Gateway A's Custom Provider.

## Ownership of settlement and leases

The previous proposal left usage parsing in Worker, which would retain CPU
work on every response chunk. In this design **Deno parses upstream usage**
while relaying bytes unchanged and sends a bounded, authenticated terminal
report to the Worker callback. The callback applies `settle`, `markUncertain`
or `release` to the same QuotaController entry. A terminal result is applied
at most once; duplicate terminal callbacks return the stored result, and
conflicting terminal results fail closed for reconciliation. Deno cannot
directly mutate DO or D1. The DO validates the grant state before accepting
any terminal transition; terminal usage must be a non-negative safe integer.
Requests lacking trustworthy final usage remain uncertain.

Deno renews the in-flight lease through the authenticated Worker callback
while the upstream request is active. Renewal or callback failure stops new
upstream work, retains quota conservatively, and triggers best-effort cleanup;
lease expiry releases the concurrency slot but **not** the reservation.
Response stream termination, client disconnect, or Worker death cannot be
treated as proof of zero usage. Deno attempts terminal reporting independently
of the client connection within its execution lifetime. If that report cannot
be confirmed, the reserved entry remains available for the existing
reconciliation process. The Worker must not settle the same response by
reparsing its SSE stream.

For a non-stream response Deno reports terminal usage, then returns the
upstream response. For a stream, Deno forwards the SSE bytes and reports
final usage when the upstream stream terminates. Worker forwards the Deno
response as a byte stream with the existing OCTG request and quota headers and
constructs public version headers from
`workerVersionHeaders(env.CF_VERSION_METADATA)` in the ingress Worker; the Deno
metadata does not carry a Worker version. Worker never decodes the whole
response to settle quota. Audit creation
and completion are best effort and cannot authorize a request or block a DO
state transition. Public errors remain mapped by Worker; internal errors do
not disclose prompts, response content, signed contexts or credentials.
The Deno response carries a bounded internal decision envelope containing the
Worker-issued quota snapshot; Worker validates it before constructing public
OCTG headers. If that envelope is absent or malformed before response headers
are emitted, Worker fails closed rather than inventing quota values. After
headers are emitted, a stream failure terminates the stream; it cannot be
replaced with a new JSON error response.

## Failure matrix

| Boundary | Required quota state and behavior |
| --- | --- |
| Authentication, Deno parsing or DecisionDO validation fails | No `admitRelay` call, no reservation/lease/grant and no upstream call; return the mapped validation or internal error. |
| `QuotaController.admitRelay` rejects quota, concurrency or idempotency | Its single transaction writes no admission state; no activation or upstream call. |
| `admitRelay` acknowledgement is lost | Worker returns internal failure and Deno does not activate. An exact retry with the same context/body/key is idempotent at the same shard and QuotaController; if no retry succeeds, the authorized grant expires and is atomically released, or an attempted grant follows the existing uncertain rule. |
| Grant signing fails after `admitRelay` commits | DecisionDO uses the stored grant binding to request pre-activation `release`; it returns no allow. If release acknowledgement is ambiguous, leave the grant for exact retry/authorized expiry; never send upstream. |
| Allow response delivery is ambiguous | Exact decision retry returns the same stored grant while still authorized; after activation it cannot authorize another upstream attempt. |
| Activation acknowledged, upstream fetch fails or response is ambiguous | Mark uncertain; no upstream retry. |
| Deno proves failure before any activation | Release reservation and lease. |
| Upstream response lacks trustworthy usage, stream aborts, or callbacks fail | Keep or mark uncertain; release the lease when safe; reconcile later. |
| Valid terminal usage | Settle exactly once, then release lease and complete audit best effort. |
| Worker or Deno terminates unexpectedly | No new upstream attempt on retry; retain conservative reservation until terminal report or reconciliation. |

The implementation must distinguish a failure *before activation* from an
unconfirmed activation. `upstream start` telemetry alone is not proof of
upstream reach. Do not release a reservation solely because Gateway B has no
log; its logging may omit attempts that fail during upload.

## Security and environment isolation

- Keep the upstream Gateway B credential only in the Deno secret store for
  this route. Keep existing Worker credential while legacy routes use it;
  rotate/remove only after those routes no longer require it.
- Reject any context, callback or grant with the wrong environment, audience,
  service version, expiry or nonce. Use distinct secrets and fixed origins for
  Preview and Production. Never accept a Preview grant against Production DO.
- Bind one request ID and idempotency identity to one grant. Reject replay,
  cross-client reuse, cross-model substitution, and mismatched lease
  generation. Rate-limit malformed internal requests without logging secrets.
- Validate Deno's reported usage against numeric bounds and request identity.
  Trusting the Deno service to measure upstream usage is an explicit change in
  trust boundary; DO remains the quota decision authority, but a compromised
  Deno deployment could falsify usage. Use deployment provenance, narrow
  service credentials and reconciliation against the upstream usage ledger.

## Rollout, rollback and acceptance

1. Deploy the versioned Deno relay and Worker/Decision DO code inert, with
   environment-specific secrets and the SQLite migration. Keep the existing
   `/prepare` route functional.
2. Test request-size buckets including prior failed sizes (at least 123 KiB,
   174 KiB, approximately 700 KiB and 1 MiB), both stream modes, tool policy,
   invalid lengths, duplicate idempotency keys, and concurrent admissions.
3. Run injected failures at every matrix boundary, including lost
   `admitRelay` acknowledgement/retry with identical context, lost activation
   ACK, Worker termination after atomic admission, Deno termination after
   activation, and client disconnect. Assert at most one upstream attempt per
   grant and no over-release of quota.
4. Canary the relay in Preview, then a controlled Production subset. Compare
   stateless Worker `exceededCpu`/CPU distributions separately from
   RelayDecisionController and QuotaController DO CPU series, plus Deno capacity,
   Gateway B log matches, settlement and uncertain-entry counts by revision. Do
   not promote based on elapsed time alone. The release gate is zero CPU failures
   in every documented Worker and DO series and no quota invariant violations.
   Record sample counts and tail margins to 10 ms for Worker and 30,000 ms for
   DO. A DO pass never excuses a stateless Worker failure.
5. Deploy Deno before Worker for each immutable revision. Roll back Worker to
   the existing prepare route only when it is safe to do so; leave Deno's new
   endpoint compatible during rollback. Reconcile outstanding grants before
   disabling callbacks or removing secrets. Never route unresolved requests
   to a different control plane.

Observability records an opaque request ID, deployment revision, environment,
size bucket, stage, grant state and DO terminal state, without body, prompt,
response, nonce, signature, client key or API token. Measure CPU as separate
`stateless` and `durableObject` invocation series; distinguish
RelayDecisionController and each QuotaController RPC class by service/trigger or
isolated measurement window. Never pool a DO invocation into its calling Worker
callback.

## Pre-implementation CPU Feasibility Gate (BLOCKING)

Task 1 through Task 8 MUST remain blocked until a complete Task 0 rerun for this
revised architecture is PASS and Fresh Superpowers Review Gate accepts its
evidence. Task 0 is the sole permitted pre-gate activity. It is an
outside-repository disposable capability spike, not production implementation.
Remote deployment and measurement require the user's explicit authorization.
Use the intended Workers Free Preview and a temporary Deno app; local emulators,
Paid Workers and synthetic microbenchmarks do not satisfy this gate. Record the
dated Worker/Deno revisions, runtime/plan, methodology and sanitized aggregate
results without request bodies or credentials.

The evidence MUST include all of the following:

- The ingress Worker receives a representative authenticated `/v1/responses`
  request, signs its bounded context, and transfers the original body to Deno
  exactly once, without cloning, full buffering, JSON parsing or transformation.
- Request payload buckets of 123 KiB, 174 KiB, approximately 700 KiB, and
  exactly 1 MiB; cover both `stream=true` and `stream=false` in every bucket
  with at least 100 valid authenticated invocations per size/mode combination.
- The stateless Worker `/decision` callback is measured as a thin invocation:
  exact method/path and content-type validation; Deno service bearer check;
  bounded context, key and body-size checks; bounded body read; request-ID shard
  hint extraction; deterministic shard selection; and one Decision DO dispatch.
  It does not parse decision JSON, verify HMAC, bind the idempotency hash, read
  policy, classify models, calculate budgets, mutate quota, create grants or
  sign credentials.
- The `RelayDecisionController.decide` DO invocation is measured separately and
  includes bounded decision JSON parsing; full signed context validation;
  environment/audience/expiry/nonce checks; exact `clientId` and raw
  Idempotency-Key/hash binding; authoritative registry/policy lookup;
  tool/model classification; token-budget calculation; pool/day resolution;
  one `QuotaController.admitRelay` RPC; and grant signing.
- The `QuotaController.admitRelay` DO invocation is measured as a separate
  series and includes idempotency, quota, finalized-state, and concurrency
  checks plus one atomic reservation/lease/grant transaction.
- The activation callback invocation, measured separately from ingress, runs:
  service bearer validation; grant-credential verification; grant, reservation,
  and lease-generation validation; and an atomic `authorized -> attempted`
  equivalent DO operation.
- The renewal callback invocation, measured separately from ingress, runs:
  service bearer validation; grant-credential verification; attempted-state,
  expiry and lease-generation validation; and a lease-renewal-equivalent DO
  operation.
- The terminal callback invocation, measured separately from ingress, runs:
  service bearer validation; grant-credential verification; grant-state
  validation; a quota settle/uncertain-equivalent mutation; and a lease-release /
  grant-terminalization-equivalent DO operation.
- Capture the QuotaController activation, renewal and terminal RPC CPU records
  separately from both the stateless Worker callbacks and each other. Do not
  pool DO CPU into the stateless callback distributions.
- Task 0's callback harness is disposable and outside the repository. It MUST
  NOT create production source, modules, routes, or callbacks.
- At least 100 successful invocations per ingress bucket and stateless callback
  class, and at least 100 successful invocations per DO operation class. Report
  sample count and per-invocation CPU min/p50/p90/p95/p99/max, successful count,
  `exceededCpu`, and tail margin to the applicable limit for each class.
- Stateless Worker PASS: `exceededCpu = 0`, p99 at most 8 ms and maximum below
  10 ms for every ingress bucket and callback class.
- Durable Object PASS: `exceededCpu = 0`, p99 at most 24,000 ms and maximum
  below 30,000 ms for each of `RelayDecisionController.decide`,
  `QuotaController.admitRelay`, and the QuotaController activation, renewal and
  terminal RPCs. This uses 20% p99 headroom against the documented 30,000 ms
  default Durable Object per-request CPU limit; Task 0 does not configure a
  higher `limits.cpu_ms`.
- Report stateless Worker and DO CPU separately. Do not pool different ingress
  buckets, callbacks, DO classes or operation classes to hide a failing tail.

The gate is **FAIL** if any stateless Worker invocation has `exceededCpu > 0`,
p99 > 8 ms or max >= 10 ms; or if any required DO operation has `exceededCpu >
0`, p99 > 24,000 ms or max >= 30,000 ms. A known observed threshold violation
is FAIL even when another telemetry record is missing. Missing required samples
or telemetry with no observed failure, unavailable Free runtime or incomplete
workload reproduction is **BLOCKED**, never PASS. The recorded Task 0 result is
FAIL because the decision callback reached p99/max 19 ms. Tasks 1–8 must remain
not started; this revision requires Fresh Review Gate approval before a complete
Task 0 rerun. Only a complete rerun PASS and accepted evidence can change the
design status to implementation-ready.

## Normative relay contract (v1)

This section is the single internal wire and state contract. The implementation
plan MUST reproduce it without changing names, limits, semantics, or ownership.

### Runtime configuration and environment isolation

The Deno relay requires all of these exact environment keys; values are scoped
to one environment and are never shared between Preview and Production:

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

The Cloudflare Worker deployment alone stores `OCTG_RELAY_CONTEXT_HMAC_KEY`, an
environment-unique base64url-no-padding encoding of exactly 32 random bytes. The
ingress Worker uses it to sign context; RelayDecisionController uses the same
environment key to verify context and sign grant credentials. It is never
configured in Deno. Worker relay configuration is enabled only when all
`OCTG_RELAY_*` Worker bindings are present and valid:
`OCTG_RELAY_ENVIRONMENT`, `OCTG_RELAY_INGRESS_ENDPOINT`,
`OCTG_RELAY_INGRESS_AUTH_TOKEN`, `OCTG_RELAY_SERVICE_AUTH_TOKEN`, and
`OCTG_RELAY_CONTEXT_HMAC_KEY`. The `RELAY_DECISION_CONTROLLER` and
`QUOTA_CONTROLLER` Durable Object bindings must resolve to the same environment;
the relay environment must not be inferred from callback input. The endpoint
must be HTTPS and environment-pinned. Deno starts the relay endpoint only when
all keys in the table are present and valid. A partial or invalid configuration
is a startup/configuration failure (`500 internal_error`); it MUST NOT silently
disable authentication, mix environments, or fall back to the legacy route.
The Decision DO also uses the same environment's D1 binding only for the existing
read-only registry and policy lookups. D1 remains audit-only for quota mutation:
the admission transaction and all quota/grant state writes are in
QuotaController. `MAX_IN_FLIGHT_REQUESTS` and `IN_FLIGHT_LEASE_TTL_MS` are
server-side Worker configuration consumed by QuotaController; they are never
callback inputs.
`OCTG_RELAY_ENABLED` is exactly `true` to enable and `false` to disable; absent
means disabled, and any other value is invalid. When true, missing or partial
relay config fails closed; it never silently switches to the legacy route.
Existing legacy `/prepare` configuration is independent.

### Methods, headers, content and bounds

All relay ingress and callback routes accept **POST only** and require
`Content-Type: application/json` (case-insensitive media type, optional
`charset=utf-8` only). Other methods return `405` with `Allow: POST`; any other
content type returns `400 invalid_request`.

| Direction / purpose | Exact route or header | Limit / rule |
| --- | --- | --- |
| Worker → Deno ingress | `POST /relay/v1/responses`; `Authorization: Bearer <OCTG_RELAY_INGRESS_AUTH_TOKEN>`; `X-OCTG-Relay-Context: <compact-context-token>`; optional `Idempotency-Key: <original value>` | Raw request body at most 1,048,576 bytes; context header at most 4,096 ASCII bytes; Idempotency-Key at most 255 UTF-8 bytes; content type is inherited as `application/json`. No other client headers are forwarded. |
| Deno → Worker callbacks | `POST /internal/relay/v1/{decision,activation,renewal,terminal}`; `Authorization: Bearer <OCTG_RELAY_SERVICE_AUTH_TOKEN>` | JSON request and response body at most 8,192 bytes; context or grant credential header at most 4,096 ASCII bytes. |
| Worker decision callback → RelayDecisionController | Internal DO RPC `decide(input)`; never exposed as a public HTTP route | Worker reads at most 8,192 callback-body bytes and passes them unchanged; context header at most 4,096 ASCII bytes; optional exact Idempotency-Key at most 255 UTF-8 bytes. The unverified request-ID hint only selects a shard; the DO verifies it. |
| Deno → Worker callback identity | `X-OCTG-Relay-Context` on decision; `X-OCTG-Relay-Grant` on activation, renewal, terminal | Never put either credential in the JSON body, logs, or public response. |
| Deno → Worker decision callback | Optional `Idempotency-Key: <exact original value>` on decision only | At most 255 UTF-8 bytes; absent when no effective public key was supplied. Never attach this header to activation, renewal or terminal callbacks. |
| Deno → Worker ingress response | `X-OCTG-Relay-Response-Meta` | Base64url without padding of UTF-8 JSON; decoded JSON at most 2,048 bytes; header at most 2,800 ASCII bytes. |

Both service tokens are 32–256 printable ASCII bytes without whitespace; each
complete `Authorization` header is at most 263 ASCII bytes. HMAC keys are
exactly 32 random bytes. All non-body headers in the table are ASCII and are
subject to the listed per-header byte limit. Relay error-envelope bodies are
at most 8,192 bytes.

The signed `RelayContextV1` claims are exactly `version`, `audience`,
`environment`, `route`, `requestId`, `clientId`, `idempotencyKeyHash`, `nonce`,
`issuedAtMs`, and `expiresAtMs`. Values:
`version=1`, `audience="octg-deno-relay"`, `route="responses"`, environment
`preview|production`. The ingress context intentionally excludes model, pool,
and quota day: the ingress Worker cannot learn those without parsing/buffering
the streamed input. Following the Deno metadata callback,
RelayDecisionController resolves the authoritative model, pool, and admission
UTC day; QuotaController binds them into the durable grant and
RelayDecisionController signs the grant credential.
`idempotencyKeyHash` is `null` when absent, otherwise lowercase hex
SHA-256(clientId || NUL || exact UTF-8 Idempotency-Key); raw keys and client
credentials are never carried in the signed context. Ingress context lifetime
is at most 60 seconds. Issuance must precede body forwarding.

Deno transports the effective Idempotency-Key value unchanged and MUST NOT use
signed context claims as authority before the decision callback. It sends the
opaque context and exact key (or its absence) to the decision callback. The
decision callback wire contract is `Authorization: Bearer
<OCTG_RELAY_SERVICE_AUTH_TOKEN>`, `X-OCTG-Relay-Context: <opaque signed
context>`, and optional `Idempotency-Key: <exact original value>`; the JSON body
remains exactly `{version:1,metadata:...}`. The key header is accepted only on
decision, is limited to 255 UTF-8 bytes, and is absent when there is no effective
key. Existing `parseIdempotencyKey` semantics define absent as a missing, null,
or empty value; an empty public header therefore has no effective key, yields a
null signed hash, and is omitted on internal and upstream requests. Every
non-empty valid key is forwarded byte-for-byte as its original string value.

Before any reservation, lease acquisition or grant creation, the stateless
Worker callback authenticates Deno and enforces the method/path, content type,
and bounded header/body limits. It passes the bounded body bytes, opaque context,
and exact optional Idempotency-Key to RelayDecisionController via internal RPC;
it does not parse decision JSON or perform HMAC, policy, budget, or quota work.

RelayDecisionController verifies the signed context and obtains the verified
`clientId` and `idempotencyKeyHash`. It parses the
callback key using the same 255-byte public rule, computes `null` when absent or
lowercase hex SHA-256 over UTF-8(`clientId`) || NUL || UTF-8(exact raw key) when
present, and compares that result with the signed hash. A malformed key,
hash mismatch, or disagreement between key presence and signed hash is rejected
fail-closed before any QuotaController call: no reservation, lease or grant is
created. Only after successful verification does RelayDecisionController call
the single `QuotaController.admitRelay` RPC with the exact raw key, verified
client ID, verified context claims and server-derived budget. QuotaController
preserves its existing raw-key plus clientId mapping; it MUST NOT receive the
hash as an idempotency key or create a relay-specific namespace. Duplicate keys
retain the existing `duplicate_idempotency_key` result across legacy and relay
routes.

After allow, Deno may decode that same DecisionController-verified context as
non-authoritative metadata, but performs no idempotency authorization check and
does not issue a terminal release for key binding. It sends the identical
effective raw key to Gateway B unchanged; when absent, it adds no upstream
Idempotency-Key. The JSON decision body is unchanged.

All identifiers are non-empty ASCII strings: requestId is the existing OCTG
request identifier generated as `req_${ulid()}` (30 ASCII bytes, matching
`req_[0-9A-HJKMNP-TV-Z]{26}`); it is not a UUID and relay does not introduce a
separate request identity. grantId is a UUID
(36 bytes), nonce is 43-character base64url encoding of 32
random bytes, and leaseGeneration is a UUID (36 bytes). clientId is 1–128
UTF-8 bytes; model is 1–256 UTF-8 bytes; idempotencyKeyHash is null or exactly
64 lowercase hexadecimal characters. Times are safe integer Unix epoch
milliseconds, `issuedAtMs <= nowMs`, and expiry is strictly greater than now
when verified. Context expiry MUST be no more than 60,000 ms after issue.

Both signed context and grant credentials use the same compact representation:
`base64url-no-padding(UTF8(RFC8785(claims))) + "." +
base64url-no-padding(HMAC-SHA-256(key, purpose || 0x00 || canonicalPayload))`.
Context purpose is ASCII `octg-relay-context-v1`; grant purpose is
`octg-relay-grant-v1`. Tokens contain exactly two segments; reject padding,
non-canonical JSON, duplicate keys, unknown claims, non-canonical base64url,
oversize tokens, and additional segments. Cloudflare-side credential interfaces are exactly
`signRelayContext(context: RelayContextV1, key: Uint8Array): Promise<string>`
and `verifyRelayContext(token: string, key: Uint8Array,
expectedEnvironment: RelayEnvironment, nowMs: number):
Promise<RelayContextV1 | undefined>`, `signRelayGrantCredential(claims:
RelayGrantCredentialV1, key: Uint8Array): Promise<string>`, and
`verifyRelayGrantCredential(token: string, key: Uint8Array,
expectedEnvironment: RelayEnvironment, nowMs: number):
Promise<RelayGrantCredentialV1 | undefined>`. The ingress Worker signs context;
RelayDecisionController verifies context/signs grants; remaining Worker
callbacks verify grants.

### Callback and response envelopes

All JSON objects reject unknown fields, missing required fields, duplicate JSON
keys, invalid ranges, and invalid UTF-8. Raw request bodies are decoded by
`parseRelayJsonBody(bytes: Uint8Array, maxBytes: number): unknown` using fatal
UTF-8 decoding and a parser that detects duplicate object keys before the
envelope-specific `parseRelay*` validator runs; malformed input throws only
`RelayProtocolError("invalid_request")`, never a raw parser detail. No callback may supply a DO name, DO
object ID, URL, environment override, quota pool override, client credential,
or upstream credential.

- Decision request: `{version:1, metadata:RelayRequestMetaV1}` where metadata
  has exactly `model:string`, `estimatedInputTokens:safe non-negative integer`,
  `maxOutputTokens:safe non-negative integer`, `inputBytes:integer 0..1048576`,
  `rawBodyBytes:integer 0..1048576`, `isToolUse:boolean`, and `stream:boolean`.
  Request header carries `X-OCTG-Relay-Context`.
- Decision response: reject is
  `{version:1,kind:"reject",code:RelayErrorCode,status:integer}`. Allow is
  `{version:1,kind:"allow",grantId:string,leaseGeneration:string,
  maxOutputTokens:safe non-negative integer,
  cacheEnabled:boolean,quota:RelayQuotaSnapshotV1}`. Quota snapshot has exactly
  `pool:"STANDARD"|"MINI",limit,used,remaining` as safe non-negative
  integers and `resetAt:string` RFC3339 UTC. The grant credential is returned
  only in `X-OCTG-Relay-Grant` response header, never in the envelope.
  A reject status MUST equal the single status assigned to that code by the
  public mapping below; mismatched code/status pairs are invalid internal
  responses and map to public `500 internal_error`.
- Activation request/response: request
  `{version:1,grantId:string,leaseGeneration:string}`; response
  `{version:1,activated:boolean,code:ActivationDenialCode|null}`. `activated:true`
  requires `code:null`; `activated:false` requires one of the listed denial
  codes. Any other shape or code is malformed and is treated as `unknown` by
  Deno. The Deno-local activation result is exactly
  `| {kind:"activated"} | {kind:"denied",code:ActivationDenialCode}
  | {kind:"unknown"}` where
  `ActivationDenialCode = "environment_mismatch" | "grant_not_found" |
  "grant_expired" | "grant_replayed" | "grant_terminalized" | "lease_lost"`.
  Worker returns a denial code only when its activation operation definitively
  did not transition the grant to `attempted`; a transport failure, malformed
  response, or lost acknowledgement is `unknown`. The denial action mapping is
  exact: `environment_mismatch` -> no terminal callback (wrong environment);
  `grant_not_found` -> no quota/grant action (no matching grant exists);
  `grant_expired` -> no terminal callback (the expired authorized grant is
  released atomically by the DO); `lease_lost` -> terminal `release` (Worker
  proved activation did not occur and the grant is still authorized);
  `grant_replayed` -> terminal `uncertain` best effort (activation may already
  have occurred; never release); `grant_terminalized` -> no action (the grant
  is already terminal). `unknown` -> terminal `uncertain` best effort. None of
  these paths calls Gateway B. Only `activated` permits the single upstream
  request.
- Renewal request/response: request
  `{version:1,grantId:string,leaseGeneration:string}`; response
  `{version:1,renewed:boolean,code:RelayErrorCode|null}`. Each successful
  renewal extends the lease by exactly `OCTG_RELAY_LEASE_TTL_MS`; Deno renews
  every exactly `OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS` while upstream is active.
- Terminal request: `{version:1,grantId:string,leaseGeneration:string,
  outcome:"settle"|"uncertain"|"release",totalTokens:safe non-negative
  integer|null}`. `settle` requires integer totalTokens; other outcomes require
  null. Response is `{version:1,accepted:boolean,state:RelayGrantState,
  code:RelayErrorCode|null}`. `release` is legal only before activation;
  post-activation termination is `uncertain`, never release.
- `RelayResponseMetaV1` is exactly
  `{version:1,requestId:string,pool:"STANDARD"|"MINI",limit:safe integer,
  used:safe integer,remaining:safe integer,resetAt:string,route:"responses"}`.
  It MUST NOT contain grant credentials, service
  secrets, signed context, nonce, client key, request body, prompt, or upstream
  credential. `route: "responses"` is an internal protocol endpoint
  discriminator used only to validate the metadata; it is not the public
  `X-OCTG-Route` value. On a successful complimentary relay response, Worker
  constructs public headers with the existing route `free_shared`, equivalent
  to `buildOctgHeaders({ requestId, quota, route: "free_shared" })`. Never copy
  internal `"responses"` into `X-OCTG-Route`.

Deno ingress rejection/failure responses use HTTP status mapped from the
`RelayErrorCode` table below, `Content-Type: application/json`, and the exact
`RelayInternalErrorV1` body; successful upstream responses preserve upstream
status/body/allowed headers and carry `X-OCTG-Relay-Response-Meta`. A decision
callback with a policy/quota rejection is still HTTP 200 with
`RelayDecisionV1.kind="reject"`; Deno translates that result to the specified
public OCTG status/code envelope, never 503. Callback transport status is 200
for valid callback envelopes (including business rejection), 400 for malformed
envelope/context, 401 for invalid internal service auth, 405 for a non-POST
method, 409 for replay or terminal conflict, 413 for body-size violation, and
500 for internal failure.
Deno treats any non-200 callback transport response as internal relay failure;
Worker translates internal auth/transport failures to public `500
internal_error`.

### Credentials, authorization and DO routing

`RelayGrantCredentialV1` uses the compact token representation above, with
grant purpose, and UTF-8 canonical JSON (RFC 8785) containing exactly these
claims: `version:1`, `audience:"octg-worker-relay"`,
`environment`, `route:"responses"`, `requestId`, `grantId`, `nonce`, `clientId`,
`idempotencyKeyHash`, `model`, `pool`, `admissionUtcDay`, `leaseGeneration`,
`issuedAtMs`, `expiresAtMs`. No `kid` or algorithm negotiation is accepted.
The model is selected by RelayDecisionController from the authoritative registry;
pool and admission UTC day are derived from that classification and the Decision
DO's trusted clock. They are never copied from Deno metadata or ingress claims.
Keys are environment-unique, exactly 32 random bytes, and compared using
constant-time verification. Cloudflare-side credential functions use these exact
signatures and the canonical payload/purpose rules above:

```ts
signRelayContext(context: RelayContextV1, key: Uint8Array): Promise<string>
verifyRelayContext(token: string, key: Uint8Array, expectedEnvironment: RelayEnvironment, nowMs: number): Promise<RelayContextV1 | undefined>
signRelayGrantCredential(claims: RelayGrantCredentialV1, key: Uint8Array): Promise<string>
verifyRelayGrantCredential(token: string, key: Uint8Array, expectedEnvironment: RelayEnvironment, nowMs: number): Promise<RelayGrantCredentialV1 | undefined>
```

The ingress Worker signs context; RelayDecisionController verifies context and
signs grants; activation, renewal and terminal callbacks verify grants. Deno has
no signing or verification-key capability. `RelayEnvironment` is exactly
`"preview" | "production"`.

The grant credential is signed only after durable authorization. It expires at
`issuedAtMs + 3,900,000` (one-hour maximum request duration plus five-minute
callback grace); authorization expires at `issuedAtMs + 3,600,000`. No decision
envelope controls either TTL. Every callback verifies all immutable claims
against the stored grant, request entry, and environment.
RelayDecisionController loads authoritative registry/policy state, validates
Deno metadata, classifies the model/pool, and derives the admission UTC day. It
resolves `quota:{POOL}:{YYYY-MM-DD}` in the environment-specific
`QUOTA_CONTROLLER` namespace. The ingress context contains neither pool nor day
and cannot select the quota object. After grant creation, activation, renewal and
terminal callbacks reconstruct the same QuotaController object only from the
Worker-verified grant credential's `pool` and `admissionUtcDay`. Deno cannot
nominate a namespace, name or object ID. Late callbacks therefore use the
admission day's same QuotaController object across UTC midnight.

#### RelayDecisionController routing and authority

RelayDecisionController uses a fixed 64-shard map for v1. The stateless
callback derives a routing hint only from the compact context payload's existing
`requestId`, after enforcing token/header bounds and the existing request-ID
syntax. It does not validate the HMAC or use the hint for authorization. The
shard function starts with unsigned offset basis `2166136261`; for each ASCII
`requestId` byte it computes `hash = Math.imul(hash ^ byte, 16777619) >>> 0`.
The shard index is `hash & 63`, zero-padded to two decimal digits. The exact DO name is
`relay-decision:v1:{environment}:{shard:00..63}`. The environment is selected
from static deployment configuration and names a separate Preview or Production
namespace; no Production namespace ID is used by Preview.

The Worker exports class `RelayDecisionController`. Its Production SQLite
namespace is introduced in `apps/gateway-worker/wrangler.jsonc` migration tag
`v3` with `new_sqlite_classes: ["RelayDecisionController"]`. Preview
configuration binds `RELAY_DECISION_CONTROLLER`, `QUOTA_CONTROLLER` and
`TOKENIZER_CONTROLLER` to Preview-local class namespaces without explicit
Production `namespace_id` values, alongside Preview D1 and Deno resources. A
Preview config that can resolve any of these bindings/resources to Production
must fail validation before deployment.

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

`RelayDecisionDispatchInput` and `RelayDecisionDispatchResult` are exported
Cloudflare-internal shared types so the stateless callback and DO compile against
the same RPC contract. They do not change the Deno/Worker HTTP wire format.

`kind:"allow"` and `kind:"reject"` are valid decisions serialized by the
stateless callback with HTTP 200; the grant header is emitted only for allow.
Malformed decision bodies, invalid signatures/claims and raw-key/hash binding
mismatches return `protocol_error` (`invalid_request`, `invalid_context`, or
`environment_mismatch`) and map to the existing HTTP 400 internal callback
failure. Quota/model/policy denials use the exact v1 reject envelope. A lost or
ambiguous QuotaController RPC result maps to `internal_error`/HTTP 500, never an
allow. Deno therefore cannot activate or call Gateway B after any protocol or
internal error.

RelayDecisionController obtains environment from its own bound configuration,
verifies the complete context HMAC and claims, recomputes the shard name from
the verified request ID, and rejects a shard mismatch before policy reads or
quota operations. It then strictly parses the decision envelope, validates raw
key length and binding against the signed `idempotencyKeyHash`, performs
authoritative registry/policy reads and model/tool classification, calculates
the token budget, and derives the admission UTC day. No field from an unverified
hint, request body, or Deno-selected URL can choose a pool, quota DO, environment
or policy result.

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

`admitRelay` derives pool/day from that QuotaController's immutable
`quota:{POOL}:{YYYY-MM-DD}` identity and validates the context environment
against its environment binding. Its single `ctx.storage.transaction()` checks
the existing raw-key/client idempotency mapping, finalized state, quota and
in-flight capacity before writing. On admission it commits the RequestEntry,
pool and unresolved counters, existing idempotency mapping, generation-bound
lease, and initial `authorized` RelayGrant together. On quota, concurrency or
duplicate-key rejection it writes no reservation, counter, idempotency mapping
or grant; pruning expired leases may commit in the same transaction. An exact
request replay returns the stored admission result only when request identity,
metadata, key binding, and grant state match; a conflicting replay rejects.
Different request IDs may reach different Decision shards, but all decisions for
the same authoritative pool/day serialize in the same QuotaController; its
existing raw-key/client mapping prevents cross-shard duplicate admission. The
RPC accepts no pool, day, namespace, DO ID, expiry, environment override, or
client-selected concurrency limit. It resolves `MAX_IN_FLIGHT_REQUESTS` from
its bound Worker environment using the existing positive-integer/default-2
semantics and uses the fixed `DEFAULT_IN_FLIGHT_LEASE_TTL_MS` value of 120,000
ms. The bound environment also supplies the fixed `OCTG_RELAY_ENVIRONMENT`,
which must be `preview` or `production` and match the verified context. These
settings are not RPC inputs. QuotaController creates grant IDs, lease generations
and timestamps inside the transaction. The Decision DO signs the grant claims
returned by this RPC.
QuotaController remains the sole quota and durable grant authority; the Decision
DO persists no quota or grant ledger.

QuotaController's existing `reserve`, `acquireInFlight`, and
`authorizeRelay`-style split calls are not composed by the new decision path.
Legacy routes retain their existing APIs. Relay admission uses only the atomic
`admitRelay` RPC, with transaction-scoped helpers that do not open nested
transactions. If an RPC acknowledgement is lost, an exact retry reaches the
same Decision shard and calls `admitRelay` with the same request ID, context,
metadata, and raw key; QuotaController returns the saved admission rather than
reserving or authorizing twice. After activation, an exact decision replay
cannot produce a second upstream attempt. Deno never retries an upstream request
after activation; a transport failure before activation fails closed.

The QuotaController DO grant record stores the immutable credential claim bindings,
`authorizationExpiresAtMs` (issuedAt + 3,600,000), state, terminal
report/fingerprint, and retention deadline. The credential's `expiresAtMs`
remains issuedAt + 3,900,000. The state union is
`authorized|attempted|settled|released|uncertain|reconciled_consumed|reconciled_unused`.
Only `authorized -> attempted` permits upstream fetch. Activation atomically
checks reservation exists and is unresolved, grant is authorized and unexpired,
all immutable bindings match, and the in-flight lease exists and has the exact
generation. `attempted` cannot activate again. A credential cannot mutate
quota after reconciliation or terminalization.

Terminal transitions are exact: `authorized -> released` only for a proven
pre-activation failure; `authorized -> uncertain` for an unconfirmed activation
result (retain reservation, remove lease); `attempted -> settled|uncertain`;
`uncertain -> settled|uncertain` (a trustworthy late usage report may settle an
uncertain quota entry); no state permits release after activation may have
occurred. An exact terminal report replay returns the saved result, while a
conflicting report fails `grant_terminalized`. Renewal is accepted only in
`attempted` before authorization expiry. If an attempted grant is observed
expired during renewal or terminal processing, atomically transition it to
`uncertain` and release only the concurrency lease; keep its reservation. A
credential-valid trustworthy terminal report may then settle that uncertain
entry during the five-minute credential grace. After credential expiry, all
callbacks are rejected.

### Stable failures and public mapping

`RelayErrorCode` is exactly:
`invalid_request | invalid_context | unauthorized_service | environment_mismatch |
client_disabled | model_requires_paid | model_not_allowed | request_too_large |
insufficient_quota | worker_concurrency_exceeded | duplicate_idempotency_key | grant_not_found |
grant_expired | grant_replayed | grant_terminalized | lease_lost | upstream_error |
upstream_timeout | upstream_invalid_response | internal_error`.

Internal error envelope is exactly
`{version:1,error:{code:RelayErrorCode}}`; it contains no
free-form message or sensitive detail. Mapping at the Worker public
`/v1/responses` boundary preserves existing OCTG status/code pairs: validation
`400 invalid_request`; external client authentication performed before relay
`401 invalid_api_key`; disabled client `403 client_disabled`;
`model_requires_paid` and `model_not_allowed` are `403`
with their existing codes; request size is `413 request_too_large`; quota is
`429 insufficient_quota`; concurrency is `429 worker_concurrency_exceeded`;
idempotency collision is `409 duplicate_idempotency_key`; all internal auth,
configuration, callback, lease-lost, malformed relay, upstream transport, and
unknown-reserve failures map to `500 internal_error` unless public headers have
already been sent. Upstream non-2xx status/body remains the existing public
upstream response contract, not an internal relay error. Deno never maps policy
or quota decisions to 503. Internal callback failures use HTTP 500; Worker maps
them to public `500 internal_error`.
Once response headers are sent, terminate the stream on later failure; never
replace it with a new error response.

### Public Responses relay selection order

The public Responses handler uses this exact order: (1) authenticate the
external client; (2) validate public `Idempotency-Key`; (3) resolve relay
configuration; (4) when `endpoint === "responses"` and relay is enabled, enter
the relay path; (5) only when relay is disabled, resolve and validate legacy
Deno tokenizer and `/prepare` configuration; (6) continue to the legacy prepare
or legacy normal path. Relay configuration and legacy `/prepare` configuration
are independent. Invalid legacy tokenizer/prepare configuration MUST NOT reject
an enabled relay request. Once the relay path is selected, relay failure never
falls back to legacy forwarding.

### Atomic quota lifecycle and reconciliation

Extract `applyQuotaLifecycleTransition(storage, requestId, transition)` as a
transaction-scoped helper in `quota-lifecycle.ts`. It owns loading the request
entry, pool counters, unresolved counters, applying the named settle,
mark-uncertain, release, or reconcile mutation, validating legal source states,
and writing all affected records. It MUST NOT open its own transaction.
`QuotaLifecycle.settle`, `markUncertain`, `release`, and `reconcileRequest` each
call it inside their existing `ctx.storage.transaction()`. `finishRelay()`
calls the same helper from one `ctx.storage.transaction()` that also checks and
writes RelayGrant and lease state. Consumes: storage, immutable DO identity,
request ID, transition and bounded terminal data. Produces: canonical quota
entry/pool/unresolved state plus RelayGrant terminal state, committed together
or not at all. No read-then-write split across transactions is permitted.

Reconciliation in `consumed` or `unused` disposition terminalizes any grant in
the same transaction to `reconciled_consumed` or `reconciled_unused`, stores the
reconciliation disposition as its terminal fingerprint, and removes/releases
the lease. Late terminal reports, including an otherwise identical report, are
rejected `grant_terminalized`; conflicting reports are rejected identically
and cannot alter quota. Renewal and activation after reconciliation are
rejected `grant_terminalized`. An expired `authorized` grant can never activate
and is transitioned to `released` with reservation and lease release in one
transaction. An expired `attempted` grant is transitioned to `uncertain`,
retaining reservation and releasing only its concurrency lease. A terminal
grant returns its stored result only for the exact same terminal report
fingerprint while its credential remains valid; a different report is
`grant_terminalized`. Keep grant records for 45 days after `admissionUtcDay`
ends; cleanup is DO-local and may delete only terminal records after that
retention period. A test MUST prove that a pre-reconciliation credential
cannot cause any quota transition after reconciliation.

## Traceability and rollout gate

The Plan tasks map every requirement as follows: Task 0 is the only pre-gate
task and owns complete CPU feasibility evidence. The current Task 0 evidence is
FAIL; Tasks 1–8 remain blocked. Task 1 owns shared wire contracts and their
normative SPEC synchronization. Task 2 owns QuotaController's one-transaction
`admitRelay`, grant state, lease, lifecycle and reconciliation. Task 3 owns
credential primitives and environment validation. Task 4 owns the
RelayDecisionController DO and the thin stateless decision callback; activation,
renewal and terminal callback ownership remains Worker-side. Task 5 owns Deno
ingress/config/upstream forwarding; Task 6 owns renewal, usage and terminal
reporting; Task 7 owns public Responses integration and metadata/status mapping;
Task 8 owns SQLite DO migration, Preview/Production isolation, fault tests,
deployment/config/docs/rollback and rollout verification. Component ownership,
credential ownership, environments, routes, names and error semantics MUST match
the Plan verbatim.

Fresh Superpowers Review Gate must review this revision before any new Task 0
remote measurement authorization is used. Even after a complete Task 0 PASS,
Tasks 1–8 do not start automatically.

Canary remains a post-implementation rollout gate and does not replace the
pre-implementation CPU gate. Rollout is blocked until both gates pass.

## Design risks to validate before implementation

- Free-tier ingress may still exceed 10 ms while proxying the original body
  once; a relay is a reduction in Worker work, not a proof of sufficiency.
- DecisionDO offload is not a presumed CPU pass. Its 30-second Durable Object
  CPU acceptance bound is separate from the stateless Worker's 10 ms limit and
  requires independent measurement; the authoritative QuotaController
  admission RPC is measured separately again.
- The thin Worker decision callback still runs under the Free 10 ms HTTP CPU
  limit; it must not regain cryptography, metadata parsing, policy or quota work.
- Deno's execution lifetime after a client disconnect is not guaranteed by
  this design. DO conservative state plus reconciliation, rather than a
  background callback assumption, is the safety mechanism.
- Production readiness depends on Deno capacity, Gateway B logging latency,
  reliable deployment ordering and verification of the one-use DO operation.

This document is a design proposal; it does not change runtime behavior.
