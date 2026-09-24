<!-- markdownlint-disable MD013 MD032 -->

# Free-Worker Deno Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Deno-prepared Responses requests through Deno to Gateway B while keeping quota authorization and settlement in QuotaController and Cloudflare Workers on the Free plan; keep the stateless Free Worker decision callback within its mandatory CPU gate by moving decision orchestration to a Cloudflare-side `RelayDecisionController` DO.

**Architecture:** The ingress Worker authenticates, creates `req_${ulid()}`, signs context and streams each original request once to Deno. Deno normalizes and tokenizes, then calls the unchanged authenticated Worker `/decision` callback with bounded metadata and opaque context. That stateless callback performs only bounded transport/authentication and routes by an unverified request-ID shard hint to `RelayDecisionController`; the DO verifies trust, applies policy/model/budget, and calls one atomic `QuotaController.admitRelay` RPC. QuotaController remains the only quota/grant-state authority. Deno then activates the one-use grant, forwards once to Gateway B, and reports usage through the existing Worker callback paths; Worker relays response bytes unchanged. The old `/prepare` route remains available until the revised relay passes measured gates.

**Tech Stack:** Strict TypeScript, Cloudflare Workers and SQLite-backed Durable Objects, Deno Deploy, Vitest, Deno test runner, npm workspaces, GitHub Actions.

**Spec:** [Free-Worker Responses Relay Through Deno](../specs/2026-09-23-free-worker-deno-relay-design.md).

**Execution status: FAIL — decision callback CPU feasibility.** Task 0 was executed on 2026-09-23. The stateless decision callback recorded p99/max CPU of 19 ms, violating the 8/10 ms gate. The sanitized evidence is in the Design. This Plan revision is documentation-only and awaits Fresh Superpowers Review Gate approval. Do not start Tasks 1–8. After review approval and separate explicit remote-measurement authorization, Task 0 must be rerun in full for the revised architecture; Tasks 1–8 remain blocked until that complete rerun passes and its evidence is accepted.

**Review findings:** RG-001 remains unresolved because the measured architecture failed. RG-002 through RG-007 remain resolved and are preserved; reopen none without a concrete regression introduced by this revision.

## Global Constraints

- Cloudflare Workers Paid is not an option; the per-HTTP-invocation Free CPU allowance is 10 ms.
- Production `MAX_INPUT_BYTES` remains `1048576`; Preview and Production control planes remain separate.
- QuotaController is the only quota authority; D1 is audit-only and cannot gate admission.
- The public `/v1/responses` contract and the current `/prepare` rollback route remain available.
- No retry of an upstream request after grant activation; ambiguous attempts retain quota conservatively.
- Never log client keys, signing or service secrets, nonces, prompts, request/response bodies or Gateway B credentials.
- Avoid touching the existing untracked `deno.lock` unless ownership is explicitly established.
- Git commits, remote deployment, and any remote runtime measurement require separate explicit user authorization; task completion does not authorize them.
- Every Task completion boundary is local and does not itself authorize a Git commit. Commit only after explicit authorization for that commit; never push as part of a task without explicit push authorization.

---

## File and interface map

| File | Responsibility |
| --- | --- |
| `SPEC.md` | Canonical wire, routing, admission transaction and failure contract, updated in Task 1 before runtime behavior. |
| `packages/shared/src/relay.ts` | Exact v1 wire types, stable error union, strict parsers/byte bounds, and the Cloudflare-internal `RelayDecisionDispatchInput`/`RelayDecisionDispatchResult` RPC types from the Design. |
| `packages/shared/src/index.ts` | Export the relay contract. |
| `packages/shared/src/relay-credential.ts` | Canonical JSON and compact HMAC context/grant sign/verify primitives. Ingress Worker signs context; RelayDecisionController verifies context/signs grants; Deno has no key capability. |
| `apps/gateway-worker/src/relay-auth.ts` | Environment validation, ingress context signer and Worker callback grant verifier. |
| `apps/gateway-worker/src/relay-callback.ts` | Thin bounded internal callback transport; dispatch decision to the Decision DO and preserve existing Worker activation/renewal/terminal ownership. |
| `apps/gateway-worker/src/relay-decision-controller.ts` | SQLite-backed `RelayDecisionController`: verify context/key binding, read policy/model state, calculate admission, call one QuotaController RPC and sign grant; no quota ledger. |
| `apps/gateway-worker/test/relay-decision-controller.test.ts` | Routing-hint tamper/replay, context verification, policy/budget and admission RPC outcome tests. |
| `apps/gateway-worker/src/relay-client.ts` | One-pass client-body relay and Deno response mapping. |
| `apps/gateway-worker/src/index.ts` | Export DO classes, register callbacks before public routes, and define isolated relay/Decision DO bindings in `Env`. |
| `apps/gateway-worker/src/proxy.ts` | Opt-in Responses routing before legacy prepare branch; leave Chat and legacy intact. |
| `durable-objects/quota-controller/src/relay-grant.ts` | Durable grant claims, single-use transitions, exact-repeat terminal replay and retention cleanup. |
| `durable-objects/quota-controller/src/relay-admission.ts` | Transaction-scoped admission helper and exact `RelayAdmissionInput`/`RelayAdmissionResult` types. |
| `durable-objects/quota-controller/src/quota-controller.ts` | Atomic `admitRelay`, grant lifecycle RPCs and server-derived pool/day identity. |
| `durable-objects/quota-controller/src/quota-lifecycle.ts` | `applyQuotaLifecycleTransition(storage, requestId, transition)` transaction-scoped settlement/reconciliation helper used by legacy and relay lifecycle. |
| `durable-objects/quota-controller/src/store.ts` | Open-storage helpers for reserve/idempotency/lease operations composed inside one admission transaction; legacy RPC behavior remains intact. |
| `durable-objects/quota-controller/test/relay-admission.test.ts` | Atomic reservation/lease/grant, idempotency, quota, concurrency and rollback tests. |
| `apps/deno-tokenizer/src/relay.ts` | Bounded input preparation, opaque context/grant transport, decision/activation callbacks and Gateway B request. |
| `apps/deno-tokenizer/src/relay-usage.ts` | Bounded SSE/JSON usage extraction without changing client bytes. |
| `apps/deno-tokenizer/src/http.ts`, `src/config.ts`, `src/main.ts` | Versioned endpoint and environment-specific configuration. |
| Existing suites in `apps/gateway-worker/test/`, `apps/deno-tokenizer/test/`, `durable-objects/quota-controller/test/` | Behavior and fault-injection regressions. |
| `apps/gateway-worker/wrangler.jsonc` | Production Decision DO binding and SQLite migration tag. |
| `scripts/preview-worker-config.mjs`, `scripts/preview-worker-config.test.mjs` | Generate/assert Preview-specific Worker, Quota, Tokenizer and Decision DO bindings without Production namespace IDs. |
| `.github/workflows/deploy-deno-tokenizer.yml`, `.github/workflows/deploy-production.yml`, `scripts/production-deno-config.mjs` | Same-revision, Deno-first rollout and safe configuration checks; Worker rollout applies the DO migration. |
| `docs/deno-tokenizer.md`, `docs/operations.md`, `docs/configuration.md` | Operator configuration, migration, deployment order, rollback and reconciliation. |

