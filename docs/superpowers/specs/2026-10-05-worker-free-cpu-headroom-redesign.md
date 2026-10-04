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
Production migration bridge
                |
                v
Final candidate at 0% + version override
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

Concurrency is an execution condition, not part of the domain workload name,
but every concurrency value is measured as a separate CPU series.

Example:

```text
activation x incident-regression-stream x concurrency=1
activation x incident-regression-stream x concurrency=2
activation x incident-regression-stream x concurrency=3
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
windowStart
windowEnd
expected successful invocation count
```

Rules:

1. No two required series for one candidate may have overlapping
   `[windowStart, windowEnd]` intervals.
2. The next series starts only after all driver invocations in the prior series
   have completed.
3. Stage 2 normal traffic remains on the stable/bridge version, so filtering by
   candidate `ScriptVersion` removes unrelated normal Production traffic.
4. The candidate `ScriptVersion`, route, and exact measurement window must be
   sufficient to reconstruct the series from platform telemetry without an
   application marker.
5. If any platform invocation in the window cannot be uniquely assigned to the
   expected series, the series is `BLOCKED / INCOMPLETE`.
6. Gate-time Worker invocation telemetry sampling must be 100%. The existing
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
windowStart
windowEnd
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

## Phase 2 Durable Object migration bridge

Phase 2 introduces a new Durable Object class lifecycle change. That lifecycle
change is **not** applied by `wrangler versions upload`.

### Migration baseline

The current legacy migration history is:

```text
v1 QuotaController
v2 TokenizerController
v3 RelayDecisionController
```

If Phase 2 is required, the next migration is exactly:

```text
tag: v4
new_sqlite_classes:
  - RelayGrantLifecycleController
```

The repository remains on the legacy `migrations` flow for this issue; this
design does not migrate Wrangler configuration to declarative `exports`.

### Production migration bridge

Before the final CPU candidate can participate in a Production gradual
deployment, deploy a **post-migration stable-compatible bridge version** with
ordinary `wrangler deploy`.

The bridge version:

- exports `RelayGrantLifecycleController`;
- contains binding `RELAY_GRANT_LIFECYCLE_CONTROLLER`;
- applies migration `v4`;
- retains all existing Production bindings/secrets;
- keeps normal activation/renewal/terminal traffic on the existing
  Worker-side implementation;
- does not enable lifecycle offload for normal traffic.

The bridge provisioning deployment is not CPU acceptance evidence.

After this deployment, the bridge version is the Production stable version and
the **only pre-candidate rollback baseline** for Phase 2.

A version earlier than the applied `v4` lifecycle migration is not a valid
Phase 2 rollback target.

### Final candidate upload

After the bridge is confirmed healthy:

1. Build the final CPU candidate from the exact immutable source revision that
   passed the current Stage 1.
2. Keep the already-applied `v4` migration unchanged.
3. Upload the final candidate with `wrangler versions upload`; this upload must
   not contain a new Durable Object lifecycle change.
4. Create a deployment containing exactly:

```text
post-migration bridge stable: 100%
final CPU candidate:            0%
```

5. Verify both version IDs are members of the current deployment before
   Stage 2 begins.

The migration bridge revision and the final CPU candidate revision are
intentionally distinct concepts. The bridge does not need to equal the Stage 1
candidate. The final CPU candidate does.

### Candidate targeting

Every Stage 2 candidate request uses the Cloudflare version override header:

```text
Cloudflare-Workers-Version-Overrides:
  <production-worker-name>="<exact-final-candidate-version-id>"
```

A Stage 2 invocation is accepted as evidence only when platform
`ScriptVersion` / Worker version metadata proves that the exact final candidate
ran.

If:

- the candidate is not in the current deployment;
- the override header is rejected or ignored;
- the invocation resolves to the bridge version; or
- the invoked ScriptVersion cannot be proven,

the invocation is excluded from PASS evidence and the series becomes
`BLOCKED / INCOMPLETE` if the required count cannot still be established.

### Phase 2 rollback

If Stage 2 or post-Stage-2 rollout fails:

- restore the post-migration bridge version to 100%;
- remove the final candidate from active traffic as appropriate;
- retain migration `v4`;
- retain the lifecycle class and binding;
- retain relay secrets and QuotaController compatibility;
- never attempt to roll back to a pre-`v4` Worker solely to remove the new
  class.

## Stage 1: isolated Preview / temporary-resource gate

Run the complete canonical workload matrix against isolated Preview or
temporary resources.

