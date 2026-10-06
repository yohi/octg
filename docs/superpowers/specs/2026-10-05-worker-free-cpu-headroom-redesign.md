# Worker Free CPU Headroom Redesign

## Status and scope

- Issue: `yohi/octg#121` — Worker Free CPU制限の再発に伴うCPU headroom再設計.
- Design status: **REVISED after Fresh Superpowers Review Gate (2026-10-05)**.
- This document is a follow-up to
  `docs/superpowers/specs/2026-09-23-free-worker-deno-relay-design.md`.
- This design does **not** authorize implementation. A separately reviewed
  implementation plan is required before source changes begin.
- Cloudflare Workers Paid is out of scope. The design continues to target the
  Workers Free HTTP CPU limit of 10 ms.
- `QuotaController` remains the sole quota authority. D1 remains outside quota
  authority.
- Existing fail-closed semantics and Production/Preview isolation remain
  mandatory.
- Chat Completions behavior and the separate `invalid_json` remediation are
  out of scope.

## Problem statement

The existing Responses relay architecture moved tokenizer/prepare work to Deno
and moved decision-path trust and semantic processing to
`RelayDecisionController`. The 2026-09-27 Task 0 gate accepted that revised
architecture, but Production later experienced Worker CPU-limit failure again.

The earlier acceptance criterion was too weak for Production safety. In
particular, the accepted activation callback evidence included a maximum of
8 ms, leaving only 2 ms below the 10 ms Free HTTP CPU limit.

Issue #121 therefore changes the target from:

```text
max < 10 ms
exceededCpu = 0
```

to a design that demonstrates stable Production headroom under representative
workloads and runtime variance.

## Goals

1. Remove repeated relay HMAC `crypto.subtle.importKey()` work from hot paths.
2. Attribute the Production recurrence to a concrete invocation class using
   runtime evidence.
3. Measure ingress, decision, activation, renewal, and terminal independently.
4. Gate every required workload series on a stronger CPU headroom threshold.
5. Escalate activation, renewal, and terminal together to a dedicated Durable
   Object trust/processing boundary only when runtime evidence requires it.
6. Require both Preview and Production-like runtime gates before rollout.
7. Preserve a reusable synthetic regression workload derived from the
   Production incident's structural characteristics.
8. Preserve existing quota correctness, fail-closed behavior, security
   boundaries, and rollback safety.
9. Keep Stage 2 CPU acceptance from exhausting or consuming the normal
   Production quota allowance.

## Non-goals

- Workers Paid migration.
- Raising the Worker CPU limit.
- Relaxing quota semantics.
- Fail-open fallback.
- Making D1 a quota authority.
- Logging or persisting request or response payloads.
- Changing the public Responses API contract.
- Changing Chat Completions behavior.
- Fixing `invalid_json` / Responses body validation in this issue.
- Redesigning `RelayDecisionController` when decision remains within the CPU
  gate.
- Adding a Production public test bypass or public measurement-only API.

## Design overview

The remediation is intentionally staged.

```text
Phase 1
Relay HMAC CryptoKey reuse
        |
        v
Stage 1 Preview CPU gate
        |
        +-- lifecycle FAIL
        |       |
        |       v
        |    Phase 2
        |    RelayGrantLifecycleController
        |       |
        |       v
        |    Stage 1 evidence reset and full re-run
        |       |
        +-------+
                |
                v
Stage 1 PASS
        |
        v
Stage 2 Durable Object compatibility bridge
        |  always required
        |  Phase 2 inactive: QuotaController CPU-gate RPC compatibility
        |  Phase 2 active: above + v4 + candidate-compatible lifecycle DO
        v
bridge 100% / CPU-tested candidate 0%
        |
        v
Stage 2 compatibility preflight
        |
        v
Stage 2 Production-like CPU gate
        |
        v
roll out exact CPU-tested candidate
        |
        v
post-gate hardening
```

Phase 2 remains conditional. The system does not add
`RelayGrantLifecycleController` simply because Issue #121 exists. The new
lifecycle boundary is introduced only when activation, renewal, or terminal
fails the approved Worker CPU gate.

The **Stage 2 Durable Object compatibility bridge is not conditional**. Every
Stage 2 run uses it because the candidate Worker can call Durable Objects whose
code version is independently assigned by Cloudflare during a gradual
deployment.

Throughout this document, **CPU-tested candidate** is the single identity for
the Worker version whose stateless CPU evidence is collected in Stage 2.
Earlier wording such as "CPU-tested candidate" is superseded by this term.

## CPU gate

The approved provisional hard gate for every required **stateless Worker**
series is:

```text
p99 <= 5 ms
max <= 7 ms
exceededCpu = 0
```

Rules:

- Runtime evidence may justify a stricter gate.
- The gate must not be relaxed to make an implementation pass.
- Any series with `max >= 8 ms` cannot be accepted.
- A Durable Object pass never excuses a stateless Worker failure.
- Ingress or decision failures require remediation of those invocation classes;
  lifecycle offload does not make them pass.

This is a rollout-safety gate, not a local microbenchmark target.

## Phase 1: relay HMAC CryptoKey reuse

### Existing problem

`packages/shared/src/relay-credential.ts` currently imports the same raw relay
HMAC key for each MAC calculation before calling `crypto.subtle.sign()`.

The existing client-key HMAC implementation in
`apps/gateway-worker/src/crypto.ts` already uses an isolate-local
`Promise<CryptoKey>` cache with rejection cleanup. Relay HMAC handling follows
the same ownership pattern.

### Cache design

Use a single isolate-local cache entry:

```text
cached = {
  rawKeySnapshot: Uint8Array,
  promise: Promise<CryptoKey>
}
```

Behavior:

- Same raw key bytes -> reuse the cached promise.
- Different raw key bytes -> import a new key and replace the cache.
- Concurrent first use of one key -> converge on the same promise.
- Import rejection -> clear the entry only if the rejected promise is still the
  current cache entry.
- Retry after rejection -> perform a fresh import.
- Key rotation -> the new raw key bytes cause a new import.
- Do not stringify, log, fingerprint, or otherwise expose raw key material only
  for cache identity.

The cache changes CPU behavior only. Token formats, verification semantics,
environment checks, and trust ownership do not change.

## Production incident attribution

### Evidence authority

Cloudflare platform invocation records are authoritative for CPU attribution
and CPU gate evaluation.

Required platform evidence includes:

```text
ScriptVersion
CPUTimeMs
Outcome
Event / route
EventTimestamp
execution model
```

Application logs are supplementary evidence only. CPU exhaustion can terminate
execution before an application-level finish marker is emitted, so absence of a
finish event must never be interpreted as proof that no CPU failure occurred.

### Sanitized relay invocation markers

A safe structured marker such as `octg.relay_invocation` may carry only
non-sensitive correlation fields:

```text
invocationClass
revisionId
requestId        # when available and safe
workloadClass    # controlled measurement only
concurrency      # controlled measurement only
phase
outcome
```

The marker must not contain request/response bodies, prompts, API keys, service
bearers, relay secrets, grant credentials, raw HMAC keys, or upstream
credentials.

The marker is for debugging and secondary correlation. It is never required to
prove PASS.

### Attribution requirement

Before grant lifecycle architecture escalation, the Production recurrence must
be attributed by evidence to one of:

```text
ingress
decision
activation
renewal
terminal
```

HMAC cache implementation may proceed before this attribution is complete.
Issue #121 must not close while the recurrence remains unattributed.

## Measurement model

### Classification dimensions

The smallest CPU-gate series is:

```text
invocation class x workload class x execution condition
```

Invocation classes:

```text
ingress
decision
activation
renewal
terminal
```

Canonical workload classes:

```text
baseline-small
baseline-large
incident-regression-stream
incident-regression-nonstream
```

Execution conditions:

```text
concurrency=1
concurrency=2
concurrency=3
```

Concurrency is the number of simultaneous callback invocations issued against
the **same active fixture**, not the number of fixtures. It is an execution
condition, not part of the domain workload name, but every concurrency value is
measured as a separate CPU series.

Because the runner may own at most one non-terminal CPU-gate operation, series
that require a fresh fixture per sample (`activation_normal` and
`terminal_normal`) are measured only at `concurrency=1`. Series that exercise
callbacks against an existing fixture (`decision`, `activation_replay`,
`renewal_normal`, and `terminal_replay`) and the stateless `ingress` series are
measured at `concurrency=1,2,3`.

Required series matrix:

```text
invocationClass      | workloadClass             | concurrency
---------------------|---------------------------|------------
ingress              | baseline-small            | 1,2,3
ingress              | baseline-large            | 1,2,3
ingress              | incident-regression-stream| 1,2,3
ingress              | incident-regression-nonstream| 1,2,3
decision             | baseline-small            | 1,2,3
decision             | baseline-large            | 1,2,3
decision             | incident-regression-stream| 1,2,3
decision             | incident-regression-nonstream| 1,2,3
activation_normal    | baseline-small            | 1
activation_normal    | baseline-large            | 1
activation_normal    | incident-regression-stream| 1
activation_normal    | incident-regression-nonstream| 1
activation_replay    | baseline-small            | 1,2,3
activation_replay    | baseline-large            | 1,2,3
activation_replay    | incident-regression-stream| 1,2,3
activation_replay    | incident-regression-nonstream| 1,2,3
renewal_normal       | baseline-small            | 1,2,3
renewal_normal       | baseline-large            | 1,2,3
renewal_normal       | incident-regression-stream| 1,2,3
renewal_normal       | incident-regression-nonstream| 1,2,3
terminal_normal      | baseline-small            | 1
terminal_normal      | baseline-large            | 1
terminal_normal      | incident-regression-stream| 1
terminal_normal      | incident-regression-nonstream| 1
terminal_replay      | baseline-small            | 1,2,3
terminal_replay      | baseline-large            | 1,2,3
terminal_replay      | incident-regression-stream| 1,2,3
terminal_replay      | incident-regression-nonstream| 1,2,3
```

Example:

```text
activation_replay x incident-regression-stream x concurrency=1
activation_replay x incident-regression-stream x concurrency=2
activation_replay x incident-regression-stream x concurrency=3
renewal_normal x incident-regression-stream x concurrency=1
renewal_normal x incident-regression-stream x concurrency=2
renewal_normal x incident-regression-stream x concurrency=3
terminal_replay x incident-regression-stream x concurrency=1
terminal_replay x incident-regression-stream x concurrency=2
terminal_replay x incident-regression-stream x concurrency=3
activation_normal x incident-regression-stream x concurrency=1
terminal_normal x incident-regression-stream x concurrency=1
```

The series must never be pooled for percentile or sample-count purposes.

### Sequential, non-overlapping measurement windows

Required series are executed **sequentially**, not concurrently with another
gate series for the same candidate version.

For every series the external measurement harness records:

```text
stage
candidate ScriptVersion
candidate source revision
invocationClass
workloadClass
concurrency
list of per-invocation windows [windowStart, windowEnd)
expected successful invocation count
```

Rules:

1. No two required series for one candidate may have overlapping
   `[windowStart, windowEnd)` intervals.
2. The next series starts only after all driver invocations in the prior series
   have completed.
3. A series may consist of multiple non-overlapping per-invocation windows when
   each sample needs auxiliary control calls (setup, fence, terminalization)
   between measured invocations. Auxiliary control calls are placed outside the
   series windows and classified as `cpu-gate-control`; they are excluded from
   lifecycle series counts and 5/7/0 evaluation.
4. Stage 2 normal traffic remains on the stable/bridge version, so filtering by
   candidate `ScriptVersion` removes unrelated normal Production traffic.
5. The candidate `ScriptVersion`, route, and exact measurement window must be
   sufficient to reconstruct the series from platform telemetry without an
   application marker.
6. If any platform invocation in the window cannot be uniquely assigned to the
   expected series, the series is `BLOCKED / INCOMPLETE`.
7. Gate-time Worker invocation telemetry sampling must be 100%. The existing
`head_sampling_rate = 1` behavior becomes a normative prerequisite rather
than an incidental repository setting.

### Required evidence per series

Each series records at least:

```text
p50
p90
p95
p99
max
exceededCpu
successful invocation count
platform invocation count
CPU telemetry record count
Worker ScriptVersion
candidate source revision
workload class
concurrency
measurement stage
list of per-invocation windows
```

