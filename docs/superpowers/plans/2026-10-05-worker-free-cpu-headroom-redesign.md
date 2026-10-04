<!-- markdownlint-disable MD013 MD032 -->

# Worker Free CPU Headroom Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Issue #121's Worker-Free CPU headroom redesign so every required stateless relay invocation class is measured against `p99 <= 5 ms`, `max <= 7 ms`, `exceededCpu = 0`, with conditional lifecycle Durable Object offload, candidate-compatible Durable Object bridging, and a Production-safe Stage 2 canary/control plane.

**Architecture:** First remove repeated relay HMAC `CryptoKey` imports and add the measurement/control-plane primitives required by the approved design. Run the complete Stage 1 Preview gate; add `RelayGrantLifecycleController` only if activation/renewal/terminal fails. Before Stage 2, deploy a 100% Durable Object compatibility bridge, upload the exact CPU-tested candidate at 0%, prove Worker/DO compatibility, run the Production-like gate, promote the exact tested candidate, then create and verify the separate CPU-gate-secret-less hardening version.

**Tech Stack:** TypeScript 5.6, Cloudflare Workers + SQLite-backed Durable Objects, Wrangler 4.x, Vitest / `@cloudflare/vitest-pool-workers`, Node.js 22 scripts/tests, Deno relay runtime, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-05-worker-free-cpu-headroom-redesign.md`

## Global Constraints

- Cloudflare Workers Paid is not an escape hatch; the Worker Free HTTP CPU ceiling remains 10 ms.
- Every required stateless Worker CPU series must satisfy `p99 <= 5 ms`, `max <= 7 ms`, and `exceededCpu = 0`; `max >= 8 ms` cannot pass.
- Each required `invocationClass x workloadClass x concurrency` series needs at least 500 successful invocations and complete platform telemetry.
- Required measurement windows are sequential and non-overlapping; incomplete or ambiguous attribution is `BLOCKED / INCOMPLETE`, never PASS.
- Cloudflare platform invocation telemetry is authoritative; application markers are supplementary only.
- `QuotaController` remains the sole quota authority; D1 remains non-authoritative for admission/settlement decisions.
- Never log or retain prompts, request/response bodies, client keys, service bearers, CPU-gate bearers, relay HMAC keys, grant credentials, or upstream credentials.
- `OCTG_RELAY_CONTEXT_HMAC_KEY` remains Cloudflare-side only and is never provided to Deno or an external gate runner.
- `OCTG_RELAY_SERVICE_AUTH_TOKEN` is used by Deno and the protected Stage 2 runner only for the existing lifecycle callback Authorization path.
- `OCTG_RELAY_CPU_GATE_AUTH_TOKEN` is a distinct control-plane bearer; absent/invalid means every CPU-gate control route is disabled with 404.
- Public Responses semantics remain unchanged; Chat Completions remains unchanged; `invalid_json` remediation remains out of scope.
- Preview and Production resources remain isolated.
- If activation/renewal/terminal fails Stage 1 or Stage 2, lifecycle offload is activated and **all Stage 1 evidence is rerun**. Ingress/decision failure does not activate lifecycle offload.
- The Stage 2 Durable Object compatibility bridge is required whether Phase 2 is active or inactive.
- A version override identifies only the incoming stateless Worker invocation; it never proves the code version executed by a Durable Object.
- Bridge/candidate Durable Object contracts and behavior-affecting module closures must be mechanically equivalent before Stage 2.
- Production remote mutation, deployment, telemetry collection, or canary execution requires explicit operator/user authorization at execution time; local implementation tasks do not authorize remote changes.
- Every implementation task ends at a reviewable commit boundary. Do not push or deploy merely because a task reaches GREEN.

## Review Focus

1. **HMAC key rotation/rejection race:** equal-byte keys must share one import, a rotated key must replace it, and rejection of an old import must never clear a newer cache entry. Task 1 owns the regression tests.
2. **CPU-gate ambiguous setup acknowledgement:** a lost setup response must be recoverable by the runner-owned request ID without creating a second live fixture. Task 5 owns the route semantics; Task 6 owns runner retry/serialization tests.
3. **Worker/DO gradual-deployment skew:** candidate Worker -> bridge-version QuotaController/lifecycle DO and bridge Worker -> candidate-version QuotaController must remain contract-compatible. Tasks 8 and 9 own manifest/bridge tests.
4. **Missing application marker on CPU kill:** `exceededCpu` platform records must still fail the series even when no application finish marker exists. Task 6 owns evidence-reducer tests.
5. **Post-gate secret teardown:** deleting only `OCTG_RELAY_CPU_GATE_AUTH_TOKEN` creates a distinct hardening ScriptVersion; all other code/config/DO contracts must remain equivalent. Tasks 9 and 12 own rollout/hardening assertions.

---

## File and interface map

| File | Responsibility |
| --- | --- |
| `packages/shared/src/relay-credential.ts` | Isolate-local single-entry `Promise<CryptoKey>` cache for relay HMAC import. |
| `packages/shared/src/relay-routing.ts` | Shared 64-way FNV shard helper, decision/lifecycle shard names, and `relayRequestUtcDayOf(requestId)`. |
| `packages/shared/src/relay.ts` | Existing relay wire contract plus lifecycle-DO and CPU-gate internal control/RPC types. |
| `packages/shared/src/index.ts` | Export the new shared contracts/helpers. |
| `durable-objects/quota-controller/src/relay-cpu-gate.ts` | Read-only CPU-gate snapshot/fixture inspection and canonical `cpuGateFixture` predicate. |
| `durable-objects/quota-controller/src/relay-config.ts` | Shared QuotaController-side max-in-flight and CPU-gate fixture configuration parsing. |
| `durable-objects/quota-controller/src/quota-controller.ts` | Expose exact read-only CPU-gate RPCs; retain all existing quota/lifecycle RPCs unchanged. |
| `apps/gateway-worker/src/relay-cpu-gate.ts` | Protected `/internal/relay/v1/cpu-gate/*` routes: snapshot, setup, operation inspection, reconcile-unused. |
| `apps/gateway-worker/src/relay-grant-claims.ts` | One canonical `RelayGrant -> RelayGrantCredentialV1` mapping shared by Decision DO and CPU-gate setup. |
| `apps/gateway-worker/src/relay-observation.ts` | Sanitized `octg.relay_invocation` supplementary markers. |
| `apps/gateway-worker/src/relay-grant-lifecycle-controller.ts` | Conditional stateless-processing DO for activation/renewal/terminal trust + semantic work. |
| `apps/gateway-worker/src/relay-callback.ts` | Existing callback transport; optional lifecycle-DO dispatch only when the exact offload toggle is enabled. |
| `apps/gateway-worker/src/relay-decision-controller.ts` | Consume shared shard helper and shared grant-claims mapping; admission semantics unchanged. |
| `apps/gateway-worker/src/index.ts` | Export/bind new DO, CPU-gate route precedence, exact env contract. |
| `apps/gateway-worker/wrangler.jsonc` | Phase-2-active binding/migration `v4`; 100% telemetry sampling remains required. |
| `scripts/relay-cpu-workloads.mjs` | Canonical workload builders and execution-condition definitions. |
| `scripts/relay-cpu-evidence.mjs` | Pure platform-telemetry series classifier and PASS/FAIL/BLOCKED reducer. |
| `scripts/run-relay-cpu-gate.mjs` | Protected Stage 1/Stage 2 driver, runner-owned request IDs, one-operation serialization, candidate version override. |
| `scripts/do-compatibility-manifest.mjs` | Runtime bundle digest + type/source contract closure digest for bridge/candidate DO compatibility. |
| `scripts/relay-cpu-rollout.mjs` | Validated bridge/candidate/hardening Wrangler command orchestration; no implicit production execution. |
| `scripts/preview-worker-config.mjs` | Preview DO/config isolation including optional lifecycle DO and CPU-gate fixture variables. |
| `.github/workflows/deploy-production.yml` | Prevent direct unsafe 100% candidate deploy; call validated Issue #121 staging path after source merge. |
| `docs/operations.md` | Operator sequence, evidence fields, rollback, Stage 1/bridge/Stage 2/hardening runbook. |

## Task dependency graph

```text
Task 1  HMAC cache
   |
Task 2  shared routing + CPU-gate/lifecycle contracts
   |
Task 3  QuotaController read-only inspection
   |
Task 4  Worker CPU-gate control plane + safe marker
   |
Task 5  CPU workload/evidence runner
   |
Task 6  Production recurrence attribution + Stage 1 execution gate
   |
   +-- PASS for activation/renewal/terminal ----------------------+
   |                                                              |
   +-- lifecycle FAIL -> Task 7 -> Task 8 -> rerun Task 6 -------+
          lifecycle contract/DO     Worker offload + Preview v4
                                                                  |
Task 9  DO compatibility manifest --------------------------------+
   |
Task 10 bridge/candidate/hardening rollout tooling + workflow
   |
Task 11 local full verification + operations documentation
   |
Task 12 authorized remote Stage 2 / promotion / hardening evidence
```

If Task 6 reports ingress or decision FAIL, STOP. Do not run Tasks 7-12 until a separately reviewed remediation changes that invocation class.

---

### Task 1: Cache the relay HMAC CryptoKey import

**Files:**
- Modify: `packages/shared/src/relay-credential.ts`
- Modify: `packages/shared/test/relay-credential.test.ts`

**Interfaces:**
- Consumes: existing `computeRelayMac(key, purposeBytes, payloadBytes)`.
- Produces: private `relayMacKey(key: Uint8Array): Promise<CryptoKey>`; public sign/verify signatures remain unchanged.

- [ ] **Step 1: Write RED tests for cache identity, concurrency, rotation, and rejection**

Add tests named:

```text
reuses one imported CryptoKey for equal key bytes
collapses concurrent first use onto one import Promise
imports a new CryptoKey after key rotation
retries import after the current import rejects
an older rejected import cannot clear a newer rotated-key cache entry
preserves existing context/grant token bytes after caching
```

Spy/mock `crypto.subtle.importKey` only; never inspect/log raw key material.

- [ ] **Step 2: Run the focused RED test**

Run:

```bash
npm test -w packages/shared -- relay-credential.test.ts
```

Expected RED: the new import-count/race assertions fail because every MAC currently imports a fresh key.

- [ ] **Step 3: Implement the minimal single-entry Promise cache**

In `relay-credential.ts` add one module-scope entry with exact semantics:

```ts
type RelayMacKeyCacheEntry = {
  readonly rawKeySnapshot: Uint8Array;
  readonly promise: Promise<CryptoKey>;
};
```

`relayMacKey(key)` must:

- compare raw key bytes by content;
- reuse the current promise for equal bytes even when the caller passes another `Uint8Array` object;
- copy the raw bytes into `rawKeySnapshot`;
- install the new import promise **before awaiting it**;
- on rejection, clear the cache only if the rejected promise is still the current entry;
- never cache MAC output;
- keep `crypto.subtle.sign()` per MAC.

- [ ] **Step 4: Run GREEN tests**

Run:

```bash
npm test -w packages/shared -- relay-credential.test.ts
npm run typecheck -w packages/shared
```

Expected GREEN: all relay credential tests and shared typecheck pass.

- [ ] **Step 5: Refactor only if duplication remains**

Do not export cache/reset hooks solely for tests. If tests need isolation, use module reset or a fresh distinct key rather than production cache-control API.

- [ ] **Step 6: Commit boundary**

```bash
git add packages/shared/src/relay-credential.ts packages/shared/test/relay-credential.test.ts
git commit -m "perf: reuse relay HMAC CryptoKey imports"
```

---

### Task 2: Define shared routing, lifecycle RPC, and CPU-gate control contracts

**Files:**
- Create: `packages/shared/src/relay-routing.ts`
- Create: `packages/shared/test/relay-routing.test.ts`
- Modify: `packages/shared/src/relay.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/test/relay.test.ts`
- Modify: `apps/gateway-worker/src/relay-decision-controller.ts`
- Modify: `apps/gateway-worker/test/relay-decision-controller.test.ts`

**Interfaces:**
- Consumes: existing `RelayEnvironment`, `RelayGrantState`, `RequestState`, `RELAY_REQUEST_ID_PATTERN`.
- Produces:
  - `relayShardIndex(requestId: string): string`
  - `relayDecisionShardName(environment, requestId): string`
  - `relayGrantLifecycleShardName(environment, requestId): string`
  - `relayRequestUtcDayOf(requestId: string): string | undefined`
  - `RelayGrantLifecycleAction`
  - `RelayGrantLifecycleDispatchInput`
  - `RelayGrantLifecycleDispatchResult`
  - `RelayGrantLifecycleControllerOperations`
  - `RelayCpuGateSnapshot`
  - `RelayCpuGateGrantState`
  - `RelayCpuGateGrantInspection`
  - `RelayCpuGateSetupRequestV1`
  - `RelayCpuGateSetupResponseV1`
  - `RelayCpuGateOperationRequestV1`
  - `RelayCpuGateOperationInspectionV1`
  - `RelayCpuGateOperationNotFoundV1`

- [ ] **Step 1: Write RED routing tests**

Pin:

- FNV-1a 32-bit constants `2166136261`, `16777619`, mask `63`;
- two-digit shard output `00..63`;
- exact names:
  - `relay-decision:v1:<environment>:<shard>`
  - `relay-grant-lifecycle:v1:<environment>:<shard>`;
- known request IDs map identically for both prefixes;
- invalid request IDs return no UTC day;
- `relayRequestUtcDayOf` decodes the first 10 Crockford-Base32 ULID characters after `req_` and returns exact UTC `YYYY-MM-DD`.

- [ ] **Step 2: Write RED type/contract tests**

Extend `relay.test.ts` with compile/runtime shape assertions for the control result discriminants and exact lifecycle result kinds.

- [ ] **Step 3: Run RED**

```bash
npm test -w packages/shared -- relay-routing.test.ts relay.test.ts
npm test -w apps/gateway-worker -- relay-decision-controller.test.ts
```

Expected RED: missing module/types and the Decision DO still owns its private shard helper.

- [ ] **Step 4: Implement shared helpers/contracts**

Move only the shard algorithm/name generation out of `relay-decision-controller.ts`; keep Decision DO behavior unchanged.

`relayRequestUtcDayOf` must reject non-canonical IDs, overflow/impossible ULID timestamps, and dates outside JavaScript's safe/date range.

- [ ] **Step 5: GREEN**

```bash
npm test -w packages/shared -- relay-routing.test.ts relay.test.ts
npm test -w apps/gateway-worker -- relay-decision-controller.test.ts
npm run typecheck -w packages/shared
npm run typecheck -w apps/gateway-worker
```

Expected GREEN: exact old decision shard names are preserved and all new contracts typecheck.

- [ ] **Step 6: Commit boundary**

```bash
git add packages/shared/src/relay-routing.ts packages/shared/src/relay.ts packages/shared/src/index.ts packages/shared/test/relay-routing.test.ts packages/shared/test/relay.test.ts apps/gateway-worker/src/relay-decision-controller.ts apps/gateway-worker/test/relay-decision-controller.test.ts
git commit -m "refactor: share relay routing and CPU gate contracts"
```

---

### Task 3: Add read-only QuotaController CPU-gate inspection RPCs

**Files:**
- Create: `durable-objects/quota-controller/src/relay-config.ts`
- Create: `durable-objects/quota-controller/src/relay-cpu-gate.ts`
- Create: `durable-objects/quota-controller/test/relay-cpu-gate.test.ts`
- Modify: `durable-objects/quota-controller/src/relay-admission.ts`
- Modify: `durable-objects/quota-controller/src/quota-controller.ts`
- Modify: `durable-objects/quota-controller/src/store.ts`
- Modify: `apps/gateway-worker/vitest.config.ts`

**Interfaces:**
- Consumes: Task 2 CPU-gate types; canonical `relay-grant:<requestId>`, `req:<requestId>`, pool/unresolved/in-flight state.
- Produces:
  - `resolveMaxInFlightRequests(value?: string): number`
  - `resolveCpuGateFixtureIdentity(env, pool): {clientId: string; model: string} | undefined`
  - `getRelayCpuGateSnapshot(storage, env, identity, nowMs): Promise<RelayCpuGateSnapshot>`
  - `getRelayCpuGateGrantInspection(storage, env, identity, requestId, nowMs): Promise<RelayCpuGateGrantInspection>`
  - public DO RPCs with the same names/signatures.

- [ ] **Step 1: Write RED tests for snapshot read-only behavior**

Assert exact snapshot fields and prove expired-lease filtering does not write cleanup state. Include configured/default `MAX_IN_FLIGHT_REQUESTS`.

- [ ] **Step 2: Write RED tests for the canonical fixture predicate**

Cover every design predicate independently:

```text
clientId
model
pool/day
idempotencyKeyHash
admission reserved/upperBound/maxOutput/cacheEnabled
metadata estimatedInput/maxOutput/inputBytes/rawBodyBytes/isToolUse/stream
request entry presence
request entry idempotencyKey/tokens/upperBound/reserved
matching active lease generation
```

One mismatch at a time must yield `kind="non_fixture"`, not fixture details.

Also cover `kind="absent"` when neither grant nor request entry exists.

- [ ] **Step 3: Run RED**

```bash
npm test -w apps/gateway-worker -- ../../durable-objects/quota-controller/test/relay-cpu-gate.test.ts
```

Expected RED: inspection module/RPCs do not exist.

- [ ] **Step 4: Implement the minimum read-only helpers/RPCs**

Extract the max-in-flight resolver from `relay-admission.ts` into `relay-config.ts` so admission and snapshot share one exact resolver.

Add the four non-secret fixture variables to `QuotaControllerEnv`; do not accept expected client/model as RPC input.

Do not call `storage.put`, `saveInFlight`, or reconciliation from either inspection RPC.

- [ ] **Step 5: GREEN**

```bash
npm test -w apps/gateway-worker -- ../../durable-objects/quota-controller/test/relay-cpu-gate.test.ts ../../durable-objects/quota-controller/test/relay-admission.test.ts ../../durable-objects/quota-controller/test/index.test.ts
npm run typecheck -w apps/gateway-worker
```

Expected GREEN: inspection is read-only and existing admission/lifecycle behavior is unchanged.

- [ ] **Step 6: Commit boundary**

```bash
git add durable-objects/quota-controller/src/relay-config.ts durable-objects/quota-controller/src/relay-cpu-gate.ts durable-objects/quota-controller/src/relay-admission.ts durable-objects/quota-controller/src/quota-controller.ts durable-objects/quota-controller/src/store.ts durable-objects/quota-controller/test/relay-cpu-gate.test.ts apps/gateway-worker/vitest.config.ts
git commit -m "feat: add relay CPU gate quota inspection"
```

---

### Task 4: Implement the protected Worker CPU-gate control plane and safe relay markers

**Files:**
- Create: `apps/gateway-worker/src/relay-cpu-gate.ts`
- Create: `apps/gateway-worker/src/relay-grant-claims.ts`
- Create: `apps/gateway-worker/src/relay-observation.ts`
- Create: `apps/gateway-worker/test/relay-cpu-gate.test.ts`
- Create: `apps/gateway-worker/test/relay-observation.test.ts`
- Modify: `apps/gateway-worker/src/relay-auth.ts`
- Modify: `apps/gateway-worker/src/relay-decision-controller.ts`
- Modify: `apps/gateway-worker/src/index.ts`
- Modify: `apps/gateway-worker/test/relay-auth.test.ts`
- Modify: `apps/gateway-worker/test/relay-decision-controller.test.ts`
- Modify: `apps/gateway-worker/test/relay-callback.test.ts`

**Interfaces:**
- Consumes: Task 2 control types/routing helper; Task 3 QuotaController inspection/admission/reconcile RPCs; existing relay HMAC signer.
- Produces:
  - `resolveRelayCpuGateControl(env): {kind:"disabled"} | {kind:"enabled"; token:string}`
  - `verifyRelayCpuGateAuth(header, token): boolean`
  - `relayGrantClaimsOf(grant: RelayGrant): RelayGrantCredentialV1`
  - `handleRelayCpuGate(request: Request, env: Env): Promise<Response>`
  - `emitRelayInvocation(event: RelayInvocationEvent): void`

- [ ] **Step 1: Write RED auth/routing tests**

Pin:

- missing or invalid-shape `OCTG_RELAY_CPU_GATE_AUTH_TOKEN` => control surface 404 before body parsing/DO access;
- enabled route + missing/wrong bearer => 401 with no DO call;
- control prefix routes are selected before generic relay callback action parsing;
- CPU-gate bearer is never accepted as lifecycle service bearer and vice versa.

- [ ] **Step 2: Write RED setup/inspection/recovery tests**

Pin exact setup contract:

- runner supplies `pool + requestId`;
- request ID must satisfy pattern and current UTC day via `relayRequestUtcDayOf`;
- Worker chooses configured fixture client/model, nonce, environment, metadata, zero reservation/upper bound/output, no idempotency;
- existing state collision is fail-closed without mutation;
- successful admission is signed Cloudflare-side and returned as `RelayCpuGateSetupResponseV1`;
- grant HMAC key is never part of a response/log.

Pin operation-inspection:

- `pool + requestId + CPU-gate bearer`, no grant token;
- `absent` and `non_fixture` both externalize as the same 404/not-found shape;
- `fixture` returns only the approved inspection fields.

Pin reconcile-unused:

- no grant token;
- only canonical `cpuGateFixture=true` in `authorized|attempted|uncertain` may call `reconcileRequest(requestId,"unused")`;
- terminal/non-fixture/absent targets never mutate;
- success is re-inspected as `reconciled_unused / released / activeLease=false`.

- [ ] **Step 3: Write RED signing-failure compensation tests**

Reuse the existing Decision-DO poisoning technique: return an admitted grant whose claims make signing throw. Assert the CPU-gate setup calls authoritative `reconcileRequest(requestId,"unused")`, re-inspects terminal state, and returns a definite `setup_failed_compensated` result only after proof.

A failed/ambiguous compensation must return `setup_state_ambiguous` and must not claim the operation is safe to replace.

- [ ] **Step 4: Write RED safe-marker tests**

`RelayInvocationEvent` allowlist:

```text
event="octg.relay_invocation"
invocationClass=ingress|decision|activation|renewal|terminal
revisionId
requestId? 
workloadClass?  # controlled measurement only
concurrency?    # controlled measurement only
phase=start|finish
outcome?        # finish only
```

Attach secret-shaped extra properties in a test and prove they are not emitted.

- [ ] **Step 5: Run RED**

```bash
npm test -w apps/gateway-worker -- relay-cpu-gate.test.ts relay-observation.test.ts relay-auth.test.ts relay-decision-controller.test.ts relay-callback.test.ts
```

Expected RED: CPU-gate routes/modules are missing and Decision DO still owns the grant-claims mapping.

- [ ] **Step 6: Implement minimum control plane**

Exact route set:

```text
GET  /internal/relay/v1/cpu-gate/quota
POST /internal/relay/v1/cpu-gate/setup
POST /internal/relay/v1/cpu-gate/operation-inspection
POST /internal/relay/v1/cpu-gate/reconcile-unused
```

Keep control routes internal and before generic callback action parsing.

Use the existing `QuotaController.admitRelay` transaction for setup. Never write DO storage directly.

Move the grant-claims mapping from `RelayDecisionController` into `relay-grant-claims.ts` and consume it from both call sites.

- [ ] **Step 7: Wire markers only at stable class boundaries**

Add supplementary start/finish markers without using them as correctness/CPU acceptance:

- ingress at the Responses relay entry/exit;
- decision callback transport;
- activation/renewal/terminal callback transport.

Do not add payload-derived fields.

- [ ] **Step 8: GREEN**

```bash
npm test -w apps/gateway-worker -- relay-cpu-gate.test.ts relay-observation.test.ts relay-auth.test.ts relay-decision-controller.test.ts relay-callback.test.ts
npm run typecheck -w apps/gateway-worker
```

Expected GREEN: all protected route/security/compensation tests pass.

- [ ] **Step 9: Commit boundary**

```bash
git add apps/gateway-worker/src/relay-cpu-gate.ts apps/gateway-worker/src/relay-grant-claims.ts apps/gateway-worker/src/relay-observation.ts apps/gateway-worker/src/relay-auth.ts apps/gateway-worker/src/relay-decision-controller.ts apps/gateway-worker/src/index.ts apps/gateway-worker/test/relay-cpu-gate.test.ts apps/gateway-worker/test/relay-observation.test.ts apps/gateway-worker/test/relay-auth.test.ts apps/gateway-worker/test/relay-decision-controller.test.ts apps/gateway-worker/test/relay-callback.test.ts
git commit -m "feat: add protected relay CPU gate control plane"
```

---

### Task 5: Build canonical CPU workload driver and evidence reducer

**Files:**
- Create: `scripts/relay-cpu-workloads.mjs`
- Create: `scripts/relay-cpu-workloads.test.mjs`
- Create: `scripts/relay-cpu-evidence.mjs`
- Create: `scripts/relay-cpu-evidence.test.mjs`
- Create: `scripts/run-relay-cpu-gate.mjs`
- Create: `scripts/run-relay-cpu-gate.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 4 CPU-gate HTTP contract; public `/v1/responses`; existing lifecycle callback routes; Cloudflare platform telemetry exported as protected JSONL.
- Produces:
  - `WORKLOAD_CLASSES = ["baseline-small","baseline-large","incident-regression-stream","incident-regression-nonstream"]`
  - `CONCURRENCIES = [1,2,3]`
  - `evaluateCpuSeries(records, expected): RelayCpuSeriesResult`
  - executable `npm run gate:relay-cpu -- ...`.

- [ ] **Step 1: Write RED workload tests**

Pin deterministic, synthetic builders:

- baseline-small: shallow history, no tools;
- baseline-large: representative 700 KiB-1 MiB request class;
- incident-regression-stream: only structural incident features, `stream=true`;
- incident-regression-nonstream: same structure, `stream=false`;
- no production prompt/response text or credential material.

The public ingress/decision fixture uses a runner-provided canary client key and the exact synthetic model string `octg-cpu-gate-reject-v1`. Before any measured series, one unmeasured preflight request must prove that this model receives the normal `model_requires_paid` rejection and creates no admission/grant. If it is enabled or produces any other outcome, the series is `BLOCKED / INCOMPLETE`; do not select a different model ad hoc.

- [ ] **Step 2: Write RED evidence-reducer tests**

For one exact series identity:

```text
stage
candidateScriptVersion
candidateSourceRevision
invocationClass
workloadClass
concurrency
windowStart
windowEnd
```

Assert:

- 499 successes => BLOCKED;
- p99 5/max 7/exceeded 0 => PASS;
- p99 >5 => FAIL;
- max >7 => FAIL;
- any `exceededCpu` => FAIL even without app marker;
- telemetry count mismatch => BLOCKED unless an observed CPU violation already makes it FAIL;
- wrong ScriptVersion => not counted and possibly BLOCKED;
- ambiguous route/classification => BLOCKED;
- overlapping required windows => harness rejects the run ledger before evaluation.

- [ ] **Step 3: Write RED runner serialization tests**

Pin:

- runner generates `req_<ULID>` before setup;
- only one non-terminal CPU-gate operation exists across both pools;
- ambiguous setup response -> inspect same request ID;
- not-found -> same setup request ID may be retried;
- live fixture -> reconcile-unused same ID then prove terminal before a new ID;
- lost/expired grant token does not prevent requestId-based recovery;
- compatibility-preflight operations are never counted as measurement samples.

- [ ] **Step 4: Run RED**

```bash
node --test scripts/relay-cpu-workloads.test.mjs scripts/relay-cpu-evidence.test.mjs scripts/run-relay-cpu-gate.test.mjs
```

Expected RED: files/exports do not exist.

- [ ] **Step 5: Implement the pure workload/evidence modules**

The reducer must not fetch Cloudflare APIs itself. It consumes a protected telemetry export so platform retrieval and series evaluation remain separable/auditable.

The runner writes only a protected run ledger containing safe identifiers/timestamps/counts. It never writes request bodies, grant tokens, client keys, or bearer values.

- [ ] **Step 6: Implement the driver modes**

Required modes:

```text
stage1
stage2-preflight
stage2-series
recover-operation
```

Stage 2 requests use the exact header:

```text
Cloudflare-Workers-Version-Overrides:
  <worker-name>="<candidate-version-id>"
```

and require the observed Worker version to equal the candidate before accepting a sample.

- [ ] **Step 7: GREEN**

```bash
node --test scripts/relay-cpu-workloads.test.mjs scripts/relay-cpu-evidence.test.mjs scripts/run-relay-cpu-gate.test.mjs
npm run test:scripts
```

Expected GREEN: pure reducer and runner-control tests pass without network access.

- [ ] **Step 8: Commit boundary**

```bash
git add scripts/relay-cpu-workloads.mjs scripts/relay-cpu-workloads.test.mjs scripts/relay-cpu-evidence.mjs scripts/relay-cpu-evidence.test.mjs scripts/run-relay-cpu-gate.mjs scripts/run-relay-cpu-gate.test.mjs package.json
git commit -m "feat: add relay CPU gate workload and evidence tooling"
```

---

### Task 6: Attribute the Production recurrence and execute the Stage 1 gate

**Files:**
- No source changes.
- Evidence output remains outside the repository except sanitized review/runbook summaries explicitly approved by the user.

**Interfaces:**
- Consumes: Tasks 1-5, exact candidate source revision, protected Preview environment, Cloudflare platform invocation telemetry.
- Produces: Production recurrence attribution plus Stage 1 PASS/FAIL/BLOCKED matrix that selects the Phase 2 branch.

- [ ] **Step 1: Record immutable candidate identity**

Record source SHA, Worker version/revision, harness fingerprint/version, workload definitions, and CPU threshold `5/7/0`.

- [ ] **Step 2: Attribute the historical/current Production CPU recurrence**

Using platform invocation records first and safe markers only as supplemental evidence, assign the recurrence to exactly one of:

```text
ingress
decision
activation
renewal
terminal
```

If attribution remains ambiguous, Issue #121 cannot close; record BLOCKED but Task 1 HMAC work remains valid.

- [ ] **Step 3: Run Stage 1 in isolated Preview/temporary resources**

Remote execution requires explicit authorization.

Run all required workload/concurrency series with >=500 successes per series and non-overlapping windows.

- [ ] **Step 4: Evaluate Stage 1**

Run the evidence reducer against platform telemetry. Expected outcomes:

- PASS: all required series satisfy 5/7/0 and completeness.
- lifecycle FAIL: any activation/renewal/terminal required series violates the gate -> proceed to Tasks 7-8, then rerun **all** Task 6 evidence.
- ingress/decision FAIL: STOP for a new reviewed remediation.
- BLOCKED: fix evidence collection only; do not weaken gate.

- [ ] **Step 5: Review boundary**

No commit is required for raw runtime evidence. Preserve only sanitized aggregates and exact version/window identifiers in the review record.

---

### Task 7 (conditional): Implement RelayGrantLifecycleController contract and trust-processing DO

**Condition:** Run only if Task 6 reports activation/renewal/terminal FAIL.

**Files:**
- Create: `apps/gateway-worker/src/relay-grant-lifecycle-controller.ts`
- Create: `apps/gateway-worker/test/relay-grant-lifecycle-controller.test.ts`
- Create: `scripts/relay-do-config.test.mjs`
- Modify: `apps/gateway-worker/src/index.ts`
- Modify: `apps/gateway-worker/test/env.d.ts`
- Modify: `apps/gateway-worker/wrangler.jsonc`

**Interfaces:**
- Consumes: Task 2 `RelayGrantLifecycleDispatchInput/Result`, `relayGrantLifecycleShardName`; existing grant verification/parsers; QuotaController lifecycle RPCs.
- Produces: `RelayGrantLifecycleController.dispatch(input): Promise<RelayGrantLifecycleDispatchResult>`.

- [ ] **Step 1: Write RED trust/routing tests**

Cover:

- invalid HMAC -> `protocol_error: invalid_context`;
- wrong environment/expired credential -> `invalid_context`;
- tampered unsigned requestId routing hint cannot authorize;
- own DO name must be exactly `relay-grant-lifecycle:v1:<environment>:<00..63>`;
- verified requestId shard mismatch -> `invalid_request`;
- invalid own name -> `internal_error`.

- [ ] **Step 2: Write RED action tests**

For activation/renewal/terminal:

- bounded raw body -> strict JSON parse in DO;
- action-specific parser and grantId/leaseGeneration binding;
- correct QuotaController identity from verified pool/day;
- existing denial/result semantics mapped into the exact dispatch union;
- QuotaController throw -> `internal_error`;
- no durable lifecycle state is written by the lifecycle DO itself.

- [ ] **Step 3: Write RED binding/migration test**

Create `scripts/relay-do-config.test.mjs` to parse `apps/gateway-worker/wrangler.jsonc` and require the exact Worker-local binding `RELAY_GRANT_LIFECYCLE_CONTROLLER -> RelayGrantLifecycleController`, no `namespace_id`, and append-only migration `v4` with `new_sqlite_classes: ["RelayGrantLifecycleController"]`. v1-v3 must remain unchanged and ordered before v4.

- [ ] **Step 4: Run RED**

```bash
npm test -w apps/gateway-worker -- relay-grant-lifecycle-controller.test.ts
node --test scripts/relay-do-config.test.mjs
```

Expected RED: class/export/binding/migration are missing.

- [ ] **Step 5: Implement minimum DO plus binding/migration**

The class may call QuotaController; it must not own grant/quota/idempotency/conflict state. Add the exact local binding and append-only v4 migration so the Cloudflare Vitest pool can instantiate the class. This repository change does not deploy the migration.

- [ ] **Step 6: GREEN**

```bash
npm test -w apps/gateway-worker -- relay-grant-lifecycle-controller.test.ts
node --test scripts/relay-do-config.test.mjs
npm run typecheck -w apps/gateway-worker
```

- [ ] **Step 7: Commit boundary**

```bash
git add apps/gateway-worker/src/relay-grant-lifecycle-controller.ts apps/gateway-worker/src/index.ts apps/gateway-worker/test/relay-grant-lifecycle-controller.test.ts apps/gateway-worker/test/env.d.ts apps/gateway-worker/wrangler.jsonc scripts/relay-do-config.test.mjs
git commit -m "feat: add relay grant lifecycle controller"
```

---

### Task 8 (conditional): Move lifecycle callbacks behind the DO and synchronize Preview routing

**Condition:** Run only after Task 7.

**Files:**
- Modify: `apps/gateway-worker/src/relay-callback.ts`
- Modify: `apps/gateway-worker/src/relay-auth.ts`
- Modify: `apps/gateway-worker/src/index.ts`
- Modify: `apps/gateway-worker/test/relay-callback.test.ts`
- Modify: `scripts/preview-worker-config.mjs`
- Modify: `scripts/preview-worker-config.test.mjs`
- Modify: `scripts/preview-workflow.test.mjs`

**Interfaces:**
- Consumes: Task 7 lifecycle DO.
- Produces: exact implementation-detail toggle `OCTG_RELAY_GRANT_LIFECYCLE_OFFLOAD`:
  - absent/`"false"` -> existing Worker-side lifecycle path;
  - `"true"` -> thin Worker transport + lifecycle DO dispatch;
  - any other value -> fail closed as invalid relay configuration.

This toggle is the only bridge/candidate normal-routing difference when Phase 2 is active.

- [ ] **Step 1: Write RED callback-boundary tests**

With offload=true prove Worker performs only:

```text
service bearer
method/path/content-type
header/body bound
unsigned requestId hint
lifecycle shard dispatch
HTTP response envelope
```

and does not call Worker-side grant HMAC verification or lifecycle JSON parsers.

With offload=false prove old callback behavior is byte/status compatible.

- [ ] **Step 2: Write RED Preview/bridge routing config tests**

Task 7 owns the exact Production binding and append-only v4 migration. This task proves Preview config includes the same class as a Preview-local binding with no Production namespace ID, preserves v1-v4 migration order, and enforces the offload toggle: absent/`false` keeps Worker-side lifecycle handling, `true` dispatches to the lifecycle DO, any other value fails closed.

- [ ] **Step 3: Run RED**

```bash
npm test -w apps/gateway-worker -- relay-callback.test.ts
node --test scripts/preview-worker-config.test.mjs scripts/preview-workflow.test.mjs
```

- [ ] **Step 4: Implement minimal offload path/config**

Do not remove the Worker-side path; the compatibility bridge needs it with offload=false.

- [ ] **Step 5: GREEN**

```bash
npm test -w apps/gateway-worker -- relay-callback.test.ts relay-grant-lifecycle-controller.test.ts
npm run typecheck -w apps/gateway-worker
node --test scripts/preview-worker-config.test.mjs scripts/preview-workflow.test.mjs scripts/deploy-production-workflow.test.mjs
```

- [ ] **Step 6: Commit boundary**

```bash
git add apps/gateway-worker/src/relay-callback.ts apps/gateway-worker/src/relay-auth.ts apps/gateway-worker/src/index.ts apps/gateway-worker/test/relay-callback.test.ts scripts/preview-worker-config.mjs scripts/preview-worker-config.test.mjs scripts/preview-workflow.test.mjs
git commit -m "feat: offload relay lifecycle callbacks conditionally"
```

- [ ] **Step 7: Rerun Task 6 from the beginning**

All prior Stage 1 evidence is invalid because implementation changed.

---

### Task 9: Generate and verify the Durable Object compatibility manifest

**Files:**
- Create: `scripts/do-compatibility-manifest.mjs`
- Create: `scripts/do-compatibility-manifest.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Worker source tree and Wrangler dry-run bundle.
- Produces deterministic `DoCompatibilityManifest` with `runtimeBundleSha256`, per-root `sourceClosureSha256`, file lists, and `contractSha256`.

Exact source roots:

```text
quota-controller:
  durable-objects/quota-controller/src/quota-controller.ts

quota-cpu-gate:
  durable-objects/quota-controller/src/relay-cpu-gate.ts

relay-grant-lifecycle:       # Phase 2 active only
  apps/gateway-worker/src/relay-grant-lifecycle-controller.ts
```

Exact type/contract roots included even when TypeScript erases them from runtime JavaScript:

```text
packages/shared/src/relay.ts
packages/shared/src/relay-routing.ts
```

- [ ] **Step 1: Write RED determinism/type-only tests**

Test that file-order changes do not change digests; runtime-helper changes affect the owning root; type-only RPC declaration changes affect `contractSha256`; unrelated docs/assets do not affect source-closure digests; inactive mode omits the lifecycle root; active mode includes it.

- [ ] **Step 2: Run RED**

```bash
node --test scripts/do-compatibility-manifest.test.mjs
```

Expected RED: manifest tool missing.

- [ ] **Step 3: Implement the runtime artifact digest**

Create a protected temporary directory and run exactly:

```bash
npx wrangler deploy --dry-run --outdir "$OUTDIR" --config apps/gateway-worker/wrangler.jsonc
```

Digest every regular file emitted under `$OUTDIR`, sorted by relative path, using `relativePath + NUL + fileBytes + NUL`. Delete the temporary directory in `finally`.

- [ ] **Step 4: Implement source-closure and contract digests**

Use the installed TypeScript Compiler API. Starting from each exact root, recursively follow static imports/re-exports including `import type` / `export type ... from`, resolve workspace `@octg/*` modules with TypeScript module resolution, reject unresolved repository imports, sort repo-relative paths, and digest exact source bytes.

Compute `contractSha256` over the union of complete source closures rooted at exactly `packages/shared/src/relay.ts` and `packages/shared/src/relay-routing.ts`. This is the mechanical check for type-only RPC contracts.

- [ ] **Step 5: Add the package command**

```json
"manifest:do-compat": "node scripts/do-compatibility-manifest.mjs"
```

Support only:

```text
--phase2=inactive
--phase2=active
--out=<path>
--help
```

Invalid mode, missing root, unresolved repository import, or output failure exits non-zero without a partial manifest.

- [ ] **Step 6: GREEN**

```bash
node --test scripts/do-compatibility-manifest.test.mjs
npm run manifest:do-compat -- --help
```

Expected GREEN: deterministic runtime/source digests and type-only contract sensitivity.

- [ ] **Step 7: Commit boundary**

```bash
git add scripts/do-compatibility-manifest.mjs scripts/do-compatibility-manifest.test.mjs package.json
git commit -m "build: add Durable Object compatibility manifest"
```

---

### Task 10: Implement bridge/candidate/hardening rollout tooling and make Production deployment fail-safe

**Files:**
- Create: `scripts/relay-cpu-rollout.mjs`
- Create: `scripts/relay-cpu-rollout.test.mjs`
- Modify: `.github/workflows/deploy-production.yml`
- Modify: `scripts/deploy-production-workflow.test.mjs`
- Modify: `scripts/preview-worker-config.mjs`
- Modify: `scripts/preview-worker-config.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Tasks 3-5 and optional Tasks 7-8; Task 9 manifest.
- Produces validated operator commands/modes:
  - `bridge`
  - `candidate-upload`
  - `candidate-deployment`
  - `preflight`
  - `promote`
  - `hardening-create`
  - `hardening-verify`
  - `hardening-promote`
  - `rollback-bridge`.

- [ ] **Step 1: Write RED command-construction tests**

Pin the non-interactive Wrangler command shapes:

```text
npx wrangler deploy
  --config apps/gateway-worker/wrangler.jsonc
  --keep-vars
  --strict
  --secrets-file <protected-bridge-secrets-file>

npx wrangler versions upload
  --config apps/gateway-worker/wrangler.jsonc
  --keep-vars
  --strict
  --secrets-file <protected-candidate-secrets-file>

npx wrangler versions deploy
  <bridge-id>@100%
  <candidate-id>@0%
  --config apps/gateway-worker/wrangler.jsonc
  --yes

npx wrangler versions secret delete
  OCTG_RELAY_CPU_GATE_AUTH_TOKEN
  --config apps/gateway-worker/wrangler.jsonc
```

The bridge secrets file contains the existing Production Worker secrets and no CPU-gate token. The candidate file contains the existing Production Worker secrets plus `OCTG_RELAY_CPU_GATE_AUTH_TOKEN`. Both are created as mode 0600 temporary files, are never printed, and are removed on every exit path.

Reject the non-versioned `wrangler secret delete` in this rollout. Do not place secret values in command arguments or logs.

- [ ] **Step 2: Write RED bridge/candidate config tests**

Phase 2 inactive:

- bridge and candidate share QuotaController CPU-gate code/contracts;
- no v4/lifecycle binding is required;
- bridge has control secret absent/disabled;
- candidate has control secret enabled.

Phase 2 active:

- bridge applies v4 and exports full lifecycle DO;
- bridge `OCTG_RELAY_GRANT_LIFECYCLE_OFFLOAD=false`;
- candidate `...=true`;
- same code artifact / exact DO compatibility manifest;
- candidate upload contains no new migration.

- [ ] **Step 3: Write RED workflow-safety tests**

The master Production workflow must not silently deploy the CPU-tested candidate directly to 100%.

Require a validated rollout mode/input or equivalent fail-closed staging path so the sequence is always:

```text
bridge 100%
candidate upload
bridge 100 / candidate 0
manual/authorized Stage 2
promotion
hardening
```

- [ ] **Step 4: Run RED**

```bash
node --test scripts/relay-cpu-rollout.test.mjs scripts/deploy-production-workflow.test.mjs scripts/preview-worker-config.test.mjs
```

- [ ] **Step 5: Implement rollout validation**

Before candidate upload, generate manifests from the exact bridge/candidate checked-out inputs and fail on any root, `contractSha256`, or runtime bundle digest mismatch. This implementation keeps the code artifact identical and expresses bridge/candidate routing differences only through versioned bindings/variables.

Before Stage 2 preflight, verify current deployment membership is exactly bridge 100% + candidate 0%.

Version override checks prove only incoming Worker ScriptVersion; do not claim they pin DO code.

- [ ] **Step 6: Implement exact compatibility-preflight closure**

The preflight driver must:

```text
fresh requestId
-> setup
-> operation-inspection fixture proof
-> required bridge/candidate control smoke
-> terminalize fixture
-> operation-inspection terminal proof / activeLease=false
-> only then permit Stage 2 series
```

Phase 2 inactive uses `reconcile-unused`. Phase 2 active accepts a normal settled lifecycle smoke or recovery `reconcile-unused`.

Preflight request IDs and invocations are excluded from measurement windows/counts.

The first Stage 2 measurement fixture MUST use a newly generated runner-owned `requestId` distinct from the compatibility-preflight `requestId`; the runner test must assert that the two IDs differ.

- [ ] **Step 7: GREEN**

```bash
node --test scripts/relay-cpu-rollout.test.mjs scripts/deploy-production-workflow.test.mjs scripts/preview-worker-config.test.mjs
npm run test:scripts
```

- [ ] **Step 8: Commit boundary**

```bash
git add scripts/relay-cpu-rollout.mjs scripts/relay-cpu-rollout.test.mjs .github/workflows/deploy-production.yml scripts/deploy-production-workflow.test.mjs scripts/preview-worker-config.mjs scripts/preview-worker-config.test.mjs package.json
git commit -m "feat: stage relay CPU compatibility rollout"
```

---

### Task 11: Synchronize operations documentation and run the complete local verification gate

**Files:**
- Modify: `docs/operations.md`
- Modify: `docs/deployment.md`
- Modify: `docs/configuration.md`
- Modify: `docs/troubleshooting-503-worker-resource-limits.md`

**Interfaces:**
- Consumes: Tasks 1-10.
- Produces: executable operator runbook with no new architectural choices.

- [ ] **Step 1: Replace the old Worker CPU acceptance gate**

Document exact required series and:

```text
p99 <= 5 ms
max <= 7 ms
exceededCpu = 0
>=500 successful invocations per series
complete telemetry
```

Remove any text that treats `p99 <= 8` / `max < 10` as current Issue #121 acceptance.

- [ ] **Step 2: Document the exact conditional path**

```text
HMAC cache
-> Stage 1
-> if lifecycle FAIL: lifecycle DO + full Stage 1 rerun
-> always compatibility bridge
-> candidate 0%
-> preflight terminalized
-> Stage 2
-> exact candidate promotion
-> versioned CPU-gate secret deletion
-> hardening bounded verification
```

- [ ] **Step 3: Document secrets and evidence retention**

Explicitly separate HMAC/service/CPU-gate credentials and state that raw runtime artifacts stay protected/temporary.

- [ ] **Step 4: Run all local verification**

```bash
npm run typecheck
npm test
npm run test:preview-workflow
npm run test:deno-deploy-workflow
git diff --check
```

If installed:

```bash
npx --no-install markdownlint-cli2 docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md docs/operations.md docs/deployment.md docs/configuration.md docs/troubleshooting-503-worker-resource-limits.md
```

Expected GREEN: zero failures.

- [ ] **Step 5: Commit boundary**

```bash
git add docs/operations.md docs/deployment.md docs/configuration.md docs/troubleshooting-503-worker-resource-limits.md
git commit -m "docs: add Worker CPU headroom rollout runbook"
```

---

### Task 12: Execute authorized Stage 2, exact-candidate rollout, and post-gate hardening

**Files:**
- No source changes.
- Runtime evidence remains outside the repository except explicitly approved sanitized review records.

**Interfaces:**
- Consumes: accepted Stage 1 evidence, compatibility bridge/candidate artifacts, Task 9 manifests, Task 10 rollout tool, Task 11 runbook.
- Produces: Stage 2 PASS and hardening verification needed to close Issue #121.

- [ ] **Step 1: Require explicit Production authorization**

Do not execute any remote command until the user/operator explicitly authorizes Production mutation and measurement.

- [ ] **Step 2: Deploy/verify compatibility bridge at 100%**

Phase 2 inactive: candidate-compatible QuotaController inspection RPCs, stable normal behavior.

Phase 2 active: same plus append-only v4/full lifecycle DO, offload false for normal bridge traffic.

Record bridge version ID and manifest.

- [ ] **Step 3: Upload CPU-tested candidate and create 100/0 deployment**

Use `wrangler versions upload`, then:

```text
bridge 100%
CPU-tested candidate 0%
```

Verify both are in the active deployment.

- [ ] **Step 4: Run compatibility preflight**

Require exact candidate ScriptVersion on incoming Worker and terminalize the preflight fixture before measurement begins.

If any preflight operation remains non-terminal, STOP as BLOCKED.

- [ ] **Step 5: Run Stage 2 matrix**

Run all canonical workload classes and concurrency 1/2/3 series, >=500 successes each, sequential/non-overlapping windows, no upstream model traffic for the 500-sample gate.

Evaluate with platform telemetry.

Any lifecycle FAIL after a prior Phase-2-inactive Stage 1 activates Tasks 7-8 and invalidates prior Stage 1/Stage 2 evidence; return to Task 6.

- [ ] **Step 6: Promote only the exact tested candidate**

If Stage 2 PASS, gradually promote the same ScriptVersion to 100%. Do not rebuild or delete the CPU-gate secret during this promotion.

Complete normal rollout acceptance.

- [ ] **Step 7: Prove all CPU-gate operations absent/terminal**

Use runner-owned operation IDs and canonical inspection. Do not use global quota-counter equality.

- [ ] **Step 8: Create the distinct hardening version**

Run:

```text
wrangler versions secret delete OCTG_RELAY_CPU_GATE_AUTH_TOKEN
```

Record the new ScriptVersion. Verify:

```text
source revision identical
runtime code artifact digest identical
DO compatibility manifest identical
compatibility settings identical
all non-CPU-gate bindings/secrets equivalent
only CPU-gate secret absent
```

- [ ] **Step 9: Run bounded hardening verification**

At 0% with version override verify:

```text
hardening ScriptVersion observed
all CPU-gate routes -> 404
normal relay configuration enabled
normal lifecycle service auth valid
one bounded ordinary Production Responses smoke succeeds
```

No full 500-sample rerun.

- [ ] **Step 10: Promote hardening or rollback**

PASS -> hardening 100%.

FAIL -> restore CPU-tested candidate 100%; Issue #121 remains open.

- [ ] **Step 11: Final evidence/review boundary**

Record only sanitized aggregates, version IDs, source SHA, manifest hashes, exact windows, and PASS/FAIL/BLOCKED outcomes. Do not retain credentials or payloads.

Issue #121 is close-eligible only when the design's complete completion criteria are satisfied.

---

## Plan self-review

### Spec coverage

- HMAC import reuse: Task 1.
- Exact shared lifecycle/control contracts and shard identity: Task 2.
- Read-only canonical quota inspection: Task 3.
- CPU-gate trust boundary, zero-reservation authoritative admission, signing compensation, grant-token-independent recovery: Task 4.
- Canonical workloads, >=500 sample series, 5/7/0 reducer, marker-less CPU failure handling: Task 5.
- Production recurrence attribution and Stage 1 branching: Task 6.
- Conditional lifecycle DO: Tasks 7-8.
- Always-required bridge and Worker/DO version skew: Tasks 9-10.
- Type-only + runtime DO equivalence: Task 9.
- Preflight terminalization/fresh measurement operation: Task 10.
- Operations/rollback/secret teardown: Tasks 11-12.
- Stage 2 exact candidate promotion and distinct hardening version: Task 12.

No spec section intentionally authorizes Workers Paid, direct DO storage mutation, D1 quota authority, public CPU-gate routes, or source implementation before this plan is separately reviewed.

### Type consistency

The exact names used by dependent tasks are declared in Task 2; Task 3 and Task 4 consume those names without aliases. The lifecycle class/binding remain exactly `RelayGrantLifecycleController` / `RELAY_GRANT_LIFECYCLE_CONTROLLER`. CPU-gate recovery remains `pool + requestId`, never grant-token-based.

### Proportion / task boundaries

The plan deliberately keeps remote evidence/deployment in Tasks 6 and 12 instead of mixing it into source tasks. Conditional Tasks 7-8 are the only Phase 2 implementation; they are skipped if Stage 1 lifecycle series pass.

