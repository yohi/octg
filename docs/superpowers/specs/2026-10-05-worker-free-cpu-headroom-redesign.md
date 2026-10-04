# Worker Free CPU Headroom Redesign

## Status and scope

- Issue: `yohi/octg#121` — Worker Free CPU制限の再発に伴うCPU headroom再設計.
- Design status: **APPROVED in Superpowers brainstorming (2026-10-05)**.
- This document is a follow-up to
  `docs/superpowers/specs/2026-09-23-free-worker-deno-relay-design.md`.
- This design does **not** authorize implementation. An implementation plan must
  be written and reviewed separately before source changes begin.
- Cloudflare Workers Paid is out of scope. The design must continue to operate
  under the Workers Free HTTP CPU limit of 10 ms.
- `QuotaController` remains the sole quota authority. D1 remains outside quota
  authority. Existing fail-closed semantics and Production/Preview isolation
  remain mandatory.
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
5. Escalate the grant lifecycle callbacks to a dedicated Durable Object trust
   boundary only when runtime evidence requires it.
6. Require both Preview and Production-like runtime gates before rollout.
7. Preserve a reusable synthetic regression workload derived from the
   Production incident's structural characteristics.
8. Preserve existing quota correctness, fail-closed behavior, security
   boundaries, and rollback safety.

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

## Design overview

The remediation is intentionally staged.

```text
Phase 1
Relay HMAC CryptoKey reuse
        |
        v
CPU measurement
        |
        v
CPU headroom gate
        |
        +-- PASS --> Stage 1 Preview gate
        |               |
        |               v
        |            Stage 2 Production-like gate
        |               |
        |               v
        |            rollout
        |
        +-- lifecycle FAIL
                |
                v
Phase 2
RelayGrantLifecycleController
                |
                v
Stage 1 evidence reset and full re-run
                |
                v
Stage 2
                |
                v
rollout
```

Phase 2 is conditional. The system does not add a new Durable Object simply
because Issue #121 exists. The new lifecycle boundary is introduced only when
activation, renewal, or terminal fails the approved Worker CPU gate in Stage 1
or Stage 2.

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

This is a rollout-safety gate, not a microbenchmark target.

## Phase 1: relay HMAC CryptoKey reuse

### Existing problem

`packages/shared/src/relay-credential.ts` currently imports the same raw relay
HMAC key for each MAC calculation before calling `crypto.subtle.sign()`.

The existing client-key HMAC implementation in
`apps/gateway-worker/src/crypto.ts` already uses an isolate-local
`Promise<CryptoKey>` cache with rejection cleanup. Relay HMAC handling should
follow the same pattern.

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

Cloudflare platform invocation records are the authoritative evidence for CPU
attribution and CPU gate evaluation.

Required platform evidence includes, where available:

- Worker revision;
- invocation/request route classification;
- CPU time;
- invocation outcome including `exceededCpu`;
- timestamp sufficient for correlation.

Application logs are supplementary evidence only. CPU exhaustion can terminate
execution before an application-level finish marker is emitted, so absence of a
finish event must never be interpreted as proof that no CPU failure occurred.

### Sanitized relay invocation markers

Add a safe structured marker for correlation, for example
`octg.relay_invocation`, carrying only non-sensitive fields such as:

```text
invocationClass
revisionId
requestId        # when available and safe
workloadClass    # controlled measurement only
concurrency      # controlled measurement only
phase
outcome
```

The marker must not contain:

- request body;
- response body;
- prompt;
- client API key;
- service bearer;
- relay secret;
- grant credential;
- raw HMAC key;
- upstream credential.

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

Concurrency is an execution condition, not part of the domain workload name,
but every concurrency value is measured as a separate CPU series.

Example:

```text
activation x incident-regression-stream x concurrency=1
activation x incident-regression-stream x concurrency=2
activation x incident-regression-stream x concurrency=3
```

