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
  -> lifecycle callback Authorization only

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
POST /internal/relay/v1/activation
POST /internal/relay/v1/renewal
POST /internal/relay/v1/terminal
```

The runner does not use the service bearer on any CPU-gate control route.

For the CPU-gate bearer, use is restricted to:

```text
/internal/relay/v1/cpu-gate/setup
/internal/relay/v1/cpu-gate/quota
/internal/relay/v1/cpu-gate/grant-inspection
/internal/relay/v1/cpu-gate/reconcile-unused
```

Neither bearer may be stored in the repository, shell trace, request fixture,
application log, acceptance report, retained artifact, or long-lived local
file. The Stage 2 runner discards both when the run ends.

### CPU-gate secret lifecycle

CPU-gate control availability is controlled entirely by
`OCTG_RELAY_CPU_GATE_AUTH_TOKEN`.

The exact configuration semantics are:

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
```

Bearer comparison is constant-time.

After Stage 2 acceptance evidence has been collected, the Production
`OCTG_RELAY_CPU_GATE_AUTH_TOKEN` secret binding is deleted. This disables all
CPU-gate control routes without changing source revision. Secret removal is an
environment-specific configuration change and does not invalidate the already
captured Stage 1/Stage 2 candidate evidence.

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
      readonly kind: "not_found";
      readonly cpuGateFixture: false;
    }
  | {
      readonly kind: "found";
      readonly state: RelayCpuGateGrantState;
      readonly requestState: RequestState | "not_found";
      readonly reservedTokens: number;
      readonly upperBoundTokens: number;
      readonly maxOutputTokens: number;
      readonly actualTokens: number | null;
      readonly activeLease: boolean;
      readonly cpuGateFixture: boolean;
    };

export interface RelayCpuGateControllerOperations {
  getRelayCpuGateSnapshot(): Promise<RelayCpuGateSnapshot>;
  getRelayCpuGateGrantInspection(
    requestId: string,
  ): Promise<RelayCpuGateGrantInspection>;
}
```

`QuotaController` implements exactly these two additional read-only RPCs.

The existing The earlier state-only inspection concept is superseded. The only canary-specific
read-only RPC is `getRelayCpuGateGrantInspection(requestId)`.

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

Snapshot values are **capacity/preflight and diagnostic evidence only**.
Because normal Production traffic shares the same QuotaController namespace,
changes in global counters during Stage 2 are not candidate failures.

#### Canary-owned inspection authority

`getRelayCpuGateGrantInspection(requestId)` reads only canonical
QuotaController storage for that request ID:

- `relay-grant:<requestId>`;
- `req:<requestId>`;
- canonical active in-flight leases after read-only expiry filtering.

It returns no payload, prompt, raw credential, key, client ID, model, normal
request list, or unrelated request state.

The QuotaController environment additionally receives the same four
non-secret, pool-specific fixture identifiers used by the Worker setup route:

```text
OCTG_RELAY_CPU_GATE_STANDARD_CLIENT_ID
OCTG_RELAY_CPU_GATE_STANDARD_MODEL
OCTG_RELAY_CPU_GATE_MINI_CLIENT_ID
OCTG_RELAY_CPU_GATE_MINI_MODEL
```

The QuotaController chooses the expected client/model from **its own pool
identity**. The caller cannot supply or override expected client/model values.

For a found grant, `cpuGateFixture` is true only when all of the following
canonical facts are true:

```text
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

If any condition is false, `cpuGateFixture=false`.

`activeLease` is true only when the canonical active in-flight lease set
contains this request ID with the grant's exact `leaseGeneration`.

`actualTokens` is the request entry's canonical `actualTokens` when present,
otherwise `null`.

This inspection performs no mutation.

### Exact Worker inspection routes

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

No request ID list is exposed.

#### Canary grant inspection

```text
POST /internal/relay/v1/cpu-gate/grant-inspection
Content-Type: application/json
Authorization: Bearer <OCTG_RELAY_CPU_GATE_AUTH_TOKEN>
```

Body:

```ts
interface RelayCpuGateGrantInspectionRequestV1 {
  readonly version: 1;
  readonly grantToken: string;
}
```

The Worker:

1. requires the CPU-gate control surface to be enabled;
2. authenticates the CPU-gate bearer;
3. verifies `grantToken` with the Cloudflare-side
   `OCTG_RELAY_CONTEXT_HMAC_KEY`;
