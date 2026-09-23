<!-- markdownlint-disable MD013 MD032 -->

# Free-Worker Deno Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Deno-prepared Responses requests through Deno to Gateway B while keeping quota authorization and settlement in QuotaController and Cloudflare Workers on the Free plan.

**Architecture:** Worker authenticates and streams each original request once to Deno. Deno normalizes and tokenizes, calls back to Worker for quota admission and one-use DO authorization, then forwards to Gateway B and reports terminal usage through Worker; Worker relays response bytes unchanged. The old `/prepare` route remains available until the relay passes measured canary gates.

**Tech Stack:** Strict TypeScript, Cloudflare Workers and SQLite-backed Durable Objects, Deno Deploy, Vitest, Deno test runner, npm workspaces, GitHub Actions.

**Spec:** [Free-Worker Responses Relay Through Deno](../specs/2026-09-23-free-worker-deno-relay-design.md).

**Execution status: BLOCKED pending CPU feasibility evidence.** The Pre-implementation CPU Feasibility Gate in the Design is a hard prerequisite to Tasks 1–8. Task 0 below is the sole pre-gate task and is only an isolated, disposable capability spike, not production source implementation. The repository currently records no passing evidence. Do not start Task 1–8 until the evidence and explicit PASS decision are recorded; missing evidence is not a pass.

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
| `packages/shared/src/relay.ts` | Exact v1 wire types, stable error union, strict parsers and byte bounds from the Design's Normative relay contract. |
| `packages/shared/src/index.ts` | Export the relay contract. |
| `packages/shared/src/relay-credential.ts` | Worker-side canonical JSON, compact HMAC token sign/verify and bearer-token comparison primitives. Deno must not import or hold signing/verifying key capability. |
| `apps/gateway-worker/src/relay-auth.ts` | Worker-facing credential adapters and relay config validation; delegates cryptographic primitives to shared package. |
| `apps/gateway-worker/src/relay-callback.ts` | Bounded callback routing and DO/policy orchestration; no client body processing. |
| `apps/gateway-worker/src/relay-client.ts` | One-pass client-body relay and Deno response mapping. |
| `apps/gateway-worker/src/index.ts` | Register callback before public routes; extend `Env` with isolated relay configuration. |
| `apps/gateway-worker/src/proxy.ts` | Opt-in Responses routing before legacy prepare branch; leave Chat and legacy intact. |
| `durable-objects/quota-controller/src/relay-grant.ts` | Durable grant claims, one-use transitions, exact-repeat terminal replay and retention cleanup. |
| `durable-objects/quota-controller/src/quota-controller.ts` | Grant operations and server-side pool/day DO identity; no Deno-supplied DO identifier. |
| `durable-objects/quota-controller/src/quota-lifecycle.ts` | `applyQuotaLifecycleTransition(storage, requestId, transition)` transaction-scoped mutation helper used by legacy lifecycle and relay. |
| `apps/deno-tokenizer/src/relay.ts` | Bounded input preparation, opaque context/grant transport, decision/activation callbacks and Gateway B request. |
| `apps/deno-tokenizer/src/relay-usage.ts` | Bounded SSE/JSON usage extraction without changing client bytes. |
| `apps/deno-tokenizer/src/http.ts`, `src/config.ts`, `src/main.ts` | Versioned endpoint and environment-specific configuration. |
| Existing suites in `apps/gateway-worker/test/`, `apps/deno-tokenizer/test/`, `durable-objects/quota-controller/test/` | Behavior and fault-injection regressions. |
| `.github/workflows/deploy-deno-tokenizer.yml`, `.github/workflows/deploy-production.yml`, `scripts/production-deno-config.mjs` | Same-revision, Deno-first rollout and safe configuration checks. |
| `SPEC.md`, `docs/deno-tokenizer.md`, `docs/operations.md`, `docs/configuration.md` | Normative contract, operational rollout, configuration ownership. |