The Design's **Normative relay contract (v1)** is authoritative for every name, field, limit, state, mapping and ownership rule below. Task 1 reproduces that complete normative contract as shared wire types and parsers; later tasks consume those names without renaming them. Keep each new TS module focused and below the repository's 250-LOC guidance where feasible. Existing oversized modules should gain only routing glue, not another full state machine.

## Task 0: Free-plan CPU Capability Spike (the only pre-gate task)

**Purpose:** Re-run the complete capability gate for the revised split between the stateless Worker decision callback, `RelayDecisionController`, and atomic `QuotaController.admitRelay`, without implementing production behavior in Task 0.

**Consumes / produces:** Consumes the reviewed Design, Free-plan runtime authorization and the sanitized prior FAIL. Produces the complete revised Task 0 CPU evidence and one explicit PASS/FAIL/BLOCKED decision; it does not produce source or implementation artifacts.

**Current evidence:** Task 0 was executed on 2026-09-23 and is **FAIL**. The stateless decision callback had 98 CPU telemetry records from 100 successful driver invocations, with p99/max of 19 ms and `exceededCpu=0`. The observed maximum violates the 10 ms gate. The sanitized evidence is in the Design. Tasks 1–8 have not started.

**Next-run preconditions:** Fresh Superpowers Review Gate must accept this Design/Plan revision, and the user must separately authorize remote deployment/runtime measurement. Only then may Task 0 run in a repository-external disposable harness against a Workers Free Preview and a temporary Deno app with isolated Preview D1/DO namespaces. Never use Production resources. Local emulators, Paid Workers and synthetic microbenchmarks are not qualifying evidence. Task 0 remains the only permitted work until its complete revised gate records PASS and the evidence is accepted.

**Ingress workload:** Reproduce authenticated one-pass `/v1/responses` Worker → Deno forwarding. The ingress Worker signs the existing request context, then forwards the original body exactly once without clone, full buffering, JSON parsing or transformation. Measure each size/mode bucket below with at least 100 successful invocations:

- 123 KiB / `stream=true` and `stream=false`.
- 174 KiB / `stream=true` and `stream=false`.
- Approximately 700 KiB / `stream=true` and `stream=false`.
- Exactly 1 MiB / `stream=true` and `stream=false`.

**Stateless Worker workload:** Capture `executionModel=stateless` CPU independently for ingress and each callback.

- **Decision callback:** Deno service bearer; method/path/content-type; bounded context/key/body validation; bounded body read; unverified request-ID shard hint; deterministic shard selection; one Decision DO RPC. No JSON parsing, HMAC verification, idempotency hash binding, policy/model lookup, budget, quota, grant creation or signing.
- **Activation:** service bearer, grant credential/binding and bounded envelope validation, then dispatch to QuotaController activation.
- **Renewal:** service bearer, grant binding/state/expiry and bounded envelope validation, then dispatch to QuotaController renewal.
- **Terminal:** service bearer, grant binding/state and bounded terminal envelope validation, then dispatch to QuotaController terminal transition.

**Durable Object workload:** Capture `executionModel=durableObject` series separately for each operation:

- **RelayDecisionController.decide:** strict bounded JSON parsing; context HMAC/claims; exact raw Idempotency-Key/hash binding; authoritative registry/policy/model/tool processing; token budget/pool/day; QuotaController RPC; grant signing.
- **QuotaController.admitRelay:** idempotency/quota/finalize/concurrency checks and one atomic reserve/lease/grant transaction.
- **QuotaController.activateRelay, renewRelay, finishRelay:** the existing one-use activation, lease renewal and terminal quota/grant operations, each a distinct CPU class.

Use at least 100 successful invocations per ingress bucket, stateless callback and DO operation class. Report min/p50/p90/p95/p99/max, CPU-record count, driver successful count, `exceededCpu`, and tail margin per class. Stateless Worker classes use a 10 ms limit with p99 <=8 ms and max <10 ms. Each DO operation uses the documented 30,000 ms default per-request CPU limit, p99 <=24,000 ms and max <30,000 ms. Do not pool Worker or DO CPU, or different DO operations. The harness and its tests/config/logs remain outside the repository and MUST NOT create production source, modules, routes, callbacks, tests, scripts or workflows.

**Artifacts and disposal:** Keep harness source, temporary deployment configuration, logs and raw measurement files outside the repository in a task-specific temporary directory owned by the Task 0 operator. Do not place credentials, request bodies, prompts or response bodies in artifacts. The operator is responsible for cleanup: after results are independently summarized into the review record, delete the harness, temporary configuration, raw logs and temporary deployment resources. Retain only sanitized aggregate evidence, dated runtime/revision identifiers, test methodology and explicit PASS/FAIL decision in the review record. Do not commit or push spike artifacts.

**Gate decision:** PASS requires every stateless Worker class and every required DO operation class to meet its separate thresholds, with complete >=100 successful/CPU telemetry samples, no `exceededCpu`, and no omitted class. Any observed bound violation is FAIL even if another telemetry series is incomplete. Missing evidence without an observed failure is BLOCKED. The previous architecture has an observed 19 ms decision callback and is recorded FAIL; do not rerun that architecture. The revised complete gate is the sole prerequisite for Tasks 1–8. Do not weaken thresholds or reduce workload after a failure.

## Blocking prerequisite: Pre-implementation CPU Feasibility Gate

Task 0 is the sole task permitted before PASS. The current Task 0 result is FAIL, so Tasks 1–8 MUST remain not-started. Fresh Superpowers Review Gate must first accept this revision; a separately authorized complete Task 0 rerun must then pass, with all evidence recorded, before Task 1 can start. No task completion or CPU PASS automatically authorizes a commit or push.

## Task dependencies and TDD/commit order

Task 0 is the only pre-gate task. The current status is FAIL; Fresh Superpowers Review Gate must accept this revision before a separately authorized complete Task 0 rerun. Its explicit PASS and accepted evidence are hard prerequisites to Tasks 1–8. After that gate: Task 1 (including normative SPEC synchronization) precedes Tasks 2 and 3; Tasks 2 and 3 both precede Task 4; Tasks 1, 3 and 4 precede Task 5; Task 5 precedes Task 6; Tasks 1, 3, 4, 5 and 6 precede Task 7; Tasks 1–7 precede Task 8. Tasks 2 and 3 may proceed independently after Task 1. Within Tasks 1–8, follow this exact sequence: (1) RED command, (2) expected RED, (3) minimum GREEN implementation, (4) GREEN command, (5) expected GREEN, (6) only then necessary refactor and rerun GREEN, (7) completion boundary, (8) commit message usable only if the user explicitly authorized that commit. Task 0 is excluded from this sequence and remains an external disposable runtime capability measurement. No task instructs push.

## Task 1: Define and test the bounded relay contract

**Files:** Create `packages/shared/src/relay.ts`, `packages/shared/test/relay.test.ts`; modify `packages/shared/src/index.ts` and `SPEC.md`.

