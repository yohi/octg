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
2. **CPU-gate ambiguous setup acknowledgement:** a lost setup response must be recoverable by the runner-owned request ID without creating a second live fixture. Task 4 owns route/recovery semantics; Task 5 owns runner retry/serialization tests; Task 6 executes the remote Stage 1 gate.
3. **Worker/DO gradual-deployment skew:** candidate Worker -> bridge-version QuotaController/lifecycle DO and bridge Worker -> candidate-version QuotaController must remain contract-compatible. Task 9 owns the compatibility manifest; Task 10 owns exact bridge/candidate version construction and rollout verification.
4. **Missing application marker on CPU kill:** `exceededCpu` platform records must still fail the series even when no application finish marker exists. Task 5 owns telemetry normalization/evidence-reducer tests; Task 6 executes the evidence gate.
5. **Post-gate secret teardown:** deleting only `OCTG_RELAY_CPU_GATE_AUTH_TOKEN` creates a distinct hardening ScriptVersion; all other code/config/DO contracts must remain equivalent. Task 9 owns manifest equivalence, Task 10 owns version/hardening tooling, and Task 12 performs the authorized remote teardown and verification.
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
| `scripts/relay-cpu-evidence.mjs` | Pure normalized platform-telemetry series classifier and PASS/FAIL/BLOCKED reducer. |
| `scripts/relay-cpu-telemetry.mjs` | Workers Observability REST API producer: exact-window invocation query, pagination/completeness checks, protected normalized JSONL. |
| `scripts/run-relay-cpu-gate.mjs` | Protected Stage 1/Stage 2 driver, runner-owned request IDs, one-operation serialization, candidate version override. |
| `scripts/do-compatibility-manifest.mjs` | Runtime bundle digest + type/source contract closure digest for bridge/candidate DO compatibility. |
| `scripts/relay-cpu-version-config.mjs` | Deterministically generate complete temporary Production bridge/candidate Wrangler configs from canonical non-secret inputs; never contains secret values. |
| `scripts/relay-cpu-rollout.mjs` | Validated bridge/candidate/hardening Wrangler command orchestration using generated exact version configs; no implicit production execution. |
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
Task 5  CPU workload / telemetry / evidence tooling
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
Task 10 exact Production version configs + bridge/candidate/hardening rollout
   |
Task 11 local full verification + operations documentation
   |
Task 12 authorized remote Stage 2 / promotion / hardening evidence
```

If Task 6 reports ingress or decision FAIL, STOP. Do not run Tasks 7-12 until a separately reviewed remediation changes that invocation class.

A **Stage 2 lifecycle FAIL discovered in Task 12 after a Phase-2-inactive Stage 1** is a full branch transition, not a simple jump back to Task 6:

```text
Task 12 lifecycle FAIL
  -> stop candidate rollout
  -> restore current compatibility bridge to 100%
  -> invalidate old Phase-2-inactive candidate/version/evidence/manifest/preflight artifacts
  -> Task 7
  -> Task 8
  -> rerun Task 6 completely
  -> rerun Task 9 with --phase2=active
  -> rerun Task 10 Phase-2-active config/rollout verification
  -> rerun Task 11 complete local verification
  -> restart Task 12 from compatibility-bridge creation
```

Old Phase-2-inactive bridge/candidate version IDs, manifests, preflight results, Stage 1 evidence, Stage 2 evidence, or local-verification results MUST NOT be reused after that transition.
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

### Task 5: Build canonical CPU workload, telemetry acquisition, and evidence tooling

**Files:**
- Create: `scripts/relay-cpu-workloads.mjs`
- Create: `scripts/relay-cpu-workloads.test.mjs`
- Create: `scripts/relay-cpu-telemetry.mjs`
- Create: `scripts/relay-cpu-telemetry.test.mjs`
- Create: `scripts/relay-cpu-evidence.mjs`
- Create: `scripts/relay-cpu-evidence.test.mjs`
- Create: `scripts/run-relay-cpu-gate.mjs`
- Create: `scripts/run-relay-cpu-gate.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 4 CPU-gate HTTP contract; public `/v1/responses`; existing lifecycle callback routes; Cloudflare Workers Observability REST API.
- Produces:
  - `WORKLOAD_CLASSES = ["baseline-small","baseline-large","incident-regression-stream","incident-regression-nonstream"]`
  - `CONCURRENCIES = [1,2,3]`
  - `fetchRelayCpuTelemetry(options): Promise<RelayCpuTelemetryExportResult>`
  - `evaluateCpuSeries(records, expected): RelayCpuSeriesResult`
  - executable `npm run gate:relay-cpu -- ...`
  - executable `npm run telemetry:relay-cpu -- ...`
  - protected normalized platform JSONL consumed by `relay-cpu-evidence.mjs`.