Each required series needs at least **500 successful invocations**. Five hundred
samples cannot be satisfied by combining concurrency conditions.

PASS requires all of:

```text
successfulInvocations >= 500
platform invocation count explained by the harness
required CPU telemetry is complete
p99 <= 5 ms
max <= 7 ms
exceededCpu = 0
candidate ScriptVersion matches
candidate source revision matches
workload classification matches
execution condition matches
measurement window is non-overlapping
```
FAIL means sufficient evidence exists and the CPU gate itself is violated.

An `exceededCpu` platform invocation is never discarded because an application
marker is absent. If candidate version + route + measurement window assigns it
to the series, that series is FAIL.

BLOCKED / INCOMPLETE includes:

- candidate ScriptVersion cannot be proven;
- measurement windows overlap;
- insufficient successful samples;
- CPU telemetry undercount;
- query failure;
- platform invocation count and harness count cannot be explained;
- a platform invocation cannot be uniquely assigned to a series;
- revision mismatch;
- missing required series;
- ambiguous workload classification.

Telemetry deficiency must never be treated as PASS.

## Canonical workload design

The measurement matrix uses a small set of representative workload classes
instead of a combinatorial product of every feature.

### baseline-small

Ordinary valid Responses-relay shape:

- small body;
- shallow history;
- no tool/function history;
- representative callback lifecycle.

### baseline-large

Representative large valid Responses shape:

- approximately the previously exercised upper-size classes;
- substantial history;
- same relay lifecycle;
- no requirement that it reproduce the Production incident shape.

### incident-regression-stream

Synthetic workload reproducing the structural characteristics of the
Production CPU recurrence, with `stream=true`.

Include incident-relevant features supported by evidence, such as:

- request/body size class;
- conversation/history depth;
- tool/function-call history;
- large response history;
- callback lifecycle shape.

### incident-regression-nonstream

The same incident-derived structural shape with `stream=false`.

The actual Production payload, prompts, responses, credentials, or customer
data must never become fixtures.

These incident-derived workloads remain after Issue #121 closes and become
part of the future CPU regression gate.

### Stage-specific ingress/decision model

`ingress` and `decision` are measured against a stage-appropriate model so that
Stage 1 exercises the normal admission and grant-signing path while Stage 2
remains a Production-safe canary that cannot consume Production quota.

- **Stage 1** uses a Preview-enabled complimentary model that classifies to the
  requested pool. The runner verifies the model is present in the Preview
  registry before measurement. These series exercise normal admission,
  Cloudflare-side grant signing, and callback dispatch.
- **Stage 2** uses a runner-provided canary client key and the synthetic model
  `octg-cpu-gate-reject-v1`. One unmeasured preflight request must prove that
  this model receives `model_requires_paid` with no admission/grant; any other
  outcome makes the Stage 2 series `BLOCKED / INCOMPLETE`.

The `decision` invocation class is measured by invoking
`/internal/relay/v1/decision` directly. For each decision sample the runner:

1. generates a fresh runner-owned `req_<ULID>` decision request ID;
2. calls the CPU-gate `decision-context` route to obtain a Cloudflare-signed
   `contextToken` without performing admission;
3. issues `concurrency` simultaneous `/internal/relay/v1/decision` callbacks with:

```text
X-OCTG-Relay-Context: <contextToken>
Authorization: Bearer <OCTG_RELAY_SERVICE_AUTH_TOKEN>
Cloudflare-Workers-Version-Overrides: <worker-name>="<candidate-version-id>"
```

4. captures any `X-OCTG-Relay-Grant` headers returned by allowed callbacks;
5. terminalizes the resulting grants via the normal `/internal/relay/v1/terminal`
   callback and proves the fixture is terminal before starting the next sample.

Stage 2 uses the reject model, so callbacks return reject before creating a
grant and no terminal cleanup is required. The runner never constructs or signs
a RelayContext.

`ingress` uses the same override header on `/v1/responses`. `activation`,
`renewal`, and `terminal` use the Worker-signed grant credential obtained from
CPU-gate setup and the same override header.

## Conditional Phase 2: RelayGrantLifecycleController

### Activation condition

Introduce `RelayGrantLifecycleController` when any required activation,
renewal, or terminal Worker series fails the CPU gate in either Stage 1 or
Stage 2.

If Stage 2 triggers escalation, the new implementation invalidates the old
Stage 1 evidence and the complete Stage 1 matrix must be rerun.

Ingress or decision failures do not activate this design automatically; those
paths are remediated independently.

### Exact class and binding

The names are normative:

```text
class:
RelayGrantLifecycleController

binding:
RELAY_GRANT_LIFECYCLE_CONTROLLER
```

The Worker `Env` contract uses
`DurableObjectNamespace<RelayGrantLifecycleController>` for this binding.

### Responsibility boundary

After escalation:

```text
Deno
  |
  v
Stateless Worker
  - service bearer validation
  - method/path/content-type validation
  - bounded body/header validation
  - unsigned requestId hint extraction
  - lifecycle DO dispatch
  - HTTP response envelope encoding
  |
  v
RelayGrantLifecycleController
  - grant HMAC verification
  - canonical token verification
  - environment / expiry validation
  - verified requestId -> shard identity recheck
  - callback JSON parsing
  - action-specific semantic validation
  - grantId / leaseGeneration binding validation
  - QuotaController dispatch
  |
  v
QuotaController
  - authoritative lifecycle state transition
  - idempotency
  - conflict handling
  - quota state
```

The Worker owns HTTP transport and HTTP response encoding. The lifecycle DO
never returns an HTTP `Response`.

### Internal RPC contract

Use **one** lifecycle RPC:

```text
RelayGrantLifecycleController.dispatch(
  input: RelayGrantLifecycleDispatchInput
): Promise<RelayGrantLifecycleDispatchResult>
```

The shared contract is:

```ts
export type RelayGrantLifecycleAction =
  | "activation"
  | "renewal"
  | "terminal";

export interface RelayGrantLifecycleDispatchInput {
  readonly action: RelayGrantLifecycleAction;
  readonly grantToken: string;
  readonly callbackBody: Uint8Array;
}

export type RelayGrantLifecycleDispatchResult =
  | {
      readonly kind: "activation";
      readonly response: RelayActivationResponseV1;
    }
  | {
      readonly kind: "renewal";
      readonly response: RelayRenewalResponseV1;
    }
  | {
      readonly kind: "terminal";
      readonly response: RelayTerminalResponseV1;
    }
  | {
      readonly kind: "protocol_error";
      readonly code: "invalid_context" | "invalid_request";
    }
  | {
      readonly kind: "internal_error";
      readonly code: "internal_error";
    };

export interface RelayGrantLifecycleControllerOperations {
  dispatch(
    input: RelayGrantLifecycleDispatchInput
  ): Promise<RelayGrantLifecycleDispatchResult>;
}
```

The result is structured-clone-safe. It carries no `Response`, secret, raw key,
or request/response payload beyond the already-bounded callback contract.

### Worker HTTP mapping

Existing Deno-visible wire behavior is preserved.

| DO result | Worker HTTP behavior |
| --- | --- |
| `activation` | HTTP 200 with existing `RelayActivationResponseV1` |
| `renewal` | HTTP 200 with existing `RelayRenewalResponseV1` |
| `terminal` | HTTP 200 with existing `RelayTerminalResponseV1` |
| `protocol_error: invalid_context` | HTTP 400 existing `{version:1,error:{code:"invalid_context"}}` |
| `protocol_error: invalid_request` | HTTP 400 existing `{version:1,error:{code:"invalid_request"}}` |
| `internal_error` or thrown DO RPC | HTTP 500 existing `{version:1,error:{code:"internal_error"}}` |

Specific ownership rules:

- invalid HMAC -> `protocol_error: invalid_context`;
- wrong signed environment -> `protocol_error: invalid_context`, preserving
  current `verifyRelayGrantHeader` behavior;
- expired credential -> `protocol_error: invalid_context`, preserving current
  behavior;
- malformed callback JSON -> `protocol_error: invalid_request`;
- callback/grant binding mismatch detected before QuotaController dispatch ->
  `protocol_error: invalid_request`;
- QuotaController denial -> the action-specific HTTP 200 response with the
  existing denial code/state mapping;
- QuotaController RPC failure -> `internal_error`.

No new Deno-visible status, error code, envelope, or retry rule is introduced.

### Exact shard identity

Lifecycle routing uses the same 32-bit FNV shard-index algorithm and 64-way
mask as `RelayDecisionController`, but a different namespace prefix.

The exact lifecycle DO name is:

```text
relay-grant-lifecycle:v1:<environment>:<00..63>
```

Rules:

- the shard index is derived from `requestId`;
- the prefix is exactly `relay-grant-lifecycle`;
- the version component is exactly `v1`;
- environment is exactly `preview` or `production`;
- shard is a zero-padded two-digit value `00` through `63`;
- the shard-index implementation must be shared with
  `RelayDecisionController` or behavior-frozen by common tests so the
  algorithm cannot silently diverge.

Worker behavior:

1. Decode only enough of the **unverified** grant payload to extract a
   syntactically valid `requestId` routing hint.
2. Compute `relay-grant-lifecycle:v1:<runtime-environment>:<shard>`.
3. Dispatch the raw grant token, bounded raw callback body, and action.

Lifecycle DO behavior:

1. Verify the signed grant fully.
2. Require the verified signed environment to equal the runtime environment.
3. Recompute the expected shard from the **verified** request ID.
4. Parse its own DO name and require exact prefix/version/environment/shard.
5. Reject verified shard mismatch as `invalid_request`.
6. Treat an invalid own DO name as `internal_error`.
7. Only then parse callback semantics and select the authoritative
   `QuotaController`.

The unsigned routing hint is never authorization data.

### State ownership

`RelayGrantLifecycleController` is a CPU/trust processing boundary only. It
holds no authoritative durable lifecycle state.

It does not:

- own quota;
- own grant state;
- own idempotency state;
- own terminal conflict state;
- cache authoritative lifecycle results in Durable Object storage.

Retries repeat verification and dispatch to the same authoritative
`QuotaController`, whose existing lifecycle/idempotency semantics remain
canonical.

## Failure semantics

The entire remediation remains fail-closed.

### Worker-side failures

```text
service auth failure     -> existing unauthorized_service response
invalid method/path      -> existing transport rejection
invalid content type     -> existing invalid_request response
oversized transport      -> existing request_too_large response
invalid routing hint     -> invalid_context
DO dispatch failure      -> internal_error
```

A lifecycle-DO dispatch failure must not fall back to the old Worker-heavy
grant processing path.

### Lifecycle-DO failures

```text
invalid grant HMAC        -> invalid_context
expired grant             -> invalid_context
wrong environment         -> invalid_context
shard identity mismatch   -> invalid_request
invalid callback JSON     -> invalid_request
semantic binding mismatch -> invalid_request
QuotaController RPC error -> internal_error
```

Duplicate activation/renewal/terminal, stale lease generation, conflicting
terminal results, and grant expiry after authoritative lookup continue to use
the existing QuotaController result semantics.

## Stage 2 Durable Object compatibility bridge

Cloudflare gradual deployments can run a Worker request on one version while a
Durable Object instance is assigned to another version from the same
deployment. A version override targets the incoming Worker invocation; it does
not pin the code version of a Durable Object instance reached through an RPC.

Therefore Stage 2 MUST NOT begin directly from the pre-Issue-#121 Production
stable version.

After Stage 1 PASS and before uploading/targeting the CPU-tested candidate,
Production is first moved to a **Stage 2 Durable Object compatibility bridge**
at 100%.

The bridge provisioning deployment is not CPU acceptance evidence.

### Compatibility invariant

The bridge exists to make every Durable Object RPC surface that the CPU-tested
candidate may call forward/backward compatible before candidate traffic exists.

For the entire gradual rollout, the design permits all physically possible
Worker/DO version combinations:

```text
bridge Worker    -> bridge-version QuotaController
bridge Worker    -> candidate-version QuotaController
candidate Worker -> bridge-version QuotaController
candidate Worker -> candidate-version QuotaController
```

When Phase 2 is active, the candidate Worker may additionally call either a
bridge-version or candidate-version `RelayGrantLifecycleController`.