**Consumes:** Design Normative relay contract, including the post-Task-0 `RelayDecisionController` routing contract and `QuotaController.admitRelay` authority boundary; exact v1 routes/headers/envelopes/error mapping.
**Produces:** `SPEC.md` as canonical normative contract before dependent source work; `RelayEnvironment`, `RelayGrantState`, `RelayContextV1`, `RelayGrantCredentialV1`, `RelayRequestMetaV1`, `RelayQuotaSnapshotV1`, `RelayDecisionV1`, `RelayActivationV1`, `RelayRenewalV1`, `RelayTerminalV1`, `RelayResponseMetaV1`, `RelayErrorCode`, `RelayInternalErrorV1`, `RelayProtocolError`, `RelayDecisionDispatchInput`, and `RelayDecisionDispatchResult`; `parseRelayJsonBody(bytes: Uint8Array, maxBytes: number): unknown` plus strict parsers for each body envelope. Grant credential is carried only in `X-OCTG-Relay-Grant`, not in the allow envelope. Public Deno/Worker HTTP fields remain unchanged; Task 1 declares the Cloudflare-internal Worker→DecisionDO RPC types, Task 2 owns QuotaController admission RPC types, and Task 4 consumes both.

**Exact contract to encode:** `RelayContextV1` has the Design's exact claims and ingress lifetime; `requestId` uses the existing OCTG `req_${ulid()}` format and its parser/test accepts a valid `req_[0-9A-HJKMNP-TV-Z]{26}` identifier. `RelayRequestMetaV1` fields and limits are exactly the Design's decision request. Decision reject/allow, activation, renewal, terminal, `RelayResponseMetaV1`, `RelayErrorCode`, internal error envelope, method/content-type rules, exact header names, and ingress/callback/header byte limits MUST match the Normative relay contract verbatim. `parseRelayJsonBody` enforces the byte limit, fatal UTF-8 and duplicate-key rejection before each strict envelope parser; all parsers reject unknown fields, invalid ranges, and over-limit UTF-8 byte lengths. `RelayResponseMetaV1` contains no credentials or request content. Do not introduce alternate shapes or aliases.

Contract checklist for this task: POST only; JSON content type; Worker ingress `Authorization: Bearer <ingress token>` plus `X-OCTG-Relay-Context`, and optional unchanged `Idempotency-Key` <=255 UTF-8 bytes; callbacks `Authorization: Bearer <service token>` and grant callbacks also `X-OCTG-Relay-Grant`; response metadata `X-OCTG-Relay-Response-Meta` containing unpadded base64url JSON. Ingress body <=1,048,576 bytes; context/grant header <=4,096 ASCII bytes; callback request/response body <=8,192 bytes; metadata JSON <=2,048 decoded bytes and metadata header <=2,800 ASCII bytes; bearer Authorization header <=263 ASCII bytes; service token 32–256 printable ASCII bytes; the Cloudflare-side HMAC key base64url decodes to exactly 32 bytes and is unavailable to Deno. The ingress Worker signs context; RelayDecisionController verifies context and signs grants; activation/renewal/terminal callback Worker paths verify grants. Decision request, reject/allow response, activation, renewal, terminal request/response, metadata response, internal error, every named error code and every public status mapping are exactly the shapes/tables in Design sections "Callback and response envelopes" and "Stable failures and public mapping". No extra HTTP headers, envelope fields or status remapping may be invented.

Exact callback routes are `POST /internal/relay/v1/decision`, `/activation`, `/renewal`, `/terminal`; Deno ingress is `POST /relay/v1/responses`. Context claims are exactly version/audience/environment/route/requestId/clientId/idempotencyKeyHash/nonce/issuedAtMs/expiresAtMs. Grant claims add grantId/model/pool/admissionUtcDay/leaseGeneration and have the grant audience. Decision request is `{version:1,metadata:RelayRequestMetaV1}`; decision response is either `{version:1,kind:"reject",code,status}` or `{version:1,kind:"allow",grantId,leaseGeneration,maxOutputTokens,cacheEnabled,quota}` with the grant only in `X-OCTG-Relay-Grant`; reject status must match the exact code mapping. Activation, renewal and terminal envelopes and `RelayResponseMetaV1` fields are copied exactly from the Design. Stable errors are the complete `RelayErrorCode` union; internal failures use `{version:1,error:{code}}`. Public mapping preserves `400 invalid_request`, external-client `401 invalid_api_key`, `403 client_disabled|model_requires_paid|model_not_allowed`, `409 duplicate_idempotency_key`, `413 request_too_large`, `429 insufficient_quota|worker_concurrency_exceeded`, and internal relay failures `500 internal_error`. Deno config keys are exactly `OCTG_RELAY_ENVIRONMENT`, `OCTG_RELAY_CALLBACK_ORIGIN`, `OCTG_RELAY_SERVICE_AUTH_TOKEN`, `OCTG_RELAY_INGRESS_AUTH_TOKEN`, `OCTG_RELAY_GATEWAY_B_BASE_URL`, `OCTG_RELAY_GATEWAY_B_TOKEN`, `MAX_INPUT_BYTES`, `OCTG_RELAY_MAX_REQUEST_DURATION_MS`, `OCTG_RELAY_LEASE_TTL_MS`, `OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS`; `OCTG_RELAY_CONTEXT_HMAC_KEY` is bound only in Cloudflare. The ingress Worker signs context; RelayDecisionController verifies context and signs grants; no Deno code receives the key. Worker keys and fixed values/partial-configuration semantics are exactly those in the Design. `OCTG_RELAY_ENABLED=true` requires complete valid Worker config; `false` or absent disables relay; any other value is invalid. Lease TTL/cadence are fixed config (120,000/30,000 ms), never decision fields.

- [ ] Add failing tests for each accepted envelope and for version mismatch, extra keys, negative or non-integer usage, oversized metadata, wrong environment and malformed grant. Include a valid existing `req_${ulid()}` request ID case. The decision metadata type/function are exactly `RelayRequestMetaV1` and `parseRelayRequestMeta(...)`. Example: `expect(parseRelayRequestMeta({ model: "openai/test", estimatedInputTokens: -1 })).toBeUndefined()`.
- [ ] Run `npm test -w packages/shared -- relay.test.ts`; expect the missing parser test to fail.
- [ ] Update `SPEC.md` first with the exact accepted v1 wire contracts, `RelayDecisionController` authority/routing, and `QuotaController.admitRelay` boundary from the Design; do not add implementation details that the Design does not define.
- [ ] Add discriminated unions and parsers with explicit byte/string bounds, as in `if (!Number.isSafeInteger(raw.estimatedInputTokens) || raw.estimatedInputTokens < 0) return undefined;`. Export the functions in `index.ts`.

  ```ts
  const RELAY_METADATA_KEYS = new Set([
    "model", "estimatedInputTokens", "maxOutputTokens", "inputBytes",
    "rawBodyBytes", "isToolUse", "stream",
  ]);
  export function parseRelayRequestMeta(value: unknown): RelayRequestMetaV1 | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    if (Object.keys(raw).length !== RELAY_METADATA_KEYS.size ||
        Object.keys(raw).some((key) => !RELAY_METADATA_KEYS.has(key))) return undefined;
    if (typeof raw.model !== "string" || raw.model.length === 0 ||
        new TextEncoder().encode(raw.model).byteLength > 256) return undefined;
    if (typeof raw.estimatedInputTokens !== "number" ||
        !Number.isSafeInteger(raw.estimatedInputTokens) || raw.estimatedInputTokens < 0) return undefined;
    for (const key of ["inputBytes", "rawBodyBytes"] as const) {
      if (typeof raw[key] !== "number" || !Number.isSafeInteger(raw[key]) ||
          (raw[key] as number) < 0 || (raw[key] as number) > 1048576) return undefined;
    }
    if (typeof raw.maxOutputTokens !== "number" ||
        !Number.isSafeInteger(raw.maxOutputTokens) || raw.maxOutputTokens < 0) return undefined;
    if (typeof raw.isToolUse !== "boolean" || typeof raw.stream !== "boolean") return undefined;
    return {
      model: raw.model,
      estimatedInputTokens: raw.estimatedInputTokens,
      maxOutputTokens: raw.maxOutputTokens,
      inputBytes: raw.inputBytes as number,
      rawBodyBytes: raw.rawBodyBytes as number,
      isToolUse: raw.isToolUse,
      stream: raw.stream,
    };
  }
  ```