The Design's **Normative relay contract (v1)** is authoritative for every name, field, limit, state, mapping and ownership rule below. Task 1 reproduces that complete normative contract as shared wire types and parsers; later tasks consume those names without renaming them. Keep each new TS module focused and below the repository's 250-LOC guidance where feasible. Existing oversized modules should gain only routing glue, not another full state machine.

## Task 0: Free-plan CPU Capability Spike (the only pre-gate task)

**Purpose:** Resolve the circular dependency between the CPU gate and production callback implementation by measuring representative capability without implementing production relay behavior.

**Permitted before CPU Gate PASS:** Task 0 only. Task 0 MUST be an isolated, disposable harness; it MUST NOT add or change production routes, production callbacks, production relay modules, workflows, scripts, tests, or shared package code. It MUST NOT become a dependency or artifact consumed by Tasks 1–8 other than sanitized evidence and the recorded PASS/FAIL decision.

**Execution and authorization:** The task owner is the operator explicitly assigned to run this plan. Remote deployment and Free-runtime measurement are separate remote actions and require the user's explicit authorization before execution. Without that authorization, do not deploy or measure remotely; report Task 0 blocked and keep the overall status `BLOCKED pending CPU feasibility evidence`. No local emulator, Paid Worker, or synthetic microbenchmark can satisfy the gate.

**Spike workload:** In the exact intended Free-plan runtime/deployment class, reproduce authenticated one-pass Worker -> Deno body forwarding with no clone, buffering, parsing or transformation by Worker, using valid authenticated requests at 123 KiB, 174 KiB, approximately 700 KiB and exactly 1 MiB, with `stream=true` and `stream=false` in every bucket. Measure representative bounded decision, activation, renewal, and terminal callback workloads separately. Each callback workload must include its necessary bounded JSON parsing, credential verification and representative Durable Object RPC sequence. Use at least 100 invocations per request-size/stream bucket and at least 100 per callback class. Report per-invocation CPU min/p50/p90/p95/p99/max, sample counts, tail margin to 10 ms and `exceededCpu` counts, by bucket and callback class without pooling away failures.

**Artifacts and disposal:** Keep harness source, temporary deployment configuration, logs and raw measurement files outside the repository in a task-specific temporary directory owned by the Task 0 operator. Do not place credentials, request bodies, prompts or response bodies in artifacts. The operator is responsible for cleanup: after results are independently summarized into the review record, delete the harness, temporary configuration, raw logs and temporary deployment resources. Retain only sanitized aggregate evidence, dated runtime/revision identifiers, test methodology and explicit PASS/FAIL decision in the review record. Do not commit or push spike artifacts.

**Gate decision:** PASS requires zero `exceededCpu`, p99 at most 8 ms, maximum below 10 ms and complete coverage of every bucket, mode and callback class. A failed ingress or callback class is FAIL; stop before production implementation, return to the Design and revise architecture/responsibility, then rerun the complete spike under separately authorized remote measurement. Missing authorization, samples, runtime availability or telemetry is BLOCKED, not FAIL or PASS. No measured result is assumed or fabricated; status remains `BLOCKED pending CPU feasibility evidence` until actual evidence and explicit PASS are recorded.

## Blocking prerequisite: Pre-implementation CPU Feasibility Gate

Task 0 is the sole task permitted before PASS. Task 1–8 MUST remain not-started until Task 0 passes and the evidence and explicit PASS decision are recorded. After any redesign, repeat the complete Task 0 workload. Until evidence and explicit PASS are recorded, status remains `BLOCKED pending CPU feasibility evidence` and no production implementation commit is permitted.

## Task dependencies and TDD/commit order