Stage 1 uses isolated Preview quota state and may exercise the complete normal
grant lifecycle, including real successful activation/renewal/terminal
semantics against Preview resources.

Every required Worker series must:

- use the final candidate source revision;
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

Normal Production traffic remains on the post-migration bridge/stable version.

Only the protected canary driver targets the final candidate at 0% by version
override.

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

### Lifecycle series: one zero-reservation canary grant

For each `workloadClass x concurrency` lifecycle measurement group, the
protected harness creates exactly one synthetic canary grant through the
existing internal relay decision contract.

The harness may possess the Production relay service credential and relay HMAC
key only through a protected secret source. It must never print or persist
either secret.

The setup decision uses:

```text
reservedTokens = 0
upperBoundTokens = 0
maxOutputTokens = 0
no Idempotency-Key
```

and otherwise valid signed Production relay context/metadata.

This creates:

- one authoritative grant;
- zero token reservation;
- one in-flight lease;
- one request/grant record pair.

Setup invocations occur outside the CPU measurement window and are not counted
toward a required series.

### Capacity guard

The canary may hold **at most one** active canary grant/lease at any time.

Before creating that grant, a quota-capacity probe obtains safe aggregate
capacity evidence without mutation. The implementation must emit or expose to
the protected gate harness only non-sensitive aggregate fields sufficient to
prove:

```text
activeLeaseCountBefore = 0
maxInFlight >= 3
```

This evidence must not expose request IDs for normal users, payloads, keys, or
credentials and must not become a Production public API.

If the precondition is not proven, the lifecycle series does not start and is
`BLOCKED / INCOMPLETE` for that attempt.

The canary therefore never begins by consuming the last normal in-flight slot;
with the canary lease present, at least two configured slots remain available.

### Lifecycle CPU sampling on the single grant

The same valid grant is used to exercise the three callback classes in order:

1. **activation series**
   - first valid activation may transition `authorized -> attempted`;
   - repeated valid activation calls may return the existing replay denial;
   - those responses are expected protocol outcomes and still count as
     successful driver invocations when the exact expected response is
     observed.

2. **renewal series**
   - grant is already `attempted`;
   - repeated valid renewals operate on the same lease;
   - concurrency 1/2/3 refers to callback request concurrency, not the number of
     authoritative grants or leases.

3. **terminal series**
   - first terminal report is exactly `settle(totalTokens=0)`;
   - repeated terminal reports use the same terminal fingerprint and exercise
     the existing idempotent terminal response;
   - concurrency 1/2/3 again uses the same one grant.

This approach measures the stateless Worker trust/parse/dispatch path without
creating 500 grants or consuming Production token quota.

For Phase 2-offloaded candidates, the same requests measure the thin stateless
Worker path while the lifecycle DO performs trust/semantic work. DO CPU is
recorded separately and does not substitute for the stateless 5/7/0 gate.

### Upstream behavior

The 500-sample Stage 2 CPU matrix sends **no upstream model request**.

Activation in this controlled lifecycle fixture means only that the existing
authoritative grant state enters `attempted`; the harness itself performs no
Gateway B/OpenAI request.

The terminal outcome is therefore deterministically `settle(totalTokens=0)`,
not `release`. `release` is never used after activation.

Any later ordinary end-to-end Production smoke request is a separate rollout
correctness check, is bounded in count, is accounted as real quota usage, and
is not part of the 500-sample CPU acceptance evidence.

### Persistent state impact

For every lifecycle measurement group, exactly one zero-token canary
request/grant pair may remain as settled historical state until normal
day-finalization cleanup.

No Idempotency-Key is used, so no canary idempotency mapping is created.

The expected authoritative delta for `N` completed lifecycle measurement
groups is:

```text
confirmedTokens:       unchanged
reservedTokens:        unchanged
uncertainTokens:       unchanged
unresolved reserved:   unchanged
unresolved uncertain:  unchanged
active canary leases:  0 after cleanup
requestCount:          +N
settled canary entries:+N
settled canary grants: +N
```

The bounded `requestCount` / settled-record delta is accepted as measurement
metadata; it does not reduce remaining quota.

### Pre/post state invariant

The protected harness records an authoritative safe aggregate snapshot before
the first setup grant and after every lifecycle group cleanup.

PASS requires:

```text
confirmedTokens_after  == confirmedTokens_before
reservedTokens_after   == reservedTokens_beforeuncertainTokens_after  == uncertainTokens_before
unresolved_after       == unresolved_before
activeLeaseCount_after == activeLeaseCount_before
requestCount_after     == requestCount_before + expectedCanaryGrantCount
```