- [ ] Run `npm test -w packages/shared -- relay.test.ts`, `npm run typecheck -w packages/shared`, and `git diff --check`; expect all to pass and SPEC/Design contracts to agree.
- [ ] **Completion boundary:** `SPEC.md` and shared v1 contract/types/parsers match the Design exactly; focused tests/typecheck/diff check pass; no Worker, Deno, DO or workflow behavior is implemented in this task.
- [ ] **Commit only if explicitly authorized:** `feat: relayのwire contractを定義`

## Task 2: Add one atomic QuotaController relay admission RPC

**Files:** Create `durable-objects/quota-controller/src/relay-grant.ts`, `durable-objects/quota-controller/src/relay-admission.ts`, `durable-objects/quota-controller/test/relay-grant.test.ts`, and `durable-objects/quota-controller/test/relay-admission.test.ts`; modify `durable-objects/quota-controller/src/quota-controller.ts`, `durable-objects/quota-controller/src/quota-lifecycle.ts`, and `durable-objects/quota-controller/src/store.ts`.

**Consumes:** Task 1 shared v1 contract and SPEC; existing RequestEntry/idempotency/pool/unresolved/lease storage; environment-isolated `QuotaController` identity.
**Produces:** `RelayGrant`, `RelayAdmissionInput`, `RelayAdmissionResult`, `admitRelay(input)`, existing `activateRelay`, `renewRelay`, `finishRelay`, and the transaction-scoped `applyQuotaLifecycleTransition(storage, requestId, transition)`. `admitRelay` is the only decision-path QuotaController admission RPC; the stateless Worker and Decision DO do not call `reserve`, `acquireInFlight` and grant authorization as separate RPCs.

`applyQuotaLifecycleTransition(storage, requestId, transition)` remains the only terminal quota lifecycle mutation seam. It consumes an open transaction-scoped storage handle and never opens a nested transaction. Existing `settle`, `markUncertain`, `release`, `reconcileRequest` and grant `finishRelay` preserve their existing atomicity and reconciliation rules. `admitRelay` is one public QuotaController RPC and one `ctx.storage.transaction()`: it checks request/idempotency replay, finalized state, quota and active in-flight capacity before writes; then commits RequestEntry, pool/unresolved counters, the raw-key/client mapping, generation-bound lease and initial authorized RelayGrant together. Any denial writes no admission state. It derives the pool/day from the QuotaController namespace, reads `MAX_IN_FLIGHT_REQUESTS` using the existing default-2 positive-integer semantics, and uses the fixed 120,000 ms relay lease TTL. It does not accept a pool/day, namespace ID, expiry, limit or TTL from Deno or the Worker RPC caller. Legacy `reserve`, `acquireInFlight` and `renewInFlight` remain available for legacy routes; relay does not compose them as separate RPCs.

**Exact DO RPC contract (all time values are safe-integer Unix milliseconds generated by the owning DO):** These signatures and result unions are normative for Tasks 2 and 4. Task 4 consumes them directly and must not design alternatives. `RelayContextV1`, `RelayRequestMetaV1`, `RelayGrantCredentialV1`, `RelayTerminalV1` and `RelayQuotaSnapshotV1` are the exact Task 1 types; `RequestEntry` remains the canonical quota entry.

```ts
interface QuotaControllerEnv {
  readonly QUOTA_LIMIT_STANDARD?: string;
  readonly QUOTA_LIMIT_MINI?: string;
  readonly MAX_IN_FLIGHT_REQUESTS?: string; // server config; default is 2
  readonly OCTG_RELAY_ENVIRONMENT?: string; // validated as preview|production for relay
}

interface RelayAdmissionInput {
  context: RelayContextV1; // verified by RelayDecisionController
  metadata: RelayRequestMetaV1; // strictly parsed by RelayDecisionController
  rawIdempotencyKey?: string; // exact effective public value; absent if none
  reservedTokens: number; // derived by Decision DO budget calculation
  upperBoundTokens: number; // derived by Decision DO budget calculation
  maxOutputTokens: number; // final output clamp from authoritative policy
  cacheEnabled: boolean; // authoritative policy result
}

type RelayAdmissionResult =
  | { kind: "admitted"; grant: RelayGrant; quota: RelayQuotaSnapshotV1 }
  | { kind: "denied"; code: RelayErrorCode };

type RelayGrantBinding = {
  requestId: string;
  grantId: string;
  leaseGeneration: string;
  claims: RelayGrantCredentialV1; // verified by the Worker callback
  nowMs: number; // Worker-supplied time is validated against stored grant bounds
};

type ActivateRelayResult =
  | { kind: "activated"; grant: RelayGrant }
  | { kind: "denied"; code: ActivationDenialCode };

type RenewRelayResult =
  | { kind: "renewed"; grant: RelayGrant; leaseExpiresAtMs: number }
  | { kind: "denied"; code: RelayErrorCode };

type FinishRelayInput = RelayGrantBinding & {
  report: RelayTerminalV1;
  reportFingerprint: string;
};
type FinishRelayResult =
  | { kind: "accepted"; grant: RelayGrant; quota: RequestEntry }
  | { kind: "denied"; code: RelayErrorCode };

interface RelayGrantOperations {
  admitRelay(input: RelayAdmissionInput): Promise<RelayAdmissionResult>;
  activateRelay(input: RelayGrantBinding): Promise<ActivateRelayResult>;
  renewRelay(input: RelayGrantBinding): Promise<RenewRelayResult>;
  finishRelay(input: FinishRelayInput): Promise<FinishRelayResult>;
}
```

`admitRelay` validates the verified context/metadata binding, positive safe
reservation bounds, exact optional raw key and environment. QuotaController
derives pool/day from its immutable namespace identity, generates grant ID and
lease generation, sets fixed authorization/grant expiry, and reads server-side
in-flight settings from its Worker environment. One storage transaction checks
the existing raw-key/client mapping, quota tier/capacity, finalized state and
active concurrency; then writes reservation, counters, idempotency mapping,
lease and authorized grant together. A denial before commit leaves no partial
reservation/lease/grant. An exact same-request replay with identical claims and
metadata returns the same admission only while the grant remains `authorized`;
an attempted/terminal grant cannot produce a second allow. A different request
ID with the same raw key/client is rejected by the existing idempotency mapping.
There is no separate public `authorizeRelay` call in the relay decision path.