Task 0 is the only pre-gate task; its explicit PASS is a hard prerequisite to Tasks 1–8. After Task 0 passes: Task 1 precedes Tasks 2 and 3; Tasks 2 and 3 both precede Task 4; Tasks 1, 3 and 4 precede Task 5; Task 5 precedes Task 6; Tasks 1, 3, 4, 5 and 6 precede Task 7; Tasks 1–7 precede Task 8. Tasks 2 and 3 may proceed independently after Task 1. Within each task, follow this exact sequence: (1) RED command, (2) expected RED, (3) minimum GREEN implementation, (4) GREEN command, (5) expected GREEN, (6) only then necessary refactor and rerun GREEN, (7) completion boundary, (8) commit message usable only if the user explicitly authorized that commit. No task instructs push.

## Task 1: Define and test the bounded relay contract

**Files:** Create `packages/shared/src/relay.ts`, `packages/shared/test/relay.test.ts`; modify `packages/shared/src/index.ts`.

**Consumes:** Design Normative relay contract, exact v1 routes/headers/envelopes/error mapping.
**Produces:** `RelayEnvironment`, `RelayGrantState`, `RelayContextV1`, `RelayGrantCredentialV1`, `RelayRequestMetaV1`, `RelayQuotaSnapshotV1`, `RelayDecisionV1`, `RelayActivationV1`, `RelayRenewalV1`, `RelayTerminalV1`, `RelayResponseMetaV1`, `RelayErrorCode`, `RelayInternalErrorV1`, `RelayProtocolError`; `parseRelayJsonBody(bytes: Uint8Array, maxBytes: number): unknown` plus strict parsers for each body envelope. Grant credential is carried only in `X-OCTG-Relay-Grant`, not in the allow envelope.

**Exact contract to encode:** `RelayContextV1` has the Design's exact claims and ingress lifetime; `requestId` uses the existing OCTG `req_${ulid()}` format and its parser/test accepts a valid `req_[0-9A-HJKMNP-TV-Z]{26}` identifier. `RelayRequestMetaV1` fields and limits are exactly the Design's decision request. Decision reject/allow, activation, renewal, terminal, `RelayResponseMetaV1`, `RelayErrorCode`, internal error envelope, method/content-type rules, exact header names, and ingress/callback/header byte limits MUST match the Normative relay contract verbatim. `parseRelayJsonBody` enforces the byte limit, fatal UTF-8 and duplicate-key rejection before each strict envelope parser; all parsers reject unknown fields, invalid ranges, and over-limit UTF-8 byte lengths. `RelayResponseMetaV1` contains no credentials or request content. Do not introduce alternate shapes or aliases.

Contract checklist for this task: POST only; JSON content type; Worker ingress `Authorization: Bearer <ingress token>` plus `X-OCTG-Relay-Context`, and optional unchanged `Idempotency-Key` <=255 UTF-8 bytes; callbacks `Authorization: Bearer <service token>` and grant callbacks also `X-OCTG-Relay-Grant`; response metadata `X-OCTG-Relay-Response-Meta` containing unpadded base64url JSON. Ingress body <=1,048,576 bytes; context/grant header <=4,096 ASCII bytes; callback request/response body <=8,192 bytes; metadata JSON <=2,048 decoded bytes and metadata header <=2,800 ASCII bytes; bearer Authorization header <=263 ASCII bytes; service token 32–256 printable ASCII bytes; the Worker-only HMAC key base64url decodes to exactly 32 bytes. Decision request, reject/allow response, activation, renewal, terminal request/response, metadata response, internal error, every named error code and every public status mapping are exactly the shapes/tables in Design sections "Callback and response envelopes" and "Stable failures and public mapping". No extra headers, envelope fields or status remapping may be invented.