Existing QuotaController RPCs MUST NOT be removed, renamed, or given
behavior-incompatible semantics in either version.

### Bridge Worker behavior

The bridge Worker preserves normal Production request behavior from the
pre-bridge stable version:

- public Responses ingress behavior is unchanged;
- normal decision routing is unchanged;
- normal activation/renewal/terminal callbacks remain on the existing
  Worker-side lifecycle path;
- Chat Completions is unchanged;
- no normal request uses CPU-gate control routes;
- `OCTG_RELAY_CPU_GATE_AUTH_TOKEN` may be absent, leaving all CPU-gate
  control routes disabled with 404.

The bridge may add Durable Object exports/RPC implementations required for
compatibility, but it MUST NOT enable candidate-only normal traffic routing.

### Phase 2 inactive bridge

When HMAC CryptoKey reuse alone passes the lifecycle CPU gate, no lifecycle DO
migration is required.

The compatibility bridge still MUST contain a QuotaController implementation
with:

```text
all existing QuotaController RPCs
getRelayCpuGateSnapshot()
getRelayCpuGateGrantInspection(requestId)
```

The two CPU-gate inspection RPCs have the exact same shared contract and
canonical semantics as the CPU-tested candidate.

The four non-secret fixture identifiers are available to bridge-version
QuotaController instances:

```text
OCTG_RELAY_CPU_GATE_STANDARD_CLIENT_ID
OCTG_RELAY_CPU_GATE_STANDARD_MODEL
OCTG_RELAY_CPU_GATE_MINI_CLIENT_ID
OCTG_RELAY_CPU_GATE_MINI_MODEL
```

No Durable Object lifecycle migration is added in this branch.

### Phase 2 active bridge

If lifecycle offload is required, the compatibility bridge also performs the
Durable Object class lifecycle migration.

The current legacy migration history is:

```text
v1 QuotaController
v2 TokenizerController
v3 RelayDecisionController
```

The next migration is exactly:

```text
tag: v4
new_sqlite_classes:
  - RelayGrantLifecycleController
```

The repository remains on the legacy `migrations` flow for this issue.

Because a Durable Object lifecycle change cannot be introduced by
`wrangler versions upload`, the Phase-2-active compatibility bridge is
deployed with ordinary:

```text
wrangler deploy
```

The bridge:

- applies append-only migration `v4`;
- exports `RelayGrantLifecycleController`;
- contains binding `RELAY_GRANT_LIFECYCLE_CONTROLLER`;
- contains the candidate-compatible QuotaController CPU-gate RPCs;
- retains existing Production bindings/secrets;
- keeps normal activation/renewal/terminal traffic on the existing Worker-side
  path;
- does not route normal bridge traffic through
  `RelayGrantLifecycleController`.

After `v4`, no version earlier than the compatibility bridge is a valid
rollback target for Phase 2.

### Lifecycle DO implementation is not a migration placeholder

When Phase 2 is active, the bridge
`RelayGrantLifecycleController` MUST be a full candidate-compatible
implementation, not a placeholder used only to apply migration `v4`.

Its following behavior is identical to the CPU-tested candidate:

```text
dispatch() signature/result union
grant HMAC verification semantics
canonical grant verification
environment / expiry validation
verified requestId shard recheck
callback JSON parsing
action-specific semantic validation
grantId / leaseGeneration binding
QuotaController dispatch
internal error mapping
```

Normal bridge traffic does not use this class, but candidate Worker traffic may
reach a bridge-assigned lifecycle DO during gradual deployment.

### Mechanical DO implementation equivalence

The compatibility bridge and CPU-tested candidate may have different Worker
source revisions because their normal Worker routing behavior differs.

However, their **DO compatibility artifact** MUST be mechanically identical.

The build/release process produces a deterministic
`do-compatibility-manifest` for both bridge and candidate. The manifest
contains SHA-256 digests over the compiled module closure that affects:

```text
QuotaController
QuotaController CPU-gate inspection RPCs
canonical cpuGateFixture predicate
shared CPU-gate RPC result/input types
existing QuotaController lifecycle/grant semantics
shared quota storage/state transition helpers

and, when Phase 2 is active:

RelayGrantLifecycleController
lifecycle dispatch RPC types
lifecycle shard algorithm
grant verification/parsing helpers used by lifecycle DO
lifecycle -> QuotaController dispatch/error mapping
```

Bridge and candidate manifests MUST match exactly for every applicable root.

This manifest compares behavior-affecting transitive dependencies, not merely
top-level source filenames.

A manifest mismatch blocks candidate upload/Stage 2.

### Bridge configuration equivalence

The compatibility bridge and CPU-tested candidate use the same Production:

- QuotaController namespace/binding;
- relay secrets other than the CPU-gate-only control secret;
- quota limits;
- max-in-flight configuration;
- relay environment;
- fixture client/model variables;
- lifecycle DO namespace/binding when Phase 2 is active.

The bridge does not require `OCTG_RELAY_CPU_GATE_AUTH_TOKEN`. The
CPU-tested candidate does require it for Stage 2 control routes.

### CPU-tested candidate upload

Only after the bridge is at 100% and its compatibility verification passes may
the CPU-tested candidate be uploaded.

The CPU-tested candidate is built from the exact immutable source revision that
passed Stage 1.

If Phase 2 is active, migration `v4` is already applied by the bridge and the
candidate upload contains no new Durable Object lifecycle change.

Create a deployment containing exactly:

```text
Stage 2 compatibility bridge: 100%
CPU-tested candidate:            0%
```

Both version IDs MUST be members of the current deployment before Stage 2
preflight begins.

### Version override responsibility

Every Stage 2 candidate request uses:

```text
Cloudflare-Workers-Version-Overrides:
  <production-worker-name>="<exact-cpu-tested-candidate-version-id>"
```

The override pins only the **incoming Worker invocation** to the
CPU-tested candidate in the current deployment.

It does **not** pin:

```text
QuotaController instance code version
RelayGrantLifecycleController instance code version
```

A stateless Worker CPU sample is accepted only when platform
`ScriptVersion` metadata proves that the incoming invocation ran the exact
CPU-tested candidate.

Durable Object correctness is guaranteed separately by the bridge/candidate
compatibility invariant and the exact DO compatibility manifest.

If DO CPU evidence is recorded separately, record the observable DO code
version when available, but do not mix DO CPU evidence into the stateless
Worker 5/7/0 gate.

### Stage 2 Durable Object compatibility preflight

Before any Stage 2 CPU measurement window, verify all of:

```text
compatibility bridge = 100%
CPU-tested candidate = 0%
candidate version override resolves to exact candidate ScriptVersion
bridge/candidate do-compatibility-manifest = exact match
bridge QuotaController exposes candidate-compatible CPU-gate RPCs
```

Then, outside all CPU measurement windows, run one bounded compatibility
preflight operation through the exact candidate version override.

The preflight operation uses a fresh runner-owned request ID and is **not**
reused as Stage 2 CPU measurement evidence.

The common sequence is:

```text
candidate override confirmed
    ->
CPU-gate setup(preflight requestId)
    ->
operation-inspection proves canonical CPU-gate fixture
    ->
required compatibility smoke
    ->
terminalize preflight fixture
    ->
operation-inspection proves terminal state and no active lease
    ->
only then Stage 2 CPU measurement may begin
```

For Phase 2 inactive, the exact control smoke is:

```text
candidate Worker
  -> bridge-compatible QuotaController
  -> CPU-gate snapshot / setup / operation inspection
```

After the smoke, call:

```text
reconcile-unused(preflight pool, preflight requestId)
```

and require:

```text
kind = fixture
cpuGateFixture = true
state = reconciled_unused
requestState = released
activeLease = false
```

before the preflight operation is closed.

When Phase 2 is active, additionally prove:

```text
bridge exports candidate-compatible RelayGrantLifecycleController.dispatch

candidate Worker
  -> lifecycle DO
  -> QuotaController
```

with the same preflight fixture outside the CPU measurement windows.

If the lifecycle smoke has already completed the fixture through the normal
terminal callback path, require the canonical terminal inspection instead:

```text
kind = fixture
cpuGateFixture = true
state = settled
requestState = settled
actualTokens = 0
activeLease = false
```

and perform no additional reconcile mutation.

If the Phase-2-active control smoke leaves the fixture in any non-terminal
CPU-gate state, use the existing protected
`reconcile-unused(preflight pool, preflight requestId)` recovery seam and
require `reconciled_unused / released / activeLease=false`.

The compatibility-preflight request ID, setup invocation, callback invocations,
cleanup invocation, and inspections are all excluded from Stage 2 CPU series
measurement windows and sample counts.

Stage 2 CPU measurement MUST NOT begin while any compatibility-preflight
CPU-gate operation is non-terminal.

The first Stage 2 measurement fixture is therefore a fresh runner-owned
operation created only after the preflight operation is authoritative terminal
or absent.

Failure is `BLOCKED / INCOMPLETE`; it is not repaired by weakening the CPU
gate, reusing the preflight fixture as measurement evidence, or bypassing the
Durable Object path.

### Bridge rollback baseline

Once the compatibility bridge verification passes, it is the Stage 2
stable/rollback baseline.

If Stage 2 or candidate rollout fails:

- restore the compatibility bridge to 100%;
- remove the CPU-tested candidate from active traffic as appropriate;
- retain bridge-compatible QuotaController RPCs;
- if Phase 2 is active, retain migration `v4`, lifecycle class/binding, and
  candidate-compatible lifecycle DO implementation;
- never roll back to a pre-`v4` version after `v4` is applied.

## Stage 1: isolated Preview / temporary-resource gate

Run the complete canonical workload matrix against isolated Preview or
temporary resources.

Stage 1 uses isolated Preview quota state and may exercise the complete normal
grant lifecycle, including real successful activation/renewal/terminal
semantics against Preview resources.

Every required Worker series must:

- use the CPU-tested candidate source revision;
- use the approved measurement harness;
- use the approved workload definitions;
- reach at least 500 successful invocations;
- satisfy the 5/7/0 CPU gate.

Stage 1 PASS alone does not authorize rollout completion.

If Phase 2 is active, the Preview DO migration must already be applied through
a migration-capable deploy before version-based smoke/CPU measurement, matching
the repository's existing Preview migration design.

## Stage 2: Production-like controlled CPU canary

### Traffic isolation

Normal Production traffic remains on the Stage 2 compatibility bridge at
100%.

Only the protected canary driver targets the CPU-tested candidate at 0% by
version override.

Stage 2 cannot start until the Durable Object compatibility preflight defined
above has passed.

The 500-sample CPU acceptance matrix is **not** a Production load test and does
not intentionally send upstream model traffic.

### Quota-state protection principle

Stage 2 uses the real Production `QuotaController` namespace because the final
candidate must be the exact Production version under acceptance.

The measurement protocol therefore makes Production quota-state impact
explicit and bounded rather than pretending the candidate is isolated.

The Stage 2 CPU gate must not consume Production token quota.

### Ingress and decision series: pre-admission fixtures

Ingress and decision CPU series use valid synthetic request shapes that retain
the required body size, stream mode, history/tool characteristics, and
transport path but are deterministically rejected **before `admitRelay`**.

The rejection reason must be a normal Production policy/model result, not a
test-only bypass.

Consequences:

- no grant is created;
- no quota reservation is created;
- no in-flight lease is created;
- no upstream request is attempted;
- the candidate Worker ingress/decision path is still measured.

The harness records the exact expected rejection and treats any unexpected
admission as an immediate Stage 2 abort.

### Stage 2 gate control-plane boundary

Stage 2 uses a dedicated internal CPU-gate control surface. It is not part of
the public API and is not available to Deno.

The exact Worker secret is:

```text
OCTG_RELAY_CPU_GATE_AUTH_TOKEN
```

It has the same 32-256 printable-ASCII shape as the relay service bearer, but
it is a different credential and trust class.

Credential ownership is normative:

```text
OCTG_RELAY_CONTEXT_HMAC_KEY
  -> Cloudflare Worker / Cloudflare-side relay trust components only
  -> never external harness
  -> never Deno

OCTG_RELAY_SERVICE_AUTH_TOKEN
  -> Worker
  -> Deno relay runtime
  -> protected Stage 2 gate runner
  -> existing lifecycle callback Authorization only

OCTG_RELAY_CPU_GATE_AUTH_TOKEN
  -> Worker + protected Stage 2 gate runner only
  -> CPU-gate measurement control plane only
  -> never Deno
  -> not a signing key
```

