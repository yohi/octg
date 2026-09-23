# Free-Worker Responses Relay Through Deno

## Status and scope

- Design approved: 2026-09-23; **BLOCKED pending CPU feasibility evidence**.
- Implementation status: not authorized to start until the Pre-implementation CPU
  Feasibility Gate below passes. No qualifying evidence is recorded in this
  repository as of this revision; do not invent or infer measurements.
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

## Goals and exclusions

- Preserve client-facing `/v1/responses`, including streaming, output
  clamping, idempotency, and existing quota and error contracts.
- Keep QuotaController DO as the sole quota authority; D1 remains audit-only.
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
Client -> Worker: authenticated Responses request (one streaming pass)
Worker -> Deno: authenticated relay request + short-lived signed context
Deno: bounded parse, normalize, tokenize; hold prepared body in memory
Deno -> Worker internal callback: metadata + signed context
Worker -> QuotaController: policy/model checks, budget, reserve and admission
Worker -> Deno: bounded decision (reject, or one-use authorization + clamp)
Deno -> Gateway B: upstream request using Deno-held credential
Gateway B -> Deno -> Worker -> Client: response stream
Deno -> Worker callback -> QuotaController: terminal usage or uncertainty
```

Worker authenticates the external client, validates the Idempotency-Key and
public request route, and passes the original request body to Deno once.
The internal context contains the existing OCTG request ID, environment
identifier, client ID, idempotency-key identity, issue and expiry times, and a
unique nonce. It does not contain the client key or upstream credentials. The
Worker authenticates Deno with an environment-specific service secret and signs
the context with a separate environment-specific key. Deno authenticates all
callback calls. Only Worker holds the context HMAC key: it signs ingress
contexts and grant credentials, verifies ingress contexts on decision callbacks,
and verifies grant credentials on activation, renewal and terminal callbacks.
Deno does not verify or sign either token. It checks only the context header's
transport size and syntax bounds and forwards the opaque token unchanged to the
decision callback. A successful allow response proves to Deno that Worker
verified that exact context. Only after allow, Deno may decode the context as
non-authoritative data for bounded relay/upstream metadata such as request ID
and client ID; it must not use unverified claims for quota, policy, model, pool,
admission-day, or target selection. Deno transports the grant credential opaquely in its callbacks.
Endpoint configuration is pinned to the corresponding environment.
The short-lived ingress context is validated only when creating the decision;
long-running renewal and terminal callbacks use a separate grant-bound
credential whose expiry covers the maximum supported request duration. A
short ingress-context expiry must not prevent a legitimate late settlement.
After terminal state, the grant credential can only retrieve the stored
result for an identical terminal report; it cannot activate, renew or change
the outcome.

Deno enforces raw and normalized size limits, parses Responses, performs
exact token estimation, prepares the upstream JSON in memory, and sends only
bounded metadata to the internal decision callback. Worker verifies the
context and metadata schema, loads the authoritative registry and policy,
applies the existing tool/model rules and output budget, then asks the
Production or Preview QuotaController to reserve and acquire an in-flight
lease. Rejected requests never reach Gateway B. The callback returns the
clamped output-token limit and an authorization bound to this request,
environment, lease generation, and nonce; Deno applies the clamp before
forwarding. A network timeout or malformed response is a rejection, never
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
| Authentication, Deno parsing or prepare fails | No reserve, no upstream call; return mapped validation or internal error. |
| DO reservation rejected or result unknown | No activation or upstream; unknown reserve uses existing conservative handling. |
| Admission fails before grant | Release confirmed reservation; no upstream call. |
| Grant delivery fails after reservation | Do not send upstream; release only if the DO proves activation never occurred, otherwise uncertain. |
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

1. Deploy the versioned Deno relay and Worker callbacks inert, with
   environment-specific secrets. Keep the existing prepare route functional.
2. Test request-size buckets including prior failed sizes (at least 123 KiB,
   174 KiB, approximately 700 KiB and 1 MiB), both stream modes, tool policy,
   invalid lengths, duplicate idempotency keys, and concurrent admissions.
3. Run injected failures at every matrix boundary, including lost activation
   ACK, Worker CPU termination after reserve, Deno termination after activation,
   and client disconnect. Assert at most one upstream attempt per grant and
   no over-release of quota.
4. Canary the relay in Preview, then a controlled Production subset. Compare
   Worker `exceededCpu`, per-invocation CPU distribution, Deno capacity,
   Gateway B log matches, settlement and uncertain-entry counts by revision.
   Do not promote based on elapsed time alone. The release gate is zero CPU
   failures on a documented set of representative large requests and no quota
   invariant violations; record the sample size and tail CPU margin below
   10 ms. If the request-forwarding leg alone breaches the limit, stop and
   revisit ingress architecture instead of declaring this relay sufficient.
5. Deploy Deno before Worker for each immutable revision. Roll back Worker to
   the existing prepare route only when it is safe to do so; leave Deno's new
   endpoint compatible during rollback. Reconcile outstanding grants before
   disabling callbacks or removing secrets. Never route unresolved requests
   to a different control plane.

Observability contains request ID, deployment revision, environment, size
bucket, stage, grant state and DO terminal state, without body, prompt,
response, nonce, signature, client key or API token. Correlate the two legs
through an opaque request ID and measure CPU independently on both Worker
callback invocations and the original ingress invocation.

## Pre-implementation CPU Feasibility Gate (BLOCKING)

Task 1 through Task 8 in the implementation plan MUST NOT start until this gate
is PASS. Task 0, the isolated Free-plan CPU Capability Spike defined in the
Plan, is the sole activity permitted before PASS. It is not production source
implementation and must not create production routes, callbacks, or relay
modules. Remote deployment and runtime measurement for Task 0 still require the
user's explicit authorization. The gate measures the exact Free-plan runtime and deployment class used
by the intended Worker, not a local emulator, Paid Worker, or synthetic
microbenchmark. Record the dated Worker revision, runtime/plan, test harness,
and raw aggregate results without request bodies or credentials.

The evidence MUST include all of the following:

- The Worker receives a representative authenticated `/v1/responses` request
  and transfers its body to Deno exactly once, without cloning, buffering,
  parsing, or transforming it.
- Request payload buckets of 123 KiB, 174 KiB, approximately 700 KiB, and
  exactly 1 MiB; cover both `stream=true` and `stream=false` in every bucket
  with at least 100 valid authenticated invocations per size/mode combination.
- The decision callback invocation, measured separately from ingress, runs this
  bounded workload: service bearer validation; bounded JSON parsing; signed
  ingress-context verification; registry/policy lookup equivalent; model
  classification; token-budget calculation; reservation; in-flight acquisition;
  and a durable authorize-equivalent DO operation.
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
- Task 0's callback harness is disposable and outside the repository. It MUST
  NOT create production source, modules, routes, or callbacks.
- At least 100 successful invocations per payload-size/stream-mode combination
  and at least 100 invocations per callback class. Report sample count and per-invocation CPU
  distribution (minimum, p50, p90, p95, p99, maximum), ingress/callback
  `exceededCpu` counts, and each distribution's tail margin to the 10 ms limit.
- A documented pass threshold: zero `exceededCpu`; p99 CPU at or below 8 ms
  (at least 2 ms margin); maximum observed CPU below 10 ms; no payload bucket or
  callback class may be omitted or pooled to hide a failing tail.

The gate is **FAIL** if any invocation exceeds 10 ms, p99 exceeds 8 ms, any
`exceededCpu` event occurs, or the representative one-pass ingress itself
cannot meet the threshold. On failure, do not begin Tasks 1–8: redesign ingress
architecture if ingress fails, or reduce/reassign callback responsibility if
any callback class fails; rerun the complete gate after the redesign. Missing
samples, unavailable Free runtime, or incomplete telemetry are **BLOCKED**, not
PASS. If Task 0 fails, do not begin production implementation; return to this Design
and revise the architecture. Record no measurements until actually observed.
Until then the status remains `BLOCKED pending CPU feasibility evidence`.
Store the evidence and explicit PASS decision in the review record before
changing this document's status to implementation-ready.

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

Worker alone stores `OCTG_RELAY_CONTEXT_HMAC_KEY`, an environment-unique
base64url-no-padding encoding of exactly 32 random bytes. It is never configured
in Deno. Worker relay configuration is enabled only when all `OCTG_RELAY_*` Worker
bindings are present and valid: `OCTG_RELAY_ENVIRONMENT`,
`OCTG_RELAY_INGRESS_ENDPOINT`, `OCTG_RELAY_INGRESS_AUTH_TOKEN`,
`OCTG_RELAY_SERVICE_AUTH_TOKEN`, and `OCTG_RELAY_CONTEXT_HMAC_KEY`. The endpoint
must be HTTPS and environment-pinned. Deno starts the relay endpoint only when
all keys in the table are present and valid. A partial or invalid configuration
is a startup/configuration failure (`500 internal_error`); it MUST NOT silently
disable authentication, mix environments, or fall back to the legacy route.
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
and quota day: Worker cannot safely learn those without parsing/buffering the
streamed input. Following Deno metadata callback, Worker resolves the
authoritative model, pool, and admission UTC day and binds them in the durable
grant and grant credential.
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

Before any reservation, lease acquisition, or grant creation, Worker authenticates
the callback, applies bounded request validation, verifies the signed context,
and obtains its verified `clientId` and `idempotencyKeyHash`. Worker parses the
callback key using the same 255-byte public rule, computes `null` when absent or
lowercase hex SHA-256 over UTF-8(`clientId`) || NUL || UTF-8(exact raw key) when
present, and compares that result with the signed hash. A malformed key,
hash mismatch, or disagreement between key presence and signed hash is rejected
fail-closed before quota reservation: no reservation, in-flight lease, grant, or
Gateway B call is created. Only after a successful comparison may Worker call
`reserve(requestId, tokens, upperBoundTokens, rawIdempotencyKey,
verifiedClientId)`. It MUST preserve QuotaController's existing raw-key plus
clientId idempotency mapping; it MUST NOT pass the hash to `reserve` or create a
relay-specific idempotency namespace. Thus duplicate keys retain the existing
`duplicate_idempotency_key` result across legacy and relay routes.

After allow, Deno may decode that same Worker-verified context as
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
oversize tokens, and additional segments. Worker interfaces are exactly
`signRelayContext(context: RelayContextV1, key: Uint8Array): Promise<string>`
and `verifyRelayContext(token: string, key: Uint8Array,
expectedEnvironment: RelayEnvironment, nowMs: number):
Promise<RelayContextV1 | undefined>`.

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
`model`, `pool`, and `admissionUtcDay` are set by Worker from authoritative
policy/quota resolution after Deno submits request metadata; they are not copied
from Deno metadata or the ingress context. Keys are environment-unique, exactly
32 random bytes, and compared using constant-time verification. Plan interfaces are exactly
`signRelayGrantCredential(claims: RelayGrantCredentialV1, key: Uint8Array): Promise<string>` and
`verifyRelayGrantCredential(token: string, key: Uint8Array, expectedEnvironment: RelayEnvironment, nowMs: number):
Promise<RelayGrantCredentialV1 | undefined>`; context signing uses the same
canonical serialization and HMAC primitive with its exact context purpose
defined above. `RelayEnvironment` is exactly `"preview" | "production"`.

The grant credential is minted only after durable authorization. It expires at
`issuedAtMs + 3,900,000` (one-hour maximum request duration plus five-minute
callback grace); the grant's authorization expiry is `issuedAtMs +
3,600,000`. No decision envelope controls TTL. Every callback verifies all
claims against the durable grant, request entry, and environment. For the decision callback, Worker verifies the ingress context, loads the
authoritative registry and policy, validates Deno metadata, classifies the model
and pool authoritatively, and derives the server-side admission UTC day. It
resolves the QuotaController DO from that authoritative pool and day; the
ingress context contains neither value and cannot route the decision. After
grant issuance, activation, renewal and terminal callbacks reconstruct the same
DO only from the Worker-verified signed grant credential's `pool` and
`admissionUtcDay`. Worker maps `pool` to `STANDARD|MINI` and `admissionUtcDay`
to the canonical name `quota:{POOL}:{YYYY-MM-DD}`, then resolves that name in
the environment's own `QUOTA_CONTROLLER` namespace. Deno cannot nominate a
namespace, name, or object ID. This guarantees late callbacks across UTC
midnight use the admission day's same DO.

The DO grant record stores the immutable credential claim bindings,
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

The Plan tasks map every requirement as follows: Task 0 is the sole pre-gate
task and owns CPU feasibility measurement/evidence; CPU Gate PASS is a
precondition to Tasks 1–8. Task 1 owns all wire types/bounds/errors; Task 2
owns grant state, transaction seam, lease and reconciliation; Task 3 owns
credential primitives and environment validation; Task 4 owns Worker
callbacks, authorization and same-DO routing; Task 5 owns Deno ingress,
configuration and upstream forwarding; Task 6 owns renewal, usage and terminal
reporting; Task 7 owns public Responses integration/metadata/status mapping;
Task 8 owns cross-runtime fault tests, config/deployment/docs/rollback and
rollout verification. Component ownership, credential ownership, environments,
routes, names and error semantics MUST match the Plan verbatim.

Canary remains a post-implementation rollout gate and does not replace the
pre-implementation CPU gate. Rollout is blocked until both gates pass.

## Design risks to validate before implementation

- Free-tier ingress may still exceed 10 ms while proxying the original body
  once; a relay is a reduction in Worker work, not a proof of sufficiency.
- Callback invocations themselves also run within the Free CPU limit and
  need bounded payloads and isolated measurement.
- Deno's execution lifetime after a client disconnect is not guaranteed by
  this design. DO conservative state plus reconciliation, rather than a
  background callback assumption, is the safety mechanism.
- Production readiness depends on Deno capacity, Gateway B logging latency,
  reliable deployment ordering and verification of the one-use DO operation.

This document is a design proposal; it does not change runtime behavior.