Exact callback routes are `POST /internal/relay/v1/decision`, `/activation`, `/renewal`, `/terminal`; Deno ingress is `POST /relay/v1/responses`. Context claims are exactly version/audience/environment/route/requestId/clientId/idempotencyKeyHash/nonce/issuedAtMs/expiresAtMs. Grant claims add grantId/model/pool/admissionUtcDay/leaseGeneration and have the grant audience. Decision request is `{version:1,metadata:RelayRequestMetaV1}`; decision response is either `{version:1,kind:"reject",code,status}` or `{version:1,kind:"allow",grantId,leaseGeneration,maxOutputTokens,cacheEnabled,quota}` with the grant only in `X-OCTG-Relay-Grant`; reject status must match the exact code mapping. Activation, renewal and terminal envelopes and `RelayResponseMetaV1` fields are copied exactly from the Design. Stable errors are the complete `RelayErrorCode` union; internal failures use `{version:1,error:{code}}`. Public mapping preserves `400 invalid_request`, external-client `401 invalid_api_key`, `403 client_disabled|model_requires_paid|model_not_allowed`, `409 duplicate_idempotency_key`, `413 request_too_large`, `429 insufficient_quota|worker_concurrency_exceeded`, and internal relay failures `500 internal_error`. Deno config keys are exactly `OCTG_RELAY_ENVIRONMENT`, `OCTG_RELAY_CALLBACK_ORIGIN`, `OCTG_RELAY_SERVICE_AUTH_TOKEN`, `OCTG_RELAY_INGRESS_AUTH_TOKEN`, `OCTG_RELAY_GATEWAY_B_BASE_URL`, `OCTG_RELAY_GATEWAY_B_TOKEN`, `MAX_INPUT_BYTES`, `OCTG_RELAY_MAX_REQUEST_DURATION_MS`, `OCTG_RELAY_LEASE_TTL_MS`, `OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS`; `OCTG_RELAY_CONTEXT_HMAC_KEY` is Worker-only. Worker keys and fixed values/partial configuration semantics are exactly those in the Design. `OCTG_RELAY_ENABLED=true` requires complete valid Worker config; `false` or absent disables relay; any other value is invalid. Lease TTL/cadence are fixed config (120,000/30,000 ms), never decision fields.

- [ ] Add failing tests for each accepted envelope and for version mismatch, extra keys, negative or non-integer usage, oversized metadata, wrong environment and malformed grant. Include a valid existing `req_${ulid()}` request ID case. The decision metadata type/function are exactly `RelayRequestMetaV1` and `parseRelayRequestMeta(...)`. Example: `expect(parseRelayRequestMeta({ model: "openai/test", estimatedInputTokens: -1 })).toBeUndefined()`.
- [ ] Run `npm test -w packages/shared -- relay.test.ts`; expect the missing parser test to fail.
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
- [ ] Run `npm test -w packages/shared -- relay.test.ts` and `npm run typecheck -w packages/shared`; expect pass.
- [ ] **Completion boundary:** Shared v1 contract/types/parsers match the Design exactly; focused tests and typecheck pass; no Worker, Deno, DO or workflow behavior is implemented in this task.
- [ ] **Commit only if explicitly authorized:** `feat: relayのwire contractを定義`

## Task 2: Make grants durable, single-use and terminal transitions atomic

**Files:** Create `durable-objects/quota-controller/src/relay-grant.ts`, `durable-objects/quota-controller/test/relay-grant.test.ts`; modify `durable-objects/quota-controller/src/quota-controller.ts`.

**Consumes:** Task 1 wire unions; existing request entry, pool state, unresolved counters and in-flight lease store.
**Produces:** `RelayGrant` with every immutable credential claim plus exact state union from Design; `authorizeRelay`, `activateRelay`, `finishRelay`; `applyQuotaLifecycleTransition(storage, requestId, transition)` in `quota-lifecycle.ts`.