The protected Stage 2 runner receives both bearer credentials only from the
deployment/CI secret store as ephemeral process secrets.

For the service bearer, Stage 2 use is restricted to the existing exact
Production callback routes:

```text
POST /internal/relay/v1/decision
POST /internal/relay/v1/activation
POST /internal/relay/v1/renewal
POST /internal/relay/v1/terminal
```

The runner does not use the service bearer on any CPU-gate control route.

For the CPU-gate bearer, use is restricted to:

```text
/internal/relay/v1/cpu-gate/quota
/internal/relay/v1/cpu-gate/setup
/internal/relay/v1/cpu-gate/setup-fence
/internal/relay/v1/cpu-gate/decision-context
/internal/relay/v1/cpu-gate/operation-inspection
/internal/relay/v1/cpu-gate/reconcile-unused
```

Neither bearer may be stored in the repository, shell trace, request fixture,
application log, acceptance report, retained artifact, or long-lived local
file. The Stage 2 runner discards both when the run ends.

### CPU-gate secret lifecycle

CPU-gate control availability is controlled entirely by
`OCTG_RELAY_CPU_GATE_AUTH_TOKEN`.

The exact runtime semantics are:

```text
secret absent
  -> CPU-gate control surface disabled
  -> every /internal/relay/v1/cpu-gate/* request returns 404
  -> no body parsing
  -> no Durable Object call
  -> no mutation

secret present but invalid shape
  -> CPU-gate control surface disabled
  -> same 404 fail-closed behavior

secret valid
  -> control surface enabled
  -> every CPU-gate route requires exact Bearer authentication
  -> missing/malformed/mismatched Authorization returns 401
  -> no Durable Object call on authentication failure
  -> if OCTG_RELAY_CPU_GATE_AUTH_TOKEN equals OCTG_RELAY_SERVICE_AUTH_TOKEN,
     the control surface is disabled with the same 404 fail-closed behavior as
     an absent secret
```

Bearer comparison is constant-time. The Worker additionally validates at startup
that the CPU-gate bearer and the service bearer are distinct non-empty values;
if they are equal, `resolveRelayCpuGateControl(env)` returns `kind:"disabled"`.

The secret remains present throughout:

```text
Stage 2
  ->
Stage 2 PASS
  ->
rollout of the exact CPU-tested candidate ScriptVersion
  ->
candidate reaches 100%
  ->
rollout acceptance completes
  ->
all runner-owned CPU-gate operations are proven absent or terminal
```

Only after that sequence is complete may the CPU-gate secret be removed.

Secret removal creates a **new Worker version**. It is therefore not treated as
an environment-only mutation of the already-tested candidate.

The exact hardening operation is:

```text
wrangler versions secret delete OCTG_RELAY_CPU_GATE_AUTH_TOKEN
```

The non-versioned `wrangler secret delete` operation is not used because it
would create and immediately deploy the new version.

The new secret-less version is called the **post-gate hardening version**. It is
distinct from the **CPU-tested candidate version**.

The CPU-gate routes are routed before the generic relay callback action parser
so they cannot be mistaken for Deno callback actions.

### Exact read-only QuotaController inspection contracts

Add the following shared internal types:

```ts
export interface RelayCpuGateSnapshot {
  readonly version: 1;
  readonly pool: PoolName;
  readonly utcDay: string;
  readonly limit: number;
  readonly remaining: number;
  readonly confirmedTokens: number;
  readonly reservedTokens: number;
  readonly uncertainTokens: number;
  readonly requestCount: number;
  readonly unresolvedReservedCount: number;
  readonly unresolvedUncertainCount: number;
  readonly activeLeaseCount: number;
  readonly maxInFlight: number;
}

export type RelayCpuGateGrantState =
  | "authorized"
  | "attempted"
  | "uncertain"
  | "settled"
  | "released"
  | "reconciled_consumed"
  | "reconciled_unused";

export type RelayCpuGateGrantInspection =
  | {
      readonly kind: "absent";
      readonly cpuGateFixture: false;
      readonly fenced: boolean;
    }
  | {
      readonly kind: "non_fixture";
      readonly cpuGateFixture: false;
    }
  | {
      readonly kind: "fixture";
      readonly state: RelayCpuGateGrantState;
      readonly requestState: RequestState;
      readonly reservedTokens: number;
      readonly upperBoundTokens: number;
      readonly maxOutputTokens: number;
      readonly actualTokens: number | null;
      readonly activeLease: boolean;
      readonly cpuGateFixture: true;
    };

export type RelayCpuGateFenceResult =
  | {
      readonly kind: "fenced";
    }
  | {
      readonly kind: "fixture";
      readonly inspection: Extract<
        RelayCpuGateGrantInspection,
        { readonly kind: "fixture" }
      >;
    }
  | {
      readonly kind: "non_fixture";
      readonly inspection: Extract<
        RelayCpuGateGrantInspection,
        { readonly kind: "non_fixture" }
      >;
    };

export interface RelayCpuGateControllerOperations {
  getRelayCpuGateSnapshot(): Promise<RelayCpuGateSnapshot>;
  getRelayCpuGateGrantInspection(
    requestId: string,
  ): Promise<RelayCpuGateGrantInspection>;
  fenceRelayCpuGateSetup(requestId: string): Promise<RelayCpuGateFenceResult>;
}
```
`QuotaController` implements exactly these additional RPCs.

The earlier state-only inspection concept is superseded. The canary-specific
RPCs are `getRelayCpuGateGrantInspection(requestId)` and
`fenceRelayCpuGateSetup(requestId)`. `getRelayCpuGateSnapshot()` remains read-only;
`fenceRelayCpuGateSetup(requestId)` writes a durable setup fence.

The earlier state-only inspection concept is superseded. The only
canary-specific read-only RPC is
`getRelayCpuGateGrantInspection(requestId)`.

#### Snapshot authority

`getRelayCpuGateSnapshot()` derives all fields from the owning
`quota:<POOL>:<UTC_DAY>` object:

- pool counters and `requestCount` from canonical pool state;
- unresolved counts from canonical unresolved state;
- `activeLeaseCount` from canonical in-flight lease state after read-only
  expiry filtering at `Date.now()`;
- `maxInFlight` from the same effective `MAX_IN_FLIGHT_REQUESTS`
  resolution used by relay admission;
- `limit` and `remaining` from canonical quota state.

The snapshot RPC performs no storage write, including no cleanup write for
expired leases.

Snapshot values are capacity/preflight and diagnostic evidence only. Because
normal Production traffic shares the same QuotaController namespace, changes
in global counters during Stage 2 are not candidate failures.

`getRelayCpuGateGrantInspection(requestId)` reads only canonical
QuotaController storage for that request ID:

- `relay-grant:<requestId>`;
- `req:<requestId>`;
- `cpu-gate-fence:<requestId>` if present;
- canonical active in-flight leases after read-only expiry filtering.

Its internal result distinguishes:

- `absent`: neither a request entry, relay grant, nor durable fence exists for
  the ID;
- `fenced absent`: neither a request entry nor relay grant exists, and a durable
  CPU-gate setup fence is present, so a delayed original setup cannot leave a
  live fixture;
- `non_fixture`: canonical state exists but does not satisfy the CPU-gate
  fixture predicate;
- `fixture`: canonical request/grant facts satisfy the complete fixture
  predicate below.

This distinction is available only inside the trusted Worker/QuotaController
boundary. External recovery routes expose `fenced absent` and `non_fixture` as
different HTTP responses so the runner applies distinct recovery rules. Both
responses must disclose no facts about ordinary Production requests.

Use:
- `absent` -> HTTP `425 Too Early` with body `{"version":1,"kind":"pending_ambiguous"}`;
- `fenced absent` -> HTTP `404 Not Found` with body `{"version":1,"kind":"absent"}`;
  the runner may close operation A and start a new operation B with a fresh
  request ID;
- `non_fixture` -> HTTP `409 Conflict` with body `{"version":1,"error":"setup_state_incompatible"}`;
  the runner must not retry `setup(A)` and must treat the operation as
  `BLOCKED / INCOMPLETE`.

The response for `non_fixture` must be produced without reading any ordinary
request metadata beyond the fixture-predicate failure; it must not leak client,
model, tokens, or state values.

The QuotaController environment receives the same four non-secret,
pool-specific fixture identifiers used by the Worker setup route:

```text
OCTG_RELAY_CPU_GATE_STANDARD_CLIENT_ID
OCTG_RELAY_CPU_GATE_STANDARD_MODEL
OCTG_RELAY_CPU_GATE_MINI_CLIENT_ID
OCTG_RELAY_CPU_GATE_MINI_MODEL
```

The QuotaController chooses the expected client/model from its own pool
identity. The caller cannot supply or override expected client/model values.

For a found grant, `cpuGateFixture=true` only when all canonical facts are:

```text
grant.clientId
grant.clientId
  == configured CPU-gate client for this QuotaController pool

grant.model
  == configured CPU-gate model for this QuotaController pool

grant.pool
  == this QuotaController pool

grant.admissionUtcDay
  == this QuotaController utcDay

grant.idempotencyKeyHash
  == null

grant.admission.reservedTokens
  == 0

grant.admission.upperBoundTokens
  == 0

grant.admission.maxOutputTokens
  == 0

grant.admission.cacheEnabled
  == false

grant.admission.metadata.estimatedInputTokens
  == 0

grant.admission.metadata.maxOutputTokens
  == 0

grant.admission.metadata.inputBytes
  == 0

grant.admission.metadata.rawBodyBytes
  == 0

grant.admission.metadata.isToolUse
  == false

grant.admission.metadata.stream
  == false

request entry exists

request entry.idempotencyKey
  == undefined

request entry.tokens
  == 0

request entry.upperBoundTokens
  == 0

request entry.reservedTokens
  == 0
```

If any condition is false, the internal result is `non_fixture`. The presence or
absence of an active in-flight lease does **not** affect `cpuGateFixture`; an
expired, settled, released, or reconciled CPU-gate fixture remains a fixture as
long as the canonical facts above still match.

`activeLease` is reported as a separate field in the `fixture` inspection. It is
`true` only when the canonical active in-flight lease set contains this request
ID with the grant's exact `leaseGeneration`. Terminal fixtures report
`activeLease=false`.

`actualTokens` is the request entry's canonical `actualTokens` when present,
otherwise `null`.
`actualTokens` is the request entry's canonical `actualTokens` when present,

This inspection performs no mutation and exposes no payload, prompt, key,
credential, client/model identity, normal request list, or unrelated request
state.

### Stable CPU-gate operation identity

A CPU-gate setup operation has a stable identity **before any Production
mutation occurs**.

The setup request is exactly:

```ts
interface RelayCpuGateSetupRequestV1 {
  readonly version: 1;
  readonly pool: "STANDARD" | "MINI";
  readonly requestId: string;
}
```

1. generates `requestId` before sending setup;
2. generates it as `req_<ULID>` satisfying `RELAY_REQUEST_ID_PATTERN`;
3. stores it only in protected ephemeral runner state **and** in a protected
   operation journal that contains no secrets;
4. never treats it as client, pool, quota, or authorization data.

The operation journal records for every runner-owned operation:

```text
pool
requestId
state (pending | active | terminalizing | fenced_absent | terminal | blocked)
createdAt timestamp
lastTransitionAt timestamp
```

The journal is mode `0600`, lives in a protected temporary directory, and is never
committed. On driver startup, the runner reads the journal and must recover or
close every operation that is not already `fenced_absent` or `terminal` before
creating a new operation. Before deleting `OCTG_RELAY_CPU_GATE_AUTH_TOKEN`, the
runner must prove the journal is empty or that every recorded operation is in a
`fenced_absent` or `terminal` state.

The runner MUST NOT wait for `fenced` blindly: the setup-fence response itself
is authoritative. A `fixture` response from setup-fence is equivalent to a
delayed successful admission; the runner must recover the existing fixture rather
than retry setup(A).

This serialization rule, together with the authoritative atomic
`QuotaController.admitRelay()` max-in-flight check and the durable setup fence,
preserves the design invariant that the CPU-gate itself owns at most one live
canary grant/lease.