The only authoritative telemetry producer is the Workers Observability REST API endpoint:

```text
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/observability/telemetry/query
```

Authentication comes only from environment variables:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
```

The token is never accepted as a CLI argument or written to output.

- [ ] **Step 1: Write RED workload tests**

Pin deterministic, synthetic builders:

- baseline-small: shallow history, no tools;
- baseline-large: representative 700 KiB-1 MiB request class;
- incident-regression-stream: only structural incident features, `stream=true`;
- incident-regression-nonstream: same structure, `stream=false`;
- no production prompt/response text or credential material.

The public ingress/decision fixture uses a runner-provided canary client key and the exact synthetic model string `octg-cpu-gate-reject-v1`. Before any measured series, one unmeasured preflight request must prove that this model receives the normal `model_requires_paid` rejection and creates no admission/grant. If it is enabled or produces any other outcome, the series is `BLOCKED / INCOMPLETE`; do not select a different model ad hoc.

- [ ] **Step 2: Write RED telemetry-acquisition tests**

Define this exact normalized JSONL record:

```ts
interface RelayCpuPlatformRecord {
  readonly eventId: string;
  readonly eventTimestampMs: number;
  readonly scriptName: string;
  readonly scriptVersionId: string;
  readonly cpuTimeMs: number;
  readonly outcome: string;
  readonly eventType: string;
  readonly routeDiscriminator: string;
  readonly executionModel: "stateless";
  readonly requestId?: string;
}
```

The producer accepts exactly:

```text
scriptName
expectedScriptVersionId
windowStartMs
windowEndMs
expectedExecutionModel=stateless
outputPath
```

plus `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` from the environment.

Tests must pin:

- query `view="invocations"`;
- exact timeframe from `windowStartMs` through `windowEndMs`;
- dataset `cloudflare-workers`;
- server-side filters for the expected script plus, when exposed by the Observability keys API, exact ScriptVersion and `executionModel=stateless`;
- hard post-normalization requirements that `$workers.scriptName`, `$workers.scriptVersion.id`, and `$workers.executionModel` equal the expected values even if a server-side filter is unavailable;
- `cpuTimeMs` comes only from `$workers.cpuTimeMs`;
- `outcome` comes only from `$workers.outcome`;
- `eventTimestampMs` comes only from the platform event timestamp;
- `eventType` comes only from `$workers.eventType`;
- `routeDiscriminator` is the URL pathname from `$metadata.url`, or the path parsed from `$metadata.trigger` only when URL is absent;
- URL/trigger disagreement or an unassignable route is `BLOCKED`;
- `executionModel="durableObject"` is never normalized into the stateless gate;
- `outcome="exceededCpu"` is retained even when no application finish marker exists;
- missing `cpuTimeMs`, ScriptVersion, outcome, event timestamp, script name, or execution model on an in-scope invocation is `BLOCKED`;
- any in-scope platform record with `$workers.truncated=true` is `BLOCKED`;
- exact duplicate `eventId` records are deterministically de-duplicated once; conflicting duplicates are `BLOCKED`;
- HTTP/API failure, `success=false`, malformed response, or query parse failure is `BLOCKED`.

Pagination is exact:

```text
limit=2000
offset=<last returned $metadata.id>
offsetDirection=next
```

Continue until a subsequent page returns zero new invocation events. A non-empty page without a usable final `$metadata.id`, repeated cursor, or any state where complete retrieval cannot be proven is `BLOCKED`. The producer post-filters timestamps to `windowStartMs <= timestamp < windowEndMs` so adjacent series cannot share one boundary event.

The protected output file is created mode `0600`; raw API responses are not committed.

- [ ] **Step 3: Write RED evidence-reducer tests**

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

Route mapping is exact:

```text
/v1/responses                        -> ingress
/internal/relay/v1/decision          -> decision
/internal/relay/v1/activation        -> activation
/internal/relay/v1/renewal           -> renewal
/internal/relay/v1/terminal          -> terminal
```

Assert:

- 499 successes => BLOCKED;
- p99 5/max 7/exceeded 0 => PASS;
- p99 >5 => FAIL;
- max >7 => FAIL;
- any `exceededCpu` => FAIL even without app marker;
- telemetry count mismatch => BLOCKED unless an observed CPU violation already makes it FAIL;
- wrong ScriptVersion => rejected/not counted and completeness may become BLOCKED;
- missing/ambiguous route classification => BLOCKED;
- overlapping required windows => harness rejects the run ledger before evaluation;
- application `octg.relay_invocation` markers may enrich attribution but are never required for a normalized platform record and never turn incomplete platform telemetry into PASS.

- [ ] **Step 4: Write RED runner serialization tests**

Pin:

- runner generates `req_<ULID>` before setup;
- only one non-terminal CPU-gate operation exists across both pools;
- ambiguous setup response -> inspect same request ID;
- not-found -> same setup request ID may be retried;
- live fixture -> reconcile-unused same ID then prove terminal before a new ID;
- lost/expired grant token does not prevent requestId-based recovery;
- compatibility-preflight operations are never counted as measurement samples.

- [ ] **Step 5: Run RED**

```bash
node --test \
  scripts/relay-cpu-workloads.test.mjs \
  scripts/relay-cpu-telemetry.test.mjs \
  scripts/relay-cpu-evidence.test.mjs \
  scripts/run-relay-cpu-gate.test.mjs