Each grant-aware RPC validates all immutable claims against its stored grant.
`activateRelay` atomically validates reservation, grant, environment and lease
generation before `authorized -> attempted`. `renewRelay` MUST, in the same
transaction, require `state === "attempted"`, unexpired authorization, unresolved
reservation, live lease with matching generation, and no reconciliation or
terminalization before extending the lease by exactly 120,000 ms. It MUST NOT
call or wrap the legacy `renewInFlight()` RPC. An expired attempted grant
transitions to `uncertain`, retains quota reservation and releases only its
concurrency lease. `finishRelay` calls the same
`applyQuotaLifecycleTransition(storage, requestId, transition)` helper as legacy
settlement/reconciliation and commits quota, grant terminal state and lease
release atomically. Existing legal transition, reconciliation, terminal replay
and retention semantics remain unchanged.

- [ ] Write failing DO tests for `admitRelay`: one call atomically creates reservation/counters/idempotency mapping/lease/authorized grant; quota or concurrency denial leaves none of these writes; same request/context/metadata returns the same authorized result; conflicting metadata or a different request ID with the same raw key/client rejects; late/cross-shard calls converge on the same pool/day QuotaController. Also test activation concurrently twice (exactly one activates), renewal state/expiry/generation rules, terminal replay/conflict, authorized release, attempted uncertainty, reconciliation terminalization and expired-grant behavior.
- [ ] Run `npm test -w apps/gateway-worker -- relay-admission.test.ts relay-grant.test.ts`; expect missing `admitRelay` and atomic behavior assertions to fail.
- [ ] Implement `admitRelay(input)` as one `ctx.storage.transaction()`. Extract transaction-scoped reserve/admission helpers; precheck idempotency, finalized state, quota and concurrency before writes; then commit RequestEntry, pool/unresolved counters, existing raw-key/client idempotency mapping, lease and authorized RelayGrant together. Generate grant ID, lease generation and timestamps in QuotaController. Do not call public `reserve()`, `acquireInFlight()` or `authorizeRelay()` as separate nested/remote RPCs from the Decision DO. Keep legacy RPCs behavior-compatible. Preserve `applyQuotaLifecycleTransition` for settle/uncertain/release/reconciliation; keep `finishRelay()` transactional with grant and lease state. Maintain every existing terminal/reconciliation state rule and 45-day terminal retention.

  ```ts
  async admitRelay(input: RelayAdmissionInput): Promise<RelayAdmissionResult> {
    return this.ctx.storage.transaction((storage) =>
      admitRelayInTransaction(storage, this.env, this.identity, input, Date.now())
    );
  }
  ```
- [ ] Run `npm test -w apps/gateway-worker -- relay-admission.test.ts relay-grant.test.ts`, `npm run typecheck -w durable-objects/quota-controller`, `npm run typecheck -w apps/gateway-worker`, and `git diff --check`; expect all to pass.
- [ ] **Completion boundary:** The relay has exactly one QuotaController admission RPC with atomic reservation/lease/grant state; legacy reserve and in-flight callers are unchanged; reconciliation, terminal idempotency and grant lifecycle tests pass.
- [ ] **Commit only if explicitly authorized:** `feat: quota DOでrelay grantを原子的に管理`

## Task 3: Authenticate relay context and internal callbacks

**Files:** Create `packages/shared/src/relay-credential.ts`, `packages/shared/test/relay-credential.test.ts`, `apps/gateway-worker/src/relay-auth.ts`, `apps/gateway-worker/test/relay-auth.test.ts`; modify `packages/shared/src/index.ts` and `apps/gateway-worker/src/index.ts` for exports/environment bindings.

**Consumes / produces:** Consumes the exact Task 1 `RelayContextV1`/`RelayGrantCredentialV1` contracts and emits Cloudflare-side signing/verification and fixed environment validation used by ingress Worker, Decision DO and grant callbacks. It does not add callback/DO behavior.

**Interfaces:** `packages/shared/src/relay-credential.ts` exports the exact sign/verify context and grant credential functions specified in the Design plus constant-time bearer comparison. `apps/gateway-worker/src/relay-auth.ts` exports `resolveRelayConfig(env)` and the ingress/callback adapters. Use canonical JSON, compact base64url, HMAC-SHA-256 with purpose-separated inputs and constant-time MAC comparison. The environment-specific `OCTG_RELAY_CONTEXT_HMAC_KEY` is a Cloudflare Worker deployment secret consumed by the ingress Worker context signer and `RelayDecisionController` context verifier/grant signer; it is never configured in Deno. Deno applies only transport size/syntax bounds to the opaque ingress context and forwards it unchanged to decision; after allow it may decode claims only as non-authoritative bounded metadata. Exact Worker/Deno env keys, partial-config behavior, fixed origins and TTLs are specified in the Design. This task implements credentials/config only; Task 4 implements callback and Decision DO behavior.

- [ ] Write failing unit tests only for credential/context sign+verify primitives and pure config validation: claims round-trip; wrong version/audience/environment/purpose/signature; expired/future times; malformed/non-canonical/oversized token; missing/partial env keys; wrong endpoint scheme. Do not test callback routes, activation, terminal replay, or renewal behavior here. Example: `expect(await verifyRelayGrantCredential(previewToken, prodKey, "production", now)).toBeUndefined()`.
- [ ] Run `npm test -w apps/gateway-worker -- relay-auth.test.ts`; expect missing exports.
- [ ] Implement signing/verifying and `resolveRelayConfig(env)` with exact keys and fixed TTL policy from the Design; partial/invalid enabled config returns invalid, not disabled. Never leak token, payload or signature.

  ```ts
  const signature = await crypto.subtle.sign("HMAC", signingKey, encodedContext);
  // Verify signature against the original bytes before parseRelayContext(JSON.parse(...)).
  // Reject an ingress context when expiresAtMs <= nowMs or environment differs.
  ```
- [ ] Run focused test and `npm run typecheck -w apps/gateway-worker`; expect pass.
- [ ] **Completion boundary:** Only crypto/context/config primitives exist and their unit tests/typecheck pass; no callback routing or grant lifecycle behavior is included.
- [ ] **Commit only if explicitly authorized:** `feat: relay credentialの署名検証を追加`

## Task 4: Add RelayDecisionController and thin stateless decision callback

**Files:** Create `apps/gateway-worker/src/relay-decision-controller.ts`, `apps/gateway-worker/test/relay-decision-controller.test.ts`, `apps/gateway-worker/src/relay-callback.ts`, and `apps/gateway-worker/test/relay-callback.test.ts`; modify `apps/gateway-worker/src/index.ts` and `apps/gateway-worker/wrangler.jsonc`.

**Consumes / produces:** Consumes Task 1 HTTP envelopes plus shared `RelayDecisionDispatchInput`/`RelayDecisionDispatchResult`, Task 2 `admitRelay`, Task 3 credential functions and the Design's routing contract. Produces the `RelayDecisionController` DO and a thin Worker decision callback; activation/renewal/terminal behavior remains Worker-side.