The exact control routes are:

```text
GET  /internal/relay/v1/cpu-gate/quota
POST /internal/relay/v1/cpu-gate/setup
POST /internal/relay/v1/cpu-gate/setup-fence
POST /internal/relay/v1/cpu-gate/decision-context
POST /internal/relay/v1/cpu-gate/operation-inspection
POST /internal/relay/v1/cpu-gate/reconcile-unused
```

#### Quota snapshot

```text
GET /internal/relay/v1/cpu-gate/quota
    ?pool=STANDARD|MINI
    &utcDay=YYYY-MM-DD
Authorization: Bearer <OCTG_RELAY_CPU_GATE_AUTH_TOKEN>
```

The Worker:

1. requires the CPU-gate control surface to be enabled;
2. authenticates the CPU-gate bearer;
3. validates `pool` and `utcDay`;
4. resolves exactly `quota:<POOL>:<UTC_DAY>`;
5. calls `getRelayCpuGateSnapshot()`;
6. returns only `RelayCpuGateSnapshot`.

#### Operation inspection and recovery

```text
POST /internal/relay/v1/cpu-gate/operation-inspection
Content-Type: application/json
Authorization: Bearer <OCTG_RELAY_CPU_GATE_AUTH_TOKEN>
```

Body:

```ts
interface RelayCpuGateOperationRequestV1 {
  readonly version: 1;
  readonly pool: "STANDARD" | "MINI";
  readonly requestId: string;
}
```

The Worker:

1. requires the CPU-gate control surface to be enabled;
2. authenticates the CPU-gate bearer;
3. validates `pool` and `requestId`;
4. derives the operation UTC day from the requestId's ULID timestamp;
5. resolves the owning QuotaController by that embedded day (recovery is valid even
   after a calendar-day rollover);
6. calls `getRelayCpuGateGrantInspection(requestId)`;
7. maps `absent` with `fenced=true` to HTTP `404 Not Found` with body:

```ts
interface RelayCpuGateOperationAbsentV1 {
  readonly version: 1;
  readonly kind: "absent";
}
```

8. maps `absent` with `fenced=false` to HTTP `425 Too Early` with body:

```ts
interface RelayCpuGateOperationPendingV1 {
  readonly version: 1;
  readonly kind: "pending_ambiguous";
}
```

9. maps `non_fixture` to HTTP `409 Conflict` with body:

```ts
interface RelayCpuGateOperationIncompatibleV1 {
  readonly version: 1;
  readonly error: "setup_state_incompatible";
}
```

10. maps a canonical fixture to HTTP 200:

```ts
interface RelayCpuGateOperationInspectionV1 {
  readonly version: 1;
  readonly kind: "fixture";
  readonly inspection: Extract<
    RelayCpuGateGrantInspection,
    { readonly kind: "fixture" }
  >;
}
```
### Cloudflare-side lifecycle fixture setup

The external runner MUST NOT receive `OCTG_RELAY_CONTEXT_HMAC_KEY` and MUST
NOT construct or sign a RelayContext or RelayGrantCredential.

The exact setup route is:

```text
POST /internal/relay/v1/cpu-gate/setup
Content-Type: application/json
Authorization: Bearer <OCTG_RELAY_CPU_GATE_AUTH_TOKEN>
```

The Worker-owned pool-specific fixture identifiers are:

```text
OCTG_RELAY_CPU_GATE_STANDARD_CLIENT_ID
OCTG_RELAY_CPU_GATE_STANDARD_MODEL
OCTG_RELAY_CPU_GATE_MINI_CLIENT_ID
OCTG_RELAY_CPU_GATE_MINI_MODEL
```
Those client IDs are dedicated enabled CPU-gate clients and each configured
model must classify to its requested pool.
The external request cannot supply a client ID, model, reservation, upper
bound, cache mode, environment, metadata, nonce, or signing input.
For setup, the Worker:

1. requires the CPU-gate control surface to be enabled;
2. authenticates the CPU-gate bearer;
3. validates the runner-supplied request ID and requires its ULID UTC day to
   equal the current Worker UTC day;
4. derives the operation UTC day from the request ID;
5. resolves the owning QuotaController;
6. calls `getRelayCpuGateGrantInspection(requestId)` as collision preflight;
7. proceeds only when the result is `absent`; `non_fixture` or an existing
   fixture fails closed with no new mutation;
8. builds a valid Production `RelayContextV1` using exactly the runner-owned
   request ID, the dedicated fixture client, no idempotency key, runtime
   environment, normal context timestamps, and a fresh Worker-generated nonce;
9. constructs synthetic metadata with:
   - `model` = configured fixture model;
   - `estimatedInputTokens = 0`;
   - `maxOutputTokens = 0`;
   - `inputBytes = 0`;
   - `rawBodyBytes = 0`;
   - `isToolUse = false`;
   - `stream = false`;
10. calls the existing authoritative `QuotaController.admitRelay(...)`
    transaction with:
    - `reservedTokens = 0`;
    - `upperBoundTokens = 0`;
    - `maxOutputTokens = 0`;
    - `cacheEnabled = false`;
    - no raw Idempotency-Key;
11. performs no direct Durable Object storage mutation and no D1 quota mutation;
12. if admission is denied, returns a definite pre-admission setup rejection;
13. if admission succeeds, builds normal `RelayGrantCredentialV1` claims from
    the returned authoritative grant and signs them with
    `OCTG_RELAY_CONTEXT_HMAC_KEY` inside Cloudflare.

The QuotaController transaction remains the final collision authority. If a
normal Production request with the same ID appears between preflight and
admission, existing canonical state causes admission to fail closed rather than
mutating that normal request.

The successful response is exactly:

```ts
interface RelayCpuGateSetupResponseV1 {
  readonly version: 1;
  readonly requestId: string;
  readonly grantToken: string;
  readonly grantId: string;
  readonly leaseGeneration: string;
  readonly pool: "STANDARD" | "MINI";
  readonly admissionUtcDay: string;
}
```

The returned `requestId` must equal the runner-supplied request ID.

#### Setup fence

After any ambiguous setup response the runner MUST write a durable fence before
retrying the same request ID or concluding the operation. The fence is a new
Worker route:

```text
POST /internal/relay/v1/cpu-gate/setup-fence
Content-Type: application/json
Authorization: Bearer <OCTG_RELAY_CPU_GATE_AUTH_TOKEN>
```

Body: same `RelayCpuGateOperationRequestV1` shape as operation inspection.

The Worker:

1. requires the CPU-gate control surface to be enabled;
2. authenticates the CPU-gate bearer;
3. validates `requestId` and derives the operation UTC day from its ULID timestamp;
4. resolves the owning QuotaController by that embedded day (recovery is valid even
   after a calendar-day rollover);
5. calls `fenceRelayCpuGateSetup(requestId)`;
6. returns the authoritative result.

The QuotaController RPC `fenceRelayCpuGateSetup(requestId)` runs inside the
existing QuotaController transaction and atomically:

- checks whether a canonical fixture already exists for the request ID;
- if a fixture exists, returns `kind="fixture"` with the approved inspection
  fields so the runner can recover the existing fixture;
- if a non-fixture grant/request exists, returns `kind="non_fixture"` so the
  runner treats the operation as `BLOCKED / INCOMPLETE`;
- otherwise records a durable CPU-gate setup fence for the request ID and returns
  `kind="fenced"`;
- if a durable fence already exists for the request ID, returns `kind="fenced"`
  (idempotent).

Once the fence is durable:

- the same QuotaController transaction that executes any later `admitRelay(requestId)`
  MUST fail closed if a fence exists for that request ID, regardless of whether
  the original setup HTTP request had not yet reached `admitRelay`;
- `getRelayCpuGateGrantInspection(requestId)` returns `fenced absent` only when
  the fence is present and no grant/request entry exists;
- an existing fixture is detected before the fence is written and the runner is
  directed to the live-fixture recovery path instead of starting a new operation.

No direct Durable Object storage mutation occurs outside the QuotaController
transaction. The fence record may share the existing `req:<requestId>` key or a
dedicated `cpu-gate-fence:<requestId>` key, but it must be authoritative and
must not be writable by the Worker directly.

The response body is exactly:

```ts
interface RelayCpuGateSetupFenceResponseV1 {
  readonly version: 1;
  readonly requestId: string;
  readonly kind: "fenced" | "fixture" | "non_fixture";
  readonly inspection?: Extract<
    RelayCpuGateGrantInspection,
    { readonly kind: "fixture" | "non_fixture" }
  >;
}
```

Setup, setup-fence, decision-context, and recovery checks occur outside every
CPU acceptance measurement window. They are classified as `cpu-gate-control`
invocations and are excluded from lifecycle series counts and 5/7/0 evaluation.

#### Decision context

Decision callbacks require a Cloudflare-signed `RelayContextV1` in the
`X-OCTG-Relay-Context` header. The external runner MUST NOT receive
`OCTG_RELAY_CONTEXT_HMAC_KEY` and MUST NOT construct or sign a RelayContext.

For each decision sample the runner:

1. generates a fresh runner-owned `req_<ULID>` decision request ID;
2. calls the CPU-gate `decision-context` route for that request ID to obtain a
   Cloudflare-signed `contextToken`;
3. issues `concurrency` simultaneous `/internal/relay/v1/decision` callbacks
   using the same `contextToken` and the stage-appropriate model;
4. captures any `X-OCTG-Relay-Grant` headers returned by allowed callbacks;
5. terminalizes the resulting grants via the normal `/internal/relay/v1/terminal`
   callback using those grant credentials, then proves the fixture is terminal
   before starting the next sample.

Stage 2 uses the reject model, so callbacks return reject before creating a
grant and no terminal cleanup is required.

The route is:

```text
POST /internal/relay/v1/cpu-gate/decision-context
Content-Type: application/json
Authorization: Bearer <OCTG_RELAY_CPU_GATE_AUTH_TOKEN>
```

Body: same `RelayCpuGateOperationRequestV1` shape as operation inspection
(`pool` + `requestId`).

The Worker:

1. requires the CPU-gate control surface to be enabled;
2. authenticates the CPU-gate bearer;
3. validates `pool` and `requestId`;
4. requires the request ID's ULID UTC day to equal the current Worker UTC day;
5. derives the operation UTC day from the requestId's ULID timestamp;
6. resolves the owning QuotaController by that embedded day;
7. calls `getRelayCpuGateGrantInspection(requestId)` as collision preflight and
   requires the result to be `absent`;
8. builds a valid Production `RelayContextV1` using exactly the runner-owned
   request ID, the dedicated fixture client, the fixture model, no idempotency
   key, runtime environment, normal context timestamps, and a fresh
   Worker-generated nonce;
9. signs the context with `OCTG_RELAY_CONTEXT_HMAC_KEY` inside Cloudflare;
10. returns:

```ts
interface RelayCpuGateDecisionContextV1 {
  readonly version: 1;
  readonly requestId: string;
  readonly contextToken: string;
}
```

If the preflight is not `absent`, the route returns a definite error and does
not sign a context.

`decision-context` is a `cpu-gate-control` invocation and is excluded from the
decision measurement window. It performs **no admission**; the decision callback
itself exercises the normal admission path.

### Setup signing-failure compensation

A successful admission followed by grant signing failure is a post-mutation
failure and must not leave a live fixture.

Because no grant credential has been returned and this measurement architecture
does not perform any upstream model request, the Worker performs this exact
compensation before returning a definite setup failure:

1. call
   `QuotaController.reconcileRequest(requestId, "unused")`;
2. call `getRelayCpuGateGrantInspection(requestId)`;
3. require:

```text
kind = fixture
cpuGateFixture = true
state = reconciled_unused
requestState = released
activeLease = false
```

4. only after that proof, return an authenticated setup error:

```ts
{
  version: 1,
  kind: "setup_failed_compensated"
}
```

If compensation or its verification is ambiguous, return
`setup_state_ambiguous`; the runner MUST keep the same request ID active and
enter the recovery algorithm below. It must not start another setup operation.

No direct storage mutation is permitted.

### Setup acknowledgement classification

The runner classifies setup outcomes as follows.

#### Definite success

HTTP 200 with a valid `RelayCpuGateSetupResponseV1` whose request ID equals the
runner-owned request ID.