```

Expected RED: files/exports do not exist.

- [ ] **Step 6: Implement workload, telemetry, and evidence modules**

`relay-cpu-telemetry.mjs` performs the programmatic Observability query and normalization; `relay-cpu-evidence.mjs` remains pure and performs no network access.

The driver writes only a protected run ledger containing safe identifiers/timestamps/counts. It never writes request bodies, grant tokens, client keys, API tokens, or bearer values.

- [ ] **Step 7: Implement the driver modes**

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

- [ ] **Step 8: Add executable package commands**

```json
"gate:relay-cpu": "node scripts/run-relay-cpu-gate.mjs",
"telemetry:relay-cpu": "node scripts/relay-cpu-telemetry.mjs"
```

The telemetry CLI accepts identifiers/window/output path only; credentials remain environment-only.

- [ ] **Step 9: GREEN**

```bash
node --test \
  scripts/relay-cpu-workloads.test.mjs \
  scripts/relay-cpu-telemetry.test.mjs \
  scripts/relay-cpu-evidence.test.mjs \
  scripts/run-relay-cpu-gate.test.mjs
npm run test:scripts
```

Expected GREEN: workload, mocked-API telemetry normalization/pagination, pure reducer, and runner-control tests pass without live network access.

- [ ] **Step 10: Commit boundary**

```bash
git add \
  scripts/relay-cpu-workloads.mjs scripts/relay-cpu-workloads.test.mjs \
  scripts/relay-cpu-telemetry.mjs scripts/relay-cpu-telemetry.test.mjs \
  scripts/relay-cpu-evidence.mjs scripts/relay-cpu-evidence.test.mjs \
  scripts/run-relay-cpu-gate.mjs scripts/run-relay-cpu-gate.test.mjs \
  package.json
git commit -m "feat: add relay CPU gate telemetry and evidence tooling"
```


### Task 6: Attribute the Production recurrence and execute the Stage 1 gate

**Files:**
- No source changes.
- Evidence output remains outside the repository except sanitized review/runbook summaries explicitly approved by the user.

**Interfaces:**
- Consumes: Tasks 1-5, exact candidate source revision, protected Preview environment, Workers Observability REST API.
- Produces: Production recurrence attribution plus Stage 1 PASS/FAIL/BLOCKED matrix that selects the Phase 2 branch.

- [ ] **Step 1: Require explicit telemetry authorization and record immutable candidate identity**

Remote Worker execution **and** Workers Observability API queries require explicit authorization for this task.

Record source SHA, Worker version/revision, harness fingerprint/version, workload definitions, and CPU threshold `5/7/0`.

- [ ] **Step 2: Attribute the historical/current Production CPU recurrence**

Using normalized platform invocation records first and safe markers only as supplemental evidence, assign the recurrence to exactly one of:

```text
ingress
decision
activation
renewal
terminal
```

The executable acquisition sequence is:

```bash
umask 077
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...