The harness also records every canary request ID in a protected temporary file
and verifies that each corresponding grant/request is terminal `settled` with
zero actual tokens.

The request-ID file is deleted after acceptance evidence is reduced to safe
aggregate results.

### Failure cleanup

If a canary lifecycle group fails before the expected terminal settlement:

1. stop the current and all subsequent Stage 2 series;
2. do not start another canary grant;
3. determine whether the canary grant is still `authorized`, `attempted`,
   `uncertain`, or terminal;
4. if still `authorized`, a normal `release` terminal is legal;
5. if `attempted`, do **not** use `release`;
6. because the Stage 2 harness performs no upstream request, an attempted
   canary may be reconciled as `unused` only after protected operator evidence
   confirms that no upstream attempt occurred;
7. require the post-cleanup authoritative state invariant before any rerun.

Failure cleanup evidence is not PASS evidence.

## Evidence continuity

The migration bridge deployment and CPU acceptance candidate are deliberately
separate identities.

### Bridge identity

The bridge exists only to provision migration `v4`, binding, and a compatible
rollback baseline. Its source revision may differ from the final candidate.

### Final CPU candidate identity

The **final CPU candidate** is immutable across its accepted Stage 1 and Stage
2 evidence.

The following must remain identical:

- source revision;
- lifecycle DO implementation;
- Worker/lifecycle RPC contract;
- callback routing behavior;
- binding names and class names;
- CPU gate implementation;
- measurement harness version/fingerprint;
- workload definitions.

Environment-specific values may differ where Preview/Production isolation
requires them, including secret values, endpoints, namespace IDs, and
environment label.

Stage 2 additionally records the exact Production ScriptVersion produced from
that final candidate source.

If source, lifecycle implementation, RPC contract, CPU gate logic, workload
definition, or harness semantics change, Stage 1 evidence is invalid and must
be rerun.

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
- Stage 2's protected internal measurement credentials are never exposed to
  clients or written to logs/artifacts.

## Rollback compatibility

While unresolved relay grants exist:

- retain the internal relay callback routes;
- retain `RELAY_GRANT_LIFECYCLE_CONTROLLER` once migration `v4` has been
  applied;
- retain the relevant relay HMAC secret;
- retain `QuotaController`;
- retain migration `v4`.

Phase 2 rollback always means returning to the post-migration bridge-compatible
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

Verify the normative order:

```text
Stage 1 final candidate PASS
    ->
Production wrangler deploy bridge applies v4
    ->
bridge becomes 100% stable/rollback baseline
    ->
final candidate versions upload, no new lifecycle migration
    ->
deployment bridge=100%, candidate=0%
    ->
version override reaches exact candidate ScriptVersion
    ->
Stage 2
```

Tests must reject:

- `versions upload` as the operation that first introduces `v4`;
- candidate deployment without bridge migration;
- pre-`v4` rollback after migration;
- Stage 2 request whose version override did not resolve to the candidate.

### Measurement-correlation tests

Test that platform telemetry alone can classify every required series using:

```text
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
- setup grant has zero reservation and no idempotency key;
- at most one canary grant/lease exists at once;
- capacity precondition is proven before setup;
- concurrency 1/2/3 does not create additional grants;
- activation then renewal then settle(0) is used;
- `activate -> release` is never used;
- repeated terminal report is idempotent;
- no upstream request is made by the 500-sample CPU matrix;
- pre/post token and unresolved counters are identical;
- active lease count returns to baseline;
- requestCount delta equals the expected number of canary grants;
- all canary entries/grants finish settled with zero actual tokens;
- failure cleanup stops further measurement and restores the invariant before
  rerun.

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
- If Phase 2 is active, migration `v4` is applied by a bridge
  `wrangler deploy` before final candidate version upload.
- After `v4`, the bridge is the rollback baseline.
- Stage 2 final candidate is present at 0% beside the 100% bridge/stable
  version and is targeted by exact version override.
- Platform metadata proves every Stage 2 sample ran the exact candidate.
- Stage 2 does not increase Production confirmed/reserved/uncertain token state.
- Stage 2 has at most one active canary grant/lease and restores active lease
  state after each group.
- Stage 2 sends no upstream model request as part of the 500-sample CPU gate.
- Any bounded persistent canary records are settled zero-token records and are
  accounted by the expected `requestCount` delta.
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