Then:

1. call `operation-inspection` for the same pool/request ID;
2. require:

```text
kind = fixture
cpuGateFixture = true
state = authorized
requestState = reserved
reservedTokens = 0
upperBoundTokens = 0
maxOutputTokens = 0
actualTokens = null
activeLease = true
```

3. only then enter lifecycle CPU measurement.

#### Definite no-live-fixture result

A syntactically valid authenticated response that explicitly represents either:

- rejection before `admitRelay`;
- `admitRelay` returning `kind="denied"`; or
- `setup_failed_compensated`.

These outcomes prove that setup did not leave a live CPU-gate fixture. The
runner MUST call `setup-fence(A)` and accept either:

- `fenced` -> operation A is `fenced absent`; runner may close A and start a new
  operation B; or
- `fixture` with `state=reconciled_unused`, `requestState=released`,
  `activeLease=false` -> the fixture is terminal and operation A is closed;
  runner may start a new operation B.

In both cases operation A is permanently closed. The runner MUST NOT retry
`setup(A)`.

#### Ambiguous result

It enters recovery for request ID A by first writing a durable setup fence. The
fence is authoritative: once durable, no later `admitRelay(A)` can leave a live
fixture for that request ID. Only after the fence is durable may the runner
inspect A again.

The exact protocol is:

```text
runner generates requestId A
    ->
POST setup(A)
    |
    +-- definite success
    |      -> operation-inspect A
    |      -> prove authorized CPU-gate fixture
    |      -> run measurement
    |      -> terminalize fixture
    |      -> operation may close; runner may start operation B
    |
    +-- definite no-live-fixture result
    |      -> POST setup-fence(A)
    |      -> accept fenced OR terminal fixture from setup-fence
    |      -> operation may close; runner may start operation B
    +-- ambiguous result
    |           -> DO NOT create requestId B
    |           -> POST setup-fence(A)
    |           -> inspect setup-fence result
    |                |
    |                +-- fenced
    |                |      -> operation-inspect A returns fenced absent
    |                |      -> operation may close; runner may start operation B
    |                |
    |                +-- fixture
    |                |      -> original setup already left a live fixture
    |                |      -> operation-inspect A
    |                |      -> if terminal: operation may close; runner may start operation B
    |                |      -> if non-terminal: reconcile-unused(A), prove terminal,
    |                |           then runner may start operation B
    |                |
    |                +-- non_fixture
    |                       -> BLOCKED / INCOMPLETE
    |                       -> no new setup
    |                       -> runner must not start operation B
    |
    +-- non-fixture / unverifiable result
           -> external response is non_fixture or error
           -> BLOCKED / INCOMPLETE
           -> no new setup
           -> runner must not start operation B
```

The runner never retries `setup(A)`. The fence is a tombstone: once `fenced` is
durable for requestId A, operation A is permanently closed and the runner may
only start a new operation with a fresh request ID.
The ordinary `RelayDecisionController` budget resolver applies a minimum
safety margin of 256 tokens, or 512 tokens at low remaining ratio. Therefore
`estimatedInputTokens=0` and `maxOutputTokens=0` do not produce a zero
reservation through the normal decision budget path.

The CPU-gate setup route deliberately does not call that budget resolver. It
delegates the fixed zero-reservation mutation to the existing authoritative
`QuotaController.admitRelay` transaction.

This does not create a second quota authority:

- quota/grant/request/lease writes still occur only inside QuotaController's
  existing admission transaction;
- the Worker cannot mutate Durable Object storage directly;
- D1 remains non-authoritative;
- Production HMAC signing remains Cloudflare-side;
- public and Deno relay behavior is unchanged.

### Capacity and shared Production authority

The CPU-gate runner fetches `RelayCpuGateSnapshot` immediately before setup
and requires only:

```text
maxInFlight >= 3
```

It does not require `activeLeaseCount=0` and does not use global counter
equality as Stage 2 PASS evidence.

Normal Production traffic remains active on the Stage 2 compatibility bridge and may
legitimately change:

- `confirmedTokens`;
- `reservedTokens`;
- `uncertainTokens`;
- unresolved counts;
- `activeLeaseCount`;
- `requestCount`.

Those changes do not fail the candidate.

The authoritative admission transaction remains responsible for the atomic
`maxInFlight` check. If normal traffic has consumed capacity before setup,
`admitRelay` may return `worker_concurrency_exceeded`; the series does not
start and the attempt is `BLOCKED / INCOMPLETE`, not candidate FAIL.

The CPU-gate runner owns at most one non-terminal CPU-gate operation at a time.
Therefore its bounded Production capacity impact is at most one in-flight slot.
The design does not claim that two normal slots remain continuously during
measurement.

### Lifecycle CPU sampling design

The CPU-gate runner owns at most one non-terminal CPU-gate operation at a time.
Therefore the bounded Production capacity impact is at most one in-flight slot.
This constraint also shapes how the runner collects enough samples for each
lifecycle transition class.

For every lifecycle series the Stage 2 runner calls the existing callback routes
with:

```text
Authorization: Bearer <OCTG_RELAY_SERVICE_AUTH_TOKEN>
X-OCTG-Relay-Grant: <grantToken>
Content-Type: application/json
```

This preserves the exact Production lifecycle callback authentication hot path.

The runner performs separate, non-overlapping series:

1. **activation_normal**
   - Each sample creates a fresh CPU-gate fixture through `setup`, then calls
     activation exactly once.
   - The fixture is terminalized before the next sample begins, so every
     activation is a real `authorized -> attempted` transition.
   - Because only one non-terminal operation may exist at a time, samples run
     serially within the series and the series is measured only at
     `concurrency=1`.
   - Setup, terminalization, and any recovery calls are `cpu-gate-control`
     invocations placed outside the series windows; the measured window for each
     sample contains exactly one activation callback.
   - Requires at least 500 successful first-time activations.
2. **activation_replay**
   - One fixture is created and activated once.
   - Subsequent activation calls exercise the existing replay-denial path.
   - Measures replay cost separately from normal transition cost.
   - Requires at least 500 successful invocations.

3. **renewal_normal**
   - One fixture is created, activated, and then renewed repeatedly while the lease
     remains active.
   - Every renewal is a normal attempted-state transition.
   - Concurrency is the number of simultaneous renewal callbacks against the same
     fixture; measured at `concurrency=1,2,3`.
   4. **terminal_normal**
   - Each sample creates a fresh CPU-gate fixture, activates it in a
     `cpu-gate-control` window, and calls terminal exactly once in the measured
     window.
   - The first terminal report is the real `settle(totalTokens=0)` transition.
   - Samples run serially because the fixture must be closed before the next one.
   - The series is measured only at `concurrency=1`.
   - Requires at least 500 successful first-time terminals.

5. **terminal_replay**
   - One fixture is created, activated, and terminalized once.
   - Subsequent terminal calls exercise existing idempotent terminal handling.
   - Measures replay cost separately from normal transition cost.
   - Concurrency is the number of simultaneous terminal callbacks against the same
     fixture; measured at `concurrency=1,2,3`.
   - Requires at least 500 successful invocations.
   - Requires at least 500 successful invocations.

The runner holds the returned grant credential, CPU-gate bearer, and service
bearer only for the active measurement run. It never receives a signing key.

For Phase 2-offloaded candidates, these requests measure the thin stateless
Worker path while the lifecycle DO performs trust/semantic work. DO CPU is
recorded separately and does not substitute for the stateless 5/7/0 gate.

### Upstream behavior
Activation means only that the authoritative grant reaches `attempted`; the
gate runner never performs Gateway B/OpenAI traffic.

The terminal outcome is therefore deterministically
`settle(totalTokens=0)`. `release` is never used after activation during the
normal successful measurement flow.

Any later ordinary end-to-end Production smoke is a separate rollout
correctness check, bounded in count and accounted as real quota usage. It is
not part of the 500-sample CPU acceptance evidence.

### Canary-owned quota-safety PASS invariant

Global Production counters are not compared before and after Stage 2.

For every canary operation, the authoritative
`getRelayCpuGateGrantInspection(requestId)` result is the quota-safety
evidence.
Immediately after setup, the setup inspection above must prove the exact
authorized zero-reservation fixture.

After normal terminal completion, `operation-inspection` must prove:

```text
kind = fixture
cpuGateFixture = true
state = settled
requestState = settled
reservedTokens = 0
upperBoundTokens = 0
maxOutputTokens = 0
actualTokens = 0
activeLease = false
```

These canary-owned facts prove that this CPU-gate request:

- was admitted with zero reservation;
- settled with zero actual tokens;
- released its own lease;
- did not leave unresolved canary quota state.

Normal Production counter changes caused by unrelated requests do not alter
this PASS decision.

For every lifecycle measurement group, one zero-reservation canary request and
grant may remain as terminal historical state until normal day-finalization
cleanup. No Idempotency-Key mapping is created.

Every CPU-gate request is individually accounted for by its runner-owned
request ID and canonical terminal inspection. Global `requestCount` delta is
not acceptance evidence.

### Exact recovery cleanup control

The protected cleanup route is:

```text
POST /internal/relay/v1/cpu-gate/reconcile-unused
Content-Type: application/json
Authorization: Bearer <OCTG_RELAY_CPU_GATE_AUTH_TOKEN>
```

Its body is exactly `RelayCpuGateOperationRequestV1`:

```ts
interface RelayCpuGateOperationRequestV1 {
  readonly version: 1;
  readonly pool: "STANDARD" | "MINI";
  readonly requestId: string;
}
```

A grant token is deliberately **not** required for recovery cleanup.

The Worker:

1. requires the CPU-gate control surface to be enabled;
2. authenticates the CPU-gate bearer;
3. validates the request ID and derives its operation UTC day from the ULID
   timestamp;
4. resolves the authoritative QuotaController;
5. calls `getRelayCpuGateGrantInspection(requestId)`;
6. requires `kind="fixture"` and `cpuGateFixture=true`;
7. permits cleanup only when state is one of:
   - `authorized`;
   - `attempted`;
   - `uncertain`;
8. if the target is absent, non-fixture, terminal, or unverifiable, performs no
   reconcile mutation;
9. otherwise calls only
   `QuotaController.reconcileRequest(requestId, "unused")`;
10. re-reads `getRelayCpuGateGrantInspection(requestId)`;
11. succeeds only when:

```text
kind = fixture
cpuGateFixture = true
state = reconciled_unused
requestState = released
activeLease = false
```

This cleanup is valid for all non-terminal CPU-gate states because the Stage 2
measurement architecture sends no upstream model request.

The route cannot reconcile a normal Production grant merely because the caller
knows a request ID. Canonical `cpuGateFixture=true` authorization is required
before mutation.

This same recovery seam handles:

- setup response loss;
- missing or expired grant credential;
- signing-failure compensation that could not be confirmed inline;
- activation/renewal measurement failure;
- uncertain CPU-gate state.

Normal lifecycle callbacks continue to require the existing grant credential
plus the existing service bearer.

No direct storage mutation is permitted.

## Evidence continuity

The Stage 2 compatibility bridge, CPU-tested candidate, and post-gate
hardening version are three distinct Worker version identities.

### Bridge identity

The compatibility bridge is a stable-compatible Production version deployed
at 100% before Stage 2.

It is not CPU acceptance evidence and its Worker routing behavior remains
stable-compatible, but its Durable Object RPC/code surface is mechanically
candidate-compatible according to the exact
`do-compatibility-manifest` invariant.

When Phase 2 is active it additionally applies migration `v4` and becomes the
earliest valid rollback baseline after that migration.

### CPU-tested candidate identity

The **CPU-tested candidate version** is the exact Worker ScriptVersion used for
Stage 2 and then rolled out through Production acceptance.

It contains a valid `OCTG_RELAY_CPU_GATE_AUTH_TOKEN` binding.

The following remain identical across accepted Stage 1 and Stage 2 evidence:

- source revision;
- lifecycle DO implementation;
- Worker/lifecycle RPC contract;
- callback routing behavior;
- binding names and class names;
- CPU gate implementation;
- measurement harness version/fingerprint;
- workload definitions.

If source, lifecycle implementation, RPC contract, CPU gate logic, workload
series definitions, or gate tooling change after a candidate is CPU-tested, the
candidate is invalidated and Stage 2 must restart from Task 6 using the new
locked source revision.
environment label.