npm run telemetry:relay-cpu -- \
  --script-name=<production-worker-name> \
  --script-version=<known-production-version-id> \
  --window-start-ms=<closed-window-start> \
  --window-end-ms=<closed-window-end> \
  --execution-model=stateless \
  --out=<protected-attribution-jsonl>
```

If complete retrieval cannot be proven, a required field is absent, or attribution remains ambiguous, record `BLOCKED / INCOMPLETE`; Issue #121 cannot close.

- [ ] **Step 3: Run Stage 1 in isolated Preview/temporary resources**

Remote execution requires explicit authorization.

Run one required workload/concurrency series at a time. For each series the runner records an exact non-overlapping half-open window `[windowStartMs, windowEndMs)`, expected attempt/success counts, candidate ScriptVersion, workload class, invocation class, and concurrency.

- [ ] **Step 4: Acquire authoritative platform telemetry immediately after each closed series**

For every series:

```bash
npm run telemetry:relay-cpu -- \
  --script-name=<stage1-worker-name> \
  --script-version=<candidate-version-id> \
  --window-start-ms=<series-window-start> \
  --window-end-ms=<series-window-end> \
  --execution-model=stateless \
  --out=<protected-series-jsonl>
```

No raw telemetry file is added to Git. Query/API failure, incomplete pagination, truncation, missing required platform fields, or missing expected records makes that series `BLOCKED / INCOMPLETE`.

- [ ] **Step 5: Evaluate each Stage 1 series**

Run:

```bash
node scripts/relay-cpu-evidence.mjs \
  --ledger=<protected-run-ledger> \
  --telemetry=<protected-series-jsonl> \
  --out=<protected-series-summary>
```

Expected outcomes:

- PASS: all required series satisfy 5/7/0, >=500 successful invocations, and complete authoritative telemetry.
- lifecycle FAIL: any activation/renewal/terminal required series violates the gate -> proceed to Tasks 7-8, then rerun **all** Task 6 evidence.
- ingress/decision FAIL: STOP for a separately reviewed remediation; do not enable lifecycle offload.
- BLOCKED: repair evidence acquisition only; do not weaken the gate.

- [ ] **Step 6: Review boundary**

Preserve only sanitized aggregates, exact ScriptVersion/source SHA, manifest/harness identifiers, and exact windows in the review record. Protected normalized JSONL/raw API material remains temporary and is never committed.


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
- Consumes: Worker source tree plus an explicit Wrangler config path representing the exact bridge or candidate effective non-secret configuration.
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
npx wrangler deploy --dry-run --outdir "$OUTDIR" --config "$WRANGLER_CONFIG"
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
--config=<exact-generated-wrangler-config>
--out=<path>
--help
```

`--config` is mandatory except for `--help`; the manifest tool must never silently fall back to `apps/gateway-worker/wrangler.jsonc`.

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

### Task 10: Implement exact Production version configuration and bridge/candidate/hardening rollout tooling

**Files:**
- Create: `scripts/relay-cpu-version-config.mjs`
- Create: `scripts/relay-cpu-version-config.test.mjs`
- Create: `scripts/relay-cpu-rollout.mjs`
- Create: `scripts/relay-cpu-rollout.test.mjs`
- Modify: `.github/workflows/deploy-production.yml`
- Modify: `scripts/deploy-production-workflow.test.mjs`
- Modify: `scripts/preview-worker-config.mjs`
- Modify: `scripts/preview-worker-config.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Tasks 3-5 and optional Tasks 7-8; Task 9 manifest; canonical Production non-secret inputs.
- Produces:
  - `buildRelayCpuProductionVersionConfigs(baseConfig, productionInputs, phase2)`
  - protected temporary `bridge-wrangler.json`
  - protected temporary `candidate-wrangler.json`
  - validated rollout modes: `bridge`, `candidate-upload`, `candidate-deployment`, `preflight`, `promote`, `hardening-create`, `hardening-verify`, `hardening-promote`, `rollback-bridge`.

### Exact version-configuration construction

The implementation is fixed to one mechanism:

```text
apps/gateway-worker/wrangler.jsonc
        +