The series must never be pooled for percentile or sample-count purposes.

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
CPU telemetry record count
Worker revision
workload class
concurrency
measurement stage
```

Each required series needs at least **500 successful invocations**.

Five hundred samples cannot be satisfied by combining concurrency conditions.

### PASS / FAIL / BLOCKED

Each series has exactly one state:

```text
PASS
FAIL
BLOCKED / INCOMPLETE
```

PASS requires all of:

```text
successfulInvocations >= 500
required CPU telemetry is complete
p99 <= 5 ms
max <= 7 ms
exceededCpu = 0
candidate revision matches
workload classification matches
execution condition matches
```

FAIL means sufficient evidence exists and the CPU gate itself is violated.

BLOCKED / INCOMPLETE includes, for example:

- insufficient successful samples;
- CPU telemetry undercount;
- query failure;
- revision mismatch;
- missing required series;
- ambiguous workload classification.

Telemetry deficiency must not be misclassified as architecture failure, but it
must also never be treated as PASS.

## Canonical workload design

The measurement matrix uses a small set of representative workload classes
instead of a combinatorial product of every feature.

### baseline-small

Ordinary valid Responses relay request:

- small body;
- shallow history;
- no tool/function history;
- representative callback lifecycle.

### baseline-large

Representative large valid Responses workload:

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
- full callback lifecycle.

### incident-regression-nonstream

Same incident-derived structural shape with `stream=false`.

The actual Production payload, prompts, responses, credentials, or customer
data must never become fixtures.

These incident-derived workloads are retained after Issue #121 closes and
become part of the future CPU regression gate.

## Conditional Phase 2: RelayGrantLifecycleController

### Activation condition

Introduce `RelayGrantLifecycleController` when any required activation,
renewal, or terminal Worker series fails the CPU gate in either Stage 1 or
Stage 2.

If Stage 2 triggers escalation, the new implementation invalidates the old
Stage 1 evidence and the complete Stage 1 matrix must be rerun.

Ingress or decision failures do not activate this design automatically; those
paths are remediated independently.

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
  |
  v
QuotaController
  - authoritative lifecycle state transition
  - idempotency
  - conflict handling
  - quota state
```

The Worker passes the lifecycle DO only:

```text
action: activation | renewal | terminal
grantToken: raw X-OCTG-Relay-Grant value
callbackBody: bounded raw bytes
```

The Worker must not parse lifecycle semantics, verify the grant HMAC, or rebuild
grant binding before dispatch.

### Routing

Use deterministic 64-way sharding by request ID, matching the existing
Decision DO trust pattern.

Worker behavior:

1. Decode only enough of the unverified grant payload to extract a syntactically
   valid `requestId` routing hint.
2. Compute the lifecycle shard from the hint.
3. Dispatch the raw grant/body/action to that shard.

Lifecycle DO behavior:

1. Verify the signed grant fully.
2. Recompute the expected shard from the **verified** `requestId`.
3. Compare the expected shard with the DO's own identity.
4. Reject any mismatch.
5. Only then perform callback semantic/binding validation and select the
   authoritative `QuotaController`.

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
service auth failure     -> reject
invalid method/path      -> reject
invalid content type     -> reject
oversized transport      -> reject
invalid routing hint     -> reject
DO dispatch failure      -> internal error / fail closed
```

A lifecycle-DO dispatch failure must not fall back to the old Worker-heavy
grant processing path.

### Lifecycle-DO failures

```text
invalid grant HMAC        -> reject
expired grant             -> reject
wrong environment         -> reject
shard identity mismatch   -> reject
invalid callback JSON     -> reject
semantic binding mismatch -> reject
QuotaController RPC error -> internal error / fail closed
```

Duplicate activation/renewal/terminal, stale lease generation, conflicting
terminal results, and grant expiry continue to use the existing authoritative
QuotaController semantics.

## Production / Preview isolation

If Phase 2 is activated, introduce a dedicated Durable Object binding such as:

```text
RELAY_GRANT_LIFECYCLE_CONTROLLER
```

and a new append-only Durable Object migration tag.

Requirements:

- Preview and Production use distinct Durable Object namespaces.
- Production routing is never selected from an unsigned environment hint.
- The verified signed environment must match the runtime environment.
- A verified request ID must map to the lifecycle DO's own shard identity.
- An applied migration tag must not be deleted or rewritten for rollback.

## Two-stage rollout gate

### Stage 1: Preview / temporary-resource gate

Run the complete canonical workload matrix against isolated Preview or
temporary resources.

Every required Worker series must:

- use the candidate implementation;
- use the approved measurement harness;
- use the approved workload definitions;
- reach at least 500 successful invocations;
- satisfy the 5/7/0 CPU gate.

Stage 1 PASS alone does not authorize rollout completion.

### Stage 2: Production-like controlled canary

Use Production runtime configuration, bindings, secrets, and Durable Object
namespaces, but keep normal user traffic on the current stable Worker version.

Only a dedicated canary client is routed to the candidate version.

Run the same canonical workload definitions and concurrency conditions as
Stage 1. Every required series must independently satisfy the same sample and
CPU gate.

Do not expose ordinary user traffic to the candidate merely to gather the
acceptance evidence.

## Evidence continuity

Stage 1 and Stage 2 must represent the same immutable candidate.

The following must remain unchanged between the accepted Stage 1 and Stage 2
evidence:

- Worker source revision;
- applicable Durable Object implementation;
- binding contract;
- measurement harness;
- workload definitions;
- CPU gate logic.

If any of these change, invalidate the old Stage 1 PASS and rerun Stage 1 from
the beginning.

Environment-specific endpoint values, secret values, and Durable Object
namespace IDs may differ as required by Preview/Production isolation.

## Rollback compatibility

If Phase 2 is deployed, rollback must preserve compatibility with unresolved
relay grants.

While unresolved grants exist:

- retain the internal relay callback routes;
- retain the lifecycle DO binding;
- retain the relevant relay HMAC secret;
- retain `QuotaController`;
- do not remove or rewrite the applied DO migration.

Resolve or reconcile outstanding grants before removing the lifecycle
processing path.

Rollback never changes the rule that quota decisions come from
`QuotaController`, not D1.

## Testing strategy

Correctness tests and CPU acceptance evidence are separate.

### Unit tests

HMAC cache tests must cover:

- same key -> one import;
- concurrent first access -> one shared import promise;
- different key -> new import;
- key rotation;
- import rejection clears the current cache entry;
- retry after import rejection;
- signing and verification behavior remains unchanged.

### Worker / DO integration tests

When Phase 2 is active, test:

- Worker performs transport/service-auth work only.
- Worker does not verify grant HMAC.
- Worker does not parse lifecycle callback semantics.
- Lifecycle DO receives raw bounded input.
- Lifecycle DO verifies the grant before semantic use.
- Tampered unsigned routing hint cannot bypass verified shard identity.
- Lifecycle DO selects the correct QuotaController only after verification.
- Duplicate and conflicting callbacks preserve existing authoritative
  QuotaController semantics.

### Fault injection

Cover at least:

- lifecycle DO unavailable;
- QuotaController RPC failure;
- invalid HMAC;
- wrong environment;
- expired grant;
- routing-hint tampering;
- verified shard mismatch;
- malformed callback JSON;
- grant ID mismatch;
- lease-generation mismatch.

Every ambiguous failure must remain fail-closed.

### Runtime CPU gate

Do not use local timers or microbenchmarks as Issue #121 acceptance evidence.

Cloudflare runtime CPU telemetry is authoritative. Produce a sanitized report
for each required series containing:

```text
candidate revision
Worker revision
measurement stage
invocation class
workload class
concurrency
successful count
telemetry count
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
- Every required series has at least 500 successful invocations.
- Telemetry deficiency is never treated as PASS.
- All required stateless Worker series satisfy `p99 <= 5 ms`,
  `max <= 7 ms`, and `exceededCpu = 0`.
- Stage 1 passes.
- Stage 2 passes for the same immutable candidate and workload definitions.
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

In particular, the prior activation maximum of 8 ms is now outside the accepted
Worker gate. The new Stage 1 and Stage 2 measurements supersede the old PASS for
rollout decisions while preserving the old record for comparison and incident
analysis.
