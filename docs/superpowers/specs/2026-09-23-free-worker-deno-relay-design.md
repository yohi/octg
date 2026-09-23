# Free-Worker Responses Relay Through Deno

## Status and scope

- Design approved: 2026-09-23; implementation pending.
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
The internal context contains a random request ID, environment identifier,
client ID, idempotency-key identity, issue and expiry times, and a unique
nonce. It does not contain the client key or upstream credentials. The Worker
authenticates Deno with an environment-specific service secret and signs the
context with a separate environment-specific key; Deno authenticates all
callback calls. Both sides validate the audience, route, expiry and context
version. Endpoint configuration is pinned to the corresponding environment.
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
response as a byte stream with the existing OCTG request, quota and version
headers; it never decodes the whole response to settle quota. Audit creation
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