canonical Production non-secret inputs
        |
        +--> temporary bridge Wrangler config
        |
        +--> temporary candidate Wrangler config
```

`relay-cpu-version-config.mjs` parses the repository base config, copies required invariant bindings/migrations/compatibility settings, and creates **complete** effective Production `vars` maps. It never copies a secret value into either config.

Required base-config invariants that must exist and be preserved exactly:

```text
QUOTA_LIMIT_STANDARD
QUOTA_LIMIT_MINI
MAX_IN_FLIGHT_REQUESTS
IN_FLIGHT_LEASE_TTL_MS
IN_FLIGHT_LEASE_RENEWAL_MS
OCTG_UPSTREAM_BASE_URL
ACCESS_TEAM_DOMAIN
ACCESS_AUD
durable_objects bindings
migrations
compatibility_date
compatibility_flags
observability
```

Required explicit Production inputs, sourced by the Production workflow/operator and rejected when absent/empty:

```text
OCTG_RELAY_ENABLED
MAX_INPUT_BYTES
DENO_TOKENIZER_ENDPOINT
DENO_TOKENIZER_THRESHOLD_BYTES
DENO_TOKENIZER_TIMEOUT_MS
DENO_PREPARE_ENDPOINT
DENO_PREPARE_THRESHOLD_BYTES
OCTG_RELAY_INGRESS_ENDPOINT
OCTG_RELAY_CPU_GATE_STANDARD_CLIENT_ID
OCTG_RELAY_CPU_GATE_STANDARD_MODEL
OCTG_RELAY_CPU_GATE_MINI_CLIENT_ID
OCTG_RELAY_CPU_GATE_MINI_MODEL
```

The generator always writes:

```text
OCTG_RELAY_ENVIRONMENT=production
```

and never accepts `OCTG_RELAY_ENVIRONMENT` as caller-controlled input.

Phase 2 inactive:

```text
bridge normal-routing vars == candidate normal-routing vars
OCTG_RELAY_GRANT_LIFECYCLE_OFFLOAD absent in both
```

Phase 2 active:

```text
bridge:
  OCTG_RELAY_GRANT_LIFECYCLE_OFFLOAD=false

candidate:
  OCTG_RELAY_GRANT_LIFECYCLE_OFFLOAD=true
```

That offload variable is the **only normal-routing var difference** between bridge and candidate in Phase 2 active.

The separate trust-class difference remains:

```text
bridge:
  OCTG_RELAY_CPU_GATE_AUTH_TOKEN absent from secrets file

candidate:
  OCTG_RELAY_CPU_GATE_AUTH_TOKEN present in secrets file
```

No secret value is ever written into generated Wrangler config.

- [ ] **Step 1: Write RED exact-config tests**

Prove:

```text
bridge OCTG_RELAY_ENVIRONMENT == production
candidate OCTG_RELAY_ENVIRONMENT == production
all required Production vars are present
base quota/max-in-flight/lease/upstream/access settings are preserved
all DO bindings/migrations/compatibility settings are exact
no Preview environment/value can survive into a Production version
missing required Production input fails before file creation

Phase 2 inactive:
  bridge/candidate normal vars are byte-for-byte equal

Phase 2 active:
  bridge/candidate normal vars differ only by offload=false/true

secret sentinel values never appear in generated config
secret sentinel values never appear in command arguments
```

Also assert generated files are mode `0600`, written only under a protected temporary directory, and removed on every success/failure exit path.

- [ ] **Step 2: Write RED command-construction tests**

Pin these exact config-driven command shapes; **do not use `--keep-vars`**:

```text
npx wrangler deploy
  --config <bridge-config>
  --strict
  --secrets-file <protected-bridge-secrets-file>

npx wrangler versions upload
  --config <candidate-config>
  --strict
  --secrets-file <protected-candidate-secrets-file>

npx wrangler versions deploy
  <bridge-id>@100%
  <candidate-id>@0%
  --config <candidate-config>
  --yes

npx wrangler versions secret delete
  OCTG_RELAY_CPU_GATE_AUTH_TOKEN
  --config <candidate-config>