**Interfaces:** `RelayDecisionController extends DurableObject<Env>` exposes the exact internal RPC `decide(input: RelayDecisionDispatchInput): Promise<RelayDecisionDispatchResult>` defined in the Design. It holds no quota/grant ledger. `handleRelayCallback(request, env, ctx)` continues to handle exactly the v1 callback paths. For decision it authenticates the Deno service bearer, validates method/path/content type and header/body bounds, reads at most 8,192 body bytes without JSON parsing, extracts only the syntactically valid `requestId` routing hint from the context token, and calls the deterministic Decision DO shard. It does not verify HMAC, hash/bind the Idempotency-Key, read policy, classify models, calculate budgets, reserve, acquire leases, authorize grants or sign credentials. Activation/renewal/terminal retain their existing Worker-side grant verification and dispatch to the same QuotaController identity reconstructed from verified grant `pool + admissionUtcDay`. `index.ts` exports and binds the DO class; Wrangler adds the SQLite-backed class migration. Exact route/header/body/error contracts remain unchanged.

- [ ] Write failing tests for the thin Worker callback: wrong method/path/content type, invalid service bearer, over-limit headers/body, malformed routing hint, and deterministic shard mapping. Assert it preserves the exact bounded body/context/raw key bytes and performs one DO dispatch without doing context verification, JSON parsing, idempotency hashing, policy lookup or QuotaController RPCs. Write failing Decision DO tests for wrong signature/environment/audience/expiry/nonce; tampered request-ID hint/shard mismatch; raw Idempotency-Key/hash mismatch and absent/empty key semantics; policy/model/tool reject; budget/output clamp; pool/day selection; exact `admitRelay` arguments/results; retry after lost `admitRelay` acknowledgement with the identical input; exact replay before activation; rejection after activation; and grant header/envelope separation. Assert invalid context/key binding makes zero registry/quota calls, and every reject makes zero Gateway B calls.
- [ ] Add failing grant-delivery tests: a signing failure after atomic admission requests pre-activation `finishRelay(release)` and emits no allow; a lost callback acknowledgement is retried only with the identical context/body/key and returns the same stored grant while authorized; an attempted grant cannot produce a second allow.
- [ ] Preserve regression coverage for activation/renewal/terminal: invalid grant, duplicate activation, stale generation, expiry/reconciliation, terminal replay/conflict, and same admission-day QuotaController selection. These callbacks stay Worker-side and must not route through `RelayDecisionController`.
- [ ] Run `npm test -w apps/gateway-worker -- relay-decision-controller.test.ts relay-callback.test.ts`; expect the Decision DO binding/class and thin callback behavior tests to fail.
- [ ] Implement `RelayDecisionController.decide(input)` in `apps/gateway-worker/src/relay-decision-controller.ts`: verify signed context and environment first, recompute its 64-shard identity, parse bounded decision bytes, verify exact key/hash binding, load registry/policy, classify model/tool, calculate budget/day, call `QuotaController.admitRelay` once, then sign returned grant claims and return the exact Decision result. In `relay-callback.ts`, authenticate Deno and perform bounded method/path/header/body checks, extract only the unsigned request-ID routing hint, dispatch to one shard and serialize the DO result to the unchanged HTTP envelope/header. Do not do HMAC, policy, model, token-budget, grant or quota work in the stateless decision callback. Keep existing activation/renewal/terminal handling and error mappings. Export the new DO from `index.ts`; add the Production class binding and SQLite migration tag in `wrangler.jsonc` so Workers tests can bind it.
- [ ] If signing or response construction fails after `admitRelay` returned an authorized grant but before an allow response is emitted, call `finishRelay` with pre-activation `release` using the stored grant binding. Never release if activation may have occurred; rely on the existing uncertain/expiry/reconciliation rules.

  ```ts
  const decisionBody = await readBoundedBytes(request.body, 8_192);
  const contextToken = requireContextHeader(request);
  const requestIdHint = extractBoundedRequestIdHint(contextToken);
  const shardName = decisionShardName(env.OCTG_RELAY_ENVIRONMENT, requestIdHint);
  const result = await env.RELAY_DECISION_CONTROLLER
    .get(env.RELAY_DECISION_CONTROLLER.idFromName(shardName))
    .decide({ decisionBody, contextToken, rawIdempotencyKey });
  return serializeDecisionResult(result);
  ```
- [ ] Run `npm test -w apps/gateway-worker -- relay-decision-controller.test.ts relay-callback.test.ts`, `npm run typecheck -w apps/gateway-worker`, `npm run typecheck -w durable-objects/quota-controller`, and `git diff --check`; expect all to pass.
- [ ] **Completion boundary:** The DecisionDO verifies and orchestrates; QuotaController remains the sole durable quota/grant authority; the stateless decision callback performs bounded transport/dispatch only; activation/renewal/terminal ownership and v1 wire envelopes remain unchanged.
- [ ] **Commit only if explicitly authorized:** `feat: Worker relay callbackを追加`

## Task 5: Build Deno relay and upstream request with explicit activation

**Files:** Create `apps/deno-tokenizer/src/relay.ts`, `apps/deno-tokenizer/test/relay.test.ts`; modify `apps/deno-tokenizer/src/http.ts`, `apps/deno-tokenizer/src/config.ts`, and `apps/deno-tokenizer/src/main.ts`. Do not modify `deno.json`; its existing `@octg/shared` mapping is sufficient for shared non-cryptographic wire types/parsers. Keep `/prepare` behavior unchanged. Do not create `relay-auth.ts` or import HMAC signing/verification primitives into Deno.

**Interfaces:** `handleRelay` accepts only `POST /relay/v1/responses`, exact JSON media type, bearer ingress auth and context header; it enforces 1,048,576 raw bytes and checks only context header size/syntax transport bounds. It forwards the context token unchanged and opaquely to the decision callback, whose thin Worker transport dispatches to `RelayDecisionController` for verification. Deno does not hold the HMAC key or verify/mint context or grant tokens. It forwards the effective raw `Idempotency-Key` unchanged to decision as an optional header (maximum 255 UTF-8 bytes), and sends no such header when the public key is effectively absent under the existing missing/null/empty semantics. The decision JSON body remains `{version:1,metadata:...}`. After an allow decision returned through Worker, Deno may decode context claims only as non-authoritative bounded relay/upstream metadata (for example, request ID and client ID); it performs no idempotency authorization check and never terminal-releases for key mismatch. It forwards the same exact effective key to Gateway B unchanged, or omits it when absent. Deno configuration is the exact required Deno key set in the Design; missing/partial/invalid settings fail startup and do not disable checks. It calls `POST /decision`, then `POST /activation` with exact envelopes. Grant credential travels opaquely only in `X-OCTG-Relay-Grant`. Gateway B URL/token are fixed Deno config, never request-supplied. Upstream JSON uses the existing normalizer and allowed numeric output clamp; headers follow existing Gateway B contract and never reuse client Authorization. A valid HTTP 200 reject envelope is a business rejection that Deno maps by the existing public code/status table. A non-200 callback transport failure becomes public `500 internal_error`, never 503.

**Consumes / produces:** Consumes Task 1 v1 envelopes and Task 4's authenticated decision/activation callback contract. Produces the same Deno `/relay/v1/responses` behavior and unchanged HTTP decision wire format; Deno has no Worker or Durable Object binding and cannot choose a Decision or Quota DO.