`applyQuotaLifecycleTransition` is the only quota lifecycle mutation seam. It receives an open transaction-scoped storage handle, validates legal source state, mutates request entry/pool/unresolved counters, and returns the canonical outcome; it never opens a transaction. Existing `QuotaLifecycle.settle`, `markUncertain`, `release`, and `reconcileRequest` must call it from their own `ctx.storage.transaction()`. `finishRelay()` performs grant validation, the helper call, lease transition, and grant terminal write inside the same `ctx.storage.transaction()`. Activation in one transaction verifies reservation exists and remains unresolved, grant is authorized, all immutable bindings match, grant is unexpired, and live lease generation matches. This requires modifying `quota-lifecycle.ts`, `relay-grant.ts`, and `quota-controller.ts`; no read-then-mutate split is allowed.

- [ ] Write a failing DO test that reserves, acquires a lease, authorizes a grant, calls `activateRelay` concurrently twice, and asserts exactly one `ok: true`; include wrong generation, missing reservation, expired grant, release-before-activation, post-activation release rejection, duplicate identical terminal and conflicting terminal cases. Example: `expect((await Promise.all([stub.activateRelay(id, grant, gen), stub.activateRelay(id, grant, gen)])).filter(x => x.ok)).toHaveLength(1)`.
- [ ] Run `npm test -w apps/gateway-worker -- relay-grant.test.ts`; the gateway Vitest config includes quota-controller tests. Expect missing methods to fail.
- [ ] Implement `applyQuotaLifecycleTransition` and route existing `settle`, `markUncertain`, `release`, `reconcileRequest` through it. Implement `finishRelay` and activation as single `ctx.storage.transaction()` operations using the same storage handle. Legal terminal transitions are exactly those in Design: authorized release only for proven pre-activation failure; authorized uncertain for ambiguous activation; attempted settle/uncertain; uncertain settle/uncertain; never release after activation may have occurred. Renewal is only valid for attempted grants before authorization expiry. Reconciliation atomically terminalizes any grant as `reconciled_consumed` or `reconciled_unused`, records disposition, and removes its lease. Identical terminal report retries return saved result only for callback-terminal grants; after reconciliation all terminal reports, renewal and activation return `grant_terminalized`. Expired authorized grants atomically release reservation/lease; expired attempted grants become uncertain and release only the lease; a trustworthy terminal usage report may settle that uncertain entry during the five-minute credential grace. Keep terminal grants 45 days after admission UTC day ends; cleanup deletes only expired terminal grant records.

  ```ts
  return this.ctx.storage.transaction(async (storage) => {
    const grant = await storage.get<RelayGrant>(`relay:${requestId}`);
    if (grant?.grantId !== grantId || grant.generation !== generation || grant.state !== "authorized") {
      return { ok: false } as const;
    }
    await storage.put(`relay:${requestId}`, { ...grant, state: "attempted" });
    return { ok: true } as const;
  });
  ```
- [ ] Run `npm test -w apps/gateway-worker -- relay-grant.test.ts` and `npm run typecheck -w durable-objects/quota-controller`; expect pass.
- [ ] **Completion boundary:** Tests prove transactional quota/grant/lease atomicity, every source/terminal state rule, reconciliation terminalization and stale-credential non-mutation; focused tests/typecheck pass.
- [ ] **Commit only if explicitly authorized:** `feat: quota DOでrelay grantを原子的に管理`

## Task 3: Authenticate relay context and internal callbacks

**Files:** Create `packages/shared/src/relay-credential.ts`, `packages/shared/test/relay-credential.test.ts`, `apps/gateway-worker/src/relay-auth.ts`, `apps/gateway-worker/test/relay-auth.test.ts`; modify `packages/shared/src/index.ts` and `apps/gateway-worker/src/index.ts` for exports/environment bindings.