```

The bridge secrets file contains the existing Production Worker secrets and no CPU-gate token. The candidate file contains the existing Production Worker secrets plus `OCTG_RELAY_CPU_GATE_AUTH_TOKEN`. Both are mode `0600`, are never printed, and are deleted on every exit path.

Reject:

- non-versioned `wrangler secret delete`;
- any `--keep-vars` dependency in Issue #121 bridge/candidate construction;
- secret values in command arguments/logs;
- repository base config used directly as a Production bridge/candidate upload config.

- [ ] **Step 3: Write RED bridge/candidate compatibility tests**

Phase 2 inactive:

- bridge/candidate share QuotaController CPU-gate code/contracts;
- no v4/lifecycle binding is required;
- normal non-secret configuration is exact/equal;
- bridge CPU-gate secret absent, candidate CPU-gate secret present.

Phase 2 active:

- bridge applies v4 and exports full lifecycle DO;
- bridge offload=false, candidate offload=true;
- every other normal-routing var/binding/compatibility setting is exact/equal;
- candidate upload contains no new migration.

Generate manifests from the **exact generated configs**:

```bash
npm run manifest:do-compat -- \
  --phase2=<inactive|active> \
  --config=<bridge-config> \
  --out=<bridge-manifest>

npm run manifest:do-compat -- \
  --phase2=<inactive|active> \
  --config=<candidate-config> \
  --out=<candidate-manifest>
```

Fail before candidate upload on any applicable source-root/`contractSha256` mismatch. Runtime bundle code digest must also match; config-only routing differences do not authorize different Worker code.

- [ ] **Step 4: Write RED workflow-safety tests**

The Production workflow must source every explicit Production input above from its existing GitHub Environment/Variables contract, invoke the version-config generator, and never silently deploy the CPU-tested candidate directly to 100%.

Required sequence:

```text
generate exact bridge/candidate configs
-> bridge 100%
-> candidate upload
-> bridge 100 / candidate 0
-> manual/authorized Stage 2
-> exact candidate promotion
-> hardening
```

- [ ] **Step 5: Run RED**

```bash
node --test \
  scripts/relay-cpu-version-config.test.mjs \
  scripts/relay-cpu-rollout.test.mjs \
  scripts/deploy-production-workflow.test.mjs \
  scripts/preview-worker-config.test.mjs
```

Expected RED: exact Production version generator/rollout contracts do not exist.

- [ ] **Step 6: Implement exact config generation and rollout validation**

Before bridge deployment/candidate upload:

1. generate protected bridge/candidate configs;
2. validate their effective vars/bindings/migrations;
3. generate Task 9 manifests using those exact config files;
4. prove required equivalence/differences;
5. only then construct remote Wrangler commands.

Before Stage 2 preflight, verify active deployment membership is exactly bridge 100% + candidate 0%.

Version override checks prove only incoming Worker ScriptVersion; do not claim they pin DO code.

- [ ] **Step 7: Implement exact compatibility-preflight closure**

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

- [ ] **Step 8: GREEN**

```bash
node --test \
  scripts/relay-cpu-version-config.test.mjs \
  scripts/relay-cpu-rollout.test.mjs \
  scripts/deploy-production-workflow.test.mjs \
  scripts/preview-worker-config.test.mjs
npm run test:scripts
```

- [ ] **Step 9: Commit boundary**

```bash
git add \
  scripts/relay-cpu-version-config.mjs scripts/relay-cpu-version-config.test.mjs \
  scripts/relay-cpu-rollout.mjs scripts/relay-cpu-rollout.test.mjs \
  .github/workflows/deploy-production.yml scripts/deploy-production-workflow.test.mjs \
  scripts/preview-worker-config.mjs scripts/preview-worker-config.test.mjs \
  package.json