`activateOnce(grantId, leaseGeneration, credential)` returns exactly `| {kind:"activated"} | {kind:"denied",code:ActivationDenialCode} | {kind:"unknown"}`, with `ActivationDenialCode` and each code's action defined in the Design Normative relay contract. For `lease_lost` only, Deno sends terminal `release`; it never releases for `grant_replayed`, which maps to best-effort `uncertain`, nor for already-terminal `grant_terminalized`. `environment_mismatch`, `grant_not_found`, and `grant_expired` cause no terminal callback, for their respective reasons specified in the contract. `unknown` sends terminal `uncertain` best effort. Deno never retries activation, never calls Gateway B for denial/unknown, and only `{kind:"activated"}` permits exactly one Gateway B request.

- [ ] Add failing tests for transport-invalid contexts: malformed, oversized, or non-two-segment context tokens are rejected by Deno transport validation and make no decision callback. Separately test syntactically valid contexts with wrong signature, expiry, or environment: Deno does not cryptographically verify them; it sends them to the decision callback, RelayDecisionController rejects them, no activation occurs, and Gateway B is not called. Also test invalid ingress auth/media type/method/size; exact non-empty Idempotency-Key preservation from Deno ingress to decision callback and onward to Gateway B; absent/empty effective key omitted from both; validation/model/quota/concurrency rejection with exact status/code and no activation/upstream call; activation lost/denied with no upstream call; successful activation with exactly one fixed Gateway B call and numeric clamp; post-activation fetch failure reported uncertain; and no fallback after callback failure. Assert quota rejection remains `429 insufficient_quota`, not 503, with zero upstream calls.
- [ ] Run `npm test -w apps/deno-tokenizer`; expect the new relay route tests to fail.
- [ ] Implement bounded preparation using existing reader/normalizer/encoder; send exact decision metadata, require valid allow decision and grant header, then activate once before forwarding. Preserve decision rejection envelope/status/code for Worker translation. Treat every ambiguous post-activation outcome as uncertain.

  ```ts
  const decision = parseRelayDecision(await decisionResponse.json());
  if (decision?.kind === "reject") return relayErrorResponse(decision.status, decision.code);
  if (decision?.kind !== "allow") return relayErrorResponse(500, "internal_error");
  const grantCredential = decisionResponse.headers.get("X-OCTG-Relay-Grant");
  if (grantCredential === null) return relayErrorResponse(500, "internal_error");
  const activation = await activateOnce(
    decision.grantId,
    decision.leaseGeneration,
    grantCredential,
  );
  switch (activation.kind) {
    case "activated":
      break;
    case "denied":
      await applyActivationDenialAction(activation.code);
      return relayErrorResponse(500, activation.code);
    case "unknown":
      await reportTerminalUncertainBestEffort();
      return relayErrorResponse(500, "internal_error");
  }
  const body = normalizeResponsesUpstreamBody(parsedBody);
  body.max_output_tokens = decision.maxOutputTokens;
  return forwardToGatewayB(body, decision);
  ```
- [ ] Run `npm run typecheck -w apps/deno-tokenizer` and `npm test -w apps/deno-tokenizer`; expect pass.
- [ ] **Completion boundary:** Deno ingress/config and single upstream attempt conform to v1; no usage parsing or public response metadata settlement logic is included.
- [ ] **Commit only if explicitly authorized:** `feat: Deno relay ingressを追加`

## Task 6: Move usage extraction and terminal reporting to Deno

**Files:** Create `apps/deno-tokenizer/src/relay-usage.ts`, `apps/deno-tokenizer/test/relay-usage.test.ts`; modify `apps/deno-tokenizer/src/relay.ts`, `apps/deno-tokenizer/test/relay.test.ts`.

**Interfaces:** `relayUpstreamResponse(response, onTerminal): Response`; bytes and content type remain unchanged. Parse bounded Responses usage including fragmented SSE; non-stream response is bounded and reports before return. Renew at fixed 30,000 ms with exact 120,000 ms lease TTL from config; do not derive cadence from decision envelope. Renewal failure aborts further upstream work, attempts terminal uncertain and never releases an attempted reservation. Terminal callback is exactly-once locally; DO handles idempotent retries.

- [ ] Add failing tests for SSE usage split across chunks, large non-usage events, no final usage, upstream non-2xx, client disconnect, renewal failure and callback failure. Assert original response bytes are identical, usage reported once, no full-stream buffering, and no quota release after activation.
- [ ] Run `npm test -w apps/deno-tokenizer`; expect new tests to fail.
- [ ] Implement bounded tail inspection and terminal callback in a `finally` path with idempotent completion. Forward the original upstream status and content-type; if failure occurs after headers, abort the stream rather than fabricating a second HTTP response. On terminal callback failure, rely on conservative DO reservation and reconciliation, not Deno background execution guarantees.

  ```ts
  let reported = false;
  const reportOnce = async (report: RelayTerminalV1): Promise<void> => {
    if (reported) return;
    reported = true;
    await onTerminal(report);
  };
  // In the stream's flush/cancel/error paths call reportOnce with parsed
  // usage or uncertain, then clear the lease-renewal timer.
  ```
- [ ] Run `npm run typecheck -w apps/deno-tokenizer` and `npm test -w apps/deno-tokenizer`; expect pass.
- [ ] **Completion boundary:** Renewal cadence, stream/non-stream usage parsing, terminal outcomes and byte-preserving behavior pass focused tests; stale grant/reconciliation rules remain tested at the DO boundary.
- [ ] **Commit only if explicitly authorized:** `feat: Deno usageとlease更新を追加`

## Task 7: Select relay for Responses and relay bytes without Worker parsing

**Files:** Create `apps/gateway-worker/src/relay-client.ts`, `apps/gateway-worker/test/relay-client.test.ts`; modify `apps/gateway-worker/src/proxy.ts`, `apps/gateway-worker/src/index.ts`, `apps/gateway-worker/test/proxy-prepare.test.ts`.

**Interfaces:** `callDenoRelay` sends original client body exactly once as a stream without clone/buffer/transform and with exact ingress headers. Deno response carries base64url UTF-8 JSON `RelayResponseMetaV1` in `X-OCTG-Relay-Response-Meta`, decoded size <=2,048 bytes. `RelayResponseMetaV1.route === "responses"` is used only to validate the internal metadata; it is not the public route header. Worker validates metadata, request ID, route, pool/quota numeric invariants before public headers, then builds successful complimentary response headers with `buildOctgHeaders({ requestId, quota, route: "free_shared" })` semantics and never copies internal `"responses"` to `X-OCTG-Route`. `workerVersion` is not response metadata: construct public version headers in the ingress Worker using `workerVersionHeaders(env.CF_VERSION_METADATA)`. Relay decision errors use `RelayErrorCode` and existing SPEC.md public status/code mapping (quota 429, model 403, validation 400); internal failures map to 500 `internal_error`, never blanket 503. Worker never parses usage.