**Interfaces:** `packages/shared/src/relay-credential.ts` exports the exact sign/verify context and grant credential interfaces specified in the Design plus constant-time bearer verification. `apps/gateway-worker/src/relay-auth.ts` exports `resolveRelayConfig(env)` and Worker adapters. Use canonical JSON, compact base64url, HMAC-SHA-256 with purpose-separated inputs and constant-time MAC comparison, exactly as the Design defines. This task implements authentication/credential primitives and pure config validation only. Deno does not import HMAC primitives, hold `OCTG_RELAY_CONTEXT_HMAC_KEY`, or verify/mint signed tokens. It applies only transport size/syntax bounds to the opaque ingress context and forwards it unchanged to decision. A successful allow decision proves Worker verified that same context; after allow, Deno may decode claims only as non-authoritative bounded relay/upstream metadata such as request ID and client ID and may not use them for quota, policy, model, pool, admission-day or target selection. It transports the grant credential opaquely. Exact Worker/Deno env keys, partial-config behavior, fixed HTTPS origins and ingress/grant TTLs are specified in the Design. Callback behavior and grant state transitions belong to Tasks 2 and 4, not this task.

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

## Task 4: Add Worker decision, activation, renewal and terminal callbacks

**Files:** Create `apps/gateway-worker/src/relay-callback.ts`, `apps/gateway-worker/test/relay-callback.test.ts`; modify `apps/gateway-worker/src/index.ts`, `apps/gateway-worker/src/policy.ts` only if a reusable policy helper is required.

**Interfaces:** `handleRelayCallback(request, env, ctx)` handles only exact POST callback routes/envelopes from the Design, enforcing the 8,192-byte bound, service auth, content type and error envelope. Decision verifies the ingress context, uses existing authoritative registry/policy/model/quota checks, classifies the pool and derives the admission UTC day server-side, then resolves the DO from that authoritative pool/day. Activation/renewal/terminal verify `X-OCTG-Relay-Grant` and reconstruct the same DO from its signed `pool + admissionUtcDay`; no callback accepts a supplied DO identifier. Duplicate decisions are idempotent only for byte-identical context+metadata before activation; conflicting duplicates reject. Policy/quota/validation rejections preserve exact code and mapped status; they are never flattened to 503.

- [ ] Write failing tests for callback auth, wrong method/path, oversized JSON, wrong environment, model/tool rejection, quota rejection, unknown reserve, admission rejection, duplicate decision and lost grant ACK; assert no `fetch` to Gateway B before successful activation. Example: `expect(await callback(duplicateDecision)).toMatchObject({ status: 409 })` for a conflicting nonce/metadata.
- [ ] Run `npm test -w apps/gateway-worker -- relay-callback.test.ts`; expect the decision route to return 404.
- [ ] Implement callback endpoints with strict parsers. Reserve first, acquire in-flight, then authorize; on proven pre-activation failure release both. On unknown reserve call `markReserveOutcomeUnknown`. An ambiguous activation is never automatically retried. Terminal invokes `finishRelay`; audit completion remains best effort and cannot change a DO outcome.

  ```ts
  const reserved = await reserveFailClosed(
    (id, tokens, upper, key, client) => stub.reserve(id, tokens, upper, key, client),
    reserveInput,
  );
  if (reserved.kind === "unknown") {
    await stub.markReserveOutcomeUnknown(context.requestId);
    return relayInternalError(500, "internal_error");
  }
  // On reserved.ok, acquireInFlight -> authorizeRelay; otherwise reject.
  // Never send an allow decision before all three operations have succeeded.
  ```
- [ ] Run focused tests and `npm run typecheck -w apps/gateway-worker`; expect pass.
- [ ] **Completion boundary:** Four callbacks, strict auth/schema/size/error contracts and server-derived same-DO routing are covered by tests; Deno does not yet call them.
- [ ] **Commit only if explicitly authorized:** `feat: Worker relay callbackを追加`

## Task 5: Build Deno relay and upstream request with explicit activation

**Files:** Create `apps/deno-tokenizer/src/relay.ts`, `apps/deno-tokenizer/test/relay.test.ts`; modify `apps/deno-tokenizer/src/http.ts`, `src/config.ts`, `src/main.ts`, and Deno workspace dependency declarations only as needed for shared non-cryptographic wire types/parsers. Keep `/prepare` behavior unchanged. Do not create `relay-auth.ts` or import HMAC signing/verification primitives into Deno.