4. requires the signed environment to equal the runtime environment;
5. derives `pool`, `admissionUtcDay`, and `requestId` only from verified
   grant claims;
6. resolves exactly that QuotaController;
7. calls `getRelayCpuGateGrantInspection(requestId)`;
8. returns exactly:

```ts
interface RelayCpuGateGrantInspectionResponseV1 {
  readonly version: 1;
  readonly inspection: RelayCpuGateGrantInspection;
}
```

The external harness cannot select an arbitrary request ID. It must present a
valid signed grant credential, and fixture ownership is decided from canonical
stored state by QuotaController.

### Cloudflare-side lifecycle fixture setup

The external harness MUST NOT receive `OCTG_RELAY_CONTEXT_HMAC_KEY` and MUST
NOT construct or sign a RelayContext or RelayGrantCredential.

The exact setup route is:

```text
POST /internal/relay/v1/cpu-gate/setup
Content-Type: application/json
Authorization: Bearer <OCTG_RELAY_CPU_GATE_AUTH_TOKEN>
```

Body:

```ts
interface RelayCpuGateSetupRequestV1 {
  readonly version: 1;
  readonly pool: "STANDARD" | "MINI";
}
```

The Worker-owned pool-specific fixture identifiers are:

```text
OCTG_RELAY_CPU_GATE_STANDARD_CLIENT_ID
OCTG_RELAY_CPU_GATE_STANDARD_MODEL
OCTG_RELAY_CPU_GATE_MINI_CLIENT_ID
OCTG_RELAY_CPU_GATE_MINI_MODEL
```

Those client IDs are dedicated enabled CPU-gate clients and the configured
model for each pair must classify to its requested pool.

The external request cannot supply a client ID, model, reservation, upper
bound, cache mode, environment, or signing input.

For setup, the Worker:

1. requires the CPU-gate control surface to be enabled;
2. authenticates the CPU-gate bearer;
3. resolves the requested pool's Worker-owned fixture client/model;
4. verifies that client/model configuration is valid for that pool;
5. generates a fresh normal relay `requestId`;
6. builds a valid Production `RelayContextV1` with the dedicated fixture
   client, no idempotency key, runtime environment, normal timestamps, and a
   fresh nonce;
7. constructs synthetic metadata with:
   - `model` = configured fixture model;
   - `estimatedInputTokens = 0`;
   - `maxOutputTokens = 0`;
   - `inputBytes = 0`;
   - `rawBodyBytes = 0`;
   - `isToolUse = false`;
   - `stream = false`;
8. calls the existing authoritative `QuotaController.admitRelay(...)`
   transaction with:
   - `reservedTokens = 0`;
   - `upperBoundTokens = 0`;
   - `maxOutputTokens = 0`;
   - `cacheEnabled = false`;
   - no raw Idempotency-Key;
9. performs no direct Durable Object storage mutation and no D1 quota
   mutation;
10. after admission, builds normal `RelayGrantCredentialV1` claims from the
    returned authoritative grant and signs the grant credential with
    `OCTG_RELAY_CONTEXT_HMAC_KEY` inside Cloudflare;
11. returns:

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

12. the harness immediately calls `grant-inspection` and requires:

```text
kind = found
cpuGateFixture = true
state = authorized
requestState = reserved
reservedTokens = 0
upperBoundTokens = 0
maxOutputTokens = 0
actualTokens = null
activeLease = true
```

A setup admission denial is fail-closed and produces no CPU series evidence.

Setup and its inspection occur outside every CPU acceptance measurement window.

### Why zero reservation is possible here

The ordinary `RelayDecisionController` budget resolver applies a minimum
safety margin of 256 tokens, or 512 tokens at low remaining ratio. Therefore
`estimatedInputTokens=0` and `maxOutputTokens=0` do not produce a zero
reservation through the normal decision budget path.

The CPU-gate setup route deliberately does **not** call that budget resolver.
It delegates the fixed zero-reservation mutation to the existing authoritative
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

It does **not** require `activeLeaseCount=0` and does not use global counter
equality as Stage 2 PASS evidence.

Normal Production traffic remains active on the bridge/stable version and may
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