Stage 2 records the exact Production ScriptVersion of this CPU-tested
candidate and the source-revision lock so that the promotion/hardening boundary
can prove identity.

### Post-gate hardening criteria

Hardening is allowed only when:

1. the exact CPU-tested candidate has reached 100%;
2. rollout acceptance for that exact candidate is complete;
3. every runner-owned CPU-gate operation is proven `fenced absent` or terminal.

**Rollout acceptance** means ordinary Production traffic served by the candidate ScriptVersion at non-zero traffic percentage passes an end-to-end Responses smoke for a bounded observation window. The acceptance window must be at least one complete minute and must include at least ten successful `/v1/responses` requests with normal tokenization, admission, and upstream settlement. Acceptance fails if error rate exceeds baseline, any 5/7/0 CPU violation is observed, or the candidate ScriptVersion is not the observed Worker version. Acceptance evidence is required before hardening creation; `hardening-create` must reject if it is missing.


**Rollout acceptance** means ordinary Production traffic served by the candidate ScriptVersion at non-zero traffic percentage passes an end-to-end Responses smoke for a bounded observation window. The acceptance window must be at least one complete minute and must include at least ten successful `/v1/responses` requests with normal tokenization, admission, and upstream settlement. Acceptance fails if error rate exceeds baseline, any 5/7/0 CPU violation is observed, or the candidate ScriptVersion is not the observed Worker version. Acceptance evidence is required before hardening creation; `hardening-create` must reject if it is missing.

### Post-gate hardening version identity

Deleting `OCTG_RELAY_CPU_GATE_AUTH_TOKEN` creates a new Worker version.
Therefore the secret-less version is explicitly **not** the CPU-tested
candidate.

The post-gate hardening version is created only after:

1. the exact CPU-tested candidate has reached 100%;
2. rollout acceptance for that exact candidate is complete;
3. every runner-owned CPU-gate operation is proven absent or terminal.

Create it with:

```text
wrangler versions secret delete OCTG_RELAY_CPU_GATE_AUTH_TOKEN
```

The hardening version must be mechanically equivalent to the CPU-tested
candidate except for the removed CPU-gate secret binding.

Required equality:

```text
source revision             identical
code bundle/artifact digest identical
compatibility settings      identical
DO bindings                 identical
quota bindings              identical
relay bindings              identical
all non-CPU-gate secrets    identical by binding name/presence
CPU-gate fixture variables  identical
OCTG_RELAY_CPU_GATE_AUTH_TOKEN
                            absent only in hardening version
```

No source rebuild, source edit, configuration cleanup, dependency update, or
unrelated binding change may be folded into this hardening version.

The hardening version uses the exact same code artifact and therefore the exact
same Durable Object implementations/RPC contracts as the CPU-tested candidate.
Its `do-compatibility-manifest` MUST be identical to the candidate manifest.

### Post-gate hardening deployment and verification

After creating the hardening version:

1. create a deployment containing:

```text
CPU-tested candidate: 100%
post-gate hardening:     0%
```

2. target the hardening ScriptVersion with the exact Cloudflare version
   override;
3. run the bounded post-gate verification below;
4. if it passes, promote the hardening version to 100%;
5. if it fails, keep or restore the CPU-tested candidate at 100% and do not
   close Issue #121.

The bounded verification is exactly:

```text
hardening ScriptVersion is proven by platform/version metadata
all /internal/relay/v1/cpu-gate/* routes return 404
normal relay configuration remains enabled
existing lifecycle callback service authentication remains valid
one bounded ordinary Production Responses relay smoke completes successfully
```

The ordinary smoke is real Production traffic, is bounded in count, and is
accounted as ordinary quota usage.

The post-gate hardening version does **not** rerun the full 500-sample CPU gate.
That decision is normative: the only permitted version delta is removal of a
CPU-gate-only secret binding whose routes are not protocol inputs to normal
ingress, decision, activation, renewal, or terminal processing.

Issue #121 is not close-eligible until the hardening version has passed this
bounded verification and reached 100%.

## Production / Preview isolation

The exact Phase 2 binding is:

```text
RELAY_GRANT_LIFECYCLE_CONTROLLER
```

Requirements:

- Preview and Production lifecycle DO namespaces are distinct.
- Preview and Production QuotaController namespaces remain distinct.
- Production routing is never selected from an unsigned environment hint.
- The verified signed environment must match the runtime environment.
- A verified request ID must map to the lifecycle DO's own exact shard
  identity.
- An applied migration tag is append-only and must not be deleted or rewritten
  for rollback.
- Stage 2's protected measurement credentials are never exposed to clients or written to logs/artifacts.
- `OCTG_RELAY_CONTEXT_HMAC_KEY` remains Cloudflare-side only.
- `OCTG_RELAY_SERVICE_AUTH_TOKEN` may be used by the protected Stage 2 runner only for the existing lifecycle callback routes (decision, activation, renewal, terminal).
- `OCTG_RELAY_CPU_GATE_AUTH_TOKEN` enables only the CPU-gate control plane on the CPU-tested candidate and remains present through exact-candidate rollout acceptance; it is removed only in the separately verified post-gate hardening version.

## Rollback compatibility

While unresolved relay grants exist:

- retain the internal relay callback routes;
- retain `RELAY_GRANT_LIFECYCLE_CONTROLLER` once migration `v4` has been
  applied;
- retain the relevant relay HMAC secret;
- retain `QuotaController`;
- retain migration `v4`.

Phase 2 rollback always means returning to the Stage 2 compatibility bridge-compatible
version, not a pre-migration version.

Resolve or reconcile outstanding grants before removing any later lifecycle
processing compatibility.

Rollback never changes the rule that quota decisions come from
`QuotaController`, not D1.

## Testing strategy

Correctness tests and CPU acceptance evidence are separate.

### Unit tests

HMAC cache tests cover:

- same key -> one import;
- concurrent first access -> one shared import promise;
- different key -> new import;
- key rotation;
- import rejection clears only the current cache entry;
- retry after import rejection;
- signing and verification behavior remains unchanged.

### Lifecycle RPC contract tests

When Phase 2 is active, test:

- exact binding/class names;
- one `dispatch` RPC only;
- structured-clone-safe result union;
- Worker owns HTTP response encoding;
- DO never returns `Response`;
- activation/renewal/terminal result mapping preserves existing wire behavior;
- invalid HMAC/wrong environment/expired token -> `invalid_context`;
- invalid JSON/binding mismatch -> `invalid_request`;
- QuotaController RPC failure -> `internal_error`.

### Routing tests

Test exact name grammar:

```text
relay-grant-lifecycle:v1:<environment>:<00..63>
```

and prove:

- lifecycle and decision use the same FNV shard-index algorithm;
- different namespace prefixes cannot alias;
- tampered unsigned routing hint cannot bypass verified shard identity;
- environment mismatch fails closed;
- invalid own name is internal error.

### Worker / DO integration tests

Verify:

- Worker performs transport/service-auth work only for offloaded lifecycle
  callbacks;
- Worker does not verify grant HMAC after offload;
- Worker does not parse lifecycle semantics after offload;
- lifecycle DO receives raw bounded input;
- lifecycle DO verifies grant before semantic use;
- lifecycle DO selects QuotaController only after verification;
- duplicate/conflicting callbacks preserve QuotaController semantics.

### Migration/rollout tests

Verify the normative order for **both** Phase-2-inactive and Phase-2-active
flows:

```text
Stage 1 CPU-tested candidate source PASS
    ->
build Stage 2 compatibility bridge
    ->
verify bridge/candidate DO compatibility manifest equality
    ->
deploy compatibility bridge to 100%
    ->
if Phase 2 active: bridge applies append-only v4
    ->
bounded bridge normal-traffic verification
    ->
upload CPU-tested candidate
    ->
deployment bridge=100%, CPU-tested candidate=0%
    ->
exact candidate Worker version override confirmed
    ->
Durable Object compatibility preflight/control smoke
    ->
Stage 2
    ->
roll out exact CPU-tested candidate
    ->
CPU-tested candidate reaches 100%
    ->
Production rollout acceptance completes
    ->
all CPU-gate operations absent or terminal
    ->
wrangler versions secret delete OCTG_RELAY_CPU_GATE_AUTH_TOKEN
    ->
post-gate hardening version created
    ->
deployment CPU-tested candidate=100%, hardening=0%
    ->
bounded hardening verification via exact version override
    ->
hardening version reaches 100%
```

Tests MUST reject:

- Stage 2 without a 100% compatibility bridge;
- Phase-2-inactive bridge without both CPU-gate QuotaController RPCs;
- Phase-2-active bridge that uses a placeholder lifecycle DO;
- bridge/candidate DO compatibility manifest mismatch;
- removal/rename/incompatible change of an existing QuotaController RPC;
- candidate upload before bridge compatibility verification;
- `versions upload` as the operation that first introduces `v4`;
- candidate deployment without bridge migration when Phase 2 is active;
- pre-`v4` rollback after migration;
- Stage 2 request whose override did not resolve to the CPU-tested candidate;
- treating the version override as proof of Durable Object code version;
- CPU-gate secret deletion before exact-candidate rollout acceptance;
- use of non-versioned `wrangler secret delete` in this rollout;
- a hardening version whose diff contains anything except removal of
  `OCTG_RELAY_CPU_GATE_AUTH_TOKEN`;
- hardening DO compatibility manifest differing from the CPU-tested candidate;
- hardening promotion without bounded verification;
- treating hardening and CPU-tested ScriptVersions as identical.

### Durable Object gradual-deployment compatibility tests

The bridge/candidate pair MUST be tested as a forward/backward-compatible
Worker/DO contract.

Phase 2 inactive:

```text
bridge QuotaController exposes getRelayCpuGateSnapshot()
bridge QuotaController exposes getRelayCpuGateGrantInspection(requestId)
candidate Worker -> bridge-version QuotaController succeeds
bridge Worker existing behavior -> candidate-version QuotaController remains valid
all existing QuotaController RPC semantics remain compatible
cpuGateFixture predicate is identical bridge vs candidate
```

Phase 2 active adds:

```text
bridge RelayGrantLifecycleController.dispatch contract == candidate contract
bridge lifecycle DO implementation manifest == candidate manifest
candidate Worker -> bridge-version lifecycle DO succeeds
candidate Worker -> bridge-version QuotaController succeeds
candidate lifecycle DO -> bridge/candidate QuotaController succeeds
grant verification / shard recheck / callback parsing / error mapping are identical
bridge normal Production lifecycle callbacks remain Worker-side
```

Live Production preflight, outside measurement windows, MUST confirm:

```text
bridge 100%
candidate 0%
exact candidate Worker override
candidate ScriptVersion observed
candidate Worker -> bridge-compatible CPU-gate inspection/setup succeeds
```
### Stage 2 quota-safety tests

Test the exact Production canary protocol:

- ingress/decision fixtures stop before `admitRelay`;
- CPU-gate control uses a dedicated bearer unavailable to Deno;
- CPU-gate secret absent, invalid shape, or equal to the service bearer disables
  every control route with 404 and no DO call;
- external runner never receives the Production relay HMAC key;
- Stage 2 runner receives the existing service bearer only for
  decision/activation/renewal/terminal callback Authorization;
- runner generates the setup request ID before the mutation;
- setup uses exactly the runner-supplied request ID;
- setup rejects a request ID whose ULID UTC day is not the current Worker day;
- setup collision with normal Production state fails closed and mutates
  nothing;
- setup grant is created through existing `QuotaController.admitRelay` with
  zero reservation and no idempotency key;
- setup cannot select arbitrary client/model/reservation/signing claims;
- signing failure after successful admission performs
  `reconcileRequest(requestId, "unused")` and proves no live fixture remains;
- ambiguous signing-failure compensation blocks creation of a new operation;
- HTTP response loss after successful admission is recovered by the pre-known
  request ID;
- an ambiguous setup result never causes a fresh request ID to be issued;
- the runner never retries `setup(A)`; `fenced absent` means operation A is
  permanently closed and the runner may start a new operation B;
- operation inspection maps `fenced absent` to HTTP 404 (operation A closed) and
  `non_fixture` to HTTP 409 (operation A blocked); both responses disclose no
  normal Production request details;