**Interfaces:** `handleRelay` accepts only `POST /relay/v1/responses`, exact JSON media type, bearer ingress auth and context header; it enforces 1,048,576 raw bytes and checks only context header size/syntax transport bounds. It forwards the context token unchanged and opaquely to the decision callback, which verifies it. Deno does not hold the HMAC key or verify/mint context or grant tokens. Following a successful allow response for that same context, Deno may decode context claims only as non-authoritative bounded relay/upstream metadata (for example, request ID and client ID); no unverified claim may influence quota, policy, model/pool/day classification or target selection. Deno configuration is the exact required Deno key set in the Design; missing/partial/invalid settings fail startup and do not disable checks. It calls `POST /decision`, then `POST /activation` with exact envelopes. Grant credential travels opaquely only in `X-OCTG-Relay-Grant`. Gateway B URL/token are fixed Deno config, never request-supplied. Upstream JSON uses the existing normalizer and allowed numeric output clamp; headers follow existing Gateway B contract and never reuse client Authorization. Decision rejection is returned as its exact internal error envelope/status for Worker mapping; it is never rewritten to 503.

`activateOnce(grantId, leaseGeneration, credential)` returns exactly `| {kind:"activated"} | {kind:"denied",code:ActivationDenialCode} | {kind:"unknown"}`, with `ActivationDenialCode` and each code's action defined in the Design Normative relay contract. For `lease_lost` only, Deno sends terminal `release`; it never releases for `grant_replayed`, which maps to best-effort `uncertain`, nor for already-terminal `grant_terminalized`. `environment_mismatch`, `grant_not_found`, and `grant_expired` cause no terminal callback, for their respective reasons specified in the contract. `unknown` sends terminal `uncertain` best effort. Deno never retries activation, never calls Gateway B for denial/unknown, and only `{kind:"activated"}` permits exactly one Gateway B request.

- [ ] Add failing tests: invalid ingress auth/context/media type/method/size has no callback; validation/model/quota/concurrency rejection preserves exact status/code and performs no activation or upstream request; activation lost/denied never calls upstream; successful activation calls fixed Gateway B exactly once with numeric clamp; fetch failure after activation reports uncertain; no failed callback causes fallback. Assert quota rejection remains `429 insufficient_quota`, not 503, with zero upstream calls.
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

**Interfaces:** `callDenoRelay` sends original client body exactly once as a stream without clone/buffer/transform and with exact ingress headers. Deno response carries base64url UTF-8 JSON `RelayResponseMetaV1` in `X-OCTG-Relay-Response-Meta`, decoded size <=2,048 bytes. Worker validates metadata, request ID, route, pool/quota numeric invariants before public headers. `workerVersion` is not response metadata: construct public version headers in the ingress Worker using `workerVersionHeaders(env.CF_VERSION_METADATA)`. Relay decision errors use `RelayErrorCode` and existing SPEC.md public status/code mapping (quota 429, model 403, validation 400); internal failures map to 500 `internal_error`, never blanket 503. `handleProxy` selects relay only when explicitly enabled for Responses; no fallback to legacy after relay may have reached Deno. Worker never parses usage.

- [ ] Add failing integration tests for exact 1 MiB with and without Content-Length, malformed lengths, stream and non-stream, Deno timeout, validation reject and 5xx, unchanged Chat route, legacy fallback when disabled, and raw byte equality of SSE payload. Example: `expect(upstreamWorkerCalls).toBe(0)` on relay success and `expect(denoCalls).toBe(1)`.
- [ ] Run `npm test -w apps/gateway-worker -- relay-client.test.ts proxy-prepare.test.ts`; expect relay-disabled tests to pass and new enabled tests to fail.
- [ ] Add route/config selection before the legacy prepare branch, with no legacy retry after an enabled relay fails. Forward only safe response headers. Avoid `proxyStream` in relay route and avoid marking a reservation released on an ingress failure after Deno might have activated.

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