git commit -m "feat: stage exact relay CPU Production versions"
```


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

- [ ] **Step 3: Document exact version construction, telemetry acquisition, secrets, and evidence retention**

Document:

- `relay-cpu-version-config.mjs` as the only Issue #121 bridge/candidate Production config constructor;
- complete Production non-secret var construction and forced `OCTG_RELAY_ENVIRONMENT=production`;
- Workers Observability REST query endpoint, environment-only API authentication, pagination/completeness rules, normalized platform JSONL, and reducer command order;
- HMAC/service/CPU-gate credential separation;
- raw platform responses, normalized JSONL, run ledgers, and credentials as protected temporary artifacts that are never committed.

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
- Consumes: accepted Stage 1 evidence, exact generated bridge/candidate configs, compatibility manifests, Task 10 rollout tool, Task 11 runbook.
- Produces: Stage 2 PASS and hardening verification needed to close Issue #121.

- [ ] **Step 1: Require explicit Production mutation and telemetry authorization**

Do not execute any remote mutation, measured request, or Workers Observability API query until the user/operator explicitly authorizes it.

Create protected temporary config/secrets/evidence directories with `umask 077`.

- [ ] **Step 2: Generate exact configs and deploy/verify compatibility bridge at 100%**

Regenerate the bridge/candidate configs from canonical current Production inputs immediately before remote use.

Phase 2 inactive: candidate-compatible QuotaController inspection RPCs, stable normal behavior.

Phase 2 active: same plus append-only v4/full lifecycle DO, offload=false for normal bridge traffic.

Generate/verify the bridge manifest from the exact bridge config, deploy that bridge config, then record bridge ScriptVersion ID and manifest hash.

- [ ] **Step 3: Upload the CPU-tested candidate from the exact candidate config and create 100/0 deployment**

Generate/verify the candidate manifest from the exact candidate config and require Task 10 equivalence rules.

Then:

```text
bridge 100%
CPU-tested candidate 0%
```

Verify both exact version IDs are in the active deployment before preflight.

- [ ] **Step 4: Run compatibility preflight**

Require exact candidate ScriptVersion on incoming Worker and terminalize the preflight fixture before measurement begins.

If any preflight operation remains non-terminal, STOP as `BLOCKED / INCOMPLETE`.

The first measured Stage 2 fixture uses a fresh runner-owned requestId distinct from preflight.

- [ ] **Step 5: Run each Stage 2 series and acquire authoritative telemetry**

For every canonical workload/invocation-class/concurrency series:

1. run exactly one measured series;
2. close and record the exact half-open window `[windowStartMs, windowEndMs)`;
3. query Workers Observability with `scripts/relay-cpu-telemetry.mjs` for the candidate ScriptVersion and `executionModel=stateless`;
4. write protected normalized JSONL;
5. run `relay-cpu-evidence.mjs`;
6. record PASS / FAIL / BLOCKED before starting the next non-overlapping series.

Executable acquisition/evaluation shape:

```bash
npm run telemetry:relay-cpu -- \
  --script-name=<production-worker-name> \
  --script-version=<candidate-version-id> \
  --window-start-ms=<series-window-start> \
  --window-end-ms=<series-window-end> \
  --execution-model=stateless \
  --out=<protected-series-jsonl>

node scripts/relay-cpu-evidence.mjs \
  --ledger=<protected-run-ledger> \
  --telemetry=<protected-series-jsonl> \
  --out=<protected-series-summary>
```

No upstream model traffic is generated by the 500-sample CPU matrix.

If telemetry pagination/completeness cannot be proven, the series is BLOCKED; do not infer PASS from driver success.

- [ ] **Step 6: Apply the exact Stage 2 failure transition**

If **ingress or decision** FAIL:

```text
STOP
-> do not enable lifecycle offload
-> separately reviewed remediation required
```

If **activation, renewal, or terminal** FAIL while the current branch is Phase 2 inactive:

```text
STOP candidate rollout
-> restore/verify current compatibility bridge at 100%
-> invalidate old Phase-2-inactive candidate ScriptVersion
-> invalidate old Phase-2-inactive Stage 1 and Stage 2 evidence
-> invalidate old bridge/candidate compatibility manifests
-> invalidate old compatibility-preflight artifacts/results
-> invalidate old Task 11 local-verification result
-> Task 7
-> Task 8
-> rerun Task 6 completely from fresh Stage 1 evidence
-> rerun Task 9 with --phase2=active
-> rerun Task 10 using new Phase-2-active bridge/candidate configs
-> rerun Task 11 complete local verification gate
-> restart Task 12 from Step 2
```

The restarted remote sequence is necessarily new:

```text
new Phase-2-active compatibility bridge
  -> apply v4
  -> new bridge 100%
  -> new CPU-tested candidate upload
  -> new bridge 100 / new candidate 0
  -> new compatibility preflight
  -> new Stage 2