- a durable setup fence prevents a delayed `admitRelay` for the same request ID
  from leaving a live fixture;
- setup-fence resolves the owning QuotaController from the requestId's ULID day and
  works across a calendar-day rollover.
- setup-fence resolves the owning QuotaController from the requestId's ULID day and

Compatibility-preflight terminalization MUST also be tested:

```text
Phase 2 inactive:
setup/inspection smoke
  -> reconcile-unused(preflight requestId)
  -> reconciled_unused / released / activeLease=false

Phase 2 active:
lifecycle control smoke
  -> normal terminal settled state
  OR recovery reconcile-unused
  -> terminal canonical state / activeLease=false

all modes:
compatibility preflight leaves no non-terminal CPU-gate fixture
Stage 2 measurement cannot begin while preflight operation is non-terminal
```

```text
candidate ScriptVersion
candidate ScriptVersion
route / invocation class
non-overlapping windowStart/windowEnd
```

Missing app markers must not hide `exceededCpu`.

Test all `BLOCKED / INCOMPLETE` conditions, including count mismatch and
unassignable platform records.

### Stage 2 quota-safety tests

Test the exact Production canary protocol:

- ingress/decision fixtures stop before `admitRelay`;
- CPU-gate control uses a dedicated bearer unavailable to Deno;
- CPU-gate secret absent or invalid disables every control route with 404 and
  no DO call;
- external runner never receives the Production relay HMAC key;
- Stage 2 runner receives the existing service bearer only for
  activation/renewal/terminal callback Authorization;
- runner generates the setup request ID before the mutation;
- setup uses exactly the runner-supplied request ID;
- setup rejects a request ID whose ULID UTC day is not the current Worker day;
- setup collision with normal Production state fails closed and mutates
  nothing;
- setup grant is created through existing `QuotaController.admitRelay` with
  zero reservation and no idempotency key;
- setup cannot select arbitrary client/model/reservation/signing claims;
- signing failure after successful admission performs
  `reconcileRequest(requestId, "unused")` and proves no live fixture remains;
- ambiguous signing-failure compensation blocks creation of a new operation;
- HTTP response loss after successful admission is recovered by the pre-known
  request ID;
- an ambiguous setup result never causes a fresh request ID to be issued;
  permanently closed and the runner may start a new operation B;
- operation inspection maps `fenced absent` to HTTP 404 (operation A closed) and
  `non_fixture` to HTTP 409 (operation A blocked); both responses disclose no
  normal Production request details;
- a durable setup fence prevents a delayed `admitRelay` for the same request ID
  from leaving a live fixture;
- setup-fence resolves the owning QuotaController from the requestId's ULID day and
  works across a calendar-day rollover.
  facts and QuotaController-owned pool configuration;
- setup inspection requires `cpuGateFixture=true`, authorized/reserved states,
  zero admission values, and `activeLease=true`;
- concurrency 1/2/3 does not create additional grants;
- activation then renewal then `settle(0)` is used;
- normal successful measurement never uses `activate -> release`;
- repeated terminal report is idempotent;
- no upstream request is made by the 500-sample CPU matrix;
- completion inspection requires `cpuGateFixture=true`, settled/settled
  states, `actualTokens=0`, and `activeLease=false`;
- lost or expired grant token does not prevent recovery by request ID;
- recovery `reconcile-unused` accepts only canonical
  `cpuGateFixture=true`;
- recovery cleanup can terminalize authorized, attempted, or uncertain
  CPU-gate fixtures because the measurement architecture sends no upstream
  request;
- normal Production request IDs cannot be inspected in detail or reconciled by
  the CPU-gate control plane;
- recovery cleanup delegates only to existing
  `QuotaController.reconcileRequest(requestId, "unused")`;
- cleanup never writes Durable Object storage directly;
- no new setup operation begins until the previous request ID is authoritative
  `fenced absent` or terminal; a durable setup fence makes absent authoritative
  and permanently closes the operation;
- compatibility-preflight setup/inspection/callback/cleanup operations are excluded from all Stage 2 CPU sample windows;
- compatibility-preflight fixture is canonical terminal with no active lease before Stage 2 measurement starts;
- the first Stage 2 measurement setup uses a fresh runner-owned request ID rather than reusing the preflight fixture;
- every CPU-gate request is accounted by runner-owned request ID plus canonical
  terminal inspection, not by global `requestCount` delta.

### Post-gate hardening tests

Test:

- CPU-tested candidate reaches 100% before secret deletion;
- all runner-owned CPU-gate operations are absent or terminal before deletion;
- `wrangler versions secret delete` creates a distinct hardening
  ScriptVersion;
- code artifact/source revision and every non-CPU-gate configuration item are
  equivalent;
- only `OCTG_RELAY_CPU_GATE_AUTH_TOKEN` is absent;
- hardening CPU-gate routes return 404;
- normal relay remains enabled;
- lifecycle callback service auth remains valid;
- a bounded ordinary Production Responses relay smoke succeeds;
- full 500-sample CPU evidence is not rerun for the hardening-only secret
  removal;
- failure leaves/restores the CPU-tested candidate at 100%.

### Runtime CPU gate

Local timers and microbenchmarks are not Issue #121 acceptance evidence.

Cloudflare platform CPU telemetry is authoritative. Produce a sanitized report
for each required series containing:

```text
candidate source revision
candidate ScriptVersion
measurement stage
invocation class
workload class
concurrency
windowStart
windowEnd
successful count
platform invocation count
CPU telemetry count
p50
p90
p95
p99
max
exceededCpu
PASS / FAIL / BLOCKED
```

## Completion criteria

Issue #121 becomes eligible to close only after all of the following are true:

- Production CPU recurrence is attributed to an invocation class.
- Repeated relay HMAC key import is removed.
- Key rotation and import-failure behavior are correct.
- All required invocation/workload/concurrency series are independently
  measurable.
- Required series run in non-overlapping windows.
- Every required series has at least 500 successful invocations.
- Platform telemetry can assign every failed/exceeded candidate invocation
  without relying on application markers.
- Telemetry deficiency is never treated as PASS.
- All required stateless Worker series satisfy `p99 <= 5 ms`,
  `max <= 7 ms`, and `exceededCpu = 0`.
- Stage 1 passes.
- A Stage 2 Durable Object compatibility bridge is deployed to 100% before the CPU-tested candidate is exposed, regardless of whether Phase 2 is active.
- Phase-2-inactive bridge provides candidate-compatible QuotaController CPU-gate inspection RPCs without changing normal Production request behavior.
- If Phase 2 is active, the compatibility bridge applies append-only migration `v4` with `wrangler deploy` and includes a full candidate-compatible RelayGrantLifecycleController implementation.
- After `v4`, the compatibility bridge is the earliest valid rollback baseline.
- Bridge and candidate DO compatibility manifests match for QuotaController, CPU-gate inspection/predicate/contracts, and all behavior-affecting transitive dependencies.
- When Phase 2 is active, the lifecycle DO implementation/contract/shard/verification dependencies also match exactly.
- Stage 2 CPU-tested candidate is present at 0% beside the 100% compatibility bridge and is targeted by exact Worker version override.
- Platform metadata proves every Stage 2 sample ran the exact candidate.
- The version override is treated only as stateless incoming Worker identity and never as proof of Durable Object code version.
- Stage 2 preflight proves candidate Worker -> bridge-compatible QuotaController control RPCs before any CPU measurement window.
- When Phase 2 is active, Stage 2 preflight also proves candidate Worker -> lifecycle DO -> QuotaController control flow before measurement.
- The compatibility-preflight CPU-gate operation is terminalized and canonically inspected before any Stage 2 CPU measurement window begins.
- Phase-2-inactive preflight ends as `reconciled_unused / released / activeLease=false`.
- Phase-2-active preflight ends either as normal `settled / settled / actualTokens=0 / activeLease=false` or, when recovery is required, `reconciled_unused / released / activeLease=false`.
- No compatibility-preflight invocation is counted as Stage 2 CPU evidence, and the first measurement fixture uses a fresh runner-owned request ID.
- Gradual rollout explicitly permits bridge/candidate Worker and DO version skew while requiring forward/backward-compatible RPC semantics.
- Stage 2 quota/capacity inspection is defined by exact read-only QuotaController RPCs and protected Worker routes.
- Stage 2 PASS does not depend on equality of global Production quota counters that normal traffic may legitimately change.
- Quota safety is proven from canary-owned canonical grant/request/lease inspection.
- Canary setup inspection proves cpuGateFixture=true, authorized/reserved state, zero reservation/upper-bound/max-output values, and an active matching lease.
- Canary completion inspection proves cpuGateFixture=true, settled grant/request state, actualTokens=0, and no active matching lease.
- Stage 2 has at most one CPU-gate canary grant/lease at any time; its capacity impact is bounded to at most one slot.
- maxInFlight >= 3 remains preflight evidence, but the design makes no continuous free-slot guarantee.
- Production relay HMAC signing remains Cloudflare-side; neither the external harness nor Deno receives OCTG_RELAY_CONTEXT_HMAC_KEY.
- The protected Stage 2 runner may use OCTG_RELAY_SERVICE_AUTH_TOKEN only on the existing decision/activation/renewal/terminal callback routes.
- CPU-gate control uses the separate OCTG_RELAY_CPU_GATE_AUTH_TOKEN; absent or invalid secret disables all CPU-gate control routes fail-closed.
- The Production CPU-gate secret remains on the exact CPU-tested candidate through its 100% rollout acceptance, then is removed only to create the separate post-gate hardening version.
- Recovery inspection distinguishes `absent` (HTTP 404, retry allowed) from
  `non_fixture` (HTTP 409, retry forbidden) and exposes no normal Production
  request details.
- reconcile-unused requires canonical cpuGateFixture=true before mutation and then uses only existing reconcileRequest(..., "unused") semantics.
- No CPU-gate route performs direct Durable Object storage mutation.
- Setup mutation identity is known to the runner before mutation and uses exactly one runner-generated request ID.
- Ambiguous setup acknowledgement never causes a second operation to be created
  before the first is authoritative `fenced absent` or terminal; a durable
  setup fence makes absent authoritative and permanently closes the operation;
- Lost/expired grant credentials do not prevent recovery because operation inspection and cleanup can target the runner-owned request ID.
- Recovery inspection distinguishes `fenced absent` (HTTP 404, operation closed)
  from `non_fixture` (HTTP 409, operation blocked) and exposes no normal
  Production request details.
- Recovery cleanup mutates only canonical `cpuGateFixture=true` targets.
- The exact CPU-tested candidate ScriptVersion reaches 100% and completes rollout acceptance before CPU-gate secret deletion.
- Secret deletion uses `wrangler versions secret delete` and creates a distinct post-gate hardening ScriptVersion.
- The hardening version differs only by absence of `OCTG_RELAY_CPU_GATE_AUTH_TOKEN`, passes bounded post-gate verification, and reaches 100%.
- The hardening version's Durable Object compatibility manifest is identical to the CPU-tested candidate because the code artifact is unchanged.
- Stage 2 sends no upstream model request as part of the 500-sample CPU gate.
- Every CPU-gate request is individually accounted for by its runner-owned request ID and canonical terminal inspection; global `requestCount` delta is not acceptance evidence.
- The incident-derived synthetic regression workload is retained.
- If lifecycle escalation was triggered, activation/renewal/terminal are moved
  together behind `RelayGrantLifecycleController`.
- If remediation still fails the Worker gate, Issue #121 remains open and the
  architecture is revisited without relaxing the gate or moving to Workers
  Paid.
- `QuotaController` remains the only quota authority.
- D1 is not used for quota decisions.
- Fail-closed behavior is preserved.
- Production/Preview isolation is preserved.
- Chat Completions behavior is unchanged.
- No request/response payload, prompt, credential, or raw HMAC key is retained
  in logs, telemetry, or fixtures.

## Historical evidence interpretation

The accepted 2026-09-27 Task 0 result remains valuable historical evidence, but
it no longer demonstrates sufficient Production safety for Issue #121.

In particular, the prior activation maximum of 8 ms is outside the accepted
Worker gate. The new Stage 1 and Stage 2 measurements supersede the old PASS for
rollout decisions while preserving the old record for comparison and incident
analysis.