- [ ] Add failing integration tests for exact 1 MiB with and without Content-Length, malformed lengths, stream and non-stream, Deno timeout, validation reject and 5xx, unchanged Chat route, legacy fallback when disabled, and raw byte equality of SSE payload. Add the selection-order regression pair: with relay enabled and invalid legacy Deno tokenizer/prepare configuration, the Responses request selects relay and succeeds without returning the legacy configuration error; with relay disabled and the same invalid legacy configuration, preserve the existing legacy failure semantics. Assert successful public relay responses use `X-OCTG-Route: free_shared`. Example: `expect(upstreamWorkerCalls).toBe(0)` on relay success and `expect(denoCalls).toBe(1)`.
- [ ] Run `npm test -w apps/gateway-worker -- relay-client.test.ts proxy-prepare.test.ts`; expect relay-disabled tests to pass and new enabled tests to fail.
- [ ] Implement this exact selection order: (1) external client authentication; (2) public Idempotency-Key validation; (3) relay configuration resolution; (4) if `endpoint === "responses"` and relay is enabled, select relay; (5) only if relay is disabled, resolve and validate legacy Deno tokenizer/`/prepare` configuration; (6) legacy prepare or legacy normal path. Relay and legacy prepare configuration are independent, so invalid legacy configuration cannot fail an enabled relay request. Relay failure never falls back to legacy. Forward only safe response headers. Avoid `proxyStream` in relay route and avoid marking a reservation released on an ingress failure after Deno might have activated.

  ```ts
  if (endpoint === "responses" && relayConfig.kind === "enabled") {
    const signedContext = await signRelayContext(context, relayConfig.contextKey);
    const relayed = await callDenoRelay(request, signedContext, relayConfig);
    return relayPublicResponse(
      relayed,
      requestId,
      workerVersionHeaders(env.CF_VERSION_METADATA),
    );
  }
  // The existing prepare and Chat paths remain below this branch.
  ```
- [ ] Run focused tests and `npm run typecheck -w apps/gateway-worker`; expect pass.
- [ ] **Completion boundary:** Public responses preserve existing error/status and header contracts; exact-once ingress and raw stream-forwarding tests pass.
- [ ] **Commit only if explicitly authorized:** `feat: ResponsesをDeno relayへ接続`

## Task 8: Verify crash windows, isolation, config and rollout

**Files:** Modify `apps/gateway-worker/wrangler.jsonc`, `scripts/preview-worker-config.mjs`, `scripts/preview-worker-config.test.mjs`, `apps/gateway-worker/test/relay-callback.test.ts`, `apps/gateway-worker/test/relay-decision-controller.test.ts`, `apps/deno-tokenizer/test/relay.test.ts`, `durable-objects/quota-controller/test/relay-grant.test.ts`, `durable-objects/quota-controller/test/relay-admission.test.ts`, `scripts/production-deno-config.mjs`, its test, `.github/workflows/deploy-deno-tokenizer.yml`, `.github/workflows/deploy-production.yml`, `docs/configuration.md`, `docs/deno-tokenizer.md`, `docs/operations.md`.

**Consumes / produces:** Consume Task 4's SQLite migration tag `v3`, exact `RelayDecisionController` binding, and Task 2 `admitRelay` RPC. Produce Preview-local Decision/Quota/Tokenizer DO bindings, Preview config validation that rejects Production namespace IDs and D1 IDs, same-SHA deployment ordering, and synced operator rollback/config docs. `SPEC.md` was made normative in Task 1; Task 8 verifies it agrees with Design/Plan without creating a second protocol source.

- [ ] Write failing isolation/fault tests for Preview and Production DO separation; exact Preview migration/binding generation; Production binding not copied into Preview; same-SHA Deno-first deployment; and rollback retaining the Decision DO/QuotaController callbacks while any grant is unresolved. Extend existing tests for Worker termination after atomic admission, lost `admitRelay` acknowledgement/retry with the same input, duplicate shard dispatch, stale grant generation, Deno termination after activation, terminal conflict, Preview credential at Production callback, UTC-midnight late callback, reconciliation before/after terminalization, expired authorized/attempted grants and retention. Assert one grant causes at most one upstream attempt, one `admitRelay` transaction causes no partial reservation/lease/grant, and neither quota nor audit depends on D1 writes.
- [ ] Run `npm test -w apps/gateway-worker -- relay-callback.test.ts relay-decision-controller.test.ts relay-admission.test.ts relay-grant.test.ts` and `npm run test:preview-workflow`; expect the missing isolation/migration assertions to fail.
- [ ] Verify `apps/gateway-worker/wrangler.jsonc` contains the Task 4 `v3` SQLite class migration and Production binding. In Preview config generation, use the Preview Worker name and add `previews.durable_objects.bindings` for `RelayDecisionController`, `QUOTA_CONTROLLER` and `TOKENIZER_CONTROLLER` without any Production `namespace_id`; ensure Preview D1 and Deno endpoints are isolated. Assert the Preview Worker and binding configuration cannot resolve Production resources before any remote mutation. Keep endpoint/secrets/environment pinned, Deno-first same-SHA deployment, and relay opt-in. Preserve `/prepare` and callbacks until all unresolved grants are reconciled.
- [ ] Update human configuration/deno/operations docs for Worker/DecisionDO/QuotaController ownership, 64-shard routing, the atomic admission RPC, DO migration/namespace separation, CPU evidence and rollback. Keep `SPEC.md` canonical from Task 1; do not duplicate the normative contract here.
- [ ] Run focused tests, `npm run typecheck`, `npm test`, `npm run test:deno-deploy-workflow`, `npm run test:preview-workflow`, `git diff --check`, and, if installed, `npx --no-install markdownlint-cli2 SPEC.md docs/configuration.md docs/deno-tokenizer.md docs/operations.md`.
- [ ] **Completion boundary:** Cross-runtime fault/isolation/config/rollout tests pass; Design, Plan, SPEC and operator docs agree; the same-SHA deployment has distinct Preview/Production DO namespaces; unresolved grants are reconciled before rollback removes callbacks/secrets.
- [ ] **Commit only if explicitly authorized:** `test: relayの障害境界とrolloutを検証`

## Canary and release gate

No production change occurs as part of writing or merely executing tests for this plan. After the revised complete Task 0 gate is PASS and separately authorized deployment, deploy Deno first for the same immutable revision, then migrate/bind the Production Decision DO and enable the Worker relay only in Preview. Canary the eight payload-size/stream-mode ingress classes and all four stateless callback classes; record their CPU separately from `RelayDecisionController` and every QuotaController RPC class. Record `exceededCpu`, Gateway B matches, reservation/settlement/uncertainty counts and Deno capacity without payloads or credentials. Only enable a controlled Production subset after zero CPU failures in every required Worker and DO series and correct quota behavior for injected failures. Any stateless Worker CPU breach fails rollout even when every DO series passes. Rollback must retain callbacks and Decision/Quota DO bindings while outstanding grants exist; reconcile them before removing old secrets or migrations.

## Self-review matrix

- Ingress and wire contract: Tasks 1, 3, 5, 7.
- Thin callback and DecisionDO trust/routing: Tasks 3, 4, 8.
- Atomic quota admission, one-use authorization and failure windows: Tasks 2, 4, 8.
- Upstream forwarding, stream usage and lease renewal: Tasks 5, 6.
- Free CPU feasibility ownership/evidence: Task 0; complete Worker + separate DO CPU PASS prerequisite for Tasks 1–8. Deployment, SQLite migration, environment isolation and rollback: Tasks 4, 8, canary gate.
- External-facing normative contract and operational documentation: Task 8.

The source tree already contains an unrelated untracked `deno.lock`; verify status before edits and leave it unstaged.