```

The old Phase-2-inactive bridge version ID, candidate version ID, manifests, preflight result, Stage 1 evidence, Stage 2 evidence, and local-verification result are forbidden inputs to the Phase-2-active rollout.

If Phase 2 is already active and a lifecycle series still FAILs, STOP for a separately reviewed remediation; do not loosen the CPU gate or add another authority layer.

- [ ] **Step 7: Promote only the exact tested candidate**

Only after every Stage 2 series PASS, gradually promote the same tested candidate ScriptVersion to 100%.

Do not rebuild, change generated normal-routing config, or delete the CPU-gate secret during this promotion.

- [ ] **Step 8: Prove all CPU-gate operations absent/terminal**

Use runner-owned operation IDs and canonical inspection. Do not use global quota-counter equality.

- [ ] **Step 9: Create the distinct hardening version**

Run the Task 10 versioned-secret operation against the exact tested candidate version/config:

```text
wrangler versions secret delete OCTG_RELAY_CPU_GATE_AUTH_TOKEN
```

Record the new ScriptVersion. Verify:

```text
source revision identical
runtime code artifact digest identical
DO compatibility manifest identical
compatibility settings identical
complete normal non-secret Production configuration identical
all non-CPU-gate secrets equivalent
only OCTG_RELAY_CPU_GATE_AUTH_TOKEN absent
```

- [ ] **Step 10: Run bounded hardening verification**

At 0% with version override verify:

```text
hardening ScriptVersion observed
all CPU-gate routes -> 404
normal relay configuration remains enabled
normal lifecycle service auth remains valid
one bounded ordinary Production Responses relay smoke succeeds
```

No full 500-sample rerun.

- [ ] **Step 11: Promote hardening or rollback**

PASS -> hardening 100%.

FAIL -> restore the CPU-tested candidate 100%; Issue #121 remains open.

- [ ] **Step 12: Final evidence/review boundary**

Record only sanitized aggregates, version IDs, source SHA, manifest hashes, exact windows, and PASS/FAIL/BLOCKED outcomes. Delete protected raw API responses/normalized JSONL/config/secrets temporary artifacts according to the runbook.

Issue #121 is close-eligible only when the design's complete completion criteria are satisfied.


## Plan self-review

### Spec coverage

- HMAC import reuse: Task 1.
- Exact shared lifecycle/control contracts and shard identity: Task 2.
- Read-only canonical quota inspection: Task 3.
- CPU-gate trust boundary, zero-reservation authoritative admission, signing compensation, grant-token-independent recovery: Task 4.
- Canonical workloads, Workers Observability acquisition/normalization, >=500 sample series, 5/7/0 reducer, marker-less CPU failure handling: Task 5.
- Production recurrence attribution and executable Stage 1 telemetry/evidence sequence: Task 6.
- Conditional lifecycle DO: Tasks 7-8.
- Always-required bridge and Worker/DO version skew: Task 9 manifest plus Task 10 exact Production version construction/rollout.
- Type-only + runtime DO equivalence: Task 9.
- Preflight terminalization/fresh measurement operation: Task 10.
- Operations, exact telemetry/version-config runbook, rollback, and secret teardown: Tasks 11-12.
- Stage 2 exact candidate promotion, full Phase-2-active restart after lifecycle FAIL, and distinct hardening version: Task 12.

No spec section intentionally authorizes Workers Paid, direct DO storage mutation, D1 quota authority, public CPU-gate routes, or source implementation before this plan is separately reviewed.

### Type consistency

The exact names used by dependent tasks are declared in Task 2; Task 3 and Task 4 consume those names without aliases. The lifecycle class/binding remain exactly `RelayGrantLifecycleController` / `RELAY_GRANT_LIFECYCLE_CONTROLLER`. CPU-gate recovery remains `pool + requestId`, never grant-token-based.

### Proportion / task boundaries

The plan deliberately keeps remote evidence/deployment in Tasks 6 and 12 instead of mixing it into source tasks. Task 5 implements the telemetry producer/reducer seam; Task 10 implements deterministic Production version construction. Conditional Tasks 7-8 are the only Phase 2 implementation; they are skipped if Stage 1 lifecycle series pass. A later Stage 2 lifecycle FAIL explicitly invalidates the Phase-2-inactive artifacts and requires Tasks 7-11 to be replayed in the documented order before Task 12 restarts.