**Files:** Modify `apps/gateway-worker/test/relay-callback.test.ts`, `apps/deno-tokenizer/test/relay.test.ts`, `durable-objects/quota-controller/test/relay-grant.test.ts`, `scripts/production-deno-config.mjs`, its test, `scripts/preview-worker-config.test.mjs`, `.github/workflows/deploy-deno-tokenizer.yml`, `.github/workflows/deploy-production.yml`, `SPEC.md`, `docs/configuration.md`, `docs/deno-tokenizer.md`, `docs/operations.md`.

- [ ] Add failing fault-injection tests for Worker termination after reserve, lost activation acknowledgement, duplicate callbacks, terminal delivery failure, stale lease generation, Deno termination after activation, conflicting terminal reports, Preview credential at Production callback, UTC-midnight late callbacks, reconciliation while grant authorized/attempted, terminal reports after reconciliation, renewal and activation after reconciliation, expired authorized/attempted grant, and retention cleanup. Assert one grant causes at most one upstream attempt and a reconciled grant credential cannot change quota; neither DO quota nor audit depends on D1 availability.
- [ ] Run focused suites; expect missing crash handling and Preview isolation assertions to fail.
- [ ] Wire isolated Preview and Production endpoints/secrets and make new relay opt-in, with config validation before remote mutation. Keep the same-SHA Deno-before-Worker gate; add a non-secret relay health/contract probe. Preserve existing Deno `/prepare` and Worker rollback path until pending grants can be reconciled.
- [ ] Update `SPEC.md` as the single normative source for the new internal protocol, and human docs for configuration and rollback. Include pre-implementation CPU gate and separate post-implementation canary, exact config keys and partial-config behavior, fixed lease TTL/cadence, transaction helper/reconciliation and retention. Document that failed callback after activation leaves quota conservative, not auto-released.
- [ ] Run `npm run typecheck`, `npm test`, `npm run test:deno-deploy-workflow`, `npm run test:preview-workflow`, `git diff --check`, and, if installed, `npx --no-install markdownlint-cli2 SPEC.md docs/configuration.md docs/deno-tokenizer.md docs/operations.md`.
- [ ] **Completion boundary:** All cross-runtime fault/isolation/config/rollout gates pass; Design, Plan, SPEC and operator docs agree; unresolved grants are reconciled before rollback removes callbacks/secrets.
- [ ] **Commit only if explicitly authorized:** `test: relayの障害境界とrolloutを検証`

## Canary and release gate

No production change occurs as part of writing or merely executing tests for this plan. After separate deployment authorization, deploy Deno first for the same immutable revision, then enable the Worker relay in Preview. Canary synthetic payloads at 123 KiB, 174 KiB, approximately 700 KiB and 1 MiB in both streaming modes at concurrency 1, 2 and 3. Record sample count, CPU distribution per ingress and callback invocation, `exceededCpu`, Gateway B matches, reservation/settlement/uncertainty counts and Deno capacity without payloads or credentials. Only enable a controlled Production subset after zero CPU failures in the documented sample and correct quota behavior for all injected failures. If the first Worker-to-Deno hop alone breaches 10 ms, halt the rollout and revisit ingress placement. Rollback must retain callbacks while outstanding grants exist; reconcile them before removing old secrets.

## Self-review matrix

- Ingress and contract: Tasks 1, 3, 5, 7.
- Quota one-use authorization and failure windows: Tasks 2, 4, 8.
- Upstream forwarding, stream usage and lease renewal: Tasks 5, 6.
- Free CPU, deployment, environment isolation and rollback: Tasks 7, 8, canary gate.
- External-facing normative contract and operational documentation: Task 8.

The source tree already contains an unrelated untracked `deno.lock`; verify status before edits and leave it unstaged.