The CPU-gate control plane creates at most **one** CPU-gate grant at a time.
Therefore its bounded Production capacity impact is at most one in-flight slot.
The design does not claim that two normal slots remain continuously during the
measurement.

### Lifecycle CPU sampling on the single grant

The same valid canary grant is used to exercise the three callback classes in
order.

The Stage 2 runner calls each existing callback route with:

```text
Authorization: Bearer <OCTG_RELAY_SERVICE_AUTH_TOKEN>
X-OCTG-Relay-Grant: <grantToken>
Content-Type: application/json
```

This preserves the exact Production lifecycle callback authentication hot path.

1. **activation series**
   - first valid activation may transition `authorized -> attempted`;
   - repeated valid activation calls may return the existing replay denial;
   - those exact expected responses count as successful driver invocations.

2. **renewal series**
   - grant is already `attempted`;
   - repeated valid renewals operate on the same lease;
   - concurrency 1/2/3 is callback request concurrency, not grant count.

3. **terminal series**
   - first terminal report is exactly `settle(totalTokens=0)`;
   - repeated terminal reports use the same terminal fingerprint and exercise
     existing idempotent terminal handling;
   - concurrency 1/2/3 again uses the same grant.

The runner holds the returned grant credential, CPU-gate bearer, and service
bearer only for the active measurement run. It never receives a signing key.

For Phase 2-offloaded candidates, these requests measure the thin stateless
Worker path while the lifecycle DO performs trust/semantic work. DO CPU is
recorded separately and does not substitute for the stateless 5/7/0 gate.

### Upstream behavior

The 500-sample Stage 2 CPU matrix sends **no upstream model request**.

Activation means only that the authoritative grant reaches `attempted`; the
gate runner never performs Gateway B/OpenAI traffic.

The terminal outcome is therefore deterministically
`settle(totalTokens=0)`. `release` is never used after activation.

Any later ordinary end-to-end Production smoke is a separate rollout
correctness check, bounded in count and accounted as real quota usage. It is
not part of the 500-sample CPU acceptance evidence.

### Canary-owned quota-safety PASS invariant

Global Production counters are not compared before and after Stage 2.

For every canary grant, the authoritative
`getRelayCpuGateGrantInspection(requestId)` result is the quota-safety
evidence.

Immediately after setup, PASS requires the setup inspection described above.

After normal terminal completion, the harness calls `grant-inspection` again
and requires:

```text
kind = found
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

The runner may retain `requestId` and `grantToken` only in protected
in-memory/ephemeral-runner state while the group is active. They are not
written to logs or retained artifacts.

### Exact failure cleanup control

The protected cleanup route is:

```text
POST /internal/relay/v1/cpu-gate/reconcile-unused
Content-Type: application/json
Authorization: Bearer <OCTG_RELAY_CPU_GATE_AUTH_TOKEN>
```

Body:

```ts
interface RelayCpuGateReconcileUnusedRequestV1 {
  readonly version: 1;
  readonly grantToken: string;
}
```

The Worker:

1. requires the CPU-gate control surface to be enabled;
2. authenticates the CPU-gate bearer;
3. verifies the grant credential with the Cloudflare-side HMAC key;
4. requires signed environment = runtime environment;
5. derives pool/day/request ID only from verified claims;
6. resolves the authoritative QuotaController;
7. calls `getRelayCpuGateGrantInspection(requestId)`;
8. requires:
   - `kind = "found"`;
   - `cpuGateFixture = true`;
   - `state = "attempted"` or `state = "uncertain"`;
9. if any requirement is false, performs **no mutation** and fails closed;
10. otherwise calls only the existing authoritative
    `QuotaController.reconcileRequest(requestId, "unused")`;
11. re-reads `getRelayCpuGateGrantInspection(requestId)`;
12. succeeds only when:
    - `cpuGateFixture = true`;
    - `state = "reconciled_unused"`;
    - `requestState = "released"`;
    - `activeLease = false`.

The route cannot reconcile a normal Production grant merely because the caller
holds a valid grant token. CPU-gate fixture authorization is derived from the
canonical stored grant/request facts and the QuotaController-owned
pool-specific canary configuration.

The route never performs direct storage mutation.

Failure handling is exact:

- `authorized` CPU-gate fixture -> use normal terminal callback `release`
  with the existing service bearer;
- `attempted` or `uncertain` CPU-gate fixture -> protected
  `reconcile-unused`, because this measurement architecture sends no upstream
  request;
- terminal CPU-gate fixture -> no cleanup mutation;
- `cpuGateFixture=false`, `not_found`, invalid token, or unverifiable state
  -> no mutation and `BLOCKED / INCOMPLETE`.

After failure cleanup, `grant-inspection` must prove the canary-owned terminal
state before any rerun. Global Production counter equality is not required.

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
- Stage 2's protected measurement credentials are never exposed to clients or written to logs/artifacts.
- `OCTG_RELAY_CONTEXT_HMAC_KEY` remains Cloudflare-side only.
- `OCTG_RELAY_SERVICE_AUTH_TOKEN` may be used by the protected Stage 2 runner only for the existing lifecycle callback routes.
- `OCTG_RELAY_CPU_GATE_AUTH_TOKEN` enables only the CPU-gate control plane and is removed after Stage 2 acceptance.

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
- CPU-gate control uses a dedicated bearer that is unavailable to Deno;
- CPU-gate secret absent or invalid disables every control route with 404 and no DO call;
- removing the CPU-gate secret after Stage 2 disables the privileged control surface without a source revision change;
- external harness never receives the Production relay HMAC key;
- Stage 2 runner receives the existing service bearer only for activation/renewal/terminal callback Authorization;
- setup grant is created through the existing QuotaController.admitRelay transaction with zero reservation and no idempotency key;
- setup cannot select arbitrary client/model/reservation/signing claims;
- at most one CPU-gate grant/lease exists at once;
- snapshot returns canonical aggregate capacity/diagnostic values but global counter equality is not a PASS invariant;
- maxInFlight >= 3 is checked as preflight evidence;
- normal Production traffic may change global counters during Stage 2 without failing the candidate;
- canary inspection derives fixture identity from canonical stored grant/request facts and QuotaController-owned pool configuration;
- setup inspection requires cpuGateFixture=true, authorized/reserved states, zero admission values, and activeLease=true;
- concurrency 1/2/3 does not create additional grants;
- activation then renewal then settle(0) is used;
- `activate -> release` is never used;
- repeated terminal report is idempotent;
- no upstream request is made by the 500-sample CPU matrix;
- completion inspection requires cpuGateFixture=true, settled/settled states, actualTokens=0, and activeLease=false;
- reconcile-unused refuses cpuGateFixture=false and performs no mutation;
- attempted/uncertain cleanup delegates only to existing QuotaController.reconcileRequest(requestId, "unused");
- cleanup never writes Durable Object storage directly;
- failure cleanup stops further measurement until canary-owned terminal state is proven.

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
- Stage 2 quota/capacity inspection is defined by exact read-only QuotaController RPCs and protected Worker routes.
- Stage 2 PASS does not depend on equality of global Production quota counters that normal traffic may legitimately change.
- Quota safety is proven from canary-owned canonical grant/request/lease inspection.
- Canary setup inspection proves cpuGateFixture=true, authorized/reserved state, zero reservation/upper-bound/max-output values, and an active matching lease.
- Canary completion inspection proves cpuGateFixture=true, settled grant/request state, actualTokens=0, and no active matching lease.
- Stage 2 has at most one CPU-gate canary grant/lease at any time; its capacity impact is bounded to at most one slot.
- maxInFlight >= 3 remains preflight evidence, but the design makes no continuous free-slot guarantee.
- Production relay HMAC signing remains Cloudflare-side; neither the external harness nor Deno receives OCTG_RELAY_CONTEXT_HMAC_KEY.
- The protected Stage 2 runner may use OCTG_RELAY_SERVICE_AUTH_TOKEN only on the existing activation/renewal/terminal callback routes.
- CPU-gate control uses the separate OCTG_RELAY_CPU_GATE_AUTH_TOKEN; absent or invalid secret disables all CPU-gate control routes fail-closed.
- The Production CPU-gate secret is removed after Stage 2 acceptance to close the privileged control surface.
- Stage 2 setup creates grants only through QuotaController.admitRelay.
- Canary inspection exposes no normal-user request list and requires a verified grant credential.
- reconcile-unused requires canonical cpuGateFixture=true before mutation and then uses only existing reconcileRequest(..., "unused") semantics.
- No CPU-gate route performs direct Durable Object storage mutation.
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